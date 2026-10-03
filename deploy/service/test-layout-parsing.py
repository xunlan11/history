"""服务端 OCR 冒烟测试：按数据端契约格式调用 /layout-parsing。

用法：
    ~/history-service/venv-ocr/bin/python ~/history-service/test-layout-parsing.py [图片路径] [服务端地址]
不给图片时自动生成一张带文字的测试图。
"""

import argparse
import base64
import json
import sys
import time
import urllib.request

from PIL import Image, ImageDraw


def build_image(path: str) -> None:
    img = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(img)
    for index, text in enumerate(
        [
            "OCR UPSTREAM SELFTEST",
            "The quick brown fox jumps over the lazy dog.",
            "0123456789 - ASCII only, no font required.",
            "一、部队集结 1948年 徐州",
        ]
    ):
        draw.text((80, 140 + index * 60), text, fill="black")
    img.save(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", nargs="?")
    parser.add_argument("base_url", nargs="?", default="http://127.0.0.1:8080")
    parser.add_argument("--full", action="store_true", help="启用公式、印章和图表解析")
    parser.add_argument("--preprocess", action="store_true", help="启用方向分类与去扭曲")
    parser.add_argument("--expect", action="append", default=[], help="要求出现的版面标签，可重复")
    args = parser.parse_args()
    image_path = args.image or "/tmp/selftest-page.png"
    base_url = args.base_url.rstrip("/")
    if args.image is None:
        build_image(image_path)

    payload = {
        "file": base64.b64encode(open(image_path, "rb").read()).decode(),
        "fileType": 1,
        "filename": "page-1.png",
        "pageNumber": 1,
        "useLayoutDetection": True,
        "useTableRecognition": True,
        "useDocOrientationClassify": args.preprocess,
        "useDocUnwarping": args.preprocess,
        "useTextlineOrientation": True,
        "useFormulaRecognition": args.full,
        "useSealRecognition": args.full,
        "useChartRecognition": args.full,
        "visualize": False,
    }
    request = urllib.request.Request(
        f"{base_url}/layout-parsing",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    started = time.time()
    try:
        response = json.load(urllib.request.urlopen(request, timeout=900))
    except urllib.error.HTTPError as exc:
        print(f"失败：HTTP {exc.code}\n{exc.read().decode()[:2000]}")
        return 1
    elapsed = time.time() - started

    result = response["result"]["layoutParsingResults"][0]
    pruned = result["prunedResult"]
    blocks = pruned.get("parsing_res_list", [])
    overall = pruned.get("overall_ocr_res") or {}
    print(f"耗时 {elapsed:.1f}s；返回字段 {sorted(pruned.keys())}")
    print(f"版面块 {len(blocks)} 个：")
    for block in blocks[:8]:
        print(
            f"  - {block.get('block_label')} order={block.get('block_order')} "
            f"bbox={block.get('block_bbox')} text={(block.get('block_content') or '')[:50]!r}"
        )
    print("识别文本行：", overall.get("rec_texts"))
    print("markdown 长度：", len(((result.get("markdown") or {}).get("text") or "")))
    print("实际模块设置：", pruned.get("model_settings"))
    labels = {block.get("block_label") for block in blocks}
    missing = set(args.expect) - labels
    if missing:
        print("缺少要求的版面标签：", sorted(missing))
        return 3
    return 0 if blocks else 2


if __name__ == "__main__":
    raise SystemExit(main())
