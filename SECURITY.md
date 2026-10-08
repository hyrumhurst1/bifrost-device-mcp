# Security and scope

Bifrost is an experimental, single-operator application allowlist. It is **not** a security boundary against a hostile process running as its OS user and is not a general-purpose computer-control sandbox.

## Protected surfaces

- Workspace file helpers use Python `dir_fd`/descriptor-relative open operations with `O_NOFOLLOW` at each component. Absolute paths, parent traversal, symlinks and non-regular read targets fail. Reads stop at 32 KiB and listings at 1000 entries. The configured workspace root and all its ancestors must be trusted, stable, and outside attacker control. Hardlinks and bind mounts can intentionally expose data inside an otherwise valid root; the operator must provision a clean workspace with only authorized data.
- Commands have fixed executable + arguments from owner configuration outside the workspace. No shell or user arguments are accepted. Executables located in the workspace are refused. The environment is reduced; timeouts (max 30 seconds), output cap (32 KiB), cancellation and POSIX process-group termination apply. Four commands may run at once.
- Browser context starts empty, with a temporary empty home, no persistent storage/profile reuse and Chromium sandbox explicitly required. Downloads, service workers, popups and dialogs are blocked/dismissed. Exact-origin request routing is application filtering, **not** a network firewall: DNS changes, WebRTC and browser implementation behavior require independent egress isolation for hostile sites. WebSockets are closed.
- HTTP binds to loopback, requires a supplied bearer token, rejects unexpected Host and every Origin header, caps bodies at 64 KiB and concurrent requests at eight. The token grants all capabilities configured for this process. There are no multi-tenant sessions or per-user scopes.
- Ask requests bind canonical server-generated tool arguments and browser document revision/URL, expire after 60 seconds, are single-use, and are cleared on mode changes. Policy is process memory. Only the local terminal console can raise mode or approve; MCP can only reduce to Ask. Queued work rechecks policy epoch before execution.
- Session status and receipt lookup are read-only and available even in Ask. A maximum of 100 metadata-only receipts are retained in memory; process restart clears them. Audit receipts store ID, timestamp, tool name, outcome and duration, not commands, URLs, content, output or secrets. Tool output itself goes to your MCP host and can contain private data. Put logs outside the workspace, protect/rotate them yourself. Logging failure preserves a completed action result with an explicit warning so callers do not repeat a successful action by accident.

## Non-goals and residual risks

A recipe still runs with the service OS identity and can read/write beyond the workspace, load unsafe workspace code/configuration, access the terminal, or escape process-group cleanup by daemonizing. A trusted system executable does not make an untrusted script safe. Commands must be benign, narrowly reviewed recipes. Do not expose a shell, interpreter script runner, `npm`, `git` hooks, arbitrary browser evaluation, filesystem write, personal cookies, or credential access while claiming owner-only elevation.

The bridge installation/helper/dependencies, operator policy, audit destination and their ancestors must be owner-controlled and not writable by the agent or untrusted tasks. Pointing the workspace at the installation is rejected. Run under a dedicated unprivileged OS user or container/VM with only the intended files mounted when evaluating untrusted workloads. This repository does not provision that isolation. Bypass is refused until such a boundary is implemented.

Browser document approval does not freeze the DOM, business state, dynamic network responses or the site's transaction semantics. A selector may change meaning. Ask is not an atomic payment/signature/medical/financial-consent protocol. Avoid consequential websites and secrets in this preview. Third-party page text and tool output are untrusted input to your model; they cannot authorize local mode elevation.

Already-started operations cannot be undone by mode reduction. Pending queued actions are rejected after an epoch change. HTTP cancellation and browser-operation cancellation are not equivalent to rollback; browser actions are bounded by timeout and close. Whole-process lifecycle cleanup, sandbox startup, macOS behavior and any real remote client must be verified on the deployment machine.

No credential generation, OAuth grant, Tailscale login, Serve/Funnel mutation or persistent service install is performed by these scripts. A user enabling any of those should review permissions and routing separately.

## Reporting

Do not post secrets or exploit access credentials in a public issue. Until a private maintainer reporting channel is established, share a minimal non-sensitive reproduction and request a private follow-up. No external security audit or production-readiness certification is claimed.
