from __future__ import annotations

import json
import os
import re
import socket
import urllib.error
import urllib.request
from typing import Any, Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


LLM_PROVIDER = os.getenv("LLM_PROVIDER", "ollama")
LLM_MODEL = os.getenv("LLM_MODEL", "qwen3:8b")
LLM_API_BASE = os.getenv("LLM_API_BASE", "http://127.0.0.1:11434/v1")
LLM_TIMEOUT_SECONDS = int(os.getenv("LLM_TIMEOUT_SECONDS", "180"))


app = FastAPI(title="近代军史数智平台大模型统一接口")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class DocumentMetadata(BaseModel):
    title: str = ""
    author: str = ""
    year: str = ""
    publisher: str = ""
    rights: str = ""
    source: str = ""


class LlmTaskRequest(BaseModel):
    documentId: str = ""
    pageId: str = ""
    pageNumber: int | None = None
    metadata: DocumentMetadata = Field(default_factory=DocumentMetadata)
    options: dict[str, Any] = Field(default_factory=dict)


class PunctuateRequest(LlmTaskRequest):
    sourceText: str
    sourceLayer: Literal["ocr", "clean", "punctuated"] = "clean"


class ProofreadRequest(LlmTaskRequest):
    ocrText: str = ""
    cleanText: str = ""
    punctuatedText: str = ""
    notes: str = ""


class ExtractEventsRequest(LlmTaskRequest):
    text: str
    sourceLayer: Literal["ocr", "clean", "punctuated"] = "punctuated"


class ExtractMetadataRequest(LlmTaskRequest):
    text: str
    source: Literal["filename", "ocr", "clean", "punctuated"] = "ocr"


class DetectCoverRequest(BaseModel):
    imageDataUrl: str
    fileName: str = ""
    metadata: DocumentMetadata = Field(default_factory=DocumentMetadata)
    options: dict[str, Any] = Field(default_factory=dict)


class ChronicleRequest(BaseModel):
    topic: str = ""
    events: list[dict[str, Any]] = Field(default_factory=list)
    documents: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class ChatRequest(BaseModel):
    prompt: str
    context: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class LlmServiceError(RuntimeError):
    pass


def provider_configured() -> bool:
    return bool(LLM_PROVIDER and LLM_MODEL and LLM_API_BASE)


def probe_provider() -> tuple[bool, str]:
    if not provider_configured():
        return False, "尚未配置本地模型或外部 API。"

    try:
        result = request_json("GET", f"{LLM_API_BASE.rstrip('/')}/models", timeout=3)
        model_names = [
            item.get("id", "")
            for item in result.get("data", [])
            if isinstance(item, dict)
        ]
        if model_names and LLM_MODEL not in model_names:
            return False, f"大模型服务已连接，但未找到模型 {LLM_MODEL}。"
        return True, f"大模型服务已连接，当前模型 {LLM_MODEL}。"
    except LlmServiceError as exc:
        return False, str(exc)


def base_response(task: str, ready: bool | None = None, message: str = "") -> dict[str, Any]:
    if ready is None:
        ready = provider_configured()

    return {
        "task": task,
        "provider": LLM_PROVIDER,
        "model": LLM_MODEL,
        "ready": ready,
        "reviewRequired": True,
        "status": "ready" if ready else "unavailable",
        "message": message or ("大模型服务已连接。" if ready else "大模型服务未连接。"),
    }


@app.get("/health")
def health() -> dict[str, Any]:
    ready, message = probe_provider()
    return {
        "status": "ok",
        "ready": ready,
        "provider": LLM_PROVIDER,
        "model": LLM_MODEL,
        "apiBase": LLM_API_BASE,
        "message": message,
    }


@app.get("/llm/health")
def llm_health() -> dict[str, Any]:
    return health()


