# Ziggy web

A small React client for talking to a local Ziggy Profile. The first slice opens the current
Profile's main conversation, loads its authoritative history, watches that conversation, streams
the response, and keeps an uncertain send visible for reconciliation.

## Run it

```sh
cd clients/example-web
bun install
bun run dev
```

Vite+ serves the development client at <http://127.0.0.1:4174/>. Build the static client with:

```sh
bun run build
```

The build is written to `dist/` and can be served by any static file host. Connection settings ask
for the local WebSocket endpoint and runtime token. The endpoint is remembered in local storage;
the token is kept only in session storage. Reloading the same browser tab reconnects automatically;
a new tab or browser session shows the connection form again.

## Stack boundary

This client follows the frontend foundation from [fatestack](https://stack.fate.technology/): React,
Vite+, Tailwind, and `@nkzw/stack`. Shared controls are generated from the shadcn/ui source
registry and live in `src/components/ui`. The Fate data client and fbtee are intentionally deferred
until they own concrete application behavior. Ziggy already has a typed, replay-aware WebSocket
gateway, so adding Fate's HTTP/SSE backend would create a second transport and transcript path.

Bot identities use a local React adapter over [Bloub](https://github.com/jeremy-prt/bloub). The
adapted upstream engine and its MIT license live under `src/vendor/bloub`.

## Current behavior

- Opens and selects `local/main` for the current available Profile.
- Watches only the selected live conversation; channel sessions are not subscribed at startup.
- Reconciles history when the SDK reports an epoch, replay, or sequence gap.
- Keeps the streamed answer visible if authoritative history cannot yet be read.
- Uses Enter to send, Shift+Enter for a newline, and exposes Stop while the agent is working.
- Adapts the conversation rail into a sheet on narrow screens and respects reduced motion.

Pinned conversations, unopened bots, groups, and secondary Profile settings will follow as later
vertical slices. Stored sessions are deliberately absent from the default rail until the client has
an explicit past-conversations surface.
