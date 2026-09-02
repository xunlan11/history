from __future__ import annotations

import html
import io
import posixpath
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from xml.etree import ElementTree


MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_EXTRACTED_CHARS = 60_000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 80 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 2_000

TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl",
    ".xml", ".html", ".htm", ".yaml", ".yml", ".log",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | IMAGE_EXTENSIONS | {
    ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".rtf",
}


class FileExtractionError(ValueError):
    pass


class VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self.hidden_depth += 1
        elif tag in {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self.hidden_depth:
            self.hidden_depth -= 1
        elif tag in {"p", "div", "li", "tr"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden_depth:
            self.parts.append(data)


def extract_file_content(content: bytes, file_name: str, mime_type: str = "") -> dict[str, Any]:
    if not content:
        raise FileExtractionError("上传文件为空")
    if len(content) > MAX_FILE_BYTES:
        raise FileExtractionError("文件超过 25 MB，无法作为快速对话附件处理")

    suffix = Path(file_name or "").suffix.lower()
    normalized_mime = (mime_type or "").lower()
    if suffix not in SUPPORTED_EXTENSIONS and not normalized_mime.startswith("image/"):
        raise FileExtractionError(
            "暂不支持该文件类型；请使用 PDF、DOCX、XLSX、PPTX、ODT、ODS、RTF、"
            "TXT、Markdown、CSV、JSON、HTML 或常见图片格式"
        )

    warnings: list[str] = []
    needs_ocr = False
    kind = "document"

    if suffix in IMAGE_EXTENSIONS or normalized_mime.startswith("image/"):
        text = ""
        kind = "image"
        needs_ocr = True
    elif suffix == ".pdf":
        text, pdf_warnings = extract_pdf(content)
        warnings.extend(pdf_warnings)
        kind = "pdf"
        needs_ocr = not text.strip()
    elif suffix == ".docx":
        text = extract_docx(content)
        kind = "document"
    elif suffix == ".xlsx":
        text = extract_xlsx(content)
        kind = "spreadsheet"
    elif suffix == ".pptx":
        text = extract_pptx(content)
        kind = "presentation"
    elif suffix in {".odt", ".ods"}:
        text = extract_open_document(content, spreadsheet=suffix == ".ods")
        kind = "spreadsheet" if suffix == ".ods" else "document"
    elif suffix == ".rtf":
        text = extract_rtf(content)
        kind = "document"
    else:
        decoded = decode_text(content)
        if suffix in {".html", ".htm"}:
            text = extract_html(decoded)
        elif suffix == ".xml":
            text = extract_xml_text(decoded)
        else:
            text = decoded
        kind = "spreadsheet" if suffix in {".csv", ".tsv"} else "text"

    text = normalize_text(text)
    truncated = len(text) > MAX_EXTRACTED_CHARS
    if truncated:
        text = text[:MAX_EXTRACTED_CHARS].rstrip()
        warnings.append("文件内容较长，当前对话只保留前 60000 个字符")
    if not text and not needs_ocr:
        warnings.append("文件中没有可快速提取的文字")

    return {
        "kind": kind,
        "text": text,
        "needsOcr": needs_ocr,
        "truncated": truncated,
        "warnings": unique_strings(warnings),
    }


def decode_text(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "big5", "utf-16"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def extract_pdf(content: bytes) -> tuple[str, list[str]]:
    try:
        import fitz
    except ImportError as exc:
        raise FileExtractionError("PDF 文字提取组件未安装") from exc

    try:
        document = fitz.open(stream=content, filetype="pdf")
    except Exception as exc:
        raise FileExtractionError("PDF 文件无法读取或已经损坏") from exc

    pages: list[str] = []
    try:
        for index, page in enumerate(document):
            page_text = page.get_text("text").strip()
            if page_text:
                pages.append(f"[第 {index + 1} 页]\n{page_text}")
    finally:
        document.close()

    warnings = [] if pages else ["PDF 没有可直接提取的文字，将尝试 OCR"]
    return "\n\n".join(pages), warnings


def checked_archive(content: bytes) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise FileExtractionError("压缩文档无法读取或已经损坏") from exc

    entries = archive.infolist()
    if len(entries) > MAX_ARCHIVE_ENTRIES:
        archive.close()
        raise FileExtractionError("压缩文档包含过多文件，无法快速处理")
    if sum(entry.file_size for entry in entries) > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
        archive.close()
        raise FileExtractionError("压缩文档解压后过大，无法快速处理")
    return archive


def extract_docx(content: bytes) -> str:
    with checked_archive(content) as archive:
        try:
            root = ElementTree.fromstring(archive.read("word/document.xml"))
        except (KeyError, ElementTree.ParseError) as exc:
            raise FileExtractionError("DOCX 正文无法读取") from exc

    word_ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{word_ns}p"):
        pieces: list[str] = []
        for node in paragraph.iter():
            if node.tag == f"{word_ns}t" and node.text:
                pieces.append(node.text)
            elif node.tag == f"{word_ns}tab":
                pieces.append("\t")
            elif node.tag == f"{word_ns}br":
                pieces.append("\n")
        value = "".join(pieces).strip()
        if value:
            paragraphs.append(value)
    return "\n".join(paragraphs)


def extract_pptx(content: bytes) -> str:
    with checked_archive(content) as archive:
        slide_names = sorted(
            (name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
            key=natural_number,
        )
        slides: list[str] = []
        drawing_text = "{http://schemas.openxmlformats.org/drawingml/2006/main}t"
        for index, name in enumerate(slide_names):
            try:
                root = ElementTree.fromstring(archive.read(name))
            except ElementTree.ParseError:
                continue
            values = [node.text.strip() for node in root.iter(drawing_text) if node.text and node.text.strip()]
            if values:
                slides.append(f"[第 {index + 1} 页]\n" + "\n".join(values))
    return "\n\n".join(slides)


def extract_xlsx(content: bytes) -> str:
    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    with checked_archive(content) as archive:
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall(f"{{{main_ns}}}si"):
                shared_strings.append("".join(node.text or "" for node in item.iter(f"{{{main_ns}}}t")))

        sheet_paths: list[tuple[str, str]] = []
        try:
            workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
            relationships = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            targets = {
                node.attrib.get("Id", ""): node.attrib.get("Target", "")
                for node in relationships.findall(f"{{{package_rel_ns}}}Relationship")
            }
            for index, sheet in enumerate(workbook.findall(f".//{{{main_ns}}}sheet")):
                relation_id = sheet.attrib.get(f"{{{rel_ns}}}id", "")
                target = targets.get(relation_id, f"worksheets/sheet{index + 1}.xml")
                normalized = posixpath.normpath(posixpath.join("xl", target)).lstrip("/")
                sheet_paths.append((sheet.attrib.get("name", f"工作表 {index + 1}"), normalized))
        except (KeyError, ElementTree.ParseError):
            sheet_paths = [
                (f"工作表 {index + 1}", name)
                for index, name in enumerate(sorted(
                    (entry for entry in archive.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", entry)),
                    key=natural_number,
                ))
            ]

        sheets: list[str] = []
        for sheet_name, sheet_path in sheet_paths:
            if sheet_path not in archive.namelist():
                continue
            try:
                root = ElementTree.fromstring(archive.read(sheet_path))
            except ElementTree.ParseError:
                continue
            rows: list[str] = []
            for row in root.findall(f".//{{{main_ns}}}sheetData/{{{main_ns}}}row"):
                values: list[str] = []
                current_column = 0
                for cell in row.findall(f"{{{main_ns}}}c"):
                    column = cell_column_index(cell.attrib.get("r", ""))
                    if column > current_column:
                        values.extend([""] * min(column - current_column, 200))
                    values.append(xlsx_cell_value(cell, main_ns, shared_strings))
                    current_column = max(column + 1, current_column + 1)
                while values and not values[-1]:
                    values.pop()
                if values:
                    rows.append("\t".join(values))
            if rows:
                sheets.append(f"[工作表：{sheet_name}]\n" + "\n".join(rows))
    return "\n\n".join(sheets)


def xlsx_cell_value(cell: ElementTree.Element, namespace: str, shared_strings: list[str]) -> str:
    cell_type = cell.attrib.get("t", "")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{{{namespace}}}t"))
    value_node = cell.find(f"{{{namespace}}}v")
    value = value_node.text if value_node is not None and value_node.text is not None else ""
    if cell_type == "s" and value.isdigit():
        index = int(value)
        return shared_strings[index] if index < len(shared_strings) else value
    if cell_type == "b":
        return "是" if value == "1" else "否"
    return value


def cell_column_index(reference: str) -> int:
    match = re.match(r"([A-Z]+)", reference.upper())
    if not match:
        return 0
    value = 0
    for char in match.group(1):
        value = value * 26 + ord(char) - 64
    return max(0, value - 1)


def extract_open_document(content: bytes, spreadsheet: bool = False) -> str:
    with checked_archive(content) as archive:
        try:
            root = ElementTree.fromstring(archive.read("content.xml"))
        except (KeyError, ElementTree.ParseError) as exc:
            raise FileExtractionError("OpenDocument 正文无法读取") from exc

    text_ns = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
    table_ns = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
    if not spreadsheet:
        return "\n".join(
            "".join(node.itertext()).strip()
            for node in root.iter(f"{text_ns}p")
            if "".join(node.itertext()).strip()
        )

    sheets: list[str] = []
    for index, table in enumerate(root.iter(f"{table_ns}table")):
        name = table.attrib.get(f"{table_ns}name", f"工作表 {index + 1}")
        rows: list[str] = []
        for row in table.iter(f"{table_ns}table-row"):
            values = [" ".join(cell.itertext()).strip() for cell in row.findall(f"{table_ns}table-cell")]
            while values and not values[-1]:
                values.pop()
            if values:
                rows.append("\t".join(values))
        if rows:
            sheets.append(f"[工作表：{name}]\n" + "\n".join(rows))
    return "\n\n".join(sheets)


def extract_html(value: str) -> str:
    parser = VisibleTextParser()
    parser.feed(value)
    return "".join(parser.parts)


def extract_xml_text(value: str) -> str:
    try:
        root = ElementTree.fromstring(value)
    except ElementTree.ParseError:
        return value
    return "\n".join(part.strip() for part in root.itertext() if part.strip())


def extract_rtf(content: bytes) -> str:
    value = decode_text(content)

    def replace_unicode(match: re.Match[str]) -> str:
        number = int(match.group(1))
        return chr(number % 65536)

    def replace_hex(match: re.Match[str]) -> str:
        return bytes.fromhex(match.group(1)).decode("cp1252", errors="replace")

    value = re.sub(r"\\u(-?\d+)\??", replace_unicode, value)
    value = re.sub(r"\\'([0-9a-fA-F]{2})", replace_hex, value)
    value = re.sub(r"\\(?:par|line)\b", "\n", value)
    value = re.sub(r"\\tab\b", "\t", value)
    value = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", value)
    value = value.replace("\\{", "{").replace("\\}", "}").replace("\\\\", "\\")
    return value.replace("{", "").replace("}", "")


def normalize_text(value: str) -> str:
    value = html.unescape(value or "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    value = re.sub(r"[ \t]+\n", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def natural_number(value: str) -> int:
    match = re.search(r"(\d+)", value)
    return int(match.group(1)) if match else 0


def unique_strings(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))