@app.post("/llm/punctuate")
def punctuate(payload: PunctuateRequest) -> dict[str, Any]:
    prompt = f"""
/no_think
请处理一页近代军史文献整理文本。

任务：
1. 在不增删、不改写、不概括原文内容的前提下，进行简体转换、断句和添加现代标点。
2. 保留人名、地名、机构名、军队番号、年号、日期等专名信息。
3. 不能把推测内容直接写入正文；不确定处放入 uncertainItems。
4. 输出必须是 JSON，不要输出解释文字。

返回格式：
{{
  "punctuatedText": "简体标点文本",
  "uncertainItems": ["不确定处"],
  "warnings": ["处理提示"]
}}

文献信息：
{format_metadata(payload.metadata)}

原文：
{payload.sourceText}
""".strip()

    try:
        result = call_json_task(prompt)
        punctuated_text = string_value(result.get("punctuatedText"))
        uncertain_items = list_value(result.get("uncertainItems"))
        warnings = list_value(result.get("warnings"))
        response = base_response("punctuate", ready=True)
    except LlmServiceError as exc:
        punctuated_text = ""
        uncertain_items = []
        warnings = [str(exc)]
        response = base_response("punctuate", ready=False, message=str(exc))

    response.update(
        {
            "documentId": payload.documentId,
            "pageId": payload.pageId,
            "pageNumber": payload.pageNumber,
            "sourceLayer": payload.sourceLayer,
            "sourceText": payload.sourceText,
            "punctuatedText": punctuated_text,
            "uncertainItems": uncertain_items,
            "warnings": warnings,
        }
    )
    return response


@app.post("/llm/proofread")
def proofread(payload: ProofreadRequest) -> dict[str, Any]:
    prompt = f"""
/no_think
请对一页近代军史文献的多层整理文本做校对报告。

原则：
1. 只指出疑点，不直接修改正文。
2. 重点检查 OCR 原始录文、忠实整理文本、简体标点文本之间是否有漏字、错字、重复、顺序错乱或疑难字未标。
3. 不能凭空判断史实，只能基于输入文本提出待核对建议。
4. 输出必须是 JSON，不要输出解释文字。

返回格式：
{{
  "highRiskPages": [页码],
  "suspectedMissingText": ["疑似漏字漏句"],
  "suspectedWrongCharacters": ["疑似错字"],
  "uncertainCharacters": ["不确定字词"],
  "reviewNotes": ["需要人工复核的事项"]
}}

页码：{payload.pageNumber or ""}
文献信息：
{format_metadata(payload.metadata)}

OCR 原始录文：
{payload.ocrText}

忠实整理文本：
{payload.cleanText}

简体标点文本：
{payload.punctuatedText}

已有核对说明：
{payload.notes}
""".strip()

    try:
        result = call_json_task(prompt)
        report = {
            "highRiskPages": list_value(result.get("highRiskPages")),
            "suspectedMissingText": list_value(result.get("suspectedMissingText")),
            "suspectedWrongCharacters": list_value(result.get("suspectedWrongCharacters")),
            "uncertainCharacters": list_value(result.get("uncertainCharacters")),
            "reviewNotes": list_value(result.get("reviewNotes")),
        }
        response = base_response("proofread", ready=True)
    except LlmServiceError as exc:
        report = {
            "highRiskPages": [],
            "suspectedMissingText": [],
            "suspectedWrongCharacters": [],
            "uncertainCharacters": [],
            "reviewNotes": [str(exc)],
        }
        response = base_response("proofread", ready=False, message=str(exc))

    response.update(
        {
            "documentId": payload.documentId,
            "pageId": payload.pageId,
            "pageNumber": payload.pageNumber,
            "report": report,
        }
    )
    return response


