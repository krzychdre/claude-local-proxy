// Upstream auth: relay or inject credentials for the Anthropic and local paths.

import fs from 'node:fs';
import { hasAuth, stripAuth } from './http.mjs';
import { log } from './log.mjs';

let cfg = {};
let cachedOauth = null;

export function initAuth(c) { cfg = c; }

// Read Claude Code's stored OAuth token, with a 60s freshness cache. Best-effort:
// logs a warning and returns null if the file is missing/unreadable.
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

// Decide auth for the Anthropic upstream. Either force a configured key, or
// relay the incoming headers, falling back to the OAuth token only when the
// request carried no auth at all.
export function applyAnthropicAuth(headers) {
  if (cfg.anthropicUpstreamKey) {
    stripAuth(headers);
    headers['x-api-key'] = cfg.anthropicUpstreamKey;
    return;
  }
  if (cfg.anthropicCredsFallback && !hasAuth(headers)) {
    const oauth = readOauthToken();
    if (oauth && oauth.accessToken) {
      headers['authorization'] = `Bearer ${oauth.accessToken}`;
      const beta = headers['anthropic-beta'] ? `${headers['anthropic-beta']},oauth-2025-04-20` : 'oauth-2025-04-20';
      headers['anthropic-beta'] = beta;
      log('debug', 'attached OAuth fallback token to Anthropic upstream');
    }
  }
}

// Strip any incoming Anthropic auth and inject the local backend's key (sent as
// both x-api-key and Bearer; Ollama ignores it, vLLM/LM Studio may need it).
export function applyLocalAuth(headers, backend) {
  stripAuth(headers);
  if (backend.apiKey) {
    headers['x-api-key'] = backend.apiKey;
    headers['authorization'] = `Bearer ${backend.apiKey}`;
  }
}
