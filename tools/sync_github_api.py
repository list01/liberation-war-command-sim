#!/usr/bin/env python3
"""
《解放战争》GitHub 同步（REST API 模式，不走 git push）

认证：只从环境变量 GITHUB_TOKEN 读取独立生成的 PAT；不读取聊天记录、
jsonl 日志、.env 或任何本地配置里的现成令牌；不写入凭证到文件。

流程：GET repo -> POST /git/blobs -> POST /git/trees(base_tree 增量)
      -> POST /git/commits -> PATCH/POST refs
注意：API 生成的 commit SHA 与本地 git 提交必然不同，以远端为权威。

用法：
  bash:     GITHUB_TOKEN=xxx python tools/sync_github_api.py
  PowerShell: $env:GITHUB_TOKEN="xxx"; python tools/sync_github_api.py
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

OWNER = os.environ.get("GITHUB_OWNER", "list01")
REPO = os.environ.get("GITHUB_REPO", "liberation-war-command-sim")
BRANCH = os.environ.get("GITHUB_BRANCH", "main")
TOKEN = os.environ.get("GITHUB_TOKEN")
ROOT = Path(__file__).resolve().parent.parent

# 项目边界：不把本机元数据、生成物、缓存、未完成的部署暂存带上远端
EXCLUDE_DIRS = {".git", ".workbuddy", "deploy", "node_modules", "__pycache__",
                ".pytest_cache", ".ruff_cache", ".playwright", ".venv", "venv"}
EXCLUDE_PREFIX = (".env",)
EXCLUDE_SUFFIX = (".pem", ".key", ".p12", ".pfx", ".tmp", ".log")
MAX_BYTES = 50 * 1024 * 1024


def api(method, path, body=None):
    url = "https://api.github.com" + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:600]
        raise RuntimeError(f"HTTP {exc.code} {method} {path}: {detail}") from exc


def is_404(err):
    return "HTTP 404" in str(err)


def is_empty_repo(err):
    """GitHub 空仓库读取 ref 返回 409 'Git Repository is empty'，按'无 ref'处理。"""
    return "HTTP 409" in str(err) and "empty" in str(err).lower()


def ensure_repo():
    try:
        info = api("GET", f"/repos/{OWNER}/{REPO}")
        print(f"仓库已存在: {info.get('html_url', OWNER + '/' + REPO)}")
    except RuntimeError as err:
        if not is_404(err):
            raise
        api("POST", "/user/repos", {
            "name": REPO,
            "description": "解放战争师级指挥模拟器 v1.4.1（真实电文与地理的网页兵棋）",
            "private": False,
            "auto_init": False,
        })
        print(f"已在账号根级创建英文仓库: {OWNER}/{REPO}")


def collect_files():
    out = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT).as_posix()
        parts = rel.split("/")
        if any(part in EXCLUDE_DIRS for part in parts[:-1]):
            continue
        name = parts[-1]
        if name.startswith(EXCLUDE_PREFIX) or name.endswith(EXCLUDE_SUFFIX):
            continue
        if rel.startswith("out/") and rel != "out/.gitkeep":
            continue
        size = path.stat().st_size
        if size > MAX_BYTES:
            print(f"  跳过超大文件 (>50MB): {rel}")
            continue
        out.append((rel, path))
    return sorted(out)


def encode_file(path):
    raw = path.read_bytes()
    # Windows core.autocrlf：工作区 CRLF、远端 LF。文本统一 \r\n -> \n，
    # 避免误报几十个"修改"；二进制（含中文编码的字节流）保持原样 base64。
    if b"\x00" not in raw:
        try:
            text = raw.decode("utf-8")
            raw = text.replace("\r\n", "\n").encode("utf-8")
        except UnicodeDecodeError:
            pass
    return base64.b64encode(raw).decode("ascii")


def main():
    if not TOKEN:
        sys.exit("GITHUB_TOKEN 未设置：请独立生成 PAT 并设置环境变量；不会从日志/配置中捞取令牌。")
    ensure_repo()

    files = collect_files()
    print(f"待同步 {len(files)} 个文件（仓库根目录为准，无子目录嵌套）")

    base_sha = None
    parent_sha = None
    try:
        ref = api("GET", f"/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}")
        base_sha = ref["object"]["sha"]
        parent_sha = base_sha
        print(f"基于现有 {BRANCH}: {base_sha[:8]}")
    except RuntimeError as err:
        if not (is_404(err) or is_empty_repo(err)):
            raise
        print(f"分支 {BRANCH} 不存在或仓库为空，将创建初始提交")

    tree_items = []
    for rel, path in files:
        blob = api("POST", f"/repos/{OWNER}/{REPO}/git/blobs", {
            "content": encode_file(path),
            "encoding": "base64",
        })
        tree_items.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print(f"  blob  {rel}")

    tree_body = {"tree": tree_items}
    if base_sha:
        tree_body["base_tree"] = base_sha   # 增量，不重建整棵树
    tree = api("POST", f"/repos/{OWNER}/{REPO}/git/trees", tree_body)

    commit_body = {
        "message": f"sync: {REPO} from local workspace (REST API, LF normalized)",
        "tree": tree["sha"],
    }
    if parent_sha:
        commit_body["parents"] = [parent_sha]
    commit = api("POST", f"/repos/{OWNER}/{REPO}/git/commits", commit_body)

    if parent_sha:
        api("PATCH", f"/repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}",
            {"sha": commit["sha"], "force": False})
    else:
        api("POST", f"/repos/{OWNER}/{REPO}/git/refs",
            {"ref": f"refs/heads/{BRANCH}", "sha": commit["sha"]})

    print(f"完成: https://github.com/{OWNER}/{REPO}@{BRANCH}  commit {commit['sha'][:8]}")
    print("说明：远端 commit 由 API 生成，与本地 git 提交不同；以远端为权威，勿再混用 git push。")


if __name__ == "__main__":
    main()
