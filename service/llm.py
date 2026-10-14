from __future__ import annotations

import difflib
import json
import os
import re
import socket
import unicodedata
import urllib.error
import urllib.request
from typing import Any, Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from service.chronology import normalize_chronicle_entries


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
    sourceLayer: Literal["ocr", "clean", "punctuated"] = "clean"


class PreviousPageContext(BaseModel):
    pageNumber: int | None = None
    text: str = ""


class FinalizePageRequest(LlmTaskRequest):
    ocrText: str = ""
    normalizedText: str = ""
    punctuationDraftText: str = ""
    # 兼容旧调用方；新调度器使用 normalizedText / punctuationDraftText。
    cleanText: str = ""
    punctuatedText: str = ""
    previousPages: list[PreviousPageContext] = Field(default_factory=list)


class ExtractMetadataRequest(LlmTaskRequest):
    text: str
    source: Literal["filename", "ocr", "clean", "punctuated"] = "ocr"


class ChronicleRequest(BaseModel):
    topic: str = ""
    documents: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class SupplementChronicleRequest(BaseModel):
    topic: str = ""
    previousEntries: list[dict[str, Any]] = Field(default_factory=list)
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


class LlmServiceUnavailable(LlmServiceError):
    """无法建立连接或探测超时；区别于服务已响应但未就绪。"""


# 用于校验“模型只加了标点”的正文比较：标点与空白都不算正文字符。
COMPARE_IGNORED_CATEGORIES = {"P", "Z"}


def normalize_layout_text(text: str) -> str:
    """清理 OCR 版面文本的空白，但保留逐行、逐列的换行。

    这些换行来自 OCR 版面：竖排古籍一行就是一列，需要抬头（抬格）的字词还会单独成行，
    所以换行本身不代表自然段边界。哪一处换行该删、该留交给大模型按语义判断；代码只做
    空白清理，并把原文里确定的段落分隔（空行）统一成一个空行。
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


@app.post("/llm/punctuate")
def punctuate(payload: PunctuateRequest) -> dict[str, Any]:
    # 逐行、逐列的换行是 OCR 版面信息（抬头字还常单独成行），不能在这里盲目合并，
    # 交给模型按语义判断哪些换行该删、哪些是段落分隔。
    source_text = normalize_layout_text(payload.sourceText)
    prompt = f"""
/no_think
请给下面这一页近代军史文献（多为竖排古籍 OCR 结果）断句，并加上现代汉语标点。

OCR 版面文本（每一行都是版面换行：原书的一列、一行，或为抬头（抬格）而单独排出的字词；不代表句子或自然段的边界；空行代表原文中确定的段落分隔）：
{source_text}

任务：
1. 请对每一处换行做同一个判断——它是不是把同一句话切断了：如果这一行末尾并不是句子结束、下一行仍要接着读，就删掉这处换行，把文字连成一句话、连成一个自然段；只有确实是段落之间，才把换行留作段落分隔。判断依据只有语法和语义，不要看行数、行长、行首空格，也不要因为某个词（如官名、称谓、钦此、圣鉴等）单独成行就特殊处理。
2. 输出里不要残留版面换行：连起来的句子直接相连，段落之间用两个换行字符（JSON 字符串中写作 \\n\\n）表示。
3. 本次唯一允许新增的内容就是标点符号。原文的汉字、数字、字母、专名以及排列顺序必须一字不差地保留：不增字、不删字、不改字、不润色、不概括、不翻译、不补写。
4. 容易犯的错误是“为了不改动原文而一个标点都不加”。加标点正是本次任务，标点不算增删文字；结果里必须逐句给出标点，标点过少视为处理失败。
5. 在按上面规则合并换行的基础上，按语法结构和语义关系判断句界，通读整页后再断句。一句话可以很长，可以跨越原 OCR 的多列、多行。
6. 必须恢复自然段：按语义把整页分成若干自然段，每段通常 2 至 5 句。不要把整页压成一个大段，也不要每句话单独成段。
7. 输入已经由 OpenCC 完成简体转换；不要再次进行简繁转换，不要改写字形。
8. 保留人名、字号、笔名、地名、国名、民族名、朝代名、年号、官署名、机构名、部队番号、职务、日期、档案号和其他专名。不要把专名误拆成多个成分，也不要擅自给不确定的词语加书名号或引号。
9. 标点判断优先依据语法结构、语义关系和原文已有标点，不要仅凭停顿感或现代口语习惯断句。
10. 不能把推测内容直接写入正文；无法可靠判断的字词、句界、引文范围或标点，保持最保守的处理，并将问题简要放入 uncertainItems。

