#!/usr/bin/env bash
set -euo pipefail

skills_dir="./skills"
skill_name=""
dry_run=false

usage() {
  cat <<'EOF'
Usage: extract-skill.sh <skill-name> [--dry-run] [--output-dir <relative-path>]

Create a skill scaffold beneath the current Profile directory.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=true
      shift
      ;;
    --output-dir)
      [[ -n "${2:-}" && "${2:-}" != -* ]] || fail "--output-dir requires a relative path"
      skills_dir="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      [[ -z "$skill_name" ]] || fail "unexpected argument: $1"
      skill_name="$1"
      shift
      ;;
  esac
done

[[ -n "$skill_name" ]] || fail "skill name is required"
[[ "$skill_name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
  fail "skill name must contain lowercase letters, numbers, and single hyphens"
[[ "$skills_dir" != /* ]] || fail "output directory must be relative to the Profile"
[[ ! "$skills_dir" =~ (^|/)\.\.(/|$) ]] || fail "output directory cannot contain '..'"

skills_dir="${skills_dir#./}"
skill_path="./${skills_dir}/${skill_name}"
skill_file="${skill_path}/SKILL.md"
title="$(printf '%s' "$skill_name" | tr '-' ' ' | awk '{
  for (i = 1; i <= NF; i++) {
    $i = toupper(substr($i, 1, 1)) tolower(substr($i, 2))
  }
  print
}')"

render_template() {
  cat <<EOF
---
name: ${skill_name}
description: "[TODO: Describe what this skill does and when to use it]"
---

# ${title}

[TODO: Explain the skill's purpose.]

## Quick Reference

| Situation | Action |
| --- | --- |
| [Trigger] | [Action] |

## Usage

[TODO: Add actionable instructions.]

## Source Learning

- Learning ID: [TODO]
- Original file: .learnings/LEARNINGS.md
EOF
}

if [[ "$dry_run" == true ]]; then
  printf 'Dry run: would create %s\n\n' "$skill_file"
  render_template
  exit 0
fi

[[ ! -e "$skill_path" ]] || fail "skill already exists: $skill_path"
mkdir -p "$skill_path"
render_template >"$skill_file"
printf 'Created %s\n' "$skill_file"
