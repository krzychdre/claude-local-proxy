// HTTP server: classify each request, route it, and dispatch to a backend
// handler. The handler does the flavour-specific work; this file stays free of
// per-flavour branching (open/closed).

import http from 'node:http';
import { readBody } from './http.mjs';
import { log, initLog, finishUsage } from './log.mjs';
import { initAuth } from './auth.mjs';
import { initUpstream } from './upstream.mjs';
import { pickUpstream } from './router.mjs';
import { handlerFor } from './backends/index.mjs';
import { applyWebToolPolicy, webConfig } from './websearch.mjs';

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
    localBackends: cfg.localBackends,
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
  const { buf: bodyBuf, oversize } = await readBody(req, cfg.maxBodyBytes);
  if (oversize) {
    if (!res.headersSent) respondError(res, 413, 'invalid_request_error', `request body exceeds ${cfg.maxBodyBytes} byte limit`);
    req.destroy();
    return;
  }
  if (res.headersSent) return;

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
    routeLabel,
    usage: (c.isMessages || c.isCount) ? { route: upstream === 'anthropic' ? 'anthropic' : 'local', model: c.model, routeLabel, reqLine } : null,
  };

  try {
    // Anthropic's server-side web tools can't reach a local gateway, and in
    // 'always' mode we'd rather serve them ourselves even when Anthropic could:
    // the policy either strips them from ctx.body, takes the request over
    // entirely, or (most often) declines and leaves it to the backend.
    const handler = applyWebToolPolicy(cfg, ctx) || handlerFor(upstream);
    await handler.handle(ctx);
    if (combineUsage) finishUsage(ctx.usage);
  } catch (e) {
    onError(res, e);
  }
}

function onError(res, e) {
  const isTimeout = e.code === 'ETIMEDOUT' || e.name === 'AbortError' || /timeout/i.test(e.message);
  log('error', `handler error: ${e.stack || e.message || e}`);
  if (!res.headersSent) {
    respondError(res, isTimeout ? 504 : 502, isTimeout ? 'timeout' : 'proxy_error', String((e && e.message) || e));
    return;
  }
  // Headers already sent (streaming); try to send an SSE error event.
  try {
    const errMsg = JSON.stringify({ type: 'error', error: { type: 'api_error', message: String((e && e.message) || e) } });
    res.write(`event: error\ndata: ${errMsg}\n\n`);
  } catch { /* client may have disconnected */ }
  res.end();
}

// Build the banner describing the routing table.
function bannerLines(cfg) {
  const lines = [];
  lines.push(cfg.configLoaded ? `config: ${cfg.configPath}` : `config: none found (using defaults; looked for ${cfg.configPath})`);
  if (Array.isArray(cfg.localBackends) && cfg.localBackends.length) {
    for (const b of cfg.localBackends) {
      lines.push(`  tier '${b.tier}' -> ${b.flavor || cfg.localFlavor} @ ${b.baseUrl || cfg.localBaseUrl} (model ${b.model})`);
    }
  } else {
    lines.push(`local tiers [${cfg.localTiers.join(', ')}] -> ${cfg.localFlavor} @ ${cfg.localBaseUrl} (model ${cfg.localModel})`);
  }
  lines.push(`everything else -> ${cfg.anthropicBaseUrl} (auth: ${cfg.anthropicUpstreamKey ? 'configured key' : 'pass-through/OAuth fallback'})`);
  const w = webConfig(cfg);
  if (w.mode === 'off') {
    lines.push('web tools: stripped on the local route, native on the Anthropic route (webSearch.mode=off)');
  } else {
    const served = [w.searxUrl && `web_search -> ${w.searxUrl}`, w.crawl4aiUrl && `web_fetch -> ${w.crawl4aiUrl}`].filter(Boolean);
    const scope = w.mode === 'always' ? 'every route' : 'the local route only';
    lines.push(served.length
      ? `web tools served in-proxy on ${scope}: ${served.join(', ')}`
      : `web tools: mode=${w.mode} but no searxUrl/crawl4aiUrl configured — stubs will be stripped on the local route`);
    if (w.mode === 'always') lines.push('  Anthropic-routed requests with a web stub are buffered (no incremental streaming)');
  }
  return lines;
}

export function startServer(cfg) {
  initLog(cfg);
  initAuth(cfg);
  initUpstream(cfg);

  const server = http.createServer((req, res) => {
    req.on('error', e => log('error', `request error: ${e.message}`));
    handle(cfg, req, res);
  });
  server.listen(cfg.port, cfg.host, () => {
    log('info', `listening on http://${cfg.host}:${cfg.port}`);
    for (const line of bannerLines(cfg)) log(cfg.configLoaded ? 'info' : 'warn', line);
  });
  return server;
}
