# Tailscale: private reachability, not automatic Grok compatibility

These are reviewable setup templates, not executed changes. Bifrost does not install Tailscale, log in, create auth keys, edit grants, start Serve/Funnel, or persist a service.

## Recommended topology

Owner device runs Bifrost on loopback. A client you control runs on the same tailnet. Prefer a tailnet SSH connection carrying stdio rather than exposing the HTTP endpoint; an existing SSH connection must already be independently authorized and host keys verified. The SSH user is a dedicated unprivileged account whose filesystem and command capabilities are limited at the OS level.

A generic local MCP host can be configured to launch `ssh OWNER_DEVICE` with a fixed command invoking Node and `src/cli.js`. Pass only fixed reviewed environment paths on the remote side. Do not put secrets into command-line arguments or disable host-key checking. This is a topology template, not tested per-client configuration.

## Serve route, after explicit approval

[Tailscale Serve](https://tailscale.com/kb/1312/serve) makes a service available to the tailnet. [Funnel](https://tailscale.com/kb/1223/funnel) makes it public and is deliberately out of scope here. Review [grants](https://tailscale.com/kb/1324/grants) so only your intended caller identity can reach the service.

The current HTTP server accepts exactly `127.0.0.1:PORT` as Host. Tailscale Serve forwards the caller's original `*.ts.net` Host header to the backend, so a plain Serve route to Bifrost is refused with 403. A reviewed reverse proxy must rewrite the internal Host correctly while validating the external hostname, terminate TLS, retain bearer authorization, and leave untrusted browser origins rejected. No ready-to-run Serve command is supplied because proxy Host behavior and caller reachability must be tested on the actual target rather than weakening the guard to make routing work.

## Acceptance checklist

1. Identify where the actual MCP tool caller executes: your device, a tailnet VM, or the provider's hosted infrastructure
2. Confirm that caller's tailnet membership and least-privilege network grants
3. Confirm MCP protocol/transport and auth mechanism supported by that specific client
4. From that caller, verify DNS, TLS, authenticated initialize/tools/list, and a synthetic terminal/browser task
5. Verify wrong/missing auth, unauthorized tailnet identity, hostile Host/Origin, off-origin browser requests and cancellation fail safely
6. Disconnect/restart/revoke and verify access disappears and no child/browser processes remain

Hosted Grok's ability to call a public remote MCP URL does not prove it can route into your private tailnet. See [Connecting Grok](grok.md) and [compatibility](compatibility.md). Do not make a privileged bridge public just to resolve that mismatch.
