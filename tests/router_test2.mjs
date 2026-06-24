import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.join(__dir, '..', 'router.mjs');

// mock Anthropic-compatible LOCAL gateway: echoes what it received
const gw = http.createServer((req,res)=>{
  let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
    const body=JSON.parse(b||'{}');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({where:'local-gateway', path:req.url, model:body.model,
      auth:req.headers['authorization']||null, xapikey:req.headers['x-api-key']||null}));
  });
});
// mock real Anthropic upstream
const ant = http.createServer((req,res)=>{
  let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
    const body=JSON.parse(b||'{}');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({where:'anthropic', model:body.model, auth:req.headers['authorization']||null}));
  });
});
await new Promise(r=>gw.listen(0,r));
await new Promise(r=>ant.listen(0,r));
const GW=gw.address().port, ANT=ant.address().port;

const proc=spawn('node',[ROUTER],{env:{...process.env,
  ROUTER_CONFIG:'/dev/null',
  PORT:'8798',
  LOCAL_BASE_URL:`http://127.0.0.1:${GW}`, LOCAL_FLAVOR:'anthropic',
  LOCAL_MODEL:'GLM-4.7-REAP-265B', LOCAL_API_KEY:'gw-secret', LOCAL_TIERS:'sonnet,haiku',
  ANTHROPIC_UPSTREAM_URL:`http://127.0.0.1:${ANT}`, ROUTER_LOG_LEVEL:'warn',
},stdio:['ignore','inherit','inherit']});
await new Promise(r=>setTimeout(r,600));

const base='http://127.0.0.1:8798'; let pass=0,fail=0;
const ok=(n,c)=>{c?pass++:fail++;console.log((c?'PASS':'FAIL')+' '+n);};
const post=(m,extra={})=>fetch(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer sk-ant-oat-REAL'},body:JSON.stringify({model:m,max_tokens:10,messages:[{role:'user',content:'hi'}],...extra})}).then(r=>r.json());

{ const j=await post('claude-sonnet-4-6');
  ok('sonnet -> local gateway', j.where==='local-gateway');
  ok('  model rewritten to local', j.model==='GLM-4.7-REAP-265B');
  ok('  real Anthropic auth NOT leaked to gateway', j.auth==='Bearer gw-secret' && j.xapikey==='gw-secret'); }
{ const j=await post('claude-haiku-4-5');
  ok('haiku -> local gateway', j.where==='local-gateway' && j.model==='GLM-4.7-REAP-265B'); }
{ const j=await post('claude-opus-4-8[1m]');
  ok('opus[1m] -> real Anthropic', j.where==='anthropic');
  ok('  opus keeps real subscription auth', j.auth==='Bearer sk-ant-oat-REAL'); }
{ const r=await fetch(base+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-6',messages:[{role:'user',content:'hello there friend'}]})}); const j=await r.json();
  ok('count_tokens(local) estimated', typeof j.input_tokens==='number' && j.input_tokens>0); }

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill(); gw.close(); ant.close();
process.exit(fail?1:0);