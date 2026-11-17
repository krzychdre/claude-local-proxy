// A client that hangs up mid-stream cancels the upstream call, on the
// transparent path and on the OpenAI-translated one, instead of leaving the
// upstream to generate an answer nobody reads.
import { mockServer, startRouter, wait, ok, finish } from './helpers.mjs';

const TOTAL_EVENTS = 30;

// Stream `first`, then `event` every 100 ms, TOTAL_EVENTS in all (3 s). The
// returned promise resolves, once the connection is closed, with the number of
// events written by then: TOTAL_EVENTS means the stream ran to its end.
function slowStream(res, first, event) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(first);
  let written = 0;
  const timer = setInterval(() => {
    if (written === TOTAL_EVENTS) return res.end();
    written++;
    res.write(event);
  }, 100);
  return new Promise(resolve => res.on('close', () => {
    clearInterval(timer);
    resolve(written);
  }));
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

let anthropicStream, openaiStream;
const anthropic = await mockServer((req, res) => {
  anthropicStream = slowStream(res,
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 321, output_tokens: 1 } } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }));
});
const openai = await mockServer((req, res) => {
  const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`;
  openaiStream = slowStream(res, chunk, chunk);
});

const router = await startRouter({
  ANTHROPIC_UPSTREAM_URL: anthropic,
  ANTHROPIC_UPSTREAM_KEY: 'test-key',
  LOCAL_BASE_URL: openai, LOCAL_FLAVOR: 'openai', LOCAL_TIERS: 'sonnet',
  ROUTER_LOG_USAGE: '1', ROUTER_LOG_LEVEL: 'info',
});

// Start a streaming request, read the first chunk, then drop the connection.
async function requestAndHangUp(model) {
  const client = new AbortController();
  const r = await fetch(`${router.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    signal: client.signal,
  });
  await r.body.getReader().read();
  client.abort();
}

await requestAndHangUp('claude-opus-4-8');
ok('transparent path: upstream cancelled when the client leaves', await anthropicStream < TOTAL_EVENTS);

await requestAndHangUp('claude-sonnet-4-6');
ok('openai path: upstream cancelled when the client leaves', await openaiStream < TOTAL_EVENTS);

// The log lines are written after the upstream calls have been torn down.
await wait(200);
ok('a client hanging up is not logged as an error', !router.logs.includes('ERROR'));
ok('usage reported before the hang-up is still logged',
  router.logs.includes('model=claude-opus-4-8 -> anthropic input=321'));

finish();
