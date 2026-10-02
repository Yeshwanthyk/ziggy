# Inspect stored sessions

List a Profile's stored sessions or inspect one session's metadata:

```sh
ziggy sessions list squarey
ziggy sessions show squarey SESSION_ID
```

These commands are transcript-free. Their output is limited to paths, IDs, Pi session display names,
lineage, timestamps, entry counts, model and thinking changes, usage, and safe terminal state. They
never print prompts, replies, thinking, tool arguments, or tool output.

Ziggy records the display name through Pi's native `session_info` entry. Existing names and explicit
name clears remain authoritative. A new channel or stable local route starts with its available
semantic identity and adds a bounded first-message topic; an otherwise unnamed conversation uses
the topic alone. One-off specialist runs include both the agent identity and task topic. The direct
UI agent route remains one continuing session per agent; its name does not create a second routing
identity.

## One writer per session

Each stored session has one writer at a time. The process that opens a session holds it until it
closes or exits; separate lanes (each Slack or Discord thread, each `ui/<name>`, each automation
run, each specialist task) have their own sessions and never contend. A second opener of the same
session is refused instead of interleaving writes: the CLI prints "this session is open in another
process (pid N); use the UI, or start a new session", the web UI shows the session as busy, and an
automation delivery fails as retriable `session-held`. Retry later, use the process that holds it,
or start a new session. `ziggy run --continue` and `--session` refuse a session the resident holds.

## Resume and model in the web UI

The resident web UI can resume an older web conversation (`local/main` or `ui/<name>`) from its
session picker; group, specialist, automation, and channel transcripts cannot be resumed there.
It can also change the model and thinking level of the open session. That change applies to that
session only; the Profile default in `settings.json` is unchanged. Resume and model changes are
refused while a turn is streaming, and other open clients reload after either one.

Run `ziggy help sessions` for the version-matched command syntax and JSON options.
