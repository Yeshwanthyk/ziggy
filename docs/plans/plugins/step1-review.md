# Step 1 review trail

Builder: `codex exec` gpt-6.1-sol high, session `01a0f573-2747-77c2-8f93-11f7d993175f` (resume with `codex exec resume <id>`). Reviewer: gpt-6.1-sol xhigh, read-only, fresh session per round.

## review1

1. **Major — OAuth tokens can leak through logs and errors.** [src/extensions/mcp.ts:131](/Users/yesh/code/personal/ziggy/src/extensions/mcp.ts:131) supplies a log path without redaction. Pi forwards MCP notifications verbatim to disk (`dist/extensions/mcp/runtime.js:291`, `log.js:23`) and includes HTTP response bodies in connection errors. An in-memory probe using stored OAuth credentials confirmed that an endpoint echoing its Authorization header exposes the token in `connection.error`; Pi’s log formatter also preserves it. **Fix:** redact known credentials before logging or exposing diagnostics, with sentinel tests covering both paths.

2. **Major — Ordinary automations bypass A5.** [src/session/runtime.ts:200](/Users/yesh/code/personal/ziggy/src/session/runtime.ts:200) treats every session without a persona as unrestricted. Untagged automations take that branch through `src/application/automations.ts:398–407`. An enabled extension registering an MCP server therefore gives these automations automatic codemode activation and callable MCP tools without naming them. Direct exposure activates tools directly; deferred exposure enables tool-search. This contradicts the plan’s automation requirement. **Fix:** pass an explicit automation tool policy into session construction and test an untagged automation with a runtime-registered server.

3. **Major — Production rejects specialists that explicitly permit MCP tools.** [src/session/agent.ts:177](/Users/yesh/code/personal/ziggy/src/session/agent.ts:177) validates active tools before `makeChatHandle` binds extensions and starts MCP discovery. A specialist declaring `["codemode", "mcp__fixture__echo"]` initially has only `codemode` active and receives `SpecialistToolUnsupported`. After discovery, codemode-exposed tools are callable without being active, so an active-only check remains unsuitable. The new demo bypasses this production check. **Fix:** validate availability after bounded discovery using exposure-aware registry checks; exercise the production specialist-opening path.

4. **Major — The credential backend does not implement locking.** [src/extensions/mcp.ts:98](/Users/yesh/code/personal/ziggy/src/extensions/mcp.ts:98) implements `withLock` as an unlocked read-modify-write of the entire Keychain blob. Two processes updating different servers can overwrite each other’s credentials; a deterministic interleaving reproduced the lost entry. Pi’s refresh locks cover individual URLs, not the whole blob. Moreover, the Keychain account is global while refresh-lock directories are per Profile, permitting simultaneous refreshes of the same rotating token across Profiles. **Fix:** serialize blob updates across processes and align refresh-lock scope with credential-storage scope.

5. **Major — Standalone codemode lacks its runtime assets.** [src/extensions/mcp.ts:137](/Users/yesh/code/personal/ziggy/src/extensions/mcp.ts:137) enables Pi codemode, but `tooling/standalone-executable.mjs:35` still compiles only `src/main.ts`. Pi requires an embedded QuickJS wasm path and a separately embedded worker (`dist/config.js:397–411`); Ziggy initializes neither. An in-memory Bun build contained neither asset. A binary-only installation consequently cannot execute codemode scripts. **Fix:** embed and initialize the wasm, include the correctly addressed worker entrypoint, and verify a codemode call from an isolated standalone binary.

6. **Minor — The startup timeout claim is too strong.** [LOG.md:1538](/Users/yesh/code/personal/ziggy/LOG.md:1538) promises a maximum 3000 ms startup wait, but `src/extensions/mcp.ts:38–42` synchronously blocks the event loop on Keychain commands for up to ten seconds each. Pi’s three-second timer cannot fire during that work. **Fix:** bound credential access within the startup budget or qualify the documented guarantee.

Formatting, lint, typecheck, knip, and catalog/web-assets/Pi-docs checks passed. Generated outputs match the repository generators. No files were modified; filesystem-writing suites and standalone execution were not run.

Nothing needed from you right now.

VERDICT: CHANGES
## fix1

Addressed all nine findings:

