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

Run `ziggy help sessions` for the version-matched command syntax and JSON options.
