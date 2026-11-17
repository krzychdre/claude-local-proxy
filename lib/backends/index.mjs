// Backend handler registry: the open/closed seam.
//
// Each handler is an object with a single `handle(ctx)` method. To add a new
// local flavor, create a new handler module and add one line to LOCAL; the
// server, router, and existing handlers stay untouched.

import { anthropicBackend } from './anthropic.mjs';
import { localAnthropicBackend } from './localAnthropic.mjs';
import { localOpenaiBackend } from './localOpenai.mjs';

// Keyed by the `flavor` of a local backend config.
const LOCAL = {
  anthropic: localAnthropicBackend,
  openai: localOpenaiBackend,
};

export const LOCAL_FLAVORS = Object.keys(LOCAL);

// `upstream` is the literal 'anthropic' or a backend config object from
// pickUpstream ({ route: 'local', flavor, ... }). Its flavor is one of
// LOCAL_FLAVORS: startServer refuses to start otherwise.
export function handlerFor(upstream) {
  return upstream === 'anthropic' ? anthropicBackend : LOCAL[upstream.flavor];
}
