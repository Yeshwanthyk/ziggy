---
name: agent-browser
description: Use profile-persistent agent-browser automation for authenticated browsing, screenshots, scraping, forms, and reusable browser sessions.
---

# Agent Browser

Use `agent_browser` when a task needs a real browser, authenticated web state,
screenshots, DOM snapshots, form interaction, or a session that must reuse a
browser login.

The tool always uses the current Profile:

- Browser profile: `.runtime/agent-browser/browser-profile`
- Screenshots: `.runtime/agent-browser/screenshots`
- Session: the provided `session`, otherwise `desktop-main`
- Output: upstream `--json` mode

Browser state persists between Pi modes and sessions using the same Profile.

## Workflow

For complex work, first load the installed CLI guidance:

```json
{"action":"skills","name":"core"}
```

Open a page and inspect it:

```json
{"action":"status"}
{"action":"open","url":"https://example.com","headed":true}
{"action":"snapshot","interactive":true}
```

Use snapshot refs for interaction:

```json
{"action":"click","ref":"e12"}
{"action":"fill","ref":"e18","text":"search text"}
{"action":"press","key":"Enter"}
```

Read or capture evidence:

```json
{"action":"read"}
{"action":"get","what":"url"}
{"action":"get","what":"text","ref":"e4"}
{"action":"screenshot","full":true}
```

Use `raw` for upstream commands not represented by a structured action:

```json
{"action":"raw","args":["cookies"]}
{"action":"raw","args":["wait","for","text","Dashboard"]}
```

If login, 2FA, SSO, captcha, consent, or an automation block appears, stop and
report the exact page state. Never ask for credentials unless the user explicitly
provides them in the current conversation.

Browser actions can mutate external services. Do not submit, send, purchase,
delete, publish, or change account settings unless the user explicitly requested
that action.
