// Verifies live hooks end to end (docs/LIVE.md §5, §14) in the exact process model agents use:
//   hook command = ELECTRON_RUN_AS_NODE=1 '<Hive binary>' '<.../out/main/hive-hook.js>' --events <f> --dir <d> --provider <id>
//
//   npm run build && ELECTRON_RUN_AS_NODE=1 electron scripts/verify-live-hooks.cjs [--adapter claude|gemini|cursor]
//        [--bin <agent CLI path>] [--hive <Hive binary>] [--script <hive-hook.js>] [--no-agent]
//
// Checks:
//  1. hook script latency (p50/p95 over 20 runs; budget p50 < 150 ms);
//  2. a gated invocation blocks until answers/<gate_id>.json appears and prints that decision (headless gates);
//  3. (unless --no-agent) the real CLI, given per-spawn hooks only (never global config), appends hook lines to
//     events.jsonl for the expected events in -p mode;
//  4. prints whether HOOKS_VERIFIED[adapter] may flip (gemini/cursor: 3 and 2 must pass).
// Strictly local: no listeners; temp files only; the user's ~/.claude, ~/.gemini, ~/.cursor are never written.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const adapter = opt('--adapter', 'claude');
const hive = path.resolve(opt('--hive', process.execPath));
const script = path.resolve(opt('--script', path.join(root, 'out/main/hive-hook.js')));
const noAgent = argv.includes('--no-agent');
const BIN_NAME = { claude: 'claude', gemini: 'gemini', cursor: 'cursor-agent' }[adapter];
if (!BIN_NAME) {
  console.error(`unknown adapter ${adapter}`);
  process.exit(2);
}
if (!fs.existsSync(script)) {
  console.error(`hook script not found: ${script} (run npm run build first)`);
  process.exit(2);
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-live-verify-'));
fs.chmodSync(dir, 0o700);
fs.mkdirSync(path.join(dir, 'answers'), { mode: 0o700 });
const events = path.join(dir, 'events.jsonl');
fs.writeFileSync(events, '', { mode: 0o600 });
const baseCmd = `ELECTRON_RUN_AS_NODE=1 ${q(hive)} ${q(script)} --events ${q(events)} --dir ${q(dir)}`;
const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const lines = () =>
  fs
    .readFileSync(events, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

function runHookOnce(payload, extra = '') {
  const t0 = process.hrtime.bigint();
  const r = spawnSync('/bin/sh', ['-c', `${baseCmd} --provider ${adapter} ${extra}`], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, stdout: r.stdout, status: r.status };
}

// 1. latency
const times = [];
for (let i = 0; i < 20; i++) times.push(runHookOnce({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' }, i }).ms);
times.sort((a, b) => a - b);
const p50 = times[10];
const p95 = times[18];
ok('hook latency p50 < 150 ms', p50 < 150, `p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
ok('hook lines appended (one per invocation)', lines().length === 20, `${lines().length} lines`);

// 2. gate
async function gate() {
  fs.writeFileSync(events, '');
  const child = spawn('/bin/sh', ['-c', `${baseCmd} --provider ${adapter} --gate`]);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' }));
  const t0 = Date.now();
  let gateId = null;
  while (!gateId && Date.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 50));
    gateId = lines().find((l) => l.gate_id)?.gate_id ?? null;
  }
  if (!gateId) return ok('gate blocks and prints the answer', false, 'no gate line');
  const decision = adapter === 'cursor' ? { permission: 'allow' } : adapter === 'gemini' ? {} : { hookSpecificOutput: { decision: { behavior: 'allow' } } };
  const f = path.join(dir, 'answers', `${gateId}.json`);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(decision));
  fs.renameSync(`${f}.tmp`, f);
  const code = await new Promise((r) => child.on('exit', r));
  ok('gate blocks and prints the answer', code === 0 && JSON.stringify(JSON.parse(out || 'null')) === JSON.stringify(decision), out.trim());
  ok('gate_closed appended', lines().some((l) => l.hive === 'gate_closed' && l.gate_id === gateId));
}

// 3. the real CLI with per-spawn hooks
function which(name) {
  const r = spawnSync('/bin/sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
async function agent() {
  const bin = opt('--bin', null) ?? which(BIN_NAME);
  if (!bin) return ok(`${BIN_NAME} installed`, false, 'not on PATH; skipped the real run');
  fs.writeFileSync(events, '');
  const cmd = `${baseCmd} --provider ${adapter}`;
  let args;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let expect;
  if (adapter === 'claude') {
    const h = (async) => [{ hooks: [{ type: 'command', command: cmd, async }] }];
    const m = (async) => [{ matcher: '*', hooks: [{ type: 'command', command: cmd, async }] }];
    const settings = {
      hooks: {
        SessionStart: h(true), UserPromptSubmit: h(true), PreToolUse: m(true), PostToolUse: m(true), PostToolUseFailure: m(true),
        PermissionRequest: m(true), Notification: m(true), SubagentStart: h(true), SubagentStop: h(true), Stop: h(true), SessionEnd: h(true)
      }
    };
    const f = path.join(dir, 'claude-settings.json');
    fs.writeFileSync(f, JSON.stringify(settings), { mode: 0o600 });
    args = ['-p', '--settings', f, '--output-format', 'stream-json', '--verbose', '--model', opt('--model', 'haiku'), 'Reply with the single word: ok'];
    expect = ['SessionStart', 'UserPromptSubmit', 'Stop'];
  } else if (adapter === 'gemini') {
    const hook = (name) => [{ matcher: '*', hooks: [{ type: 'command', command: cmd, name: `hive-${name}` }] }];
    const settings = { hooksConfig: { enabled: true }, hooks: { SessionStart: hook('s'), BeforeTool: hook('b'), AfterTool: hook('a'), AfterAgent: hook('aa') } };
    const f = path.join(dir, 'gemini-system.json');
    fs.writeFileSync(f, JSON.stringify(settings), { mode: 0o600 });
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = f;
    args = ['-o', 'stream-json', '-p', 'List the files in the current directory, then reply ok'];
    expect = ['SessionStart', 'BeforeTool', 'AfterTool'];
  } else {
    const plugin = path.join(dir, 'cursor-plugin');
    fs.mkdirSync(path.join(plugin, '.cursor-plugin'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'hive' }));
    const hooks = {};
    for (const n of ['sessionStart', 'subagentStart', 'subagentStop', 'preToolUse', 'postToolUse', 'stop', 'sessionEnd']) hooks[n] = [{ command: cmd }];
    fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ version: 1, hooks }));
    args = ['-p', '--output-format', 'stream-json', '--plugin-dir', plugin, 'List the files in the current directory, then reply ok'];
    expect = ['sessionStart', 'preToolUse'];
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-live-cwd-'));
  fs.writeFileSync(path.join(cwd, 'note.txt'), 'hello\n');
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  const unknown = new Set();
  for (const l of (r.stdout || '').split('\n')) {
    try {
      const o = JSON.parse(l);
      if (o && o.type) unknown.add(o.subtype ? `${o.type}/${o.subtype}` : o.type);
    } catch {
      /* not json */
    }
  }
  ok(`${BIN_NAME} exited 0`, r.status === 0, r.status === 0 ? `stream types: ${[...unknown].join(', ')}` : (r.stderr || '').slice(0, 300));
  await new Promise((res) => setTimeout(res, 1500)); // async hooks land after exit
  const names = lines().map((l) => l.payload?.hook_event_name ?? l.payload?.hookEventName ?? l.payload?.event ?? '?');
  for (const e of expect) ok(`hook line for ${e}`, names.includes(e), `got: ${[...new Set(names)].join(', ') || 'none'}`);
  fs.rmSync(cwd, { recursive: true, force: true });
}

(async () => {
  await gate();
  if (!noAgent) await agent();
  const failed = results.filter((r) => !r.pass);
  const verifiable = adapter !== 'claude';
  console.log('');
  if (verifiable) {
    const blocking = results.filter((r) => r.name.startsWith('hook line') || r.name.startsWith('gate'));
    const may = blocking.length > 0 && blocking.every((r) => r.pass) && !noAgent;
    console.log(`HOOKS_VERIFIED.${adapter} may flip: ${may ? 'YES' : 'no'} (record the CLI version next to the flag)`);
  } else {
    console.log(`claude hooks are observational; ${failed.length ? 'some checks failed' : 'all checks passed'}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})();
