import base64
import copy
import hashlib
import io
import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from pypdf import PdfReader

from engine import Engine, UserError, FIELDS, DIMENSIONS, cited
from examples import EXAMPLES
from backup_validation import validate_project


def uid():
    return uuid.uuid4().hex


def now():
    return time.time()


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.directory / 'workspace.sqlite3', check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)')
        self.db.commit()

    def all(self):
        return [json.loads(r[0]) for r in self.db.execute('SELECT data FROM projects')]

    def get(self, project_id):
        row = self.db.execute('SELECT data FROM projects WHERE id=?', (project_id,)).fetchone()
        if not row:
            raise UserError('项目不存在或已删除。', 404)
        return json.loads(row[0])

    def save(self, project):
        project['updatedAt'] = now()
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO projects VALUES (?, ?)', (project['id'], json.dumps(project, ensure_ascii=False)))


    def save_usage(self, metric):
        # Keep only operational metadata; never persist prompts, API keys or model text.
        allowed = {key: metric[key] for key in ['model', 'seconds', 'usage', 'retry']}
        with self.lock, self.db:
            self.db.execute('INSERT INTO metrics (data) VALUES (?)', (json.dumps(allowed),))
            self.db.execute('DELETE FROM metrics WHERE id NOT IN (SELECT id FROM metrics ORDER BY id DESC LIMIT 200)')

    def usage(self):
        with self.lock:
            rows = self.db.execute('SELECT data FROM metrics ORDER BY id DESC LIMIT 200').fetchall()
            return [json.loads(row[0]) for row in reversed(rows)]


