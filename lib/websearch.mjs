// Anthropic's server-side web tools, and who gets to run them.
//
// WebSearch and WebFetch are *server* tools: Claude Code puts only a typed stub
// in the request — { type: 'web_search_20250305', name: 'web_search' }, with no
// input schema — because on api.anthropic.com the search runs inside Anthropic's
// own infrastructure, which splices `server_tool_use` / `web_search_tool_result`
// blocks into the reply. The client never executes anything. A local gateway has
// none of that machinery, so the stub is at best ignored and at worst an error.
//
// Three policies, selected by `webSearch.mode`:
//
//   'off'     Drop the stubs before the request leaves the proxy, so a local
//             model is never offered a tool nobody can run. The Anthropic route
//             is left alone. Pick this when the searxNcrawl / crawl4ai MCP
//             servers are connected: those are *client*-side tools, so they
//             already work on every route and keep streaming intact.
//
//   'local'   (default) Swap each stub for a real function tool and execute it
//             here — web_search against SearXNG, web_fetch against crawl4ai —
//             but only for models that actually run locally. Requests routed to
//             api.anthropic.com keep their native stubs, because Anthropic's own
//             search is already wired in there and is better at it.
//
//   'always'  The same substitution on every route, the Anthropic one included:
//             every web tool call is served by your own SearXNG and crawl4ai, so
//             no query or page URL ever leaves the network. Anthropic still sees
//             the conversation, just not a search request.
//
// In both active modes the call is resolved inside the proxy, in a loop, so the
// client only ever sees the finished answer and never a tool_use it cannot run.
// The cost is that the affected request cannot be streamed incrementally: the
// proxy must see the whole reply before it knows whether a search is needed, so
// the answer is buffered and replayed as SSE at the end.

import { fetchWithTimeout, buildUrl } from './http.mjs';
import { writeAnthropicMessageSse } from './sse.mjs';
import { callOnce } from './oneShot.mjs';
import { log, recordUsage } from './log.mjs';
import { WEB_SEARCH_MODES, DEFAULTS } from './config.mjs';

// The stub `type` is versioned by date (web_search_20250305), so match on prefix.
const STUB_KINDS = [[/^web_search(_|$)/, 'search'], [/^web_fetch(_|$)/, 'fetch']];

function stubKind(t) {
  const type = t && typeof t.type === 'string' ? t.type : '';
  const hit = STUB_KINDS.find(([re]) => re.test(type));
  return hit ? hit[1] : null;
}

// Replacements advertised to the local model. Unlike the stubs these carry a
// real schema, because the model is expected to actually fill it in.
//
// The description is built per request: pointing the model at web_fetch when
// web_fetch is not on offer is an invitation to call a tool that does not exist,
// and a model will take it. Only mention the follow-up when we can serve it.
const SEARCH_TOOL_NAME = 'web_search';

function searchTool(withFetch) {
  return {
    name: SEARCH_TOOL_NAME,
    description: 'Search the public web. Returns a ranked list of results, each with '
      + 'a title, a URL and a short snippet. Use it for facts that may have changed '
      + 'since training. '
      + (withFetch
        ? 'Follow up with web_fetch to read a promising page in full.'
        : 'The snippets are all you get: there is no page-fetching tool in this '
          + 'request, so answer from them and cite the URLs.'),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query, phrased in the language of the expected results.' },
      },
      required: ['query'],
    },
  };
}

const FETCH_TOOL = {
  name: 'web_fetch',
  description: 'Fetch a single web page and return its main content as Markdown, '
    + 'with navigation and boilerplate stripped.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL of the page to read.' },
    },
    required: ['url'],
  },
};

// An unrecognised mode falls back to the default rather than to 'off': a typo
// should not silently take web search away. loadConfig warns about it once at
// startup, which is where a human will see it.
const normalizeMode = m => (WEB_SEARCH_MODES.includes(m) ? m : DEFAULTS.webSearch.mode);

