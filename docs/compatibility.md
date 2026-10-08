# Client compatibility and network deployment

Documentation checked on 2026-10-08. Documented client capability is not an end-to-end integration test. See the repository's actual test results before claiming a client has been tested.

## Grok surfaces are different

- **xAI API:** remote MCP accepts Streamable HTTP or legacy HTTP+SSE, an HTTPS server URL, a server label, optional authorization/custom headers, and tool-name filtering. The OpenAI-compatible Responses API does **not** support `require_approval` or `connector_id`. Enforce safety in this server; never depend on an API approval flag. [Official API documentation](https://docs.x.ai/developers/tools/remote-mcp)
- **Grok web connectors:** custom servers must be publicly reachable. A localhost or private-network URL is not sufficient. A tunnel solves reachability, not authentication. [Official tunneling documentation](https://docs.x.ai/grok/connectors/custom-mcp-tunneling)
- **Grok Bot:** its Team Bot documentation lists custom **Remote HTTPS** MCP with a Bot credential or per-user OAuth, and **Command** servers. A Command server runs on the computer associated with the conversation. Do not put secrets into its command or arguments. [Official Team Bot documentation](https://docs.x.ai/grok-bot/team-bots)
- **Command does not mean your laptop:** Grok Bot normally works on its persistent cloud computer. Its documentation separately requires enabled capability and approval for local-computer commands. A cloud process does not inherit your laptop's Tailscale membership. [Official computer documentation](https://docs.x.ai/grok-bot/computer-and-apps)

The API documents header names and transports more precisely than the Grok Bot UI documentation. We have not established the user's exact Grok Bot build, custom connector form, supported OAuth registration flow, network routing, protocol revision, or allowed timeout. Do not promise that a particular UI token field exists until checked in that client. No live Grok account or API call was used for this documentation.

## Deployment choices

1. **Local MCP client:** run the stdio server directly on the isolated worker machine. The MCP client's process must be able to launch the executable.
2. **Client already inside a tailnet:** run HTTP on loopback and place Tailscale Serve in front, with explicit tailnet access controls and application authentication. Serve is private to the tailnet. [Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
3. **Hosted remote MCP client:** use an explicitly authorized public HTTPS ingress, such as Funnel, or a public authenticated gateway whose worker-side connection traverses Tailscale. A private Serve URL alone cannot satisfy hosted Grok's public-reachability requirement.

Funnel makes its configured port public, including to callers outside the tailnet. The Funnel node attribute controls who may enable exposure; it does not authenticate visitors. Funnel supports TLS and public ports 443, 8443, and 10000, uses a tailnet DNS name, and has bandwidth limits. It needs MagicDNS, HTTPS, and the relevant tailnet policy. Serve and Funnel cannot independently occupy the same port: changing it to Funnel makes it public. [Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel)

**Never expose a terminal or Chrome CDP directly.** Expose only the authenticated MCP gateway. Keep its worker, browser-debugging connection, and approval channel private. A deployment must correctly forward the configured external Host while retaining an exact allowlist; do not disable Host/Origin checks to make a reverse proxy work. Allow absent Origin for server-to-server clients, but reject unexpected browser Origins. Verify the exact proxy configuration before exposure.

Public ingress, installing Tailscale, joining a tailnet, opening ports, changing ACLs, issuing credentials, and connecting a Grok account are operator deployment steps. This repository does not authorize or perform them automatically.

## Protocol and authentication scope

The implementation deliberately pins the supported v1 SDK line for compatibility. The official TypeScript SDK now has a stable split-package v2 line; v1 is a legacy maintenance line. Upgrading packages is not evidence of compatibility with every client. [SDK repository](https://github.com/modelcontextprotocol/typescript-sdk) · [Release history](https://github.com/modelcontextprotocol/typescript-sdk/releases)

The 2026-07-28 protocol substantially changes wire behavior, including stateless requests. Even v2 constructors retain 2025-era behavior unless explicitly configured otherwise. Avoid advertising current-spec features without dedicated tests. [Official migration guidance](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

The project's operator-provided bearer-token mode is a limited authentication option, not a complete OAuth authorization server. For production multi-user OAuth, use a dedicated identity provider and treat the MCP server as a resource server. Validate signature/introspection, issuer, expiration, audience, and scopes; expose protected-resource metadata and a proper Bearer challenge. Current SDK guidance requires an explicit expected resource for audience checking, and recommends a dedicated identity provider rather than new use of its legacy authorization-server helpers. [Official SDK authorization guidance](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization)

Do not put a secret in the endpoint URL, committed configuration, command arguments, log output, screenshot, or tool result. Tool-name filtering at a client is a convenience, not a substitute for server-side authorization. Use short-lived scoped credentials where available. A provider holding the gateway credential can exercise its permitted tools, so credential configuration is a consequential access grant.

## Browser isolation

Use a separate automation browser/profile with no personal cookies or existing sign-ins. Chrome 136 and later ignore remote-debugging switches against the default Chrome data directory; a non-default `--user-data-dir` is required. Chrome recommends Chrome for Testing for automation. [Official Chrome guidance](https://developer.chrome.com/blog/remote-debugging-port)

An isolated browser profile separates cookies and profile state; it is not an OS sandbox. A filesystem root, command allowlist, process timeout, and output cap also do not by themselves isolate arbitrary programs from the host. For untrusted execution, deploy the worker in a dedicated VM/container with explicit mounts, reduced privileges, resource limits, and an enforced egress policy. Preserve Chrome's sandbox; never solve launch failures by silently enabling `--no-sandbox`.

## Required live acceptance checks

### Chat prompts versus trusted owner approval

Grok Bot documents native approval controls and Auto-review rules, but the public pages reviewed do not specify a signed approval receipt, authenticated callback, or verified owner-identity channel that a custom MCP server can consume. Native UI behavior must not be confused with a server-verifiable consent protocol. [Grok Bot approval documentation](https://docs.x.ai/grok-bot/approvals-security-and-privacy)

A chat message can present the pending operation and a non-secret link to an approval page. The bridge must independently authenticate the owner before approving an action. Bind each approval to its exact action digest, requester, expiry, and single-use nonce; re-check the effective policy immediately before execution. Never accept an agent-supplied `approved: true`, purported chat transcript, or unrestricted approval tool as proof of human approval.

For Auto / Ask / owner-only Bypass modes, the recommended security model is an owner-set ceiling plus an agent-requested restriction. Only the owner can raise the ceiling; the agent can reduce it or revoke its own access. The approval store and owner control channel must be outside the terminal/browser worker's writable or reachable authority. Running an unrestricted shell under the same OS identity as the owner-control files defeats that separation. A local UI label alone cannot make a setting owner-only.

The live connector's native in-chat approval integration remains unverified. A separate authenticated owner approval flow is the compatible fallback, not a claim that Grok Bot supports custom native approval buttons.

- Verify the user's actual client can discover and call a harmless tool over the intended transport.
- Verify missing/invalid credentials are rejected before tool discovery or execution.
- Test a legitimate authenticated call and rejected Host/Origin values through the actual reverse proxy.
- Confirm that an off-tailnet device cannot reach a private Serve deployment; for Funnel, confirm unauthenticated public requests are rejected.
- Confirm dangerous tools remain denied without an independently verified operator decision.
- Verify browser isolation and blocked private-network destinations, including redirects and subresources.
- Confirm bounded output, cancellation, timeout, process cleanup, and restart behavior.

Until those account/network-specific checks run, report local protocol tests separately from Grok Bot and Tailscale end-to-end verification.
