---
name: pi-packages
description: Understand and work with Ziggy's repository-owned Pi extension packages and Profile skills.
---

# Pi packages in Ziggy

Repository capabilities live under `extensions/<id>/`. Each folder is a Pi package containing an
Agent Skill, executable Pi extension code, or both. Ziggy loads these packages for every Profile;
restart a resident Ziggy process after changing executable extension code.

Profile-local skills live under `<profile>/skills/` and take precedence over package and top-level
skills with the same declared name.

Use Ziggy's existing skill commands:

```bash
ziggy skills list <profile>
ziggy skills add <profile> <skill-id>
ziggy skills add <profile> <skill-id> --force
```

`skills add` copies the complete skill folder into the Profile. It does not install executable
code or mutate a tool registry. To create or change an executable package, read the
`extension-authoring` skill and edit `extensions/<id>/` in the Ziggy repository.