@app.post("/llm/extract-events")
def extract_events(payload: ExtractEventsRequest) -> dict[str, Any]:
    prompt = f"""
/no_think
请从一页近代军史文献文本中抽取史事事件。

原则：
1. 严格依托输入文本，不补充库外信息。
2. 不加入立场褒贬。
3. 时间、地点、人物、机构、事件行为、结果不确定时留空或标注 uncertain。
4. 每个事件必须保留原文依据 quote。
5. 输出必须是 JSON，不要输出解释文字。

返回格式：
{{
  "events": [
    {{
      "dateOriginal": "原文时间",
      "dateGregorian": "YYYY-MM-DD 或空",
      "dateLunar": "农历时间或待核",
      "place": ["地点"],
      "persons": ["人物"],
      "organizations": ["机构或部队番号"],
      "event": "客观精要表述",
      "result": "结果或空",
      "quote": "原文依据",
      "uncertain": false
    }}
  ],
  "warnings": ["处理提示"]
}}

页码：{payload.pageNumber or ""}
文献信息：
{format_metadata(payload.metadata)}

文本：
{payload.text}
""".strip()

    try:
        result = call_json_task(prompt)
        events = normalize_events(result.get("events"))
        warnings = list_value(result.get("warnings"))
        response = base_response("extract-events", ready=True)
    except LlmServiceError as exc:
        events = []
        warnings = [str(exc)]
        response = base_response("extract-events", ready=False, message=str(exc))

    response.update(
        {
            "documentId": payload.documentId,
            "pageId": payload.pageId,
            "pageNumber": payload.pageNumber,
            "sourceLayer": payload.sourceLayer,
            "events": events,
            "warnings": warnings,
        }
    )
    return response


@app.post("/llm/extract-metadata")
def extract_metadata(payload: ExtractMetadataRequest) -> dict[str, Any]:
    prompt = f"""
/no_think
请从近代军史文献文本中识别基础文献信息。

原则：
1. 只依据输入文本，不要猜测。
2. 未识别到的字段必须返回空字符串。
3. 不要把正文内容误判为著者、出版社或版权信息。
4. 输出必须是 JSON，不要输出解释文字。

返回格式：
{{
  "title": "文献名或空",
  "author": "著者或空",
  "year": "出版年份或成书年份或空",
  "publisher": "出版社或出版机构或空",
  "rights": "版权信息或空",
  "source": "馆藏、来源、版本信息或空",
  "warnings": ["处理提示"]
}}

现有信息：
{format_metadata(payload.metadata)}

待识别文本：
{payload.text}
""".strip()

    try:
        result = call_json_task(prompt)
        metadata = {
            "title": string_value(result.get("title")),
            "author": string_value(result.get("author")),
            "year": string_value(result.get("year")),
            "publisher": string_value(result.get("publisher")),
            "rights": string_value(result.get("rights")),
            "source": string_value(result.get("source")),
        }
        warnings = list_value(result.get("warnings"))
        response = base_response("extract-metadata", ready=True)
    except LlmServiceError as exc:
        metadata = {
            "title": "",
            "author": "",
            "year": "",
            "publisher": "",
            "rights": "",
            "source": "",
        }
        warnings = [str(exc)]
        response = base_response("extract-metadata", ready=False, message=str(exc))

    response.update(
        {
            "documentId": payload.documentId,
            "pageId": payload.pageId,
            "pageNumber": payload.pageNumber,
            "source": payload.source,
            "metadata": metadata,
            "warnings": warnings,
        }
    )
    return response


