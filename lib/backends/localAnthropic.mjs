// Local backend, Anthropic flavor: pass-through to an Anthropic-compatible
// gateway. The only transformation is rewriting the `model` field to the local
// model name and swapping auth for the local backend's key.

import { copyHeaders, buildUrl } from '../http.mjs';
import { applyLocalAuth } from '../auth.mjs';
import { forwardTransparent } from '../upstream.mjs';
import { estimateTokens } from '../translate.mjs';

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

    // Rewrite the model field; leave everything else untouched.
    let outBuf = ctx.bodyBuf;
    if (ctx.body) {
      ctx.body.model = backend.model;
      outBuf = Buffer.from(JSON.stringify(ctx.body));
    }
    const target = buildUrl(backend.baseUrl, ctx.url);
    await forwardTransparent(target, ctx.req.method, h, outBuf, ctx.res, ctx.usage);
  },
};
