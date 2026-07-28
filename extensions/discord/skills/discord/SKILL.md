---
name: discord
description: "Operate Discord through an available Discord messaging integration: send, read, edit, delete, react, poll, pin, thread, search, and manage presence. Use when a user asks to act on Discord and a configured integration is available."
---

# Discord operations

Use the host's configured Discord integration. Inspect its tool schema before acting; do not
assume a particular tool name or that privileged actions are enabled.

## Safety and targeting

- Resolve explicit guild, channel, message, and user IDs before mutating state.
- Use the configured account selected by the user when multiple accounts are available.
- Treat sending, editing, deleting, moderating, changing roles, and changing presence as
  external mutations.
- Confirm ambiguous or broad destructive actions.
- Keep outbound messages short and avoid Markdown tables.
- Mention users as `<@USER_ID>`.

## Common payload shapes

Adapt these conceptual payloads to the available integration's schema.

Send a message:

```json
{
  "action": "send",
  "channel": "discord",
  "to": "channel:123",
  "message": "hello",
  "silent": true
}
```

Send media:

```json
{
  "action": "send",
  "channel": "discord",
  "to": "channel:123",
  "message": "see attachment",
  "media": "/absolute/path/example.png"
}
```

React:

```json
{
  "action": "react",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "emoji": "✅"
}
```

Read recent messages:

```json
{
  "action": "read",
  "channel": "discord",
  "to": "channel:123",
  "limit": 20
}
```

Edit or delete:

```json
{
  "action": "edit",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "message": "fixed typo"
}
```

```json
{
  "action": "delete",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456"
}
```

Create a poll:

```json
{
  "action": "poll",
  "channel": "discord",
  "to": "channel:123",
  "pollQuestion": "Lunch?",
  "pollOption": ["Pizza", "Sushi", "Salad"],
  "pollMulti": false,
  "pollDurationHours": 24
}
```

Pin a message:

```json
{
  "action": "pin",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456"
}
```

Create a thread:

```json
{
  "action": "thread-create",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "threadName": "bug triage"
}
```

Search:

```json
{
  "action": "search",
  "channel": "discord",
  "guildId": "999",
  "query": "release notes",
  "channelIds": ["123", "456"],
  "limit": 10
}
```

Set presence only when enabled and explicitly requested:

```json
{
  "action": "set-presence",
  "channel": "discord",
  "activityType": "playing",
  "activityName": "with fire",
  "status": "online"
}
```

Prefer the integration's current rich-component format when supported. Do not combine mutually
exclusive component and embed formats.
