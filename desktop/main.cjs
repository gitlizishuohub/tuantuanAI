const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const readline = require('node:readline');

let window, worker, port, credential, directory, closing = false;
const root = path.resolve(__dirname, '..');
const devUrl = process.env.DEFENSE_DEV_URL;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw Error('开发地址无效');
if (process.env.DEFENSE_DATA_DIR && (!app.isPackaged || process.env.DEFENSE_TEST === '1')) app.setPath('userData', path.resolve(process.env.DEFENSE_DATA_DIR));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });

async function api(method, route, body) {
  if (!worker || worker.exitCode !== null || !port) throw Error('本地服务未就绪，请重启软件。');
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(190000)
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '操作未完成，请检查输入后重试。');
  return result;
}

const routes = [
  ['GET', /^\/(health|examples|projects|model\/usage)$/],
  ['POST', /^\/projects$/],
  ['POST', /^\/examples\/[a-z]+\/clone$/],
  ['GET', /^\/projects\/[a-f0-9]{32}$/],
  ['DELETE', /^\/projects\/[a-f0-9]{32}$/],
  ['POST', /^\/projects\/[a-f0-9]{32}\/materials$/],
  ['POST', /^\/projects\/[a-f0-9]{32}\/profile\/(generate|confirm)$/],
  ['PATCH', /^\/projects\/[a-f0-9]{32}\/profile$/],
  ['POST', /^\/projects\/[a-f0-9]{32}\/sessions$/],
  ['GET', /^\/projects\/[a-f0-9]{32}\/sessions\/[a-f0-9]{32}$/],
  ['POST', /^\/projects\/[a-f0-9]{32}\/sessions\/[a-f0-9]{32}\/(answers|retry|finish|hints|next)$/],
  ['PATCH', /^\/projects\/[a-f0-9]{32}\/sessions\/[a-f0-9]{32}\/actions\/finding-[a-f0-9]{32}$/]
];
function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw Error('来源无效');
  const url = event.senderFrame.url;
  if (devUrl ? !(url === devUrl + '/' || url === devUrl) : url !== require('node:url').pathToFileURL(path.join(root, 'dist/index.html')).href) throw Error('页面来源无效');
}
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event);
    try { return { ok: true, value: await callback(...args) }; }
    catch (error) { return { ok: false, error: error.message?.replace(/Bearer\s+\S+/g, '[已隐藏]') || '操作失败，请重试。' }; }
  });
}
function validId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw Error('项目或训练编号无效');
  return value;
}

async function readSettings(secret = false) {
  let stored = { mode: 'demo', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '' };
  try { stored = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw Error('设置文件无法读取，请检查数据目录。'); }
  let key = '';
  if (stored.encryptedKey && safeStorage.isEncryptionAvailable()) {
    try { key = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')); } catch { throw Error('系统无法解密原密钥，请在设置中重新填写。'); }
  }
  return { mode: stored.mode, baseUrl: stored.baseUrl, model: stored.model, ...(secret ? { key } : { hasKey: !!key, dataDirectory: directory, version: app.getVersion() }) };
}

async function launchWorker() {
  credential = randomBytes(32).toString('hex');
  const exe = app.isPackaged ? path.join(process.resourcesPath, 'worker/defense-worker.exe') : path.join(root, '.venv/Scripts/python.exe');
  worker = spawn(exe, app.isPackaged ? [] : [path.join(root, 'backend/worker.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1' } });
  await new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: worker.stdout });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(Error('本地工作进程启动超时')), 25000);
    worker.once('error', () => finish(Error('无法启动本地工作进程，请检查安装是否完整。')));
    worker.once('exit', () => {
      finish(Error('本地工作进程意外退出'));
      port = undefined;
      if (window && !closing) dialog.showErrorBox('本地服务已停止', '已提交记录仍保存在本机。请关闭并重新启动软件继续训练。');
    });
    worker.stdin.on('error', () => finish(Error('无法初始化本地工作进程，请检查安装是否完整。')));
    lines.on('line', (line) => {
      try { const data = JSON.parse(line); if (Number.isInteger(data.port) && data.port > 0 && data.port <= 65535) { port = data.port; finish(); } } catch {}
    });
    // 不写入可能包含材料或配置内容的工作进程标准错误。
    worker.stderr.on('data', () => {});
    // Keep the pipe open: the worker detects EOF if the desktop process crashes.
    worker.stdin.write(JSON.stringify({ token: credential, directory }) + '\n');
  });
  for (let n = 0; n < 50; n++) {
    try { await api('GET', '/health'); break; } catch (e) { if (n === 49) throw e; await new Promise(r => setTimeout(r, 100)); }
  }
  await api('POST', '/model/configure', await readSettings(true));
}

