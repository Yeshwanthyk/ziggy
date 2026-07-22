# North Star

**Ziggy is a folder that is an assistant.**

Drop the executable into a directory, run `ziggy init`, and that directory becomes a resident
Profile: the folder is the durable identity, and its path is identity rather than a separate
name field. It has a `SOUL.md` that defines who it is, a Memory that grows as you talk to it,
and a runtime whose agent loop stays alive waiting for you — not the other way around. You
don't start a process and hope it remembers you tomorrow. You have a thing that already exists,
and you reach it.

## The product story

1. **Drop it.** One compiled binary, no install step, no external services required to start.
2. **`ziggy init`.** Scaffolds a Profile: config, `SOUL.md`, a choice of starter Voices, empty
   Memory, and empty Session and Extension directories. The first main-dependent Client command
   asks the daemon to lazily create the Profile's stable main Session.
3. **Mold it.** Edit `SOUL.md` in a text editor. Add Extensions — your own, or ones from the
   maintained set (smart-memory, smart-extensions, executor). A Voice means only a starter
   `SOUL.md` template offered by `ziggy init`; per-Session persona pinning is not a v1 concept.
   The default install is minimal on purpose; you build up from there.
4. **Reach it from anywhere.** The daemon is resident and is the sole process writer for
   machine-owned Profile state. Human-owned moldable files such as `SOUL.md` are correctly
   hand-edited on disk and hot-reloaded. CLI, a rich TUI, a future GUI, and Gateways (Telegram
   first) all attach as Clients over the same protocol and never write Profile files. Attach,
   detach, reattach — the Session doesn't care, and disconnecting a Client never kills the work
   in flight.
5. **It works while you sleep.** Automations are files with a trigger (schedule or webhook) and
   a wake-gate — a cheap check, often costing nothing, that decides whether the trigger firing
   is actually worth a Run. When it fires for real, it gets a fresh Session, its own pinned
   provider/model/skills/prompt, and a Broadcast rule for where the result goes.
6. **It costs nothing when idle.** No heartbeat. No periodic self-wake. The daemon is a normal
   resident OS service — idle means zero LLM calls and zero tokens, not a low-frequency poll
   loop pretending to be idle.

## The shape

```
┌─────────────────────────────────────────────────────────────┐
│  Clients                                                     │
│  CLI · rich TUI (pi-tui) · GUI (later) · Gateways (Telegram) │
│  — attach, subscribe, steer, send input. Never mutate.       │
└───────────────────────────┬────────────────────────────────┘
                             │ attach protocol (NDJSON over socket)
┌───────────────────────────▼────────────────────────────────┐
│  Runtime waist                                                │
│  Daemon · Session engine · native turn/tool loop over pi-ai   │
│  Memory · Provider adapters · Extension host · Automation      │
│  scheduler — process writer for machine-owned Profile state   │
└───────────────────────────┬────────────────────────────────┘
                             │ filesystem, local now / Cloudflare later
┌───────────────────────────▼────────────────────────────────┐
│  Worlds                                                       │
│  Local disk (v1) · Cloudflare Durable Objects + R2 (S7)       │
└─────────────────────────────────────────────────────────────┘
```

The waist is intentionally the only thing that's hard to replace. Clients are cheap and
disposable — dependency-free leaves that speak one protocol. Worlds are a storage seam, not
an architecture — moving from local disk to Cloudflare should change where bytes live, not
what a Session or a Memory is.

## What ziggy deliberately is not

- **Not always-on.** No LLM self-wake, no heartbeat, no "check in every N minutes" background
  cost. If nothing triggers it, it burns nothing.
- **Not vector-memory machinery, at v1.** Memory starts at S1 with `MEMORY.md` and `USER.md`;
  S6 adds person-scoped `memory/people/` files, which are therefore part of v1. All have hard
  size caps enforced by rejection at write time. Any index over them is a rebuildable
  projection, never an authority — search sophistication can come later without touching the
  memory model.
- **Not running delegated engines.** There is no separate supervision subsystem for
  subscription-auth providers (e.g. Codex). pi-ai already treats a Codex subscription as a
  normal wire provider; ziggy's loop stays the only loop.
- **Not a plugin registry with sprawling in-process API surface.** The default Extension
  authoring path is markdown and manifest, no code loading. The one in-process escape hatch
  (`defineTool`) is small, install-approval-gated, and not how most Extensions should be built.
- **Not a system with two writable authorities for the same fact.** See
  `docs/CONSTITUTION.md` — every piece of durable state has exactly one owning authority and one
  canonical home.

## Release posture

Ziggy retains its open-source product ambition and Apache-2.0 license, but the repository remains
private until the user explicitly says to make it public. Repository visibility is independent of
the release line. Polished, cross-platform, easily-installable binaries remain a v1 milestone:
they ship after S6 (Reach — the Telegram gateway lands and the core surface is proven end-to-end),
unless that timing is separately changed.