标点原则：
1. 句末点号：陈述句用“。”；确实表示疑问才用“？”；确实表示强烈感叹、命令或强烈语气才用“！”。历史叙述通常使用“。”，不要为了强调而滥用“？！”或“！”。
2. 句内点号：短语或分句之间的一般停顿用“，”；并列的词语或短语用“、”；多个内部已经有逗号的并列分句，用“；”分隔。不要用逗号连接明显已经完整的多个句子。
3. 冒号：下文是解释、总说后的分说、列举，或明确引出直接引语时使用“：”；关系不明确时不要强行添加。引语中已有完整句末点号的，句末点号放在引号内；引语只是句子成分的，点号按整句结构处理。
4. 引号：明确的原话、讲话、文件中的直接引文或需要特别指出的语句，用中文双引号“”；引号内再引用时用单引号‘’。不要把普通词语、所有专名或带有推测性质的内容随意加引号。
5. 书名号：书籍、文章、报刊、文件、条例、地图、汇编等有明确名称的作品或文献，用《》；书名号内再有作品名称时用〈〉。人名、地名、机构名、部队番号、年号本身不用书名号。不能确认某段文字是否为作品名时不要强加。
6. 括号：补充说明、异名、时间说明或编者可确认的必要信息用中文括号（）；不要用括号写入推测、解释性评论或原文没有的史实。
7. 破折号：只在确有转折、解释、补充、声音中断或话题突然转换时使用“——”，不要把普通停顿都写成破折号。
8. 省略号：原文确有省略、话语未完或语意未尽时用“……”；不要用连续三个句点“...”代替，也不要用省略号掩盖无法断定的内容。
9. 连接号和间隔号：只有原文或语义确实需要表示时间、地点、范围、对应关系时才使用合适的中文连接号；外国人名、少数民族人名等原文已有间隔符号时保留其信息。不要为了格式统一改写日期、数字、档案号或军队番号。
10. 其他排版：统一使用中文全角标点，不在标点前后添加英文空格；除原文明确需要外，不使用项目符号、井号、@、斜杠、星号、表情符号等非历史文献整理所需符号。不要输出 Markdown、脚注或编辑说明。原文里 OCR 误识的符号（如“−”）按原样保留，不要自行增删。

处理优先级：先保证原文字符一字不差，再判断句界，最后选择层级合适的标点。引号、书名号、破折号这类复杂符号宁缺毋滥；句末点号和句内停顿点号必须逐句给出，不要通过标点替原文作历史判断。

返回格式：
{{
  "punctuatedText": "已完成断句和标点的文本",
  "uncertainItems": ["不确定处"],
  "warnings": ["处理提示"]
}}

文献信息：
{format_metadata(payload.metadata)}
""".strip()

    try:
        result = call_json_task(prompt)
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
    # 参考层保留 OCR 的逐行版面（抬头另起一行的信息也在这里），只清理空白；
    # 正文的换行由标点结果决定，不要照抄参考层的逐行排版。
    ocr_text = normalize_layout_text(payload.ocrText)
    normalized_text = normalize_layout_text(payload.normalizedText or payload.cleanText or payload.ocrText)
    punctuation_draft = normalize_layout_text(payload.punctuationDraftText or payload.punctuatedText)
    source_text = punctuation_draft or normalized_text or ocr_text
    previous_pages = "\n\n".join(
        f"第 {page.pageNumber or '?'} 页：\n{normalize_layout_text(page.text)}"
        for page in payload.previousPages
        if page.text.strip()
    ) or "无"
    prompt = f"""
/no_think
请将一页近代军史文献 OCR 文本整理成一版可继续人工编辑的正文。

