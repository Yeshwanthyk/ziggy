# CLI slices

> This older queue is superseded by
> `docs/plans/profile-agent-session-lineage-and-cli.md`. The newer plan keeps these read-only
> session and doctor requirements and places them in the complete Profile agent and setup flow.

## What shipped

`ziggy auth <profile>` reports Profile-local provider status. Interactive
`ziggy auth <profile> <provider> [--type api_key|oauth]` delegates login to Pi and stores
credentials in the Profile.

## Next 1: sessions

Add:

```text
ziggy sessions <profile>
```

The command is read-only. It lists root TUI/run sessions plus Telegram, Discord, Slack, and
automation session leaves. Each output row contains:

```text
<profile-relative-jsonl-path>  <created-iso>  <entry-count>
```

Keep Pi imports in `src/adapters/pi/sessions.ts`. Use `SessionManager.list` once per known leaf
directory, open each session only for metadata, sort by relative path, and never print transcript
content.

Acceptance:

- Missing session directories print `no sessions`.
- Every valid JSONL appears once.
- Output reveals no prompts or replies.
- Malformed or unreadable sessions return a typed failure.

## Next 2: doctor

Add:

```text
ziggy doctor <profile>
```

The command is read-only and reports `ok`, `warn`, or `error` for:

- `SOUL.md` and Profile readability;
- provider auth availability;
- Telegram, Discord, and Slack config decoding;
- memory files and caps;
- automation parsing;
- installed skill shape.

Reuse existing decoders and auth status. Do not duplicate validation or repair files.

Acceptance:

- Exit 0 when there are no errors.
- Exit nonzero when any check is an error.
- Never print secrets or transcript content.
- Stable output order makes failures easy to diff.

## Later

Voice presets and broad exit-code cleanup are not needed for the next end-to-end milestone. Reopen
them only when a concrete UX or scripting failure requires them.

## Proof

Each slice lands separately with focused tests, followed by:

```sh
bun test
bun run check
```
