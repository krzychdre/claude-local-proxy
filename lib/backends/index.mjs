// Backend handler registry — the open/closed seam.
//
// Each handler is an object with a single `handle(ctx)` method. To add a new
// local flavor, create a new handler module and add one line to REGISTRY; the
// server, router, and existing handlers stay untouched.

import { anthropicBackend } from './anthropic.mjs';
import { localAnthropicBackend } from './localAnthropic.mjs';
import { localOpenaiBackend } from './localOpenai.mjs';

const REGISTRY = {
  anthropic: anthropicBackend,
  'local:anthropic': localAnthropicBackend,
  'local:openai': localOpenaiBackend,
};

// `upstream` is the literal 'anthropic' or a backend config object from
// pickUpstream ({ route: 'local', flavor, ... }).
export function handlerFor(upstream) {
  if (upstream === 'anthropic') return REGISTRY.anthropic;
  return REGISTRY[`local:${upstream.flavor}`] ?? REGISTRY.anthropic;
}
