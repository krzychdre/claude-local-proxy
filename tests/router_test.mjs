import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.join(__dir, '..', 'router.mjs');

// --- mock OpenAI server (local LLM) : streams text + a tool call ---
const openai = http.createServer((req,res)=>{
  let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
    const body=JSON.parse(b||'{}');
    globalThis.__lastOpenAI=body;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const ev=o=>res.write(`data: ${JSON.stringify(o)}\n\n`);
    ev({choices:[{delta:{content:"Hello "}}]});
    ev({choices:[{delta:{content:"world"}}]});
    ev({choices:[{delta:{tool_calls:[{index:0,id:"call_1",function:{name:"get_weather",arguments:'{"city":'}}]}}]});
    ev({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"Paris"}'}}]}}]});
    ev({choices:[{delta:{},finish_reason:"tool_calls"}],usage:{prompt_tokens:11,completion_tokens:7}});
    res.write('data: [DONE]\n\n'); res.end();
  });
});

// --- mock Anthropic server (the "real" upstream) : echoes auth + model ---
const anthropic = http.createServer((req,res)=>{
  let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
    const body=JSON.parse(b||'{}');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({routed:'anthropic', model:body.model, sawAuth:req.headers['authorization']||req.headers['x-api-key']||null}));
  });
});

await new Promise(r=>openai.listen(0,r));
await new Promise(r=>anthropic.listen(0,r));
const OAI=openai.address().port, ANT=anthropic.address().port;

const proc=spawn('node',[ROUTER],{env:{...process.env,
  ROUTER_CONFIG:'/dev/null',
  PORT:'8799',
  LOCAL_BASE_URL:`http://127.0.0.1:${OAI}`,
  LOCAL_FLAVOR:'openai',
  LOCAL_MODEL:'my-local-model',
  LOCAL_TIERS:'sonnet',
  ANTHROPIC_UPSTREAM_URL:`http://127.0.0.1:${ANT}`,
  ROUTER_LOG_LEVEL:'warn',
},stdio:['ignore','inherit','inherit']});
await new Promise(r=>setTimeout(r,600));

const base='http://127.0.0.1:8799';
let pass=0,fail=0;
const ok=(n,c)=>{ c?pass++:fail++; console.log((c?'PASS':'FAIL')+' '+n); };

// 1) opus -> anthropic passthrough, auth relayed
{
  const r=await fetch(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer sk-ant-oat-XYZ'},body:JSON.stringify({model:'claude-opus-4-8',max_tokens:10,messages:[{role:'user',content:'hi'}]})});
  const j=await r.json();
  ok('opus routes to Anthropic', j.routed==='anthropic' && j.model==='claude-opus-4-8');
  ok('original auth relayed upstream', j.sawAuth==='Bearer sk-ant-oat-XYZ');
}

// 2) sonnet -> local, OpenAI translated streaming -> Anthropic SSE
{
  const r=await fetch(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer sk-ant-oat-XYZ'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:50,stream:true,system:'be brief',tools:[{name:'get_weather',description:'w',input_schema:{type:'object',properties:{city:{type:'string'}}}}],messages:[{role:'user',content:'weather?'}]})});
  const txt=await r.text();
  ok('sonnet emits Anthropic message_start', /event: message_start/.test(txt));
  ok('text delta translated', /"type":"text_delta","text":"Hello "/.test(txt) && /"text":"world"/.test(txt));
  ok('tool_use block opened', /"type":"tool_use"[^}]*"name":"get_weather"/.test(txt));
  ok('tool args streamed as input_json_delta', /"partial_json":"\{\\"city\\":"/.test(txt) && /"partial_json":"\\"Paris\\"\}"/.test(txt));
  ok('stop_reason tool_use', /"stop_reason":"tool_use"/.test(txt));
  ok('message_stop terminates', /event: message_stop/.test(txt));
  // verify request translation sent to the local server
  ok('local got system prepended', globalThis.__lastOpenAI?.messages?.[0]?.role==='system');
  ok('local got model override', globalThis.__lastOpenAI?.model==='my-local-model');
  ok('local got tools', Array.isArray(globalThis.__lastOpenAI?.tools) && globalThis.__lastOpenAI.tools[0].function.name==='get_weather');
}

// 3) count_tokens on local sonnet -> estimated, no upstream call
{
  const r=await fetch(base+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-6',messages:[{role:'user',content:'abcdefghij'}]})});
  const j=await r.json();
  ok('count_tokens returns input_tokens', typeof j.input_tokens==='number' && j.input_tokens>0);
}

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill(); openai.close(); anthropic.close();
process.exit(fail?1:0);