# Verification record

Snapshot: 2026-10-08. Local cloud build only; no personal device/browser, Tailscale change, Grok session, credential creation, or public deployment.

## Passed

- 27 Node regression tests: scoped files, symlink ancestor refusal, FIFO nonblocking failure, command allowlist/environment/literal arguments/output/timeout/cancellation, task admission limits, redacted audit and logging failure, browser origin validation, lifecycle closure, approval TTL/replay/action binding/concurrency/mode changes, browser document target change, queued Auto invalidation, browser queue cap, read-only session status, bounded redacted receipt retrieval in Ask
- `npm audit`: zero known advisories across the locked dependency tree at this snapshot (not a security guarantee)
- Actual official SDK stdio initialize/listTools/callTool against a spawned server, reading a synthetic file and executing Node's version command
- Actual official SDK authenticated loopback HTTP initialize/callTool; missing auth, hostile Host/Origin, oversized request rejection; HTTP reconnection retains process session ID and receipts

## Blocked / not yet verified

- Real Chromium browser integration: the cloud execution runtime refused Chromium's local Unix socket creation. The official Playwright browser download also returned an invalid/truncated archive. No sandbox weakening or personal browser fallback was used. Full `npm run check` correctly fails rather than claiming success. A diagnostic subset used `BIFROST_SKIP_BROWSER=1` and explicitly labels browser unverified.
- macOS, sandboxed Chromium startup, local approval-console UX and complete lifecycle cleanup on the owner's device
- Published CI on the final commit
- Real Grok/Grokbot authorization and browser/terminal end-to-end flow
- Private-tailnet reachability from the actual Grok MCP caller

Run `npm ci --ignore-scripts`, `npx playwright install chromium`, and `npm run check` on the intended target/CI before replacing this record with new evidence. Keep passed/failed/skipped stages separate. This record is not a production security review.
