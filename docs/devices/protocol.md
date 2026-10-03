# ZDP/1 — the Ziggy device protocol

A device opens a WebSocket to the Profile's device hub, runs a Noise handshake inside it, and then
exchanges JSON-RPC 2.0 messages and binary chunks, each one Noise-encrypted. This page is the whole
contract; `src/devices/protocol.ts` holds its schemas, and every fenced `zdp` example below is
decoded by `test/devices/protocol.test.ts`.

## Transport

- The device connects to `ws://<host>:<port>/zdp/1` (or `wss://` through a tunnel). The hub
  address is in the pairing URI, or found by mDNS `_ziggy._tcp`, whose TXT record has `zdp=1`.
- Every WebSocket message is binary. Text messages close the link with `4400`.
- The device is the Noise initiator; the hub is the responder. The pattern is
  `Noise_XX_25519_AESGCM_SHA256` and the prologue is the ASCII bytes `zdp/1`. The three handshake
  messages are the first three WebSocket messages; their payloads are empty.
- After the handshake every WebSocket message is one Noise transport message (at most 65535 bytes)
  holding one **frame**.
- A failed decrypt is fatal: the receiver closes with `4400`.

## Frames

The first plaintext byte says what the frame is:

| First byte | Frame |
|---|---|
| `0x7B` (`{`) | One JSON-RPC 2.0 message, UTF-8, the whole frame. |
| `0x01` | A chunk: `0x01`, stream id (u16 big-endian), flags (u8, bit 0 = last chunk), data. |

Anything else closes the link with `4400`. A JSON message is at most 65535 − 16 bytes once
encrypted; anything larger (images, audio) travels as chunks on a stream.

**Streams** carry bytes that a JSON message introduces. The message names the stream id; its
chunks follow in order, and the chunk with the last flag set ends it. Devices allocate odd stream
ids and the hub even ones, so the two never collide. Ids are reused only after their stream ended.

## Keys and pairing

Each side has a static X25519 key. The hub's lives in the Keychain; the device keeps its own.
Each pins the other's at pairing; after that, the handshake proves both.

`ziggy devices pair <profile>` prints a pairing URI, valid once for ten minutes:

```
zdp://192.168.1.20:7316/pair?code=K7QM-3XW9-TB&key=<hub public key, base64url>
```

- `code` is ten Crockford base32 characters; the dashes are for reading aloud and are ignored.
- `key` is the hub's static public key. The device refuses the handshake if the hub proves any
  other key, so a man in the middle cannot pair.

The device connects with a static key the hub has not seen, and its first message is
`device.pair` instead of `device.hello`, carrying the code. The device has already checked that the
hub proved the `key` from the URI, so the code travels only to the real hub, encrypted. The hub
checks it against its open codes (it stores only their hashes), spends it, records the device's
public key, and answers with the id it gave the device. A wrong or expired code is answered with
`-32002` and the link is closed with `4401`.

```json zdp
{"jsonrpc":"2.0","id":1,"method":"device.pair","params":{"code":"K7QM-3XW9-TB","name":"Kitchen","model":"esp32-s3-box-3"}}
```

```json zdp result=device.pair
{"jsonrpc":"2.0","id":1,"result":{"id":"kitchen","profile":"pal"}}
```

After pairing the device continues with `device.hello` on the same link.

## Session

### `device.hello` (device → hub, request)

The first message of every paired connection. The hub refuses other methods until it succeeds.

```json zdp
{"jsonrpc":"2.0","id":1,"method":"device.hello","params":{"zdp":"1","name":"Kitchen","model":"esp32-s3-box-3","firmware":"0.1.0","capabilities":{"tools":{"listChanged":true},"screen":{"width":320,"height":240,"formats":["rgb565","jpeg"]},"audio":{"in":["pcm16/16000"],"out":["mp3"]},"chat":{}}}}
```

```json zdp result=device.hello
{"jsonrpc":"2.0","id":1,"result":{"id":"kitchen","profile":"pal","zdp":"1"}}
```

`capabilities` says what the device can do; every key is optional:

- `tools`: the device has commands. The hub calls `tools/list` after the hello, and again
  whenever the device sends `notifications/tools/list_changed`. That includes a device that adds
  its first command after the hello.
- `screen`: it can show text and images of this size in these formats.
- `audio`: it can record (`in`) and play (`out`) these formats.
- `chat`: it can talk to the Profile with `chat.send`.

A device without `chat` is a pure peripheral; a device without `tools` only talks.

### `ping` (either way, request)

Each side pings after 20 s without sending anything and drops the link after 60 s without
receiving anything (close `4408`). The result is empty.

```json zdp
{"jsonrpc":"2.0","id":"h-7","method":"ping"}
```

```json zdp result=ping
{"jsonrpc":"2.0","id":"h-7","result":{}}
```

## Tools (hub → device)

These are MCP's shapes. The hub exposes each command to the Profile as the tool
`device__<id>__<name>`. Names match `[a-z0-9_]{1,48}`.

- The hub keeps the latest list in the device's registry entry.
- A session gets the tools listed when it opens, and only in the process that runs the hub. A
  foreground `ziggy run` has none.
- Providers cap tool names at 64 characters. A command whose full name is longer is skipped with
  a warning, so keep the device id and command name short.
- Calling a device that is not connected fails at once with "`<id>` is offline". It does not wait
  for the 30 s limit.

```json zdp
{"jsonrpc":"2.0","id":"h-1","method":"tools/list"}
```

