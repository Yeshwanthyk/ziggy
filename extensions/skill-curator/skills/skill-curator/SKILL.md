---
name: skill-curator
description: Inspect, review, create, and explicitly replace Profile-local Agent Skills using native tools and persisted session evidence when useful.
---

# Skill Curator

Use this workflow when the user asks to inspect, create, or improve a skill owned by the current
Profile.

1. Call `skill_curator_list` to see valid Profile skills under `<cwd>/skills`.
2. For an existing target, call `skill_curator_read` before proposing changes. To ground a new or
   revised workflow in prior experience, optionally use `lcm_sessions`, `lcm_grep`, and
   `lcm_expand_query` for persisted evidence.
3. Draft the complete replacement `SKILL.md`. Its Agent Skill frontmatter `name` must exactly match
   the kebab-case directory name and its `description` must say what the skill does and when it
   applies. Keep instructions concrete, concise, and based on confirmed tools and behavior.
4. Show the user the intended creation or replacement and resolve material review feedback. Write
   only when the user directly requested the change or explicitly approves it.
5. Call `skill_curator_write` with the complete body. Omit `replace` for a new skill. For an
   existing skill, pass `replace: true` explicitly. Read it back when exact verification matters.

These tools target only the current Profile's `<cwd>/skills/<name>/SKILL.md`. They do not manage
repository package skills or top-level skill catalogs. Do not create aliases, registries,
suggestion stores, backups, scheduled work, or auxiliary runtime paths.
