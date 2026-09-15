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

from service.chronology import normalize_chronicle_entries


# 修改默认大模型配置时，请同步更新 readme.md。
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "ollama")
LLM_MODEL = os.getenv("LLM_MODEL", "qwen3:8b")
LLM_API_BASE = os.getenv("LLM_API_BASE", "http://127.0.0.1:11434/v1")
LLM_TIMEOUT_SECONDS = int(os.getenv("LLM_TIMEOUT_SECONDS", "180"))
# 思考型模型（Qwen3）默认关闭思考：同一句话 595 token → 7 token，CPU 上 150s → 1.4s。
# 详见 docs/service-deploy.md 第 9.2 节；设为 1 可恢复思考模式。
LLM_OLLAMA_THINK = os.getenv("LLM_OLLAMA_THINK", "0").strip().lower() in {"1", "true", "yes", "on"}


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


class LlmTaskRequest(BaseModel):
    documentId: str = ""
    pageId: str = ""
    pageNumber: int | None = None
    metadata: DocumentMetadata = Field(default_factory=DocumentMetadata)
    options: dict[str, Any] = Field(default_factory=dict)


class PunctuateRequest(LlmTaskRequest):
    sourceText: str
    sourceLayer: Literal["ocr", "clean", "punctuated"] = "clean"


class PreviousPageContext(BaseModel):
    pageNumber: int | None = None
    text: str = ""


class FinalizePageRequest(LlmTaskRequest):
    ocrText: str = ""
    cleanText: str = ""
    punctuatedText: str = ""
    previousPages: list[PreviousPageContext] = Field(default_factory=list)


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
    documents: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class SearchRequest(BaseModel):
    query: str
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
        "reviewRequired": False,
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
3. 如果输入来自竖排古籍 OCR，保持已经重排好的现代阅读顺序，不要再按原版式逆序处理。
4. 不能把推测内容直接写入正文；不确定处放入 uncertainItems。
5. 输出必须是 JSON，不要输出解释文字。

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


