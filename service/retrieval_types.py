"""Shared, versioned contracts for retrieval and source anchors."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Literal
from urllib.parse import quote, unquote

from pydantic import BaseModel, Field, field_validator, model_validator

CHUNKER_VERSION = "paragraph-v1"
TextPolicy = Literal["primary", "processed", "reader"]


VISUAL_SOURCE_KINDS = ("visual_caption", "table_cell")


def visual_source_layer(kind: str, visual_id: str, item_id: str) -> str:
    """Encode both IDs independently so punctuation cannot alias another source."""
    if kind not in VISUAL_SOURCE_KINDS or not visual_id or not item_id:
        raise ValueError("Invalid visual source identity")
    return f"{kind}:{quote(visual_id, safe='')}:{quote(item_id, safe='')}"


def parse_visual_source_layer(layer: str) -> dict[str, str] | None:
    parts = layer.split(":")
    if len(parts) != 3 or parts[0] not in VISUAL_SOURCE_KINDS:
        return None
    try:
        visual_id, item_id = (unquote(part, errors="strict") for part in parts[1:])
        if visual_source_layer(parts[0], visual_id, item_id) != layer:
            return None
    except (ValueError, UnicodeError):
        return None
    key = "captionId" if parts[0] == "visual_caption" else "cellId"
    return {"visualId": visual_id, key: item_id}


@dataclass(frozen=True)
class SourceText:
    documentId: str
    pageId: str
    sourceLayer: str
    text: str
    sourceHash: str


@dataclass(frozen=True)
class Chunk:
    chunkId: str
    documentId: str
    pageId: str
    sourceLayer: str
    sourceHash: str
    start: int
    end: int
    text: str
    ordinal: int

    def to_dict(self) -> dict:
        return asdict(self)


class AttachmentSource(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    fileName: str = ""
    extractedText: str = Field(max_length=60000)


class RetrievalRequest(BaseModel):
    query: str = Field(max_length=2000)
    mode: Literal["search", "chat", "chronicle", "reader"] = "search"
    documentIds: list[str] | None = Field(default=None, max_length=1000)
    textPolicy: TextPolicy = "primary"
    attachments: list[AttachmentSource] = Field(default_factory=list, max_length=12)
    limit: int | None = Field(default=None, ge=1, le=40)

    @model_validator(mode="after")
    def reader_scope(self):
        if self.mode == "reader":
            if not self.documentIds or len(self.documentIds) != 1 or not self.documentIds[0].strip():
                raise ValueError("文内检索必须限定一篇文献")
            self.textPolicy = "reader"
        return self

    @field_validator("query")
    @classmethod
    def nonempty_query(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("检索问题不能为空")
        return value.strip()


class EvidenceLocator(BaseModel):
    chunkId: str
    documentId: str
    pageId: str
    sourceLayer: str
    sourceHash: str

    @field_validator("sourceLayer")
    @classmethod
    def known_source_layer(cls, value: str) -> str:
        if value not in {"ocrText", "punctuatedText", "notes"} and parse_visual_source_layer(value) is None:
            raise ValueError("Unknown or malformed source layer")
        return value


class EvidenceValidationRequest(BaseModel):
    evidence: list[EvidenceLocator] = Field(default_factory=list, max_length=200)


# 证据在 HTTP/LLM 边界上刻意使用 JSON 对象：标识字段全部来自 Chunk.to_dict()，
# 调用方只补充当前元数据与排序信息。
