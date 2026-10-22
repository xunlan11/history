"""Parse explicit OCR tables into a bounded, plain-text table model.

Coordinates are zero based. A model must cover its complete rectangular grid,
including blank cells, without overlap. No whitespace-table inference is used.
"""

from __future__ import annotations

import json
import math
import re
from html.parser import HTMLParser
from typing import Any


_MAX_CELLS = 20_000
_STYLES = {"unknown", "ruled", "borderless"}
_MISSING = object()


class _InvalidTable(ValueError):
    pass


def _field(value: dict, *names: str, default: Any = _MISSING) -> Any:
    found = [value[name] for name in names if name in value]
    if not found:
        if default is _MISSING:
            raise _InvalidTable("Missing field")
        return default
    if any(type(item) is not type(found[0]) or item != found[0] for item in found[1:]):
        raise _InvalidTable("Conflicting aliases")
    return found[0]


def _integer(value: Any, minimum: int = 0) -> int:
    if type(value) is not int or not minimum <= value <= _MAX_CELLS:
        raise _InvalidTable("Invalid coordinate or dimension")
    return value


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int or (type(value) is float and math.isfinite(value)):
        return str(value)
    raise _InvalidTable("Cell text must be scalar")


def _cell(row: int, column: int, text: Any, row_span: int = 1,
          col_span: int = 1, header: bool = False) -> dict:
    if type(header) is not bool:
        raise _InvalidTable("Invalid header flag")
    return {
        "id": f"cell-{row}-{column}",
        "row": _integer(row),
        "column": _integer(column),
        "rowSpan": _integer(row_span, 1),
        "colSpan": _integer(col_span, 1),
        "text": _text(text),
        "header": header,
    }


def _model(cells: list[dict], rows: int | None = None,
           columns: int | None = None, border: str = "unknown") -> dict:
    if not cells or len(cells) > _MAX_CELLS:
        raise _InvalidTable("Invalid number of cells")
    if not isinstance(border, str) or border not in _STYLES:
        raise _InvalidTable("Invalid border style")
    if rows is None:
        rows = max(cell["row"] + cell["rowSpan"] for cell in cells)
    if columns is None:
        columns = max(cell["column"] + cell["colSpan"] for cell in cells)
    rows, columns = _integer(rows, 1), _integer(columns, 1)
    if rows * columns > _MAX_CELLS:
        raise _InvalidTable("Grid is too large")
    occupied: set[tuple[int, int]] = set()
    for cell in cells:
        end_row = cell["row"] + cell["rowSpan"]
        end_column = cell["column"] + cell["colSpan"]
        if end_row > rows or end_column > columns:
            raise _InvalidTable("Cell extends past table")
        for row in range(cell["row"], end_row):
            for column in range(cell["column"], end_column):
                if (row, column) in occupied:
                    raise _InvalidTable("Overlapping cells")
                occupied.add((row, column))
    if len(occupied) != rows * columns:
        raise _InvalidTable("Incomplete grid")
    return {
        "rows": rows,
        "columns": columns,
        "cells": sorted(cells, key=lambda cell: (cell["row"], cell["column"])),
        "borderStyle": border,
    }


def _matrix(value: Any, border: str = "unknown", rows: int | None = None,
            columns: int | None = None) -> dict:
    if not isinstance(value, list) or not value or len(value) > _MAX_CELLS:
        raise _InvalidTable("Expected nonempty rows")
    if not isinstance(value[0], list) or not value[0]:
        raise _InvalidTable("Expected nonempty columns")
    width = len(value[0])
    if len(value) * width > _MAX_CELLS:
        raise _InvalidTable("Grid is too large")
    if rows is not None and _integer(rows, 1) != len(value):
        raise _InvalidTable("Row count mismatch")
    if columns is not None and _integer(columns, 1) != width:
        raise _InvalidTable("Column count mismatch")
    cells = []
    for row, items in enumerate(value):
        if not isinstance(items, list) or len(items) != width:
            raise _InvalidTable("Ragged rows")
        for column, item in enumerate(items):
            if isinstance(item, dict):
                # 矩阵单元格可带 text/header，但不能嵌套模型对象。
                if set(item) - {"text", "header"} or "text" not in item:
                    raise _InvalidTable("Unsupported matrix cell")
                cells.append(_cell(row, column, item["text"], header=item.get("header", False)))
            else:
                cells.append(_cell(row, column, item))
    return _model(cells, len(value), width, border)


