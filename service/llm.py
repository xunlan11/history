from __future__ import annotations

import difflib
import json
import os
import re
import socket
import unicodedata
import urllib.error
import urllib.request
from typing import Any, Iterator, Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from service.evidence import BudgetConfig, EvidenceError, NO_RELEVANT_MATERIAL, fit_prompt_budget, normalize_chronicle_dates, validate_result_citations
from service.task_progress import progress_reporter, read_progress


# 数据端通过反向隧道访问服务端 Ollama 的 OpenAI 兼容接口（127.0.0.1:11435）。
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "ollama")
LLM_MODEL = os.getenv("LLM_MODEL", "qwen3:8b")
LLM_API_BASE = os.getenv("LLM_API_BASE", "http://127.0.0.1:11435/v1")
LLM_TIMEOUT_SECONDS = int(os.getenv("LLM_TIMEOUT_SECONDS", "180"))
# 详见 deploy/README.md；设为 1 可恢复思考模式。
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
    sourceLayer: Literal["ocr", "normalized", "punctuated"] = "normalized"


class PreviousPageContext(BaseModel):
    pageNumber: int | None = None
    text: str = ""


class FinalizePageRequest(LlmTaskRequest):
    ocrText: str = ""
    normalizedText: str = ""
    punctuationDraftText: str = ""
    previousPages: list[PreviousPageContext] = Field(default_factory=list)

    class Config:
        extra = "forbid"


class ExtractMetadataRequest(LlmTaskRequest):
    text: str
    source: Literal["filename", "ocr", "normalized", "punctuated"] = "ocr"


class ChronicleRequest(BaseModel):
    evidence: list[dict[str, Any]] = Field(default_factory=list, max_length=200)
    topic: str = ""
    documents: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class SupplementChronicleRequest(BaseModel):
    topic: str = ""
    previousEntries: list[dict[str, Any]] = Field(default_factory=list)
    documents: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class SearchRequest(BaseModel):
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    query: str
    documents: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class ChatRequest(BaseModel):
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    prompt: str
    context: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class LlmServiceError(RuntimeError):
    pass


class LlmServiceUnavailable(LlmServiceError):
    """无法建立连接或探测超时；区别于服务已响应但未就绪。"""


# 单页阶段任务的实时进度：由 service.task_progress 提供，调度器轮询 GET /llm/progress/{key}。


# 用于校验“模型只加了标点”的正文比较：标点与空白都不算正文字符。
COMPARE_IGNORED_CATEGORIES = {"P", "Z"}


def normalize_layout_text(text: str) -> str:
    """清理 OCR 版面文本的空白，但保留逐行、逐列的换行。

    这些换行来自 OCR 版面：竖排古籍一行就是一列，需要抬头（抬格）的字词还会单独成行，
    所以换行本身不代表句子或自然段边界。怎么合并交给大模型按语义判断（提示词里要求按
    整页通读后断句，而不是逐处判定换行）；代码只做空白清理，并把原文里确定的段落分隔
    （空行）统一成一个空行。
    """
    if not text:
        return ""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    kept: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            if kept and kept[-1] != "":
                kept.append("")
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def content_characters(text: str) -> str:
    """只保留正文字符：去掉标点、空白和其它排版符号，用于校验与对齐。"""
    return "".join(
        char for char in text
        if not char.isspace() and unicodedata.category(char)[:1] not in COMPARE_IGNORED_CATEGORIES
    )


def punctuation_count(text: str) -> int:
    return sum(
        1 for char in text
        if not char.isspace() and unicodedata.category(char)[:1] == "P"
    )


def validate_punctuation_result(source: str, output: str) -> None:
    """校验标点结果只增加了标点；不通过就当作处理错误，由调度器重试。

    模型偶尔会整段原样抄回（一个标点都不加），或者干脆写成摘要。两种结果都不能入库。
    """
    if not output.strip():
        raise LlmServiceError("标点服务没有返回正文。")
    source_content = content_characters(source)
    if not source_content:
        return
    output_content = content_characters(output)
    ratio = difflib.SequenceMatcher(None, source_content, output_content).ratio()
    if ratio < 0.95:
        raise LlmServiceError(
            f"标点结果与原文差异过大（字符相似度 {ratio:.2f}），疑似改写或摘要，已放弃本次结果。"
        )
    if len(source_content) >= 40 and punctuation_count(source) == 0 and punctuation_count(output) == 0:
        raise LlmServiceError("标点服务没有给出标点：原文和结果都没有句内或句末点号。")


