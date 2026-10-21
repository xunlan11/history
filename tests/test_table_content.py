"""Contract and malformed-input coverage for the independent table parser."""

import json

import pytest

from service.table_content import parse_table_model


def cell(row=0, column=0, text="", rowSpan=1, colSpan=1, header=False):
    return dict(id=f"cell-{row}-{column}", row=row, column=column,
                rowSpan=rowSpan, colSpan=colSpan, text=text, header=header)


def model(rows, columns, cells, borderStyle="unknown"):
    return dict(rows=rows, columns=columns, cells=cells, borderStyle=borderStyle)


def test_structured_cells_are_sorted_and_ids_are_generated():
    value = {"rows": 2, "columns": 2, "borderStyle": "ruled", "cells": [
        {"row": 1, "column": 1, "text": "001"},
        {"row": 0, "column": 0, "text": "heading", "colSpan": 2, "header": True},
        {"row": 1, "column": 0, "text": "", "id": "untrusted"},
    ]}
    expected = model(2, 2, [cell(text="heading", colSpan=2, header=True),
                            cell(1, 0), cell(1, 1, "001")], "ruled")
    assert parse_table_model(value) == expected
    assert parse_table_model(json.dumps(value)) == expected
    assert value["cells"][0]["row"] == 1  # Input is not mutated.


@pytest.mark.parametrize("counts", [
    {"rows": 1, "columns": 1},
    {"rowCount": 1, "columnCount": 1},
    {"row_count": 1, "column_count": 1},
    {"rows": 1, "rowCount": 1, "columns": 1, "columnCount": 1},
    {},
])
def test_count_aliases_and_inferred_dimensions(counts):
    assert parse_table_model({**counts, "cells": [{"row": 0, "column": 0, "text": "x"}]}) == model(
        1, 1, [cell(text="x")])


def test_coordinate_and_span_aliases():
    value = {"row_count": 2, "column_count": 2, "border_style": "borderless", "cells": [
        {"row_index": 0, "column_index": 0, "row_span": 2, "text": "left"},
        {"rowIndex": 0, "columnIndex": 1, "isHeader": True, "text": "top"},
        {"row": 1, "column": 1, "rowspan": 1, "colspan": 1, "text": "bottom"},
    ]}
    assert parse_table_model(value) == model(2, 2, [cell(text="left", rowSpan=2),
        cell(0, 1, "top", header=True), cell(1, 1, "bottom")], "borderless")


@pytest.mark.parametrize("value", [
    [["001", ""], [None, "A < B & C > D"]],
    {"rows": [["001", ""], [None, "A < B & C > D"]]},
    {"rows": [["001", ""], [None, "A < B & C > D"]], "rowCount": 2, "columns": 2},
])
def test_matrix_preserves_leading_zeros_blank_and_literal_cells(value):
    assert parse_table_model(value) == model(2, 2, [cell(text="001"), cell(0, 1),
        cell(1, 0), cell(1, 1, "A < B & C > D")])


def test_matrix_cell_metadata_and_scalar_text():
    assert parse_table_model([[{"text": " heading ", "header": True}, 12, 1.5, True, False]]) == model(
        1, 5, [cell(text=" heading ", header=True), cell(0, 1, "12"), cell(0, 2, "1.5"),
               cell(0, 3, "true"), cell(0, 4, "false")])


def test_structured_text_is_literal_and_not_interpreted_as_html():
    literal = '<b>&amp; 001</b> | \\ " <script>literal</script>'
    assert parse_table_model([[literal]])["cells"][0]["text"] == literal


