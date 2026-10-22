import base64
import copy
import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as app_module
from app import create_app
from engine import UserError, cited

TOKEN = 'test-token-' + 'x' * 32

@pytest.fixture
def api(tmp_path):
    application = create_app(tmp_path, TOKEN)
    with TestClient(application, headers={'Authorization': 'Bearer ' + TOKEN}) as client:
        yield client, application


def post(client, path, body=None):
    response = client.post(path, json={} if body is None else body)
    assert response.status_code == 200, response.text
    return response.json()


def ready(client):
    example = client.get('/examples').json()[0]
    project = post(client, '/examples/' + example['id'] + '/clone')
    pid = project['id']
    profile = post(client, f'/projects/{pid}/profile/generate')
    post(client, f'/projects/{pid}/profile/confirm', {'version': profile['version']})
    return pid


def start(client, pid, mode='formal', **extra):
    return post(client, f'/projects/{pid}/sessions', {'mode': mode, **extra})


def answer(client, pid, session, operation='answer', text='不知道，需要进一步核查', request_id=None):
    return post(client, f'/projects/{pid}/sessions/{session["id"]}/answers', {
        'requestId': request_id or f'answer-{session["version"]}-{operation}',
        'version': session['version'], 'operation': operation, 'text': text})


def test_local_access_guard(api):
    client, _ = api
    assert client.get('/health').json()['ready']
    assert client.get('/health', headers={'Authorization': 'Bearer invalid'}).status_code == 403
    assert client.get('/health', headers={'Origin': 'https://example.org'}).status_code == 403
    assert client.get('/health', headers={'Host': 'remote.example'}).status_code == 403


def test_text_import_deduplication_limits_and_source_integrity(api):
    client, _ = api
    pid = post(client, '/projects', {'title': '材料测试'})['id']
    path = f'/projects/{pid}/materials'
    text = '研究问题：本项目研究材料可核对性，并保留真实原文作为引用证据。\n\n支持证据：采用教学示例，不宣称真实实验结果。'
    project = post(client, path, {'name': '原始材料', 'text': text})
    material = project['materials'][0]
    assert material['kind'] == 'text'
    assert material['chunks'][0]['page'] is None
    assert material['chunks'][1]['location'] == '文字段落2'
    assert all(chunk['materialName'] == '原始材料' for chunk in material['chunks'])
    assert 'pdf' not in material
    assert len(post(client, path, {'name': '重复', 'text': text})['materials']) == 1
    assert client.post(path, json={'name': '空白', 'text': '短文本'}).status_code == 400
    for index in range(2):
        post(client, path, {'name': str(index), 'text': text + str(index)})
    assert client.post(path, json={'name': '第四份', 'text': text + '新增'}).status_code == 400
    chunks = material['chunks']
    assert cited(chunks, [{'chunkId': chunks[0]['id'], 'quote': chunks[0]['text']}])
    with pytest.raises(ValueError):
        cited(chunks, [{'chunkId': chunks[0]['id'], 'quote': '原文没有的内容'}])


def pdf_data(writer):
    output = io.BytesIO()
    writer.write(output)
    return base64.b64encode(output.getvalue()).decode()


def test_pdf_errors_are_actionable_and_atomic(api):
    client, _ = api
    pid = post(client, '/projects', {'title': 'PDF测试'})['id']
    path = f'/projects/{pid}/materials'
    for data in ['not-base64!', base64.b64encode(b'not a pdf').decode()]:
        response = client.post(path, json={'name': '损坏PDF', 'pdf': data})
        assert response.status_code == 400
        assert '解析' in response.json()['error']
    blank = PdfWriter()
    blank.add_blank_page(200, 200)
    response = client.post(path, json={'name': '扫描件', 'pdf': pdf_data(blank)})
    assert response.status_code == 400 and 'OCR' in response.json()['error']
    blank.encrypt('password')
    response = client.post(path, json={'name': '加密PDF', 'pdf': pdf_data(blank)})
    assert response.status_code == 400 and '加密' in response.json()['error']
    large = PdfWriter()
    for _ in range(101):
        large.add_blank_page(100, 100)
    response = client.post(path, json={'name': '超页数PDF', 'pdf': pdf_data(large)})
    assert response.status_code == 400 and '100页' in response.json()['error']
    assert client.get(f'/projects/{pid}').json()['materials'] == []


