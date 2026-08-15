# Channel delivery

## What shipped

Telegram, Discord, and Slack each have a complete deterministic inbound-to-reply vertical slice.

- Telegram drops the pending tail on cold start, then processes only new updates.
- Discord and Slack keep a bounded recent-ID set to suppress socket redelivery.
- Only the configured owner reaches Pi.
- Each accepted message maps to the correct Profile memory context and persistent chat.
- Slack replies stay in the source thread.
- Socket and chat resources close with the gateway scope.
- Discord HTTP 401/403 fails startup instead of retrying forever.

This follows the smallest useful Hermes behaviors without adding a delivery subsystem.

## Next: live disposable proofs

Use `/Users/yesh/Documents/personal/dump/ziggy-vertical-slices/pal` and prove one channel at a time:

1. Telegram: start the gateway, send one owner DM, receive one reply, restart, and verify offline
   backlog is dropped.
2. Discord: start with a disposable bot, send one owner DM, receive one reply, and verify invalid
   credentials fail immediately.
3. Slack: start Socket Mode, send one threaded owner DM, and verify the reply stays in-thread.

Do not use or take over production bots for these proofs.

## Later: durable inbound journal

Build this only when the gateways become load-bearing and replay across process crashes matters.

The smallest durable slice is one shared journal keyed by
`<gateway>:<chat-key>:<message-id>` with two states:

- `accepted`: persisted before opening Pi;
- `replied`: persisted after every reply chunk succeeds.

On restart, ignore `replied` messages and surface unresolved `accepted` messages for explicit
recovery. Do not add per-channel claim stores, a general event bus, or an outbound ledger in the
same slice.

## Proof

```sh
bun test test/application/gateway.test.ts \
  test/application/discord-gateway.test.ts \
  test/application/slack-gateway.test.ts \
  test/adapters/discord/socket.test.ts
bun run check
```
