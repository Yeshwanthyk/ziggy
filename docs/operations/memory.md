# Operate Profile memory

Profile memory is plain Markdown owned by the Profile. It is separate from Pi session
transcripts and is admitted by chat context:

- `MEMORY.md` is shared assistant memory and loads in local, 1:1, and group chats.
- `memory/users/<id>.md` is person memory and loads only in that person's 1:1 chat. Local chats
  use `memory/users/owner.md`. Person memory never loads in a group.
- `memory/groups/<id>.md` is group memory and loads only in that group chat.

Each document contains one entry per block. Separate entries with a line containing `§`:

```text
The person prefers short answers.
§
The project ships on Fridays.
```

The shared document is capped at 2,200 Unicode code points. Each person or group document is
capped at 1,375 code points. A write that would exceed its cap is rejected as a whole; content is
never silently truncated.

The agent uses the `memory_write` tool with `add`, `replace`, and `remove` operations. `add` is
idempotent. `replace` and `remove` require `oldText` to identify exactly one entry. A successful
change is atomic under a per-document lock.

You can inspect memory without opening a chat:

```sh
ziggy memory list <profile>
ziggy memory show <profile> shared
ziggy memory show <profile> user:<id>
ziggy memory show <profile> group:<id>
```

`memory list` reports only physical regular memory documents. Empty documents are reported as
empty and are distinct from a missing document. The `memory/README.md` format note is never
loaded as memory and is excluded from `ziggy doctor` size checks.

Hand-editing is safe when no Ziggy process is writing the same document, you preserve the `§`
delimiter, and you stay within the cap. Run `ziggy doctor <profile>` after edits.

Before an existing document is changed, Ziggy saves its exact prior bytes under:

```text
<profile>/.runtime/memory-backups/<relative-path-with-__>/<ISO-timestamp>.md
```

The newest ten backups for each document are retained. Backup and pruning failures block the
memory write. To restore one manually, copy a backup over the document and run `ziggy doctor`:

```sh
cp <profile>/.runtime/memory-backups/MEMORY.md/<timestamp>.md <profile>/MEMORY.md
ziggy doctor <profile>
```
