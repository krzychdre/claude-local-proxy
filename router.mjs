#!/usr/bin/env node
// Model-aware routing proxy for Claude Code.
//
// Claude Code points ANTHROPIC_BASE_URL at this proxy. For every request the
// proxy inspects the `model` field and decides where it goes:
//
//   model matches a "local tier"  ->  your local LLM
//   anything else (e.g. opus)     ->  the real Anthropic API (transparent)
//
// The Anthropic path is a transparent reverse proxy: it relays your original
// auth headers (OAuth subscription bearer or x-api-key) untouched, so Opus
// traffic is billed/served exactly as if Claude Code talked to Anthropic
// directly. The local path can speak either the Anthropic Messages API
// (pass-through) or the OpenAI Chat Completions API (full translation,
// including streaming + tool calls) depending on `localFlavor`.
//
// Supports one or more local backends — each tier (sonnet, haiku, etc.) can
// map to a different model or even a different server.
// Zero dependencies. Requires Node >= 18 (uses global fetch + web streams).
//
// See README.md for configuration. The implementation lives in ./lib/.

import { loadConfig } from './lib/config.mjs';
import { startServer } from './lib/server.mjs';

startServer(loadConfig());
