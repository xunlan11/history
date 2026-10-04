"""OCR 服务端自检：连通性 + 契约 + 归一化结果。

数据端不再部署识别模型，识别能力由数据处理服务器通过 HTTP 提供。服务端换机器、
换实现或升级版本后，先跑这个脚本确认契约没对不上。

用法：

    cd ~/Codefield/history
    OCR_UPSTREAM_URL=http://10.0.0.5:8080 uv run python scripts/check_ocr_upstream.py
    uv run python scripts/check_ocr_upstream.py --url http://10.0.0.5:8080 --image scan-001.png
    uv run python scripts/check_ocr_upstream.py --url http://10.0.0.5:8080 --json

不带 `--image` 时用 PIL 生成一张带文字的小图，只验证链路与字段，不验证识别精度。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

from service import ocr_upstream  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OCR 服务端自检")
    parser.add_argument("--url", default="", help="服务端基地址，覆盖 OCR_UPSTREAM_URL")
    parser.add_argument(
        "--style",
        default="",
        choices=["", "auto", "paddlex", "native"],
        help="服务端契约风格，覆盖 OCR_UPSTREAM_STYLE",
    )
    parser.add_argument("--token", default="", help="Bearer 令牌，覆盖 OCR_UPSTREAM_TOKEN")
    parser.add_argument("--image", default="", help="用于测试的图片；缺省时自动生成")
    parser.add_argument("--mode", default="formal", choices=["formal", "quick"], help="识别模式")
    parser.add_argument("--timeout", type=float, default=0.0, help="单页超时秒数")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出完整结果")
    return parser.parse_args()


def build_test_image() -> Path:
    from PIL import Image, ImageDraw

    target = Path("/tmp/ocr-upstream-selftest.png")
    image = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(image)
    lines = [
        "OCR UPSTREAM SELFTEST",
        "The quick brown fox jumps over the lazy dog.",
        "0123456789 - ASCII only, no font required.",
    ]
    for index, text in enumerate(lines):
        draw.text((80, 120 + index * 46), text, fill="black")
    image.save(target)
    return target


def preview(text: str, limit: int = 120) -> str:
    text = " / ".join(line for line in text.splitlines() if line.strip())
    return text[:limit] + ("…" if len(text) > limit else "")


def main() -> int:
    args = parse_args()
    if args.url:
        os.environ["OCR_UPSTREAM_URL"] = args.url
    if args.style:
        os.environ["OCR_UPSTREAM_STYLE"] = args.style
    if args.token:
        os.environ["OCR_UPSTREAM_TOKEN"] = args.token
    if args.timeout > 0:
        os.environ["OCR_UPSTREAM_TIMEOUT"] = str(args.timeout)

    summary: dict[str, Any] = {"config": ocr_upstream.describe()}
    print(f"配置：{json.dumps(summary['config'], ensure_ascii=False)}")

    if not summary["config"]["configured"]:
        print("失败：未设置 OCR_UPSTREAM_URL，识别能力未部署。")
        print("     systemd unit 里加 Environment=OCR_UPSTREAM_URL=http://<服务端地址>:<端口> 后重启服务。")
        return 2

    summary["health"] = ocr_upstream.health(force=True)
    print(
        "探活：reachable={reachable} latencyMs={latencyMs} detail={detail}".format(**summary["health"]),
    )
    if not summary["health"]["reachable"]:
        print("警告：探活未通过，继续尝试真实识别请求以进一步定位。")

    image_path = Path(args.image).expanduser() if args.image else build_test_image()
    if not image_path.exists():
        print(f"失败：图片不存在 {image_path}")
        return 2
    print(f"测试图：{image_path}")

    try:
        result = ocr_upstream.recognize_page_image(image_path, page_number=1, mode=args.mode)
    except ocr_upstream.OcrUpstreamError as exc:
        print(f"失败：{exc.code} - {exc}")
        if isinstance(exc, ocr_upstream.OcrUpstreamHttpError) and exc.body:
            print(f"服务端响应摘要：{exc.body}")
        print("排查：对照 deploy/README.md 中的 OCR 契约与隧道检查。")
        return 1

    blocks = result.get("blocks") or []
    lines = result.get("lines") or []
    summary["result"] = {
        "engine": result.get("engine"),
        "upstream": result.get("upstream"),
        "width": result.get("width"),
        "height": result.get("height"),
        "blockCount": len(blocks),
        "lineCount": len(lines),
        "blockTypes": [block.get("type") for block in blocks],
        "text": result.get("text") if "text" in result else None,
        "preview": preview("\n".join(block.get("text") or "" for block in blocks) or "\n".join(
            line.get("text", "") for line in lines
        )),
        "markdown": bool(result.get("markdown")),
    }

    print(f"引擎：{summary['result']['engine']}（style={summary['result']['upstream']['style']}"
          f"，{summary['result']['upstream']['latencyMs']} ms）")
    print(f"页面：{summary['result']['width']}x{summary['result']['height']}")
    print(f"版面：{summary['result']['blockCount']} 块 / {summary['result']['lineCount']} 行，"
          f"角色={summary['result']['blockTypes']}")
    print(f"文本预览：{summary['result']['preview'] or '（空）'}")
    print(f"整页 Markdown：{'有' if summary['result']['markdown'] else '无'}")

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))

    if not blocks and not lines:
        print("警告：服务端未返回任何文本，契约通了但识别结果为空。")
        return 3
    if not all(block.get("bbox") for block in blocks):
        print("提示：部分版面块没有坐标，前端若要做原图高亮需要服务端补 bbox。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