handle('api', async ({ method, route, body }) => {
  if (!routes.some(([m, re]) => method === m && re.test(route))) throw Error('不支持此操作');
  if (Buffer.byteLength(JSON.stringify(body ?? {})) > 150000) throw Error('内容过长，请拆分材料。');
  return api(method, route, body);
});
handle('settings-get', () => readSettings());
handle('settings-save', async (s) => {
  if (!['demo', 'live'].includes(s.mode) || typeof s.model !== 'string' || s.model.length > 120 || typeof s.key !== 'string') throw Error('模型设置无效');
  const url = new URL(s.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('模型地址必须使用HTTPS，且不包含账号、查询参数或片段。');
  const previous = await readSettings(true);
  const key = s.clearKey ? '' : (s.key.trim() || previous.key);
  if (key && !safeStorage.isEncryptionAvailable()) throw Error('系统凭据加密当前不可用，无法安全保存密钥。');
  const stored = { mode: s.mode, baseUrl: url.href.replace(/\/$/, ''), model: s.model.trim(), encryptedKey: key ? safeStorage.encryptString(key).toString('base64') : '' };
  await fs.writeFile(path.join(directory, 'settings.json.tmp'), JSON.stringify(stored), 'utf8');
  await fs.rename(path.join(directory, 'settings.json.tmp'), path.join(directory, 'settings.json'));
  await api('POST', '/model/configure', { mode: stored.mode, baseUrl: stored.baseUrl, model: stored.model, key });
  return readSettings();
});
handle('model-test', () => api('POST', '/model/test', {}));
handle('import-pdf', async (projectId) => {
  validId(projectId);
  const pick = await dialog.showOpenDialog(window, { title: '导入文本型PDF', filters: [{ name: 'PDF文档', extensions: ['pdf'] }], properties: ['openFile'] });
  if (pick.canceled) return null;
  const file = pick.filePaths[0];
  if ((await fs.stat(file)).size > 20*1024*1024) throw Error('PDF不能超过20 MB');
  return api('POST', `/projects/${projectId}/materials`, { name: path.basename(file), pdf: (await fs.readFile(file)).toString('base64') });
});
handle('export-report', async ({ projectId, sessionId }) => {
  const data = await api('GET', `/projects/${validId(projectId)}/sessions/${validId(sessionId)}/markdown`);
  const pick = await dialog.showSaveDialog(window, { defaultPath: '答辩风洞-复盘报告.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
  if (pick.canceled) return false;
  await fs.writeFile(pick.filePath, data.text, 'utf8');
  return true;
});
handle('open-data', async () => { const error = await shell.openPath(directory); if (error) throw Error('无法打开数据目录'); return true; });
handle('backup', async () => {
  const pick = await dialog.showSaveDialog(window, { defaultPath: '答辩风洞-本地备份.json', filters: [{ name: '项目备份', extensions: ['json'] }] });
  if (pick.canceled) return false;
  await fs.writeFile(pick.filePath, JSON.stringify(await api('GET', '/backup')), 'utf8');
  return true;
});
handle('restore', async () => {
  const pick = await dialog.showOpenDialog(window, { filters: [{ name: '项目备份', extensions: ['json'] }], properties: ['openFile'] });
  if (pick.canceled) return null;
  if ((await fs.stat(pick.filePaths[0])).size > 100*1024*1024) throw Error('备份超过100 MB，请拆分项目备份。');
  let body;
  try { body = JSON.parse(await fs.readFile(pick.filePaths[0], 'utf8')); } catch { throw Error('备份文件格式无效'); }
  const confirmation = await dialog.showMessageBox(window, { type: 'question', message: '将备份恢复为新增项目副本', detail: '现有项目将保留，恢复后可在档案中查看。备份不包含模型密钥。', buttons: ['取消', '恢复'], defaultId: 0, cancelId: 0 });
  if (confirmation.response !== 1) return null;
  // 恢复前自动保存安全副本，不含凭据。
  await fs.writeFile(path.join(directory, `before-restore-${Date.now()}.json`), JSON.stringify(await api('GET', '/backup')), 'utf8');
  return api('POST', '/backup/restore', body);
});

if (gotLock) app.whenReady().then(async () => {
  directory = app.getPath('userData');
  await fs.mkdir(directory, { recursive: true });
  try {
    await launchWorker();
    window = new BrowserWindow({ width: 1440, height: 940, minWidth: 880, minHeight: 640, backgroundColor: '#f7f8fa', title: '答辩风洞', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', e => e.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('close', e => {
      if (closing || process.env.DEFENSE_TEST) return;
      e.preventDefault();
      dialog.showMessageBox(window, { type: 'question', message: '退出答辩风洞？', detail: '已提交记录保存在本机。当前输入草稿会自动保存；正在生成的任务可在重启后重试。', buttons: ['继续使用', '退出'], defaultId: 0, cancelId: 0 }).then(({ response }) => { if (response === 1) { closing = true; app.quit(); } });
    });
    await (devUrl ? window.loadURL(devUrl) : window.loadFile(path.join(root, 'dist/index.html')));
  } catch (error) { dialog.showErrorBox('答辩风洞启动失败', error.message); app.quit(); }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { closing = true; if (worker && worker.exitCode === null) worker.kill(); });
