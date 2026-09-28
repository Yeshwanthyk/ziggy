---
name: apple-notes
description: "Create, view, edit, delete, search, move, or export Apple Notes via the memo CLI on macOS."
---

# Apple Notes CLI

Use `memo notes` to manage Apple Notes directly from the terminal. Create, view, edit, delete, search, move notes between folders, and export to HTML/Markdown.

Setup

- Install (Homebrew): `brew tap antoniorodr/memo && brew install antoniorodr/memo/memo`
- Manual (pip): `pip install .` (after cloning the repo)
- macOS-only; if prompted, grant Automation access to Notes.app.

View Notes

- List all notes: `memo notes`
- Filter by folder: `memo notes -f "Folder Name"`
- Search notes (fuzzy): `memo notes -s "query"`

Create Notes

- Add a new note: `memo notes -a`
  - Opens an interactive editor; run this in a user-owned terminal, not the resident.
- Quick add with title: `memo notes -a "Note Title"`

Edit Notes

- Edit existing note: `memo notes -e`
  - Interactive selection; ask the user to run this in their terminal if needed.

Delete Notes

- Delete a note: `memo notes -d`
  - Interactive selection; ask the user to run this in their terminal if needed.

Move Notes

- Move note to folder: `memo notes -m`
  - Interactive selection; ask the user to run this in their terminal if needed.

Export Notes

- Export to HTML/Markdown: `memo notes -ex`
  - Exports selected note; uses Mistune for markdown processing.

Limitations

- Cannot edit notes containing images or attachments.
- Use noninteractive `memo notes` forms from a Ziggy run where possible. For editor and selection
  prompts, hand off to a user-owned terminal; the resident web UI cannot answer CLI prompts.

Notes

- macOS-only.
- Requires Apple Notes.app to be accessible.
- For automation, grant permissions in System Settings > Privacy & Security > Automation.
