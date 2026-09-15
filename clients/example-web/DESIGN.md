# Ziggy web UI

## Scope

This design governs the supplied web client. Other clients can use the framework-neutral
gateway SDK with their own stack and design. The runtime owns conversations, transcripts,
agents, and permissions.

## Reference and character

The user's [Grok Bot screenshot](design/grok-reference.png) is the concrete visual reference:
a narrow conversation rail, colorful bot identities, quiet message surfaces, and a composer
anchored beneath the conversation. Cursor Agents is a secondary reference for compact,
predictable controls; its particular visuals have not been captured here.

The user keeps this local assistant open while working on a desktop. Start with the reference's
light neutral surfaces: white conversation canvas, subtly gray rail, dark readable text.
Personality comes from the bots. Use one system sans-serif family, 14px navigation and
15–16px conversation text. Keep secondary metadata readable. Use a 264–288px desktop rail,
comfortable message spacing, and a transcript measure near 72ch. On narrow screens the rail
becomes a sheet and the composer remains reachable.

## Conversation model

- Startup opens or resumes the main Squarey conversation and selects it. Profile selection
  establishes the assistant being addressed; it does not substitute for opening a conversation.
- The rail prioritizes the main conversation, pinned conversations, directly chat-able bots,
  and group chats. Give conversations human-readable titles.
- Other conversations are available on demand. Runtime channel inventory does not automatically
  become the home rail or a set of startup subscriptions.
- A bot row opens that specialist's direct conversation. Group conversations show their members
  and make the addressed recipient clear.
- Existing automations receive compact status and action controls in the rail. Settings, memory,
  extensions, and automation editing belong in secondary surfaces as those features are rebuilt.

## Components and stack

Use the React/Vite+ fatestack foundation and shadcn/ui source components for the supplied app.
Keep shared controls in one component directory and define common tokens once. Compose app
components for conversation rows, messages, composer, bot identity, and group members from
those controls. The existing gateway SDK owns transport; avoid a second backend or transcript
store. Add fate data-client and fbtee capabilities where they serve concrete app behavior.

Use [Bloub](https://github.com/jeremy-prt/bloub) for bot identities. Its framework-free engine
can be adapted behind a React component; preserve upstream provenance and license. Keep a
stable identity for each bot. Animate to convey activity, respect reduced motion, and retain
text labels so color or shape is never the only identifier.

## Interaction and reliability

- Connection state comes from the transport. A failed conversation subscription is a local
  conversation error, not evidence that the resident is offline.
- Load history and subscribe using the SDK's epoch/cursor contract. Recover a replay gap by
  reconciling authoritative history and the live baseline. Avoid silently losing live events.
- A sent prompt has a visible pending/running/settled state. Preserve the draft on failure;
  never automatically resend an uncertain mutation.
- Enter sends and Shift+Enter inserts a newline. Keep stop available while generating and
  show tool activity succinctly. Announce errors and streaming completion accessibly.
- Live mode shows actual resident data or honest loading/empty/error states. Demo messages
  must not appear as live conversations.
- Keep endpoint/token controls in connection settings. Runtime credentials remain local and
  out of committed assets and logs; only the SDK's authenticated gateway URL carries its token.

## Delivery and review

Rebuild in runnable slices. First prove connecting to Squarey, opening the main conversation,
sending a bounded message, and displaying its reply. Then add pins, bots, and groups with the
same shared components. Keep the browser preview running and refresh after each working build.
Use the checked static preview for user review and the hot-reloading server for active development.
Verify desktop and narrow layouts, keyboard focus, readable contrast, and reduced motion.
Record implemented behavior and future work in the client README.
