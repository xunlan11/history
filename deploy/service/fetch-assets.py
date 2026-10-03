#!/usr/bin/env python3
"""服务端资产预取：PaddleX 官方模型 + Ollama 二进制 + Qwen3-8B 权重。

为什么用这些源（2026-10-03 在本机 zhs22 实测，出口带宽上限约 1.2 MB/s）：

    资产             快源                        实测速度       慢源 / 速度
    PaddleX 模型     ModelScope CDN              1.2 MB/s      百度 BOS 0.19 MB/s
    Qwen3-8B 权重    ModelScope GGUF(Q4_K_M)     1.2 MB/s      Ollama registry 0.09 MB/s
    Ollama 二进制    GitHub releases             ~1.1 MB/s     （间歇性不通，见下）

本机带宽是硬上限（清华源同样只有 1.24 MB/s），所以"提速"只能靠换源：相比手册里的
BOS + registry 组合，PaddleX 模型快约 6 倍、8B 权重快约 14 倍。

GitHub 直连会间歇性抽风（实测同一小时内既有 1.1 MB/s 也有完全不通），因此
  * 每个传输都加了 `--speed-limit/--speed-time`：低速超过 45s 自动断开，避免永久挂死；
  * Ollama 二进制配了多条备用路径（GitHub 直连 → ghproxy → 本机 Clash 代理）。
全部支持断点续传，中断后重跑即可；已完整的文件按大小跳过。

用法（默认串行：本机出口带宽约 1.2 MB/s，并行不会更快，只会互相抢带宽）：
    python3 fetch-assets.py               # 全量下载（可反复重跑）
    python3 fetch-assets.py --only gguf   # 只下某一个（名字见 TASKS）
    python3 fetch-assets.py --verify      # 只做 sha256 校验，不下载
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HOME = Path.home()
ROOT = HOME / "history-service"
DL = ROOT / "dl"
LOG = ROOT / "logs"
PADDLEX_MODELS = HOME / ".paddlex" / "official_models"

MS_API = "https://modelscope.cn/api/v1/models"
MS_ORG = "PaddlePaddle"

OLLAMA_VERSION = "v0.35.1"
OLLAMA_ASSET = "ollama-linux-amd64.tar.zst"
OLLAMA_SIZE = 1_439_658_961
GH_RELEASE = f"https://github.com/ollama/ollama/releases/download/{OLLAMA_VERSION}/{OLLAMA_ASSET}"
# 依次尝试；proxy 为 None 表示直连
OLLAMA_SOURCES = [
    ("github-直连", GH_RELEASE, None),
    ("ghproxy.imciel", f"https://ghproxy.imciel.com/{GH_RELEASE}", None),
    ("clash-代理", GH_RELEASE, "http://127.0.0.1:7897"),
]
OLLAMA_DEST = DL / OLLAMA_ASSET

GGUF_REPO = "Qwen/Qwen3-8B-GGUF"
GGUF_FILE = "Qwen3-8B-Q4_K_M.gguf"
GGUF_SIZE = 5_027_783_488
GGUF_DEST = ROOT / "gguf" / GGUF_FILE

# PP-StructureV3 完整版（公式/印章/图表/方向矫正全开）用到的全部模型
PADDLE_MODELS = [
    "PP-DocLayout_plus-L",
    "PP-DocBlockLayout",
    "PP-OCRv5_server_det",
    "PP-OCRv5_server_rec",
    "PP-LCNet_x1_0_textline_ori",
    "PP-LCNet_x1_0_doc_ori",
    "PP-LCNet_x1_0_table_cls",
    "SLANeXt_wired",
    "SLANet_plus",
    "RT-DETR-L_wired_table_cell_det",
    "RT-DETR-L_wireless_table_cell_det",
    "UVDoc",
    "PP-FormulaNet_plus-L",
    "PP-Chart2Table_safetensors",
    "PP-OCRv4_server_seal_det",
]

SKIP_NAMES = {".gitattributes", "README.md"}

# 低速保护：连续 45s 低于 50 KB/s 就断开重试，避免 GitHub 抽风时永久干挂
STALL_ARGS = ["--speed-limit", "51200", "--speed-time", "45"]


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def curl_cmd(proxy: str | None) -> list[str]:
    cmd = [
        "curl", "-sSL",
        "--retry", "6", "--retry-delay", "5", "--retry-all-errors",
        "--connect-timeout", "20", *STALL_ARGS, "-C", "-",
    ]
    if proxy:
        cmd += ["--proxy", proxy]
    else:
        cmd += ["--noproxy", "*"]
    return cmd


def http_json(url: str, timeout: int = 30):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as resp:
        return json.load(resp)


def download(url: str, dest: Path, expect: int | None = None, *, proxy: str | None = None,
             tries: int = 20) -> bool:
    """curl 断点续传到 dest；已完整则跳过，否则反复重试直到大小符合预期。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, tries + 1):
        if expect is not None and dest.exists() and dest.stat().st_size == expect:
            return True
        proc = subprocess.run(curl_cmd(proxy) + ["-o", str(dest), url], capture_output=True)
        # 33：本地文件已达远端大小（服务器拒绝续传区间）
        if proc.returncode in (0, 33):
            if expect is None:
                return True
            if dest.exists() and dest.stat().st_size == expect:
                return True
        size = dest.stat().st_size if dest.exists() else -1
        log(f"  重试 {attempt}/{tries}（curl={proc.returncode}，{size}/{expect}）{dest.name}")
        time.sleep(min(3 * attempt, 20))
    return False


