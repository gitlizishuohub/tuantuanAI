const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: root, stdio: 'inherit', windowsHide: true });
let electron;
async function start() {
  let available = false;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch('http://127.0.0.1:5173'); if (response.ok) { available = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!available) throw Error('开发页面未能在 127.0.0.1:5173 启动，请检查端口和 Vite 输出。');
  const env = { ...process.env, DEFENSE_DEV_URL: 'http://127.0.0.1:5173' };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(require('electron'), ['.'], { cwd: root, stdio: 'inherit', windowsHide: true, env });
  electron.on('exit', code => { vite.kill(); process.exit(code ?? 0); });
}
process.on('SIGINT', () => { electron?.kill(); vite.kill(); process.exit(); });
process.on('SIGTERM', () => { electron?.kill(); vite.kill(); process.exit(); });
start().catch(error => { console.error(error.message); electron?.kill(); vite.kill(); process.exitCode = 1; });
