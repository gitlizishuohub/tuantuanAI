const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'defense-frozen-'));
  const token = randomBytes(32).toString('hex');
  const worker = spawn(path.resolve(__dirname, '../build/worker/defense-worker/defense-worker.exe'), [], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let timer;
  try {
    const ready = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Frozen worker startup timed out')), 25000);
      worker.once('error', reject);
      worker.once('exit', code => reject(Error('Frozen worker exited: ' + code)));
      worker.stdin.on('error', reject);
      worker.stderr.on('data', () => {});
      let buffer = '';
      worker.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.includes('\n')) {
          try { resolve(JSON.parse(buffer.split('\n')[0]).port); } catch (error) { reject(error); }
        }
      });
    });
    worker.stdin.write(JSON.stringify({ directory, token }) + '\n');
    const port = await ready;
    clearTimeout(timer);
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000),
    });
    const health = await response.json();
    if (!response.ok || health.ready !== true) throw Error('Frozen worker health check failed');
    const forbidden = await fetch(`http://127.0.0.1:${port}/projects`, { signal: AbortSignal.timeout(10000) });
    if (forbidden.status !== 403) throw Error('Unauthenticated access must be rejected');
    const exited = new Promise((resolve, reject) => {
      worker.once('exit', code => code === 0 ? resolve() : reject(Error('Unexpected worker exit: ' + code)));
      timer = setTimeout(() => reject(Error('Worker did not exit after its parent pipe closed')), 10000);
    });
    worker.stdin.end();
    await exited;
    console.log(JSON.stringify({ ok: true, health, unauthenticatedStatus: forbidden.status, parentPipeCloseExitsWorker: true, directory }, null, 2));
  } finally {
    clearTimeout(timer);
    worker.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