def test_profile_versions_user_sources_and_stale_materials(api):
    client, _ = api
    pid = ready(client)
    old = client.get(f'/projects/{pid}').json()['profile']
    body = {'version': old['version'], 'items': copy.deepcopy(old['items'])}
    body['items'][0]['content'] = '用户补充的研究问题'
    body['items'][0]['refs'] = [{'chunkId': 'fake', 'quote': 'fake'}]
    updated = client.patch(f'/projects/{pid}/profile', json=body).json()
    assert updated['version'] == old['version'] + 1
    assert updated['items'][0]['sourceType'] == 'user'
    assert updated['items'][0]['refs'] == []
    assert updated['confirmedAt'] is None
    assert client.patch(f'/projects/{pid}/profile', json=body).status_code == 409
    assert client.post(f'/projects/{pid}/sessions', json={}).status_code == 409
    post(client, f'/projects/{pid}/profile/confirm', {'version': updated['version']})
    snapshot = start(client, pid)
    post(client, f'/projects/{pid}/materials', {'name': '追加', 'text': '追加材料说明了适用条件和未来验证计划，需要重新核对研究画像与材料出处。'})
    assert client.post(f'/projects/{pid}/profile/confirm', json={'version': updated['version']}).status_code == 409
    assert client.post(f'/projects/{pid}/sessions', json={}).status_code == 409
    assert client.get(f'/projects/{pid}/sessions/{snapshot["id"]}').json()['profile'] == snapshot['profile']


def test_formal_follow_depth_round_limit_and_idempotency(api):
    client, _ = api
    pid = ready(client)
    session = start(client, pid)
    sid = session['id']
    assert client.post(f'/projects/{pid}/sessions/{sid}/hints', json={}).status_code == 403
    session = answer(client, pid, session, request_id='stable-request-id')
    duplicate = post(client, f'/projects/{pid}/sessions/{sid}/answers', {'requestId': 'stable-request-id', 'version': 1, 'text': '网络重发'})
    assert duplicate == session
    assert len(session['turns']) == 2 and session['turns'][-1]['depth'] == 1
    assert session['turns'][-1]['parentId'] == session['turns'][0]['id']
    stale = client.post(f'/projects/{pid}/sessions/{sid}/answers', json={'requestId': 'new-stale-request', 'version': 1, 'text': '过期提交'})
    assert stale.status_code == 409
    while session['status'] != 'finished':
        session = answer(client, pid, session)
    assert len(session['turns']) == 12
    assert max(turn['depth'] for turn in session['turns']) == 2
    assert session['report']['findings']
    exported = client.get(f'/projects/{pid}/sessions/{sid}/markdown').json()['text']
    assert '完整问答与尝试' in exported and '不知道' in exported


def test_deepen_and_time_limit(api, monkeypatch):
    client, application = api
    pid = ready(client)
    session = start(client, pid)
    for _ in range(3):
        session = answer(client, pid, session, operation='deepen')
    assert session['turns'][-1]['depth'] == 3
    session = answer(client, pid, session, operation='deepen')
    assert session['turns'][-1]['depth'] == 0
    monkeypatch.setattr(app_module, 'now', lambda: session['deadline'] + 1)
    ended = answer(client, pid, session)
    assert ended['status'] == 'finished'
    assert len(ended['turns']) == len(session['turns'])


