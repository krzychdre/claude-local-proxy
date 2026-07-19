// Transparent reverse proxy: relay an upstream response straight back to the
// client. When usage logging is on and the response is 2xx, the body is teed
// (streamed through untouched, never buffered for SSE) to extract the token
// usage the upstream already includes — no extra request, no extra cost.

import { fetchWithTimeout } from './http.mjs';
import { log, recordUsage } from './log.mjs';

let cfg = {};
export function initUpstream(c) { cfg = c; }

// Relay `up` (a fetch Response) to `res`, copying status + content-type + the
// upstream request-id. `scanForUsage` is called with the body when usage logging
// is wanted (it returns the parsed usage or null).
async function relayResponse(up, res, usageCtx, scanForUsage) {
  const ct = up.headers.get('content-type') || 'application/json';
  const respHeaders = { 'Content-Type': ct };
  const reqId = up.headers.get('request-id');
  if (reqId) respHeaders['request-id'] = reqId;
  res.writeHead(up.status, respHeaders);

  if (!up.body) return res.end();

  const wantUsage = usageCtx && cfg.logUsage && up.status >= 200 && up.status < 300;
  if (!wantUsage) {
    for await (const ch of up.body) res.write(ch);
    return res.end();
  }

  const usage = await scanForUsage(up.body, res, ct);
  recordUsage(usageCtx, usage);
}

// Scan an SSE stream for Anthropic usage while relaying raw chunks to the client
// unchanged. Returns the merged usage (or null).
async function scanSseUsage(body, res) {
  const decoder = new TextDecoder();
  let buf = '';
  let usage = null;
  try {
    for await (const ch of body) {
      res.write(ch);
      buf += decoder.decode(ch, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j; try { j = JSON.parse(payload); } catch { continue; }
        if (j.type === 'message_start' && j.message && j.message.usage) usage = { ...j.message.usage };
        else if (j.type === 'message_delta' && j.usage) usage = { ...(usage || {}), ...j.usage };
      }
    }
  } catch (e) {
    log('error', `transparent stream relay error: ${e.message}`);
    // After writeHead we can't change status, but we can send an SSE error event.
    try {
      const errMsg = JSON.stringify({ type: 'error', error: { type: 'api_error', message: `upstream stream error: ${e.message}` } });
      res.write(`event: error\ndata: ${errMsg}\n\n`);
    } catch { /* client may have disconnected */ }
  }
  res.end();
  return usage;
}

// Non-streaming JSON: relay chunks while buffering, then parse once for usage.
async function scanJsonUsage(body, res) {
  const chunks = [];
  for await (const ch of body) { res.write(ch); chunks.push(ch); }
  res.end();
  try {
    const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return j && j.usage;
  } catch { return null; }
}

function pickScanner(ct) {
  return ct.includes('text/event-stream') ? scanSseUsage : scanJsonUsage;
}

export async function forwardTransparent(targetUrl, method, headers, bodyBuf, res, usageCtx) {
  const init = { method, headers };
  if (bodyBuf && bodyBuf.length && method !== 'GET' && method !== 'HEAD') init.body = bodyBuf;
  const up = await fetchWithTimeout(targetUrl, init, cfg.upstreamTimeoutMs);
  await relayResponse(up, res, usageCtx, (body, res2, ct) => pickScanner(ct)(body, res2));
}
