// Configuration: defaults, file resolution, env overrides.
//
// The proxy reads config from the first existing file in a real-filesystem
// search chain (matters for the compiled single-binary build, where
// import.meta.url points inside bun's virtual bundle, not on disk):
//   1. $ROUTER_CONFIG              explicit override (always wins if set)
//   2. ./router.config.json        CWD — project-local / repo dev
//   3. ~/.config/claude-router/config.json   XDG — installed-service default
//   4. <script dir>/router.config.json       script-adjacent dev fallback
// Then any set env var overrides a field on top.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// Accepted values for webSearch.mode.
const WEB_SEARCH_MODES = ['off', 'local', 'always'];

export const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',

  // Upstream for everything NOT routed local (the real Anthropic API).
  anthropicBaseUrl: 'https://api.anthropic.com',
  // Optional: force a specific Anthropic credential for the upstream instead of
  // relaying Claude Code's own auth. Leave empty to pass through (recommended).
  anthropicUpstreamKey: '',
  // If the incoming Anthropic-bound request carries no auth at all, fall back to
  // the OAuth access token stored by Claude Code. Best-effort (no auto-refresh).
  anthropicCredsFallback: true,
  anthropicCredsPath: path.join(process.env.HOME || '', '.claude', '.credentials.json'),

  // Local LLM upstream.
  localBaseUrl: 'http://127.0.0.1:11434', // Ollama default; root URL (no /v1)
  localFlavor: 'openai',                  // 'openai' | 'anthropic'
  localModel: 'qwen2.5-coder:14b',        // model name your local server actually serves
  localApiKey: 'local',                   // sent as Bearer/x-api-key to the local server (Ollama ignores it)

  // Which model-name substrings get routed to the local LLM. Case-insensitive.
  // Default honours "replace sonnet, keep the rest on Anthropic".
  localTiers: ['sonnet'],

  // Effort levels the local model names differently: maps the value Claude Code
  // sends in `output_config.effort` (low | medium | high | xhigh | max) to the
  // one the model accepts, e.g. { "medium": "high" }. Unlisted levels pass
  // through unchanged. Applies to anthropic-flavor backends.
  localEffortMap: {},

  // Optional: per-tier local backends. Each entry has a `tier` (substring matched
  // against the model name) and `model`. Optionally override `baseUrl`, `flavor`,
  // `apiKey` and `effortMap` per backend. If a tier matches an entry in
  // localBackends, that entry's model overrides the flat `localModel`. Falls
  // back to the flat config for anything not listed here.
  localBackends: [],

  // count_tokens for local models: 'estimate' answers with a chars/4 estimate;
  // 'anthropic' forwards the call to an anthropic-flavor local gateway (an
  // openai-flavor backend is always estimated).
  countTokens: 'estimate',

  // Claude Code's WebSearch/WebFetch are Anthropic *server* tools: the request
  // carries only a stub that no local gateway can execute. See lib/websearch.mjs.
  //   mode 'off'    — strip the stubs on the local route, leave the Anthropic
  //                   route alone. Prefer this when the searxNcrawl or crawl4ai
  //                   MCP servers are connected: those run client-side and
  //                   already work with any model, streaming included.
  //   mode 'local'  — (default) the proxy runs the tools itself against searxUrl
  //                   (SearXNG) and crawl4aiUrl, but only for locally served
  //                   models; Anthropic models keep their own web tools.
  //   mode 'always' — the proxy serves the web tools on every route, so no query
  //                   or page URL leaves the network even for Anthropic models.
  // In 'local' and 'always' a tool whose endpoint is unset is not served: on the
  // local route its stub is stripped, on the Anthropic route it is left in place.
  webSearch: {
    mode: 'local',
    searxUrl: '',
    crawl4aiUrl: '',
    crawl4aiToken: '',
    maxResults: 5,        // results kept per search
    snippetChars: 400,    // per-result snippet cap
    fetchChars: 20_000,   // per-page markdown cap
    maxRounds: 3,         // search/answer round trips before the tools are withdrawn
    timeoutMs: 30_000,    // per web-tool call
  },

  logLevel: 'info', // 'debug' | 'info' | 'warn' | 'error'

  // Token-usage logging. Reads the usage Anthropic/local already return in each
  // response — no extra API calls, no extra cost. logUsage emits one info line
  // per request; usageLogFile (optional) also appends one JSON record per line.
  logUsage: false,
  usageLogFile: '',

  // Max request body size in bytes. Requests exceeding this receive a 413 error.
  maxBodyBytes: 64 * 1024 * 1024, // 64 MB

  // Time-to-first-byte timeout for upstream requests (ms). Only covers the
  // connection + headers phase; once the response starts streaming, no timeout
  // is applied so long generations are not interrupted.
  upstreamTimeoutMs: 120_000, // 2 minutes
};

