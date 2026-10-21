"""服务进程内的任务进度表。

标点、校对、登记等阶段都是一次下游调用，调用方拿不到细粒度进度；执行方
（大模型服务 / OCR 服务）在关键节点写入百分比，数据端调度器轮询读取后展示。
只在当前进程内存中保存，带 TTL，不落盘；服务重启从 0 重新开始，由调度器按
阶段状态继续显示。
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

PROGRESS_TTL_SECONDS = 300

_LOCK = threading.Lock()
_ENTRIES: dict[str, dict[str, float]] = {}


def set_progress(key: str, percent: int) -> None:
    if not key:
        return
    with _LOCK:
        _ENTRIES[key] = {"percent": max(0, min(100, int(percent))), "updatedAt": time.time()}


def read_progress(key: str) -> dict[str, float]:
    """读取进度；过期的条目在这里顺带清掉。没有记录时 percent=0、updatedAt=0。"""
    now = time.time()
    with _LOCK:
        for stale in [name for name, entry in _ENTRIES.items() if now - entry["updatedAt"] > PROGRESS_TTL_SECONDS]:
            _ENTRIES.pop(stale, None)
        entry = _ENTRIES.get(key)
        return dict(entry) if entry else {"percent": 0, "updatedAt": 0}


def progress_reporter(options: dict[str, Any] | None, expected_units: int) -> Callable[..., None] | None:
    """按「已处理量 / 预计总量」换算百分比。

    expected_units 一般取输入正文字数（生成类）或页数（逐页识别类）；
    没到末尾时最多报到 96%，真正完成时由调用方传 done=True 置 100%。
    """
    key = str((options or {}).get("progressKey") or "").strip()
    if not key:
        return None
    expected = max(1, int(expected_units or 0))

    def report(done_units: int, done: bool = False) -> None:
        percent = 100 if done else min(96, max(1, int(done_units * 96 / expected)))
        set_progress(key, percent)

    return report
