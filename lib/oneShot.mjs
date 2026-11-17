// One buffered, non-streaming call to whichever upstream serves this request,
// normalised to an Anthropic message object.
//
// The regular backends in lib/backends/ stream straight through to the client
// and never look at what the model said. The web-tool resolver in websearch.mjs
// has to: it inspects a complete response, may run a search, and asks again.
// That needs a route-agnostic "call once, give me the whole answer" primitive,
// which is this module. `callOnce` picks the upstream from the request context,
// so the resolver works identically on the local route (mode 'local') and on the
// Anthropic route (mode 'always').

import { fetchWithTimeout, upstreamError, joinChatUrl, buildUrl, copyHeaders } from './http.mjs';
import { toOpenAI, fromOpenAINonStream } from './translate.mjs';
import { applyLocalAuth, applyAnthropicAuth } from './auth.mjs';
import { toLocalAnthropic } from './backends/localAnthropic.mjs';

// `anthBody` is an Anthropic /v1/messages body. The returned message always
// carries the *client's* model name, not the backend's, so the caller can hand
// it back to Claude Code unchanged.
async function callLocalOnce(cfg, backend, anthBody, signal) {
  if (backend.flavor === 'openai') {
    const headers = { 'Content-Type': 'application/json' };
    if (backend.apiKey) headers['Authorization'] = `Bearer ${backend.apiKey}`;
    const up = await fetchWithTimeout(
      joinChatUrl(backend.baseUrl),
      { method: 'POST', headers, body: JSON.stringify(toOpenAI({ ...anthBody, stream: false }, backend.model)), signal },
      cfg.upstreamTimeoutMs,
    );
    if (!up.ok) throw await upstreamError(up, 'local');
    return fromOpenAINonStream(await up.json(), anthBody.model);
  }

  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  applyLocalAuth(headers, backend);
  const up = await fetchWithTimeout(
    buildUrl(backend.baseUrl, '/v1/messages'),
    { method: 'POST', headers, body: JSON.stringify({ ...toLocalAnthropic(anthBody, backend), stream: false }), signal },
    cfg.upstreamTimeoutMs,
  );
  if (!up.ok) throw await upstreamError(up, 'local');
  return { ...(await up.json()), model: anthBody.model };
}

// The real api.anthropic.com, called non-streaming. The client's own headers are
// relayed (with the usual auth policy) so beta flags and the API version travel
// with the request; only the framing headers are forced, because we want one
// JSON document back rather than the SSE stream the client asked for.
async function callAnthropicOnce(ctx, anthBody) {
  const headers = copyHeaders(ctx.req);
  applyAnthropicAuth(headers);
  headers['content-type'] = 'application/json';
  headers['accept'] = 'application/json';
  // Unlike the transparent proxy we are *composing* a request rather than
  // relaying one, so we cannot rely on the client having sent the version
  // header. Claude Code always does; a bare curl does not, and the upstream
  // rejects the call outright.
  if (!Object.keys(headers).some(k => k.toLowerCase() === 'anthropic-version')) {
    headers['anthropic-version'] = '2023-06-01';
  }

  const up = await fetchWithTimeout(
    buildUrl(ctx.cfg.anthropicBaseUrl, '/v1/messages'),
    { method: 'POST', headers, body: JSON.stringify({ ...anthBody, stream: false }), signal: ctx.signal },
    ctx.cfg.upstreamTimeoutMs,
  );
  if (!up.ok) throw await upstreamError(up, 'anthropic');
  return up.json();
}

// Route-agnostic entry point used by the web-tool resolver.
export function callOnce(ctx, anthBody) {
  return ctx.upstream === 'anthropic'
    ? callAnthropicOnce(ctx, anthBody)
    : callLocalOnce(ctx.cfg, ctx.backend, anthBody, ctx.signal);
}
