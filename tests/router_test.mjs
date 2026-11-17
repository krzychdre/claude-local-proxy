// OpenAI-flavor local path (request + streaming translation, tool calls,
// count_tokens, upstream errors) and the transparent Anthropic path.
import http from 'node:http';
import { mockServer, startRouter, sseEvents, ok, finish } from './helpers.mjs';

// Mock local LLM (OpenAI flavor): streams text + a tool call. A prompt saying
// TOO-LONG gets the 400 a real server answers to an oversized prompt.
let lastOpenAI = null;
const openai = await mockServer((req, res, body) => {
  lastOpenAI = body;
  if (JSON.stringify(body.messages).includes('TOO-LONG')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'context length exceeded' } }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const ev = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  ev({ choices: [{ delta: { content: 'Hello ' } }] });
  ev({ choices: [{ delta: { content: 'world' } }] });
  ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } }] });
  ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] });
  ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  res.write('data: [DONE]\n\n');
  res.end();
});

// Mock Anthropic (the "real" upstream): echoes auth + model. The model name
// claude-opus-limited gets a rate-limit answer with the headers the client
// steers its retries and its usage warnings by.
const anthropic = await mockServer((req, res, body) => {
  if (body.model === 'claude-opus-limited') {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': '7',
      'anthropic-ratelimit-unified-status': 'rejected',
      'request-id': 'req_123',
    });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ routed: 'anthropic', model: body.model, sawAuth: req.headers['authorization'] || req.headers['x-api-key'] || null }));
});

const router = await startRouter({
  LOCAL_BASE_URL: openai,
  LOCAL_FLAVOR: 'openai',
  LOCAL_MODEL: 'my-local-model',
  LOCAL_TIERS: 'sonnet',
  ANTHROPIC_UPSTREAM_URL: anthropic,
  ROUTER_LOG_LEVEL: 'warn',
});
const post = body => fetch(`${router.base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-oat-XYZ' },
  body: JSON.stringify(body),
});

// 1) opus -> anthropic passthrough, auth relayed
{
  const j = await (await post({ model: 'claude-opus-4-8', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).json();
  ok('opus routes to Anthropic', j.routed === 'anthropic' && j.model === 'claude-opus-4-8');
  ok('original auth relayed upstream', j.sawAuth === 'Bearer sk-ant-oat-XYZ');
}

// 2) the Anthropic answer comes back with its status and its headers
{
  const r = await post({ model: 'claude-opus-limited', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  const j = await r.json();
  ok('upstream status relayed', r.status === 429 && j.error.type === 'rate_limit_error');
  ok('retry-after relayed', r.headers.get('retry-after') === '7');
  ok('rate-limit state relayed', r.headers.get('anthropic-ratelimit-unified-status') === 'rejected');
  ok('request-id relayed', r.headers.get('request-id') === 'req_123');
}

// 3) a request body sent with chunked transfer encoding still reaches the upstream
{
  const j = await new Promise(resolve => {
    const req = http.request(`${router.base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-oat-XYZ' } }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve(JSON.parse(out)));
    });
    // No Content-Length and several writes: Node sends this chunked.
    req.write('{"model":"claude-opus-4-8",');
    req.end('"messages":[]}');
  });
  ok('chunked request body forwarded', j.routed === 'anthropic' && j.model === 'claude-opus-4-8');
}

// 4) sonnet -> local, OpenAI translated streaming -> Anthropic SSE
{
  const r = await post({ model: 'claude-sonnet-4-6', max_tokens: 50, stream: true, system: 'be brief', tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }], messages: [{ role: 'user', content: 'weather?' }] });
  const txt = await r.text();
  ok('sonnet emits Anthropic message_start', /event: message_start/.test(txt));
  ok('text delta translated', /"type":"text_delta","text":"Hello "/.test(txt) && /"text":"world"/.test(txt));
  ok('tool_use block opened', /"type":"tool_use"[^}]*"name":"get_weather"/.test(txt));
  ok('tool args streamed as input_json_delta', /"partial_json":"\{\\"city\\":"/.test(txt) && /"partial_json":"\\"Paris\\"\}"/.test(txt));
  ok('stop_reason tool_use', /"stop_reason":"tool_use"/.test(txt));
  ok('message_stop terminates', /event: message_stop/.test(txt));
  const { usage } = sseEvents(txt).find(e => e.type === 'message_delta');
  ok('prompt size reaches the client in message_delta', usage.input_tokens === 11 && usage.output_tokens === 7);
  // verify request translation sent to the local server
  ok('local got system prepended', lastOpenAI.messages[0].role === 'system');
  ok('local got model override', lastOpenAI.model === 'my-local-model');
  ok('local got tools', lastOpenAI.tools[0].function.name === 'get_weather');
}

// 5) an error answer of the local server keeps its status (a 400 is final for
//    the client, a 502 would be retried)
{
  const r = await post({ model: 'claude-sonnet-4-6', max_tokens: 50, messages: [{ role: 'user', content: 'TOO-LONG' }] });
  const j = await r.json();
  ok('local upstream error status relayed', r.status === 400);
  ok('local upstream error text relayed', j.type === 'error' && j.error.message.includes('context length exceeded'));
}

// 6) count_tokens on local sonnet -> estimated, no upstream call
{
  const r = await fetch(`${router.base}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'abcdefghij' }] }) });
  const j = await r.json();
  ok('count_tokens returns input_tokens', typeof j.input_tokens === 'number' && j.input_tokens > 0);
}

finish();
