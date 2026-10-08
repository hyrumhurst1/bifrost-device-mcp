# Verification record

Snapshot: 2026-10-08. Every check below ran locally with synthetic fixtures only: no personal browser profile, no real accounts, no credentials beyond a fixed test token, no Tailscale or firewall change, no public exposure and no Grok session.

## Environment

| Item | Version |
| --- | --- |
| OS | Ubuntu 24.04.4 LTS on WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), native Linux filesystem |
| User | Ordinary unprivileged user (not root) |
| Node.js / Python | 22.20.0 / 3.12.3 (`/usr/bin/python3`) |
| Playwright / browser | 1.64.0 / Chrome Headless Shell 156.0.8078.4, **Chromium sandbox enabled** |
| MCP SDK | `@modelcontextprotocol/sdk` 1.32.1 |
| Pseudo-terminal | util-linux `script` 2.39.3 (owner-console check) |

## Passed

**`npm test`: 63 of 63 tests pass.**

- Files: workspace scoping, symlink and symlink-ancestor refusal, FIFO non-blocking refusal, read and listing limits
- Terminal recipes: allowlist, prototype names, literal arguments (no shell), reduced environment, output cap, timeout, cancellation, admission limits, executables inside the workspace refused (including a workspace at `/`), errors without absolute device paths
- Configuration: native Windows, root workspace, workspace containing the installation, policy inside the workspace, group/world-writable policy, malformed recipes, inexact origins and an audit file inside the workspace all refuse to start
- Approvals: Auto/Ask, bypass refused, action binding, expiry, single use, concurrent consumption, queue cap, mode changes, early retries keep the request pending, browser document binding, queued work invalidated by a mode change, no server without a policy
- Owner console: list, show the exact action and approve once only after an explicit yes, local mode changes, bypass refused, agent text shown with control and bidi characters escaped
- Egress proxy: loopback only, approved origins forwarded, redirects passed back unfollowed, unapproved origins and CONNECT tunnels refused without contacting them, an invalid upstream status line answered with 502 instead of crashing, each hostname pinned to its first DNS answer
- **Real Chromium** (sandbox on): navigation and subresource redirects to unapproved origins blocked with zero requests reaching the unapproved server, same-origin redirects still work, a click cannot land on a page that replaced the approved one, selectors cannot enter frames, a page that hangs its renderer is released instead of wedging the browser, browser launched without `--no-sandbox` and with all traffic sent through the egress proxy, browser processes and temporary home removed on close, failed browser setup fully torn down without revealing paths
- Receipts and session status: bounded, metadata only, available in Ask

**`npm run smoke`: pass.** Official MCP SDK client over stdio against a spawned server: handshake, 12 tools, file read, terminal recipe, path traversal refused, real browser fill/click/snapshot/screenshot, unapproved navigation, subresource and redirect blocked, Ask mode. Official SDK client over authenticated loopback HTTP: missing token, hostile Host and Origin, oversized body refused; reconnection keeps the session ID and receipts.

**`npm run agent-check`: pass.** Raw JSON-RPC over Streamable HTTP with a bearer token, the way a hosted MCP client calls a remote server, with the bridge in Ask mode and its owner console on a pseudo-terminal: missing and wrong tokens refused, no tool can raise permissions or approve, an agent-supplied `approved` field and early retries run nothing, a console approval (the exact action shown, then confirmed with yes) runs it once, replay and swapped arguments refused, only the console raises Ask to Auto.

**`npm audit`: 0 known vulnerabilities** in the locked dependency tree at this snapshot (not a security guarantee).

**GitHub Actions: pass.** The same `npm run check` (all 63 tests with a sandboxed Chromium, the SDK smoke test and the hosted-agent check) runs on `ubuntu-22.04` for every push; the first green run was on commit `901f10f`. The README badge shows the latest result.

## Not yet verified

- **Real Grok connection.** No Grok Bot, Grok web connector or xAI API call has reached Bifrost. See [Connecting Grok](grok.md) for the routes and what each one needs.
- Remote access of any kind: Tailscale Serve or Funnel, tunnels, reverse proxies.
- macOS, native Ubuntu desktop with AppArmor user-namespace restrictions, and other distributions.
- Native Windows: unsupported; startup refuses to run.

Rerun with `npm ci --ignore-scripts`, `npx playwright install chromium` and `npm run check` on the target machine. Keep passed, failed and skipped stages separate, and never disable Chromium's sandbox to make a check pass. This record is not a production security review or an external audit.
