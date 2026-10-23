import base64
import io
import json
import sqlite3
from contextlib import contextmanager

import pytest
from PIL import Image
from fastapi.testclient import TestClient
from service import reader_content as content
from service import data, reader_index, ocr_upstream


def result():
    return {"width": 100, "height": 100, "coordinateSpace": "input", "blocks": [
        {"type": "text", "text": "前段如图三所示。", "order": 1},
        {"type": "figure", "text": "", "bbox": [10, 10, 45, 50], "order": 2},
        {"type": "figure_title", "text": "图三 部署图", "bbox": [10, 50, 45, 60], "order": 3},
        {"type": "text", "text": "后段文字。", "order": 4},
        {"type": "table_title", "text": "表一 人数", "bbox": [50, 5, 95, 10], "order": 5},
        {"type": "table", "text": "|部队|人数|\n|---|---|\n|甲|001|", "bbox": [50, 10, 95, 60], "order": 6},
    ]}


def page_for(raw):
    visuals, blocks = content.extract_visuals(raw)
    text = content.body_text(raw)
    return {"id": "p", "pageNumber": 1, "visuals": visuals, "visualsExtracted": True,
            "ocrText": text, "punctuatedText": text, "processingRevision": 3}, {"contentBlocks": blocks, "contentSourceText": text}


def test_captions_and_table_are_not_body_and_preserve_reference():
    page, _ = page_for(result())
    assert page["ocrText"] == "前段如图三所示。\n后段文字。"
    assert len(page["visuals"]) == 2
    figure, table = page["visuals"]
    assert figure["captions"][0]["text"] == "图三 部署图"
    assert figure["captions"][0]["position"] == "after"
    assert table["captions"][0]["position"] == "before"
    assert table["renderMode"] == "image"
    assert "tableModel" not in table


def test_ordered_projection_retains_all_body_after_punctuation_and_variant():
    page, layout = page_for(result())
    page["punctuatedText"] = "前段，如圖三所示。\n後段文字。"
    payload = content.build_reader_content(layout, page)
    assert [i["type"] for i in payload["items"]] == ["text", "visual", "text", "visual"]
    assert payload["items"][1]["placement"] == "aligned"
    assert "".join(payload["displayedText"].encode("utf-16-le")[i["start"]*2:i["end"]*2].decode("utf-16-le") for i in payload["items"] if i["type"] == "text") == page["punctuatedText"]


def test_utf16_ranges_and_image_only_page():
    page, layout = page_for({"blocks": [{"type": "text", "text": "甲😀。", "order": 1}, {"type": "figure", "order": 2}]})
    payload = content.build_reader_content(layout, page)
    assert payload["items"][0] == {"type": "text", "start": 0, "end": 4}
    page, layout = page_for({"blocks": [{"type": "figure", "order": 1}, {"type": "figure", "order": 2}]})
    assert len(content.build_reader_content(layout, page)["items"]) == 2


def test_ambiguous_caption_is_preserved_outside_body():
    raw = {"blocks": [{"type": "figure", "order": 1}, {"type": "figure_title", "text": "同名图", "order": 2}, {"type": "figure", "order": 3}]}
    page, _ = page_for(raw)
    assert page["ocrText"] == ""
    assert [v["kind"] for v in page["visuals"]] == ["figure", "caption", "figure"]
    assert page["visuals"][1]["captions"][0]["associationStatus"] == "unassigned"


def test_bilingual_titles_attach_to_their_own_chart_by_geometry():
    raw = {"width": 100, "height": 100, "coordinateSpace": "input", "blocks": [
        {"type": "text", "text": "正文一。", "order": 1},
        {"type": "figure", "text": "", "bbox": [50, 5, 95, 35], "order": 2},
        {"type": "figure_title", "text": "图1 示意图", "bbox": [52, 36, 93, 40], "order": 3},
        {"type": "figure_title", "text": "Fig.1 Diagram", "bbox": [52, 41, 93, 45], "order": 4},
        {"type": "figure_title", "text": "表1 样本统计", "bbox": [52, 49, 93, 53], "order": 5},
        {"type": "figure_title", "text": "Table 1 Statistics", "bbox": [52, 54, 93, 58], "order": 6},
        {"type": "table", "text": "|甲|乙|\n|---|---|\n|1|2|", "bbox": [50, 59, 95, 95], "order": 7},
    ]}
    page, _ = page_for(raw)
    assert [v["kind"] for v in page["visuals"]] == ["figure", "table"]
    figure, table = page["visuals"]
    assert [c["text"] for c in figure["captions"]] == ["图1 示意图", "Fig.1 Diagram"]
    assert [c["text"] for c in table["captions"]] == ["表1 样本统计", "Table 1 Statistics"]
    assert [c["position"] for c in table["captions"]] == ["before", "before"]