任务：
1. OCR 原始录文仅作为核对底本；输入文本已经由 OpenCC 完成简体转换，并已经完成一次断句和标点。
2. 修正常见 OCR 错字、漏字、重复字、断行和明显排版噪声，但只能依据 OCR 底本、当前页文本和上下文作出有依据的修改。只改确有把握的字词，不要整段改写，也不要把正文写成摘要。
3. 保持简体输出，不要重新进行大范围简繁转换；只有在明确修正 OCR 字符时才修改个别字。
4. 以已有标点文本为基础，只有内容修正导致句界变化时才调整相关标点；输入已经逐句标点，不要退回成整段无标点，也不要在行尾只补句号。
5. 保留原文意思和专名信息，不增补史实。
6. OCR 原始录文和简体文本是版面文本：每一行都是版面换行（原书的一列、一行，或为抬头（抬格）而单独排出的字词），不代表句子或自然段的边界。这些参考层的换行不要照抄成逐行排版，也不要按原版式逆序；正文里只保留自然段分隔，版面换行一律按“是否把同一句话切断”来判断合并或保留。
7. 无法确定的字词保留原样或用 `□` 表示，不在正文中加入解释。
8. 可参考前页整理文本判断本页开头的续句、承接关系、简称和省略信息，但不得把前页文字重复写入本页。
9. 必须保留并恢复自然段：输入已有段落时原样保留；输入没有可靠段落时，按语义分成自然段，每段通常包含 2 至 5 个完整句子。段落之间必须使用两个换行字符（JSON 字符串中写作 \\n\\n），不要把整页压成一个大段，也不要每句话单独成段；输出里不要残留逐行换行。
10. 输出必须是 JSON，不要输出解释文字。

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
{ocr_text}

OpenCC 简体文本：
{normalized_text}

已有标点文本：
{punctuation_draft}

优先处理文本：
{source_text}
""".strip()

    try:
        result = call_json_task(prompt)
        clean_text = normalize_generated_text(result.get("cleanText"))
        punctuated_text = normalize_generated_text(result.get("punctuatedText"))
        validate_finalize_result(source_text, punctuated_text or clean_text)
        warnings = list_value(result.get("warnings"))
        response = base_response("finalize-page", ready=True)
    except LlmServiceError as exc:
        clean_text = ""
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


def format_conversation_history(options: dict[str, Any]) -> str:
    history = options.get("history")
    if not isinstance(history, list):
        return "[]"
    turns = []
    for turn in history:
        if not isinstance(turn, dict) or not isinstance(turn.get("prompt"), str):
            continue
        turns.append({
            "mode": str(turn.get("mode") or "chat"),
            "prompt": turn["prompt"],
            "response": turn.get("payload") if isinstance(turn.get("payload"), dict) else {},
        })
    return json.dumps(turns, ensure_ascii=False)


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

此前对话（用于理解追问、修改要求和已有草稿；历史回答不作为独立史料，涉及史实须依据输入材料核对）：
{format_conversation_history(payload.options)}

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
        response = failure_response("chronicle", exc)

    response.update(
        {
            "topic": payload.topic,
            "entries": entries,
            "warnings": warnings,
        }
    )
    return response


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
5. 只使用输入材料，不引入外部史实；不做历法换算，只按原文和上下文填写 calendarType、year、month、day、eraName、eraYear、lunarMonth、lunarDay、lunarLeap、ganzhiYear，无法确定留空。
6. 每条 sources 必须保留 documentId、attachmentId、sourceType、pageId、pageNumber、author、title、publisher、year、quote。
7. 输出必须是 JSON，不要输出解释文字或 Markdown。

返回格式：
{{
  "entries": [
    {{
      "dateOriginal": "原文时间表述",
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
        entries, chronology_warnings = normalize_chronicle_entries(
            normalize_entries(result.get("entries"))
        )
        warnings = list_value(result.get("warnings")) + chronology_warnings
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

此前对话（用于理解追问、修改要求和已有草稿；历史回答不作为独立史料，涉及史实须依据输入材料核对）：
{format_conversation_history(payload.options)}

query：
{payload.query}

options：
{json.dumps({key: value for key, value in payload.options.items() if key != "history"}, ensure_ascii=False)}

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
        response = failure_response("search", exc)

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

此前对话（用于理解追问、修改要求和已有草稿；历史回答不作为独立史料，涉及史实须依据输入材料核对）：
{format_conversation_history(payload.options)}

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
        response = failure_response("chat", exc)

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
                    "正文文本字段必须保留自然段，段落换行用 \\n\\n 表示，不要把正文压成一个大段。"
                ),
            },
            {"role": "user", "content": prompt},
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
        raise LlmServiceError("尚未配置大模型服务（服务端地址 / 模型名）。")

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