def validate_finalize_result(source: str, output: str) -> None:
    """校对允许改字，但不允许相对输入大幅缩水（缩水多半是模型写成了摘要）。"""
    if not output.strip():
        raise LlmServiceError("校对服务没有返回正文。")
    source_length = len(content_characters(source))
    output_length = len(content_characters(output))
    if source_length >= 200 and output_length < source_length * 0.85:
        raise LlmServiceError(
            f"校对结果只有 {output_length} 字，原文 {source_length} 字，疑似摘要，已放弃本次结果。"
        )


def provider_configured() -> bool:
    return bool(LLM_PROVIDER and LLM_MODEL and LLM_API_BASE)


def probe_provider_health() -> tuple[bool, str, str]:
    if not provider_configured():
        return False, "尚未配置大模型服务（服务端地址 / 模型名）。", "not_ready"

    try:
        result = request_json("GET", f"{LLM_API_BASE.rstrip('/')}/models", timeout=3)
        if not isinstance(result, dict) or not isinstance(result.get("data"), list):
            return False, "大模型服务已响应，但模型列表格式异常。", "not_ready"
        model_names = [
            item.get("id", "")
            for item in result["data"]
            if isinstance(item, dict)
        ]
        if LLM_MODEL not in model_names:
            return False, f"大模型服务已连接，但未找到模型 {LLM_MODEL}。", "not_ready"
        return True, f"大模型服务已连接，当前模型 {LLM_MODEL}。", "connected"
    except LlmServiceUnavailable as exc:
        return False, str(exc), "unreachable"
    except (LlmServiceError, ValueError) as exc:
        return False, str(exc), "not_ready"


def base_response(task: str, ready: bool, message: str = "") -> dict[str, Any]:
    return {
        "task": task,
        "provider": LLM_PROVIDER,
        "model": LLM_MODEL,
        "ready": ready,
        "reviewRequired": False,
        "status": "ready" if ready else "unavailable",
        "message": message or ("大模型服务已连接。" if ready else "大模型服务未连接。"),
    }


def failure_response(task: str, exc: LlmServiceError) -> dict[str, Any]:
    response = base_response(task, ready=False, message=str(exc))
    if isinstance(exc, LlmServiceUnavailable) or not provider_configured():
        unavailable = True
    else:
        # 已就绪模型生成无效 JSON 属于普通处理错误；模型、配置缺失或服务离线则等待恢复。
        unavailable = not probe_provider_health()[0]
    response["errorKind"] = "unavailable" if unavailable else "processing"
    return response


@app.get("/health")
def health() -> dict[str, Any]:
    ready, message, state = probe_provider_health()
    return {
        "status": "ok",
        "healthState": state,
        "ready": ready,
        "provider": LLM_PROVIDER,
        "model": LLM_MODEL,
        "apiBase": LLM_API_BASE,
        "message": message,
    }


@app.get("/llm/health")
def llm_health() -> dict[str, Any]:
    return health()


@app.get("/llm/progress/{key}")
def task_progress(key: str) -> dict[str, Any]:
    """调度器轮询用：返回该请求键当前的生成百分比。"""
    entry = read_progress(key)
    return {"key": key, "percent": entry["percent"], "updatedAt": entry["updatedAt"]}


