// Low-level HTTP helpers: upstream fetch with timeout, header copy, body
// accumulation with size limit, URL building.

// fetch() with a time-to-headers timeout. Once headers arrive the timer is
// cleared, so long streaming generations are never interrupted. `init.signal`
// is the client-disconnect signal: it stays attached to the response body, so a
// client that goes away cancels the upstream request even mid-stream.
export async function fetchWithTimeout(url, init, ms) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any([init.signal, timeout.signal]) });
  } catch (e) {
    if (!timeout.signal.aborted) throw e;
    const err = new Error(`upstream timeout after ${ms}ms: ${url}`);
    err.code = 'ETIMEDOUT';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// A non-2xx upstream answer as an Error that carries the upstream's status, so
// the client sees the real error class (a 400 is final, a 429 is retryable).
export async function upstreamError(up, label) {
  const t = await up.text().catch(() => '');
  const err = new Error(`${label} upstream ${up.status}: ${t.slice(0, 300)}`);
  err.status = up.status;
  return err;
}

// Hop-by-hop / framing headers that must not be forwarded to an upstream:
// fetch frames the outgoing request itself and rejects several of these.
const STRIP_REQ_HEADERS = new Set([
  'host', 'content-length', 'connection', 'accept-encoding',
  'transfer-encoding', 'keep-alive', 'upgrade', 'expect',
]);

export function copyHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQ_HEADERS.has(k.toLowerCase())) h[k] = v;
  }
  return h;
}

export function hasAuth(headers) {
  return Object.keys(headers).some(k => {
    const lk = k.toLowerCase();
    return lk === 'authorization' || lk === 'x-api-key';
  });
}

// Remove any auth header, case-insensitively.
export function stripAuth(headers) {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-api-key') delete headers[k];
  }
}

// Build "<base><path>" with a single slash between them (trailing slashes on
// base are stripped).
export function buildUrl(base, urlPath = '') {
  return (base || '').replace(/\/+$/, '') + urlPath;
}

// Append "/chat/completions" to a local base, inserting "/v1" if the base
// doesn't already end in a versioned path (e.g. ".../v1").
export function joinChatUrl(base) {
  const b = (base || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

// Read the full request body, enforcing a byte limit. Resolves with
// { buf, oversize } where `oversize` is true once the limit is crossed (the
// caller responds 413 and destroys the request). Always collects so the socket
// drains.
export function readBody(req, maxBytes) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    let oversize = false;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { oversize = true; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve({ buf: Buffer.concat(chunks), oversize }));
    req.on('error', () => resolve({ buf: Buffer.concat(chunks), oversize }));
  });
}
