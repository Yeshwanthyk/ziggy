---
name: google-mail
description: Search, read, and send Gmail messages through a local Google Workspace helper.
---

# Google Mail

The helper is at `../google-workspace/scripts/google_api.py`, relative to this `SKILL.md`. It
requires `google-api-python-client` and `google-auth`, plus `GOOGLE_TOKEN_JSON` pointing to an
authorized-user token file.

```bash
python3 ../google-workspace/scripts/google_api.py mail search \
  'from:someone@example.com newer_than:7d' --max 10
python3 ../google-workspace/scripts/google_api.py mail get <message-id>
python3 ../google-workspace/scripts/google_api.py mail send \
  --to <email> --subject <subject> --body <text>
```

State the recipient, subject, and reason before sending mail. Prefer read operations while
orienting, and return message or thread IDs with useful results.