@app.post("/llm/punctuate")
def punctuate(payload: PunctuateRequest) -> dict[str, Any]:
    # 逐行、逐列的换行是 OCR 版面信息（抬头字还常单独成行），不能在这里盲目合并。
    # 注意：提示词不要把任务框成「逐处判断换行是否切断句子」——实测这样会让模型退化成
    # 「按行分组 + 只在段末补句号」，长枚举段落里一个句内标点都不给。要按整页通读后逐句断句。
    source_text = normalize_layout_text(payload.sourceText)
    prompt = f"""
/no_think
请给下面这一页近代军史文献（多为竖排古籍 OCR 结果）断句，并加上现代汉语标点。

待整理文本（自 OCR 版面导出：换行来自原书的一列、一行，抬头（抬格）的字词也可能单独成行；空行表示原文的段落分隔。这些换行都不是句子或自然段的边界）：
{source_text}

怎么做：
1. 先通读整页、读懂全文再动手。竖排 OCR 的一列、一行只是版面，不要按行读、不要按行断句：凡是被换行切断的同一句话都要接起来读，读完整段才算一段结束。
2. 在读懂的基础上逐句加标点，一句都不能落下。长段落尤其重要——例如连续罗列官名、人名、职务、履历的长句，必须逐处给出顿号或逗号；整段只在末尾补一个句号是错误结果。
3. 加标点正是本次要新增的内容，标点不算增删文字。除标点外，不增字、不删字、不改字、不润色、不概括、不翻译、不补写；原文的汉字、数字、字母、专名和排列顺序保持不变。
4. 输入已经由 OpenCC 完成简体转换；输出必须使用简体中文，不得混入繁体字。保持输入字词及顺序，不要再次做简繁转换，也不要改写字形。
5. 输出里不要残留版面换行：接起来的句子直接相连，只在自然段之间空一行（JSON 字符串中写作 \\n\\n）。
6. 按语义分段，每段通常 2 至 5 句；不要把整页压成一段，也不要按 OCR 的行分组分段、逐行成段。
7. 人名、地名、官署名、机构名、部队番号、职务、年号、日期、档案号等专名原样保留，不要把专名拆开。

标点用法（统一使用中文全角标点，标点前后不加英文空格）：
- 句末点号：陈述句用“。”；确实表示疑问才用“？”；确实表示强烈感叹、命令或强烈语气才用“！”。历史叙述默认用“。”。
- 句内点号：一般停顿用“，”；并列的词语或短语用“、”；内部已有逗号的并列分句之间用“；”。
- 冒号：“：”用于解释、总说后的分说、列举，或明确引出直接引语。
- 引号用中文双引号“”，引号内再引用时用单引号‘’；书名号用《》，内层用〈〉。
- 引号、书名号、破折号、括号、省略号只在原文确有对应内容时使用，宁缺毋滥；但句末点号和句内点号（。？！，、；：）属于断句本身，必须逐句给出，不能因为拿不准而省略。
- 不输出 Markdown、项目符号、编号、脚注或编辑说明。

拿不准的时候：
- 不要用“不加标点”来回避判断：字词或句界不确定时，仍按最合理的读法断句并加标点，再把疑点写进 uncertainItems。
- 不确定的专名、句界或引文范围保留原样，不替原文作历史判断，也不把推测写进正文。

返回格式（只能包含这些键；不要输出 title、authors、abstract、keywords、references 等文献信息字段）：
{{
  "punctuatedText": "已完成断句和标点的文本",
  "uncertainItems": ["不确定处"],
  "warnings": ["处理提示"]
}}

文献信息：
{format_metadata(payload.metadata)}
""".strip()

    report = progress_reporter(payload.options, len(content_characters(source_text)))
    try:
        result = call_text_task(prompt, "punctuatedText", "标点", report, extra_keys=("uncertainItems",))
        punctuated_text = normalize_generated_text(result.get("punctuatedText"))
        validate_punctuation_result(source_text, punctuated_text)
        uncertain_items = list_value(result.get("uncertainItems"))
        warnings = list_value(result.get("warnings"))
        response = base_response("punctuate", ready=True)
    except LlmServiceError as exc:
        punctuated_text = ""
        uncertain_items = []
        warnings = [str(exc)]
        response = failure_response("punctuate", exc)

    response.update(
        {
            "documentId": payload.documentId,
            "pageId": payload.pageId,
            "pageNumber": payload.pageNumber,
            "sourceLayer": payload.sourceLayer,
            "sourceText": payload.sourceText,
            "joinedSourceText": source_text,
            "punctuatedText": punctuated_text,
            "uncertainItems": uncertain_items,
            "warnings": warnings,
        }
    )
    return response


