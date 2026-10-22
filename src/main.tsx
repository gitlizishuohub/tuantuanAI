import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, ArrowRight, Plus, FileText, FolderOpen, Settings2, ShieldCheck, Clock3, ChevronRight, Check, X, Wind, LayoutDashboard, MessageSquareText, ScanLine, RotateCcw, Upload, Download, Trash2, BookOpen, Sparkles, CircleHelp, Target, CheckCircle2, LoaderCircle, ChevronDown } from 'lucide-react';
import { api, unwrap, type Project, type ProjectBrief, type Example, type Profile, type Session, type Settings, type Ref, type Chunk, type ProfileItem } from './types';
import './style.css';

const modeNames: Record<string, string> = { formal: '正式模拟', coach: '教练陪练', practice: '专项复练' };
const date = (n: number) => new Date(n * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function App() {
  const [page, setPage] = useState('home');
  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<ProjectBrief[]>([]);
  const [examples, setExamples] = useState<Example[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [modal, setModal] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [source, setSource] = useState<Ref[] | null>(null);
  const [minutes, setMinutes] = useState(12);
  const [mode, setMode] = useState('formal');
  const [consent, setConsent] = useState(false);
  const demo = settings?.mode !== 'live';
  const chunks = page === 'defense' || page === 'report' ? session?.chunks ?? [] : project?.materials.flatMap(m => m.chunks) ?? [];

  async function load() {
    const [p, e, s] = await Promise.all([api<ProjectBrief[]>('GET', '/projects'), api<Example[]>('GET', '/examples'), unwrap(window.desktop.settings())]);
    setProjects(p); setExamples(e); setSettings(s);
  }
  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '操作未完成，请重试。'); }
    finally { setBusy(''); }
  }
  useEffect(() => {
    if (!window.desktop) { setError('请通过桌面程序启动答辩风洞。开发时请运行 npm run dev。'); return; }
    void run('正在打开本地工作区', load);
  }, []);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t); } }, [toast]);

  async function openProject(id: string) {
    const p = await api<Project>('GET', `/projects/${id}`);
    setProject(p); setPage('prepare'); setSource(null);
  }
  async function syncProject() {
    if (project) setProject(await api<Project>('GET', `/projects/${project.id}`));
    await load();
  }
  async function clone(id: string) {
    await run('正在创建独立示例项目', async () => {
      const p = await api<Project>('POST', `/examples/${id}/clone`, {});
      await openProject(p.id); await load(); setToast('示例已复制。材料为自编虚构教学案例。');
    });
  }
  function acceptSession(s: Session) {
    setSession(s);
    setProject(p => p ? { ...p, sessions: p.sessions.some(x => x.id === s.id) ? p.sessions.map(x => x.id === s.id ? s : x) : [...p.sessions, s] } : p);
    setPage(s.status === 'finished' ? 'report' : 'defense'); setSource(null);
  }
  async function startSession(practice?: { sourceSession: string; findingId: string }) {
    if (!project) return;
    await run('正在准备首个问题', async () => {
      const s = await api<Session>('POST', `/projects/${project.id}/sessions`, { mode: practice ? 'practice' : mode, minutes, demo, consent, ...practice });
      acceptSession(s); await syncProject();
    });
  }
  const headerTitles: Record<string, string> = { home: '工作台', prepare: '准备室', defense: '答辩室', report: '复盘室', archive: '训练档案', settings: '应用设置' };
  const nav = (p: string) => { setPage(p); setSource(null); };

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" onClick={() => nav('home')}><span className="brand-icon"><Wind size={24}/></span><span>答辩风洞<small>DEFENSE WIND TUNNEL</small></span></a>
      <div className="workspace-label">个人工作空间 <span>LOCAL</span></div>
      <nav>
        <button className={page === 'home' ? 'active' : ''} onClick={() => nav('home')}><LayoutDashboard size={18}/>工作台</button>
        <button className={page === 'prepare' ? 'active' : ''} onClick={() => project ? nav('prepare') : setModal('create')}><FileText size={18}/>准备室{project && <i/>}</button>
        <button className={page === 'defense' ? 'active' : ''} disabled={!session} onClick={() => acceptSession(session!)}><MessageSquareText size={18}/>答辩室</button>
        <button className={page === 'report' ? 'active' : ''} disabled={!session?.report} onClick={() => nav('report')}><ScanLine size={18}/>复盘室</button>
        <button className={page === 'archive' ? 'active' : ''} onClick={() => nav('archive')}><FolderOpen size={18}/>训练档案<span className="nav-count">{projects.length}</span></button>
      </nav>
      <div className="sidebar-note"><span className="tiny-label">每一次追问，都是一次进步</span><p>让研究经得起追问，<br/>让表达更有依据。</p><div className="wind-lines"><i/><i/><i/></div></div>
      <div className="sidebar-bottom"><button onClick={() => nav('settings')} className={page === 'settings' ? 'active' : ''}><Settings2 size={18}/>设置与数据</button><div className="local-status"><span/>本机工作区 <ShieldCheck size={13}/></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumb">我的工作空间 <ChevronRight size={14}/><strong>{headerTitles[page]}</strong></div><div className="topbar-right"><span className={'mode-dot ' + (demo ? '' : 'live')}/>{demo ? '离线规则演练' : 'AI 联网模式'}<span className="divider"/><button className="icon-button" title="使用说明" onClick={() => setModal('help')}><CircleHelp size={19}/></button><div className="avatar">研</div></div></header>
      <div className="page-content">
        {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')}><X size={16}/></button></div>}
        {page === 'home' && <>
          <div className="page-eyebrow"><span/>YOUR RESEARCH, UNDER PRESSURE</div>
          <div className="heading-row"><div><h1>让研究，经得起追问<span className="green">。</span></h1><p className="subtitle">从材料中的一个主张出发，把每一次答辩变成有依据的进步。</p></div><button className="primary" onClick={() => { setName(''); setModal('create'); }}><Plus size={17}/>新建研究项目</button></div>
          <section className="hero">
            <div className="hero-copy"><span className="pill"><span className="tiny-dot"/>你的下一场答辩，从这里开始</span><h2>不是多练几遍。<br/>是把问题，再想深一层。</h2><p>读懂材料 · 多视角追问 · 有依据的复盘<br/>围绕你的研究，完成一场真正有收获的文字训练。</p><button className="dark-button" onClick={() => void clone('vision')}>体验示例项目 <ArrowUpRight size={17}/></button><small>无需准备论文 · 自编教学案例 · 可离线体验流程</small></div>
            <div className="hero-visual" aria-hidden="true"><div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="orbit orbit-c"/><div className="visual-axis"/><div className="visual-core"><Wind size={46}/><span>研究主张</span><small>CLAIM → EVIDENCE</small></div><span className="float-label fl-a"><span/>方法评审</span><span className="float-label fl-b"><span/>证据评审</span><span className="float-label fl-c"><span/>应用评审</span><div className="visual-caption">THINK DEEPER. DEFEND BETTER.</div></div>
          </section>
          <div className="section-title"><h2>一条清晰的训练路径</h2><span>从准备，到下一次进步</span></div>
          <div className="path-grid">{[{ n: '01', icon: FileText, title: '导入研究材料', text: '文本型 PDF 或研究说明，保留每一处来源。' }, { n: '02', icon: ShieldCheck, title: '确认研究画像', text: '核对问题、方法与主张，让提问围绕你的研究。' }, { n: '03', icon: MessageSquareText, title: '接受多视角追问', text: '正式模拟或教练陪练，追问随回答推进。' }, { n: '04', icon: Target, title: '复盘与专项复练', text: '把薄弱点变成可执行任务，再练一次。' }].map(x => <div className="path-card" key={x.n}><div className="path-card-top"><x.icon size={21}/><span>{x.n}</span></div><h3>{x.title}</h3><p>{x.text}</p></div>)}</div>
          <div className="section-title"><h2>从一个示例开始 <span className="badge">自编教学案例</span></h2><span>两种研究，两类值得追问的问题</span></div>
          <div className="example-grid">{examples.map((e, i) => <button className="example-card" key={e.id} onClick={() => void clone(e.id)}><div className={'example-art art-' + i}>{i ? <Target size={30}/> : <ScanLine size={30}/>}<span>CASE 0{i+1}</span></div><div><span className="tiny-label green">{e.tag}</span><h3>{e.title}</h3><p>{e.description}</p></div><ArrowUpRight size={20}/></button>)}</div>
          <div className="privacy-footer"><ShieldCheck size={15}/><span>材料与训练记录保存在本机。启用 AI 时，相关文本会发送到你配置的模型服务。</span><button onClick={() => nav('settings')}>数据管理 <ArrowRight size={13}/></button></div>
        </>}

        {page === 'prepare' && project && <>
          <PageHeading eyebrow="PREPARATION ROOM" title={project.title} subtitle="先核对材料与研究画像，再带着明确的目标进入答辩。"/>
          <div className="step-bar"><span className={project.materials.length ? 'complete' : 'current'}>1 <b>导入材料</b></span><i/><span className={project.profile?.confirmedAt ? 'complete' : 'current'}>2 <b>确认研究画像</b></span><i/><span>3 <b>开始训练</b></span></div>
          <div className="prepare-grid"><div>
            <section className="panel"><div className="panel-title"><h2><FileText size={18}/>研究材料</h2><span>{project.materials.length} / 3 份</span></div><p className="muted small">材料副本保存在本机，PDF按实际页序引用。暂不支持扫描件、OCR与复杂图表理解。</p>
              <div className="material-list">{project.materials.map(m => <div className="material" key={m.id}><span className="file-icon"><FileText size={20}/></span><div><strong>{m.name}</strong><small>{m.pageCount} 页 / 文字材料 · {m.chunks.length} 个来源段落</small>{m.warnings.map(w => <small className="amber" key={w}>{w}</small>)}</div><button className="text-button" onClick={() => setSource(m.chunks.map(c => ({ chunkId: c.id, quote: c.text })))}>查看来源</button><CheckCircle2 size={17} className="green"/></div>)}</div>
              <div className="import-row"><button className="secondary" disabled={project.materials.length >= 3} onClick={() => void run('正在解析PDF并建立来源索引', async () => { const p = await unwrap(window.desktop.importPdf(project.id)); if (p) { setProject(p); await load(); } })}><Upload size={16}/>导入 PDF</button><button className="secondary" disabled={project.materials.length >= 3} onClick={() => { setName('研究说明'); setText(''); setModal('text'); }}><Plus size={16}/>粘贴文字</button><span>20 MB / 文件 · 最多100页</span></div>
            </section>
            <section className="panel profile-panel"><div className="panel-title"><h2><ScanLine size={18}/>研究画像 <span className="badge">{project.profile ? 'v' + project.profile.version : '待生成'}</span></h2><button className="text-button" disabled={!project.materials.length || (!demo && !consent)} onClick={() => void run('正在提取六类研究信息并校验引用', async () => { const p = await api<Profile>('POST', `/projects/${project.id}/profile/generate`, { demo, consent }); setProject({ ...project, profile: p }); })}><Sparkles size={15}/>{project.profile ? '重新生成' : '生成画像'}</button></div>
              {project.profile ? <ProfileEditor key={project.profile.version} profile={project.profile} onSource={setSource} onSave={items => void run('正在保存画像新版本', async () => { const p = await api<Profile>('PATCH', `/projects/${project.id}/profile`, { version: project.profile!.version, items }); setProject({ ...project, profile: p }); setToast('已保存新版本，请重新确认。'); })} onConfirm={() => void run('正在确认研究画像', async () => { const p = await api<Profile>('POST', `/projects/${project.id}/profile/confirm`, { version: project.profile!.version }); setProject({ ...project, profile: p }); })}/>
              : <div className="empty compact"><ScanLine size={32}/><h3>把材料变成可核对的研究画像</h3><p>{demo ? '离线模式提取“研究问题：”等六个显式标签，其他内容可手动补充。' : 'AI 将从相关材料中提取主张和出处，生成后请逐项核对。'}</p></div>}
            </section>
          </div><aside><section className="panel training-config"><span className="tiny-label green">NEXT STEP</span><h2>准备好接受追问了吗？</h2><p className="muted small">确认画像后，选择适合当前阶段的训练方式。</p><label>训练模式</label>{['formal', 'coach'].map(m => <button className={'mode-option ' + (mode === m ? 'selected' : '')} onClick={() => setMode(m)} key={m}><div>{m === 'formal' ? <Clock3 size={19}/> : <BookOpen size={19}/>}<span><b>{modeNames[m]}</b><small>{m === 'formal' ? '独立作答，结束后统一复盘' : '逐层提示，保留多次回答尝试'}</small></span></div><span className="radio-dot"/></button>)}<label>目标时长</label><div className="segmented">{[10, 12, 15].map(n => <button key={n} className={minutes === n ? 'selected' : ''} onClick={() => setMinutes(n)}>{n} 分钟</button>)}</div><p className="muted small">最多12题。到时后可提交当前回答，再生成复盘。</p><div className="mode-notice"><ShieldCheck size={17}/><span>{demo ? '当前为离线规则演练。可体验完整流程，反馈不代表真实 AI 质量。' : 'AI 模式将发送相关材料、画像和必要问答记录至配置的模型服务。'}</span></div>{!demo && <label className="checkbox-line"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>我同意将上述相关文本发送到配置的模型服务</label>}<button className="primary full" disabled={!project.profile?.confirmedAt || project.profile.stale || (!demo && !consent)} onClick={() => void startSession()}>进入答辩室 <ArrowRight size={17}/></button></section><div className="quiet-note"><CircleHelp size={17}/><p>“未找到”也可以保留。研究画像不替你补造材料里不存在的证据。</p></div></aside></div>
          {project.sessions.length > 0 && <section className="panel"><div className="panel-title"><h2>本项目训练记录</h2><span>{project.sessions.length} 次</span></div><SessionList sessions={project.sessions} onOpen={s => acceptSession(s)}/></section>}
        </>}

        {page === 'defense' && session && project && <Defense key={session.id} session={session} projectId={project.id} onSource={setSource} onUpdate={acceptSession} run={run}/>}

        {page === 'report' && session?.report && project && <>
          <div className="heading-row"><PageHeading eyebrow="REFLECTION ROOM" title="把这次追问，变成下一步行动。" subtitle={`${project.title} · ${modeNames[session.mode]} · ${date(session.createdAt)}`}/><button className="secondary" onClick={() => void run('正在导出Markdown报告', async () => { if (await unwrap(window.desktop.exportReport(project.id, session.id))) setToast('报告已保存。'); })}><Download size={16}/>导出报告</button></div>
          <div className="report-intro"><ShieldCheck size={21}/><p>{session.report.summary}{session.mode === 'practice' && ' 复练仅反映本次表达；不能据此认定研究证据已补充。'}</p></div>
          <div className="section-title"><h2>五维覆盖与风险</h2><span>未覆盖的维度，不作能力判断</span></div><div className="risk-grid">{Object.entries(session.report.coverage).map(([d, state], i) => <div className={'risk-card ' + (state === '需关注' ? 'attention' : '')} key={d}><span>0{i+1}</span><h3>{d}</h3><strong>{state}</strong><div className="risk-line"/></div>)}</div>
          <div className="section-title"><h2>重点问题与行动 <span className="badge">{session.report.findings.length}</span></h2><span>勾选代表完成任务记录，仍需验证实际改善</span></div>
          {session.report.findings.length === 0 && <div className="panel empty compact"><CheckCircle2 size={30}/><h3>本次未生成重点问题卡片</h3><p>可能尚未充分作答或没有触发反馈条件。这不等于研究没有问题。</p></div>}
          <div className="findings">{session.report.findings.map((f, i) => <section className="panel finding" key={f.id}><div className="finding-number">{String(i+1).padStart(2, '0')}</div><div className="finding-content"><div className="finding-labels"><span className="badge amber">{f.category}</span><span className="tiny-label">{f.dimension} · {f.priority}</span></div><h3>{f.reason}</h3><div className="quoted-answer"><small>本次回答</small><p>{f.answer}</p></div><p className="muted small">{f.uncertainty}</p><Citations refs={f.refs} onClick={setSource}/><div className="action-task"><label className="checkbox-line"><input type="checkbox" checked={f.done} onChange={e => void run('正在更新行动记录', async () => acceptSession(await api<Session>('PATCH', `/projects/${project.id}/sessions/${session.id}/actions/${f.id}`, { done: e.target.checked })))}/><strong>{f.actionType}：{f.suggestion}</strong></label><small>完成标准：{f.criterion}</small></div><div className="finding-bottom"><button className="text-button" onClick={() => document.getElementById(f.turnId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>定位对应问答 <ChevronDown size={14}/></button><button className="secondary" disabled={!demo && !consent} onClick={() => void startSession({ sourceSession: session.id, findingId: f.id })}><RotateCcw size={15}/>针对这一点复练 <ArrowUpRight size={14}/></button></div></div></section>)}</div>
          {!demo && <label className="checkbox-line"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>专项复练时，允许向配置的模型服务发送此训练相关材料与问答</label>}
          <div className="section-title"><h2>追问树与完整回放</h2><span>保留所有作答尝试与父子关系</span></div><section className="panel replay">{session.turns.map(t => <div className="replay-turn" style={{ marginLeft: t.depth * 22 }} key={t.id} id={t.id}><span className="turn-node">{t.number}</span><small>{t.role} · {t.dimension} · {t.parentId ? '追问深度 ' + t.depth : '根问题'}</small><h3>{t.question}</h3><Citations refs={t.refs} onClick={setSource}/>{t.attempts.map((a, i) => <div className="replay-answer" key={a.id}><small>尝试 {i+1} · {a.operation === 'skip' ? '已跳过' : '已保存'}</small><p>{a.text || '本轮未作答'}</p>{a.analysis && <p className="muted small">{a.analysis.reason}</p>}</div>)}</div>)}</section>
        </>}

        {page === 'archive' && <>
          <div className="heading-row"><PageHeading eyebrow="RESEARCH ARCHIVE" title="每一次训练，都留下进步的线索。" subtitle="查看本机项目，恢复已提交的问答，或回到报告继续复练。"/><button className="primary" onClick={() => { setName(''); setModal('create'); }}><Plus size={17}/>新建项目</button></div>
          {projects.length ? <div className="archive-list">{projects.map(p => <div className="panel archive-project" key={p.id}><div className="archive-icon"><FolderOpen size={25}/></div><div><h3>{p.title}</h3><p className="muted small">{p.materialCount} 份材料 · {p.sessionCount} 次训练 · 最近更新 {date(p.updatedAt)}</p></div><button className="secondary" onClick={() => void run('正在打开项目', () => openProject(p.id))}>打开项目 <ArrowRight size={15}/></button><button className="icon-button danger" title="删除项目" onClick={() => { setName(p.id); setModal('delete'); }}><Trash2 size={17}/></button></div>)}</div> : <div className="panel empty"><FolderOpen size={36}/><h3>你的第一份训练档案，从一次尝试开始</h3><p>先创建一个项目，或使用首页的教学示例。</p><button className="primary" onClick={() => nav('home')}>去体验示例 <ArrowRight size={16}/></button></div>}
        </>}

        {page === 'settings' && settings && <SettingsPage settings={settings} run={run} onSaved={s => { setSettings(s); setConsent(false); setToast('模型设置已保存。'); }} onReload={load} notify={setToast}/>}
      </div>
      <footer className="app-footer"><span>答辩风洞 <span className="muted">/</span> 让研究经得起追问</span><span>本科理工科文字训练 · v0.1.0</span></footer>
    </main>

    {source && <div className="drawer-backdrop" onClick={() => setSource(null)}><aside className="source-drawer" onClick={e => e.stopPropagation()}><div className="panel-title"><h2><BookOpen size={19}/>材料来源</h2><button className="icon-button" onClick={() => setSource(null)}><X size={20}/></button></div><p className="muted small">PDF以物理页序定位。以下展示可提取文字，未理解图片与图表。</p>{source.length ? source.map((ref, i) => { const c: Chunk | undefined = chunks.find(c => c.id === ref.chunkId); return <div className="source-entry" key={i}><span className="tiny-label green">{c?.materialName ?? '来源不可用'}</span><h3>{c?.location ?? ref.chunkId}</h3><blockquote>{ref.quote}</blockquote>{c && <details><summary>查看完整段落</summary><p>{c.text}</p><small className="muted">ID: {c.id}</small></details>}</div>; }) : <div className="empty compact"><p>本条为用户补充或尚未找到出处，不能当作材料原文。</p></div>}</aside></div>}
    {modal && <div className="modal-backdrop" onClick={() => setModal('')}><div className="modal" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" onClick={() => setModal('')}><X size={20}/></button>
      {modal === 'create' && <><span className="tiny-label green">NEW RESEARCH</span><h2>给你的研究一个训练空间。</h2><p className="muted">材料、画像和每次训练会保存在本机项目中。</p><label>研究项目名称<input autoFocus value={name} maxLength={120} placeholder="例如：轻量化校园垃圾分类识别" onChange={e => setName(e.target.value)}/></label><button className="primary full" disabled={!name.trim()} onClick={() => void run('正在创建研究项目', async () => { const p = await api<Project>('POST', '/projects', { title: name }); await openProject(p.id); await load(); setModal(''); })}>创建项目 <ArrowRight size={16}/></button></>}
      {modal === 'text' && <><span className="tiny-label green">IMPORT MATERIAL</span><h2>粘贴研究说明</h2><p className="muted small">最多30,000字符。离线画像支持“研究问题：”“研究目标：”“方法路线：”“核心主张：”“支持证据：”“适用边界：”标签，标签间空行分隔。</p><label>材料名称<input value={name} maxLength={180} onChange={e => setName(e.target.value)}/></label><label>材料内容<textarea rows={10} value={text} maxLength={30000} onChange={e => setText(e.target.value)} placeholder="粘贴你的研究内容，空行可划分为独立来源段落。"/></label><p className="muted small">{text.length.toLocaleString()} / 30,000 字符 · 保存副本至本机工作区</p><button className="primary full" disabled={!name.trim() || text.trim().length < 30} onClick={() => void run('正在建立文字来源索引', async () => { await api('POST', `/projects/${project!.id}/materials`, { name, text }); await syncProject(); setModal(''); })}>导入材料 <Check size={16}/></button></>}
      {modal === 'delete' && <><h2>删除这个项目？</h2><p>将删除应用管理的材料副本、解析文本、画像、训练和报告。此操作无法撤销。</p><p className="muted small">原始文件、已另存的报告、备份以及恢复前自动备份仍会保留。模型服务方的数据保留由其规则决定。</p><div className="button-row"><button className="secondary" onClick={() => setModal('')}>取消</button><button className="danger-button" onClick={() => void run('正在删除项目及关联记录', async () => { await api('DELETE', `/projects/${name}`); if (project?.id === name) { setProject(null); setSession(null); } await load(); setModal(''); setToast('项目已从本机工作区删除。'); })}>确认删除</button></div></>}
      {modal === 'help' && <><span className="tiny-label green">QUICK START</span><h2>完成你的第一场训练</h2><ol className="help-list"><li>使用首页示例，或新建项目导入文本PDF、粘贴研究说明。</li><li>生成六类研究画像，点击来源核对；修正后保存并确认。</li><li>选择正式模拟或教练陪练，逐题回答。可跳过或随时结束。</li><li>在复盘室查看出处、行动和问答；从问题卡片启动专项复练。</li></ol><div className="mode-notice">默认使用离线规则演练。真实 AI 需在设置中填写兼容接口、模型名称和个人密钥。离线查看历史和导出无需联网。</div></>}
    </div></div>}
    {busy && <div className="busy-backdrop" role="status"><div><LoaderCircle className="spin" size={25}/><strong>{busy}</strong><small>请稍候，已提交内容会保留在本机。</small></div></div>}
    {toast && <div className="toast" role="status"><CheckCircle2 size={18}/>{toast}</div>}
  </div>;
}

function PageHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) { return <div className="page-heading"><div className="page-eyebrow"><span/>{eyebrow}</div><h1>{title}</h1><p className="subtitle">{subtitle}</p></div>; }
function Citations({ refs, onClick }: { refs: Ref[]; onClick: (r: Ref[]) => void }) { return <button className="citation" onClick={() => onClick(refs)}><BookOpen size={13}/>{refs.length ? refs.length + ' 处材料依据' : '用户补充 / 未找到出处'}<ArrowUpRight size={12}/></button>; }
function ProfileEditor({ profile, onSource, onSave, onConfirm }: { profile: Profile; onSource: (r: Ref[]) => void; onSave: (items: ProfileItem[]) => void; onConfirm: () => void }) {
  const [items, setItems] = useState(profile.items);
  const changed = JSON.stringify(items) !== JSON.stringify(profile.items);
  return <><div className="profile-notice">{profile.stale ? '材料有更新，请重新生成画像。' : profile.confirmedAt ? '已确认。后续训练使用此版本，历史训练仍保留原快照。' : '逐项核对后主动确认；修改的内容将标记为用户补充。'}</div>{items.map((item, i) => <div className="profile-field" key={item.field}><div><label htmlFor={'profile-' + i}><span>0{i+1}</span>{item.field}</label><span className="tiny-label">{item.content !== profile.items[i].content || item.sourceType === 'user' ? '用户补充' : item.sourceType === 'missing' ? '未找到' : profile.demo ? '显式标签提取' : '系统归纳'}</span></div><textarea id={'profile-' + i} rows={2} value={item.content} placeholder="材料中未找到，可保留空白或补充说明" maxLength={4000} onChange={e => setItems(items.map((x, j) => i === j ? { ...x, content: e.target.value } : x))}/><Citations refs={item.content === profile.items[i].content ? item.refs : []} onClick={onSource}/></div>)}<div className="profile-actions"><span className="muted small">{changed ? '存在未保存修改' : profile.confirmedAt ? '当前版本已确认' : '当前版本待确认'}</span>{changed ? <button className="primary" onClick={() => onSave(items)}>保存画像新版本 <Check size={15}/></button> : <button className="primary" disabled={!!profile.confirmedAt || profile.stale} onClick={onConfirm}><ShieldCheck size={16}/>{profile.confirmedAt ? '已确认画像' : '确认画像，可开始训练'}</button>}</div></>;
}
function SessionList({ sessions, onOpen }: { sessions: Session[]; onOpen: (s: Session) => void }) { return <div>{[...sessions].reverse().map(s => <button className="session-row" key={s.id} onClick={() => onOpen(s)}><MessageSquareText size={18}/><div><strong>{modeNames[s.mode]}</strong><small>{date(s.createdAt)} · {s.turns.length} 轮 · {s.demo ? '离线规则' : 'AI 联网'}</small></div><span className="badge">{s.status === 'finished' ? '已复盘' : '可继续'}</span><ArrowRight size={17}/></button>)}</div>; }

function Defense({ session: s, projectId, onSource, onUpdate, run }: { session: Session; projectId: string; onSource: (r: Ref[]) => void; onUpdate: (s: Session) => void; run: (label: string, fn: () => Promise<void>) => Promise<void> }) {
  const turn = s.turns[s.turns.length - 1];
  const draftKey = 'draft-' + projectId + '-' + s.id + '-' + turn.id;
  const [answer, setAnswer] = useState(() => localStorage.getItem(draftKey) ?? '');
  const [hints, setHints] = useState<string[]>([]);
  const [hintLevel, setHintLevel] = useState(0);
  const [seconds, setSeconds] = useState(Math.max(0, Math.ceil(s.deadline - Date.now()/1000)));
  const [finishConfirm, setFinishConfirm] = useState(false);
  useEffect(() => { setAnswer(localStorage.getItem(draftKey) ?? ''); setHints([]); setHintLevel(0); }, [draftKey]);
  useEffect(() => { const t = setInterval(() => setSeconds(Math.max(0, Math.ceil(s.deadline - Date.now()/1000))), 1000); return () => clearInterval(t); }, [s.deadline]);
  const path = `/projects/${projectId}/sessions/${s.id}`;
  async function submit(operation: string) {
    await run('正在保存回答并安排下一步', async () => {
      const next = await api<Session>('POST', path + '/answers', { requestId: crypto.randomUUID(), version: s.version, text: operation === 'skip' ? '' : answer, operation });
      localStorage.removeItem(draftKey); setAnswer(''); onUpdate(next);
    });
  }
  const lastAnalysis = turn.attempts.at(-1)?.analysis;
  return <>
    <div className="heading-row"><PageHeading eyebrow="DEFENSE ROOM" title={s.mode === 'practice' ? '换个角度，再回答一次。' : '把你的研究，讲清楚。'} subtitle={`${modeNames[s.mode]} · ${s.demo ? '离线规则演练，不评价真实研究质量' : '基于材料与当前回答进行 AI 追问'}`}/><div className={'timer ' + (!seconds ? 'amber' : '')}><Clock3 size={19}/><strong>{Math.floor(seconds/60).toString().padStart(2, '0')}:{(seconds%60).toString().padStart(2, '0')}</strong><small>剩余时间</small></div></div>
    {!seconds && <div className="mode-notice">目标时间已到。你可以提交当前回答，再查看复盘，不会截断正在输入的内容。</div>}
    <div className="defense-grid"><section className="panel question-panel"><div className="question-meta"><span className="pill">{turn.role}</span><span className="tiny-label">{turn.dimension} · {turn.depth ? '第 ' + turn.depth + ' 层追问' : '新主题'}</span><span className="question-count">{turn.number.toString().padStart(2, '0')} <small>/ {s.mode === 'practice' ? '04' : '12'}</small></span></div><h2>{turn.question}</h2><Citations refs={turn.refs} onClick={onSource}/><div className="answer-divider"/><div className="answer-label"><label htmlFor="defense-answer">你的回答</label><span>草稿自动保存在本机</span></div><textarea id="defense-answer" className="answer-input" value={answer} maxLength={8000} rows={9} placeholder="先说清楚你的主张，再给出依据。还没有验证的内容，也可以坦诚说明。" disabled={s.status === 'pending'} onChange={e => { setAnswer(e.target.value); localStorage.setItem(draftKey, e.target.value); }}/><div className="answer-bottom"><span>{answer.length} / 8,000</span><span>每题最多5次作答尝试</span></div>
      {s.status === 'pending' ? <div className="pending-box"><h3>回答已保存，下一步尚未完成</h3><p>{s.error || '上次处理未完成，可能发生了服务重启。可以重试或直接结束。'}</p><button className="primary" onClick={() => void run('正在继续处理已保存回答', async () => onUpdate(await api<Session>('POST', path + '/retry', {})))}><RotateCcw size={15}/>重试后续生成</button></div> : <div className="answer-actions"><button className="text-button muted" onClick={() => void submit('skip')}>暂时跳过</button><div>{s.status === 'reviewing' ? <><button className="secondary" disabled={!answer.trim()} onClick={() => void submit('retry')}><RotateCcw size={15}/>保存重答</button><button className="primary" onClick={() => void run('正在安排下一题', async () => onUpdate(await api<Session>('POST', path + '/next', {})))}>继续下一步 <ArrowRight size={16}/></button></> : <><button className="secondary" disabled={!answer.trim()} onClick={() => void submit('deepen')}>回答并继续深挖</button><button className="primary" disabled={!answer.trim()} onClick={() => void submit('answer')}>提交回答 <ArrowRight size={16}/></button></>}</div></div>}
      {s.mode !== 'formal' && lastAnalysis && <div className="coach-feedback"><span className="tiny-label green">教练反馈 · 本题最新尝试</span><h3>{lastAnalysis.reason}</h3><p>{lastAnalysis.suggestion}</p><small>{lastAnalysis.uncertainty}</small></div>}
    </section><aside><section className="panel"><div className="panel-title"><h2>训练进程</h2><span>{s.turns.length} 轮</span></div><div className="progress-topics">{['研究问题', '方法', '证据', '创新', '边界'].map(d => <div className={d === turn.dimension ? 'current' : ''} key={d}><span className="topic-dot"/><span>{d}</span><small>{s.turns.some(t => t.dimension === d && t.attempts.length) ? '已讨论' : d === turn.dimension ? '当前主题' : '待覆盖'}</small></div>)}</div><p className="muted small">程序控制追问深度和总轮数。覆盖不等于掌握，复盘以具体问答为依据。</p></section>
      {s.mode !== 'formal' && <section className="panel"><div className="panel-title"><h2><Sparkles size={17}/>教练提示</h2></div><p className="muted small">先独立思考，需要时再逐层展开。</p>{hints.slice(0, hintLevel).map((h, i) => <div className="hint" key={i}><span className="tiny-label green">{['01 思路', '02 结构', '03 材料示例'][i]}</span><p>{h}</p></div>)}<button className="secondary full" disabled={hintLevel >= 3} onClick={() => void run('正在准备教练提示', async () => { if (!hints.length) { const h = await api<{ hints: string[] }>('POST', path + '/hints', {}); setHints(h.hints); } setHintLevel(x => Math.min(3, x+1)); })}>展开{['思路', '结构', '示例'][hintLevel] ?? '完毕'} <ChevronDown size={15}/></button></section>}
      <section className="panel finish-panel"><h3>准备好回看这次训练了吗？</h3><p className="muted small">可以随时结束，已作答内容会生成复盘。未覆盖维度会单独标记。</p>{finishConfirm ? <><p className="amber small">确认结束？当前未提交草稿不会计入报告。</p><div className="button-row"><button className="secondary" onClick={() => setFinishConfirm(false)}>继续训练</button><button className="primary" onClick={() => void run('正在整理问答与行动清单', async () => onUpdate(await api<Session>('POST', path + '/finish', {})))}>确认结束</button></div></> : <button className="secondary full" onClick={() => setFinishConfirm(true)}>结束并查看复盘 <ArrowUpRight size={15}/></button>}</section>
    </aside></div>
  </>;
}

function SettingsPage({ settings: s, run, onSaved, onReload, notify }: { settings: Settings; run: (label: string, fn: () => Promise<void>) => Promise<void>; onSaved: (s: Settings) => void; onReload: () => Promise<void>; notify: (t: string) => void }) {
  const [mode, setMode] = useState(s.mode);
  const [url, setUrl] = useState(s.baseUrl);
  const [model, setModel] = useState(s.model);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  return <><PageHeading eyebrow="SETTINGS & DATA" title="你的模型，你的本地工作区。" subtitle="配置真实 AI 服务，或使用无需联网的规则演练。"/><div className="settings-grid"><section className="panel"><div className="panel-title"><h2><Settings2 size={18}/>模型连接</h2><span className="badge">OpenAI 兼容接口</span></div><label>运行模式<select value={mode} onChange={e => setMode(e.target.value)}><option value="demo">离线规则演练（不调用模型）</option><option value="live">真实 AI 联网模式</option></select></label><label>模型服务 Base URL<input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://服务地址/v1"/></label><label>模型名称<input value={model} onChange={e => setModel(e.target.value)} placeholder="填写服务商提供的可用模型 ID"/></label><label>个人 API Key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={s.hasKey ? '已加密保存，留空保留原密钥' : '输入你的个人密钥'}/></label>{s.hasKey && <label className="checkbox-line"><input type="checkbox" checked={clearKey} onChange={e => setClearKey(e.target.checked)}/>清除已保存密钥</label>}<p className="muted small">密钥通过 Windows 系统加密保存，不包含在项目备份、报告和前端资源中。模型调用由服务商计费；材料保留规则按其约定。</p><div className="button-row"><button className="primary" onClick={() => void run('正在安全保存模型配置', async () => { onSaved(await unwrap(window.desktop.saveSettings({ mode, baseUrl: url, model, key, clearKey }))); setKey(''); setClearKey(false); })}>保存设置 <Check size={15}/></button><button className="secondary" onClick={() => void run('正在测试已保存的模型连接', async () => { const r = await unwrap(window.desktop.testConnection()); notify(r.message); })}>测试已保存连接</button></div></section><div><section className="panel"><div className="panel-title"><h2><ShieldCheck size={18}/>数据与备份</h2><span className="badge">LOCAL</span></div><p className="muted small">项目记录保存在当前系统用户的数据目录。卸载和重装默认保留记录。</p><div className="data-path">{s.dataDirectory}</div><button className="secondary full" onClick={() => void run('正在打开数据目录', async () => { await unwrap(window.desktop.openDataDirectory()); })}><FolderOpen size={16}/>打开数据目录</button><div className="data-actions"><button className="secondary" onClick={() => void run('正在导出本机项目备份', async () => { if (await unwrap(window.desktop.backup())) notify('备份已保存，不包含模型密钥。请妥善保管其中的材料。'); })}><Download size={15}/>备份项目</button><button className="secondary" onClick={() => void run('正在恢复项目副本', async () => { const r = await unwrap(window.desktop.restore()); if (r) { await onReload(); notify(`已恢复 ${r.restored} 个项目副本，原项目保留。`); } })}><Upload size={15}/>从备份恢复</button></div><p className="muted small">备份含完整材料和问答，请保存在可信位置。恢复为新增副本，并在数据目录自动保留恢复前备份。</p></section><section className="panel about"><Wind size={28} className="green"/><h3>答辩风洞</h3><p className="muted small">让研究经得起追问 · v{s.version}</p><p className="muted small">面向本科理工科研究的文字训练工具。反馈辅助准备，不替代导师评议，也不预测真实成绩。</p></section></div></div></>;
}

createRoot(document.getElementById('root')!).render(<App/>);
