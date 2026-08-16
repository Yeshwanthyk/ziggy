# Ziggy gateway example

This browser page uses `@ziggy/gateway-client` to open a local UI chat and watch live
channel sessions. Read the port and token from the Profile's `.runtime/ui-server.json` file,
then paste them into the connection strip.

Run these three commands from the Ziggy repository:

```sh
bun src/main.ts serve scratch2
bun build clients/example-web/main.ts --outdir clients/example-web/dist --target browser
open clients/example-web/index.html
```

The page is local-only. The token stays in the browser tab and is sent to the loopback
WebSocket endpoint as its authentication query parameter.