| # | Change and evidence |
|---|---|
| 1 | Added credential redaction through a pinned Pi patch. Real HTTP-error and MCP-log sentinel tests pass. |
| 2 | Added explicit automation policy. Untagged automations deny MCP/codemode/tool-search across all three exposure modes. |
| 3 | Specialist validation now follows binding and bounded discovery, checking active and callable tools. Production `openSession` test passes. |
| 4 | Serialized blob updates with SQLite; refresh locks share the global credential scope. Two-process tests pass. |
| 5 | Embedded QuickJS wasm and the correctly addressed Pi worker. |
| 6 | Corrected the claim: 3000 ms bounds Pi’s timer, not wall-clock startup. |
| 7 | Factory count derives from actual loader options. |
| 8 | Production reload restores tools and completes another MCP call. Empty bindings skip Pi’s reload lifecycle; no production fix was needed. |
| 9 | Built and ran the actual isolated standalone binary: codemode→MCP passed, six checkouts denied, no sidecars. |

Changed the MCP adapter/Pi patch, session and automation policy, platform lock, standalone bootstrap/worker/tooling, focused tests, package metadata, and docs. File:line evidence and results are in [LOG.md](/Users/yesh/code/personal/ziggy/LOG.md:1547).

Checks passed: `bun run check`, `bun test test` (**681 tests**), broader standalone build tests, and binary smoke.

G7 remains deferred. The smoke precreates the existing minimal-Profile automation-directory prerequisite; production behavior there remains unchanged.

No commits, real Profiles, or `extensions/executor` changes. Nothing needed from you right now.
## review2

1. **Major — Returned MCP errors bypass credential redaction.** [src/extensions/mcp.ts:192](/Users/yesh/code/personal/ziggy/src/extensions/mcp.ts:192), [Pi tools.js:229](/Users/yesh/code/personal/ziggy/node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js:229). The patch sanitizes thrown exceptions, but an MCP response with `isError: true` passes through unchanged. An in-memory probe using Pi’s client and adapter preserved the authentication token in both text and structured content. Pi persists tool results; oversized output also goes to plaintext temporary files. **Fix:** redact returned content, structured strings, and progress before conversion or persistence. Add sentinel tests for direct and codemode error results, including oversized output. Round-1 finding 1 remains partially open.

