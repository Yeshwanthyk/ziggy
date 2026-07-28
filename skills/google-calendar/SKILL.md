---
name: google-calendar
description: List, create, and delete Google Calendar events through a local Google Workspace helper.
---

# Google Calendar

The helper is at `../google-workspace/scripts/google_api.py`, relative to this `SKILL.md`. It
requires `google-api-python-client` and `google-auth`, plus `GOOGLE_TOKEN_JSON` pointing to an
authorized-user token file.

```bash
python3 ../google-workspace/scripts/google_api.py calendar list \
  --calendar primary --max 10
python3 ../google-workspace/scripts/google_api.py calendar create \
  --calendar primary --summary <title> --start <iso> --end <iso> --timezone <iana-timezone>
python3 ../google-workspace/scripts/google_api.py calendar delete \
  --calendar primary --event-id <event-id>
```

State the calendar, title, exact time range, and timezone before creating or deleting an event.
Return event IDs and links when available.