@pytest.mark.parametrize("value", [
    None, 42, True, 1.2, b"| a |\n| --- |", "", " \n ", [], {}, [[]],
    ["a", "b"], [["a"], ["b", "c"]], [[{"nested": "table"}]],
    [[{"rows": [["nested"]]}]], [[float("nan")]], [[float("inf")]],
    {"rows": [["a"]], "cells": []},
    {"rows": [["a"]], "rowCount": 2},
    {"rows": [["a"]], "columns": 2},
    {"rows": [["a"]], "columns": True},
    {"rows": 0, "columns": 1, "cells": []},
    {"cells": "a"}, {"cells": []}, {"cells": ["a"]},
    {"rows": 2, "rowCount": 1, "cells": [{"row": 0, "column": 0}]},
    {"columns": 2, "columnCount": 1, "cells": [{"row": 0, "column": 0}]},
    {"rows": None, "cells": [{"row": 0, "column": 0}]},
    {"cells": [{"row": 0, "column": 0, "text": {"html": "<table>"}}]},
    {"cells": [{"row": 0, "column": 0, "text": ["nested"]}]},
    {"cells": [{"row": 0, "column": 0, "header": "false"}]},
    {"cells": [{"row": 0, "rowIndex": 1, "column": 0}]},
    {"cells": [{"row": 0, "column": 0, "rowSpan": 1, "rowspan": 2}]},
    {"cells": [{"row": 0, "column": 0}], "borderStyle": "solid"},
    {"cells": [{"row": 0, "column": 0}], "borderStyle": []},
    '[[NaN]]', '[[Infinity]]', '{"rows": [["a"]], "rows": [["b"]]}',
    '{"cells":[{"row":0,"column":0,"row":1}]}',
    '{"rows": [["a"]]} trailing', '{"rows": [["a"]]', '"plain text"',
])
def test_invalid_structured_inputs(value):
    assert parse_table_model(value) is None


@pytest.mark.parametrize("field", ["row", "column", "rowSpan", "colSpan"])
@pytest.mark.parametrize("invalid", [-1, 0.5, True, False, "1", None, [], 20_001])
def test_coordinates_and_spans_require_bounded_integers(field, invalid):
    item = {"row": 0, "column": 0, "text": "a", field: invalid}
    assert parse_table_model({"cells": [item]}) is None


@pytest.mark.parametrize("field", ["rowSpan", "colSpan"])
def test_zero_span_is_invalid(field):
    assert parse_table_model({"cells": [{"row": 0, "column": 0, field: 0}]}) is None


@pytest.mark.parametrize("field", ["rows", "columns", "rowCount", "columnCount"])
@pytest.mark.parametrize("invalid", [0, -1, True, 1.0, "1", None, 20_001])
def test_counts_require_positive_bounded_integers(field, invalid):
    assert parse_table_model({field: invalid, "cells": [{"row": 0, "column": 0}]}) is None


@pytest.mark.parametrize("value", [
    {"rows": 1, "columns": 1, "cells": [{"row": 0, "column": 1}]},
    {"rows": 1, "columns": 1, "cells": [{"row": 0, "column": 0, "rowSpan": 2}]},
    {"rows": 1, "columns": 2, "cells": [{"row": 0, "column": 0}]},
    {"cells": [{"row": 1, "column": 0}]},
    {"cells": [{"row": 0, "column": 0}, {"row": 0, "column": 0}]},
    {"cells": [{"row": 0, "column": 0, "colSpan": 2}, {"row": 0, "column": 1}]},
])
def test_out_of_range_incomplete_and_overlapping_grids_fail(value):
    assert parse_table_model(value) is None


def test_html_sections_spans_entities_and_inline_text():
    value = '''<table border="1"><thead><tr><th colspan="2">A &amp; B</th><th>C</th></tr></thead>
    <tbody><tr><td rowspan="2">001</td><td>&lt;x&gt;&nbsp;&#65;&#x42;</td><td></td></tr>
    <tr><td><b>bold</b><br/>next &quot;line&quot;</td><td>last</td></tr></tbody></table>'''
    assert parse_table_model(value) == model(3, 3, [cell(text="A & B", colSpan=2, header=True),
        cell(0, 2, "C", header=True), cell(1, 0, "001", rowSpan=2),
        cell(1, 1, "<x>\xa0AB"), cell(1, 2), cell(2, 1, 'bold\nnext "line"'),
        cell(2, 2, "last")], "ruled")


def test_html_suppresses_script_and_style_bodies():
    value = '''<html><head><style>body { color: red; } <table>bad</table></style></head><body>
    <script>console.log("raw code");</script><table><tr><td>before<script>evil()</script>
    <style>.secret{display:none}</style>after</td></tr></table></body></html>'''
    result = parse_table_model(value)
    assert result == model(1, 1, [cell(text="before\n    after")])
    assert "evil" not in str(result)
    assert "console" not in str(result)


