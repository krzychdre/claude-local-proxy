// Local backend, OpenAI flavor: translate the Anthropic /v1/messages request to
// OpenAI Chat Completions, call the local server, and translate the OpenAI
// response (streaming or not) back into Anthropic SSE/JSON. count_tokens is
// always answered with a local estimate (no OpenAI count endpoint is assumed).

import { fetchWithTimeout, joinChatUrl, upstreamError } from '../http.mjs';
import {
  toOpenAI, fromOpenAINonStream, streamOpenAIToAnthropic, estimateTokens,
} from '../translate.mjs';
import { recordUsage } from '../log.mjs';

export const localOpenaiBackend = {
  async handle(ctx) {
    if (ctx.isCount) {
      ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
      return ctx.res.end(JSON.stringify({ input_tokens: estimateTokens(ctx.body || {}) }));
    }

    const backend = ctx.backend;
    const oaiBody = toOpenAI(ctx.body || {}, backend.model);
    const headers = { 'Content-Type': 'application/json' };
    if (backend.apiKey) headers['Authorization'] = `Bearer ${backend.apiKey}`;

    const up = await fetchWithTimeout(
      joinChatUrl(backend.baseUrl),
      { method: 'POST', headers, body: JSON.stringify(oaiBody), signal: ctx.signal },
      ctx.cfg.upstreamTimeoutMs,
    );

    if (!up.ok) throw await upstreamError(up, 'local');

    if (oaiBody.stream) {
      return streamOpenAIToAnthropic(up, ctx.res, ctx.model, usage => recordUsage(ctx.usage, usage));
    }

    const oai = await up.json();
    const anthResp = fromOpenAINonStream(oai, ctx.model);
    recordUsage(ctx.usage, anthResp.usage);
    ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify(anthResp));
  },
};
