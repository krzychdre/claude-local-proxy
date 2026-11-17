// Transparent reverse proxy: relay an upstream response straight back to the
// client. When usage logging is on and the response is 2xx, the body is teed
// (streamed through untouched, never buffered for SSE) to extract the token
// usage the upstream already includes, with no extra request and no extra cost.

import { fetchWithTimeout } from './http.mjs';
import { recordUsage } from './log.mjs';
import { parseSSE } from './sse.mjs';

let cfg = {};
export function initUpstream(c) { cfg = c; }

// Response headers describing how the upstream framed its body. fetch has
// already decoded that body and Node frames our own response, so these would
// lie; everything else (rate-limit state, retry-after, request-id) is relayed.
const STRIP_RES_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

// Pass each raw chunk on to the client before handing it to the SSE parser.
async function* relayChunks(body, res) {
  for await (const ch of body) {
    res.write(ch);
    yield ch;
  }
}

// Relay an SSE stream unchanged while collecting the Anthropic usage from it.
// The usage is recorded even when the stream fails or the client leaves early:
// what the upstream reported up to that point was still spent.
async function relaySseWithUsage(body, res, usageCtx) {
  let usage = null;
  try {
    for await (const j of parseSSE(relayChunks(body, res))) {
      if (j.type === 'message_start' && j.message && j.message.usage) usage = { ...j.message.usage };
      else if (j.type === 'message_delta' && j.usage) usage = { ...usage, ...j.usage };
    }
  } finally {
    recordUsage(usageCtx, usage);
  }
}

// Non-streaming JSON: relay chunks while buffering, then parse once for usage.
async function relayJsonWithUsage(body, res, usageCtx) {
  const chunks = [];
  for await (const ch of relayChunks(body, res)) chunks.push(ch);
  let j;
  try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
  recordUsage(usageCtx, j.usage);
}

export async function forwardTransparent(targetUrl, method, headers, bodyBuf, res, usageCtx, signal) {
  const init = { method, headers, signal };
  if (bodyBuf.length && method !== 'GET' && method !== 'HEAD') init.body = bodyBuf;
  const up = await fetchWithTimeout(targetUrl, init, cfg.upstreamTimeoutMs);

  res.writeHead(up.status, [...up.headers].filter(([name]) => !STRIP_RES_HEADERS.has(name)));
  if (!up.body) return res.end();

  if (usageCtx && cfg.logUsage && up.ok) {
    const isSse = (up.headers.get('content-type') || '').includes('text/event-stream');
    await (isSse ? relaySseWithUsage : relayJsonWithUsage)(up.body, res, usageCtx);
  } else {
    for await (const ch of up.body) res.write(ch);
  }
  res.end();
}
