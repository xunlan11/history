"""汉字简繁转换（基于 OpenCC）。

全局复用转换器实例：OpenCC 词典加载昂贵，实例按需惰性创建并缓存。
OpenCC 的 ``convert`` 是只读操作（词典只读、无共享可变状态），
因此同一实例可在多线程间共享，无需加锁。

用法::

    from service.variant import to_simplified, to_traditional, convert

    to_traditional("汉字与后台的头发")   # -> 漢字與後臺的頭髮
    to_simplified("漢字與後臺的頭髮")    # -> 汉字与后台的头发
    convert("汉字", "traditional")       # 按变体名转换

变体名（variant）统一为两种：
- ``"simplified"``  简体（OpenCC ``t2s``，非简即转）
- ``"traditional"`` 繁体（OpenCC ``s2t``，OpenCC 标准繁体）

同时接受常见别名：``s`` / ``hans`` / ``zh-hans`` / ``zh-cn`` → 简体；
``t`` / ``hant`` / ``zh-hant`` / ``zh-tw`` / ``zh-hk`` → 繁体。
"""

from __future__ import annotations

from functools import lru_cache
from typing import Iterable

import opencc

__all__ = [
    "SIMPLIFIED",
    "TRADITIONAL",
    "normalize_variant",
    "convert",
    "convert_many",
    "to_simplified",
    "to_traditional",
]

SIMPLIFIED = "simplified"
TRADITIONAL = "traditional"

# OpenCC 配置：默认使用“标准繁简”（非台湾/香港用词体系）。
# 若将来需要台湾正体/香港繁体，可在此扩展为多套配置。
_CONFIG = {
    SIMPLIFIED: "t2s.json",
    TRADITIONAL: "s2t.json",
}

_ALIASES = {
    SIMPLIFIED: SIMPLIFIED,
    "s": SIMPLIFIED,
    "hans": SIMPLIFIED,
    "zh-hans": SIMPLIFIED,
    "zh-cn": SIMPLIFIED,
    "cn": SIMPLIFIED,
    TRADITIONAL: TRADITIONAL,
    "t": TRADITIONAL,
    "hant": TRADITIONAL,
    "zh-hant": TRADITIONAL,
    "zh-tw": TRADITIONAL,
    "zh-hk": TRADITIONAL,
    "tw": TRADITIONAL,
    "hk": TRADITIONAL,
}


def normalize_variant(variant: str | None) -> str:
    """把各种写法归一为 ``simplified`` / ``traditional``。

    ``None``、空串或未知值一律回退为 ``simplified``（平台默认简体）。
    """
    if not variant:
        return SIMPLIFIED
    key = str(variant).strip().lower()
    return _ALIASES.get(key, SIMPLIFIED)


@lru_cache(maxsize=None)
def _converter(variant: str) -> "opencc.OpenCC":
    """按变体惰性创建并缓存 OpenCC 转换器（进程内单例）。"""
    try:
        config = _CONFIG[variant]
    except KeyError as exc:  # pragma: no cover - 由 normalize_variant 兜底
        raise ValueError(f"unknown variant: {variant!r}") from exc
    return opencc.OpenCC(config)


def convert(text: str | None, variant: str = SIMPLIFIED) -> str:
    """转换单段文本；空值原样返回。"""
    if not text:
        return text or ""
    return _converter(normalize_variant(variant)).convert(text)


def convert_many(texts: Iterable[str | None], variant: str = SIMPLIFIED) -> list[str]:
    """批量转换：复用同一个转换器实例，减少重复查找开销。"""
    converter = _converter(normalize_variant(variant))
    return [converter.convert(t) if t else (t or "") for t in texts]


def to_simplified(text: str | None) -> str:
    return convert(text, SIMPLIFIED)


def to_traditional(text: str | None) -> str:
    return convert(text, TRADITIONAL)
