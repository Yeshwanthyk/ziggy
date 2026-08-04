# CLI slices

## What shipped

`ziggy auth <profile>` reports Profile-local provider status. Interactive
`ziggy auth <profile> <provider> [--type api_key|oauth]` delegates login to Pi and stores
credentials in the Profile.

## Next 1: sessions

Implement Chunk 1 from [`openclaw-hermes-primitives.md`](./openclaw-hermes-primitives.md):

```text
ziggy sessions <profile> [--json]
```

The command recursively discovers session leaf directories without following directory symlinks,
refuses symlinked `.jsonl` files, and invokes pinned Pi `SessionManager.listAll(customDirectory)`
once per leaf. It projects only session ID, relative path, created/modified timestamps, and message
count; Pi's transcript-derived preview fields never leave the adapter.

Acceptance:

- Missing session directories print `no sessions`.
- Every Pi-readable regular JSONL appears once, newest-first with a stable path tie-break, regardless of header-cwd spelling.
- Text and JSON reveal no prompts, replies, or transcript previews.
- Regular files for which Pi cannot build metadata produce a typed failure; tolerated lines remain Pi policy.
- Directory symlinks are ignored and `.jsonl` file symlinks fail before Pi reads the leaf.

## Next 2: doctor

Implement Chunk 2 from [`openclaw-hermes-primitives.md`](./openclaw-hermes-primitives.md):

```text
ziggy doctor <profile> [--json]
```

The command is read-only and reports stable check codes with `ok`, `warn`, or `error` for Profile
initialization/readability, optional channel config decoding, session metadata, and automation
parsing.

Reuse existing local config/automation decoders and the session projection. Do not call
`Auth.status` (Pi may create or refresh credential files), call a provider, poll Telegram, open
Discord/Slack, load executable extensions, test skill binaries, migrate config, or repair files.
Skill requirement/shape diagnosis remains out because Ziggy does not own a skill parser.

Acceptance:

- Exit 0 when there are no errors; absent optional channels are not errors.
- Exit nonzero when any check is an error.
- Never print secrets or transcript content.
- Text and JSON expose the same stable codes, severities, and order.

## Later

Voice presets and broad exit-code cleanup are not needed for the next end-to-end milestone. Reopen
them only when a concrete UX or scripting failure requires them.

## Proof

Each slice lands separately with focused tests, followed by:

```sh
bun test
bun run check
```
