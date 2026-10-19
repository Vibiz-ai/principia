// Verifies the hivemem stdio MCP server end to end, in the exact process model agents use:
//   <Hive binary> <.../out/main/mcp-memory.js>  with ELECTRON_RUN_AS_NODE=1 (docs/MEMORY.md §1, §13.1).
//
// Dev:       ELECTRON_RUN_AS_NODE=1 electron scripts/verify-memory-mcp.cjs
// Packaged:  ELECTRON_RUN_AS_NODE=1 electron scripts/verify-memory-mcp.cjs \
//              --bin release/mac-arm64/Hive.app/Contents/MacOS/Hive \
//              --script release/mac-arm64/Hive.app/Contents/Resources/app.asar/out/main/mcp-memory.js
//
// The test DB is created from src/main/memory/schema.ts (only Hive main migrates in the app).
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? path.resolve(process.argv[i + 1]) : def;
};
const bin = arg('--bin', process.execPath);
const script = arg('--script', path.join(root, 'out/main/mcp-memory.js'));

function schema() {
  const src = fs.readFileSync(path.join(root, 'src/main/memory/schema.ts'), 'utf8');
  const ddl = /MEMORY_DDL_V1 = \/\* sql \*\/ `([\s\S]*?)`/.exec(src)[1];
  const version = Number(/MEMORY_SCHEMA_VERSION = (\d+)/.exec(src)[1]);
  return { ddl, version };
}

function setup() {
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemem-verify-'));
  const dbPath = path.join(dir, 'memory.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const { ddl, version } = schema();
  db.exec(ddl);
  db.pragma(`user_version = ${version}`);
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO mem_grant (id, mode, adapter, transport, repo_id, repo_name, run_id, run_title, created_at, closed_at)
     VALUES (?, ?, 'claude', 'mcp', ?, ?, 'r_verify0001', 'Verify run', ?, ?)`
  );
  ins.run('mgr_rw00000001', 'read-write', 'repo_aaaaaaaaaa', 'demo', now, null);
  ins.run('mgr_ro00000001', 'read', 'repo_aaaaaaaaaa', 'demo', now, null);
  ins.run('mgr_norepo0001', 'read-write', null, null, now, null);
  ins.run('mgr_closed0001', 'read-write', 'repo_aaaaaaaaaa', 'demo', now, now);
  db.close();
  const secret = 'sk-verify-SECRET-123456';
  const salt = crypto.randomBytes(8).toString('hex');
  const fp = { salt, entries: [{ len: secret.length, h: crypto.createHash('sha256').update(salt + secret).digest('hex'), name: 'VERIFY_KEY' }] };
  fs.writeFileSync(path.join(dir, 'fp.json'), JSON.stringify(fp), { mode: 0o600 });
  return { dir, dbPath, fpPath: path.join(dir, 'fp.json'), secret };
}

function client(env) {
  const t0 = Date.now();
  const child = spawn(bin, [script], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  const waiting = new Map();
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new Error('non-JSON on stdout: ' + line.slice(0, 200));
      }
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr.on('data', (d) => (stderr += d.toString()));
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${stderr}`)), 10000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args });
    const res = r.result;
    return { isError: !!res.isError, text: res.content[0].text, data: res.structuredContent };
  };
  const close = () =>
    new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.stdin.end();
    });
  return { call, tool, close, startedAt: t0, stderr: () => stderr };
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
};

async function main() {
  const { dir, dbPath, fpPath, secret } = setup();
  const base = { HIVE_MEM_DB: dbPath, HIVE_MEM_FP: fpPath, PATH: process.env.PATH || '' };
  try {
    // read-write grant
    const rw = client({ ...base, HIVE_MEM_GRANT: 'mgr_rw00000001' });
    const init = await rw.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } });
    check('initialize', init.result && init.result.serverInfo.name === 'hivemem' && init.result.protocolVersion === '2025-06-18', init);
    check('startup < 2 s', Date.now() - rw.startedAt < 2000, Date.now() - rw.startedAt);
    const list = await rw.call('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort().join(',');
    check('read-write lists 4 tools', names === 'memory_get,memory_invalidate,memory_search,memory_write', names);
    const w = await rw.tool('memory_write', {
      entity: 'better-sqlite3',
      entity_type: 'library',
      facts: [{ text: 'Must be rebuilt for Electron; system node fails with an ABI mismatch.', kind: 'gotcha' }],
      relations: [{ type: 'used_by', to: 'hive main' }]
    });
    check('write', !w.isError && w.data.facts[0].result === 'added' && w.data.relations[0].result === 'added', w.text);
    const s = await rw.tool('memory_search', { query: 'electron abi' });
    check('search finds the fact', !s.isError && s.data.results[0] && s.data.results[0].entity.name === 'better-sqlite3', s.text);
    const g = await rw.tool('memory_get', { names: ['hive main'] });
    check('get resolves relation target', !g.isError && g.data.entities.length === 1 && g.data.entities[0].relations.in.length === 1, g.text);
    const factId = w.data.facts[0].id;
    const inv = await rw.tool('memory_invalidate', { ids: [factId], reason: 'verified wrong' });
    check('invalidate', !inv.isError && inv.data.items[0].result === 'invalidated', inv.text);
    const sec = await rw.tool('memory_write', { entity: 'deploy', facts: [{ text: `The key is ${secret} for prod` }] });
    check('secret rejected', sec.isError && /VERIFY_KEY/.test(sec.text), sec.text);
    const unknown = await rw.call('nope/method', {});
    check('unknown method -32601', unknown.error && unknown.error.code === -32601, unknown);
    check('exits on stdin close', (await rw.close()) === 0, rw.stderr());

    // read grant: no write tools, write refused
    const ro = client({ ...base, HIVE_MEM_GRANT: 'mgr_ro00000001' });
    await ro.call('initialize', { protocolVersion: '2025-11-25' });
    const roNames = (await ro.call('tools/list', {})).result.tools.map((t) => t.name).sort().join(',');
    check('read lists 2 tools', roNames === 'memory_get,memory_search', roNames);
    const roW = await ro.tool('memory_write', { entity: 'x', facts: [{ text: 'should fail' }] });
    check('read refuses writes', roW.isError, roW.text);
    await ro.close();

    // no-repo grant: read-only on global (PO2)
    const nr = client({ ...base, HIVE_MEM_GRANT: 'mgr_norepo0001' });
    await nr.call('initialize', {});
    const nrNames = (await nr.call('tools/list', {})).result.tools.map((t) => t.name).sort().join(',');
    check('no-repo grant is read-only', nrNames === 'memory_get,memory_search', nrNames);
    await nr.close();

    // closed grant
    const cl = client({ ...base, HIVE_MEM_GRANT: 'mgr_closed0001' });
    await cl.call('initialize', {});
    const clW = await cl.tool('memory_write', { entity: 'x', facts: [{ text: 'should fail' }] });
    check('closed grant refuses writes', clW.isError && /closed/.test(clW.text), clW.text);
    await cl.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ok = results.every((r) => r.ok);
  console.log('VERIFY_MEMORY_MCP ' + JSON.stringify({ ok, bin, script, results }));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.log('VERIFY_MEMORY_MCP FAIL ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
