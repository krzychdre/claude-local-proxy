// Anthropic backend: transparent reverse proxy to the real api.anthropic.com.
// Relays the original request headers (with auth applied) and pipes the
// response back untouched.

import { copyHeaders, buildUrl } from '../http.mjs';
import { applyAnthropicAuth } from '../auth.mjs';
import { forwardTransparent } from '../upstream.mjs';

export const anthropicBackend = {
  async handle(ctx) {
    const h = copyHeaders(ctx.req);
    applyAnthropicAuth(h);
    const target = buildUrl(ctx.cfg.anthropicBaseUrl, ctx.url);
    await forwardTransparent(target, ctx.req.method, h, ctx.bodyBuf, ctx.res, ctx.usage);
  },
};
