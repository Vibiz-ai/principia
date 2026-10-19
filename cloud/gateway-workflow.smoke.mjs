/** No paid model calls: a fake Codex CLI exercises real engine injection → bridge → authenticated upstream. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner } from './runner.mjs'
import { createCloudWorkflows } from '../out-cloud/workflows.mjs'
const dir = mkdtempSync(join(tmpdir(), 'principia-gateway-engine-'))
const bin = join(dir, 'bin'); mkdirSync(bin)
const upstream = join(dir, 'upstream.cjs')
writeFileSync(upstream, `const readline=require('node:readline'); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(!('id' in m))return; const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake-company',version:'1'}}:m.method==='tools/list'?{tools:[{name:'check_key',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.env.COMPANY_SECRET==='upstream-only-secret'?'authenticated-company-tool':'wrong-secret'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`)
const cli = join(bin, 'codex')
writeFileSync(cli, `#!/usr/bin/env node
const {spawn}=require('node:child_process'); const readline=require('node:readline');
if(process.argv.includes('--version')){ console.log('codex-cli 0.120.0');process.exit(0) }
(async()=>{
 const config={}; for(let i=0;i<process.argv.length;i++)if(process.argv[i]==='-c'){const v=process.argv[++i];const eq=v.indexOf('=');config[v.slice(0,eq)]=JSON.parse(v.slice(eq+1))}
 if(process.env.PRINCIPIA_MCP_MASTER_KEY || process.env.PRINCIPIA_API_TOKEN || process.env.COMPANY_SECRET)throw Error('control secret leaked to harness');
 const env={...process.env};for(const [key,value] of Object.entries(config))if(key.startsWith('mcp_servers.principia.env.'))env[key.slice('mcp_servers.principia.env.'.length)]=value;
 const command=config['mcp_servers.principia.command']; if(!command)throw Error('gateway not attached');
 const child=spawn(command,config['mcp_servers.principia.args'],{env,stdio:['pipe','pipe','inherit']});const pending=new Map();let seq=0;
 readline.createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});
 const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n')});
 try{await request('initialize',{protocolVersion:'2025-06-18'});const discovered=await request('tools/call',{name:'principia_list_tools',arguments:{}});if(!JSON.stringify(discovered).includes('check_key'))throw Error('tools not discovered');const result=await request('tools/call',{name:'principia_call_tool',arguments:{connection:'company',tool:'check_key',arguments:{}}});if(!JSON.stringify(result).includes('authenticated-company-tool'))throw Error('authentication not forwarded');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'gateway-handoff-ok'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));}finally{child.stdin.end();child.kill()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
`)
chmodSync(cli, 0o700)
const configFile = join(dir, 'mcp.json')
writeFileSync(configFile, JSON.stringify([{ id: 'company', name: 'Company', transport: 'stdio', command: process.execPath, args: [upstream], enabled: true, roots: [dir], credentials: { COMPANY_SECRET: 'upstream-only-secret', ELECTRON_RUN_AS_NODE: '1' } }]), { mode: 0o600 })
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.PRINCIPIA_MCP_CONFIG = configFile
process.env.PRINCIPIA_MCP_MASTER_KEY = 'a'.repeat(64)
process.env.PRINCIPIA_API_TOKEN = 'control-token-not-for-harness'
let workflows
try {
  const savedConfig = readFileSync(configFile, 'utf8')
  process.env.PRINCIPIA_MCP_MASTER_KEY = 'invalid'
  await assert.rejects(() => createCloudWorkflows({ dataDir: join(dir, 'bad-key'), workspace: dir, redact: s => s }), /32-byte hex key/)
  process.env.PRINCIPIA_MCP_MASTER_KEY = 'a'.repeat(64)
  const outside = JSON.parse(savedConfig); outside[0].roots = ['/']; writeFileSync(configFile, JSON.stringify(outside))
  await assert.rejects(() => createCloudWorkflows({ dataDir: join(dir, 'bad-roots'), workspace: dir, redact: s => s }), /inside cloud workspace/)
  writeFileSync(configFile, savedConfig)
  workflows = await createCloudWorkflows({ dataDir: join(dir, 'data'), workspace: dir, redact: s => s.replaceAll('upstream-only-secret', '[REDACTED]') })
  assert.equal(workflows.attachment('/'), null, 'Outside working directories must receive no company connection')
  assert.ok(!workflows.redact('value upstream-only-secret').includes('upstream-only-secret'))
  const jobs = new Runner({ dataDir: join(dir, 'jobs'), workspace: dir, commands: { codex: cli }, attachment: cwd => workflows.attachment(cwd), secrets: ['upstream-only-secret'] })
  try {
    const job = jobs.submit({ prompt: 'Discover and call company tools.', harness: 'codex' })
    for (let i = 0; i < 400 && ['queued', 'running'].includes(job.status); i++) await new Promise(r => setTimeout(r, 25))
    assert.equal(job.status, 'succeeded', JSON.stringify(job))
    assert.ok(job.output.includes('gateway-handoff-ok'))
  } finally { jobs.close() }
  const workflow = workflows.import({ hive: 'workflow', version: 1, workflow: { name: 'Gateway workflow smoke', nodes: [{ id: 'test', type: 'agent', profileId: 'prof_codex', label: 'Test', prompt: 'Discover and call company tools.', cwd: null, after: [], timeoutMin: 1 }] } })
  const run = workflows.start(workflow.id)
  let detail
  for (let i = 0; i < 400; i++) { detail = workflows.get(run.id); if (['passed', 'failed', 'canceled'].includes(detail.run.status)) break; await new Promise(r => setTimeout(r, 25)) }
  assert.equal(detail.run.status, 'passed', JSON.stringify(detail))
  assert.ok(detail.steps[0].output.includes('gateway-handoff-ok'))
  const persisted = readFileSync(join(dir, 'data', 'mcp-connections.json'), 'utf8')
  assert.ok(!persisted.includes('upstream-only-secret'), 'Gateway credentials must be encrypted on disk')
  await workflows.close(); workflows = undefined
  delete process.env.PRINCIPIA_MCP_CONFIG
  workflows = await createCloudWorkflows({ dataDir: join(dir, 'data'), workspace: dir, redact: s => s })
  const restart = workflows.start(workflow.id)
  for (let i = 0; i < 400; i++) { detail = workflows.get(restart.id); if (['passed', 'failed', 'canceled'].includes(detail.run.status)) break; await new Promise(r => setTimeout(r, 25)) }
  assert.equal(detail.run.status, 'passed', JSON.stringify(detail))
  console.log('Actual workflow → fake Codex → shared stdio bridge → credential-isolated company MCP: PASS')
} finally { await workflows?.close(); rmSync(dir, { recursive: true, force: true }) }
