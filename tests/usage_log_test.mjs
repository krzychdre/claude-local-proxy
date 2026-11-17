// Integration smoke test for the token-usage logging.
// Spins up mock upstreams + the real router as a child process, sends requests,
// and asserts the proxy folds token usage onto the request line WITHOUT making any extra
// upstream call (we count upstream hits).
import { mockServer, startRouter, wait, ok, finish } from './helpers.mjs';

let anthropicHits = 0;
let localHits = 0;

// Mock "Anthropic" upstream: streaming SSE for stream:true, JSON otherwise.
// The model name claude-opus-broken gets its connection cut without an answer.
const anthropic = await mockServer((req, res, body) => {
  if (body.model === 'claude-opus-broken') return req.socket.destroy();
  anthropicHits++;
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

// Mock local Anthropic-flavored upstream (non-stream JSON with usage).
const local = await mockServer((req, res, body) => {
  localHits++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_3', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'yo' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 22 } }));
});

const router = await startRouter({
  ANTHROPIC_UPSTREAM_URL: anthropic,
  LOCAL_BASE_URL: local, LOCAL_FLAVOR: 'anthropic', LOCAL_MODEL: 'local-x',
  LOCAL_TIERS: 'sonnet,haiku', ROUTER_LOG_USAGE: '1', ROUTER_LOG_LEVEL: 'info',
});
const post = body => fetch(`${router.base}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' }, body: JSON.stringify(body),
});

// 1) Opus streaming -> anthropic upstream, usage from message_start + message_delta
const streamOut = await (await post({ model: 'claude-opus-4-8', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).text();
// 2) Opus non-stream -> anthropic JSON usage
await (await post({ model: 'claude-opus-4-8', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).text();
// 3) Sonnet non-stream -> local upstream usage
await (await post({ model: 'claude-sonnet-4-6', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).text();
// 4) Upstream fails before answering -> there is no usage to fold in
const broken = await post({ model: 'claude-opus-broken', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
await broken.text();

// The log lines are written after each response has gone out.
await wait(200);
const logs = router.logs;
const requestLines = model => logs.split('\n').filter(l => l.includes(`model=${model} ->`));

// Streaming response still well-formed (tee didn't corrupt it)
ok('stream response relayed intact (message_start present)', streamOut.includes('event: message_start'));
ok('stream response relayed intact (message_stop present)', streamOut.includes('message_stop'));

// Usage folded onto the request line: streaming merges input from start (1234) + output from delta (77) + cache
ok('anthropic streaming usage logged (input=1234 output=77)', /POST \/v1\/messages model=claude-opus-4-8 -> anthropic .*input=1234 .*output=77/.test(logs));
ok('anthropic streaming cache tokens logged', /cache_read=1000/.test(logs) && /cache_create=50/.test(logs));
// Non-stream anthropic JSON usage
ok('anthropic json usage logged (input=555 output=42)', /POST \/v1\/messages model=claude-opus-4-8 -> anthropic .*input=555 .*output=42/.test(logs));
// Local route usage
ok('local usage logged (input=11 output=22)', /POST \/v1\/messages model=claude-sonnet-4-6 -> local\(anthropic:local-x\) .*input=11 .*output=22/.test(logs));
// Request + tokens are on ONE line (no separate bare request line for messages)
ok('no separate request line for messages',
  requestLines('claude-opus-4-8').length === 2 && requestLines('claude-sonnet-4-6').length === 1);
// A failed request has no tokens to show, but its request line must not vanish
ok('failed upstream call answered 502', broken.status === 502);
ok('failed upstream call still logs its request line',
  requestLines('claude-opus-broken').length === 1 && requestLines('claude-opus-broken')[0].endsWith('-> anthropic'));
// No extra upstream calls: exactly 2 answered by anthropic (stream + json), 1 by local. count_tokens was never called.
ok('no extra anthropic upstream calls (exactly 2)', anthropicHits === 2);
ok('no extra local upstream calls (exactly 1)', localHits === 1);

finish();
