# OpenMuse connector and MCP scout

Research date: 2026-09-22. Source snapshot: CopilotKit/openmuse commit [ef8f608bb0305ff97114983de5c9db7ebcd816e2](https://github.com/CopilotKit/openmuse/tree/ef8f608bb0305ff97114983de5c9db7ebcd816e2). This is a source inspection; it does not establish that OpenMuse's live Google acceptance has passed.

## Verdict

OpenMuse has direct, provider-specific integrations rather than a generic connector or MCP host. The shipped personal integrations are Gmail and Google Calendar, implemented as a hand-written REST client plus a Google OAuth/token store. The repository also contains a disabled, contract-tested OpenBot HTTP adapter, but that is an external agent/computer backend, not an MCP connector.

The engine registers a fixed list of local tools with CopilotKit's BuiltInAgent; there is no MCP client, MCP transport, connector manifest, remote tool discovery, or connector registry in this snapshot. The fixed tool list is visible in [engine/model.ts](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/engine/model.ts#L85-L274), and the dependency list has no MCP package in [package.json](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/package.json#L1-L53).

Therefore, Ziggy can reuse OpenMuse's boundary patterns and possibly copy small source-level ideas under the repository's MIT license, but it cannot consume an OpenMuse connector SDK or turn on MCP by configuration. A Ziggy MCP base would be new Ziggy code around an MCP client, with OpenMuse-style credential, review, ownership, and uncertain-outcome boundaries layered above it.

## What OpenMuse actually ships

The README describes Gmail/Calendar as “Google OAuth adapters” and calls out health, bank, and social connectors as future work. The feature matrix likewise lists “other connectors” outside the current release. See [README](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/README.md#L45-L60) and [FEATURES](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/docs/FEATURES.md#L1-L20).

The roadmap names Google Drive/Docs and individually validated social, bank, and health connectors as future work, with each item requiring its own authentication, capability boundaries, failure behavior, and end-to-end evidence ([ROADMAP](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/ROADMAP.md#L10-L24)).

The integration code is not a separately published package. The tree contains packages/integrations/src/google.ts, pdf.ts, and vault.ts, but no packages/integrations/package.json; the root application itself is marked private. The README says the source is MIT-licensed and can be inspected or changed ([README](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/README.md#L39-L43), [license statement](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/README.md#L195-L197)). The MIT notice must accompany copied source. Source imports are tied to OpenMuse's domain types and local layout.

## Direct Google connector

GoogleClient is a useful direct-adapter shape. It accepts an injected getAccessToken() callback and optional fetch, then owns Google-specific URLs, request headers, response decoding, pagination, MIME parsing, and bounded payload checks. It implements Gmail thread/message/attachment reads, calendar discovery and bounded event listing, and send/create/update/delete operations in one provider-specific class ([source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/integrations/src/google.ts#L1-L37), [request and read operations](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/integrations/src/google.ts#L460-L669), [write operations](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/integrations/src/google.ts#L672-L816)).

Important direct-adapter invariants worth carrying into Ziggy:

- IDs, headers, dates, MIME trees, event bodies, and provider responses are validated before they enter the domain. Calendar ranges are capped at 366 days; Gmail list reads are capped at 30 messages; attachments are capped at 10 MiB each and 20 MiB total. [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/integrations/src/google.ts#L98-L150) [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/integrations/src/google.ts#L609-L669)
- Every request obtains a token immediately before dispatch, rejects malformed tokens, uses a 30-second timeout and redirect: "error", and separates definite read failures from uncertain write outcomes. Network/5xx/408 or malformed write responses become OutcomeUnknownError; the caller must reconcile before retrying. [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/integrations/src/google.ts#L551-L607)
- Calendar updates/deletes use the provider ETag in If-Match, and stale versions become a 409 requiring a fresh review. Recurring events are refused explicitly. [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/integrations/src/google.ts#L510-L549) [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/integrations/src/google.ts#L787-L816)

This is a strong implementation reference for a Ziggy provider adapter, but it is not a generic interface. It directly imports OpenMuse Mail, CalendarEvent, and draft schemas, hard-codes Gmail/Calendar endpoints, and uses Node Buffer and fetch.

## OAuth, account binding, and credential lifecycle

GoogleAuth is tightly coupled to OpenMuse's Store, Config, and AppError, but its lifecycle is a good connector pattern:

1. connect(owner, write) checks client ID, client secret, and encryption-key configuration; rotates a connection generation; requests read scopes plus write scopes only when requested; persists a ten-minute, single-use OAuth state; and uses PKCE S256. Read scopes are Gmail readonly, Calendar events readonly, and Calendar list readonly. Write adds gmail.send and calendar.events. [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/google-auth.ts#L36-L145)
2. callback consumes the state with a take/delete operation, checks expiry and generation, exchanges the code, validates Gmail profile ownership, and stores the account plus tokens. Refresh tokens are retained only when the returned account matches the previous account. [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/google-auth.ts#L147-L191)
3. Access-token refresh is deduplicated per owner and connection ID. The refreshed secret is written with a compare-and-swap against the connection ID; a changed or disconnected account fails instead of overwriting newer credentials. [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/google-auth.ts#L192-L233)
4. Disconnect rotates generation, clears local credentials, and asks Google to revoke the refresh/access token. A revocation failure is reported while the local disconnect remains effective. [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/google-auth.ts#L235-L251)

Secrets use a versioned AES-256-GCM envelope with a 32-byte base64 key and authenticated data openmuse:credential:v1; this is an isolated source pattern, not a ready credential service ([vault.ts](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/integrations/src/vault.ts#L1-L55)).

The HTTP surface is intentionally provider-specific: authenticated POST /api/google/connect accepts capability: read|write, and POST /api/google/disconnect clears the connection. The OAuth callback is GET /api/google/callback. [Routes](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/app.ts#L102-L140) [Routes](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/app.ts#L262-L278)

OpenMuse's auth is single-owner per deployment: the access key creates a local-user session, and bearer sessions resolve to that same owner. The README explicitly says this is not multi-tenant authentication. This means its OAuth code is not safe to transplant into a multi-profile Ziggy runtime without replacing owner identity and storage boundaries ([auth.ts](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/auth.ts#L9-L40), [README](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/README.md#L91-L101)).

## Review and executor boundary

OpenMuse does not hand provider write methods directly to the model. The model calls prepare_email or prepare_event; these create a stored proposal with an account/connection ID, target version, hash, expiry, and optional task ID. The prompt explicitly says external writes require these preparation tools and that there is no model tool to approve them ([model](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/engine/model.ts#L215-L243), [prompt and fixed tools](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/engine/model.ts#L281-L303)).

ActionService then provides the reusable execution shell: idempotency-key hashing, provider preparation, connection/account binding, a 30-minute review expiry, hash comparison, task-state checks, single-claim execution, and outcome_unknown recording. Approval rechecks that the same Google account and connection are still present before dispatch. [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/actions.ts#L31-L100) [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/apps/server/src/actions.ts#L102-L201)

This is relevant to connector write policy, but Ziggy's checked-in Executor extension is only an external CLI wrapper; there is no verified shared implementation seam. ActionService is not a connector registry: its options and user-facing errors assume Google, and its provider interface is a single ProposalInput union. The valuable reusable unit is the review/claim/outcome contract, with connector-specific policy injected behind it.

## OpenBot adapter: reusable transport pattern, not MCP

packages/backends/src/openbot.ts is the most reusable extensibility pattern in the snapshot. OpenBotAdapter receives an injected OpenBotTransport with a runtime URL and authenticated request method. It refuses to accept a shared administrator token, validates all responses with Zod, distinguishes disabled, not-configured, authentication, refusal, unavailable, cancellation, and uncertain mutation errors, and preserves opaque IDs. [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/backends/src/openbot.ts#L1-L39) [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/backends/src/openbot.ts#L99-L175) [Source](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/packages/backends/src/openbot.ts#L245-L343).

It is explicitly disabled and constructing it does not connect. Its runtime() returns CopilotKit Intelligence configuration, not an AG-UI SSE URL; its probe, conversation, browser, and control methods are OpenBot-specific. OpenMuse's own integration document calls live session bridging and deployment wiring future work ([OPENBOT-INTEGRATION](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/docs/OPENBOT-INTEGRATION.md#L55-L76)).

For Ziggy, copy the host-injected transport and typed error shape for a future MCP client boundary, but replace the OpenBot schemas and routes with MCP initialize/list-tools/call-tool semantics. Keep per-profile credentials in Ziggy's authority, and pass a connector context containing profile/session, capability, and approval information to every call.

## Reuse decision for Ziggy

| OpenMuse piece | Reuse value | Coupling/limit |
| --- | --- | --- |
| GoogleClient | Direct REST adapter structure, bounded decoding, ETags, and uncertain-write handling | Google-specific; imports OpenMuse domain schemas; no published package or generic connector interface |
| GoogleAuth + vault.ts | PKCE state, generation fencing, refresh dedupe, CAS, encrypted secrets, revocation | Depends on OpenMuse Store, Config, single-owner auth, and Google OAuth endpoints |
| ActionService | Generic review/hash/expiry/claim/outcome shell for consequential connector writes | Proposal union and messages assume Google; adapt as a Ziggy domain capability |
| OpenBotAdapter | Excellent injected authenticated transport and typed-response/error pattern | OpenBot HTTP/computer backend; disabled; not MCP and not wired into OpenMuse runtime |
| OpenMuse UI routes | Apps screen and connect/disconnect UX can inspire a connector status view | Provider-specific endpoints and one-owner session; no manifest/catalog lifecycle |

The smallest compatible Ziggy base is therefore a connector host with two separate layers:

    connector manifest + capability policy
            -> per-profile credential/auth store
            -> injected transport (direct REST or MCP session)
            -> schema decode + typed connector errors
            -> connector-owned write policy and outcome handling
            -> model-facing tool projection and connector status UI

Direct connectors and MCP connectors can share the transport, decode, error, credential, and review contracts while keeping protocol adapters separate. OpenMuse supplies useful examples for those contracts; it does not supply the generic MCP layer itself.

## Proof limits

The current snapshot's automated verification covers Google OAuth state races, scopes, MIME/threads/attachments, ETags, calendar validation, and uncertain writes with controlled HTTP fixtures, but explicitly says no live Google credentials were supplied and a real-account acceptance run remains required ([VERIFICATION](https://github.com/CopilotKit/openmuse/blob/ef8f608bb0305ff97114983de5c9db7ebcd816e2/docs/VERIFICATION.md#L29-L36)). No source inspection here proves a working MCP path, a published reusable connector package, multi-tenant identity, or production Google acceptance.


## Reconciled Ziggy recommendation

Update after user clarification: direct connectors are the immediate goal. MCP hosting/client support is optional and is not a prerequisite or a first-slice acceptance requirement. The earlier two-adapter proposal below describes an eventual extension point, not required initial scope.

This section is a proposal, not implemented behavior. Ziggy was inspected at `2d3bf4a`.

### Existing pieces and the actual gap

- **Extensions already supply installation and runtime admission.** A connector can be an ordinary selected Pi package; it needs no new extension framework. The resolver disables ambient discovery and loads explicit Profile package paths. See [resource composition](../../src/adapters/pi/resources.ts), [resource loader](../../src/adapters/pi/profile-resource-loader.ts), and [minimal specification](minimal-ziggy-scout.md).
- **Executor delegates ownership outside Ziggy.** Its five tools invoke an installed `executor` executable. Its skill assigns connected sources, credentials, policy, approvals, and paused state to that external system. This investigation did not inspect that external implementation. See [wrapper](../../extensions/executor/index.ts) and [skill](../../extensions/executor/skills/executor/SKILL.md).
- **Code Mode owns a bounded stdio MCP path today.** Its config requires commands, explicit environment values, and tool allowlists. Its host constructs only `McpStdioClient`; there is no direct-provider or generic remote HTTP variant. See [config](../../extensions/codemode/src/config.ts), [host](../../extensions/codemode/src/host.ts), and [behavior contract](../../extensions/codemode/README.md).
- **Jev is the direct API precedent.** One provider owns validated requests, credentials, client lifecycle, and invocation. It exposes a Pi tool and an optional typed event bridge for independently selected consumers. See [Jev](../../extensions/jev/README.md) and [implementation](../../extensions/jev/index.ts). Cross-extension relative imports are inappropriate because packages are installed independently.
- **Model login is separate.** Existing application auth delegates to Pi model/provider auth. Personal app accounts should not be inserted into Pi's model `auth.json`. See [auth service](../../src/application/auth.ts).

The missing reusable component is the app connection lifecycle and provider contract: account identity, credential references, scopes, status, refresh/disconnect, operation discovery, validated invocation, cancellation, and bounded results.

### Smallest base

Start with one optional `connectors` extension containing a small provider contract and shared connection handling. Keep providers inside that package initially; avoid a new workspace or independently installable connector framework before there is a demonstrated need.

A provider contributes metadata, its auth strategy, operation schemas, and call implementation. A Profile connection selects that provider and its account/server, credential reference, and explicit allowed operations. Secrets stay in private connector-owned storage; model-visible tool metadata never contains tokens. OAuth flows for Google APIs and an MCP server are distinct strategies, even if they use the same private store.

Two adapters implement the same operation-facing contract:

1. **Direct API:** Google, or another service, supplies typed operations over its API/SDK. Adding a service means writing a small provider module. OpenMuse's injected token callback, scope escalation, refresh deduplication, account fencing, and uncertain-write handling are useful references. Adapt to Ziggy's Profile identity and schema/error conventions instead of importing OpenMuse's database, owner model, or task engine.
2. **MCP tools:** One generic adapter discovers and calls allowed tools from a configured server. Adding a compatible server then mostly means configuration and account setup, rather than a fresh extension. This does not imply support for every MCP feature, resources, or prompts.

Expose operations through normal Pi tools or a bounded search/describe/call surface. If Code Mode later needs these operations, add an explicit typed bridge/provider path to the same connector owner, following Jev; preserve its allowlists and interpreter confinement. Do not give it arbitrary access to all Pi tools, copy clients into each consumer, or make Executor a second credential owner.

### MCP implementation choice

The current official SDK documents the client package as `@modelcontextprotocol/client` and exposes Streamable HTTP and OAuth providers whose persistence is supplied by the host. That fits a Profile-owned credential provider. Sources: [package guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/packages.md), [connection guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md), [OAuth guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/oauth.md).

Use that SDK for a new remote HTTP/OAuth adapter. Preserve Code Mode's existing stdio implementation until any extraction/replacement proves equivalent environment isolation, size limits, cancellation, and process cleanup. Neither SDK availability nor source inspection proves compatibility with Ziggy's pinned Bun/Pi runtime; pin a version and run a small integration probe before adoption.

`pi-mcp-adapter` is an alternative when its richer Pi UI and discovery behavior are desired, but not a drop-in Profile boundary. Programmatic config is isolated; metadata cache paths still derive from its agent directory, and credential ownership needs explicit Profile namespacing. Sources: [SDK config](https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md#sdk-configuration), [cache path](https://github.com/nicobailon/pi-mcp-adapter/blob/main/metadata-cache.ts), [agent directory](https://github.com/nicobailon/pi-mcp-adapter/blob/main/agent-dir.ts). The older local [adapter scout](pi-mcp-adapter.md) covers older versions and is not current compatibility proof.

### First useful slice and proof

Prove one direct Google read path (connect, search/read, refresh, disconnect) and one allowlisted MCP tool through the proposed common operation contract. Add remote MCP HTTP/OAuth in its own bounded follow-up if the initial server is stdio. Defer a broad Apps UI and a generic write-review workflow until the connection lifecycle works through the existing faces.

Acceptance should demonstrate Profile/account isolation, no token disclosure, denied tools staying denied, stale auth/refresh not restoring a disconnected account, cancellation/cleanup, and real output from one explicitly authorized read per provider. Fixture checks cover races; live reads establish actual account/API compatibility. No live account was connected and no such runtime proof was attempted in this research pass.

## Follow-up: building direct connectors without MCP

The user clarified that the immediate question is how to build direct connectors easily, as OpenMuse does. No MCP SDK, MCP host, or connector subprocess is needed for that route. A normal Pi extension can call a provider SDK/API in-process and register its operations as tools.

A small shared helper should own Profile/account resolution, credential access, connection status, schema validation, cancellation/deadlines, and bounded result/error conversion. Each provider module supplies the service-specific SDK/API calls and operation schemas. Start with a Google connector and extract shared pieces when a second provider demonstrates actual reuse. The existing Jev direct extension is the local reference; OpenMuse supplies Google OAuth/account-lifecycle examples.

Current primary-source options found through web search:

| Route | Reused implementation | Remaining Ziggy work |
| --- | --- | --- |
| Native provider SDKs | Google's official Node client supports OAuth2 and automatic access-token refresh from an existing refresh token | Consent/callback flow, private Profile storage, account identity, tool schemas, output normalization, lifecycle |
| Nango for auth | Authorization flows, credential storage/refresh; authenticated proxy or fresh credential retrieval for your own API client | Provider operations and Pi tools; connection IDs bound to the correct Profile/account; deploy/use an additional service |
| Composio for ready-made operations | Connected accounts, managed token lifecycle, tool discovery and direct SDK execution | Pi adapter, Profile/account mapping, explicit allowed tools and version choices; dependency on Composio's API |

Sources: [Google official client](https://github.com/googleapis/google-api-nodejs-client#oauth2-client), [Nango auth](https://nango.dev/platform/auth), [Nango request proxy and auth-only credential retrieval](https://nango.dev/platform/request-proxy), [Composio direct execution](https://docs.composio.dev/docs/tools-direct/executing-tools), [Composio connected accounts](https://docs.composio.dev/docs/auth-configuration/connected-accounts).

Recommendation: use direct provider modules for a small self-contained connector set. If the goal is to add many OAuth-based apps quickly while retaining Ziggy-owned operations, evaluate Nango as the auth backend. If the goal is immediate access to an existing action catalog, Composio is the shorter integration route. All three work without MCP. A future MCP adapter can sit beside these providers when a selected service warrants it.

Revised first slice: one selected connectors extension containing a Google provider, with connect/status/disconnect and Gmail search/read. Prove refresh, account/Profile isolation, cancellation, and an authorized live read. A second connector then determines the smallest shared authoring helper. Do not require an MCP implementation to deliver this slice.

Nango self-hosting qualification: official materials describe free self-hosting for auth and proxy, with wider Functions/sync/webhook/MCP features requiring other deployment tiers. Its server requires database and encryption configuration, so this is an additional operated service rather than a small library embedded in Ziggy. See [self-host comparison](https://nango.dev/blog/best-self-hosted-api-integration-platforms-for-ai-agents#on-self-hosting), [Node client host/getToken/proxy implementation](https://github.com/NangoHQ/nango/blob/master/packages/node-client/lib/index.ts), and [deployment environment](https://github.com/NangoHQ/nango/blob/master/.env.example). No self-host deployment was attempted here.
