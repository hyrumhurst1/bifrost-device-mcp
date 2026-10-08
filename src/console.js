// Local owner console: the only place Ask approvals are granted or the mode is raised.
// It reads the operator's own terminal, never MCP traffic, and escapes agent-supplied text.
import { createReadStream, createWriteStream } from 'node:fs';
import readline from 'node:readline';

const HELP =
  'Bifrost owner console: pending | approve REQUEST_ID | mode auto | mode ask. Bypass is unsupported.';

// Agent-supplied strings could otherwise carry terminal escapes, C1 controls or bidi overrides
// that make a pending request look different from what will run.
export function escapeForTerminal(text) {
  return text.replace(
    /[^\x20-\x7e\n]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatPending(pending, now = Date.now()) {
  const shown = pending.map(({ id, tool, args, approved, expiresAt }) => ({
    id,
    tool,
    args,
    approved,
    expiresInSeconds: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
  }));
  return escapeForTerminal(JSON.stringify(shown, null, 2));
}

export function handleConsoleLine(policy, line, write) {
  try {
    const [command, argument] = line.trim().split(/\s+/);
    if (command === 'pending') write(formatPending(policy.pendingLocal()));
    else if (command === 'approve') {
      policy.approveLocal(argument);
      write('Approved once');
    } else if (command === 'mode') {
      policy.setLocal(argument);
      write(`Mode ${policy.mode}`);
    } else write('Unknown command');
  } catch (error) {
    write(escapeForTerminal(error.message));
  }
}

export function attachApprovalConsole(policy, { input, output }) {
  const lines = readline.createInterface({ input, terminal: false });
  output.write(`${HELP}\n`);
  lines.on('line', (line) => handleConsoleLine(policy, line, (text) => output.write(`${text}\n`)));
  return {
    close() {
      lines.close();
      input.destroy();
      output.end();
    },
  };
}

export function openTerminalConsole(policy) {
  const input = createReadStream('/dev/tty');
  const output = createWriteStream('/dev/tty');
  const fail = (error) => {
    process.stderr.write(
      `Bifrost owner console needs a controlling terminal (${error.code ?? error.message}); exiting\n`,
    );
    process.exit(1);
  };
  input.once('error', fail);
  output.once('error', fail);
  return attachApprovalConsole(policy, { input, output });
}
