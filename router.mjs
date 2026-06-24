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

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULTS = {
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

  // Optional: per-tier local backends. Each entry has a `tier` (substring matched
  // against the model name) and `model`. Optionally override `baseUrl`, `flavor`,
  // and `apiKey` per backend. If a tier matches an entry in localBackends, that
  // entry's model overrides the flat `localModel`. Falls back to the flat config
  // for anything not listed here.
  localBackends: [],

  // count_tokens handling for the local (openai) path: 'estimate' avoids any
  // Anthropic dependency; 'anthropic' would proxy it upstream.
  countTokens: 'estimate',

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

// Resolve the config file from a real-filesystem search chain. This matters for
// the compiled single-binary build: there, import.meta.url (__dir) points inside
// bun's virtual bundle, not the binary's location on disk, so config must come
// from a real path. First existing file wins:
//   1. ROUTER_CONFIG               explicit override (always wins if set)
//   2. ./router.config.json        CWD — project-local / repo dev (current behavior)
//   3. ~/.config/claude-router/config.json   XDG — installed-service default
//   4. <script dir>/router.config.json       script-adjacent dev fallback
// Returns the first existing path, else the XDG path (the intended home, used for
// the "no config found" message).
function resolveConfigPath() {
  if (process.env.ROUTER_CONFIG) return process.env.ROUTER_CONFIG;
  const xdgBase = process.env.XDG_CONFIG_HOME
    || (process.env.HOME ? path.join(process.env.HOME, '.config') : '');
  const xdgPath = xdgBase ? path.join(xdgBase, 'claude-router', 'config.json') : '';
  const candidates = [
    path.join(process.cwd(), 'router.config.json'),
    xdgPath,
    path.join(__dir, 'router.config.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return xdgPath || candidates[candidates.length - 1];
}

function loadConfig() {
  let fileCfg = {};
  const cfgPath = resolveConfigPath();
  try {
    if (fs.existsSync(cfgPath)) fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.error(`[router] failed to parse ${cfgPath}: ${e.message}`);
  }
  const c = { ...DEFAULTS, ...fileCfg };
  c.configPath = cfgPath;
  c.configLoaded = fileCfg && Object.keys(fileCfg).length > 0;

  // Env overrides (handy for one-off launches).
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
  if (E.ROUTER_LOG_USAGE) c.logUsage = /^(1|true|yes)$/i.test(E.ROUTER_LOG_USAGE);
  if (E.ROUTER_USAGE_LOG_FILE) c.usageLogFile = E.ROUTER_USAGE_LOG_FILE;
  if (E.MAX_BODY_BYTES) c.maxBodyBytes = parseInt(E.MAX_BODY_BYTES, 10);
  if (E.UPSTREAM_TIMEOUT_MS) c.upstreamTimeoutMs = parseInt(E.UPSTREAM_TIMEOUT_MS, 10);
  return c;
}

const cfg = loadConfig();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// Local wall-clock HH:MM:SS.mmm (toISOString would print UTC).
function localTime(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function log(level, msg) {
  if ((LEVELS[level] || 20) < (LEVELS[cfg.logLevel] || 20)) return;
  const line = `[router ${localTime()}] ${level.toUpperCase()} ${msg}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

// Emit token usage already present in an upstream response. No-op unless logUsage
// is on. Optionally appends a JSON line to usageLogFile for per-session tallies.
// ctx should include { model, routeLabel, route, reqLine }. When reqLine is set
// (deferred from request time) the tokens are folded onto that same line so the
// query and its token counts sit side by side; ctx.logged records that we did.
function recordUsage(ctx, u) {
  if (!cfg.logUsage || !u) return;
  const fields = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
  if (u.cache_read_input_tokens != null) fields.cache_read = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) fields.cache_create = u.cache_creation_input_tokens;
  const summary = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
  const head = ctx && ctx.reqLine ? ctx.reqLine : `usage route=${ctx?.route || '-'} model=${ctx?.model || '-'}`;
  if (ctx) ctx.logged = true;
  log('info', `${head} ${summary}`);
  if (cfg.usageLogFile) {
    const rec = { ts: new Date().toISOString(), route: ctx.route, model: ctx.model || '', ...fields };
    fs.appendFile(cfg.usageLogFile, JSON.stringify(rec) + '\n', err => {
      if (err) log('warn', `usage log write failed: ${err.message}`);
    });
  }
}

// When the request line was deferred to fold tokens in, but no usage was
// recorded (upstream error, non-2xx, empty body), still emit the bare line.
function finishUsage(ctx) {
  if (ctx && ctx.reqLine && !ctx.logged) log('info', ctx.reqLine);
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

// Returns 'anthropic' or a backend config object { route: 'local', model, baseUrl, flavor, apiKey, tier }
function pickUpstream(model) {
  const m = String(model || '').toLowerCase();
  for (const tier of cfg.localTiers) {
    if (m.includes(String(tier).toLowerCase())) {
      // Check for a per-tier backend override
      if (Array.isArray(cfg.localBackends) && cfg.localBackends.length) {
        const override = cfg.localBackends.find(b => String(b.tier).toLowerCase() === String(tier).toLowerCase());
        if (override) {
          return {
            route: 'local',
            tier,
            model: override.model || cfg.localModel,
            baseUrl: override.baseUrl || cfg.localBaseUrl,
            flavor: override.flavor || cfg.localFlavor,
            apiKey: override.apiKey || cfg.localApiKey,
          };
        }
      }
      return { route: 'local', tier, model: cfg.localModel, baseUrl: cfg.localBaseUrl, flavor: cfg.localFlavor, apiKey: cfg.localApiKey };
    }
  }
  return 'anthropic';
}

// ---------------------------------------------------------------------------
// Upstream fetch with time-to-headers timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, init, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      const err = new Error(`upstream timeout after ${ms}ms: ${url}`);
      err.code = 'ETIMEDOUT';
      throw err;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Shared SSE parser (async generator yielding parsed JSON payloads)
// ---------------------------------------------------------------------------

async function* parseSSE(body, decoder) {
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      yield j;
    }
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function applyAnthropicAuth(headers, req) {
  if (cfg.anthropicUpstreamKey) {
    delete headers.authorization; delete headers.Authorization;
    headers['x-api-key'] = cfg.anthropicUpstreamKey;
  } else if (cfg.anthropicCredsFallback && !hasAuth(headers)) {
    const oauth = readOauthToken();
    if (oauth && oauth.accessToken) {
      headers['authorization'] = `Bearer ${oauth.accessToken}`;
      const beta = headers['anthropic-beta'] ? `${headers['anthropic-beta']},oauth-2025-04-20` : 'oauth-2025-04-20';
      headers['anthropic-beta'] = beta;
      log('debug', 'attached OAuth fallback token to Anthropic upstream');
    }
  }
}

function applyLocalAuth(headers, backend) {
  delete headers.authorization; delete headers.Authorization; delete headers['x-api-key'];
  if (backend.apiKey) {
    headers['x-api-key'] = backend.apiKey;
    headers['authorization'] = `Bearer ${backend.apiKey}`;
  }
}

// ---------------------------------------------------------------------------
// Anthropic <-> OpenAI translation (for localFlavor === 'openai')
// ---------------------------------------------------------------------------

function anthropicSystemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
  return '';
}

function convertMessages(messages) {
  const out = [];
  for (const msg of messages || []) {
    const { role, content } = msg;
    if (typeof content === 'string') { out.push({ role, content }); continue; }
    if (!Array.isArray(content)) { out.push({ role, content: String(content ?? '') }); continue; }

    if (role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const part of content) {
        if (part.type === 'text') text += part.text;
        else if (part.type === 'tool_use') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
          });
        }
      }
      const m = { role: 'assistant', content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
    } else {
      // user turn: may carry tool_result(s) answering the previous assistant
      // tool_calls, plus fresh text/images.
      const userParts = [];
      const toolMsgs = [];
      for (const part of content) {
        if (part.type === 'text') {
          userParts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          const src = part.source || {};
          let url;
          if (src.type === 'base64') url = `data:${src.media_type};base64,${src.data}`;
          else if (src.type === 'url') url = src.url;
          if (url) userParts.push({ type: 'image_url', image_url: { url } });
        } else if (part.type === 'tool_result') {
          const c = part.content;
          let text;
          if (typeof c === 'string') text = c;
          else if (Array.isArray(c)) {
            text = c.map(x => (x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : JSON.stringify(x))).join('\n');
          } else text = JSON.stringify(c ?? '');
          toolMsgs.push({ role: 'tool', tool_call_id: part.tool_use_id, content: text });
        }
      }
      // tool results first (they must directly follow the assistant tool_calls)
      for (const tm of toolMsgs) out.push(tm);
      if (userParts.length) {
        if (userParts.every(p => p.type === 'text')) {
          out.push({ role: 'user', content: userParts.map(p => p.text).join('\n') });
        } else {
          out.push({ role: 'user', content: userParts });
        }
      }
    }
  }
  return out;
}

function convertTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools
    .filter(t => t && t.name) // skip server-side tool stubs without a schema
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
}

function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool') return { type: 'function', function: { name: tc.name } };
  if (tc.type === 'none') return 'none';
  return undefined;
}

function toOpenAI(body, backendModel) {
  const messages = [];
  const sys = anthropicSystemToText(body.system);
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push(...convertMessages(body.messages));

  const o = { model: backendModel || cfg.localModel, messages, stream: !!body.stream };
  if (body.max_tokens != null) o.max_tokens = body.max_tokens;
  if (body.temperature != null) o.temperature = body.temperature;
  if (body.top_p != null) o.top_p = body.top_p;
  if (body.stop_sequences && body.stop_sequences.length) o.stop = body.stop_sequences;
  const tools = convertTools(body.tools);
  if (tools && tools.length) o.tools = tools;
  const tc = convertToolChoice(body.tool_choice);
  if (tc) o.tool_choice = tc;
  if (body.stream) o.stream_options = { include_usage: true };
  return o;
}

function mapFinish(fr) {
  switch (fr) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return fr ? 'end_turn' : null;
  }
}

let toolIdCounter = 0;
function newToolId(seed) { return `toolu_${Date.now().toString(36)}_${seed}_${toolIdCounter++}`; }

function fromOpenAINonStream(oai, model) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tcl = msg.tool_calls[i];
      let input = {};
      try { input = JSON.parse(tcl.function?.arguments || '{}'); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tcl.id || newToolId(i), name: tcl.function?.name, input });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = oai.usage || {};
  return {
    id: oai.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinish(choice.finish_reason) || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}

// Translate an OpenAI streaming response into Anthropic SSE, writing to `res`.
async function streamOpenAIToAnthropic(up, res, model, routeLabel, usageCtx) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const msgId = `msg_${Date.now()}`;
  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  send('ping', { type: 'ping' });

  let nextIndex = 0;
  let textOpen = false;
  let textIndex = -1;
  const toolBlocks = new Map(); // openai tool index -> { anthIndex }
  let finalStop = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };

  const closeText = () => {
    if (textOpen) { send('content_block_stop', { type: 'content_block_stop', index: textIndex }); textOpen = false; }
  };

  const decoder = new TextDecoder();
  let streamError = null;
  try {
    for await (const j of parseSSE(up.body, decoder)) {
      if (j.usage) {
        usage = {
          input_tokens: j.usage.prompt_tokens ?? usage.input_tokens,
          output_tokens: j.usage.completion_tokens ?? usage.output_tokens,
        };
      }
      const choice = (j.choices && j.choices[0]) || {};
      const delta = choice.delta || {};

      if (delta.content) {
        if (!textOpen) {
          textIndex = nextIndex++;
          textOpen = true;
          send('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
        }
        send('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const oaIdx = tc.index ?? 0;
          let blk = toolBlocks.get(oaIdx);
          if (!blk) {
            closeText(); // tool blocks come after any text block
            const anthIndex = nextIndex++;
            blk = { anthIndex };
            toolBlocks.set(oaIdx, blk);
            send('content_block_start', {
              type: 'content_block_start',
              index: anthIndex,
              content_block: { type: 'tool_use', id: tc.id || newToolId(oaIdx), name: tc.function?.name || '', input: {} },
            });
          }
          const argChunk = tc.function?.arguments;
          if (argChunk) {
            send('content_block_delta', { type: 'content_block_delta', index: blk.anthIndex, delta: { type: 'input_json_delta', partial_json: argChunk } });
          }
        }
      }

      if (choice.finish_reason) finalStop = mapFinish(choice.finish_reason) || 'end_turn';
    }
  } catch (e) {
    log('error', `stream relay error: ${e.message}`);
    streamError = e;
  }

  closeText();
  for (const blk of toolBlocks.values()) {
    send('content_block_stop', { type: 'content_block_stop', index: blk.anthIndex });
  }
  if (streamError) {
    send('error', { type: 'error', error: { type: 'api_error', message: `upstream stream error: ${streamError.message}` } });
  }
  send('message_delta', { type: 'message_delta', delta: { stop_reason: streamError ? 'end_turn' : finalStop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  send('message_stop', { type: 'message_stop' });
  res.end();
  recordUsage(usageCtx || { route: 'local', model, routeLabel }, usage);
}

// rough token estimate so the local path needs no Anthropic dependency
function estimateTokens(body) {
  let chars = anthropicSystemToText(body.system).length;
  for (const m of body.messages || []) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p.type === 'text') chars += (p.text || '').length;
        else if (p.type === 'tool_result') chars += JSON.stringify(p.content || '').length;
        else if (p.type === 'tool_use') chars += JSON.stringify(p.input || '').length + (p.name || '').length;
      }
    }
  }
  if (body.tools) chars += JSON.stringify(body.tools).length;
  return Math.max(1, Math.ceil(chars / 4));
}

// ---------------------------------------------------------------------------
// Upstream forwarding
// ---------------------------------------------------------------------------

function copyHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (['host', 'content-length', 'connection', 'accept-encoding'].includes(lk)) continue;
    h[k] = v;
  }
  return h;
}

function hasAuth(headers) {
  return Object.keys(headers).some(k => {
    const lk = k.toLowerCase();
    return lk === 'authorization' || lk === 'x-api-key';
  });
}

let cachedOauth = null;
function readOauthToken() {
  if (cachedOauth && cachedOauth.expiresAt && cachedOauth.expiresAt > Date.now() + 60_000) return cachedOauth;
  try {
    const c = JSON.parse(fs.readFileSync(cfg.anthropicCredsPath, 'utf8'));
    cachedOauth = c.claudeAiOauth || null;
    if (cachedOauth && cachedOauth.expiresAt && cachedOauth.expiresAt < Date.now()) {
      log('warn', 'OAuth token in credentials file looks expired; run `claude` once to refresh, or set anthropicUpstreamKey.');
    }
    return cachedOauth;
  } catch (e) {
    log('warn', `could not read OAuth fallback creds: ${e.message}`);
    return null;
  }
}

// Transparent reverse proxy: pipe upstream response straight back to the client.
// When usageCtx is provided and logUsage is on, the response is teed (streamed
// through untouched, never buffered for SSE) to extract the token usage the
// upstream already includes — no extra request, no extra cost.
async function forwardTransparent(targetUrl, method, headers, bodyBuf, res, usageCtx) {
  const init = { method, headers };
  if (bodyBuf && bodyBuf.length && method !== 'GET' && method !== 'HEAD') init.body = bodyBuf;
  const up = await fetchWithTimeout(targetUrl, init, cfg.upstreamTimeoutMs);

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

  if (ct.includes('text/event-stream')) {
    // Stream through untouched while scanning SSE events for usage.
    // We relay raw chunks to the client and parse inline for usage extraction.
    const decoder = new TextDecoder();
    let buf = '';
    let usage = null;
    try {
      for await (const ch of up.body) {
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
      // After writeHead(200) we can't change status, but we can send an SSE error event.
      try {
        const errMsg = JSON.stringify({ type: 'error', error: { type: 'api_error', message: `upstream stream error: ${e.message}` } });
        res.write(`event: error\ndata: ${errMsg}\n\n`);
      } catch { /* client may have disconnected */ }
    }
    res.end();
    recordUsage(usageCtx, usage);
  } else {
    // Non-streaming JSON: write through while buffering, then parse once.
    const chunks = [];
    for await (const ch of up.body) { res.write(ch); chunks.push(ch); }
    res.end();
    try {
      const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      recordUsage(usageCtx, j && j.usage);
    } catch { /* not JSON-with-usage; skip */ }
  }
}

function joinChatUrl(base) {
  const b = (base || cfg.localBaseUrl).replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handle(req, res, bodyBuf) {
  const url = req.url || '';

  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, localTiers: cfg.localTiers, localBackends: cfg.localBackends, localFlavor: cfg.localFlavor, localModel: cfg.localModel }));
  }

  const isCount = url.includes('/v1/messages/count_tokens');
  const isMessages = url.startsWith('/v1/messages') && !isCount;

  let body = null;
  if ((isMessages || isCount) && bodyBuf.length) {
    try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { body = null; }
  }

  const model = (body && body.model) || '';
  const upstream = isMessages || isCount ? pickUpstream(model) : 'anthropic';
  const isLocal = typeof upstream === 'object' && upstream.route === 'local';
  const backend = isLocal ? upstream : null; // { route, tier, model, baseUrl, flavor, apiKey }
  const routeLabel = isLocal ? `local(${backend.flavor}:${backend.model})` : (upstream === 'anthropic' ? 'anthropic' : upstream);
  const reqLine = `${req.method} ${url} model=${model || '-'} -> ${routeLabel}`;
  // When usage logging is on for a /v1/messages call, defer the request line and
  // fold the token counts onto it (one line); otherwise log it now.
  const combineUsage = cfg.logUsage && isMessages;
  if ((isMessages || isCount) && !combineUsage) log('info', reqLine);

  // ---- Anthropic (transparent) -------------------------------------------
  if (upstream === 'anthropic') {
    const h = copyHeaders(req);
    applyAnthropicAuth(h, req);
    const target = cfg.anthropicBaseUrl.replace(/\/+$/, '') + url;
    const ctx = isMessages ? { route: 'anthropic', model, routeLabel, reqLine } : null;
    await forwardTransparent(target, req.method, h, bodyBuf, res, ctx);
    if (combineUsage) finishUsage(ctx);
    return;
  }

  // ---- Local: count_tokens -----------------------------------------------
  if (isCount) {
    if (cfg.countTokens === 'estimate' || backend.flavor === 'openai') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: estimateTokens(body || {}) }));
    }
    // fall through to anthropic-flavor pass-through below
  }

  // ---- Local: Anthropic-flavored upstream (pass-through) ------------------
  if (backend.flavor === 'anthropic') {
    const h = copyHeaders(req);
    applyLocalAuth(h, backend);
    let outBuf = bodyBuf;
    if (body) { body.model = backend.model; outBuf = Buffer.from(JSON.stringify(body)); }
    const target = backend.baseUrl.replace(/\/+$/, '') + url;
    const ctx = isMessages ? { route: 'local', model, routeLabel, reqLine } : null;
    await forwardTransparent(target, req.method, h, outBuf, res, ctx);
    if (combineUsage) finishUsage(ctx);
    return;
  }

  // ---- Local: OpenAI-flavored upstream (translate) ------------------------
  const oaiBody = toOpenAI(body || {}, backend.model);
  const headers = { 'Content-Type': 'application/json' };
  if (backend.apiKey) headers['Authorization'] = `Bearer ${backend.apiKey}`;

  const up = await fetchWithTimeout(joinChatUrl(backend.baseUrl), { method: 'POST', headers, body: JSON.stringify(oaiBody) }, cfg.upstreamTimeoutMs);
  const ctx = { route: 'local', model, routeLabel, reqLine };
  if (!up.ok) {
    const t = await up.text();
    if (combineUsage) finishUsage(ctx);
    log('error', `local upstream ${up.status}: ${t.slice(0, 500)}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `local upstream ${up.status}: ${t.slice(0, 300)}` } }));
  }
  if (oaiBody.stream) {
    await streamOpenAIToAnthropic(up, res, model, routeLabel, ctx);
    if (combineUsage) finishUsage(ctx);
    return;
  }

  const oai = await up.json();
  const anthResp = fromOpenAINonStream(oai, model);
  recordUsage(ctx, anthResp.usage);
  if (combineUsage) finishUsage(ctx);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify(anthResp));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > cfg.maxBodyBytes) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `request body exceeds ${cfg.maxBodyBytes} byte limit` } }));
      }
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (res.headersSent) return; // already responded (e.g. 413)
    const bodyBuf = Buffer.concat(chunks);
    try {
      await handle(req, res, bodyBuf);
    } catch (e) {
      const isTimeout = e.code === 'ETIMEDOUT' || e.name === 'AbortError' || /timeout/i.test(e.message);
      log('error', `handler error: ${e.stack || e.message || e}`);
      if (!res.headersSent) {
        const status = isTimeout ? 504 : 502;
        const errType = isTimeout ? 'timeout' : 'proxy_error';
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: errType, message: String((e && e.message) || e) } }));
      } else {
        // Headers already sent (streaming); try to send an SSE error event.
        try {
          const errMsg = JSON.stringify({ type: 'error', error: { type: 'api_error', message: String((e && e.message) || e) } });
          res.write(`event: error\ndata: ${errMsg}\n\n`);
        } catch { /* client may have disconnected */ }
        res.end();
      }
    }
  });
  req.on('error', e => log('error', `request error: ${e.message}`));
});

server.listen(cfg.port, cfg.host, () => {
  log('info', `listening on http://${cfg.host}:${cfg.port}`);
  log(cfg.configLoaded ? 'info' : 'warn',
    cfg.configLoaded ? `config: ${cfg.configPath}` : `config: none found (using defaults; looked for ${cfg.configPath})`);
  if (Array.isArray(cfg.localBackends) && cfg.localBackends.length) {
    for (const b of cfg.localBackends) {
      log('info', `  tier '${b.tier}' -> ${b.flavor || cfg.localFlavor} @ ${b.baseUrl || cfg.localBaseUrl} (model ${b.model})`);
    }
  } else {
    log('info', `local tiers [${cfg.localTiers.join(', ')}] -> ${cfg.localFlavor} @ ${cfg.localBaseUrl} (model ${cfg.localModel})`);
  }
  log('info', `everything else -> ${cfg.anthropicBaseUrl} (auth: ${cfg.anthropicUpstreamKey ? 'configured key' : 'pass-through/OAuth fallback'})`);
});
