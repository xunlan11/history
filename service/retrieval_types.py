"""Shared, versioned contracts for retrieval and source anchors."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

CHUNKER_VERSION = "paragraph-v1"
TextPolicy = Literal["primary", "processed", "reader"]


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
    sourceLayer: Literal["ocrText", "punctuatedText", "notes"]
    sourceHash: str


class EvidenceValidationRequest(BaseModel):
    evidence: list[EvidenceLocator] = Field(default_factory=list, max_length=200)


# Evidence is deliberately a JSON object at the HTTP/LLM boundary. All identity
# fields come from Chunk.to_dict(); callers only add current metadata and rank.