@app.post("/llm/detect-cover")
def detect_cover(payload: DetectCoverRequest) -> dict[str, Any]:
    prompt = f"""
/no_think
请判断这张上传文件候选图是否适合作为文献封面。

判断标准：
1. 如果画面像书籍、期刊、档案册、报告、文献首页、扉页、题名页，且能代表整本文献，返回 hasCover=true。
2. 如果只是正文页、扫描空白页、目录页、普通内页、照片、表格或无法判断，返回 hasCover=false。
3. 只基于图片判断，不要猜测。
4. 输出必须是 JSON，不要输出解释文字。

返回格式：
{{
  "hasCover": true,
  "confidence": 0.0,
  "reason": "简短判断依据"
}}

文件名：{payload.fileName}
现有文献信息：
{format_metadata(payload.metadata)}
""".strip()

    try:
        result = call_json_vision_task(prompt, payload.imageDataUrl)
        has_cover = bool_value(result.get("hasCover"))
        confidence = float_value(result.get("confidence"))
        reason = string_value(result.get("reason"))
        response = base_response("detect-cover", ready=True)
    except LlmServiceError as exc:
        has_cover = False
        confidence = 0.0
        reason = str(exc)
        response = base_response("detect-cover", ready=False, message=str(exc))

    response.update(
        {
            "fileName": payload.fileName,
            "hasCover": has_cover,
            "confidence": confidence,
            "reason": reason,
        }
    )
    return response


@app.post("/llm/chronicle")
def chronicle(payload: ChronicleRequest) -> dict[str, Any]:
    prompt = f"""
/no_think
请基于库内事件生成史事编年草稿。

原则：
1. 只使用输入 events 和 documents，不引入外部材料。
2. 严格按照时间先后排序。
3. 同日多件事情，应在条目中标注同日。
4. 公历、农历双重标注；缺失或无法换算时写“待核”。
5. 史事表述必须客观、精要，不加入立场褒贬。
6. 每条必须保留来源信息和原文依据。
7. 输出必须是 JSON，不要输出解释文字。

返回格式：
{{
  "entries": [
    {{
      "dateLabel": "公历年月日（农历年月日）",
      "sameDay": false,
      "summary": "客观史事",
      "sources": [
        {{
          "author": "著者",
          "title": "文献名",
          "publisher": "出版信息",
          "year": "年份",
          "pageNumber": 1,
          "quote": "原文依据"
        }}
      ]
    }}
  ],
  "warnings": ["处理提示"]
}}

主题：
{payload.topic}

事件数据：
{json.dumps(payload.events, ensure_ascii=False)}

文献数据：
{json.dumps(payload.documents, ensure_ascii=False)}
""".strip()

    try:
        result = call_json_task(prompt)
        entries = normalize_entries(result.get("entries"))
        warnings = list_value(result.get("warnings"))
        response = base_response("chronicle", ready=True)
    except LlmServiceError as exc:
        entries = []
        warnings = [str(exc)]
        response = base_response("chronicle", ready=False, message=str(exc))

    response.update(
        {
            "topic": payload.topic,
            "entries": entries,
            "warnings": warnings,
        }
    )
    return response


@app.post("/llm/chat")
def chat(payload: ChatRequest) -> dict[str, Any]:
    prompt = f"""
/no_think
请作为近代军史文献书库助手回答用户问题。

原则：
1. 优先依据输入的书库上下文回答。
2. 如果上下文不足，明确说明“当前书库材料不足以确认”。
3. 不要编造来源、页码或史实。
4. 回答要简洁，必要时列出所依据的文献页码。

用户问题：
{payload.prompt}

书库上下文：
{json.dumps(payload.context, ensure_ascii=False)}
""".strip()

    try:
        answer = call_chat_completion(
            [
                {
                    "role": "system",
                    "content": "你是近代军史文献书库助手。回答必须忠于用户书库上下文，不足则说明不足。",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            json_response=False,
        )
        response = base_response("chat", ready=True)
    except LlmServiceError as exc:
        answer = ""
        response = base_response("chat", ready=False, message=str(exc))

    response.update(
        {
            "prompt": payload.prompt,
            "answer": answer.strip(),
            "contextCount": len(payload.context),
        }
    )
    return response


def call_json_task(prompt: str) -> dict[str, Any]:
    content = call_chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "你是近代军史文献整理助手。你必须忠于原文，只输出合法 JSON，"
                    "不得输出 Markdown，不得输出解释。"
                ),
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.1,
    )
    return parse_json_object(content)