def test_caption_below_figure_ignores_text_in_other_column():
    raw = {"width": 100, "height": 100, "coordinateSpace": "input", "blocks": [
        {"type": "figure", "text": "", "bbox": [5, 5, 45, 50], "order": 1},
        {"type": "title", "text": "2.1 模型", "bbox": [5, 80, 30, 84], "order": 2},
        {"type": "figure_title", "text": "图2 效果", "bbox": [10, 52, 40, 56], "order": 3},
        {"type": "text", "text": "另一栏正文。", "bbox": [55, 5, 95, 60], "order": 4},
    ]}
    page, _ = page_for(raw)
    assert [v["kind"] for v in page["visuals"]] == ["figure"]
    assert page["visuals"][0]["captions"][0]["text"] == "图2 效果"


def test_note_between_figure_and_title_does_not_block_attachment():
    raw = {"width": 100, "height": 100, "coordinateSpace": "input", "blocks": [
        {"type": "figure", "text": "", "bbox": [5, 5, 45, 50], "order": 1},
        {"type": "figure_title", "text": "注：a 表示 b。", "bbox": [5, 51, 45, 70], "order": 2},
        {"type": "formula", "text": "X=1", "bbox": [55, 51, 95, 60], "order": 3},
        {"type": "figure_title", "text": "图4 结构", "bbox": [10, 71, 40, 75], "order": 4},
    ]}
    page, _ = page_for(raw)
    assert [v["kind"] for v in page["visuals"]] == ["figure"]
    assert [c["text"] for c in page["visuals"][0]["captions"]] == ["注：a 表示 b。", "图4 结构"]


def test_visual_crops_are_independent_and_unknown_space_is_not_guessed(tmp_path):
    path = tmp_path / "page.png"
    Image.new("RGB", (100,100), "white").save(path)
    raw = result()
    raw["visuals"], _ = content.extract_visuals(raw)
    content.materialize_visual_images(raw, path)
    figure = raw["visuals"][0]
    assert figure["sourceImageHash"]
    image = Image.open(io.BytesIO(base64.b64decode(figure["imageDataUrl"].split(",")[1])))
    assert image.size == (35, 40)
    raw["coordinateSpace"] = "processed"
    raw["visuals"], _ = content.extract_visuals(raw)
    content.materialize_visual_images(raw, path)
    assert raw["visuals"][0]["geometryStatus"] == "unavailable"
    assert raw["visuals"][0]["status"] == "missing"


@pytest.mark.parametrize("stored_mode", ["image", "structured"])
def test_catalog_includes_new_and_historical_tables_all_pages(stored_mode):
    page, _ = page_for(result())
    # 历史保存的结构化表格不迁移，目录及阅读器继续支持它们。
    page["visuals"][1]["renderMode"] = stored_mode
    second = dict(page, id="p2", pageNumber=2)
    payload = content.build_visual_catalog({"id":"d", "pages":[second,page]})
    assert payload["total"] == 4 and payload["complete"]
    assert [i["pageNumber"] for i in payload["items"]] == [1,1,2,2]
    assert payload["items"][1]["renderMode"] == stored_mode
    assert not content.build_visual_catalog({"id":"d", "pages":[{"id":"p"}]})["complete"]


@pytest.fixture
def library(monkeypatch, tmp_path):
    monkeypatch.setenv("INITIAL_ADMIN_USERNAME", "owner")
    monkeypatch.setenv("INITIAL_ADMIN_PASSWORD", "test-only")
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    data.ensure_schema(connection)
    monkeypatch.setattr(data, "FILE_STORAGE_DIR", tmp_path)
    user = {"id":1,"username":"owner"}
    @contextmanager
    def database():
        yield connection
    monkeypatch.setattr(data, "database", database)
    monkeypatch.setattr(data, "current_user", lambda: user)
    data.app.dependency_overrides[data.current_user] = lambda: user
    yield TestClient(data.app), connection, user
    data.app.dependency_overrides.clear()
    connection.close()


