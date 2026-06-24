// Integration smoke test for the token-usage logging.
// Spins up mock upstreams + the real router as a child process, sends requests,
// and asserts the proxy folds token usage onto the request line WITHOUT making any extra
// upstream call (we count upstream hits).
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.join(__dir, '..', 'router.mjs');

let anthropicHits = 0;
let localHits = 0;

// Mock "Anthropic" upstream: streaming SSE for stream:true, JSON otherwise.
const anthropic = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => (buf += c));
  req.on('end', () => {
    anthropicHits++;
    const body = JSON.parse(buf || '{}');
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1234, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 77 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 555, output_tokens: 42, cache_read_input_tokens: 500 } }));
    }
  });
});

// Mock local Anthropic-flavored upstream (non-stream JSON with usage).
const local = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => (buf += c));
  req.on('end', () => {
    localHits++;
    const body = JSON.parse(buf || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_3', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'yo' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 22 } }));
  });
});

const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const post = (port, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'authorization': 'Bearer test', 'Content-Length': Buffer.byteLength(data) } }, res => {
    let out = ''; res.on('data', c => (out += c)); res.on('end', () => resolve(out));
  });
  req.on('error', reject); req.write(data); req.end();
});

const wait = ms => new Promise(r => setTimeout(r, ms));

const aPort = await listen(anthropic);
const lPort = await listen(local);
const rPort = 8799;

const child = spawn('node', [ROUTER], {
  env: { ...process.env,
    ROUTER_CONFIG: '/dev/null',
    PORT: String(rPort), ROUTER_HOST: '127.0.0.1',
    ANTHROPIC_UPSTREAM_URL: `http://127.0.0.1:${aPort}`,
    LOCAL_BASE_URL: `http://127.0.0.1:${lPort}`, LOCAL_FLAVOR: 'anthropic', LOCAL_MODEL: 'local-x',
    LOCAL_TIERS: 'sonnet,haiku', ROUTER_LOG_USAGE: '1', ROUTER_LOG_LEVEL: 'info',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', d => (logs += d));
child.stderr.on('data', d => (logs += d));

await wait(600); // let it bind

const checks = [];
const expect = (name, cond) => checks.push([name, !!cond]);

// 1) Opus streaming -> anthropic upstream, usage from message_start + message_delta
const streamOut = await post(rPort, { model: 'claude-opus-4-8', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
// 2) Opus non-stream -> anthropic JSON usage
await post(rPort, { model: 'claude-opus-4-8', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
// 3) Sonnet non-stream -> local upstream usage
await post(rPort, { model: 'claude-sonnet-4-6', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });

await wait(300);
child.kill();
await wait(100);

// Streaming response still well-formed (tee didn't corrupt it)
expect('stream response relayed intact (message_start present)', streamOut.includes('event: message_start'));
expect('stream response relayed intact (message_stop present)', streamOut.includes('message_stop'));

// Usage folded onto the request line: streaming merges input from start (1234) + output from delta (77) + cache
expect('anthropic streaming usage logged (input=1234 output=77)', /POST \/v1\/messages model=claude-opus-4-8 -> anthropic .*input=1234 .*output=77/.test(logs));
expect('anthropic streaming cache tokens logged', /cache_read=1000/.test(logs) && /cache_create=50/.test(logs));
// Non-stream anthropic JSON usage
expect('anthropic json usage logged (input=555 output=42)', /POST \/v1\/messages model=claude-opus-4-8 -> anthropic .*input=555 .*output=42/.test(logs));
// Local route usage
expect('local usage logged (input=11 output=22)', /POST \/v1\/messages model=claude-sonnet-4-6 -> local\(anthropic:local-x\) .*input=11 .*output=22/.test(logs));
// Request + tokens are on ONE line (no separate bare request line for messages)
expect('no separate request line for messages', !/-> anthropic$/m.test(logs) && !/-> local\([^)]*\)$/m.test(logs));
// No extra upstream calls: exactly 2 anthropic (stream+json), 1 local. count_tokens was never called.
expect('no extra anthropic upstream calls (exactly 2)', anthropicHits === 2);
expect('no extra local upstream calls (exactly 1)', localHits === 1);

let pass = 0, fail = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); ok ? pass++ : fail++; }
if (fail) { console.log('\n--- router logs ---\n' + logs); }
console.log(`\n${pass} passed, ${fail} failed`);
anthropic.close(); local.close();
process.exit(fail ? 1 : 0);