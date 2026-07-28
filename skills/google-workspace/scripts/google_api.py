#!/usr/bin/env python3
import argparse
import base64
import json
import os
import pathlib
import sys
from email.message import EmailMessage


SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
]


def fail(message, **details):
    payload = {"ok": False, "error": message}
    payload.update(details)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 1


def credential_paths():
    token = os.environ.get("GOOGLE_TOKEN_JSON")
    secret = os.environ.get("GOOGLE_CLIENT_SECRET_JSON")
    candidates = []
    if token:
        candidates.append((pathlib.Path(token), pathlib.Path(secret) if secret else None))
    return candidates


def service(name, version):
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
    except ImportError as err:
        raise RuntimeError("install google-api-python-client and google-auth to use this skill") from err

    selected = None
    for token_path, secret_path in credential_paths():
        if token_path and token_path.exists():
            selected = (token_path, secret_path)
            break
    if not selected:
        raise RuntimeError("Google token not found; set GOOGLE_TOKEN_JSON")

    token_path, _ = selected
    creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token_path.write_text(creds.to_json())
    if not creds.valid:
        raise RuntimeError("Google credentials are invalid or expired")
    return build(name, version, credentials=creds, cache_discovery=False)


def gmail():
    return service("gmail", "v1")


def calendar():
    return service("calendar", "v3")


def msg_value(headers, name):
    for header in headers:
        if header.get("name", "").lower() == name.lower():
            return header.get("value", "")
    return ""


def cmd_mail_search(args):
    data = gmail().users().messages().list(userId="me", q=args.query, maxResults=args.max).execute()
    messages = data.get("messages", [])
    out = []
    for item in messages:
        msg = gmail().users().messages().get(userId="me", id=item["id"], format="metadata").execute()
        headers = msg.get("payload", {}).get("headers", [])
        out.append(
            {
                "id": msg.get("id"),
                "threadId": msg.get("threadId"),
                "from": msg_value(headers, "From"),
                "subject": msg_value(headers, "Subject"),
                "date": msg_value(headers, "Date"),
                "snippet": msg.get("snippet", ""),
            }
        )
    return {"messages": out}


def cmd_mail_get(args):
    return gmail().users().messages().get(userId="me", id=args.message_id, format="full").execute()


def cmd_mail_send(args):
    msg = EmailMessage()
    msg["To"] = args.to
    if args.cc:
        msg["Cc"] = args.cc
    msg["Subject"] = args.subject
    msg.set_content(args.body)
    encoded = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return gmail().users().messages().send(userId="me", body={"raw": encoded}).execute()


def cmd_calendar_list(args):
    request = {
        "calendarId": args.calendar,
        "maxResults": args.max,
        "singleEvents": True,
        "orderBy": "startTime",
    }
    if args.time_min:
        request["timeMin"] = args.time_min
    if args.time_max:
        request["timeMax"] = args.time_max
    return calendar().events().list(**request).execute()


def cmd_calendar_create(args):
    event = {
        "summary": args.summary,
        "description": args.description or "",
        "start": {"dateTime": args.start, "timeZone": args.timezone},
        "end": {"dateTime": args.end, "timeZone": args.timezone},
    }
    if args.attendee:
        event["attendees"] = [{"email": email} for email in args.attendee]
    return calendar().events().insert(calendarId=args.calendar, body=event).execute()


def cmd_calendar_delete(args):
    calendar().events().delete(calendarId=args.calendar, eventId=args.event_id).execute()
    return {"deleted": True, "calendar": args.calendar, "eventId": args.event_id}


def parser():
    p = argparse.ArgumentParser(prog="google_api.py")
    p.add_argument("service", choices=["mail", "calendar"])
    sub = p.add_subparsers(dest="command", required=True)

    mail_search = sub.add_parser("search")
    mail_search.add_argument("query")
    mail_search.add_argument("--max", type=int, default=10)
    mail_search.set_defaults(func=cmd_mail_search)
    mail_get = sub.add_parser("get")
    mail_get.add_argument("message_id")
    mail_get.set_defaults(func=cmd_mail_get)
    mail_send = sub.add_parser("send")
    mail_send.add_argument("--to", required=True)
    mail_send.add_argument("--cc")
    mail_send.add_argument("--subject", required=True)
    mail_send.add_argument("--body", required=True)
    mail_send.set_defaults(func=cmd_mail_send)

    cal_list = sub.add_parser("list")
    cal_list.add_argument("--calendar", default="primary")
    cal_list.add_argument("--max", type=int, default=10)
    cal_list.add_argument("--time-min")
    cal_list.add_argument("--time-max")
    cal_list.set_defaults(func=cmd_calendar_list)
    cal_create = sub.add_parser("create")
    cal_create.add_argument("--calendar", default="primary")
    cal_create.add_argument("--summary", required=True)
    cal_create.add_argument("--description")
    cal_create.add_argument("--start", required=True)
    cal_create.add_argument("--end", required=True)
    cal_create.add_argument("--timezone", default="America/Toronto")
    cal_create.add_argument("--attendee", action="append")
    cal_create.set_defaults(func=cmd_calendar_create)
    cal_delete = sub.add_parser("delete")
    cal_delete.add_argument("--calendar", default="primary")
    cal_delete.add_argument("--event-id", required=True)
    cal_delete.set_defaults(func=cmd_calendar_delete)
    return p


def main():
    args = parser().parse_args()
    try:
        print(json.dumps(args.func(args), indent=2, sort_keys=True))
        return 0
    except Exception as err:
        return fail(str(err))


if __name__ == "__main__":
    sys.exit(main())
