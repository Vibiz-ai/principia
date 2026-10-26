// Run with: npm run verify:native  (executes inside the Electron main process, no window)
const { app } = require('electron');
const os = require('node:os');

app.whenReady().then(async () => {
  const out = { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules };
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('create table t(x); insert into t values (42)');
    out.betterSqlite3 = db.prepare('select x from t').get().x === 42 ? 'ok' : 'bad';
    db.close();
  } catch (e) { out.betterSqlite3 = 'FAIL ' + e.message; }
  try {
    let nodeSqlite = 'absent';
    try { const { DatabaseSync } = require('node:sqlite'); new DatabaseSync(':memory:'); nodeSqlite = 'ok'; } catch (e) { nodeSqlite = 'FAIL ' + e.message; }
    out.nodeSqlite = nodeSqlite;
  } catch {}
  try {
    const pty = require('node-pty');
    const p = pty.spawn('/bin/sh', ['-c', 'printf hive-pty-ok'], { cols: 80, rows: 24, cwd: os.homedir(), env: process.env });
    out.nodePty = await new Promise((resolve) => {
      let buf = '';
      p.onData((d) => (buf += d));
      p.onExit(({ exitCode }) => resolve(buf.includes('hive-pty-ok') && exitCode === 0 ? 'ok' : 'bad: ' + JSON.stringify(buf)));
      setTimeout(() => resolve('timeout'), 5000);
    });
  } catch (e) { out.nodePty = 'FAIL ' + e.message; }
  try {
    const { safeStorage } = require('electron');
    out.safeStorageAvailable = safeStorage.isEncryptionAvailable();
  } catch (e) { out.safeStorageAvailable = 'FAIL ' + e.message; }
  console.log('VERIFY ' + JSON.stringify(out));
  const ok = out.betterSqlite3 === 'ok' && out.nodePty === 'ok';
  app.exit(ok ? 0 : 1);
});
