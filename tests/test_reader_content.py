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
    assert table["renderMode"] == "structured"
    assert table["tableModel"]["cells"][-1]["text"] == "001"


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


def test_catalog_includes_structured_tables_all_pages_and_keeps_identical_titles():
    page, _ = page_for(result())
    second = dict(page, id="p2", pageNumber=2)
    payload = content.build_visual_catalog({"id":"d", "pages":[second,page]})
    assert payload["total"] == 4 and payload["complete"]
    assert [i["pageNumber"] for i in payload["items"]] == [1,1,2,2]
    assert payload["items"][1]["renderMode"] == "structured"
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


def test_assets_two_visuals_survive_sync_and_reader_routes(library, tmp_path):
    client, connection, user = library
    page, layout = page_for(result())
    path = tmp_path / "input.png"
    Image.new("RGB", (100,100)).save(path)
    raw = result(); raw["visuals"] = page["visuals"]
    content.materialize_visual_images(raw,path)
    page["imageDataUrl"] = "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()
    # 同一页两个不同图片资源；表格仍按结构化方式处理。
    page["visuals"].append(dict(page["visuals"][0], id="another"))
    doc = {"id":"d", "visibility":"private", "pages":[page]}
    data.upsert_documents(connection,[doc],"now",user)
    stored = json.loads(connection.execute("SELECT payload FROM documents WHERE id='d'").fetchone()["payload"])
    stored_page = stored["pages"][0]
    rows = list(connection.execute("SELECT role FROM document_files WHERE document_id='d' AND role LIKE 'page-visual:%'"))
    assert len(rows) == 2
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


def test_reader_upstream_requests_input_coordinates(monkeypatch, tmp_path):
    path=tmp_path/'p.png'; Image.new('RGB',(10,10)).save(path)
    monkeypatch.setenv('OCR_UPSTREAM_URL','http://ocr.example')
    calls=[]
    monkeypatch.setattr(ocr_upstream,'_request_json',lambda url,payload,**kw: (calls.append(payload) or (200, {'result':{'layoutParsingResults':[{'prunedResult':{}}]}})))
    parsed=ocr_upstream.recognize_page_image(path,mode='reader')
    assert parsed['coordinateSpace']=='input'
    assert calls[0]['useDocUnwarping'] is False
    assert calls[0]['useTableRecognition'] is True

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

