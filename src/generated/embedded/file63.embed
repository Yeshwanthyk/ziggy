#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.error
import urllib.request


ENDPOINT = "https://api.linear.app/graphql"


def fail(message, **details):
    payload = {"ok": False, "error": message}
    payload.update(details)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 1


def request(query, variables=None):
    api_key = os.environ.get("LINEAR_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("LINEAR_API_KEY is required")
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Authorization": api_key,
            "Content-Type": "application/json",
            "User-Agent": "pi-linear-extension",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        raise RuntimeError(f"Linear API HTTP {err.code}: {detail}") from err
    if data.get("errors"):
        raise RuntimeError(json.dumps(data["errors"], indent=2))
    return data.get("data")


def connection_nodes(data, *path):
    current = data
    for key in path:
        current = current[key]
    return current.get("nodes", [])


def resolve_team_id(team):
    teams = connection_nodes(request("query { teams { nodes { id key name } } }"), "teams")
    for item in teams:
        if team in (item["id"], item["key"]) or team.lower() == item["name"].lower():
            return item["id"]
    raise RuntimeError(f"team not found: {team}")


def cmd_whoami(_):
    return request("query { viewer { id name email } }")


def cmd_list_teams(_):
    return request("query { teams { nodes { id key name } } }")


def cmd_list_projects(args):
    return request(
        "query($first:Int!) { projects(first:$first) { nodes { id name state url } } }",
        {"first": args.limit},
    )


def cmd_list_states(args):
    team_id = resolve_team_id(args.team)
    return request(
        """
        query($team:String!) {
          team(id:$team) { id key name states { nodes { id name type position } } }
        }
        """,
        {"team": team_id},
    )


def cmd_list_issues(args):
    if args.team:
        return request(
            """
            query($first:Int!, $team:String!) {
              issues(first:$first, filter:{ team: { key: { eq: $team } } }) {
                nodes { id identifier title url state { name } assignee { name email } updatedAt }
              }
            }
            """,
            {"first": args.limit, "team": args.team},
        )
    return request(
        """
        query($first:Int!) {
          issues(first:$first) {
            nodes { id identifier title url state { name } assignee { name email } updatedAt }
          }
        }
        """,
        {"first": args.limit},
    )


def cmd_get_issue(args):
    return request(
        """
        query($id:String!) {
          issue(id:$id) {
            id identifier title description url
            state { id name type }
            team { id key name }
            assignee { id name email }
            project { id name }
          }
        }
        """,
        {"id": args.issue},
    )


def cmd_search_issues(args):
    return request(
        """
        query($term:String!, $first:Int!) {
          issueSearch(term:$term, first:$first) {
            nodes { id identifier title url state { name } updatedAt }
          }
        }
        """,
        {"term": args.query, "first": args.limit},
    )


def cmd_create_issue(args):
    team_id = resolve_team_id(args.team)
    return request(
        """
        mutation($input:IssueCreateInput!) {
          issueCreate(input:$input) {
            success
            issue { id identifier title url }
          }
        }
        """,
        {"input": {"teamId": team_id, "title": args.title, "description": args.description or ""}},
    )


def cmd_update_status(args):
    state_data = request(
        """
        query($id:String!) {
          issue(id:$id) { team { states { nodes { id name } } } }
        }
        """,
        {"id": args.issue},
    )
    states = connection_nodes(state_data, "issue", "team", "states")
    state_id = next(
        (
            state["id"]
            for state in states
            if state["id"] == args.state or state["name"].lower() == args.state.lower()
        ),
        None,
    )
    if not state_id:
        raise RuntimeError(f"state not found: {args.state}")
    return request(
        """
        mutation($id:String!, $input:IssueUpdateInput!) {
          issueUpdate(id:$id, input:$input) {
            success
            issue { id identifier title url state { name } }
          }
        }
        """,
        {"id": args.issue, "input": {"stateId": state_id}},
    )


def cmd_add_comment(args):
    return request(
        """
        mutation($input:CommentCreateInput!) {
          commentCreate(input:$input) {
            success
            comment { id url body createdAt }
          }
        }
        """,
        {"input": {"issueId": args.issue, "body": args.body}},
    )


def cmd_raw(args):
    payload = json.loads(args.payload)
    return request(payload["query"], payload.get("variables"))


def parser():
    root = argparse.ArgumentParser(prog="linear_api.py")
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("whoami").set_defaults(func=cmd_whoami)
    sub.add_parser("list-teams").set_defaults(func=cmd_list_teams)
    projects = sub.add_parser("list-projects")
    projects.add_argument("--limit", type=int, default=50)
    projects.set_defaults(func=cmd_list_projects)
    states = sub.add_parser("list-states")
    states.add_argument("team")
    states.set_defaults(func=cmd_list_states)
    issues = sub.add_parser("list-issues")
    issues.add_argument("--team")
    issues.add_argument("--limit", type=int, default=20)
    issues.set_defaults(func=cmd_list_issues)
    get_issue = sub.add_parser("get-issue")
    get_issue.add_argument("issue")
    get_issue.set_defaults(func=cmd_get_issue)
    search = sub.add_parser("search-issues")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=20)
    search.set_defaults(func=cmd_search_issues)
    create = sub.add_parser("create-issue")
    create.add_argument("--team", required=True)
    create.add_argument("--title", required=True)
    create.add_argument("--description")
    create.set_defaults(func=cmd_create_issue)
    status = sub.add_parser("update-status")
    status.add_argument("issue")
    status.add_argument("--state", required=True)
    status.set_defaults(func=cmd_update_status)
    comment = sub.add_parser("add-comment")
    comment.add_argument("issue")
    comment.add_argument("--body", required=True)
    comment.set_defaults(func=cmd_add_comment)
    raw = sub.add_parser("raw")
    raw.add_argument("payload")
    raw.set_defaults(func=cmd_raw)
    return root


def main():
    args = parser().parse_args()
    try:
        print(json.dumps(args.func(args), indent=2, sort_keys=True))
        return 0
    except Exception as err:
        return fail(str(err))


if __name__ == "__main__":
    sys.exit(main())