@app.post("/llm/finalize-page")
def finalize_page(payload: FinalizePageRequest) -> dict[str, Any]:
    # 只把标点稿和上一页末尾交给模型。OCR 原文、OpenCC 简体稿与各页整页上下文
    # 与标点稿高度重复，全部塞进来会超出模型上下文（实测 4096）被截断，
    # 截断后结果缩水又会触发重试。
    normalized_text = normalize_layout_text(payload.normalizedText or payload.ocrText)
    punctuation_draft = normalize_layout_text(payload.punctuationDraftText)
    source_text = punctuation_draft or normalized_text or normalize_layout_text(payload.ocrText)
    previous_pages = "\n\n".join(
        normalize_layout_text(page.text) for page in payload.previousPages if page.text.strip()
    ) or "无"
    prompt = f"""
/no_think
请把这一页近代军史文献的标点稿整理成可继续人工编辑的正文。

要求：
1. 输入已经完成简体转换、断句和标点；只做轻度整理：修正确有把握的 OCR 错字、漏字、重复字、断行和明显排版噪声，有依据才改，不整段改写、不概括、不翻译、不增补史实。
2. 保留原有标点；只有改字导致句界变化时才调整相关标点，不要退回成无标点，也不要在行尾只补句号。
3. 结果必须使用简体中文，专名、年代、档案号原样保留。
4. 保留自然段：段落之间用两个换行字符（JSON 字符串中写作 \\n\\n），不要按行分组，也不要每句单独成段；输出里不要残留逐行换行。
5. 无法确定的字词保留原样或用 `□` 表示，不在正文中加入解释。
6. 上一页末尾只用于判断本页开头的续句、承接关系和简称，不得把上一页文字重复写入本页。
7. 只输出 JSON，不要输出解释文字。

返回格式（只能包含这些键；不要输出 title、authors、abstract、keywords、references 等文献信息字段）：
{{
  "punctuatedText": "整理后的简体正文",
  "warnings": ["处理提示"]
}}

页码：{payload.pageNumber or ""}
文献信息：
{format_metadata(payload.metadata)}

上一页末尾（仅作上下文）：
{previous_pages}

待整理正文（标点稿）：
{punctuation_draft}
""".strip()

    report = progress_reporter(payload.options, len(content_characters(source_text)))
    try:
        result = call_text_task(prompt, "punctuatedText", "校对", report)
        punctuated_text = normalize_generated_text(result.get("punctuatedText"))
        validate_finalize_result(source_text, punctuated_text)
        warnings = list_value(result.get("warnings"))
        response = base_response("finalize-page", ready=True)
    except LlmServiceError as exc:
        punctuated_text = ""
        warnings = [str(exc)]
        response = failure_response("finalize-page", exc)

    response.update(
        {
            "documentId": payload.documentId,
            "pageId": payload.pageId,
            "pageNumber": payload.pageNumber,
            "normalizedText": normalized_text,
            "punctuationDraftText": punctuation_draft,
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
4. 时间能确定到什么精度就写到什么精度（只有年份写「1936」，能确定月份写「1936年10月」，能确定日期写「1936年10月5日」），不确定的位数不要补全。
5. 输出必须是 JSON，不要输出解释文字。

返回格式：
{{
  "title": "文献名或空",
  "author": "著者或空",
  "year": "出版时间或成书时间（年 / 年月 / 年月日，不确定的位数不补全）或空",
  "publisher": "出版社或出版机构或空",
  "warnings": ["处理提示"]
}}

现有信息：
{format_metadata(payload.metadata)}

待识别文本：
{payload.text}
""".strip()

    try:
        # 元数据结果只是一小段 JSON（约 100 多字），用固定量级做分母，进度才能跟随生成推进；
        # 输入正文再长也不会让百分比停在个位数。
        report = progress_reporter(payload.options, 120)
        result = call_json_task(prompt, on_progress=report)
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
        response = failure_response("extract-metadata", exc)

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


@app.post("/llm/chronicle")
def chronicle(payload: ChronicleRequest) -> dict[str, Any]:
    return run_evidence_task(payload, "chronicle")

@app.post("/llm/chronicle/supplement")
def supplement_chronicle(payload: SupplementChronicleRequest) -> dict[str, Any]:
    prompt = f"""
/no_think
你将得到一份“已有史事编年”和“当前选定文献的完整整理材料”（材料可能与已有编年重叠）。请依据材料与已有编年合并，输出合并后的完整编年。

任务：
1. 保留已有编年的每一条及其来源；除非材料明确显示该条需要修正，否则内容与来源都照旧。
2. 从材料中提取与主题相关的史事，按时间插入。
3. 材料中的史事与已有条目重复时（同一史事或同一日期），合并为一条：sources 中并列多个来源，不重复叙述。
4. 不同来源对同一史事记载冲突时，保留并列来源，并在该条的 conflict 字段写明冲突点；无冲突则 conflict 为空字符串。
5. 只使用输入材料，不引入外部史实。每条必须给出两个时间字段：dateOriginal 原样摘抄材料中的时间表述（不得改写）；dateGregorian 为该时间换算成的公历纪年（农历、年号、干支均换算），格式为 YYYY 或 YYYY-MM 或 YYYY-MM-DD，只能精确到哪一级就写到哪一级；无法确定或换算没把握时 dateGregorian 留空，禁止编造。
6. 每条 sources 必须保留 documentId、attachmentId、sourceType、pageId、pageNumber、author、title、publisher、year、quote。
7. 输出必须是 JSON，不要输出解释文字或 Markdown。

返回格式：
{{
  "entries": [
    {{
      "dateOriginal": "原文时间表述",
      "dateGregorian": "公历纪年，无法确定留空",
      "summary": "客观史事",
      "conflict": "冲突说明或空字符串",
      "sources": [ {{ 与生成编年相同的来源字段 }} ]
    }}
  ],
  "warnings": ["处理提示"]
}}

主题：
{payload.topic}

已有编年：
{json.dumps(payload.previousEntries, ensure_ascii=False)}

当前文献材料：
{json.dumps(payload.documents, ensure_ascii=False)}
""".strip()

    try:
        result = call_json_task(prompt)
        entries, date_warnings = normalize_chronicle_dates(
            normalize_entries(result.get("entries"))
        )
        warnings = list_value(result.get("warnings")) + date_warnings
        response = base_response("chronicle-supplement", ready=True)
    except LlmServiceError as exc:
        entries = []
        warnings = [str(exc)]
        response = failure_response("chronicle-supplement", exc)

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
    return run_evidence_task(payload, "search")

@app.post("/llm/chat")
def chat(payload: ChatRequest) -> dict[str, Any]:
    return run_evidence_task(payload, "chat")

def call_json_task(prompt: str, on_progress: Any = None) -> dict[str, Any]:
    content = call_chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "你是近代军史文献整理助手。你必须忠于原文，只输出合法 JSON，"
                    "不得输出 Markdown，不得输出解释。"
                    "正文文本字段必须保留自然段，段落换行用 \\n\\n 表示，不要把正文压成一个大段。"
                ),
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.1,
        on_progress=on_progress,
    )
    return parse_json_object(content)


def call_text_task(prompt: str, key: str, task: str, on_progress: Any = None,
                   extra_keys: tuple[str, ...] = ()) -> dict[str, Any]:
    """生成类任务要求返回正文键（punctuatedText）。

    模型偶尔会忽略返回格式，例如把论文首页当成文献信息页，返回 title/authors/abstract
    等字段而没有正文。同一个提示词重发往往仍然失败（调度器重试时实测两次都是空正文），
    所以这里用一次带纠正说明的重试代替。
    """
    result = call_json_task(prompt, on_progress=on_progress)
    if isinstance(result.get(key), str) and result[key].strip():
        return result
    allowed = [key, *extra_keys, "warnings"]
    result = call_json_task(f"""{prompt}

上一次输出不符合要求：返回的字段是 {'、'.join(sorted(result)) or '空'}，缺少 "{key}"。
只允许返回一个 JSON 对象，且只能包含 {'、'.join(f'"{name}"' for name in allowed)} 这些键；
不要输出 title、authors、abstract、keywords、references、journal 之类的字段。
"{key}" 必须是上面输入文本的完整整理结果，不能摘要、不能省略、不能只写文献信息。
""", on_progress=on_progress)
    if isinstance(result.get(key), str) and result[key].strip():
        return result
    raise LlmServiceError(
        f"{task}服务返回的 JSON 缺少 {key}（返回字段：{'、'.join(sorted(result)) or '空'}）。"
    )


def call_chat_completion(
    messages: list[dict[str, Any]],
    temperature: float = 0.1,
    json_response: bool = True,
    context_tokens: int | None = None,
    output_tokens: int | None = None,
    on_progress: Any = None,
) -> str:
    if not provider_configured():
        raise LlmServiceError("尚未配置大模型服务（服务端地址 / 模型名）。")

    if LLM_PROVIDER == "ollama":
        return call_ollama_chat_completion(messages, temperature, json_response, context_tokens, output_tokens, on_progress)

    url = f"{LLM_API_BASE.rstrip('/')}/chat/completions"
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if output_tokens is not None:
        payload["max_tokens"] = output_tokens
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
    context_tokens: int | None = None,
    output_tokens: int | None = None,
    on_progress: Any = None,
) -> str:
    base = LLM_API_BASE.rstrip("/")
    ollama_root = base.removesuffix("/v1")
    url = f"{ollama_root}/api/chat"
    payload = {
        "model": LLM_MODEL,
        "messages": normalize_ollama_messages(messages),
        # 有进度回调时用流式，才能按已生成字数回报进度；没有回调保持原样一次拿完。
        "stream": bool(on_progress),
        # 关掉思考链：只对思考型模型有效，非思考模型传 false 同样安全。
        "think": LLM_OLLAMA_THINK,
        "options": {
            "temperature": temperature,
        },
    }
    if context_tokens is not None:
        payload["options"]["num_ctx"] = context_tokens
    if output_tokens is not None:
        payload["options"]["num_predict"] = output_tokens
    if json_response:
        payload["format"] = "json"

    if not on_progress:
        result = request_json("POST", url, payload=payload, timeout=LLM_TIMEOUT_SECONDS)

        try:
            return str(result["message"]["content"])
        except (KeyError, TypeError) as exc:
            raise LlmServiceError("Ollama 返回格式异常。") from exc

    parts: list[str] = []
    generated = 0
    for chunk in iter_ollama_chat_stream(url, payload, LLM_TIMEOUT_SECONDS):
        piece = str((chunk.get("message") or {}).get("content") or "")
        if not piece:
            continue
        parts.append(piece)
        generated += len(piece)
        on_progress(generated, False)
    if not parts:
        raise LlmServiceError("Ollama 返回格式异常。")
    on_progress(generated, True)
    return "".join(parts)


def iter_ollama_chat_stream(url: str, payload: dict[str, Any], timeout: int) -> Iterator[dict[str, Any]]:
    """Ollama /api/chat 的流式响应是逐行 JSON（NDJSON）。"""
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("LLM_API_KEY", "")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            for raw in response:
                line = raw.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(chunk, dict) and chunk.get("error"):
                    raise LlmServiceError(f"大模型流式返回错误：{chunk['error']}")
                if isinstance(chunk, dict):
                    yield chunk
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        cls = LlmServiceUnavailable if exc.code in {429, 502, 503, 504} else LlmServiceError
        raise cls(f"大模型接口请求失败：HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise LlmServiceUnavailable(f"无法连接大模型服务：{exc.reason}") from exc
    except (TimeoutError, socket.timeout) as exc:
        raise LlmServiceUnavailable("大模型请求超时。") from exc
    except OSError as exc:
        raise LlmServiceUnavailable(f"无法连接大模型服务：{exc}") from exc


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
        cls = LlmServiceUnavailable if exc.code in {429, 502, 503, 504} else LlmServiceError
        raise cls(f"大模型接口请求失败：HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise LlmServiceUnavailable(f"无法连接大模型服务：{exc.reason}") from exc
    except (TimeoutError, socket.timeout) as exc:
        raise LlmServiceUnavailable("大模型请求超时。") from exc
    except OSError as exc:
        raise LlmServiceUnavailable(f"无法连接大模型服务：{exc}") from exc
    except UnicodeDecodeError as exc:
        raise LlmServiceError("大模型接口返回的文字编码异常。") from exc

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
            f"出版时间：{metadata.year}",
            f"出版社：{metadata.publisher}",
        ]
    )


def normalize_generated_text(value: Any) -> str:
    """统一模型返回的换行，保留自然段，不改变正文内容。"""
    if not isinstance(value, str):
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    # 少数模型会把 JSON 字符串中的换行再次写成字面量 \n；仅在没有真实换行时恢复。
    if "\n" not in text and "\\n" in text:
        text = text.replace("\\n", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    # 约定只用 \n\n 表示段落分隔：模型若照抄 OCR 版面形成逐行换行（单个 \n），
    # 这里并回同一段，避免正文又变成一行一句。
    text = merge_single_newlines(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def merge_single_newlines(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        left = text[match.start() - 1] if match.start() else ""
        right = text[match.end()] if match.end() < len(text) else ""
        # 两侧都是西文时保留一个空格，中文按版式习惯直接相连。
        if left and right and left.isascii() and right.isascii() and (left.isalnum() or right.isalnum()):
            return " "
        return ""

    return re.sub(r"(?<!\n)\n(?!\n)", replace, text)


def string_value(value: Any) -> str:
    return value if isinstance(value, str) else ""


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


# 本轮没有可用材料时的对话出口：允许模型正常回应寒暄，但不得陈述史料。
# 与 evidence.py 的“只按证据回答”不冲突——这条路径只产出纯文本回答，从不产生引用，
# 也不会进入用材料作答的分支。
DIALOGUE_SYSTEM = (
    "/no_think\n你是近代军史史料书库的助手。本轮没有检索到可用材料。"
    "若用户只是寒暄、致谢或提出与史料无关的请求，用一句话礼貌回应即可。"
    "若用户在询问史料或史实，只说明当前材料不足以确认，并提示先在文献库中选定材料或换个问法；"
    "绝对不得凭记忆陈述任何历史内容、人物、年代、事件或文献信息。"
    "只输出 JSON，不要输出 [1] 之类的引用标记。格式：{\"reply\":\"一句话回应\"}"
)


def dialogue_messages(query: str) -> list[dict[str, Any]]:
    return [{"role": "system", "content": DIALOGUE_SYSTEM}, {"role": "user", "content": query}]


def conversational_reply(query: str, config: BudgetConfig) -> str:
    fallback = "当前材料不足以确认。"
    try:
        content = call_chat_completion(dialogue_messages(query), temperature=0.1, json_response=True,
                                       context_tokens=config.context_tokens, output_tokens=256)
        reply = string_value(parse_json_object(content).get("reply"))
    except (LlmServiceError, ValueError, TypeError):
        return fallback
    # 无材料时不允许出现引用标记，模型若越界就抹掉。
    return re.sub(r"\[\d+\]", "", reply).strip() or fallback


def run_evidence_task(payload, mode: str) -> dict[str, Any]:
    query = getattr(payload, "query", getattr(payload, "prompt", getattr(payload, "topic", "")))
    try:
        evidence = payload.evidence or []
        for item in evidence:
            if not isinstance(item.get("chunkId"), str) or not isinstance(item.get("text"), str):
                raise EvidenceError("证据缺少 chunkId 或原文")
        config = BudgetConfig.from_env()
        budgeted = fit_prompt_budget(query, mode, evidence, payload.options.get("history", []), config)
        if budgeted.evidence:
            content = call_chat_completion(budgeted.messages, temperature=0.1, json_response=True,
                                           context_tokens=config.context_tokens, output_tokens=config.output_tokens)
            checked = validate_result_citations(parse_json_object(content), budgeted.evidence, mode)
        else:
            # 没有材料时不进“按证据作答”分支：搜索/编年返回空列表，对话走寒暄出口。
            checked = validate_result_citations({}, [], mode)
            checked["warnings"].append(NO_RELEVANT_MATERIAL)
            if mode == "chat":
                checked["answer"] = conversational_reply(query, config)
        response = base_response(mode, ready=True)
        response.update(checked)
        response["warnings"] = budgeted.warnings + response.get("warnings", [])
        response["usedEvidence"] = budgeted.evidence
        response["usedHistory"] = budgeted.history
        response["inputTokens"] = budgeted.input_tokens
        response["budgetMethod"] = "tokenizer" if config.tokenizer_path else "utf8UpperBound"
        return response
    except (EvidenceError, ValueError, TypeError) as exc:
        return base_response(mode, ready=False, message=str(exc)) | {"errorKind": "processing", "warnings": [str(exc)]}
    except LlmServiceError as exc:
        return failure_response(mode, exc) | {"warnings": [str(exc)]}
