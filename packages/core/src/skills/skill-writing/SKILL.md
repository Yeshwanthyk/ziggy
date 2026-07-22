---
name: skill-writing
description: Author and review conformant Ziggy Skills and Extension Skill packages. Use when creating a SKILL.md, adding a Skill to extension.json, or checking Skill identity, links, support files, and execution boundaries.
---

# Skill writing

Create one focused Skill for one repeatable capability. A Skill is instruction content, not an
execution or state authority.

## Authoring flow

1. Confirm the capability, its activation phrases, and the owner-approved files you may edit.
2. Choose a lowercase kebab-case Skill id. The directory basename, manifest `skills[].id`,
   manifest path `skills/<id>`, and frontmatter `name` must all equal that id.
3. Write `SKILL.md` with `name` and a specific `description` that says what the Skill does and
   when to use it.
4. Put optional material only in `references/`, `scripts/`, or `assets/`. Link every retained
   support file from reachable Markdown using a confined relative link.
5. Validate the whole Extension package before asking the owner to install it.

## Minimal Skill

```markdown
---
name: release-notes
description: Draft concise release notes from an owner-selected change list. Use when the user asks for release notes, a changelog entry, or a shipped-change summary.
---

# Release notes

1. Read only the change list the owner selected.
2. Group user-visible changes by outcome.
3. Flag breaking changes explicitly.
```

The matching manifest entry is:

```json
{ "id": "release-notes", "path": "skills/release-notes" }
```

## Boundaries

- Don't add a Tool, setup command, network access, secret, or filesystem permission merely because
  prose could ask for it. Declare the smallest real capability separately in `extension.json`.
- Files in `scripts/` are inert by existence. They execute only through an approved Ziggy Tool or
  supervised setup/doctor boundary.
- Don't write Extension state or duplicate Profile, Session, or Memory authority.
- Don't use absolute, parent-relative, backslash, URL-query, fragment, symlink, or hardlink paths
  for local Skill support material.
- Don't retain copied references, examples, or assets that the Skill doesn't reach and use.

## Review checklist

- `SKILL.md` starts with valid frontmatter and has a non-empty body.
- The id matches the directory, manifest entry, and frontmatter exactly.
- The description names concrete triggers and stays focused on one capability.
- Every local link is confined, every target exists, and no support file is orphaned.
- The manifest declares canonical sorted requirements and only the authority the capability needs.
- Reinstall and reapproval are expected after any sealed package or approval-bound change.
