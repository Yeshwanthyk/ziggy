# Ziggy Jev

`@ziggy/jev` is an optional Pi extension for bounded judgments through TypeSafe's System One API. It supports one request containing mixed **Choice**, **Score**, and **Noul** questions. `state`, `instructions`, and criteria follow the current TypeSafe JSON shapes: text, an object, an array, or `null` where the API permits it.

The configured default is pinned to `jev-1.13.0`. The response reports the resolved model returned by TypeSafe, token usage, end-to-end latency, and attempt count. The extension does not call the network during startup.

## Pi tool

Select the `jev` shelf package, then call `jev_evaluate`:

```json
{
  "state": {"message": "The export button crashes in Safari."},
  "questions": {
    "team": {
      "type": "choice",
      "instructions": {"question": "Which team owns this?", "focus": "Primary issue"},
      "criteria": {"frontend": {"what": "Browser UI defects"}, "billing": null}
    },
    "severity": {
      "type": "score",
      "instructions": "How severe is the issue?",
      "criteria": ["Cosmetic", {"what": "Broken but has a workaround"}, "Blocking"]
    },
    "needs_review": {
      "type": "noul",
      "instructions": "Does this require human review?",
      "criteria": {"true": "Evidence is ambiguous", "false": "Evidence is clear"}
    }
  },
  "deadlineMs": 10000
}
```

The result is a JSON `JevEvaluation` containing `model`, answers validated against every requested question, `usage.input_tokens`, `usage.output_tokens`, and `meta.{latencyMs,attempts}`. The extension applies no confidence threshold, authorization policy, or automatic action.

## Credentials and configuration

`TYPESAFE_API_KEY` is the preferred credential source and takes precedence over files:

```sh
export TYPESAFE_API_KEY=...
```

An optional fallback is `<profile>/.runtime/jev/credentials.json` containing `{"apiKey":"..."}`. Credential and config files must be regular, non-symlink files with no group/world permission bits. Credentials, request state, and responses are never logged.

Optional non-secret settings live at `<profile>/.pi/jev.json`:

```json
{
  "model": "jev-1.13.0",
  "baseUrl": "https://api.typesafe.ai/v1/systemone",
  "timeoutMs": 30000,
  "maxRetries": 2
}
```

`timeoutMs` is an end-to-end request budget, not a per-attempt timeout. `maxRetries` is bounded to 0–3. Connection failures and transient `408`, `429`, `529`, and `5xx` responses retry within that budget, using `Retry-After` or `retry-after-ms` when usable and bounded exponential backoff otherwise. `401`, `422`, and other non-transient responses do not retry. HTTP base URLs are accepted only for localhost tests.

## Optional cross-extension bridge

The reusable event channel is `ziggy:jev:judgment:v1`. Packages are selected independently, so a consumer must **not import `extensions/jev/**` at runtime**. Instead, copy [`caller.ts`](./caller.ts) into the consuming package and import that local copy. It has no Jev-package-relative imports and provides the typed request, answer, reply, error, validation, and `requestJevJudgment` helper.

```ts
import { requestJevJudgment } from "./jev-caller.ts";

const evaluation = await requestJevJudgment(pi.events, request, {
  profilePath: ctx.cwd,
  signal,
  deadlineMs: 10_000,
});
```

Exact request event:

```ts
{
  version: 1;
  requestId: string;
  operation: "evaluate";
  profilePath: string;
  request: EvaluateRequest;
  signal?: AbortSignal;
  deadlineMs?: number;
  accept(): void;
  reply(response: JevBridgeReply): void;
}
```

Reply:

```ts
{ version: 1, requestId, ok: true, evaluation }
// or
{ version: 1, requestId, ok: false, error: { code, message } }
```

The helper fails immediately with `bridge_listener_missing` when the optional provider is absent. Cancellation, bridge timeout, invalid requests/replies, missing credentials, deadline expiry, invalid upstream responses, rate limiting, and HTTP failures remain explicit failure codes. The provider and `jev_evaluate` tool both call the same validated `JevClient.evaluate` implementation.

## Bounds and lifecycle

- State: at most 256 KiB encoded JSON.
- Complete request: at most 512 KiB, 1–64 questions, bounded JSON depth and collection sizes.
- Upstream response/tool text: at most 48 KiB.
- Deadlines: 100–120,000 ms.
- Retries: at most three after the initial attempt.

There is no polling, transcript collection, caller-data persistence, background process, or generic provider layer. Active requests are aborted and cached clients are closed on `session_shutdown`.

## Verification

All tests use fake fetch responses; they make no paid API calls:

```sh
bun test ./extensions/jev
bunx tsc --noEmit -p extensions/jev/tsconfig.json
bunx oxlint extensions/jev
bunx oxfmt --check "extensions/jev/**/*.ts"
```
