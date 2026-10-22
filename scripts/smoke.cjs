const { _electron: electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Runs the built renderer in a real Electron window and an isolated local workspace.
const root = path.resolve(__dirname, '..');
const screenshots = path.join(root, 'docs', 'screenshots');
let app;
let dataDirectory;
const errors = [];
async function launch() {
  const env = { ...process.env, DEFENSE_TEST: '1', DEFENSE_DATA_DIR: dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.DEFENSE_SMOKE_EXECUTABLE && path.resolve(process.env.DEFENSE_SMOKE_EXECUTABLE);
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [root], cwd: root,
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(20000);
  return page;
}
async function settled(page) {
  await page.locator('.busy-backdrop').waitFor({ state: 'hidden' });
  await expect(page.locator('.error-banner')).toHaveCount(0);
}
async function shot(page, name) {
  await settled(page);
  await page.screenshot({ path: path.join(screenshots, name + '.png'), fullPage: true });
}
async function main() {
  await fs.mkdir(screenshots, { recursive: true });
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'defense-smoke-'));
  let page = await launch();
  await expect(page.getByRole('heading', { name: '让研究，经得起追问。' })).toBeVisible();
  await shot(page, '01-workbench');
  await page.getByRole('button', { name: '体验示例项目', exact: true }).click();
  await settled(page);
  await page.getByRole('button', { name: '生成画像', exact: true }).click();
  await settled(page);
  await expect(page.locator('.profile-field')).toHaveCount(6);
  await page.locator('.profile-field .citation').first().click();
  await expect(page.locator('.source-drawer blockquote').first()).toBeVisible();
  await page.locator('.source-drawer .icon-button').click();
  await page.getByRole('button', { name: '确认画像，可开始训练' }).click();
  await settled(page);
  await shot(page, '02-preparation');
  await page.getByRole('button', { name: '进入答辩室' }).click();
  await settled(page);
  await expect(page.getByLabel('你的回答')).toBeVisible();
  await expect(page.getByRole('heading', { name: '教练提示' })).toHaveCount(0);
  await page.getByLabel('你的回答').fill('我认为这个方法在所有条件下都一定有效，目前没有进一步证据。');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await settled(page);
  await shot(page, '03-defense');
  // Skip the follow-up and the next root question; skipped dimensions stay uncovered.
  await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await settled(page);
  await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await settled(page);
  await page.getByRole('button', { name: '结束并查看复盘' }).click();
  await page.getByRole('button', { name: '确认结束', exact: true }).click();
  await settled(page);
  await expect(page.getByRole('heading', { name: '五维覆盖与风险' })).toBeVisible();
  await expect(page.locator('.risk-card').filter({ hasText: '方法' })).toContainText('未覆盖');
  assert.ok(await page.locator('.finding').count(), 'A submitted answer must yield a review finding');
  await shot(page, '04-review');
  await page.locator('.finding').first().getByRole('checkbox').click();
  await settled(page);
  await expect(page.locator('.finding').first().getByRole('checkbox')).toBeChecked();
  await page.locator('.finding').first().getByRole('button', { name: '针对这一点复练' }).click();
  await settled(page);
  await expect(page.getByRole('heading', { name: '换个角度，再回答一次。' })).toBeVisible();
  await page.getByRole('button', { name: '展开思路' }).click();
  await settled(page);
  await expect(page.locator('.hint')).toHaveCount(1);
  await page.getByLabel('你的回答').fill('这一结论仅适用于已有样本。下一步需加入独立测试数据、明确对照基线，并记录重复实验的波动。');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await settled(page);
  await shot(page, '05-practice');
  await page.getByRole('button', { name: '结束并查看复盘' }).click();
  await page.getByRole('button', { name: '确认结束', exact: true }).click();
  await settled(page);

  const reportFile = path.join(dataDirectory, 'smoke-report.md');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, reportFile);
  await page.getByRole('button', { name: '导出报告' }).click();
  await settled(page);
  assert.ok((await fs.readFile(reportFile, 'utf8')).length > 100, 'Markdown report should contain the session');
  const projectCount = await page.evaluate(async () => {
    const response = await window.desktop.request('GET', '/projects');
    if (!response.ok) throw Error(response.error);
    return response.value.length;
  });
  assert.equal(projectCount, 1);
  await app.close();
  app = null;
  page = await launch();
  await settled(page);
  await page.getByRole('button', { name: /训练档案/ }).click();
  await expect(page.locator('.archive-project')).toHaveCount(projectCount);
  await shot(page, '06-archive');

  // Exercise OS-encrypted settings using a fake credential without any network call.
  const fakeKey = 'smoke-only-not-a-real-key-123456';
  const saved = await page.evaluate(async key => {
    const old = await window.desktop.settings();
    if (!old.ok) throw Error(old.error);
    const response = await window.desktop.saveSettings({ ...old.value, mode: 'demo', key });
    if (!response.ok) throw Error(response.error);
    return response.value;
  }, fakeKey);
  assert.equal(saved.hasKey, true);
  const storedSettings = await fs.readFile(path.join(dataDirectory, 'settings.json'), 'utf8');
  assert.ok(!storedSettings.includes(fakeKey), 'Credential must not appear in plaintext on disk');
  assert.ok(JSON.parse(storedSettings).encryptedKey, 'Credential must be encrypted');
  const cleared = await page.evaluate(async () => {
    const old = await window.desktop.settings();
    const response = await window.desktop.saveSettings({ ...old.value, mode: 'demo', key: '', clearKey: true });
    if (!response.ok) throw Error(response.error);
    return response.value;
  });
  assert.equal(cleared.hasKey, false);

  await page.locator('.archive-project').first().getByRole('button', { name: '打开项目' }).click();
  await settled(page);
  await page.getByRole('button', { name: '进入答辩室' }).click();
  await settled(page);
  await page.getByLabel('你的回答').fill('原项目保留的独立草稿');

  const backupFile = path.join(dataDirectory, 'smoke-backup.json');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, backupFile);
  await page.getByRole('button', { name: '设置与数据' }).click();
  await page.getByRole('button', { name: '备份项目', exact: true }).click();
  await settled(page);
  assert.ok((await fs.stat(backupFile)).size > 100);
  await page.getByRole('button', { name: '从备份恢复', exact: true }).click();
  await settled(page);
  await page.getByRole('button', { name: /训练档案/ }).click();
  await expect(page.locator('.archive-project')).toHaveCount(2);
  await page.locator('.archive-project').filter({ hasText: '恢复副本' }).getByRole('button', { name: '打开项目' }).click();
  await settled(page);
  await page.locator('.session-row').filter({ hasText: '可继续' }).click();
  await settled(page);
  await expect(page.getByLabel('你的回答')).toHaveValue('');
  await page.getByLabel('你的回答').fill('恢复副本独立草稿');
  await page.getByRole('button', { name: /训练档案/ }).click();
  await page.locator('.archive-project').filter({ hasNotText: '恢复副本' }).getByRole('button', { name: '打开项目' }).click();
  await settled(page);
  await page.locator('.session-row').filter({ hasText: '可继续' }).click();
  await settled(page);
  await expect(page.getByLabel('你的回答')).toHaveValue('原项目保留的独立草稿');
  await page.getByRole('button', { name: /训练档案/ }).click();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(880, 720); });
  await shot(page, '07-compact-880');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'Compact viewport must not overflow horizontally');
  await page.evaluate(async () => {
    const projects = await window.desktop.request('GET', '/projects');
    for (const project of projects.value) {
      const detail = await window.desktop.request('GET', '/projects/' + project.id);
      for (const session of detail.value.sessions) {
        localStorage.setItem('draft-' + session.id + '-' + session.turns[0].id, 'draft used to verify project deletion');
        localStorage.setItem('draft-' + project.id + '-' + session.id + '-' + session.turns[0].id, 'namespaced draft used to verify project deletion');
      }
    }
  });
  for (let i = 0; i < 2; i++) {
    await page.locator('.archive-project').first().getByTitle('删除项目').click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await settled(page);
  }
  await expect(page.locator('.archive-project')).toHaveCount(0);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('draft-')).length), 0, 'Deleting projects must clear their local drafts');
  assert.deepEqual(errors, [], 'Renderer should have no uncaught exceptions');
  console.log(JSON.stringify({ ok: true, packaged: Boolean(process.env.DEFENSE_SMOKE_EXECUTABLE), flow: 'example → sources → profile → formal/skip coverage → review → practice → export → restart → encrypted credential → backup/restore draft isolation → compact window → delete/draft cleanup', screenshots, dataDirectory }, null, 2));
}
main().catch(async error => {
  console.error(error);
  process.exitCode = 1;
  if (app) {
    const page = app.windows()[0];
    if (page) await page.screenshot({ path: path.join(screenshots, 'smoke-failure.png'), fullPage: true }).catch(() => {});
  }
}).finally(async () => { if (app) await app.close(); });
