// Reads and validates Bifrost's launch configuration from environment variables.
// Every check fails closed: a bad workspace, policy, recipe, origin list or audit path stops startup.
import fs from 'node:fs/promises';
import path from 'node:path';

const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RECIPE_KEYS = new Set(['executable', 'args', 'timeoutMs']);

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function requireOperatorOwnedFile(file, label) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw Error(`${label} must be a regular file`);
  if (stat.mode & 0o022) throw Error(`${label} must not be writable by group or others`);
  if (stat.uid !== process.getuid() && stat.uid !== 0)
    throw Error(`${label} must be owned by the operator or root`);
}

export function validateRecipes(tasks) {
  if (typeof tasks !== 'object' || tasks === null || Array.isArray(tasks))
    throw Error('Policy tasks must be an object of named recipes');
  const recipes = Object.create(null);
  for (const [name, recipe] of Object.entries(tasks)) {
    if (!TASK_NAME.test(name)) throw Error(`Invalid task name ${JSON.stringify(name)}`);
    const invalid = (reason) => Error(`Invalid recipe ${name}: ${reason}`);
    if (typeof recipe !== 'object' || recipe === null || Array.isArray(recipe))
      throw invalid('must be an object');
    for (const key of Object.keys(recipe))
      if (!RECIPE_KEYS.has(key)) throw invalid(`unsupported field ${JSON.stringify(key)}`);
    if (typeof recipe.executable !== 'string' || !path.isAbsolute(recipe.executable))
      throw invalid('executable must be an absolute path');
    if (!Array.isArray(recipe.args) || !recipe.args.every((arg) => typeof arg === 'string'))
      throw invalid('args must be an array of strings');
    if (
      recipe.timeoutMs !== undefined &&
      (!Number.isInteger(recipe.timeoutMs) || recipe.timeoutMs < 100 || recipe.timeoutMs > 30000)
    )
      throw invalid('timeoutMs must be an integer from 100 to 30000');
    recipes[name] = Object.freeze({ ...recipe, args: Object.freeze([...recipe.args]) });
  }
  return Object.freeze(recipes);
}

export function parseOrigins(value) {
  let origins;
  try {
    origins = JSON.parse(value || '[]');
  } catch {
    origins = null;
  }
  const exact = (origin) => {
    try {
      const url = new URL(origin);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
    } catch {
      return false;
    }
  };
  if (!Array.isArray(origins) || !origins.every(exact))
    throw Error('Browser origins must be a JSON array of exact HTTP(S) origins');
  return origins;
}

async function prepareAuditFile(file, workspace) {
  const resolved = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  if (isInside(workspace, resolved)) throw Error('Audit file must be outside the workspace');
  const handle = await fs.open(resolved, 'a', 0o600);
  await handle.close();
  const target = await fs.realpath(resolved);
  if (isInside(workspace, target)) throw Error('Audit file must be outside the workspace');
  return target;
}

export async function loadConfig(env, installation, platform = process.platform) {
  if (platform === 'win32')
    throw Error('Bifrost requires Linux or another POSIX system; native Windows is unsupported');
  if (!env.BIFROST_WORKSPACE)
    throw Error(
      'Set BIFROST_WORKSPACE to a dedicated workspace, separate from the bridge installation',
    );
  const workspace = await fs.realpath(env.BIFROST_WORKSPACE);
  if (isInside(workspace, await fs.realpath(installation)))
    throw Error('Workspace must not contain the bridge installation');
  let recipes = validateRecipes({});
  if (env.BIFROST_POLICY) {
    const policyFile = await fs.realpath(env.BIFROST_POLICY);
    if (isInside(workspace, policyFile))
      throw Error('Policy must be outside the model-accessible workspace');
    await requireOperatorOwnedFile(policyFile, 'Policy');
    recipes = validateRecipes(JSON.parse(await fs.readFile(policyFile, 'utf8')).tasks ?? {});
  }
  return {
    workspace,
    recipes,
    origins: parseOrigins(env.BIFROST_BROWSER_ORIGINS),
    auditFile: env.BIFROST_AUDIT_FILE
      ? await prepareAuditFile(env.BIFROST_AUDIT_FILE, workspace)
      : undefined,
    executablePath: env.BIFROST_CHROMIUM_EXECUTABLE,
    mode: env.BIFROST_MODE || 'auto',
  };
}
