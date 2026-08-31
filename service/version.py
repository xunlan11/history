from __future__ import annotations

import json
import os
import shutil
import subprocess
import tarfile
import threading
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

APP_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = Path(os.getenv("VERSION_REPO_DIR", APP_DIR)).resolve()
REMOTE_NAME = os.getenv("VERSION_REMOTE", "origin")
BRANCH_NAME = os.getenv("VERSION_BRANCH", "")
RELEASES_DIR = Path(os.getenv("VERSION_RELEASES_DIR", REPO_DIR / ".deploy" / "releases")).resolve()
CURRENT_LINK = Path(os.getenv("VERSION_CURRENT_LINK", REPO_DIR / ".deploy" / "current")).resolve()
BUILD_COMMAND = os.getenv("VERSION_BUILD_COMMAND", "").strip()
HEALTH_PATH = os.getenv("VERSION_HEALTH_PATH", "html/index.html").strip()

app = FastAPI(title="近代军史数智平台版本更新服务")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATE: dict[str, Any] = {
    "updating": False,
    "message": "",
    "lastUpdatedAt": "",
    "lastError": "",
}
STATE_LOCK = threading.Lock()


def run_git(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_DIR,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if check and result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "git 命令执行失败"
        raise RuntimeError(message)
    return result.stdout.strip()


def is_git_repo() -> bool:
    try:
        return run_git("rev-parse", "--is-inside-work-tree") == "true"
    except Exception:  # noqa: BLE001
        return False


def current_branch() -> str:
    if BRANCH_NAME:
        return BRANCH_NAME
    branch = run_git("branch", "--show-current", check=False)
    return branch or "main"


def remote_ref() -> str:
    return f"{REMOTE_NAME}/{current_branch()}"


def fetch_remote() -> None:
    run_git("fetch", REMOTE_NAME, current_branch())


def commit_for(ref: str) -> str:
    return run_git("rev-parse", ref)


def deployed_commit() -> str:
    version_file = CURRENT_LINK / "version.json"
    if version_file.exists():
        try:
            data = json.loads(version_file.read_text(encoding="utf-8"))
            commit = str(data.get("commit", "")).strip()
            if commit:
                return commit
        except Exception:  # noqa: BLE001
            pass
    return commit_for("HEAD")


def current_link_ready() -> bool:
    return CURRENT_LINK.exists() or CURRENT_LINK.is_symlink()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_extract_archive(archive: bytes, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=False)
    with tarfile.open(fileobj=BytesIO(archive), mode="r:") as tar:
        for member in tar.getmembers():
            member_path = (target_dir / member.name).resolve()
            if target_dir not in member_path.parents and member_path != target_dir:
                raise RuntimeError("发布包包含非法路径")
        tar.extractall(target_dir)


def export_release(commit: str) -> Path:
    short_commit = commit[:12]
    release_dir = RELEASES_DIR / short_commit
    if release_dir.exists():
        return release_dir

    temp_dir = RELEASES_DIR / f".tmp-{short_commit}"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)

    RELEASES_DIR.mkdir(parents=True, exist_ok=True)
    archive = subprocess.run(
        ["git", "archive", "--format=tar", commit],
        cwd=REPO_DIR,
        check=True,
        capture_output=True,
    ).stdout
    safe_extract_archive(archive, temp_dir)

    (temp_dir / "version.json").write_text(
        json.dumps(
            {
                "version": short_commit,
                "commit": commit,
                "builtAt": now_iso(),
                "branch": current_branch(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    temp_dir.replace(release_dir)
    return release_dir


def run_build(release_dir: Path) -> None:
    if not BUILD_COMMAND:
        return

    import shlex

    subprocess.run(
        shlex.split(BUILD_COMMAND, posix=os.name != "nt"),
        cwd=release_dir,
        check=True,
    )


def check_release(release_dir: Path) -> None:
    if not HEALTH_PATH:
        return
    check_path = (release_dir / HEALTH_PATH).resolve()
    if release_dir not in check_path.parents and check_path != release_dir:
        raise RuntimeError("健康检查路径不在发布目录内")
    if not check_path.exists():
        raise RuntimeError(f"发布检查失败：缺少 {HEALTH_PATH}")


def switch_current_link(release_dir: Path) -> None:
    CURRENT_LINK.parent.mkdir(parents=True, exist_ok=True)
    temp_link = CURRENT_LINK.parent / f".current-{release_dir.name}.tmp"
    if temp_link.exists() or temp_link.is_symlink():
        temp_link.unlink()

    os.symlink(release_dir, temp_link, target_is_directory=True)

    if CURRENT_LINK.exists() and not CURRENT_LINK.is_symlink():
        raise RuntimeError(f"{CURRENT_LINK} 已存在且不是软链接，不能安全切换")

    os.replace(temp_link, CURRENT_LINK)


def build_status(fetch: bool) -> dict[str, Any]:
    if not is_git_repo():
        return {
            "configured": False,
            "updating": STATE["updating"],
            "updateAvailable": False,
            "message": "当前目录不是 Git 仓库",
        }

    try:
        if fetch:
            fetch_remote()
        remote_commit = commit_for(remote_ref())
        current_commit = deployed_commit()
        update_available = remote_commit != current_commit or not current_link_ready()
        return {
            "configured": True,
            "updating": STATE["updating"],
            "updateAvailable": update_available,
            "currentCommit": current_commit,
            "remoteCommit": remote_commit,
            "branch": current_branch(),
            "message": STATE["message"],
            "lastUpdatedAt": STATE["lastUpdatedAt"],
            "lastError": STATE["lastError"],
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "configured": False,
            "updating": STATE["updating"],
            "updateAvailable": False,
            "message": str(exc),
            "lastError": str(exc),
        }


def update_project() -> None:
    with STATE_LOCK:
        if STATE["updating"]:
            return
        STATE.update({"updating": True, "message": "正在抓取最新代码", "lastError": ""})

    try:
        fetch_remote()
        remote_commit = commit_for(remote_ref())
        current_commit = deployed_commit()

        if remote_commit == current_commit and current_link_ready():
            STATE.update({"message": "当前已是最新版本", "lastUpdatedAt": now_iso()})
            return

        release_dir = export_release(remote_commit)
        STATE["message"] = "正在检查发布目录"
        run_build(release_dir)
        check_release(release_dir)
        switch_current_link(release_dir)
        STATE.update({"message": "更新完成", "lastUpdatedAt": now_iso()})
    except Exception as exc:  # noqa: BLE001
        STATE.update({"message": "更新失败", "lastError": str(exc)})
    finally:
        STATE["updating"] = False


@app.get("/health")
def health():
    return {"status": "ok", "repo": str(REPO_DIR)}


@app.get("/version")
def version():
    return JSONResponse(build_status(fetch=True))


@app.post("/update")
def update(background_tasks: BackgroundTasks):
    if STATE["updating"]:
        return JSONResponse(build_status(fetch=False))

    background_tasks.add_task(update_project)
    response = build_status(fetch=False)
    response["updating"] = True
    response["message"] = "已开始后台更新"
    return JSONResponse(response)