def paddle_file_url(repo: str, path: str) -> str:
    return f"{MS_API}/{MS_ORG}/{repo}/repo?" + urllib.parse.urlencode(
        {"Revision": "master", "FilePath": path}
    )


def paddle_listing(model: str) -> list[dict]:
    for attempt in range(1, 6):
        try:
            listing = http_json(f"{MS_API}/{MS_ORG}/{model}/repo/files?Revision=master")
            return [f for f in listing["Data"]["Files"] if f["Name"] not in SKIP_NAMES]
        except Exception as exc:  # noqa: BLE001
            log(f"  {model}: 取文件清单失败（{attempt}/5）{exc}")
            time.sleep(5 * attempt)
    return []


def fetch_paddle_model(model: str) -> bool:
    target = PADDLEX_MODELS / model
    files = paddle_listing(model)
    if not files:
        log(f"!! {model}: 无法取得 ModelScope 文件清单")
        return False
    total = sum(f["Size"] for f in files)
    log(f"→ {model}（{len(files)} 个文件，{total / 1048576:.1f} MB）")
    ok = True
    for f in files:
        if not download(paddle_file_url(model, f["Path"]), target / f["Path"], f["Size"]):
            log(f"!! {model}/{f['Path']} 重试后仍失败")
            ok = False
    return ok


def fetch_ollama() -> bool:
    for name, url, proxy in OLLAMA_SOURCES:
        log(f"→ Ollama {OLLAMA_VERSION}（{OLLAMA_SIZE / 1048576:.0f} MB）源：{name}")
        if download(url, OLLAMA_DEST, OLLAMA_SIZE, proxy=proxy, tries=6):
            log(f"  源 {name} 完成")
            return True
        log(f"  源 {name} 未完成，换下一个")
    return False


def fetch_gguf() -> bool:
    log(f"→ Qwen3-8B GGUF（{GGUF_SIZE / 1048576:.0f} MB）源：ModelScope")
    return download(f"{MS_API}/{GGUF_REPO}/repo?" + urllib.parse.urlencode(
        {"Revision": "master", "FilePath": GGUF_FILE}), GGUF_DEST, GGUF_SIZE)


TASKS = {
    "ollama": fetch_ollama,
    "gguf": fetch_gguf,
    **{f"paddle:{m}": (lambda mm: (lambda: fetch_paddle_model(mm)))(m) for m in PADDLE_MODELS},
}


def sha256(path: Path, chunk: int = 1 << 22) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while block := fh.read(chunk):
            h.update(block)
    return h.hexdigest()


def verify() -> int:
    """按 ModelScope 清单里的 sha256 校验已下载文件。"""
    log("校验 ModelScope 资产（sha256）…")
    bad: list[str] = []
    checked = 0
    for model in PADDLE_MODELS:
        for f in paddle_listing(model):
            path = PADDLEX_MODELS / model / f["Path"]
            if not path.exists():
                bad.append(f"缺失 {model}/{f['Path']}")
                continue
            checked += 1
            if path.stat().st_size != f["Size"] or sha256(path) != f["Sha256"]:
                bad.append(f"损坏 {model}/{f['Path']}")
    try:
        listing = http_json(f"{MS_API}/{GGUF_REPO}/repo/files?Revision=master")
        want = next(f for f in listing["Data"]["Files"] if f["Name"] == GGUF_FILE)
        checked += 1
        if not GGUF_DEST.exists() or sha256(GGUF_DEST) != want["Sha256"]:
            bad.append(f"损坏 {GGUF_FILE}")
    except Exception as exc:  # noqa: BLE001
        log(f"  GGUF 校验取清单失败：{exc}")
    log(f"校验完成：{checked} 个文件，问题 {len(bad)} 个")
    for b in bad:
        log(f"  {b}")
    return 1 if bad else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", action="append", default=[],
                        help="只跑指定任务，可重复；名字见 TASKS")
    parser.add_argument("--verify", action="store_true", help="只做 sha256 校验")
    parser.add_argument("--workers", type=int, default=1,
                        help="并发数；默认 1（本机出口带宽约 1.2 MB/s，串行下载）")
    args = parser.parse_args()

    DL.mkdir(parents=True, exist_ok=True)
    LOG.mkdir(parents=True, exist_ok=True)

    if args.verify:
        return verify()

    names = args.only or list(TASKS)
    log(f"开始下载 {len(names)} 个任务（并发 {args.workers}）")
    results: dict[str, bool] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(TASKS[n]): n for n in names}
        for fut, name in futures.items():
            try:
                results[name] = bool(fut.result())
            except Exception as exc:  # noqa: BLE001
                log(f"!! {name}: {exc}")
                results[name] = False

    failed = [n for n, ok in results.items() if not ok]
    log("=" * 60)
    log(f"完成 {len(results) - len(failed)}/{len(results)}")
    for n in failed:
        log(f"  失败：{n}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
