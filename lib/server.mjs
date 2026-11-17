// HTTP server: classify each request, route it, and dispatch to a backend
// handler. The handler does the flavour-specific work; this file stays free of
// per-flavour branching (open/closed).

import http from 'node:http';
import fs from 'node:fs';
import { loadConfig, resolveConfigPath } from './config.mjs';
import { readBody } from './http.mjs';
import { log, initLog, finishUsage } from './log.mjs';
import { initAuth } from './auth.mjs';
import { initUpstream } from './upstream.mjs';
import { pickUpstream, backendFor } from './router.mjs';
import { handlerFor, LOCAL_FLAVORS } from './backends/index.mjs';
import { applyWebToolPolicy } from './websearch.mjs';

// The running config. Replaced as a whole on reload: a request keeps the one it
// arrived under.
let cfg;

// Short label for a route, used in the request log line.
function labelFor(upstream) {
  if (upstream === 'anthropic') return 'anthropic';
  return `local(${upstream.flavor}:${upstream.model})`;
}

// Classify the incoming request into the fields the backends need.
function classify(req, bodyBuf) {
  const url = req.url || '';
  const isCount = url.includes('/v1/messages/count_tokens');
  const isMessages = url.startsWith('/v1/messages') && !isCount;
  let body = null;
  if ((isMessages || isCount) && bodyBuf.length) {
    try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { body = null; }
  }
  return {
    req,
    url,
    isCount,
    isMessages,
    body,
    model: (body && body.model) || '',
  };
}

function respondHealth(res, cfg) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    localTiers: cfg.localTiers,
    localBackends: cfg.localBackends.map(({ apiKey, ...shown }) => shown),
    localFlavor: cfg.localFlavor,
    localModel: cfg.localModel,
  }));
}

function respondError(res, status, type, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

// The request handler returned to http.createServer. Reads the body with a size
// limit, then either responds early (413 / health) or dispatches to a backend.
async function handle(cfg, req, res) {
  // Aborts when the client's connection closes, so a cancelled request also
  // cancels the upstream call instead of letting it generate for nobody. It
  // fires after a normal finish too, when there is nothing left to cancel.
  const clientGone = new AbortController();
  res.on('close', () => clientGone.abort());

  const { buf: bodyBuf, oversize } = await readBody(req, cfg.maxBodyBytes);
  if (oversize) {
    respondError(res, 413, 'invalid_request_error', `request body exceeds ${cfg.maxBodyBytes} byte limit`);
    req.destroy();
    return;
  }

  const c = classify(req, bodyBuf);

  if (req.method === 'GET' && (c.url === '/' || c.url === '/health')) {
    return respondHealth(res, cfg);
  }

  const upstream = (c.isMessages || c.isCount) ? pickUpstream(cfg, c.model) : 'anthropic';
  const routeLabel = labelFor(upstream);
  const reqLine = `${req.method} ${c.url} model=${c.model || '-'} -> ${routeLabel}`;
  // When usage logging is on for a /v1/messages call, defer the request line and
  // fold the token counts onto it (one line); otherwise log it now.
  const combineUsage = cfg.logUsage && c.isMessages;
  if ((c.isMessages || c.isCount) && !combineUsage) log('info', reqLine);

  const ctx = {
    req, res, cfg,
    url: c.url,
    isMessages: c.isMessages,
    isCount: c.isCount,
    body: c.body,
    bodyBuf,
    model: c.model,
    upstream,
    backend: upstream === 'anthropic' ? null : upstream,
    signal: clientGone.signal,
    usage: (c.isMessages || c.isCount) ? { route: upstream === 'anthropic' ? 'anthropic' : 'local', model: c.model, reqLine } : null,
  };

  try {
    // Anthropic's server-side web tools can't reach a local gateway, and in
    // 'always' mode we'd rather serve them ourselves even when Anthropic could:
    // the policy either strips them from ctx.body, takes the request over
    // entirely, or (most often) declines and leaves it to the backend.
    const handler = applyWebToolPolicy(cfg, ctx) || handlerFor(upstream);
    await handler.handle(ctx);
  } catch (e) {
    if (clientGone.signal.aborted) log('debug', `client disconnected: ${reqLine}`);
    else onError(res, e);
  } finally {
    if (combineUsage) finishUsage(ctx.usage);
  }
}

// An error that carries `status` is an upstream's own HTTP answer (see
// upstreamError) and keeps that status; anything else is the proxy failing to
// reach the upstream at all.
function onError(res, e) {
  const isTimeout = e.code === 'ETIMEDOUT' || /timeout/i.test(e.message);
  log('error', e.status ? e.message : `handler error: ${e.stack || e.message}`);
  if (!res.headersSent) {
    respondError(res, e.status || (isTimeout ? 504 : 502), isTimeout ? 'timeout' : 'proxy_error', e.message);
    return;
  }
  // Headers already sent (streaming): the status is gone, send an SSE error event.
  const errMsg = JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } });
  res.write(`event: error\ndata: ${errMsg}\n\n`);
  res.end();
}