def test_html_blank_rows_covered_by_rowspans_are_valid():
    assert parse_table_model('<table><tr><td rowspan="2">a</td></tr><tr></tr></table>') == model(
        2, 1, [cell(text="a", rowSpan=2)])


@pytest.mark.parametrize(("attributes", "expected"), [
    ("", "unknown"), ('border="0"', "borderless"), ('border="1"', "ruled"),
    ("border", "ruled"), ('rules="all"', "ruled"),
    ('style="border: none"', "borderless"), ('style="border: 0"', "borderless"),
    ('style="border: 1px solid #000"', "ruled"),
    ('style="border-collapse: collapse"', "unknown"),
])
def test_html_border_evidence(attributes, expected):
    assert parse_table_model(f"<table {attributes}><tr><td>x</td></tr></table>")["borderStyle"] == expected


def test_html_cell_border_is_evidence_of_ruling():
    assert parse_table_model('<table border="0"><tr><td style="border-bottom: 1px solid">x</td></tr></table>')[
        "borderStyle"] == "ruled"


@pytest.mark.parametrize("value", [
    "<table></table>", "<table><tr></tr></table>", "<tr><td>a</td></tr>",
    "<table><td>a</td></table>", "<table><tr><td>a</th></tr></table>",
    "<table><tr><td>a</td></tr>", "<table><tr><td>a</tr></table>",
    "<table><tr><td><b>a</td></tr></table>",
    "<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>",
    "<table><tr><td>a<table><tr><td>nested</td></tr></table></td></tr></table>",
    "<table><tr><td>one</td></tr><tr><td>two</td><td>three</td></tr></table>",
    '<table><tr><td rowspan="2">a</td></tr></table>',
    '<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td colspan="2">c</td></tr></table>',
    '<table><tr><td>a</td><td rowspan="2">b</td></tr><tr><td colspan="2">c</td></tr></table>',
    '<table><tr><td colspan="0">a</td></tr></table>',
    '<table><tr><td rowspan="-1">a</td></tr></table>',
    '<table><tr><td colspan="1.5">a</td></tr></table>',
    '<table><tr><td rowspan="x">a</td></tr></table>',
    '<table><tr><td colspan>a</td></tr></table>',
    '<table><tr><td colspan="1" colspan="2">a</td></tr></table>',
    '<table><tr><td colspan="20001">a</td></tr></table>',
    '<table><tr><td rowspan="200" colspan="200">a</td></tr></table>',
    '<table><tr><td>safe<script>unclosed raw code</td></tr></table>',
    '<table><tr><td>safe<style>unclosed raw code</td></tr></table>',
    '<div>prose</div><table><tr><td>a</td></tr></table>',
    '<table><tr><td>a</td></tr>raw code</table>',
    '<script>raw code</script>', '<style>raw code</style>',
])
def test_invalid_and_unsupported_html(value):
    assert parse_table_model(value) is None


@pytest.mark.parametrize("value", [
    "| Name | Value |\n| --- | :---: |\n| 001 | |",
    "Name | Value\n--- | :---:\n001 | ",
])
def test_markdown_with_and_without_outer_pipes(value):
    assert parse_table_model(value) == model(2, 2, [cell(text="Name", header=True),
        cell(0, 1, "Value", header=True), cell(1, 0, "001"), cell(1, 1)])


def test_markdown_escaped_pipes_and_literal_characters():
    value = r'''| A\|B | C |
| --- | ---: |
| x\|y | 001 & <value> |
| \\ | \| |'''
    assert parse_table_model(value) == model(3, 2, [cell(text="A|B", header=True),
        cell(0, 1, "C", header=True), cell(1, 0, "x|y"), cell(1, 1, "001 & <value>"),
        cell(2, 0, "\\"), cell(2, 1, "|")])


def test_markdown_escaped_final_pipe_is_not_a_boundary():
    assert parse_table_model("a | b\n--- | ---\nx | end\\|")["cells"][-1]["text"] == "end|"


def test_markdown_even_backslashes_before_delimiter():
    value = "a | b\n--- | ---\ntrail\\\\|last"
    assert [item["text"] for item in parse_table_model(value)["cells"][2:]] == ["trail\\", "last"]


def test_markdown_header_only_and_blank_headers():
    assert parse_table_model("| | heading |\n| --- | --- |") == model(1, 2,
        [cell(header=True), cell(0, 1, "heading", header=True)])
    assert parse_table_model("| a |\n| --- |\n| |") == model(2, 1,
        [cell(text="a", header=True), cell(1, 0)])


