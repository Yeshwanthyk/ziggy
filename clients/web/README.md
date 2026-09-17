# Ziggy web

A small React client for talking to a local Ziggy Profile. The first slice opens the current
Profile's main conversation, loads its authoritative history, watches that conversation, streams
the response, and keeps an uncertain send visible for reconciliation.

## Run it

```sh
cd clients/web
bun install
bun run dev
```

Vite+ serves the hot-reloading development client at <http://127.0.0.1:4174/>. It can reset while
React modules are actively changing. Build the checked static client with:

```sh
bun run build
```

The build is written to `dist/`. A configured `ziggy serve` listener serves the checked web client,
pairing endpoint, and WebSocket from one origin. A browser opened through a `ziggy web pair` link
receives an HttpOnly session cookie and reconnects after resident or browser restarts. Manual
WebSocket endpoint and runtime-token entry remains available for an explicitly external client.

## Stack boundary

This client follows the frontend foundation from [fatestack](https://stack.fate.technology/): React,
Vite+, Tailwind, and `@nkzw/stack`. Shared controls are generated from the shadcn/ui source
registry and live in `src/components/ui`. The Fate data client and fbtee are intentionally deferred
until they own concrete application behavior. Ziggy already has a typed, replay-aware WebSocket
gateway, so adding Fate's HTTP/SSE backend would create a second transport and transcript path.

Bot identities use a local React adapter over [Bloub](https://github.com/jeremy-prt/bloub). The
adapted upstream engine and its MIT license live under `src/vendor/bloub`.
The 96-variant catalog in `src/lib/blob-catalog.ts` assigns each normalized bot identity a stable
shape/color from a curated subset automatically, including newly discovered bots. Avatars animate while idle or thinking,
pause in hidden tabs, and respect reduced motion.
These identities belong to this supplied UI; no avatar fields are written into Profile agent files.

## Current behavior

- Opens and selects `local/main` for the current available Profile.
- Lists Profile specialists and opens their direct conversations on demand.
  Direct conversation headers expose an editor for the agent's description, model override,
  thinking level, comma-separated tools, and instructions. Saves use source comparison and apply to
  new specialist sessions; existing conversations keep their current runtime.
- Lists existing groups, creates groups with up to four specialists, and addresses the host,
  everyone, or one member from the composer.
- Lists active, paused, and conflicted automations with run, pause, and resume controls where valid.
  Clicking a name opens its task, complete source definition, schedule, scheduler status, and runs
  filtered to that automation. Edit exposes the supported flat fields and task or the complete
  literal source; Save uses the displayed source as a compare-and-swap guard against overwriting a
  newer file.
- Reads and updates Profile-owned conversation pins.
- Restores the selected main, specialist, or group conversation when the same tab reloads.
- Watches only the selected live conversation; channel sessions are not subscribed at startup.
- Reconciles history when the SDK reports an epoch, replay, or sequence gap.
- Keeps the streamed answer visible if authoritative history cannot yet be read.
- Uses Enter to send, Shift+Enter for a newline, and exposes Stop while the agent is working.
- Renders assistant Markdown, including lists, tables, links, and code. Remote images stay links;
  raw HTML is not rendered.
- Settings exposes the connection, configured provider status, and available default models with
  supported thinking levels. Saving changes the Profile default for new sessions; existing chats
  retain their model. Provider credentials remain managed on the host.
- Adapts the conversation rail into a sheet on narrow screens and respects reduced motion.
- Keeps populated rail data visible during refresh and labels first-load restoration explicitly.

Stored sessions, memory, extensions, and other Profile settings remain outside this compact
conversation surface. Stored sessions are deliberately absent from the default rail until the client
has an explicit past-conversations surface.

## Credential requests: proposed follow-up

A future agent-requested credential form should submit values outside the transcript and return
only a success acknowledgement or opaque reference to the agent. A scoped host adapter would use
the credential. This is not implemented by the current settings form. Keeping a value out of chat
does not make it inaccessible to an agent that can read the same environment or files with shell
tools; that stronger guarantee needs an isolated credential broker and restricted access.