// Returns the first existing candidate path, else the XDG path (the intended
// home, used for the "no config found" message).
export function resolveConfigPath() {
  if (process.env.ROUTER_CONFIG) return process.env.ROUTER_CONFIG;
  const xdgBase = process.env.XDG_CONFIG_HOME
    || (process.env.HOME ? path.join(process.env.HOME, '.config') : '');
  const xdgPath = xdgBase ? path.join(xdgBase, 'claude-router', 'config.json') : '';
  const candidates = [
    path.join(process.cwd(), 'router.config.json'),
    xdgPath,
    path.join(__dir, '..', 'router.config.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return xdgPath || candidates[candidates.length - 1];
}

// Boolean env vars accept 1/true/yes (case-insensitive).
const isTruthy = v => /^(1|true|yes)$/i.test(v);

function applyEnvOverrides(c) {
  const E = process.env;
  if (E.PORT) c.port = +E.PORT;
  if (E.ROUTER_HOST) c.host = E.ROUTER_HOST;
  if (E.ANTHROPIC_UPSTREAM_URL) c.anthropicBaseUrl = E.ANTHROPIC_UPSTREAM_URL;
  if (E.ANTHROPIC_UPSTREAM_KEY) c.anthropicUpstreamKey = E.ANTHROPIC_UPSTREAM_KEY;
  if (E.LOCAL_BASE_URL) c.localBaseUrl = E.LOCAL_BASE_URL;
  if (E.LOCAL_FLAVOR) c.localFlavor = E.LOCAL_FLAVOR;
  if (E.LOCAL_MODEL) c.localModel = E.LOCAL_MODEL;
  if (E.LOCAL_API_KEY) c.localApiKey = E.LOCAL_API_KEY;
  if (E.LOCAL_TIERS) c.localTiers = E.LOCAL_TIERS.split(',').map(s => s.trim()).filter(Boolean);
  if (E.ROUTER_LOG_LEVEL) c.logLevel = E.ROUTER_LOG_LEVEL;
  if (E.ROUTER_LOG_USAGE) c.logUsage = isTruthy(E.ROUTER_LOG_USAGE);
  if (E.ROUTER_USAGE_LOG_FILE) c.usageLogFile = E.ROUTER_USAGE_LOG_FILE;
  if (E.MAX_BODY_BYTES) c.maxBodyBytes = parseInt(E.MAX_BODY_BYTES, 10);
  if (E.UPSTREAM_TIMEOUT_MS) c.upstreamTimeoutMs = parseInt(E.UPSTREAM_TIMEOUT_MS, 10);
  if (E.WEB_SEARCH_MODE) c.webSearch.mode = E.WEB_SEARCH_MODE;
  if (E.SEARXNG_URL) c.webSearch.searxUrl = E.SEARXNG_URL;
  if (E.CRAWL4AI_URL) c.webSearch.crawl4aiUrl = E.CRAWL4AI_URL;
  if (E.CRAWL4AI_API_TOKEN) c.webSearch.crawl4aiToken = E.CRAWL4AI_API_TOKEN;
  return c;
}

// Build the config from the file at `cfgPath` (if there is one) and the env
// overrides. Throws when the file exists but cannot be loaded: that is not "no
// config", and running on the defaults would route to a local server nobody
// set up.
export function loadConfig(cfgPath) {
  let fileCfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      throw new Error(`cannot load ${cfgPath}: ${e.message}`);
    }
  }
  // webSearch is merged one level deeper, so a config file that sets only
  // `mode` still inherits the caps and timeouts instead of blanking them.
  const c = applyEnvOverrides({
    ...DEFAULTS,
    ...fileCfg,
    webSearch: { ...DEFAULTS.webSearch, ...(fileCfg.webSearch || {}) },
  });
  // A misspelt mode falls back to the default rather than to 'off': a typo
  // should not silently take web search away.
  if (!WEB_SEARCH_MODES.includes(c.webSearch.mode)) {
    console.error(`[router] unknown webSearch.mode "${c.webSearch.mode}", expected one of ${WEB_SEARCH_MODES.join(' | ')}; using "${DEFAULTS.webSearch.mode}"`);
    c.webSearch.mode = DEFAULTS.webSearch.mode;
  }
  c.configPath = cfgPath;
  c.configLoaded = Object.keys(fileCfg).length > 0;
  return c;
}