@app.post("/llm/finalize-page")
def finalize_page(payload: FinalizePageRequest) -> dict[str, Any]:
    source_text = payload.punctuatedText or payload.cleanText or payload.ocrText
    previous_pages = "\n\n".join(
        f"第 {page.pageNumber or '?'} 页：\n{page.text}"
        for page in payload.previousPages
        if page.text.strip()
    ) or "无"
    prompt = f"""
/no_think
请将一页近代军史文献 OCR 文本整理成一版可继续人工编辑的正文。

任务：
1. 以 OCR 原始录文为底本，参考已有整理文本和简体标点文本。
2. 修正常见 OCR 错字、漏空格、断行和明显排版噪声。
3. 进行简体转换、断句和添加现代标点。
4. 保留原文意思和专名信息，不增补史实，不改写为摘要。
5. 如果 OCR 原始录文来自竖排古籍，保持已经重排好的现代阅读顺序，不要再按原版式逆序处理。
6. 无法确定的字词保留原样或用 `□` 表示，不在正文中加入解释。
7. 可参考前页整理文本判断本页开头的续句、承接关系、简称和省略信息，但不得把前页文字重复写入本页。
8. 输出必须是 JSON，不要输出解释文字。

返回格式：
{{
  "cleanText": "忠实整理文本",
  "punctuatedText": "简体标点文本",
  "warnings": ["处理提示"]
}}

页码：{payload.pageNumber or ""}
文献信息：
{format_metadata(payload.metadata)}

前页整理文本（仅作上下文）：
{previous_pages}

OCR 原始录文：
{payload.ocrText}

已有忠实整理文本：
{payload.cleanText}

已有简体标点文本：
{payload.punctuatedText}

优先处理文本：
{source_text}
""".strip()

    try:
        result = call_json_task(prompt)
        clean_text = string_value(result.get("cleanText"))
        punctuated_text = string_value(result.get("punctuatedText"))
        warnings = list_value(result.get("warnings"))
        response = base_response("finalize-page", ready=True)
    except LlmServiceError as exc:
        clean_text = ""
        punctuated_text = ""
        warnings = [str(exc)]
        response = base_response("finalize-page", ready=False, message=str(exc))

    response.update(
        {
            "documentId": payload.documentId,
            "pageId": payload.pageId,
            "pageNumber": payload.pageNumber,
            "cleanText": clean_text,
            "punctuatedText": punctuated_text,
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
3. 不要把正文内容误判为著者或出版社。
4. 输出必须是 JSON，不要输出解释文字。

返回格式：
{{
  "title": "文献名或空",
  "author": "著者或空",
  "year": "出版年份或成书年份或空",
  "publisher": "出版社或出版机构或空",
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
        }
        warnings = list_value(result.get("warnings"))
        response = base_response("extract-metadata", ready=True)
    except LlmServiceError as exc:
        metadata = {
            "title": "",
            "author": "",
            "year": "",
            "publisher": "",
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
请基于输入材料生成史事编年草稿。documents 同时可能包含库内文献和当前对话上传文件；每项包含 sourceType、documentId、attachmentId（仅上传文件）、title 及 pages，每页包含 pageId、pageNumber、text、notes。

其中 sourceType 为 conversation-file 的材料来自当前对话的临时快速读取，可能存在基础 OCR 或顺序误差；可以依据其原文生成结果，但不得把它表述成已经正式整理、登记入库的文献。

任务：
1. 现场从 documents.pages.text 中识别与主题相关的史事；主题为空时，抽取全部有明确时间依据的史事。
2. 识别复杂纪年的组成信息，包括民国纪年、清代年号、干支纪年、公历日期、农历日期、闰月以及上下文省略的年份或月份。
3. 不要自行做历法换算；只按原文和上下文填写 calendarType、year、month、day、eraName、eraYear、lunarMonth、lunarDay、lunarLeap、ganzhiYear。无法确定的字段留空。
4. 严格只使用输入材料，不引入外部史实，不补充材料外事件；日期换算、排序和同日判定由程序完成。
5. 史事表述必须客观、精要，不加入立场褒贬。
6. 每条必须保留材料定位依据、sourceType、documentId、attachmentId、pageId、pageNumber 和原文依据 quote；字段值必须照抄输入，不得虚构。
7. 输出必须是 JSON，不要输出解释文字或 Markdown。

返回格式：
{{
  "entries": [
    {{
      "dateOriginal": "原文时间表述",
      "calendarType": "gregorian、lunar 或 unknown",
      "year": 1898,
      "month": 0,
      "day": 0,
      "eraName": "光绪、民国等年号或空",
      "eraYear": 24,
      "lunarMonth": 6,
      "lunarDay": 3,
      "lunarLeap": false,
      "ganzhiYear": "戊戌或空",
      "summary": "客观史事",
      "sources": [
        {{
          "documentId": "输入中的 documentId",
          "attachmentId": "上传文件的 attachmentId 或空",
          "sourceType": "document-page 或 conversation-file",
          "pageId": "输入中的 pageId",
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

文献数据：
{json.dumps(payload.documents, ensure_ascii=False)}
""".strip()

    try:
        result = call_json_task(prompt)
        entries, chronology_warnings = normalize_chronicle_entries(
            normalize_entries(result.get("entries"))
        )
        warnings = list_value(result.get("warnings")) + chronology_warnings
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


@app.post("/llm/search")
def search(payload: SearchRequest) -> dict[str, Any]:
    prompt = f"""
/no_think
请在用户书库文献和当前对话上传文件中做智能检索。

其中 sourceType 为 conversation-file 的材料来自当前对话的临时快速读取，可能存在基础 OCR 或顺序误差；仍须忠实引用输入文字，不得补写或修正成材料中没有的内容。

任务：
1. 根据 query 在 documents.pages.text 和 notes 中找相关内容。
2. 不只做字面匹配，还要识别同一对象的不同称呼：
   - 人物：姓名、字、号、别名、旧译名、职务代称。
   - 战役/事件：中外不同称呼、敌我双方不同称呼、简称、旧称。
   - 机构/部队：全称、简称、番号变化、上级/下级常见代称。
   - 地名：旧地名、异体写法、简称。
3. 可以使用通用历史常识判断别称关系，但匹配结果必须能在输入材料中找到原文依据 quote。
4. 不要把只是同一时代、同一地区但无直接关联的内容列为结果。
5. 每条结果必须保留 sourceType、documentId、attachmentId、pageId、pageNumber，方便前端打开原文献或上传文件。
6. 按相关性排序：直接命中、明确别称、强上下文关联优先。
7. 最多返回 options.maxMatches 条；如果命中更多，在 warnings 中说明还有更多结果。
8. 输出必须是 JSON，不要输出解释文字或 Markdown。

返回格式：
{{
  "matches": [
    {{
      "documentId": "输入中的 documentId",
      "attachmentId": "上传文件的 attachmentId 或空",
      "sourceType": "document-page 或 conversation-file",
      "pageId": "输入中的 pageId",
      "pageNumber": 1,
      "title": "文献名",
      "author": "著者",
      "year": "年份",
      "matchedAs": "材料中实际出现的称呼",
      "matchType": "直接命中/别称/字号/战役异称/部队番号/地名旧称/上下文关联",
      "reason": "为什么判断与 query 相关",
      "quote": "原文依据",
      "score": 0.0
    }}
  ],
  "expandedTerms": ["模型识别出的同义称谓"],
  "warnings": ["处理提示"]
}}

query：
{payload.query}

options：
{json.dumps(payload.options, ensure_ascii=False)}

documents：
{json.dumps(payload.documents, ensure_ascii=False)}
""".strip()

    try:
        result = call_json_task(prompt)
        matches = normalize_entries(result.get("matches"))
        expanded_terms = list_value(result.get("expandedTerms"))
        warnings = list_value(result.get("warnings"))
        response = base_response("search", ready=True)
    except LlmServiceError as exc:
        matches = []
        expanded_terms = []
        warnings = [str(exc)]
        response = base_response("search", ready=False, message=str(exc))

    response.update(
        {
            "query": payload.query,
            "matches": matches,
            "expandedTerms": expanded_terms,
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
1. 优先依据输入上下文回答；其中 sourceType 为 conversation-file 的内容是当前对话上传文件的临时快速读取结果，并非正式入库文献。
2. 如果上下文不足，明确说明“当前材料不足以确认”。
3. 不要编造来源、页码或史实。
4. 回答要简洁，必要时列出所依据的文献页码。

用户问题：
{payload.prompt}

输入上下文：
{json.dumps(payload.context, ensure_ascii=False)}
""".strip()

    try:
        answer = call_chat_completion(
            [
                {
                    "role": "system",
                    "content": "你是近代军史文献书库助手。回答必须忠于输入上下文；临时上传文件可能存在快速读取误差，不足则说明不足。",
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
        # 关掉思考链：只对思考型模型有效，非思考模型传 false 同样安全。
        "think": LLM_OLLAMA_THINK,
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


def normalize_entries(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]
