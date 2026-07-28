#!/usr/bin/env python3
"""Read-only GitHub pull request triage helper."""

import json
import shutil
import subprocess
import sys


def run_gh(*args):
    command = [shutil.which("gh") or "gh"] + list(args)
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(f"gh error: {result.stderr.strip()}\n")
        sys.exit(result.returncode)
    output = result.stdout.strip()
    if not output:
        return []
    return json.loads(output)


def review_requested():
    data = run_gh(
        "search",
        "prs",
        "--review-requested=@me",
        "--state=open",
        "--json",
        "repository,number,title,url,author,updatedAt",
    )
    print(json.dumps(data, indent=2))


def mine():
    data = run_gh(
        "search",
        "prs",
        "--author=@me",
        "--state=open",
        "--json",
        "repository,number,title,url,author,updatedAt",
    )
    enriched = []
    for pull_request in data:
        repo = pull_request["repository"]["nameWithOwner"]
        number = pull_request["number"]
        try:
            detail = run_gh(
                "pr",
                "view",
                str(number),
                "-R",
                repo,
                "--json",
                "number,title,url,state,reviewDecision,statusCheckRollup,isDraft",
            )
            enriched.append(detail)
        except SystemExit:
            enriched.append(pull_request)
    print(json.dumps(enriched, indent=2))


def view(repo, number):
    detail = run_gh(
        "pr",
        "view",
        str(number),
        "-R",
        repo,
        "--json",
        "number,title,author,body,state,isDraft,"
        "baseRefName,headRefName,"
        "additions,deletions,changedFiles,files,"
        "reviewDecision,latestReviews,statusCheckRollup,"
        "createdAt,updatedAt,url",
    )
    print(json.dumps(detail, indent=2))


def usage():
    print("usage: gh-prs review-requested | mine | view <owner/repo> <number>", file=sys.stderr)
    sys.exit(1)


def main():
    args = sys.argv[1:]
    if not args:
        usage()
    command = args[0]
    if command == "review-requested":
        review_requested()
    elif command == "mine":
        mine()
    elif command == "view":
        if len(args) < 3:
            usage()
        view(args[1], args[2])
    else:
        usage()


if __name__ == "__main__":
    main()
