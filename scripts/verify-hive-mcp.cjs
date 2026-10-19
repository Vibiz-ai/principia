// Verifies the `hive` authoring stdio MCP server (docs/AUTHORING.md §1, §11) in the process model claude uses:
//   <Hive binary> <.../out/main/mcp-hive.js>  with ELECTRON_RUN_AS_NODE=1 and HIVE_LIVE_DIR = a throwaway live dir.
//
// 1. Protocol: initialize + tools/list (exactly the authoring tools, no hive_schedule_create) + one tools/call round
//    trip through the file mailbox (events.jsonl author_call -> answers/<call_id>.json), answered by a stand-in "main".
// 2. --claude: a real `claude -p` loads the server from a per-spawn --mcp-config and calls hive_workflow_validate.
//    Uses a throwaway HIVE_USER_DATA-style temp dir; never touches ~/.claude/settings.json or the installed Hive.
//
// Dev:  npm run build && ELECTRON_RUN_AS_NODE=1 electron scripts/verify-hive-mcp.cjs [--claude]
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? path.resolve(process.argv[i + 1]) : def;
};
const bin = arg('--bin', process.execPath);
const script = arg('--script', path.join(root, 'out/main/mcp-hive.js'));
const withClaude = process.argv.includes('--claude');
const fail = (m) => {
  console.error(`FAIL ${m}`);
  process.exit(1);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-author-verify-'));
const liveDir = path.join(tmp, 'live', 's_verify0001');
fs.mkdirSync(path.join(liveDir, 'answers'), { recursive: true, mode: 0o700 });
const events = path.join(liveDir, 'events.jsonl');
fs.writeFileSync(events, '');

// stand-in for main's broker: answers every author_call it sees
const calls = [];
let offset = 0;
const responder = setInterval(() => {
  const text = fs.readFileSync(events, 'utf8');
  const fresh = text.slice(offset);
  const nl = fresh.lastIndexOf('\n');
  if (nl < 0) return;
  offset += nl + 1;
  for (const l of fresh.slice(0, nl).split('\n')) {
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    if (m.hive !== 'author_call') continue;
    calls.push(m);
    const wf = (m.args && m.args.workflow) || {};
    const result =
      m.tool === 'hive_workflow_validate'
        ? { ok: true, errors: [], warnings: ['verify: stand-in main'], normalized: wf }
        : { note: `verify stand-in for ${m.tool}` };
    const f = path.join(liveDir, 'answers', `${m.call_id}.json`);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ ok: true, result }));
    fs.renameSync(`${f}.tmp`, f);
  }
}, 50);

function protocol() {
  return new Promise((resolve) => {
    const child = spawn(bin, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HIVE_LIVE_DIR: liveDir }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const pending = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const req = (method, params) =>
      new Promise((r) => {
        const n = ++id;
        pending.set(n, r);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
      });
    (async () => {
      const init = await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } });
      if (init.result.serverInfo.name !== 'hive') fail('serverInfo.name');
      const tools = (await req('tools/list', {})).result.tools.map((t) => t.name);
      if (!tools.includes('hive_workflow_create') || tools.includes('hive_schedule_create')) fail(`tools: ${tools.join(',')}`);
      const call = await req('tools/call', { name: 'hive_workflow_validate', arguments: { workflow: { name: 't', nodes: [] } } });
      if (call.result.isError || call.result.structuredContent.ok !== true) fail(`round trip: ${JSON.stringify(call)}`);
      console.log(`ok protocol: ${tools.length} tools, mailbox round trip`);
      child.stdin.end();
      resolve();
    })().catch((e) => fail(String(e)));
  });
}

function claude() {
  const which = spawnSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' });
  const claudeBin = which.stdout.trim();
  if (!claudeBin) fail('claude not found on PATH');
  const cfg = path.join(liveDir, 'hive.mcp.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({ mcpServers: { hive: { type: 'stdio', command: bin, args: [script], env: { ELECTRON_RUN_AS_NODE: '1', HIVE_LIVE_DIR: liveDir } } } }),
    { mode: 0o600 }
  );
  const scratch = path.join(tmp, 'scratch');
  fs.mkdirSync(scratch);
  const before = calls.length;
  const prompt =
    'Call the tool mcp__hive__hive_workflow_validate exactly once with workflow {"name":"verify","nodes":[{"id":"a","type":"shell","command":"echo hi"}]}. Then reply with only the value of its "ok" field.';
  // async spawn: the stand-in main above must keep answering while claude runs (spawnSync would block it)
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(claudeBin, ['-p', prompt, '--mcp-config', cfg, '--allowedTools', 'mcp__hive__hive_workflow_validate', '--output-format', 'json'], {
        cwd: scratch,
        env: { ...process.env, MCP_TOOL_TIMEOUT: '3700000' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      const t = setTimeout(() => child.kill('SIGTERM'), 240_000)
      child.on('exit', (status) => {
        clearTimeout(t)
        resolve({ status, stdout, stderr })
      })
    })
  return run().then((r) => new Promise((resolve) =>
    setTimeout(() => {
      const got = calls.slice(before).filter((c) => c.tool === 'hive_workflow_validate');
      if (!got.length) fail(`claude did not call the tool. exit=${r.status} out=${(r.stdout || '').slice(0, 400)} err=${(r.stderr || '').slice(0, 400)}`);
      let out = ''
      try {
        out = String(JSON.parse(r.stdout).result ?? '')
      } catch {
        out = r.stdout || ''
      }
      if (!/true/i.test(out)) fail(`unexpected claude answer: ${out.slice(0, 400)}`);
      console.log(`ok claude: ${got.length} hive_workflow_validate call(s) through the mailbox`);
      resolve();
    }, 300)
  ));
}

(async () => {
  await protocol();
  if (withClaude) await claude();
  clearInterval(responder);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('VERIFY HIVE MCP OK');
  process.exit(0);
})();