def test_coach_hints_retry_next_and_practice(api):
    client, _ = api
    pid = ready(client)
    session = start(client, pid, 'coach')
    sid = session['id']
    assert len(post(client, f'/projects/{pid}/sessions/{sid}/hints')['hints']) == 3
    session = answer(client, pid, session)
    assert session['status'] == 'reviewing' and len(session['turns']) == 1
    session = answer(client, pid, session, operation='retry', text='仍不清楚，需要核查')
    assert len(session['turns'][0]['attempts']) == 2
    session = post(client, f'/projects/{pid}/sessions/{sid}/next')
    assert session['status'] == 'waiting' and len(session['turns']) == 2
    session = post(client, f'/projects/{pid}/sessions/{sid}/finish')
    finding = session['report']['findings'][0]
    practice = start(client, pid, 'practice', sourceSession=sid, findingId=finding['id'])
    assert practice['target'] == finding['reason']
    assert practice['profile'] == session['profile']
    while practice['status'] != 'finished':
        practice = answer(client, pid, practice, operation='deepen')
    assert len(practice['turns']) == 4
    assert client.post(f'/projects/{pid}/sessions', json={'mode': 'practice', 'sourceSession': sid, 'findingId': 'missing'}).status_code == 400


def test_analysis_failure_keeps_answer_and_retry_recovers(api, monkeypatch):
    client, application = api
    pid = ready(client)
    session = start(client, pid)
    original = application.state.engine.analyze
    def failure(*args):
        raise UserError('测试模型超时', 504)
    monkeypatch.setattr(application.state.engine, 'analyze', failure)
    failed = answer(client, pid, session)
    assert failed['status'] == 'pending' and failed['error'] == '测试模型超时'
    assert failed['turns'][0]['attempts'][0]['text'] == '不知道，需要进一步核查'
    monkeypatch.setattr(application.state.engine, 'analyze', original)
    recovered = post(client, f'/projects/{pid}/sessions/{session["id"]}/retry')
    assert recovered['status'] == 'waiting' and recovered['error'] is None
    assert len(recovered['turns'][0]['attempts']) == 1
    assert len(recovered['turns']) == 2


def test_coach_next_question_failure_retry_resumes_transition(api, monkeypatch):
    client, application = api
    pid = ready(client)
    session = answer(client, pid, start(client, pid, 'coach'))
    original = application.state.engine.question
    def failure(*args):
        raise UserError('测试出题失败', 502)
    monkeypatch.setattr(application.state.engine, 'question', failure)
    path = f'/projects/{pid}/sessions/{session["id"]}'
    failed = post(client, path + '/next')
    assert failed['status'] == 'pending'
    monkeypatch.setattr(application.state.engine, 'question', original)
    recovered = post(client, path + '/retry')
    assert recovered['status'] == 'waiting'
    assert len(recovered['turns']) == 2
    assert len(recovered['turns'][0]['attempts']) == 1


def test_backup_restore_delete_and_restore_atomicity(api):
    client, _ = api
    pid = ready(client)
    session = answer(client, pid, start(client, pid))
    backup = client.get('/backup').json()
    assert post(client, '/backup/restore', backup)['restored'] == 1
    projects = client.get('/projects').json()
    restored = next(p for p in projects if p['id'] != pid)
    copy_project = client.get('/projects/' + restored['id']).json()
    assert copy_project['sessions'][0]['turns'] == session['turns']
    assert copy_project['title'].endswith('（恢复副本）')
    invalid = copy.deepcopy(backup)
    invalid['projects'].append({'title': '损坏副本', 'materials': [], 'sessions': [{'status': 'bad'}]})
    assert client.post('/backup/restore', json=invalid).status_code == 400
    assert len(client.get('/projects').json()) == 2
    assert client.delete(f'/projects/{pid}').json()['deleted']
    assert client.get(f'/projects/{pid}').status_code == 404
    assert len(client.get('/backup').json()['projects']) == 1

@pytest.mark.parametrize('damage', ['profile', 'attempts', 'report', 'timestamps', 'incomplete'])
def test_restore_rejects_broken_nested_state_without_partial_writes(api, damage):
    client, _ = api
    pid = ready(client)
    session = answer(client, pid, start(client, pid))
    post(client, f'/projects/{pid}/sessions/{session["id"]}/finish')
    backup = client.get('/backup').json()
    invalid = copy.deepcopy(backup['projects'][0])
    if damage == 'profile':
        invalid['profile']['items'] = []
    elif damage == 'attempts':
        invalid['sessions'][0]['turns'][0]['attempts'] = [{'text': 'incomplete'}]
    elif damage == 'report':
        invalid['sessions'][0]['report']['findings'][0]['refs'][0]['quote'] = 'forged source'
    elif damage == 'timestamps':
        invalid['updatedAt'] = 'yesterday'
    else:
        invalid = {'title': 'incomplete', 'materials': [], 'sessions': []}
    backup['projects'].append(invalid)
    assert client.post('/backup/restore', json=backup).status_code == 400
    assert len(client.get('/projects').json()) == 1


