---
shaping: true
---

# Automation — Frame

## Source

> then we need to fix the automation flow . i was wondering wher it got it form
>
> where is the delivery mode history_only how can we add differnt broadcasts and back to tui. what
> hapopens if tui is not open when it has run?

> Also, the TUI doesn't seem to have any automation support, so I can't really see what has been
> added and what has been removed or how i cna modify it

> we need to decide on the vertical slices for automatoin and add them in

## Problem

Ziggy has a truthful manual `wake` primitive but no agent-facing automation tools, scheduled
owner, durable result view, or TUI management surface. In the Yoko test, the model escaped to the
Merlin/Claw binary, wrote a second automation authority under `.claw/`, and reported success even
though `history_only` could not deliver into Ziggy's TUI and no Yoko scheduler service owned the
next firing.

## Outcome

A user can ask Ziggy to create or change an automation and immediately inspect the same
Ziggy-owned definition in the TUI. Manual and scheduled runs leave truthful durable results that
the TUI can show now or after reopening. A dedicated Profile scheduler runs independently of the
TUI, and one result can broadcast to explicit Telegram, Discord, and Slack destinations without
making those transports a second source of truth.
