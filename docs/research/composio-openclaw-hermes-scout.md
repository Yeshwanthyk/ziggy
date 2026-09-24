# Composio through OpenClaw, Hermes, and Ziggy

Research date: 2026-09-22. Source inspection only; no installation, login, account connection, or live action was performed.

## Finding

Composio can give Ziggy broad app coverage through one integration. The relevant upstream patterns delegate connector definitions and app authorization to Composio; neither requires Ziggy to implement each app's API. MCP, CLI, and direct SDK calls are alternative ways to reach that service.

This narrows the earlier [OpenMuse investigation](openmuse-connectors-scout.md): a homegrown direct connector base remains useful for bespoke integrations, but it is unnecessary as a prerequisite to using Composio's existing catalog.

## OpenClaw: distinguish plugin source from setup pages

The Composio community plugin is `@composio/openclaw-plugin` 0.0.12 at commit `47025c33224d343d9fbbf67e0a24e56eeaa18fff`. Its entrypoint registers onboarding CLI commands and prepends guidance before prompt construction. It does not register app tools or instantiate an MCP client. See [manifest](https://github.com/composio-community/openclaw-composio-plugin/blob/47025c33224d343d9fbbf67e0a24e56eeaa18fff/package.json) and [registration](https://github.com/composio-community/openclaw-composio-plugin/blob/47025c33224d343d9fbbf67e0a24e56eeaa18fff/index.ts#L18-L28).

Its workflow is CLI status, tool search, schema inspection, app linking when needed, and execution. Multi-step work can use the CLI's own run facility. Its README explicitly describes the previous direct MCP plugin route as no longer recommended. See [guidance](https://github.com/composio-community/openclaw-composio-plugin/blob/47025c33224d343d9fbbf67e0a24e56eeaa18fff/index.ts#L221-L241) and [README](https://github.com/composio-community/openclaw-composio-plugin/blob/47025c33224d343d9fbbf67e0a24e56eeaa18fff/README.md).

However, Composio's current [OpenClaw setup page](https://composio.dev/claw) recommends its HTTP MCP endpoint with OAuth and no manually entered auth headers. These sources describe different routes; do not claim there is one consistent universal OpenClaw default. The complete official OpenClaw tree inspected at `86559e65983fe6a47b453a7d17bcc5a5f9c8fdeb` had no path containing `composio`; that filename inventory alone does not prove every file lacks an inline reference.

Do not transplant all plugin operational behavior. Its `doctor` command attempts an upgrade, and its printed reinstall guidance removes the CLI state directory. Those are unrelated to Ziggy's connector operation contract.

## Hermes: generic remote MCP integration

The scout found no dedicated Composio adapter in current Hermes main. Hermes supplies generic remote HTTP MCP configuration, discovery, tool registration, and OAuth support. Relevant sources are [MCP configuration](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/mcp_config.py), [MCP feature documentation](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md), and [OAuth manager](https://github.com/NousResearch/hermes-agent/blob/main/tools/mcp_oauth_manager.py). Main was observed at `a53b42ddea76b250a3f5fa3f6dffa057f29e6374` during the parent check; the scout's source reads used moving main URLs.

Composio's current [Hermes setup page](https://composio.dev/hermes) directs users to `https://connect.composio.dev/mcp` with HTTP and automatic OAuth. Hermes owns the local credentials for that MCP connection; Composio manages the downstream app connections. Do not conflate the MCP login token with Gmail or Slack provider credentials.

An [April 14 Composio guide](https://composio.dev/content/hermes-agent-with-composio-mcp-cli) describes both remote MCP and a CLI alternative. Its static consumer-header example differs from the current OAuth setup page, so it is historical evidence of available approaches rather than the current login recipe.

## Implication for Ziggy

The smallest experiment is a Composio skill using an installed CLI. A product-quality first slice can be one optional `composio` Pi extension, borrowing the shape of [Executor's existing wrapper](../../extensions/executor/index.ts) and exposing bounded search, describe, execute, connection-status, and connect-link operations. These names are proposed, not implemented tools.

Use separate arguments rather than generated shell commands, propagate cancellation and deadlines, bound output, and distinguish a successful process from a successful remote operation. Load schemas on demand. Adding another supported application then becomes account connection and permitted-tool selection, not another Ziggy provider implementation.

The current Composio CLI sources support `COMPOSIO_CACHE_DIR`; without it, state defaults under the user's home. See [cache-directory resolution](https://github.com/ComposioHQ/composio/blob/cd9ee743abdb12b682dde60415a1eecba505fee0/ts/packages/cli/src/effects/setup-cache-dir.ts), [configuration keys](https://github.com/ComposioHQ/composio/blob/cd9ee743abdb12b682dde60415a1eecba505fee0/ts/packages/cli/src/effects/app-config.ts), and [environment prefix mapping](https://github.com/ComposioHQ/composio/blob/cd9ee743abdb12b682dde60415a1eecba505fee0/ts/packages/cli/src/services/config.ts). Merely setting a subprocess cwd to the Profile does not isolate its credentials. Separate local state also does not itself prove distinct remote account permissions. Verify the intended Profile, Composio identity, and connected-account mapping before admitting the integration across Profiles.

If Ziggy later needs embedded account UI or explicit application-user control, the [direct SDK execution path](https://docs.composio.dev/docs/tools-direct/executing-tools) is an alternative backend for the same small operation surface. Composio distinguishes its personal CLI product from its developer platform; do not assume their login credentials are interchangeable. See [CLI workflows](https://docs.composio.dev/docs/cli) and [connected accounts](https://docs.composio.dev/docs/auth-configuration/connected-accounts).

Recommendation: try one optional Composio integration before building a general connector framework. The CLI route avoids new MCP transport work and fits the existing extension model. Ziggy retains Profile selection, admitted operations, and Pi execution; Composio remains a remote dependency for app authentication and execution. This is an architectural recommendation, not runtime compatibility proof.

## Verification limits

Inspected source, current first-party documentation, and repository identity. No external credentials were read and no provider calls were made. A later implementation must verify the pinned CLI or SDK in Ziggy, connect one explicitly authorized account, prove one read operation, and check Profile/account selection and cancellation. Documentation whitespace was checked with `git diff --check`; application tests were not needed for this research-only change.
