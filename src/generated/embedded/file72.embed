---
name: open-computer-use
description: Automate local desktop apps through screenshots, accessibility snapshots, clicks, typing, scrolling, dragging, and key presses.
---

# Open Computer Use

Use `open_computer_use` for direct control of a local desktop app or screen.
Base64 screenshots are removed from tool output and saved under
`.runtime/open-computer-use/screenshots` in the current Profile.

Check setup and permissions:

```json
{"action":"doctor"}
```

On macOS, stop and ask the user to grant Accessibility or Screen Recording
permission when required.

Discover apps and snapshot before element-index actions:

```json
{"action":"list_apps"}
{"action":"get_app_state","app":"TextEdit"}
```

Element indexes are valid only for the latest snapshot. Snapshot again after
navigation, layout changes, modal changes, reloads, or failed actions.

Common actions:

```json
{"action":"click","app":"TextEdit","element_index":1}
{"action":"type_text","app":"TextEdit","text":"Hello"}
{"action":"press_key","app":"TextEdit","key":"Return"}
{"action":"set_value","app":"TextEdit","element_index":1,"value":"Draft"}
{"action":"scroll","app":"TextEdit","element_index":4,"direction":"down","pages":1}
```

Use coordinates only when the accessibility tree does not expose the target:

```json
{"action":"click","app":"TextEdit","x":120,"y":240}
{"action":"drag","app":"TextEdit","from_x":120,"from_y":240,"to_x":420,"to_y":240}
```

On platforms where snapshot state is process-local, batch dependent calls:

```json
{"action":"calls","calls":[{"tool":"get_app_state","args":{"app":"TextEdit"}},{"tool":"click","args":{"app":"TextEdit","element_index":"1"}}]}
```

The target is the user's real desktop. Stop at credentials, 2FA, captchas,
protected permission prompts, destructive actions, external submissions,
purchases, deletes, approvals, uploads, or ambiguous targets.
