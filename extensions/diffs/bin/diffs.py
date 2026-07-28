#!/usr/bin/env python3
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional, Union
from urllib.parse import urlparse


PR_REF_RE = re.compile(r"^([^/\s]+/[^#\s]+)#(\d+)$")
GITHUB_PR_RE = re.compile(r"^/([^/\s]+)/([^/\s]+)/pull/(\d+)/?$")


def fail(code: str, message: str, **extra: object) -> int:
    print(
        json.dumps({"error": {"code": code, "message": message, **extra}}, sort_keys=True),
        file=sys.stderr,
    )
    return 1


def file_stats(patch: str) -> list[dict]:
    files: list[dict] = []
    current: Optional[dict] = None
    pending_old = ""

    def ensure(path: str = "diff") -> dict:
        nonlocal current
        if current is None:
            current = {"path": path or "diff", "additions": 0, "deletions": 0, "hunks": 0}
        return current

    def finish() -> None:
        nonlocal current
        if current is not None:
            files.append(current)
            current = None

    for line in patch.splitlines():
        if line.startswith("diff --git "):
            finish()
            parts = line.split()
            path = parts[3].removeprefix("b/") if len(parts) >= 4 else "diff"
            current = {"path": path or "diff", "additions": 0, "deletions": 0, "hunks": 0}
            continue
        if line.startswith("--- "):
            pending_old = clean_diff_path(line[4:])
            ensure(pending_old)
            continue
        if line.startswith("+++ "):
            path = clean_diff_path(line[4:])
            if path == "/dev/null":
                path = pending_old
            ensure(path)["path"] = path or pending_old or "diff"
            continue
        if line.startswith("@@"):
            ensure()["hunks"] += 1
        elif line.startswith("+") and not line.startswith("+++"):
            ensure()["additions"] += 1
        elif line.startswith("-") and not line.startswith("---"):
            ensure()["deletions"] += 1

    finish()
    if not files and patch.strip():
        files.append({"path": "diff", "additions": 0, "deletions": 0, "hunks": 0})
    return files


def patch_stats(patch: str) -> dict:
    files = file_stats(patch)
    return {
        "files": len(files),
        "hunks": sum(item["hunks"] for item in files),
        "additions": sum(item["additions"] for item in files),
        "deletions": sum(item["deletions"] for item in files),
    }


def clean_diff_path(path: str) -> str:
    path = path.strip().split("\t", 1)[0]
    if path.startswith("a/") or path.startswith("b/"):
        return path[2:]
    return path


def parse_pr_ref(ref: str, url: str) -> Optional[tuple[str, str]]:
    match = PR_REF_RE.match(ref.strip())
    if match:
        return match.group(1), match.group(2)
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.netloc not in {"github.com", "www.github.com"}:
        return None
    match = GITHUB_PR_RE.match(parsed.path)
    if not match:
        return None
    return f"{match.group(1)}/{match.group(2)}", match.group(3)


def fetch_pr_diff(ref: str, url: str) -> Union[str, int]:
    parsed = parse_pr_ref(ref, url)
    if parsed is None:
        return fail(
            "pr_ref_invalid",
            "source.ref must be owner/repo#number or source.url must be a GitHub PR URL",
        )
    repo, number = parsed
    if shutil.which("gh") is None:
        return fail("gh_missing", "gh is required to fetch GitHub PR diffs")
    process = subprocess.run(
        ["gh", "pr", "diff", number, "--repo", repo],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if process.returncode != 0:
        return fail(
            "gh_pr_diff_failed",
            "gh pr diff failed",
            exitCode=process.returncode,
            stderr=process.stderr.strip(),
        )
    return process.stdout


def make_patch(payload: dict) -> tuple[str, str]:
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    patch = payload.get("patch") or ""
    if not patch and source.get("kind") == "pr":
        result = fetch_pr_diff(str(source.get("ref") or ""), str(source.get("url") or ""))
        if isinstance(result, int):
            raise SystemExit(result)
        patch = result
    path = payload.get("path") or payload.get("title") or "diff.txt"
    if not patch:
        before = (payload.get("before") or "").splitlines()
        after = (payload.get("after") or "").splitlines()
        patch = "\n".join(
            difflib.unified_diff(
                before,
                after,
                fromfile=f"a/{path}",
                tofile=f"b/{path}",
                lineterm="",
            )
        )
    if not patch.endswith("\n"):
        patch += "\n"
    return patch, str(path)


def main() -> int:
    try:
        payload = json.load(open(0))
    except json.JSONDecodeError as error:
        return fail("json_invalid", "stdin must be JSON", cause=str(error))
    mode = payload.get("mode") or "both"
    if mode not in {"text", "file", "both"}:
        return fail("mode_invalid", "mode must be text, file, or both")
    patch, path = make_patch(payload)
    digest = hashlib.sha256(patch.encode()).hexdigest()[:16]
    profile = Path(os.environ.get("ZIGGY_PROFILE_PATH") or os.getcwd())
    artifact_root = profile / ".runtime" / "diffs" / "artifacts"
    artifact_root.mkdir(parents=True, exist_ok=True)
    raw_artifact = artifact_root / f"{digest}.diff"
    raw_artifact.write_text(patch)
    details = {
        "id": digest,
        "bytes": len(patch.encode()),
        "path": path,
        "rawPath": str(raw_artifact),
        "filePath": str(raw_artifact),
        "artifactDir": str(artifact_root),
        "stats": patch_stats(patch),
        "files": file_stats(patch),
    }
    if mode == "file":
        print(json.dumps(details, sort_keys=True))
    elif mode == "text":
        print(patch, end="")
    else:
        print(patch, end="")
        print(json.dumps(details, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
