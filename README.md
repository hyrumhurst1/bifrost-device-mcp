# Bifrost

**Created by Hyrum Hurst** · A Phoenix Labs project

An experimental provider-neutral MCP bridge for trusted terminal command recipes and a separate browser.

> **Preview repository:** this initial commit contains only this README and the MIT license. Runnable source, branded imagery, setup instructions, and verified release test evidence are pending. There is nothing to install or connect yet.

The intended design uses exact trusted command recipes, an isolated browser profile, and Auto and Ask modes with local owner approvals. It is a trusted-owner tool, not an arbitrary-code sandbox. Unrestricted Bypass is excluded.

The current implementation under review requires Linux/POSIX security primitives and fails closed on native Windows. Hosted-agent connectivity over Tailscale and full Grok integration are not verified. A separate browser profile does not provide complete operating-system isolation.

This repository, **bifrost-device-mcp**, refers to Hyrum Hurst's device MCP bridge. It is distinct from other projects named Bifrost.

Licensed under the [MIT license](LICENSE).
