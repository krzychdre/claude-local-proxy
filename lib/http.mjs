// Low-level HTTP helpers: upstream fetch with timeout, header copy, body
// accumulation with size limit, URL building.

// fetch() with a time-to-headers timeout. Once headers arrive the timer is
// cleared, so long streaming generations are never interrupted.
export async function fetchWithTimeout(url, init, ms) {
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

// Hop-by-hop / framing headers that must not be forwarded to an upstream.
const STRIP_REQ_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);

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