def call_json_vision_task(prompt: str, image_data_url: str) -> dict[str, Any]:
    content = call_chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "你是近代军史文献图像整理助手。你必须只依据图片判断，"
                    "只输出合法 JSON，不得输出 Markdown，不得输出解释。"
                ),
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            },
        ],
        temperature=0.1,
    )
    return parse_json_object(content)


def call_chat_completion(
    messages: list[dict[str, Any]],
    temperature: float = 0.1,
    json_response: bool = True,
) -> str:
    if not provider_configured():
        raise LlmServiceError("尚未配置本地模型或外部 API。")

    if LLM_PROVIDER == "ollama":
        return call_ollama_chat_completion(messages, temperature, json_response)

    url = f"{LLM_API_BASE.rstrip('/')}/chat/completions"
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if json_response:
        payload["response_format"] = {"type": "json_object"}

    result = request_json("POST", url, payload=payload, timeout=LLM_TIMEOUT_SECONDS)

    try:
        return str(result["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmServiceError("大模型返回格式异常。") from exc


def call_ollama_chat_completion(
    messages: list[dict[str, Any]],
    temperature: float = 0.1,
    json_response: bool = True,
) -> str:
    base = LLM_API_BASE.rstrip("/")
    ollama_root = base.removesuffix("/v1")
    url = f"{ollama_root}/api/chat"
    payload = {
        "model": LLM_MODEL,
        "messages": normalize_ollama_messages(messages),
        "stream": False,
        "options": {
            "temperature": temperature,
        },
    }
    if json_response:
        payload["format"] = "json"

    result = request_json("POST", url, payload=payload, timeout=LLM_TIMEOUT_SECONDS)

    try:
        return str(result["message"]["content"])
    except (KeyError, TypeError) as exc:
        raise LlmServiceError("Ollama 返回格式异常。") from exc


def normalize_ollama_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for message in messages:
        content = message.get("content", "")
        if not isinstance(content, list):
            normalized.append(message)
            continue

        text_parts: list[str] = []
        images: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                text_parts.append(str(part.get("text", "")))
            if part.get("type") == "image_url":
                image_url = part.get("image_url", {})
                if isinstance(image_url, dict):
                    images.append(strip_data_url(str(image_url.get("url", ""))))

        normalized_message = {
            "role": message.get("role", "user"),
            "content": "\n".join([text for text in text_parts if text]),
        }
        if images:
            normalized_message["images"] = images
        normalized.append(normalized_message)
    return normalized


def strip_data_url(value: str) -> str:
    if "," in value and value.startswith("data:"):
        return value.split(",", 1)[1]
    return value


def request_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: int = LLM_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("LLM_API_KEY", "")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise LlmServiceError(f"大模型接口请求失败：HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise LlmServiceError(f"无法连接大模型服务：{exc.reason}") from exc
    except (TimeoutError, socket.timeout) as exc:
        raise LlmServiceError("大模型请求超时。") from exc

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise LlmServiceError("大模型接口返回内容不是 JSON。") from exc


def parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if not match:
            raise LlmServiceError("大模型未返回 JSON 对象。")
        value = json.loads(match.group(0))

    if not isinstance(value, dict):
        raise LlmServiceError("大模型返回的 JSON 不是对象。")
    return value


def format_metadata(metadata: DocumentMetadata) -> str:
    return "\n".join(
        [
            f"文献名：{metadata.title}",
            f"著者：{metadata.author}",
            f"年份：{metadata.year}",
            f"出版社：{metadata.publisher}",
            f"版权信息：{metadata.rights}",
            f"来源信息：{metadata.source}",
        ]
    )


def string_value(value: Any) -> str:
    return value if isinstance(value, str) else ""


def float_value(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def bool_value(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "是", "有"}
    return False


def list_value(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value:
        return [value]
    return []


def normalize_events(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def normalize_entries(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]