// Build the banner describing the routing table.
function bannerLines(cfg) {
  const lines = [];
  lines.push(cfg.configLoaded ? `config: ${cfg.configPath}` : `config: none found (using defaults; looked for ${cfg.configPath})`);
  for (const tier of cfg.localTiers) {
    const b = backendFor(cfg, tier);
    lines.push(`tier '${tier}' -> ${b.flavor} @ ${b.baseUrl} (model ${b.model})`);
  }
  lines.push(`everything else -> ${cfg.anthropicBaseUrl} (auth: ${cfg.anthropicUpstreamKey ? 'configured key' : 'pass-through/OAuth fallback'})`);
  const w = cfg.webSearch;
  if (w.mode === 'off') {
    lines.push('web tools: stripped on the local route, native on the Anthropic route (webSearch.mode=off)');
  } else {
    const served = [w.searxUrl && `web_search -> ${w.searxUrl}`, w.crawl4aiUrl && `web_fetch -> ${w.crawl4aiUrl}`].filter(Boolean);
    const scope = w.mode === 'always' ? 'every route' : 'the local route only';
    lines.push(served.length
      ? `web tools served in-proxy on ${scope}: ${served.join(', ')}`
      : `web tools: mode=${w.mode} but no searxUrl/crawl4aiUrl configured, stubs will be stripped on the local route`);
    if (w.mode === 'always') lines.push('  Anthropic-routed requests with a web stub are buffered (no incremental streaming)');
  }
  return lines;
}

// Load the config and check what loadConfig cannot see: that every local tier
// names a flavor some backend implements. Such a tier has no sensible fallback,
// so the config is refused rather than sent somewhere nobody asked for.
function loadCheckedConfig(cfgPath) {
  const next = loadConfig(cfgPath);
  for (const tier of next.localTiers) {
    const { flavor } = backendFor(next, tier);
    if (!LOCAL_FLAVORS.includes(flavor)) {
      throw new Error(`tier '${tier}': unknown flavor "${flavor}", expected one of ${LOCAL_FLAVORS.join(' | ')}`);
    }
  }
  return next;
}

function useConfig(next) {
  cfg = next;
  initLog(cfg);
  initAuth(cfg);
  initUpstream(cfg);
  for (const line of bannerLines(cfg)) log(cfg.configLoaded ? 'info' : 'warn', line);
}

// The config file changed on disk: swap the new config in without a restart.
// A file that does not load (often a half-written save) is refused and the
// running config stays.
function onConfigFileChange(curr, prev) {
  // watchFile also reports a mere read of the file, and reports a deleted file
  // (some editors delete and recreate on save) with an mtime of 0.
  if (curr.mtimeMs === prev.mtimeMs || curr.mtimeMs === 0) return;
  let next;
  try {
    next = loadCheckedConfig(cfg.configPath);
  } catch (e) {
    log('error', `config reload refused, keeping the running config: ${e.message}`);
    return;
  }
  if (next.port !== cfg.port || next.host !== cfg.host) {
    log('warn', `still listening on ${cfg.host}:${cfg.port}; restart to apply a port/host change`);
    next.port = cfg.port;
    next.host = cfg.host;
  }
  log('info', 'config file changed, reloading');
  useConfig(next);
}

export function startServer() {
  let first;
  try {
    first = loadCheckedConfig(resolveConfigPath());
  } catch (e) {
    console.error(`[router] ${e.message}`);
    process.exit(1);
  }
  useConfig(first);

  const server = http.createServer((req, res) => {
    req.on('error', e => log('error', `request error: ${e.message}`));
    handle(cfg, req, res);
  });
  server.listen(cfg.port, cfg.host, () => log('info', `listening on http://${cfg.host}:${cfg.port}`));
  // Polling stat (not fs.watch) keeps working when an editor replaces the file.
  fs.watchFile(cfg.configPath, { interval: 1000 }, onConfigFileChange);
  return server;
}