// Read the webSearch block defensively: a config file may supply only some keys,
// and the tests construct a config without one at all.
export function webConfig(cfg) {
  const w = (cfg && cfg.webSearch) || {};
  return {
    mode: normalizeMode(w.mode),
    searxUrl: w.searxUrl || '',
    crawl4aiUrl: w.crawl4aiUrl || '',
    crawl4aiToken: w.crawl4aiToken || '',
    maxResults: w.maxResults ?? 5,
    snippetChars: w.snippetChars ?? 400,
    fetchChars: w.fetchChars ?? 20_000,
    maxRounds: w.maxRounds ?? 3,
    timeoutMs: w.timeoutMs ?? 30_000,
  };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function runSearch(w, input) {
  const query = String((input && input.query) || '').trim();
  if (!query) return 'web_search error: the query was empty.';

  const url = new URL(buildUrl(w.searxUrl, '/search'));
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const up = await fetchWithTimeout(url.toString(), { headers: { Accept: 'application/json' } }, w.timeoutMs);
  if (!up.ok) return `web_search error: SearXNG returned HTTP ${up.status}.`;

  let data;
  try {
    data = await up.json();
  } catch {
    // SearXNG ships with the JSON API switched off; this is the usual cause.
    return 'web_search error: SearXNG did not return JSON. Add "json" to search.formats in its settings.yml.';
  }

  const results = (data.results || []).slice(0, w.maxResults);
  log('info', `web_search "${query.slice(0, 80)}" -> ${results.length} result(s)`);
  if (!results.length) return `No results for "${query}".`;

  return results.map((r, i) => {
    const snippet = String(r.content || '').replace(/\s+/g, ' ').slice(0, w.snippetChars);
    return `${i + 1}. ${r.title || '(no title)'}\n   ${r.url || ''}\n   ${snippet}`;
  }).join('\n\n');
}

async function runFetch(w, input) {
  const target = String((input && input.url) || '').trim();
  if (!/^https?:\/\//i.test(target)) return 'web_fetch error: need an absolute http(s) URL.';

  const headers = { 'Content-Type': 'application/json' };
  if (w.crawl4aiToken) headers['Authorization'] = `Bearer ${w.crawl4aiToken}`;

  const up = await fetchWithTimeout(
    buildUrl(w.crawl4aiUrl, '/md'),
    { method: 'POST', headers, body: JSON.stringify({ url: target, f: 'fit' }) },
    w.timeoutMs,
  );
  if (!up.ok) return `web_fetch error: crawl4ai returned HTTP ${up.status}.`;

  const data = await up.json().catch(() => null);
  const md = data && (data.markdown || data.result || '');
  log('info', `web_fetch ${target} -> ${String(md).length} char(s)`);
  if (!md) return `web_fetch error: crawl4ai returned no content for ${target}.`;
  return String(md).slice(0, w.fetchChars);
}

// A failing web tool must come back as a tool_result the model can read and work
// around, never as a 502 that kills the whole turn.
async function execute(w, enabled, call) {
  // Dispatch on what is actually enabled, not on the name alone: a model that
  // invents a call named 'web_fetch' while fetch is unserved must get the
  // "no such tool" answer, not a run against an unconfigured endpoint.
  try {
    if (!enabled.has(call.name)) {
      return `${call.name} error: there is no tool by that name in this request. `
        + 'Do not call it again; answer with the information you already have.';
    }
    if (call.name === SEARCH_TOOL_NAME) return await runSearch(w, call.input);
    if (call.name === FETCH_TOOL.name) return await runFetch(w, call.input);
    return `${call.name} error: no such web tool.`;
  } catch (e) {
    log('warn', `web tool ${call.name} failed: ${e.message}`);
    return `${call.name} error: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

// Inspect an incoming /v1/messages request and apply the configured policy.
// Rewrites ctx.body.tools in place, and returns either null (carry on with the
// normal backend) or a handler that resolves the web tools inside the proxy.
export function applyWebToolPolicy(cfg, ctx) {
  if (!ctx.isMessages) return null;
  const body = ctx.body;
  if (!body || !Array.isArray(body.tools) || !body.tools.length) return null;
  if (!body.tools.some(stubKind)) return null;

  const w = webConfig(cfg);
  const toAnthropic = ctx.upstream === 'anthropic';
  // Only 'always' reaches across to the Anthropic route; 'off' and 'local' both
  // leave it exactly as Claude Code sent it, so the native server tools run.
  if (toAnthropic && w.mode !== 'always') return null;

  // An endpoint we don't have configured downgrades that tool to 'off' — better
  // a missing tool than one that fails on every call.
  const serves = {
    search: w.mode !== 'off' && !!w.searxUrl,
    fetch: w.mode !== 'off' && !!w.crawl4aiUrl,
  };
  // Which kinds we will actually end up serving has to be known before the
  // tools are built, because the search tool's description depends on whether
  // web_fetch will be there too.
  const willServe = { search: false, fetch: false };
  for (const t of body.tools) {
    const kind = stubKind(t);
    if (kind && serves[kind]) willServe[kind] = true;
  }
  const replacement = { search: searchTool(willServe.fetch), fetch: FETCH_TOOL };

  const tools = [];
  const enabled = new Set();
  let dropped = 0;
  for (const t of body.tools) {
    const kind = stubKind(t);
    if (!kind) { tools.push(t); continue; }
    if (serves[kind]) {
      tools.push(replacement[kind]);
      enabled.add(replacement[kind].name);
    } else if (toAnthropic) {
      // Nothing local to put in its place, but Anthropic can still run the stub
      // itself — keeping it beats taking the tool away.
      tools.push(t);
    } else {
      dropped++;
    }
  }

  // Nothing to substitute on the Anthropic route: hand the request back
  // untouched rather than buffering a stream for no reason.
  if (toAnthropic && !enabled.size) return null;

  if (tools.length) {
    body.tools = tools;
  } else {
    // Leaving tool_choice behind with no tools makes some OpenAI servers 400.
    delete body.tools;
    delete body.tool_choice;
  }
  if (dropped) log('debug', `web tools: dropped ${dropped} server-tool stub(s) the local backend cannot run`);

  if (!enabled.size) return null;
  log('debug', `web tools: resolving ${[...enabled].join(', ')} in-proxy on the ${toAnthropic ? 'anthropic' : 'local'} route`);
  return { handle: c => resolveInProxy(c, w, enabled) };
}

// Every round is a separate billed call, so the counts are summed. The cache
// fields only appear once an upstream has reported them (Anthropic does, local
// gateways generally don't), which keeps the local-route totals as they were.
const CACHE_KEYS = ['cache_read_input_tokens', 'cache_creation_input_tokens'];

function addUsage(total, u) {
  if (!u) return total;
  total.input_tokens += u.input_tokens || 0;
  total.output_tokens += u.output_tokens || 0;
  for (const k of CACHE_KEYS) {
    if (u[k] != null) total[k] = (total[k] || 0) + u[k];
  }
  return total;
}

// Ask the model, run any web tool it calls, feed the results back, repeat.
// The client sees only the final message.
async function resolveInProxy(ctx, w, enabled) {
  const wantStream = !!ctx.body.stream;
  const base = { ...ctx.body, stream: false };
  const total = { input_tokens: 0, output_tokens: 0 };
  // Every tool the model was actually offered. A call to anything outside this
  // set is invented, and the client has no such tool either — so it is ours to
  // answer, not the client's to choke on.
  const advertised = new Set((base.tools || []).map(t => t && t.name).filter(Boolean));
  let messages = Array.isArray(base.messages) ? base.messages.slice() : [];
  let final = null;

  for (let round = 0; ; round++) {
    const resp = await callOnce(ctx, { ...base, messages });
    addUsage(total, resp.usage);

    const blocks = Array.isArray(resp.content) ? resp.content : [];
    const calls = blocks.filter(b => b.type === 'tool_use');
    const ours = calls.filter(b => enabled.has(b.name) || !advertised.has(b.name));
    const client = calls.filter(b => !enabled.has(b.name) && advertised.has(b.name));

    const invented = ours.filter(b => !enabled.has(b.name));
    if (invented.length) {
      log('warn', `web tools: model called ${invented.map(b => b.name).join(', ')} — not offered in this request; answering with an error instead of passing it to the client`);
    }

    if (!ours.length) { final = resp; break; }

    // A reply that mixes a web tool with a client tool cannot be resolved here:
    // the client half has to run on Claude Code's side, and we cannot hand back
    // a half-finished turn. Drop our calls and let the client proceed; the model
    // can search again on the next turn.
    if (client.length) {
      log('warn', `web tools: reply mixed ${ours.length} in-proxy call(s) with ${client.length} client tool call(s); dropped the in-proxy call(s)`);
      final = { ...resp, content: blocks.filter(b => !ours.includes(b)) };
      break;
    }

    if (round >= w.maxRounds) {
      log('warn', `web tools: round budget (${w.maxRounds}) exhausted; asking once more with the web tools withdrawn`);
      const closing = { ...base, messages };
      const rest = (base.tools || []).filter(t => !enabled.has(t.name));
      if (rest.length) closing.tools = rest;
      else { delete closing.tools; delete closing.tool_choice; }
      final = await callOnce(ctx, closing);
      addUsage(total, final.usage);
      break;
    }

    const results = await Promise.all(ours.map(async c => ({
      type: 'tool_result',
      tool_use_id: c.id,
      content: await execute(w, enabled, c),
    })));
    messages = messages.concat(
      { role: 'assistant', content: blocks },
      { role: 'user', content: results },
    );
  }

  // The upstream already reports the client's model name on every path; keep it
  // (Anthropic resolves aliases to a dated id, which the client wants to see).
  final.model = final.model || ctx.model;
  final.usage = total;
  recordUsage(ctx.usage, total);

  if (wantStream) return writeAnthropicMessageSse(ctx.res, final);
  ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(final));
}
