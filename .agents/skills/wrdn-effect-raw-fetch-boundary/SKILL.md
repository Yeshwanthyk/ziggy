---
name: wrdn-effect-raw-fetch-boundary
description: Route HTTP through Effect boundaries instead of raw fetch. Use when lint flags ziggy-effect/no-raw-fetch or when adding networked protocol or Provider code.
---

HTTP in Ziggy protocol, provider, and Extension code should go through Effect services so tests
can replace real networks with local protocol fixtures or mock `HttpClient`
layers.

## Fix Shape

- Prefer `effect/unstable/http` `HttpClient` and `HttpClientRequest` for
  ordinary HTTP calls.
- Accept an injectable `HttpClient.HttpClient` service or Layer on provider code
  when callers need to inject a test client.
- In tests, use real local servers plus `FetchHttpClient.layer` or a captured
  `HttpClient` service from the test layer.
- Do not add fetch-shaped abstractions in SDK or Extension seams. If a third-party
  library truly only accepts `fetch`, keep the adapter in the owning package,
  name the forced boundary explicitly, and delegate internally to Effect
  `HttpClient`.
- Do not type new protocol or Extension seams as `typeof globalThis.fetch`; keep the
  ambient runtime boundary out of domain and test APIs.
- Do not patch `globalThis.fetch`. Replace those tests with a local server,
  `HttpClient` layer, or the approved Effect-backed adapter.
- Do not add a broad allowlist entry unless the file is a platform entrypoint
  or a temporary migration target.

## Approved Boundaries

- Worker/handler objects whose public API must expose a `fetch` method.
- Test calls to a worker or Miniflare binding's `.fetch(...)` method.
- Small adapters for libraries that only accept `fetch`, if the implementation
  delegates to Effect `HttpClient`.
- Browser UI event handlers may remain raw only until app-side boundaries are
  classified; prefer SDK/client APIs where available.

## Bad

```ts
const response = await fetch(url);
```

```ts
const fetchImpl = options.fetch ?? globalThis.fetch;
```

## Good

```ts
const client = yield * HttpClient.HttpClient;
const response = yield * client.execute(HttpClientRequest.get(url));
```

```ts
const extension = makeGraphqlExtension({ httpClientLayer: testHttpClientLayer });
```
