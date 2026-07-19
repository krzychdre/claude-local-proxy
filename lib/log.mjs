// Structured logging + token-usage recording.
//
// `initLog(cfg)` is called once at startup; after that `log`, `recordUsage`,
// and `finishUsage` use the cached config (level threshold, usage logging).

import fs from 'node:fs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let cfg = { logLevel: 'info', logUsage: false, usageLogFile: '' };

export function initLog(c) { cfg = c; }

// Local wall-clock HH:MM:SS.mmm (toISOString would print UTC).
function localTime(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function log(level, msg) {
  if ((LEVELS[level] || 20) < (LEVELS[cfg.logLevel] || 20)) return;
  const line = `[router ${localTime()}] ${level.toUpperCase()} ${msg}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

// Build the `k=v` summary of a usage object, normalising Anthropic field names.
function usageSummary(u) {
  const fields = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
  if (u.cache_read_input_tokens != null) fields.cache_read = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) fields.cache_create = u.cache_creation_input_tokens;
  return Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
}

// Emit token usage already present in an upstream response. No-op unless logUsage
// is on. ctx is { model, routeLabel, route, reqLine }. When reqLine is set
// (deferred from request time) the tokens are folded onto that same line so the
// query and its token counts sit side by side; ctx.logged records that we did.
export function recordUsage(ctx, u) {
  if (!cfg.logUsage || !u) return;
  const head = ctx && ctx.reqLine ? ctx.reqLine : `usage route=${ctx?.route || '-'} model=${ctx?.model || '-'}`;
  if (ctx) ctx.logged = true;
  log('info', `${head} ${usageSummary(u)}`);
  if (cfg.usageLogFile) {
    const fields = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
    if (u.cache_read_input_tokens != null) fields.cache_read = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens != null) fields.cache_create = u.cache_creation_input_tokens;
    const rec = { ts: new Date().toISOString(), route: ctx.route, model: ctx.model || '', ...fields };
    fs.appendFile(cfg.usageLogFile, JSON.stringify(rec) + '\n', err => {
      if (err) log('warn', `usage log write failed: ${err.message}`);
    });
  }
}

// When the request line was deferred to fold tokens in, but no usage was
// recorded (upstream error, non-2xx, empty body), still emit the bare line.
export function finishUsage(ctx) {
  if (ctx && ctx.reqLine && !ctx.logged) log('info', ctx.reqLine);
}
