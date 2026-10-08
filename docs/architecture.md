# Architecture

MCP host → official MCP SDK transport → tool schema validation → deterministic local policy → bounded capability adapter → result + redacted receipt.

- `src/cli.js`: environment validation, separate owner terminal console, stdio or authenticated loopback HTTP lifecycle
- `src/server.js`: twelve MCP tools, approval binding, execution epoch guards
- `src/policy.js`: Auto/Ask state, bounded pending queue, local-only decision methods, expiry and single-use consumption
- `src/bridge.js`: command admission/process groups, browser serialization/isolated context, file helper invocation, session health and a 100-receipt in-memory ring
- `src/files.py`: POSIX descriptor-relative read/list implementation; no shell and no symlink following
- `scripts/smoke.js`: real SDK client/server integration against synthetic disposable fixtures

The official TypeScript SDK is pinned to the supported 1.32.1 compatibility line; this is not a claim of v2/latest-wire-spec conformance. Dependencies and versions are locked in `package-lock.json`. Playwright controls a browser this process launches, never the owner's personal Chrome. The HTTP transport is stateless and the capability/approval/browser state is process-global; do not serve multiple independent users.

Future high-privilege execution needs a separate constrained worker identity and a privileged, owner-authenticated policy broker that workers cannot rewrite or impersonate. A token accepted by an MCP host authenticates a caller; it is not evidence of human approval for a particular consequential action.
