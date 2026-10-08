![Bifrost: a bridge to your computer. Terminal recipes, an isolated browser, and Auto / Ask permissions.](docs/assets/bifrost-banner.png)

# Bifrost

**Give your agent useful tools on a computer you control.**

Bifrost is an open-source MCP bridge for scoped files, owner-configured terminal recipes, and a fresh browser session. Connect an MCP client, choose its boundaries, and keep approval in your hands.

Created by **Hyrum Hurst** · **A Phoenix Labs project** · [MIT](LICENSE)

[Quick start](#quick-start) · [Tools](#tools) · [Client compatibility](docs/compatibility.md) · [Security](SECURITY.md) · [Test status](docs/verification.md)

## One bridge. Three ways to work.

- **Read your workspace.** List and read files inside a dedicated directory, with traversal and symlink checks.
- **Run your recipes.** Expose specific commands with fixed arguments, timeouts, output limits, and cancellation.
- **Use a fresh browser.** Navigate, inspect, click, fill, and capture screenshots in separate headless Chromium, with exact-origin allowlists and no personal browser profile.

Use **stdio** for a local MCP host or authenticated **loopback Streamable HTTP** for an independently configured connection. Check session health and the latest 100 metadata-only receipts, including after an HTTP reconnect to the same running process.

## Your tools. Your boundaries.

| Mode | What happens |
| --- | --- |
| **Auto** | Runs the capabilities you configured: fixed terminal recipes, scoped file tools, and allowed browser origins |
| **Ask** | Queues an exact action for approval in your local terminal; approvals expire after 60 seconds and work once |

An agent can reduce its access to Ask. Only the local owner console can approve an action or raise the mode. Chat messages do not grant approval. Arbitrary shell execution and Bypass are unsupported.

> **Developer preview · Linux-first.** Native Windows is unsupported; macOS and the complete browser/client setup still need target-device validation. Local regression and MCP transport checks have passed; integrated browser, Grok, and tunnel end-to-end checks remain open. Bifrost is an application allowlist, not an OS security boundary. Use trusted, bounded recipes and avoid credentials or consequential transactions. [Full test status](docs/verification.md) · [Security model](SECURITY.md)

## Quick start

Use Node.js 22+, `/usr/bin/python3`, and Chromium with a working sandbox. Run as an unprivileged user. Keep the installation and owner policy outside the dedicated workspace.

```sh
git clone https://github.com/hyrumhurst1/bifrost-device-mcp.git
cd bifrost-device-mcp
npm ci --ignore-scripts
npx playwright install chromium

mkdir -p "$HOME/bifrost-workspace" "$HOME/.config/bifrost"
cp examples/policy.json "$HOME/.config/bifrost/policy.json"
```

Edit the example policy's `executable` to the absolute path returned by `command -v node`. The included recipe runs `node --version`.

Add Bifrost to your local MCP host, replacing the paths below:

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/bifrost-device-mcp/src/cli.js"],
      "env": {
        "BIFROST_WORKSPACE": "/absolute/path/to/bifrost-workspace",
        "BIFROST_POLICY": "/absolute/path/to/owner-policy.json",
        "BIFROST_BROWSER_ORIGINS": "[]"
      }
    }
  }
}
```

Try asking your client to list the workspace, show the available terminal tasks, and run `node-version`. Browser access starts closed: set `BIFROST_BROWSER_ORIGINS` to explicit exact origins such as `["http://127.0.0.1:8080"]` to enable it.

For a direct stdio launch, set `BIFROST_WORKSPACE` and `BIFROST_POLICY`, then run `npm start`. It waits for an MCP client on stdin. Setup creates no tunnel, credentials, startup service, or personal browser connection.

## Tools

| Area | MCP tools |
| --- | --- |
| Files | `workspace_list`, `workspace_read` |
| Terminal | `terminal_tasks`, `terminal_run` |
| Browser | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot` |
| Session | `session_status`, `recent_receipts`, `permissions_reduce` |

Use one trusted client/operator per bridge process. Session IDs, receipts, and approvals live for that process; restarting creates a new session.

## Local approvals

Launch from your own terminal with `BIFROST_MODE=ask BIFROST_APPROVAL_CONSOLE=1` alongside your workspace, policy, and transport settings. The owner console uses `/dev/tty`, separately from MCP traffic, and requires a controlling terminal.

Review with `pending`, grant with `approve REQUEST_ID`, and change modes with `mode auto` or `mode ask`. After approval, retry the exact tool call with its `approvalId`. Changed, expired, reused, or invalidated approvals are rejected.

## Check your setup

```sh
npm run check
```

The full check runs regression tests and a synthetic MCP demo covering files, a terminal recipe, browser interaction, screenshots, origin restrictions, and authenticated HTTP. See the [verification record](docs/verification.md) for completed checks and remaining acceptance tests. Never disable Chromium's sandbox to make a check pass.

## Connect further

- [Client compatibility](docs/compatibility.md): local hosts, Grok surfaces, and deployment requirements
- [Private Tailscale setup](docs/tailscale.md): operator-managed routing and authentication
- [Architecture](docs/architecture.md): transports, tools, approvals, and process lifecycle
- [Security](SECURITY.md): deployment boundaries and residual risks
- [Brand assets](docs/assets/README.md): banner, social card, wordmark, and icon

HTTP is opt-in, loopback-only, and requires an existing operator-provided token. Hosted clients need a separately configured route; a private tailnet URL alone does not make your machine reachable to hosted Grok. Review the connection guide before enabling remote access.

---

**Bifrost Device MCP** (`bifrost-device-mcp`) is an independent project, unrelated to other products or companies named Bifrost.