def test_figure_and_table_image_assets_survive_sync_and_reader_routes(library, tmp_path):
    client, connection, user = library
    page, layout = page_for(result())
    path = tmp_path / "input.png"
    Image.new("RGB", (100,100)).save(path)
    raw = result(); raw["visuals"] = page["visuals"]
    content.materialize_visual_images(raw,path)
    page["imageDataUrl"] = "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()
    # 同一页的插图、表格均保存独立图片资源。
    page["visuals"].append(dict(page["visuals"][0], id="another"))
    doc = {"id":"d", "visibility":"private", "pages":[page]}
    data.upsert_documents(connection,[doc],"now",user)
    stored_page = data.load_document_pages(connection, "d")[0]
    rows = list(connection.execute("SELECT role FROM document_files WHERE document_id='d' AND role LIKE 'page-visual:%'"))
    assert len(rows) == 3
    assert stored_page["visuals"][1]["renderMode"] == "image"
    assert stored_page["visuals"][1]["url"] != stored_page["visuals"][0]["url"]
    assert stored_page["visuals"][0]["url"] != stored_page["visuals"][-1]["url"]
    assert "imageDataUrl" not in stored_page["visuals"][0]
    reader_index.save_ocr_layout(connection,"d",stored_page,{**result(), "contentBlocks":layout["contentBlocks"],"contentSourceText":page["ocrText"]},"now")
    connection.commit()
    response = client.get("/api/documents/d/pages/p/reader-content")
    assert response.status_code == 200, response.text
    assert len(response.json()["visuals"]) == 3
    assert client.get("/api/documents/d/visual-catalog").json()["total"] == 3
    data.upsert_documents(connection,[{"id":"d","pages":[{"id":"p","pageNumber":1,"punctuatedText":"edited"}]}],"later",user)
    assert len(json.loads(connection.execute("SELECT payload FROM document_pages WHERE id='p'").fetchone()["payload"])["visuals"]) == 3
    other = {"id":2,"username":"other"}
    data.app.dependency_overrides[data.current_user] = lambda: other
    # 路由会显式调用 current_user，这里一并替换。
    from unittest.mock import patch
    with patch.object(data,"current_user",lambda: other):
        assert client.get("/api/documents/d/visual-catalog").status_code == 404
        assert client.get("/api/documents/d/pages/p/reader-content").status_code == 404


@pytest.mark.parametrize("mode", ["formal", "quick", "reader"])
def test_upstream_requests_images_without_reconstruction(monkeypatch, tmp_path, mode):
    path=tmp_path/'p.png'; Image.new('RGB',(10,10)).save(path)
    monkeypatch.setenv('OCR_UPSTREAM_URL','http://ocr.example')
    calls=[]
    monkeypatch.setattr(ocr_upstream,'_request_json',lambda url,payload,**kw: (calls.append(payload) or (200, {'result':{'layoutParsingResults':[{'prunedResult':{}}]}})))
    parsed=ocr_upstream.recognize_page_image(path,mode=mode)
    assert parsed['coordinateSpace'] == ('processed' if mode == 'formal' else 'input')
    assert calls[0]['useDocUnwarping'] is (mode == 'formal')
    assert calls[0]['useDocOrientationClassify'] is (mode == 'formal')
    assert calls[0]['useTextlineOrientation'] is (mode != 'quick')
    assert calls[0]['useLayoutDetection'] is (mode != 'quick')
    assert calls[0]['useWiredTableCellsTransToHtml'] is False
    assert calls[0]['useWirelessTableCellsTransToHtml'] is False
    assert calls[0]['useChartRecognition'] is False
    assert calls[0]['returnMarkdownImages'] is True
    assert calls[0]['useTableRecognition'] is False

def test_corrupt_resource_still_uses_verified_original_crop(tmp_path):
    path=tmp_path/'page.png'; Image.new('RGB',(100,100)).save(path)
    raw=result();raw['visuals'],_=content.extract_visuals(raw)
    raw['visuals'][0]['resourceRef']='bad.png'
    raw['markdownImages']={'bad.png':'this is not base64'}
    content.materialize_visual_images(raw,path)
    assert raw['visuals'][0]['status']=='ready'
    assert raw['visuals'][0]['warning']


def test_explicit_caption_identity_wins_over_adjacency():
    raw={'blocks':[
        {'type':'figure','visualId':'va','order':1},
        {'type':'text','text':'body','order':2},
        {'type':'figure_title','visualId':'va','text':'caption A','order':3},
        {'type':'figure','visualId':'vb','order':4},
    ]}
    visuals,_=content.extract_visuals(raw)
    assert visuals[0]['captions'][0]['text']=='caption A'
    assert not visuals[1]['captions']
    raw['blocks'][2]['visualId']='missing'
    visuals,_=content.extract_visuals(raw)
    assert any(v['kind']=='caption' for v in visuals)
    assert not next(v for v in visuals if v['id']=='visual-0004')['captions']


