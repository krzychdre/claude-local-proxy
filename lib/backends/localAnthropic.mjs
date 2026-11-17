// Local backend, Anthropic flavor: pass-through to an Anthropic-compatible
// gateway. The request is rewritten into that gateway's dialect (see
// toLocalAnthropic) and the auth is swapped for the local backend's key.

import { copyHeaders, buildUrl } from '../http.mjs';
import { applyLocalAuth } from '../auth.mjs';
import { forwardTransparent } from '../upstream.mjs';
import { estimateTokens } from '../translate.mjs';

// An Anthropic /v1/messages body in the dialect of one local gateway: its own
// model name, and its own name for an effort level where backend.effortMap
// lists one. Everything else is left untouched.
export function toLocalAnthropic(body, backend) {
  const out = { ...body, model: backend.model };
  const effort = body.output_config?.effort;
  if (effort in backend.effortMap) {
    out.output_config = { ...body.output_config, effort: backend.effortMap[effort] };
  }
  return out;
}

export const localAnthropicBackend = {
  async handle(ctx) {
    // count_tokens with the 'estimate' policy is answered locally; otherwise we
    // fall through to forwarding it to the gateway (anthropic-style pass-through).
    if (ctx.isCount && ctx.cfg.countTokens === 'estimate') {
      ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
      return ctx.res.end(JSON.stringify({ input_tokens: estimateTokens(ctx.body || {}) }));
    }

    const backend = ctx.backend;
    const h = copyHeaders(ctx.req);
    applyLocalAuth(h, backend);

    const outBuf = Buffer.from(JSON.stringify(toLocalAnthropic(ctx.body, backend)));
    const target = buildUrl(backend.baseUrl, ctx.url);
    await forwardTransparent(target, ctx.req.method, h, outBuf, ctx.res, ctx.usage, ctx.signal);
  },
};