2. **Major — Larger credentials can corrupt the entire Keychain blob.** [src/extensions/mcp.ts:71](/Users/yesh/code/personal/ziggy/src/extensions/mcp.ts:71). `security -i` splits input at 4095 characters. This whole-blob base64 command exceeds that limit with roughly 3 KB of credential JSON. The first fragment can replace the existing password with truncated data; readback detects failure only after the previous credentials have been overwritten. Harmless commands reproduced the splitting on this machine, consistent with [Apple’s parser](https://github.com/apple-oss-distributions/SecurityTool/blob/main/readline.c#L48-L75); a simulated command seam reproduced invalid stored JSON. **Fix:** use a size-safe Keychain writer without secrets in argv. Immediately reject oversized commands before mutation and test realistic multi-server blobs.

3. **Major — Encoded and configured credentials evade the redactor.** [src/extensions/mcp.ts:106](/Users/yesh/code/personal/ziggy/src/extensions/mcp.ts:106). Pi sends `client_secret_basic` as base64 of `client_id:client_secret`, which none of the remembered variants matches. A probe through Pi’s actual refresh function returned that header in an OAuth error; redaction left the decodable secret intact. Configured client secrets that never enter the backend and `registration_access_token` are also missed. **Fix:** remember resolved authentication inputs before transmission, cover registration tokens, and redact the complete Basic authorization value. Test actual authentication methods and runtime-registered credentials.

4. **Major — Automation policy changes ordinary tool permissions.** [src/session/runtime.ts:220](/Users/yesh/code/personal/ziggy/src/session/runtime.ts:220). Supplying this constructed `tools` list overrides Pi’s `defaultTools` settings and explicitly activates registered tools despite `defaultActive: false`. An actual SDK probe changed a session configured with `["read", "grep"]` into one exposing `read`, `bash`, `edit`, `write`, and an intentionally inactive extension tool. This introduces shell access and removes configured tools. **Fix:** preserve configured activation and extension defaults while enforcing MCP exclusions at the registry boundary. Add those regression cases and correct [LOG.md:1550](/Users/yesh/code/personal/ziggy/LOG.md:1550)’s preservation claim.

5. **Major — Synchronous credential access can defeat refresh serialization.** [src/extensions/mcp.ts:162](/Users/yesh/code/personal/ziggy/src/extensions/mcp.ts:162). Pi’s refresh lock expires after 20 seconds and renews through an event-loop timer. Consecutive synchronous Keychain operations and SQLite waits can prevent renewal beyond that threshold. Another process can then take over while the first still holds the old rotating token; Pi ignores lock-compromise notifications. An in-memory clock/filesystem probe through Pi’s refresh flow sent the same refresh token twice before either refresh completed. **Fix:** keep refresh-lock ownership valid during synchronous stalls, or move credential access off the event loop. Test overlapping processes with slow credential operations. The blob lock and shared scope close only part of round-1 finding 4.

Formatting, lint, typecheck, knip, and generator checks passed. A5 registry probes passed, including activation expansion and late registration. Specialist discovery ordering and standalone asset wiring match Pi source. Full filesystem-writing suites and standalone execution were not rerun in the read-only sandbox. No files were modified.

Nothing needed from you right now.

VERDICT: CHANGES


## fix2

Fixed all five findings.

1. **Returned errors:** redaction now runs at Pi’s MCP response boundary, before conversion or persistence. [Sentinel tests](/Users/yesh/code/personal/ziggy/test/session/runtime.test.ts:285) cover direct/codemode errors, structured content, progress, transcripts and oversized-output files.
2. **Keychain corruption:** [async per-key storage](/Users/yesh/code/personal/ziggy/src/extensions/mcp.ts:37) replaces the blob. Pi’s underlying store supports Promise methods (`provider.d.ts:17–20`). Secrets use stdin; oversized commands fail before mutation. Independent multi-server preservation tests pass.
3. **Encoded/configured secrets:** [redaction](/Users/yesh/code/personal/ziggy/src/extensions/mcp.ts:125) covers resolved authentication inputs, registration tokens and complete Basic values. Actual Basic/POST refresh tests and runtime-registration tests pass.
4. **Automation permissions:** [registry filtering](/Users/yesh/code/personal/ziggy/src/session/runtime.ts:213) preserves Pi activation defaults. Tests retain configured `read`/`grep` and keep `defaultActive:false` tools inactive.
5. **Refresh serialization:** synchronous credential operations are gone. Two processes awaiting slow credential subprocesses hold Pi’s refresh lock beyond 20 seconds and issue exactly one refresh request.

Removed the blob, synchronous SQLite wrapper, blob lock, associated directory-validation machinery, synchronous subprocesses and constructed automation allowlist. Updated the Pi patch, lockfile, tests, standalone smoke, plan and [LOG.md](/Users/yesh/code/personal/ziggy/LOG.md:1558).

Checks passed: 16 focused tests; `bun run check` and full test gate through the standalone builder; `bun test test` **685 passed, zero failures**; isolated standalone codemode/MCP smoke with checkout access denied.

Individual writes retain [Apple’s parser limit](https://github.com/apple-oss-distributions/SecurityTool/blob/main/readline.c#L48-L75) and safely reject oversized commands. G7 remains deferred. No commit, real Profile access or executor changes.

Nothing needed from you right now.
## Round 3 direction

The user decided to drop the Pi patch entirely and run Step 1 on stock Pi 0.99.1, which replaces the
round-2 design. Round 3 should review this version.

- Gone: the patch, `patchedDependencies`, the async per-key Keychain OAuth store, `rememberCredentials`
  and the credential redactor, `security` subprocesses, `onStartup` and the discovery wait, the
  `toolFilter` automation predicate and the constructed tool lists. Their tests are gone too.
  `src/platform/file-lock.ts` matches `main`.
- OAuth: the credential store reads nothing and refuses writes, and `openUrl` refuses. OAuth plugins are
  disabled until G3.
- A5: the MCP stack (MCP, codemode, tool-search) is loaded only for main sessions, and for persona
  sessions whose allowlist names `codemode` or an `mcp__` tool. Untagged automations never load it.
  `mcp__*` names in a specialist allowlist are not refused before their server connects.
- Redaction: an inline `tool_result` handler replaces configured header, env and client-secret values in
  MCP, codemode and MCP resource results (content, `structuredContent`, details), including nested
  codemode calls. When it fails, it withholds the result.
- Accepted risks: Pi's `mcp.log` is plaintext (user cache, outside the Profile). Pi spills results over
  20 KB to temp files before `tool_result`, so those files may be unredacted (`tools.js:81-100`, before
  `agent-session.js:327`). Progress messages also bypass the hook.
- Round-2 findings 2, 3 (OAuth parts) and 5 no longer apply because the code they covered is gone.
  Finding 1 is now handled by the hook, except for temp-file spills and progress (accepted). Finding 4
  is handled by not loading the stack, so automation defaults are untouched.

Evidence and checks are in `LOG.md` under "Plugins Step 1: Pi MCP and codemode (stock Pi 0.99.1)".
`step1-review3-prompt.md` predates this rework.