@pytest.mark.parametrize("value", [
    "a b\nc d", "a\tb\nc\td", "a  b\n---  ---\nc  d", "prose", "a | b",
    "a | b\n-- | ---\nx | y", "a | b\nabc | ---", "a | b\n--- | --- | ---",
    "a | b\n--- | ---\nx", "a | b\n--- | ---\nx | y | z",
    "a | b\n--- | ---\n\nx | y", "a | b\n:--: | ---",
    "| a |\n| :---:: |", "| a |\n| === |", "a\n---\nx",
    "prose\n| a | b |\n| --- | --- |", "|a|b|\n|---|---|\n```",
    "print('a|b')\nprint('c|d')", "| a | b |\n| --- --- | --- |",
])
def test_invalid_markdown_and_no_whitespace_guessing(value):
    assert parse_table_model(value) is None


@pytest.mark.parametrize(("language", "body"), [
    ("json", '{"rows": [["001", ""]]}'),
    ("html", '<table><tr><td>001</td><td></td></tr></table>'),
    ("markdown", '| 001 | |\n| --- | --- |'),
    ("HTML", '<table><tr><td>001</td><td></td></tr></table>'),
])
def test_one_supported_outer_fence(language, body):
    result = parse_table_model(f" \n```{language}\n{body}\n```\n ")
    assert result is not None
    assert result["rows"] == 1 and result["columns"] == 2
    assert [item["text"] for item in result["cells"]] == ["001", ""]


def test_fence_with_crlf():
    assert parse_table_model('```json\r\n[["001"]]\r\n```') == model(1, 1, [cell(text="001")])


@pytest.mark.parametrize("value", [
    '```python\n| a | b |\n| --- | --- |\n```',
    '```\n| a | b |\n| --- | --- |\n```',
    '```json\n[["a"]]', '```json\n[["a"]]\n```\nprose',
    'before\n```json\n[["a"]]\n```',
    '```markdown\n```markdown\n|a|\n|---|\n```\n```',
    '```json\n<table><tr><td>a</td></tr></table>\n```',
    '```html\n|a|\n|---|\n```', '```markdown\n[["a"]]\n```',
    '```json\n{"rows":[["a"]]}\n```\n```json\n[["b"]]\n```',
])
def test_invalid_fences_do_not_leak_code(value):
    assert parse_table_model(value) is None


def test_grid_limit_includes_spanned_slots():
    assert parse_table_model({"rows": 100, "columns": 200, "cells": [
        {"row": 0, "column": 0, "rowSpan": 100, "colSpan": 200, "text": "ok"}
    ]}) == model(100, 200, [cell(text="ok", rowSpan=100, colSpan=200)])
    assert parse_table_model({"cells": [
        {"row": 0, "column": 0, "rowSpan": 101, "colSpan": 200}
    ]}) is None


def test_dense_matrix_cell_limit():
    result = parse_table_model([[""] * 200 for _ in range(100)])
    assert result is not None and len(result["cells"]) == 20_000
    assert parse_table_model([[""] * 200 for _ in range(101)]) is None
    assert parse_table_model([[""]] * 20_001) is None
    assert parse_table_model({"cells": [{"row": 0, "column": 0}] * 20_001}) is None


def test_html_and_markdown_cell_limits():
    assert parse_table_model("<table><tr>" + "<td></td>" * 20_001 + "</tr></table>") is None
    assert parse_table_model("|a|\n|---|\n" + "|x|\n" * 20_000) is None


def test_recursive_or_deep_input_fails_without_raising():
    nested = []
    nested.append(nested)
    assert parse_table_model(nested) is None
    assert parse_table_model("[" * 2000 + "]" * 2000) is None


@pytest.mark.parametrize("value", [
    {"row_count": 1, "col_count": 1, "cells": [{"row_index": 0, "col_index": 0, "text": "001"}]},
    {"rowCount": 1, "colCount": 1, "cells": [{"rowIndex": 0, "colIndex": 0, "text": "001"}]},
    {"cells": [{"row": 0, "col": 0, "text": "001"}]},
])
def test_ocr_column_aliases(value):
    assert parse_table_model(value) == model(1, 1, [cell(text="001")])