def test_backfill_completed_job_preserves_manual_body_and_uses_new_source(library, tmp_path):
    from concurrent.futures import Future
    from service import scheduler
    client, connection, user = library
    image=Image.new('RGB',(100,100)); stream=io.BytesIO();image.save(stream,format='PNG')
    old={'id':'d','pages':[{'id':'p','pageNumber':1,'ocrText':'old OCR','punctuatedText':'manual text must survive',
                          'processingRevision':2,'imageDataUrl':'data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode()}]}
    data.upsert_documents(connection,[old],'now',user);connection.commit()
    assert client.post('/api/documents/d/pages/p/extract-visuals').status_code==200
    worker=scheduler.Scheduler(data,services=object())
    loaded=worker._load(connection,'d',allow_terminal=True)
    assert loaded and loaded[0]['status']=='completed'
    job,doc,cp=loaded;cp['visualQueue'][0]['status']='running'
    connection.execute('UPDATE processing_jobs SET checkpoint=? WHERE document_id=?',(json.dumps(cp),'d'));connection.commit()
    raw=result();raw['visuals'],raw['contentBlocks']=content.extract_visuals(raw);raw['contentSourceText']=content.body_text(raw);raw['text']=raw['contentSourceText']
    future=Future();future.set_result(raw)
    try:
        worker._record('d','visual_backfill',1,future)
        actual=json.loads(connection.execute('SELECT payload FROM document_pages WHERE id=?',('p',)).fetchone()['payload'])
        assert actual['punctuatedText']=='manual text must survive'
        assert actual['ocrText']=='old OCR'
        assert actual['visualsExtracted']
        assert actual['processingRevision']==3
        layout=json.loads(connection.execute('SELECT layout FROM page_reader_indexes WHERE page_id=?',('p',)).fetchone()['layout'])
        assert layout['contentSourceText']==raw['contentSourceText']
        assert client.get('/api/documents/d/pages/p/extract-visuals').json()['status']=='completed'
    finally:
        worker.executor.shutdown()


def test_backfill_rejects_changed_source_revision(library):
    from concurrent.futures import Future
    from service import scheduler
    client,connection,user=library
    data.upsert_documents(connection,[{'id':'d','pages':[{'id':'p','pageNumber':1,'punctuatedText':'manual','processingRevision':2}]}],'now',user)
    cp={'visualQueue':[{'pageId':'p','pageNumber':1,'imageHash':'','sourceRevision':1,'status':'running'}]}
    connection.execute("INSERT INTO processing_jobs(document_id,mode,phase,status,source_path,checkpoint,created_at,updated_at) VALUES('d','serial','body','completed','',?,'now','now')",(json.dumps(cp),));connection.commit()
    future=Future();future.set_result({'visuals':[]})
    worker=scheduler.Scheduler(data,services=object())
    try:
        worker._record('d','visual_backfill',1,future)
        page=json.loads(connection.execute("SELECT payload FROM document_pages WHERE id='p'").fetchone()['payload'])
        assert page['punctuatedText']=='manual' and not page.get('visualsExtracted')
        assert client.get('/api/documents/d/pages/p/extract-visuals').json()['status']=='failed'
    finally:worker.executor.shutdown()


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

def _prepare_backfill(library, page):
    from service import scheduler
    client,connection,user=library
    image=Image.new('RGB',(100,100));stream=io.BytesIO();image.save(stream,format='PNG')
    page={**page,'id':'p','pageNumber':1,'processingRevision':2,
          'imageDataUrl':'data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode()}
    data.upsert_documents(connection,[{'id':'d','pages':[page]}],'now',user);connection.commit()
    assert client.post('/api/documents/d/pages/p/extract-visuals').status_code==200
    row=connection.execute("SELECT checkpoint FROM processing_jobs WHERE document_id='d'").fetchone()
    cp=json.loads(row['checkpoint']);cp['visualQueue'][0]['status']='running'
    connection.execute("UPDATE processing_jobs SET checkpoint=? WHERE document_id='d'",(json.dumps(cp),));connection.commit()
    return scheduler.Scheduler(data,services=object())


def test_backfill_never_deletes_a_manually_authored_caption_matching_paragraph(library):
    from concurrent.futures import Future
    page={'ocrText':'Before\nAfter','punctuatedText':'Before\nA user-authored paragraph\nAfter'}
    worker=_prepare_backfill(library,page)
    raw={'blocks':[{'type':'figure','order':1},{'type':'figure_title','text':'A user-authored paragraph','order':2}]}
    raw['visuals'],raw['contentBlocks']=content.extract_visuals(raw)
    future=Future();future.set_result(raw)
    try:
        worker._record('d','visual_backfill',1,future)
        actual=json.loads(library[1].execute("SELECT payload FROM document_pages WHERE id='p'").fetchone()['payload'])
        assert actual['punctuatedText']==page['punctuatedText']
        assert actual['ocrText']==page['ocrText']
    finally:worker.executor.shutdown()


def test_backfill_keeps_changed_final_rendition_and_marks_separation_for_review(library):
    from concurrent.futures import Future
    page={'ocrText':'Before\nFigure title\nAfter','punctuatedText':'Before,\nFigure title\nAfter!'}
    worker=_prepare_backfill(library,page)
    raw={'blocks':[{'type':'figure','order':1},{'type':'figure_title','text':'Figure title','order':2}]}
    raw['visuals'],raw['contentBlocks']=content.extract_visuals(raw)
    future=Future();future.set_result(raw)
    try:
        worker._record('d','visual_backfill',1,future)
        actual=json.loads(library[1].execute("SELECT payload FROM document_pages WHERE id='p'").fetchone()['payload'])
        assert actual['punctuatedText']==page['punctuatedText']
        assert actual['ocrText']=='Before\nAfter'
        assert actual['visualSeparationStatus']=='needs_review'
        assert content.build_reader_content({},actual)['warnings']
    finally:worker.executor.shutdown()


def test_backfill_asset_failure_rolls_back_page_and_previous_working_assets(library,monkeypatch):
    from concurrent.futures import Future
    stream=io.BytesIO();Image.new('RGB',(10,10),'blue').save(stream,format='PNG')
    image_data='data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode()
    old={'id':'old','kind':'figure','renderMode':'image','status':'ready','imageDataUrl':image_data,'sourceBoundary':0}
    worker=_prepare_backfill(library,{'ocrText':'body','punctuatedText':'manual','visualsExtracted':True,'visuals':[old]})
    stored=json.loads(library[1].execute("SELECT payload FROM document_pages WHERE id='p'").fetchone()['payload'])
    old_asset=stored['visuals'][0]['asset']['id']
    store=data.store_data_url_asset
    def fail_new(connection,**kwargs):
        if kwargs.get('role')=='page-visual:new':raise OSError('injected disk error')
        return store(connection,**kwargs)
    monkeypatch.setattr(data,'store_data_url_asset',fail_new)
    future=Future();future.set_result({'visuals':[{**old,'id':'new','imageDataUrl':image_data}],'contentBlocks':[]})
    try:
        worker._record('d','visual_backfill',1,future)
        actual=json.loads(library[1].execute("SELECT payload FROM document_pages WHERE id='p'").fetchone()['payload'])
        assert actual['processingRevision']==2
        assert actual['visuals'][0]['id']=='old' and actual['visuals'][0]['url']
        assert library[1].execute('SELECT deleted_at FROM document_files WHERE id=?',(old_asset,)).fetchone()['deleted_at'] is None
        assert not library[1].execute("SELECT 1 FROM document_files WHERE role='page-visual:new'").fetchone()
        assert library[0].get('/api/documents/d/pages/p/extract-visuals').json()['status']=='failed'
    finally:worker.executor.shutdown()


def test_backfill_only_job_does_not_block_first_original_upload(library):
    worker=_prepare_backfill(library,{'ocrText':'body','punctuatedText':'manual'})
    try:
        response=library[0].post('/api/files/upload',data={'documentId':'d','role':'source'},files={'document':('source.pdf',b'%PDF-test-original','application/pdf')})
        assert response.status_code==200,response.text
        job=library[1].execute("SELECT * FROM processing_jobs WHERE document_id='d'").fetchone()
        assert job['phase']=='registration' and job['status']=='queued'
        assert not json.loads(job['checkpoint']).get('visualOnly')
    finally:worker.executor.shutdown()


def test_zero_valued_explicit_caption_identity_does_not_fall_back_to_neighbor():
    raw={'blocks':[{'type':'figure','id':0,'order':1},{'type':'text','text':'body','order':2},
                   {'type':'figure','id':1,'order':3},{'type':'figure_title','parentId':0,'text':'caption zero','order':4}]}
    visuals,_=content.extract_visuals(raw)
    assert visuals[0]['captions'][0]['text']=='caption zero'
    assert not visuals[1]['captions']

def test_backfill_queue_worker_executes_ocr_and_records_completion(library, monkeypatch):
    worker=_prepare_backfill(library,{'ocrText':'body','punctuatedText':'manual'})
    connection=library[1]
    cp=json.loads(connection.execute("SELECT checkpoint FROM processing_jobs WHERE document_id='d'").fetchone()['checkpoint'])
    cp['visualQueue'][0]['status']='queued'
    connection.execute("UPDATE processing_jobs SET checkpoint=? WHERE document_id='d'",(json.dumps(cp),));connection.commit()
    calls=[]
    class Services:
        def execute(self, operation,job,doc,checkpoint,number):
            calls.append(operation)
            page=doc['pages'][0]
            assert (data.FILE_STORAGE_DIR/page['imageFile']['path']).exists()
            return {'visuals':[],'contentBlocks':[],'contentSourceText':'body'}
    worker.services=Services()
    try:
        worker.tick()
        assert 'visual_backfill' in worker.running
        worker.running['visual_backfill'][0].result(timeout=3)
        worker.tick()
        assert calls==['visual_backfill']
        assert library[0].get('/api/documents/d/pages/p/extract-visuals').json()['status']=='completed'
    finally:worker.executor.shutdown()