def _structured(value: Any) -> dict:
    if isinstance(value, list):
        return _matrix(value)
    if not isinstance(value, dict):
        raise _InvalidTable("Expected table object")
    border = _field(value, "borderStyle", "border_style", default="unknown")
    raw_rows = value.get("rows")
    row_count = _field(value, "rowCount", "row_count", default=None)
    column_count = _field(value, "columns", "columnCount", "column_count", "colCount", "col_count", default=None)
    if isinstance(raw_rows, list):
        for name in ("rowCount", "row_count", "columns", "columnCount", "column_count", "colCount", "col_count"):
            if name in value:
                _integer(value[name], 1)
        if "cells" in value:
            raise _InvalidTable("Ambiguous table representation")
        return _matrix(raw_rows, border, row_count, column_count)
    row_count = _field(value, "rows", "rowCount", "row_count", default=None)
    # 显式 null 的计数不等于省略计数。
    for name in ("rows", "rowCount", "row_count", "columns", "columnCount", "column_count", "colCount", "col_count"):
        if name in value:
            _integer(value[name], 1)
    raw_cells = value.get("cells")
    if not isinstance(raw_cells, list) or not 0 < len(raw_cells) <= _MAX_CELLS:
        raise _InvalidTable("Expected cells")
    cells = []
    for item in raw_cells:
        if not isinstance(item, dict):
            raise _InvalidTable("Expected cell object")
        cells.append(_cell(
            _field(item, "row", "rowIndex", "row_index"),
            _field(item, "column", "columnIndex", "column_index", "col", "colIndex", "col_index"),
            _field(item, "text", default=""),
            _field(item, "rowSpan", "rowspan", "row_span", default=1),
            _field(item, "colSpan", "colspan", "col_span", default=1),
            _field(item, "header", "isHeader", default=False),
        ))
    return _model(cells, row_count, column_count, border)