```json zdp result=tools/list
{"jsonrpc":"2.0","id":"h-1","result":{"tools":[{"name":"lights_set","description":"Set the kitchen lights.","inputSchema":{"type":"object","properties":{"on":{"type":"boolean"}},"required":["on"]}}]}}
```

```json zdp
{"jsonrpc":"2.0","id":"h-2","method":"tools/call","params":{"name":"lights_set","arguments":{"on":true}}}
```

```json zdp result=tools/call
{"jsonrpc":"2.0","id":"h-2","result":{"content":[{"type":"text","text":"lights on"}]}}
```

A failure the model should see is a result with `isError: true`; a JSON-RPC error is for a call
that could not run at all. The hub gives a call 30 s.

```json zdp result=tools/call
{"jsonrpc":"2.0","id":"h-3","result":{"content":[{"type":"text","text":"the relay did not answer"}],"isError":true}}
```

```json zdp
{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}
```

## Chat (device → hub)

One Profile session per device. `chat.send` starts a turn and is answered at once with its id;
the turn then streams as notifications. A second `chat.send` while a turn runs fails with `-32001`.
A device that did not declare `chat` is refused with `-32002`. Turn ids are unique per connection;
a refused send does not use one. The conversation lives in the Profile under
`sessions/device/<id>` and continues across connections.

```json zdp
{"jsonrpc":"2.0","id":2,"method":"chat.send","params":{"text":"What's on today?"}}
```

```json zdp result=chat.send
{"jsonrpc":"2.0","id":2,"result":{"turn":"t1"}}
```

```json zdp
{"jsonrpc":"2.0","method":"chat.status","params":{"turn":"t1","state":"tool","tool":"calendar_today"}}
```

```json zdp
{"jsonrpc":"2.0","method":"chat.delta","params":{"turn":"t1","text":"You have "}}
```

```json zdp
{"jsonrpc":"2.0","method":"chat.done","params":{"turn":"t1","text":"You have two meetings."}}
```

```json zdp
{"jsonrpc":"2.0","method":"chat.error","params":{"turn":"t1","message":"the model is unavailable"}}
```

`chat.status` `state` is `thinking` or `tool` (with the tool's name). `chat.delta` carries new text
only; `chat.done` carries the whole reply. Exactly one of `chat.done` and `chat.error` ends a turn.

Voice: `chat.send` may carry `audio` instead of `text`. The device streams the recording on the
named stream (PCM16 mono at 16 kHz, 0.3–20 s); the hub answers with the transcript before the reply.

```json zdp
{"jsonrpc":"2.0","id":3,"method":"chat.send","params":{"audio":{"stream":1,"format":"pcm16/16000"}}}
```

```json zdp
{"jsonrpc":"2.0","method":"chat.transcript","params":{"turn":"t2","text":"what's on today"}}
```

`chat.abort` stops the running turn, which then ends with `chat.error`. With no turn running it
succeeds and does nothing.

```json zdp
{"jsonrpc":"2.0","id":4,"method":"chat.abort"}
```

```json zdp result=chat.abort
{"jsonrpc":"2.0","id":4,"result":{}}
```

## Push (hub → device, notifications, any time)

```json zdp
{"jsonrpc":"2.0","method":"notify","params":{"title":"Reminder","text":"Stand-up in 5 minutes."}}
```

```json zdp
{"jsonrpc":"2.0","method":"display.show","params":{"text":"Back in 10."}}
```

```json zdp
{"jsonrpc":"2.0","method":"display.show","params":{"image":{"stream":2,"format":"rgb565","width":320,"height":240}}}
```

```json zdp
{"jsonrpc":"2.0","method":"audio.play","params":{"stream":4,"format":"mp3"}}
```

The hub sends only what the device's `capabilities` allow: `display.show` only with `screen`,
images in a listed format at the device's size, `audio.play` in a listed `out` format.

Ziggy pushes `notify` for an automation broadcast to `device:<id>`, titled with the Profile's
name; the text is cut at 4000 code points. The model's `device_show` tool sends `display.show`
text. Push is fire-and-forget: a device that is offline when a push is due does not get it later.

## Errors

Error responses use JSON-RPC's codes and these:

| Code | Meaning |
|---|---|
| -32700 | The frame is not JSON. |
| -32600 | Not a JSON-RPC 2.0 message. |
| -32601 | Unknown method. |
| -32602 | The params do not match this page. |
| -32603 | The receiver failed. |
| -32001 | Busy: a chat turn is running. |
| -32002 | Not allowed yet: `device.hello` has not succeeded, or pairing was refused. |
| -32003 | The hub does not speak this `zdp` version. |
| -32004 | Timed out. |

```json zdp error
{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"a turn is running"}}
```

Unknown notifications are ignored.

WebSocket close codes:

| Code | Meaning |
|---|---|
| 4400 | Protocol violation: bad frame, failed decrypt, handshake out of order. |
| 4401 | The device key is not paired, or was revoked. |
| 4408 | No message for 60 s, or the handshake or hello took over 10 s. |
| 4409 | The same device connected again; the older link is closed. |
| 4426 | Unsupported `zdp` version. |

## Versioning

The version is in three places that must agree: the path `/zdp/1`, the Noise prologue `zdp/1`
and `device.hello`'s `zdp`. Receivers decode strictly: a field this page does not name is an error.
Within version 1, a new field or method may only be added behind a capability in `device.hello`,
so a peer never receives what it did not ask for. Anything else is version 2.