@pytest.mark.parametrize("counts", [
    {"rowCount": None}, {"row_count": None}, {"columns": None},
    {"columnCount": None}, {"colCount": None}, {"col_count": None},
    {"rowCount": True}, {"col_count": 0},
])
def test_matrix_counts_cannot_be_null_or_invalid(counts):
    assert parse_table_model({"rows": [["x"]], **counts}) is None


@pytest.mark.parametrize(("style", "border"), [
    ("border: 0 solid black", "borderless"),
    ("border: none black", "borderless"),
    ("border: 0.5px solid black", "ruled"),
    ("border-width: thin", "ruled"),
    ("border-width: 0 0 0 0", "borderless"),
])
def test_css_border_widths(style, border):
    assert parse_table_model(f'<table style="{style}"><tr><td>x</td></tr></table>')["borderStyle"] == border


@pytest.mark.parametrize("suffix", ["<!--", "<?broken"])
def test_incomplete_html_tokens(suffix):
    assert parse_table_model("<table><tr><td>a</td></tr></table>" + suffix) is None


def test_complete_html_comments_and_doctype_are_supported():
    assert parse_table_model('<!DOCTYPE html><!--before--><table><!--inside--><tr><td>x<!--hidden--></td></tr></table><!--after-->') == model(
        1, 1, [cell(text="x")])


def test_markdown_blank_header_without_outer_pipes():
    assert parse_table_model("Name |\n--- | ---\n001 |") == model(2, 2, [
        cell(text="Name", header=True), cell(0, 1, header=True), cell(1, 0, "001"), cell(1, 1)])


def test_markdown_explicit_boundaries_do_not_pad_a_short_row():
    assert parse_table_model("| a | b |\n| --- | --- |\n| x |") is None

@pytest.mark.parametrize("content", [
    "<img src='formula.png' alt='formula'>",
    "<span>prefix<img src='formula.png' alt='formula'></span>",
    "<IMG SRC='formula.png' ALT='formula'/>",
    "<svg><text>formula</text></svg>",
    "<svg/>",
    "<svg:svg><svg:text>formula</svg:text></svg:svg>",
    "<math><mi>x</mi></math>",
    "<m:math><m:mi>x</m:mi></m:math>",
    "<object data='formula.svg'>fallback text</object>",
    "<embed src='formula.svg'>",
    "<iframe src='formula.html'>fallback text</iframe>",
    "<canvas>fallback text</canvas>",
    "<picture><source srcset='formula.svg'></picture>",
    "<audio src='formula.wav'>fallback text</audio>",
    "<video src='formula.mp4'>fallback text</video>",
    "<input value='formula'>",
    "<select><option>formula</option></select>",
    "<textarea>formula</textarea>",
    "<button value='formula'>formula</button>",
    "<meter value='0.5'>half</meter>",
    "<progress value='50' max='100'>half</progress>",
])
@pytest.mark.parametrize("surrounding_text", ["{}", "before {} after"])
def test_html_content_that_cannot_be_represented_as_text_requires_fallback(content, surrounding_text):
    value = "<table><tr><td>" + surrounding_text.format(content) + "</td></tr></table>"
    assert parse_table_model(value) is None


def test_html_literal_image_markup_and_suppressed_script_do_not_trigger_fallback():
    value = """<table><tr><td>&lt;img src='formula.png'&gt;
    <script>const image = "<img src='formula.png'>";</script></td></tr></table>"""
    assert parse_table_model(value) == model(1, 1, [cell(text="<img src='formula.png'>")])


@pytest.mark.parametrize("header", [
    "[Label](target)", "{Unit}", '["Label"]', '{"Unit": 1}', '{"Unit": 1, "Unit": 2}',
])
@pytest.mark.parametrize("fence", [None, "markdown", "json"])
def test_markdown_json_like_prefixes_fall_back_only_without_a_json_fence(header, fence):
    value = header + " | Count\n---|---\n001|2"
    if fence:
        value = f"```{fence}\n{value}\n```"
    if fence == "json":
        assert parse_table_model(value) is None
    else:
        assert parse_table_model(value) == model(2, 2, [
            cell(text=header, header=True), cell(0, 1, "Count", header=True),
            cell(1, 0, "001"), cell(1, 1, "2"),
        ])