def test_unplaced_visual_does_not_push_later_anchor_to_end():
    source='a'*90+'\n'+'b'*90+'\n'+'KEEPFIRST.\nKEEPSECOND.\nKEEPLAST.'
    target='KEEPFIRST.\nKEEPSECOND.\nKEEPLAST.'
    page={'ocrText':source,'punctuatedText':target,'visualsExtracted':True,'visuals':[
        {'id':'missing','sourceBoundary':20},
        {'id':'found','sourceBoundary':source.index('KEEPSECOND.')},
    ]}
    payload=content.build_reader_content({'contentSourceText':source},page)
    entries=payload['items']
    assert entries[-1]['type']=='text'
    assert entries[1]['placement']=='unplaced'
    assert entries[2]['visualId']=='found'
    assert entries[2]['placement']=='aligned'

def test_public_copy_rebinds_all_visual_assets(library,tmp_path,monkeypatch):
    client,connection,user=library
    connection.execute("INSERT INTO users(id,username,password_hash,created_at) VALUES(2,'reader','unused','now')")
    path=tmp_path/'input.png';Image.new('RGB',(100,100)).save(path)
    page,layout=page_for(result()); raw=result();raw['visuals']=page['visuals'];content.materialize_visual_images(raw,path)
    page['imageDataUrl']='data:image/png;base64,'+base64.b64encode(path.read_bytes()).decode()
    data.upsert_documents(connection,[{'id':'d','visibility':'public','pages':[page]}],'now',user);connection.commit()
    monkeypatch.setattr(data,'current_user',lambda:{'id':2,'username':'reader'})
    response=client.post('/api/documents/d/download');assert response.status_code==200,response.text
    copied=response.json()['document']; visual=copied['pages'][0]['visuals'][0]
    assert visual['asset']['pageId']==copied['pages'][0]['id']
    assert visual['asset']['id'].startswith(copied['id']+':')
    assert (data.FILE_STORAGE_DIR/visual['asset']['path']).exists()

def test_zero_valued_explicit_caption_identity_does_not_fall_back_to_neighbor():
    raw={'blocks':[{'type':'figure','id':0,'order':1},{'type':'text','text':'body','order':2},
                   {'type':'figure','id':1,'order':3},{'type':'figure_title','parentId':0,'text':'caption zero','order':4}]}
    visuals,_=content.extract_visuals(raw)
    assert visuals[0]['captions'][0]['text']=='caption zero'
    assert not visuals[1]['captions']


def test_table_pixels_are_cropped_even_when_upstream_sends_html(tmp_path):
    path = tmp_path / "page.png"
    image = Image.new("RGB", (100, 100), "white")
    image.paste("red", (50, 10, 95, 60))
    image.save(path)
    raw = result()
    raw["blocks"][-1]["html"] = "<table><tr><td>wrong reconstruction</td></tr></table>"
    raw["visuals"], _ = content.extract_visuals(raw)
    content.materialize_visual_images(raw, path)
    table = raw["visuals"][1]
    assert table["renderMode"] == "image" and table["status"] == "ready"
    assert "tableModel" not in table
    with Image.open(io.BytesIO(base64.b64decode(table["imageDataUrl"].split(",", 1)[1]))) as crop:
        assert crop.size == (45, 50)
        assert crop.tobytes() == image.crop((50, 10, 95, 60)).tobytes()


@pytest.mark.parametrize("image_format", ["PNG", "JPEG"])
def test_processed_visuals_use_their_own_resources_not_input_coordinates(tmp_path, image_format):
    path = tmp_path / "page.png"
    Image.new("RGB", (100, 100), "white").save(path)
    raw = {"width": 100, "height": 100, "coordinateSpace": "processed", "blocks": [
        {"type": "table", "text": "![table](imgs/table.jpg)", "bbox": [1, 1, 20, 20]},
        {"type": "chart", "text": "![chart](imgs/chart.jpg)", "bbox": [30, 1, 50, 20]},
        {"type": "table", "text": "no image", "bbox": [1, 30, 20, 50]},
    ], "markdownImages": {}}
    # 资源顺序与块顺序不同，必须按真实路径绑定，不能按下标猜测。
    for kind, color in [("chart", "blue"), ("table", "red")]:
        output = io.BytesIO()
        Image.new("RGB", (19, 19), color).save(output, format=image_format)
        raw["markdownImages"][f"imgs/{kind}.jpg"] = base64.b64encode(output.getvalue()).decode()
    raw["visuals"], _ = content.extract_visuals(raw)
    content.materialize_visual_images(raw, path)
    for visual, color in zip(raw["visuals"], [(255, 0, 0), (0, 0, 255)]):
        assert visual["status"] == "ready" and visual["geometryStatus"] == "unavailable"
        with Image.open(io.BytesIO(base64.b64decode(visual["imageDataUrl"].split(",", 1)[1]))) as crop:
            assert all(abs(actual - expected) <= 2 for actual, expected in zip(crop.getpixel((0, 0)), color))
    assert raw["visuals"][2]["status"] == "missing"
    assert "imageDataUrl" not in raw["visuals"][2]