def test_usage_metadata_survives_restart_without_sensitive_content(api, tmp_path, monkeypatch):
    import httpx
    import engine as engine_module
    client, application = api
    engine = application.state.engine
    engine.configure({'mode': 'live', 'baseUrl': 'https://model.example/v1', 'model': 'test-model', 'key': 'secret-key'})
    class FakeClient:
        def __init__(self, **kwargs):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def post(self, *args, **kwargs):
            return httpx.Response(200, json={'choices': [{'message': {'content': '{"ok":true}'}}], 'usage': {'prompt_tokens': 12, 'completion_tokens': 4, 'injected': 'private text'}})
    monkeypatch.setattr(engine_module.httpx, 'Client', FakeClient)
    assert post(client, '/model/test')['ok']
    usage = client.get('/model/usage').json()
    assert usage[0]['usage'] == {'prompt_tokens': 12, 'completion_tokens': 4}
    assert set(usage[0]) == {'model', 'seconds', 'usage', 'retry'}
    assert 'secret-key' not in str(usage) and 'private text' not in str(usage)
    reopened = create_app(tmp_path, TOKEN)
    try:
        assert reopened.state.store.usage() == usage
    finally:
        reopened.state.store.db.close()

def test_pdf_import_retains_physical_page_and_excerpt(api):
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    client, _ = api
    pid = post(client, '/projects', {'title': 'PDF来源'})['id']
    writer = PdfWriter()
    page = writer.add_blank_page(400, 400)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 12 Tf 20 300 Td (Research evidence must retain its physical PDF page and original quotation.) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    project = post(client, f'/projects/{pid}/materials', {'name': 'paper.pdf', 'pdf': pdf_data(writer)})
    material = project['materials'][0]
    assert material['kind'] == 'pdf' and material['pageCount'] == 1
    chunk = material['chunks'][0]
    assert chunk['page'] == 1 and chunk['location'] == 'PDF物理第1页 · 段落1'
    assert 'Research evidence' in chunk['text']
    assert chunk['materialName'] == 'paper.pdf'


@pytest.mark.parametrize('repair_succeeds', [False, True])
def test_model_adapter_repairs_invalid_references_once(repair_succeeds, monkeypatch):
    import httpx
    import engine as engine_module
    engine = engine_module.Engine()
    engine.configure({'mode': 'live', 'baseUrl': 'https://model.example/v1', 'model': 'test', 'key': 'private'})
    chunks = [{'id': 'known', 'text': 'Original evidence'}]
    calls = []
    class FakeClient:
        def __init__(self, **kwargs):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def post(self, *args, **kwargs):
            calls.append(copy.deepcopy(kwargs['json']))
            import json
            refs = [{'chunkId': 'known', 'quote': 'Original evidence'}] if repair_succeeds and len(calls) == 2 else [{'chunkId': 'unknown', 'quote': 'fabricated'}]
            return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps({'refs': refs})}}]})
    monkeypatch.setattr(engine_module.httpx, 'Client', FakeClient)
    validate = lambda data: cited(chunks, data['refs'])
    if repair_succeeds:
        assert engine.generate('test', {'chunks': chunks}, validate)[0]['chunkId'] == 'known'
    else:
        with pytest.raises(UserError, match='引用校验未通过'):
            engine.generate('test', {'chunks': chunks}, validate)
    assert len(calls) == 2
    assert len(calls[1]['messages']) == 3
    assert len(engine.usage) == 2


def test_skipped_dimensions_remain_uncovered_in_report(api):
    client, _ = api
    pid = ready(client)
    session = start(client, pid)
    while session['status'] != 'finished':
        session = answer(client, pid, session, operation='skip', text='')
    assert len(session['turns']) == 5
    assert set(session['report']['coverage'].values()) == {'未覆盖'}
    assert session['report']['findings'] == []
