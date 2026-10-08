// Capability adapters behind the MCP tools: scoped file helper, fixed command recipes, the
// isolated browser, receipts and session health.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execFileAsync = promisify(execFile);
import { chromium } from 'playwright';
import { startEgressProxy } from './egress.js';
import { isInside } from './config.js';

export class Bridge {
  constructor({ workspace, recipes = {}, origins = [], executablePath, auditFile }) {
    this.sessionId = crypto.randomUUID();
    this.startedAt = new Date().toISOString();
    this.startedMs = Date.now();
    this.receipts = [];
    this.root = workspace;
    this.recipes = recipes;
    this.origins = new Set(origins);
    this.executablePath = executablePath;
    this.auditFile = auditFile;
    this.children = new Set();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.browserQueue = Promise.resolve();
    this.closed = false;
    this.active = 0;
    this.running = 0;
    this.queuedBrowser = 0;
    this.documentVersion = 0;
  }
  async init() {
    this.root = await fs.realpath(this.root);
    return this;
  }
  async scoped(relative = '.') {
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative))
      throw Error('Relative workspace path required');
    const lexical = path.resolve(this.root, relative);
    if (!isInside(this.root, lexical)) throw Error('Path is outside the workspace');
    const resolved = await fs.realpath(lexical).catch(() => {
      throw Error('Workspace path does not exist');
    });
    if (!isInside(this.root, resolved)) throw Error('Symlink target is outside the workspace');
    return resolved;
  }
  async receipt(tool, outcome, started) {
    const receipt = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      tool,
      outcome,
      durationMs: Date.now() - started,
    };
    // Deliberately omit arguments, commands, paths, page content and output.
    if (this.auditFile) {
      try {
        await fs.appendFile(this.auditFile, JSON.stringify(receipt) + '\n', { mode: 0o600 });
        receipt.auditRecorded = true;
      } catch {
        receipt.auditRecorded = false;
        receipt.auditWarning =
          'Audit write failed; action may already have completed. Do not repeat it solely to retry logging.';
      }
    }
    this.receipts.push({ ...receipt });
    if (this.receipts.length > 100) this.receipts.shift();
    return receipt;
  }
  status(mode = 'auto') {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((Date.now() - this.startedMs) / 1000),
      mode,
      lifecycle: this.closed ? 'closed' : 'running',
      activeTools: this.active,
      runningCommands: this.running,
      queuedBrowserActions: this.queuedBrowser,
      browser: this.browser ? 'ready' : 'not_started',
      recentReceiptCount: this.receipts.length,
      persistence: 'process_only',
      supportedFilePlatform: process.platform !== 'win32',
    };
  }
  recentReceipts(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error('Receipt limit must be between 1 and 100');
    return {
      sessionId: this.sessionId,
      persistence: 'process_only',
      receipts: this.receipts.slice(-limit).map((r) => ({ ...r })),
    };
  }
  async invoke(tool, fn) {
    const started = Date.now();
    if (this.closed) throw Error('Bridge is closed');
    try {
      if (this.active >= 8) throw Error('Bridge is busy');
      this.active++;
      try {
        const result = await fn();
        return { ...result, receipt: await this.receipt(tool, 'ok', started) };
      } finally {
        this.active--;
      }
    } catch (error) {
      await this.receipt(tool, 'error', started);
      throw error;
    }
  }
  async fileOperation(operation, relative = '.') {
    if (
      typeof relative !== 'string' ||
      relative.includes('\0') ||
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).includes('..')
    )
      throw Error('Relative workspace path required');
    if (process.platform === 'win32')
      throw Error('Secure descriptor-relative file tools require POSIX and Python 3');
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/python3',
        [fileURLToPath(new URL('./files.py', import.meta.url)), this.root, operation, relative],
        { timeout: 5000, maxBuffer: 262144, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      );
      return JSON.parse(stdout);
    } catch {
      throw Error(
        'File access refused: require a non-symlink regular file/directory inside the workspace and /usr/bin/python3',
      );
    }
  }
  async list(relative) {
    return this.fileOperation('list', relative);
  }
  async read(relative) {
    return this.fileOperation('read', relative);
  }
  async run(name, relative, signal, guard = () => {}) {
    if (this.running >= 4) throw Error('Terminal concurrency limit reached');
    this.running++;
    try {
      return await this.runApproved(name, relative, signal, guard);
    } finally {
      this.running--;
    }
  }
  async runApproved(name, relative, signal, guard) {
    const recipe = this.recipes[name];
    if (!Object.hasOwn(this.recipes, name) || !recipe)
      throw Error(
        'Task is not operator-approved; edit the trusted local policy outside the workspace',
      );
    if (
      !path.isAbsolute(recipe.executable) ||
      !Array.isArray(recipe.args) ||
      !recipe.args.every((a) => typeof a === 'string')
    )
      throw Error('Invalid operator recipe');
    if (this.children.size >= 4) throw Error('Terminal concurrency limit reached');
    const executable = await fs.realpath(recipe.executable).catch(() => {
      throw Error('Recipe executable is unavailable; check the operator policy');
    });
    if (isInside(this.root, executable)) throw Error('Executable cannot be inside the workspace');
    const cwd = await this.scoped(relative);
    if (!(await fs.stat(cwd)).isDirectory()) throw Error('Working directory required');
    if (signal?.aborted) throw Error('Cancelled');
    const timeoutMs = Math.min(Math.max(recipe.timeoutMs ?? 10000, 100), 30000);
    guard();
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, recipe.args, {
        cwd,
        shell: false,
        detached: process.platform !== 'win32',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.children.add(child);
      let output = Buffer.alloc(0),
        truncated = false,
        reason = null;
      const stop = (why) => {
        reason ??= why;
        killGroup(child);
      };
      const append = (data) => {
        const available = 32768 - output.length;
        output = Buffer.concat([output, data.subarray(0, Math.max(0, available))]);
        if (data.length > available) {
          truncated = true;
          stop('output_limit');
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const abort = () => stop('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.children.delete(child);
        killGroup(child);
      };
      child.on('error', (err) => {
        cleanup();
        reject(Error(`Recipe could not start (${err.code ?? 'error'})`));
      });
      child.on('close', (code, terminationSignal) => {
        cleanup();
        resolve({
          code,
          signal: terminationSignal,
          reason,
          output: output.toString('utf8'),
          truncated,
        });
      });
    });
  }
  allowed(url) {
    try {
      const u = new URL(url);
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        this.origins.has(u.origin)
      );
    } catch {
      return false;
    }
  }
  pageIsApproved() {
    const url = this.page.url();
    return url === 'about:blank' || this.allowed(url);
  }
  async browserBinding() {
    return { version: this.documentVersion, url: this.page?.url() ?? 'about:blank' };
  }
  async browserAction(action, args, guard = () => {}) {
    if (this.queuedBrowser >= 4) throw Error('Browser queue limit reached');
    this.queuedBrowser++;
    const work = async () => {
      if (this.closed) throw Error('Bridge is closed');
      guard();
      if (!this.browser) await this.launchBrowser();
      guard();
      if (action === 'navigate') {
        if (!this.allowed(args.url)) throw Error('Origin is not operator-approved');
        try {
          await this.page.goto(args.url, { waitUntil: 'domcontentloaded' });
        } finally {
          if (!this.pageIsApproved()) await this.page.goto('about:blank').catch(() => {});
        }
        if (!this.allowed(this.page.url())) throw Error('Navigation left approved origins');
      } else if (!this.pageIsApproved())
        throw Error('The current page is outside approved origins; navigate to an approved origin');
      else if (action === 'click') await this.page.locator(args.selector).click();
      else if (action === 'fill') await this.page.locator(args.selector).fill(args.value);
      else if (action === 'screenshot')
        return {
          image: (await this.page.screenshot({ type: 'png', fullPage: false })).toString('base64'),
        };
      else if (action !== 'snapshot') throw Error('Unknown browser action');
      return {
        url: this.page.url(),
        title: await this.page.title(),
        text: (await this.page.locator('body').innerText()).slice(0, 16384),
      };
    };
    const next = this.browserQueue.then(work);
    this.browserQueue = next.catch(() => {});
    return next.finally(() => {
      this.queuedBrowser--;
    });
  }
  async launchBrowser() {
    try {
      this.browserHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bifrost-browser-'));
      this.egress = await startEgressProxy((url) => this.allowed(url));
      this.browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        executablePath: this.executablePath,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: this.browserHome },
        // Playwright adds <-loopback> to the bypass list, so loopback traffic is proxied too.
        proxy: { server: this.egress.url },
      });
      this.context = await this.browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      await this.context.route('**/*', (route) =>
        this.allowed(route.request().url()) ? route.continue() : route.abort('blockedbyclient'),
      );
      await this.context.routeWebSocket('**/*', (socket) => socket.close());
      this.page = await this.context.newPage();
      this.page.on('framenavigated', (frame) => {
        if (frame === this.page.mainFrame()) this.documentVersion++;
      });
      this.context.on('page', (page) => {
        if (page !== this.page) page.close().catch(() => {});
      });
      this.page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
      this.page.setDefaultTimeout(5000);
      this.page.setDefaultNavigationTimeout(10000);
    } catch (error) {
      await this.releaseBrowser();
      throw error;
    }
  }
  async releaseBrowser() {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
    await this.egress?.close();
    this.egress = null;
    if (this.browserHome) await fs.rm(this.browserHome, { recursive: true, force: true });
    this.browserHome = null;
  }
  async close() {
    this.closed = true;
    for (const child of this.children) killGroup(child);
    await this.browserQueue;
    await this.releaseBrowser();
  }
}
export function killGroup(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
