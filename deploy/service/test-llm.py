"""服务端 LLM 冒烟测试：按 OpenAI 兼容接口调用，测量 CPU 生成速度。

用法：
    ~/history-service/venv-ocr/bin/python ~/history-service/test-llm.py [基地址] [模型名]
默认：http://127.0.0.1:11434/v1  qwen3:8b
"""

import json
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:11434/v1"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "qwen3:8b"

PROMPT = """/no_think
请把下面这段近代军史文献录文做简体转换、断句并添加现代标点，不要增删内容，直接输出结果：
第一军奉命于一九四八年十一月六日由商丘地区向徐州方向集结七日拂晓前抵达指定位置
""".strip()


def main() -> int:
    models = json.load(urllib.request.urlopen(f"{BASE}/models", timeout=10))
    ids = [item.get("id") for item in models.get("data") or []]
    print(f"可用模型：{ids}")
    if MODEL not in ids:
        print(f"警告：未找到模型 {MODEL}")

    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT}],
        "stream": False,
        "temperature": 0.2,
    }
    request = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    started = time.time()
    response = json.load(urllib.request.urlopen(request, timeout=1800))
    elapsed = time.time() - started

    choice = (response.get("choices") or [{}])[0]
    content = (choice.get("message") or {}).get("content", "")
    usage = response.get("usage") or {}
    completion_tokens = usage.get("completion_tokens") or 0
    print(f"总耗时 {elapsed:.1f}s，输出 {completion_tokens} tokens"
          f"，约 {completion_tokens / elapsed:.2f} tok/s")
    print("返回内容：", content.strip()[:300])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