def _json_object(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise _InvalidTable("Duplicate JSON key")
        result[key] = value
    return result


def _html_integer(value: str | None) -> int:
    if value is None or not re.fullmatch(r"[0-9]+", value.strip()):
        raise _InvalidTable("Invalid HTML span")
    return _integer(int(value.strip()), 1)


class _TableHTMLParser(HTMLParser):
    _VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input",
             "link", "meta", "param", "source", "track", "wbr"}
    _SECTIONS = {"thead", "tbody", "tfoot"}
    # 展平这些元素会丢失渲染内容或控件值。
    _UNSUPPORTED_CONTENT = {
        "img", "image", "svg", "math", "object", "embed", "iframe", "canvas",
        "picture", "audio", "video", "applet", "frame", "frameset", "portal",
        "source", "track", "param", "area", "map", "input", "select", "textarea",
        "button", "meter", "progress",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.seen = False
        self.in_table = False
        self.suppressed: str | None = None
        self.cells: list[dict] = []
        self.occupied: set[tuple[int, int]] = set()
        self.row = -1
        self.column = 0
        self.current: dict | None = None
        self.parts: list[str] = []
        self.border = "unknown"

    def _border(self, attrs: dict[str, str | None]) -> None:
        hints = []
        if "border" in attrs:
            value = (attrs["border"] or "").strip()
            if not value or re.fullmatch(r"[0-9]+", value):
                hints.append("borderless" if value and int(value) == 0 else "ruled")
        if attrs.get("rules", "") in {"all", "rows", "cols", "groups"}:
            hints.append("ruled")
        for declaration in (attrs.get("style") or "").lower().split(";"):
            name, separator, value = declaration.partition(":")
            name, value = name.strip(), value.strip()
            if separator and re.fullmatch(r"border(?:-(?:top|right|bottom|left))?(?:-width|-style)?", name):
                tokens = value.split()
                zero_width = lambda token: bool(re.fullmatch(r"0(?:\.0+)?(?:px|pt|em|rem|%)?", token))
                if any(token in {"none", "hidden"} for token in tokens) or (
                    tokens and (all(zero_width(token) for token in tokens) or
                                (name in {"border", "border-top", "border-right", "border-bottom", "border-left"}
                                 and zero_width(tokens[0])))
                ):
                    hints.append("borderless")
                elif any(token in {"solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset",
                                   "thin", "medium", "thick"} for token in tokens) or any(
                    re.fullmatch(r"[0-9]+(?:\.[0-9]+)?(?:px|pt|em|rem)?", token) and not zero_width(token)
                    for token in tokens
                ):
                    hints.append("ruled")
        if "ruled" in hints:
            self.border = "ruled"
        elif "borderless" in hints and self.border == "unknown":
            self.border = "borderless"

    def handle_starttag(self, tag: str, attributes: list[tuple[str, str | None]]) -> None:
        if self.suppressed:
            return
        if tag in {"script", "style"}:
            self.suppressed = tag
            return
        if tag.rsplit(":", 1)[-1] in self._UNSUPPORTED_CONTENT:
            raise _InvalidTable("HTML content requires image fallback")
        attrs = dict(attributes)
        if len(attrs) != len(attributes):
            raise _InvalidTable("Duplicate HTML attribute")
        parent = self.stack[-1] if self.stack else None
        if tag == "table":
            if self.seen or self.in_table:
                raise _InvalidTable("Multiple or nested tables")
            self.seen = self.in_table = True
            self._border(attrs)
        elif tag in self._SECTIONS:
            if parent != "table":
                raise _InvalidTable("Invalid table section")
        elif tag == "tr":
            if parent not in {"table", *self._SECTIONS}:
                raise _InvalidTable("Invalid table row")
            self.row += 1
            _integer(self.row)
            self.column = 0
        elif tag in {"td", "th"}:
            if parent != "tr":
                raise _InvalidTable("Invalid table cell")
            while (self.row, self.column) in self.occupied:
                self.column += 1
            self.current = _cell(self.row, self.column, "",
                                 _html_integer(attrs["rowspan"]) if "rowspan" in attrs else 1,
                                 _html_integer(attrs["colspan"]) if "colspan" in attrs else 1,
                                 tag == "th")
            self.parts = []
            end_row = self.row + self.current["rowSpan"]
            end_column = self.column + self.current["colSpan"]
            if end_row > _MAX_CELLS or end_column > _MAX_CELLS or end_row * end_column > _MAX_CELLS:
                raise _InvalidTable("Grid is too large")
            for row in range(self.row, end_row):
                for column in range(self.column, end_column):
                    if (row, column) in self.occupied:
                        raise _InvalidTable("Overlapping HTML cells")
                    self.occupied.add((row, column))
                    if len(self.occupied) > _MAX_CELLS:
                        raise _InvalidTable("Grid is too large")
            self._border(attrs)
        elif self.current is not None:
            if tag == "br":
                self.parts.append("\n")
        elif tag in {"colgroup", "col"}:
            if parent not in {"table", "colgroup"}:
                raise _InvalidTable("Invalid column group")
        elif tag not in {"html", "head", "body", "meta", "link"} or self.in_table:
            raise _InvalidTable("Unsupported HTML outside a cell")
        if tag not in self._VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if self.suppressed:
            if tag == self.suppressed:
                self.suppressed = None
            return
        if not self.stack or self.stack[-1] != tag:
            raise _InvalidTable("Unbalanced HTML")
        self.stack.pop()
        if tag in {"td", "th"}:
            if self.current is None:
                raise _InvalidTable("Unexpected cell close")
            self.current["text"] = "".join(self.parts).strip(" \t\r\n")
            self.cells.append(self.current)
            self.current = None
        elif tag == "table":
            self.in_table = False

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in self._VOID:
            self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self.suppressed:
            return
        if self.current is not None:
            self.parts.append(data)
        elif data.strip():
            raise _InvalidTable("Text outside table cells")

    def result(self) -> dict:
        if self.rawdata:
            raise _InvalidTable("Incomplete HTML token")
        self.close()
        if self.stack or self.suppressed or self.in_table or not self.seen:
            raise _InvalidTable("Incomplete HTML table")
        return _model(self.cells, rows=self.row + 1, border=self.border)


def _markdown_row(line: str, columns: int | None = None) -> list[str]:
    cells, current = [], []
    index, pipes = 0, 0
    while index < len(line):
        char = line[index]
        if char == "\\" and index + 1 < len(line) and line[index + 1] in {"\\", "|"}:
            current.append(line[index + 1])
            index += 2
            continue
        if char == "|":
            cells.append("".join(current).strip())
            current = []
            pipes += 1
        else:
            current.append(char)
        index += 1
    cells.append("".join(current).strip())
    if not pipes:
        raise _InvalidTable("Expected pipe table")
    leading_pipe = line.startswith("|")
    if leading_pipe:
        cells.pop(0)
    # 转义的结尾竖线属于单元格内容，不是边界。
    trailing_slashes = len(line[:-1]) - len(line[:-1].rstrip("\\")) if line.endswith("|") else 0
    if line.endswith("|") and trailing_slashes % 2 == 0:
        if leading_pipe or columns is None or len(cells) > columns:
            cells.pop()
    if not cells:
        raise _InvalidTable("Empty pipe row")
    return cells


def _markdown(value: str) -> dict:
    lines = value.splitlines()
    if len(lines) < 2 or len(lines) - 1 > _MAX_CELLS:
        raise _InvalidTable("Expected Markdown table")
    separator = _markdown_row(lines[1].strip())
    header = _markdown_row(lines[0].strip(), len(separator))
    if len(header) != len(separator) or any(not re.fullmatch(r":?-{3,}:?", item) for item in separator):
        raise _InvalidTable("Invalid Markdown separator")
    if (len(lines) - 1) * len(header) > _MAX_CELLS:
        raise _InvalidTable("Grid is too large")
    rows = [header] + [_markdown_row(line.strip(), len(header)) for line in lines[2:]]
    model = _matrix(rows)
    for cell in model["cells"]:
        cell["header"] = cell["row"] == 0
    return model


def parse_table_model(value: Any) -> dict | None:
    """Return a validated table, or ``None`` for invalid/unsupported content.

    Accept a structured object (cells or two-dimensional rows), its JSON
    encoding, one complete HTML table, or a Markdown pipe table. A string may
    have one outer html/markdown/json code fence. Returned text is literal;
    consumers must use text nodes or escape it when generating HTML.
    """
    try:
        if isinstance(value, (dict, list)):
            return _structured(value)
        if not isinstance(value, str):
            return None
        value = value.strip()
        language = None
        if value.startswith("```"):
            fenced = re.fullmatch(r"```(html|markdown|json)[ \t]*\r?\n(.*?)\r?\n```", value,
                                  flags=re.DOTALL | re.IGNORECASE)
            if not fenced:
                return None
            language, value = fenced.group(1).lower(), fenced.group(2).strip()
            if re.search(r"(?m)^\s*```", value):
                return None
        if not value:
            return None
        if language == "json" or (language is None and value[0] in "{["):
            try:
                parsed = json.loads(value, object_pairs_hook=_json_object)
            except ValueError:
                if language == "json":
                    raise
                # 无围栏的 Markdown 表头可能以链接或花括号开头。
            else:
                return _structured(parsed)
        if language == "html" or (language is None and value.startswith("<")):
            parser = _TableHTMLParser()
            parser.feed(value)
            return parser.result()
        return _markdown(value)
    except (ValueError, TypeError, RecursionError, OverflowError):
        return None
