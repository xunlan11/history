"""服务端 OCR 冒烟测试：按数据端契约格式调用 /layout-parsing。

用法：
    ~/history-service/venv-ocr/bin/python ~/history-service/test-layout-parsing.py [图片路径] [服务端地址]
不给图片时自动生成一张带文字的测试图。
"""

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
    image_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/selftest-page.png"
    base_url = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8080"
    if len(sys.argv) <= 1:
        build_image(image_path)

    payload = {
        "file": base64.b64encode(open(image_path, "rb").read()).decode(),
        "fileType": 1,
        "filename": "page-1.png",
        "pageNumber": 1,
        "useLayoutDetection": True,
        "useTableRecognition": True,
        "useDocOrientationClassify": False,
        "useDocUnwarping": False,
        "useTextlineOrientation": True,
        "useFormulaRecognition": False,
        "useSealRecognition": False,
        "useChartRecognition": False,
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
    return 0 if blocks else 2


if __name__ == "__main__":
    raise SystemExit(main())