class Title(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class MaterialInput(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    text: str = Field(default='', max_length=30000)
    pdf: str = Field(default='', max_length=28000000)


class ProfileInput(BaseModel):
    items: list[dict]
    version: int


class StartInput(BaseModel):
    mode: str = 'formal'
    minutes: int = 12
    demo: bool = True
    consent: bool = False
    sourceSession: str | None = None
    findingId: str | None = None


class AnswerInput(BaseModel):
    requestId: str = Field(min_length=8, max_length=100)
    version: int
    text: str = Field(default='', max_length=8000)
    operation: str = 'answer'


def make_report(session):
    findings = []
    for turn in session['turns']:
        if not turn['attempts']:
            continue
        attempt = turn['attempts'][-1]
        a = attempt.get('analysis')
        if not a or a.get('action') == 'switch':
            continue
        findings.append({'id': 'finding-' + turn['id'], 'turnId': turn['id'], 'attemptId': attempt['id'],
                         'dimension': turn['dimension'], 'category': a['category'], 'reason': a['reason'],
                         'question': turn['question'], 'answer': attempt['text'], 'refs': a['refs'],
                         'uncertainty': a['uncertainty'], 'suggestion': a['suggestion'], 'done': False,
                         'actionType': '表达练习' if a['category'] == '回答未说明' else '补充实验或分析',
                         'criterion': '明确主张、提供可定位证据、说明证据缺口与下一步验证方案。', 'priority': '优先处理'})
    coverage = {}
    for dimension in DIMENSIONS:
        answered = [t for t in session['turns'] if t['dimension'] == dimension and t['attempts'] and t['attempts'][-1]['operation'] != 'skip' and t['attempts'][-1].get('analysis')]
        coverage[dimension] = '未覆盖' if not answered else ('需关注' if any(f['dimension'] == dimension for f in findings) else '已讨论，待人工核对')
    return {'createdAt': now(), 'coverage': coverage, 'findings': findings,
            'summary': '本次报告基于已保存问答与材料出处，不预测真实答辩成绩。' + ('当前为离线规则演练，反馈不构成 AI 理解或研究质量评价。' if session['demo'] else '模型判断仍需结合原文人工核对。')}


def markdown(project, session):
    report = session.get('report')
    if not report:
        raise UserError('报告尚未生成，请先结束训练。', 409)
    lines = ['# 答辩风洞 · 训练复盘', '', '项目：' + project['title'], '', report['summary'], '', '## 维度覆盖', '']
    lines += [f'- {k}：{v}' for k, v in report['coverage'].items()]
    chunks = {c['id']: c for c in session['chunks']}
    lines += ['', '## 重点问题与行动', '']
    for f in report['findings']:
        lines += ['### ' + f['dimension'] + ' · ' + f['category'], '', '问题：' + f['question'], '', '回答：' + f['answer'], '', f['reason'], '', '不确定性：' + f['uncertainty'], '', f"- [{'x' if f['done'] else ' '}] {f['suggestion']}", '- 完成标准：' + f['criterion']]
        for ref in f['refs']:
            c = chunks[ref['chunkId']]
            lines += ['', f"> {c['materialName']} · {c['location']} · {c['id']}：{ref['quote']}"]
        lines += ['']
    lines += ['', '## 完整问答与尝试', '']
    for t in session['turns']:
        lines += [f"### {t['number']}. {t['role']} · {t['dimension']}（追问深度 {t['depth']}）", '', t['question'], '', '父问题：' + (t['parentId'] or '根问题')]
        for i, a in enumerate(t['attempts']):
            lines += ['', f"尝试 {i+1}（{a['operation']}）：{a['text']}"]
    return '\n'.join(lines)


def create_app(directory, token):
    if len(token) < 24:
        raise ValueError('必须提供每次启动随机生成的鉴权凭据')
    store = Store(directory)
    engine = Engine(on_usage=store.save_usage)
    engine.usage = store.usage()

    @asynccontextmanager
    async def lifespan(app):
        yield
        store.db.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.store, app.state.engine = store, engine

    @app.middleware('http')
    async def guard(request: Request, call_next):
        if request.headers.get('authorization') != 'Bearer ' + token or request.headers.get('origin'):
            return JSONResponse({'error': '本地服务访问未获授权。'}, 403)
        if request.headers.get('host', '').split(':')[0] not in ['127.0.0.1', 'testserver']:
            return JSONResponse({'error': '访问地址无效。'}, 403)
        if int(request.headers.get('content-length', 0)) > 100_000_000:
            return JSONResponse({'error': '请求超过容量限制。'}, 413)
        return await call_next(request)

    @app.exception_handler(UserError)
    async def user_error(request, exc):
        return JSONResponse({'error': exc.message}, exc.status)

    @app.exception_handler(Exception)
    async def unexpected(request, exc):
        return JSONResponse({'error': '本地处理失败，已提交记录会保留。请重试或重启软件。'}, 500)

    def session_of(project, session_id):
        s = next((s for s in project['sessions'] if s['id'] == session_id), None)
        if not s:
            raise UserError('训练不存在。', 404)
        return s

    def add_question(s, dimension, parent=None, analysis=None):
        q = engine.question(s, dimension, parent, analysis)
        s['turns'].append({**q, 'id': uid(), 'number': len(s['turns'])+1, 'parentId': parent['id'] if parent else None,
                           'depth': parent['depth']+1 if parent else 0, 'createdAt': now(), 'attempts': []})
        s['status'] = 'waiting'
        s['version'] += 1

    @app.get('/health')
    def health():
        return {'ready': True, 'version': '0.1.0'}

    @app.get('/examples')
    def examples():
        return [{k: v for k, v in x.items() if k != 'text'} for x in EXAMPLES]

    @app.get('/projects')
    def projects():
        with store.lock:
            return sorted([{k: p[k] for k in ['id', 'title', 'createdAt', 'updatedAt']} | {'materialCount': len(p['materials']), 'sessionCount': len(p['sessions'])} for p in store.all()], key=lambda p: p['updatedAt'], reverse=True)

    @app.post('/projects')
    def create(body: Title):
        if not body.title.strip():
            raise UserError('请填写项目名称。')
        p = {'id': uid(), 'title': body.title.strip(), 'createdAt': now(), 'materials': [], 'profile': None, 'profiles': [], 'sessions': []}
        with store.lock:
            store.save(p)
        return p

    @app.get('/projects/{pid}')
    def get_project(pid: str):
        with store.lock:
            p = store.get(pid)
            return {**p, 'materials': [{k: v for k, v in m.items() if k != 'pdf'} for m in p['materials']]}

    @app.delete('/projects/{pid}')
    def delete(pid: str):
        with store.lock:
            with store.db:
                store.get(pid)
                store.db.execute('DELETE FROM projects WHERE id=?', (pid,))
            # Commit before checkpoint, retaining the lock across both operations.
            store.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        return {'deleted': True}

    store.db.execute('PRAGMA secure_delete=ON')

    @app.post('/projects/{pid}/materials')
    def material(pid: str, body: MaterialInput):
        with store.lock:
            p = store.get(pid)
            raw = body.text.encode('utf-8')
            pages, warnings = [body.text], []
            if body.pdf:
                try:
                    raw = base64.b64decode(body.pdf, validate=True)
                    if len(raw) > 20 * 1024 * 1024:
                        raise UserError('文件超过20 MB，请拆分PDF或粘贴文字。')
                    reader = PdfReader(io.BytesIO(raw))
                    if reader.is_encrypted:
                        raise UserError('PDF已加密，请解除加密后重新导入。')
                    if len(reader.pages) > 100:
                        raise UserError('PDF超过100页，请拆分文件。')
                    pages = [(page.extract_text() or '') for page in reader.pages]
                except UserError:
                    raise
                except Exception:
                    raise UserError('无法解析此PDF，请确认文件完整，或改为粘贴文字。')
            digest = hashlib.sha256(raw).hexdigest()
            if any(m['digest'] == digest for m in p['materials']):
                return p
            if len(p['materials']) >= 3 or sum(m['pageCount'] for m in p['materials']) + len(pages) > 150:
                raise UserError('每个项目最多3份材料、合计150页，请新建项目。')
            if sum(len(t.strip()) for t in pages) < 30:
                raise UserError('可提取文字不足，可能是扫描件。首版不支持OCR，请粘贴文字。')
            if sum(map(len, pages)) > 300000:
                raise UserError('解析文字超过30万字符，请拆分材料。')
            mid, chunks = uid(), []
            for page_no, text in enumerate(pages, 1):
                if len(text.strip()) < 40:
                    warnings.append(f'第{page_no}页文字较少，可能包含未理解的图片或图表。')
                paragraphs = [x.strip() for x in text.replace('\r', '').split('\n\n') if x.strip()]
                for para_no, para in enumerate(paragraphs, 1):
                    for part in range(0, len(para), 1800):
                        chunks.append({'id': f'{mid}-p{page_no}-{para_no}-{part//1800}', 'materialId': mid, 'materialName': body.name,
                                       'page': page_no if body.pdf else None, 'location': f'PDF物理第{page_no}页 · 段落{para_no}' if body.pdf else f'文字段落{para_no}', 'text': para[part:part+1800]})
            m = {'id': mid, 'name': body.name, 'digest': digest, 'pageCount': len(pages), 'kind': 'pdf' if body.pdf else 'text', 'chunks': chunks, 'warnings': warnings,
                 'status': 'ready', 'createdAt': now(), 'pdf': body.pdf}
            p['materials'].append(m)
            if p['profile']:
                p['profile']['confirmedAt'] = None
                p['profile']['stale'] = True
            store.save(p)
            return {**p, 'materials': [{k: v for k, v in m.items() if k != 'pdf'} for m in p['materials']]}

    @app.post('/examples/{eid}/clone')
    def clone(eid: str):
        example = next((x for x in EXAMPLES if x['id'] == eid), None)
        if not example:
            raise UserError('示例不存在。', 404)
        p = create(Title(title=example['title']))
        material(p['id'], MaterialInput(name='自编虚构教学材料 · ' + example['title'], text=example['text']))
        return store.get(p['id'])

    @app.post('/projects/{pid}/profile/generate')
    def generate_profile(pid: str, body: dict):
        with store.lock:
            p = store.get(pid)
            chunks = [c for m in p['materials'] for c in m['chunks']]
            if not chunks:
                raise UserError('请先导入材料。')
            demo = body.get('demo', True)
            if not demo and not body.get('consent'):
                raise UserError('请确认将相关材料文本发送到配置的模型服务。')
            items = engine.profile(chunks, demo)
            version = (p['profile']['version'] if p['profile'] else 0) + 1
            p['profile'] = {'version': version, 'items': items, 'confirmedAt': None, 'createdAt': now(), 'stale': False, 'demo': demo}
            p['profiles'].append(copy.deepcopy(p['profile']))
            store.save(p)
            return p['profile']

    @app.patch('/projects/{pid}/profile')
    def edit_profile(pid: str, body: ProfileInput):
        with store.lock:
            p = store.get(pid)
            old = p['profile']
            if not old or old['version'] != body.version:
                raise UserError('画像版本发生变化，请重新载入。', 409)
            if len(body.items) != 6 or [i.get('field') for i in body.items] != FIELDS:
                raise UserError('画像必须包含完整的六个字段。')
            chunks = [c for m in p['materials'] for c in m['chunks']]
            for item, previous in zip(body.items, old['items']):
                if not isinstance(item.get('content'), str) or len(item['content']) > 4000:
                    raise UserError('画像内容无效或超过长度限制。')
                # 只有未改动文本可沿用材料引用，用户输入不能伪装成原文。
                if item['content'] != previous['content']:
                    item['sourceType'], item['refs'] = 'user', []
                else:
                    item['sourceType'], item['refs'] = previous['sourceType'], previous['refs']
                try:
                    cited(chunks, item['refs'])
                except ValueError:
                    raise UserError('画像引用已失效，请重新生成。')
            p['profile'] = {**old, 'items': body.items, 'version': old['version']+1, 'confirmedAt': None}
            p['profiles'].append(copy.deepcopy(p['profile']))
            store.save(p)
            return p['profile']

    @app.post('/projects/{pid}/profile/confirm')
    def confirm(pid: str, body: dict):
        with store.lock:
            p = store.get(pid)
            if not p['profile'] or p['profile'].get('stale') or p['profile']['version'] != body.get('version'):
                raise UserError('请先生成并保存当前材料的画像，再确认。', 409)
            p['profile']['confirmedAt'] = now()
            p['profiles'][-1] = copy.deepcopy(p['profile'])
            store.save(p)
            return p['profile']

    @app.post('/projects/{pid}/sessions')
    def start(pid: str, body: StartInput):
        with store.lock:
            p = store.get(pid)
            if not p['profile'] or not p['profile']['confirmedAt'] or p['profile'].get('stale'):
                raise UserError('请先确认当前研究画像。', 409)
            if body.mode not in ['formal', 'coach', 'practice'] or body.minutes not in [10, 12, 15]:
                raise UserError('训练模式或时长无效。')
            if not body.demo and not body.consent:
                raise UserError('请确认将相关材料和回答发送到模型服务。')
            chunks = [c for m in p['materials'] for c in m['chunks']]
            target, dimension = '', '研究问题'
            if body.mode == 'practice':
                source = session_of(p, body.sourceSession)
                finding = next((f for f in (source.get('report') or {}).get('findings', []) if f['id'] == body.findingId), None)
                if not finding:
                    raise UserError('复练需从有效问题卡片启动。')
                chunks, profile = source['chunks'], source['profile']
                target, dimension = finding['reason'], finding['dimension']
            else:
                profile = p['profile']
            s = {'id': uid(), 'mode': body.mode, 'demo': body.demo, 'minutes': body.minutes, 'createdAt': now(), 'deadline': now()+body.minutes*60,
                 'version': 0, 'profile': copy.deepcopy(profile), 'chunks': copy.deepcopy(chunks), 'turns': [], 'status': 'creating', 'report': None,
                 'target': target, 'sourceSession': body.sourceSession, 'findingId': body.findingId, 'requests': {}, 'error': None}
            add_question(s, dimension)
            p['sessions'].append(s)
            store.save(p)
            return s

    @app.get('/projects/{pid}/sessions/{sid}')
    def get_session(pid: str, sid: str):
        with store.lock:
            return session_of(store.get(pid), sid)

    def advance(p, s):
        turn = s['turns'][-1]
        attempt = turn['attempts'][-1]
        if not attempt.get('analysis'):
            if attempt['operation'] == 'skip':
                attempt['analysis'] = {'kind': 'skip', 'action': 'switch', 'category': '回答未说明', 'reason': '本轮已跳过，不据此判断能力。', 'suggestion': '', 'refs': turn['refs'], 'uncertainty': '未作答'}
            else:
                attempt['analysis'] = engine.analyze(s, turn, attempt['text'])
            store.save(p)
        analysis = attempt['analysis']
        if s['mode'] == 'coach' and attempt['operation'] != 'skip' and not s.get('continueCoach'):
            s['status'] = 'reviewing'
            s['error'] = None
            store.save(p)
            return
        limit = 4 if s['mode'] == 'practice' else 12
        if len(s['turns']) >= limit or now() >= s['deadline'] or analysis['action'] == 'finish':
            s['status'], s['endedAt'], s['report'] = 'finished', now(), make_report(s)
        elif analysis['action'] == 'follow' and turn['depth'] < (3 if attempt['operation'] == 'deepen' else 2):
            add_question(s, turn['dimension'], turn, analysis)
        else:
            covered = {t['dimension'] for t in s['turns']}
            remaining = [d for d in DIMENSIONS if d not in covered]
            if not remaining or s['mode'] == 'practice':
                s['status'], s['endedAt'], s['report'] = 'finished', now(), make_report(s)
            else:
                add_question(s, remaining[0])
        s['continueCoach'] = False
        s['error'] = None
        store.save(p)

    @app.post('/projects/{pid}/sessions/{sid}/answers')
    def answer(pid: str, sid: str, body: AnswerInput):
        with store.lock:
            p = store.get(pid)
            s = session_of(p, sid)
            if body.requestId in s['requests']:
                return s
            if s['status'] not in ['waiting', 'reviewing'] or s['version'] != body.version:
                raise UserError('训练状态已变化，请恢复最新记录后操作。', 409)
            if body.operation not in ['answer', 'skip', 'retry', 'deepen']:
                raise UserError('回答操作无效。')
            if body.operation != 'skip' and not body.text.strip():
                raise UserError('请填写回答，或选择暂时跳过。')
            if body.operation == 'retry' and s['mode'] != 'coach':
                raise UserError('仅教练陪练支持重新回答。')
            turn = s['turns'][-1]
            if len(turn['attempts']) >= 5:
                raise UserError('本题已达5次尝试上限，请结束并查看复盘。')
            turn['attempts'].append({'id': uid(), 'text': body.text.strip(), 'operation': body.operation, 'createdAt': now(), 'analysis': None})
            s['status'], s['error'] = 'pending', None
            s['version'] += 1
            s['requests'][body.requestId] = True
            store.save(p)  # 先提交回答，模型故障不会丢失。
            try:
                advance(p, s)
            except UserError as exc:
                s['error'] = exc.message
                store.save(p)
            return s

    @app.post('/projects/{pid}/sessions/{sid}/next')
    def coach_next(pid: str, sid: str):
        with store.lock:
            p = store.get(pid)
            s = session_of(p, sid)
            if s['mode'] != 'coach' or s['status'] != 'reviewing':
                raise UserError('当前无法进入下一题。', 409)
            s['continueCoach'], s['status'] = True, 'pending'
            store.save(p)
            try:
                advance(p, s)
            except UserError as exc:
                s['error'] = exc.message
                store.save(p)
            return s

    @app.post('/projects/{pid}/sessions/{sid}/retry')
    def retry(pid: str, sid: str):
        with store.lock:
            p = store.get(pid)
            s = session_of(p, sid)
            if s['status'] != 'pending':
                return s
            try:
                advance(p, s)
            except UserError as exc:
                s['error'] = exc.message
                store.save(p)
            return s

    @app.post('/projects/{pid}/sessions/{sid}/finish')
    def finish(pid: str, sid: str):
        with store.lock:
            p = store.get(pid)
            s = session_of(p, sid)
            if s['status'] != 'finished':
                s['status'], s['endedAt'], s['report'] = 'finished', now(), make_report(s)
                s['version'] += 1
                store.save(p)
            return s

    @app.post('/projects/{pid}/sessions/{sid}/hints')
    def hints(pid: str, sid: str, body: dict):
        with store.lock:
            p = store.get(pid)
            s = session_of(p, sid)
            if s['mode'] == 'formal':
                raise UserError('正式模拟结束前不提供提示。', 403)
            turn = s['turns'][-1]
            if 'hints' not in turn:
                if s['demo']:
                    quote = turn['refs'][0]['quote'] if turn['refs'] else '当前材料未找到可直接使用的证据。'
                    turn['hints'] = ['先明确评审在问什么，再区分已验证与尚未验证的内容。', '按“主张 → 材料依据 → 适用条件 → 验证计划”组织。', '可核对的材料摘录：' + quote + '。请用自己的话解释；没有完成的实验应明确承认。']
                else:
                    def validate(d):
                        if not isinstance(d['hints'], list) or len(d['hints']) != 3 or any(not isinstance(h, str) or len(h)>2000 for h in d['hints']):
                            raise ValueError()
                        return d['hints']
                    turn['hints'] = engine.generate('返回 {"hints":["思路","回答结构","仅基于材料的示例，不补造结果"]}。', {'question': turn['question'], 'refs': turn['refs'], 'profile': s['profile']}, validate)
                store.save(p)
            return {'hints': turn['hints']}

    @app.patch('/projects/{pid}/sessions/{sid}/actions/{fid}')
    def action(pid: str, sid: str, fid: str, body: dict):
        with store.lock:
            p = store.get(pid)
            s = session_of(p, sid)
            f = next((f for f in (s.get('report') or {}).get('findings', []) if f['id'] == fid), None)
            if not f or type(body.get('done')) is not bool:
                raise UserError('行动任务或状态无效。')
            f['done'] = body['done']
            store.save(p)
            return s

    @app.get('/projects/{pid}/sessions/{sid}/markdown')
    def export(pid: str, sid: str):
        with store.lock:
            p = store.get(pid)
            return {'text': markdown(p, session_of(p, sid))}

    @app.post('/model/configure')
    def configure(body: dict):
        if body.get('mode') not in ['demo', 'live']:
            raise UserError('模型模式无效。')
        engine.configure(body)
        return {'ok': True}

    @app.post('/model/test')
    def model_test():
        if engine.config.get('mode') == 'demo':
            return {'ok': True, 'message': '离线规则演练可用，无需网络。'}
        def validate(d):
            if d.get('ok') is not True:
                raise ValueError()
            return {'ok': True, 'message': '连接成功，模型支持JSON响应。'}
        return engine.generate('连接测试，请返回 {"ok":true}。', {}, validate)

    @app.get('/model/usage')
    def usage():
        return store.usage()

    @app.get('/backup')
    def backup():
        with store.lock:
            return {'schema': 1, 'createdAt': now(), 'projects': store.all()}

    @app.post('/backup/restore')
    def restore(body: dict):
        # 恢复为新增副本，不覆盖已有项目。所有历史引用、ID保留于副本内部。
        if body.get('schema') != 1 or not isinstance(body.get('projects'), list) or len(body['projects']) > 100:
            raise UserError('备份格式不兼容，请选择本软件导出的v1备份。')
        copies = []
        try:
            for p in body['projects']:
                validate_project(p)
                p = copy.deepcopy(p)
                p['id'], p['title'] = uid(), p['title'][:110] + '（恢复副本）'
                copies.append(p)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise UserError('备份数据校验失败，未恢复任何项目。')
        with store.lock, store.db:
            for p in copies:
                store.db.execute('INSERT INTO projects VALUES (?, ?)', (p['id'], json.dumps(p, ensure_ascii=False)))
        return {'restored': len(copies)}

    return app
