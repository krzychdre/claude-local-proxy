// Server-side web tools: 'off' strips the stubs on the local route, 'local'
// resolves them in-proxy for local models only, 'always' does so on the
// Anthropic route too.
import { mockServer, startRouter, sseEvents, ok, finish } from './helpers.mjs';

const WEB_SEARCH_STUB = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
const WEB_FETCH_STUB = { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 };
const CLIENT_TOOL = { name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } };

// A model name that no localTier matches, so it takes the Anthropic route.
const REMOTE_MODEL = 'claude-opus-4-6';

// --- mock local LLM (OpenAI flavor) ---
// First round: asks for a web_search. Second round (a `role: tool` message is
// present): answers in text. Every request body is recorded for assertions.
// The prompt selects the scenario: HALUCYNACJA makes it call a tool that was
// never offered, POBIERZ makes it call web_fetch, otherwise it searches when
// search is on offer.
const seen = [];
const openai = await mockServer((req, res, body) => {
  seen.push(body);
  const answered = (body.messages || []).some(m => m.role === 'tool');
  const asked = JSON.stringify(body.messages || []);
  const offersSearch = (body.tools || []).some(t => t.function?.name === 'web_search');
  const call = (name, args) => JSON.stringify({
    id: 'oai_1',
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (!answered) {
    if (asked.includes('HALUCYNACJA')) return res.end(call('web_fetch', '{"url":"https://pypi.org/project/x/"}'));
    if (asked.includes('POBIERZ')) return res.end(call('web_fetch', '{"url":"https://example.com"}'));
    if (offersSearch) return res.end(call('web_search', '{"query":"crawl4ai docs"}'));
  }
  res.end(JSON.stringify({
    id: 'oai_2',
    choices: [{ message: { role: 'assistant', content: 'Odpowiedź po wyszukaniu.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 9 },
  }));
});

// --- mock SearXNG ---
let lastQuery = null;
const searx = await mockServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  lastQuery = { q: u.searchParams.get('q'), format: u.searchParams.get('format'), path: u.pathname };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ results: [
    { title: 'Crawl4AI docs', url: 'https://docs.crawl4ai.com', content: 'Async web crawler' },
    { title: 'Repo', url: 'https://github.com/unclecode/crawl4ai', content: 'source' },
  ] }));
});

// --- mock api.anthropic.com (Anthropic flavor) ---
// Mirrors the local mock: asks for a search when it is offered a *real*
// web_search function tool (the bare stub has no input_schema), answers in text
// once the tool_result is back. The first reply carries a thinking block, so the
// buffered SSE replay can be checked for it.
const anthSeen = [];
const anthropic = await mockServer((req, res, body) => {
  anthSeen.push({ url: req.url, body });
  const answered = (body.messages || []).some(m => Array.isArray(m.content)
    && m.content.some(c => c.type === 'tool_result'));
  const offersSearch = (body.tools || []).some(t => t.name === 'web_search' && t.input_schema);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (offersSearch && !answered) {
    return res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
      content: [
        { type: 'thinking', thinking: 'Muszę poszukać.', signature: 'sig-abc' },
        { type: 'tool_use', id: 'tu_1', name: 'web_search', input: { query: 'crawl4ai docs' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 100 },
    }));
  }
  res.end(JSON.stringify({
    id: 'msg_2', type: 'message', role: 'assistant', model: body.model,
    content: [
      { type: 'thinking', thinking: 'Mam wyniki.', signature: 'sig-final' },
      { type: 'text', text: 'Odpowiedź z Anthropic.' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 40, output_tokens: 6, cache_read_input_tokens: 100 },
  }));
});

// --- mock crawl4ai ---
let lastFetch = null;
const crawl = await mockServer((req, res, body) => {
  lastFetch = { path: req.url, body, auth: req.headers.authorization };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ markdown: '# Example Domain\n\nTreść pobranej strony.' }));
});

const baseEnv = {
  LOCAL_BASE_URL: openai,
  LOCAL_FLAVOR: 'openai',
  LOCAL_MODEL: 'my-local-model',
  LOCAL_TIERS: 'sonnet',
  ROUTER_LOG_LEVEL: 'error',
  ANTHROPIC_UPSTREAM_URL: anthropic,
  // Force a key so the OAuth fallback never touches the real credentials file.
  ANTHROPIC_UPSTREAM_KEY: 'test-key',
};
const off = await startRouter({ ...baseEnv, WEB_SEARCH_MODE: 'off' });
const local = await startRouter({ ...baseEnv, WEB_SEARCH_MODE: 'local', SEARXNG_URL: searx });
const always = await startRouter({ ...baseEnv, WEB_SEARCH_MODE: 'always', SEARXNG_URL: searx });
// Both endpoints configured, so web_fetch is served too.
const both = await startRouter({
  ...baseEnv,
  WEB_SEARCH_MODE: 'local',
  SEARXNG_URL: searx,
  CRAWL4AI_URL: crawl,
  CRAWL4AI_API_TOKEN: 'tok-123',
});
// An Anthropic-flavor local gateway (the Anthropic mock speaks that protocol)
// whose model has its own name for the 'medium' effort level.
const localAnth = await startRouter(
  { ...baseEnv, LOCAL_BASE_URL: anthropic, LOCAL_FLAVOR: 'anthropic', WEB_SEARCH_MODE: 'local', SEARXNG_URL: searx },
  { localEffortMap: { medium: 'high' } },
);
// No endpoint configured in either active mode.
const localBare = await startRouter({ ...baseEnv, WEB_SEARCH_MODE: 'local' });
const alwaysBare = await startRouter({ ...baseEnv, WEB_SEARCH_MODE: 'always' });

const post = (router, body) => fetch(`${router.base}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// 1) mode=off — the stub never reaches the local backend, client tools survive
{
  seen.length = 0;
  const r = await post(off, {
    model: 'claude-sonnet-4-6', max_tokens: 50,
    tools: [WEB_SEARCH_STUB, CLIENT_TOOL],
    messages: [{ role: 'user', content: 'szukaj' }],
  });
  const j = await r.json();
  const names = (seen[0]?.tools || []).map(t => t.function.name);
  ok('off: web_search stub stripped', !names.includes('web_search'));
  ok('off: client tool kept', names.includes('get_weather'));
  ok('off: request still answered', j.content?.[0]?.text === 'Odpowiedź po wyszukaniu.');
}

// 2) mode=off with nothing but the stub — tools and tool_choice both go away
{
  seen.length = 0;
  await post(off, {
    model: 'claude-sonnet-4-6', max_tokens: 50,
    tools: [WEB_SEARCH_STUB], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: 'szukaj' }],
  });
  ok('off: empty tool list removed entirely', seen[0]?.tools === undefined);
  ok('off: dangling tool_choice removed', seen[0]?.tool_choice === undefined);
}

// 3) mode=off leaves a request without web stubs completely alone
{
  seen.length = 0;
  await post(off, {
    model: 'claude-sonnet-4-6', max_tokens: 50,
    tools: [CLIENT_TOOL], messages: [{ role: 'user', content: 'pogoda' }],
  });
  ok('off: untouched when no stub present', (seen[0]?.tools || []).length === 1);
}

// 4) mode=local — proxy runs the search, loops, and streams back only the answer
{
  seen.length = 0; lastQuery = null;
  const r = await post(local, {
    model: 'claude-sonnet-4-6', max_tokens: 50, stream: true,
    tools: [WEB_SEARCH_STUB],
    messages: [{ role: 'user', content: 'znajdź dokumentację crawl4ai' }],
  });
  const txt = await r.text();

  ok('local: stub replaced by a real schema', seen[0]?.tools?.[0]?.function?.name === 'web_search'
    && !!seen[0].tools[0].function.parameters?.properties?.query);
  ok('local: SearXNG queried with the model’s query', lastQuery?.q === 'crawl4ai docs' && lastQuery?.format === 'json');
  ok('local: SearXNG hit on /search', lastQuery?.path === '/search');
  ok('local: two rounds against the model', seen.length === 2);
  ok('local: results fed back as a tool message', (seen[1]?.messages || []).some(m => m.role === 'tool' && /docs\.crawl4ai\.com/.test(m.content)));

  ok('local: buffered reply replayed as SSE', /event: message_start/.test(txt) && /event: message_stop/.test(txt));
  ok('local: final answer delivered', /"text":"Odpowiedź po wyszukaniu\."/.test(txt));
  ok('local: client never sees the web_search call', !/"name":"web_search"/.test(txt));
  ok('local: usage summed across rounds', /"output_tokens":14/.test(txt));
}

// 5) mode=local without a SearXNG URL degrades to stripping, not to failing
{
  seen.length = 0;
  const r = await post(localBare, {
    model: 'claude-sonnet-4-6', max_tokens: 50,
    tools: [WEB_SEARCH_STUB, CLIENT_TOOL], messages: [{ role: 'user', content: 'szukaj' }],
  });
  const j = await r.json();
  const names = (seen[0]?.tools || []).map(t => t.function.name);
  ok('local without endpoint: falls back to stripping', !names.includes('web_search') && names.includes('get_weather'));
  ok('local without endpoint: still answers', j.content?.[0]?.text === 'Odpowiedź po wyszukaniu.');
}

// 6) mode=local leaves the Anthropic route alone — its own web tools still run
{
  anthSeen.length = 0;
  const r = await post(local, {
    model: REMOTE_MODEL, max_tokens: 50,
    tools: [WEB_SEARCH_STUB, CLIENT_TOOL],
    messages: [{ role: 'user', content: 'szukaj' }],
  });
  const j = await r.json();
  const tools = anthSeen[0]?.body?.tools || [];
  ok('local: Anthropic route keeps the native stub', tools[0]?.type === 'web_search_20250305');
  ok('local: Anthropic route not intercepted', anthSeen.length === 1);
  ok('local: Anthropic answer relayed',
    j.content?.some(c => c.type === 'text' && c.text === 'Odpowiedź z Anthropic.'));
}

// 7) mode=always — the proxy serves the web tools on the Anthropic route too
{
  anthSeen.length = 0; lastQuery = null;
  const r = await post(always, {
    model: REMOTE_MODEL, max_tokens: 50, stream: true,
    tools: [WEB_SEARCH_STUB, WEB_FETCH_STUB, CLIENT_TOOL],
    messages: [{ role: 'user', content: 'znajdź dokumentację crawl4ai' }],
  });
  const txt = await r.text();
  const tools = anthSeen[0]?.body?.tools || [];
  const search = tools.find(t => t.name === 'web_search');

  ok('always: Anthropic route gets the local web_search instead of the stub',
    !!search?.input_schema?.properties?.query && search.type === undefined);
  ok('always: unserved web_fetch stub left for Anthropic to run',
    tools.some(t => t.type === 'web_fetch_20250910'));
  ok('always: client tool untouched', tools.some(t => t.name === 'get_weather'));
  ok('always: SearXNG served the Anthropic model’s query', lastQuery?.q === 'crawl4ai docs');
  ok('always: two rounds against Anthropic', anthSeen.length === 2);
  ok('always: results fed back as a tool_result',
    (anthSeen[1]?.body?.messages || []).some(m => m.role === 'user'
      && m.content?.some?.(c => c.type === 'tool_result' && /docs\.crawl4ai\.com/.test(c.content))));
  ok('always: thinking block replayed to the upstream with its signature',
    (anthSeen[1]?.body?.messages || []).some(m => m.role === 'assistant'
      && m.content?.some?.(c => c.type === 'thinking' && c.signature === 'sig-abc')));
  ok('always: never streamed to the upstream', anthSeen.every(s => s.body.stream === false));

  ok('always: final answer delivered as SSE', /"text":"Odpowiedź z Anthropic\."/.test(txt));
  ok('always: client never sees the web_search call', !/"name":"web_search"/.test(txt));
  ok('always: the final answer’s thinking survives the SSE replay',
    /"type":"thinking_delta"/.test(txt) && /"signature":"sig-final"/.test(txt));
  ok('always: the intermediate search round is not replayed to the client',
    !/sig-abc/.test(txt));
  const events = sseEvents(txt);
  const startUsage = events.find(e => e.type === 'message_start').message.usage;
  ok('always: usage summed across rounds',
    startUsage.input_tokens === 51 && events.find(e => e.type === 'message_delta').usage.output_tokens === 13);
  ok('always: cache tokens survive the SSE replay', startUsage.cache_read_input_tokens === 200);
}

// 8) mode=always with no endpoint configured leaves the Anthropic route untouched
{
  anthSeen.length = 0;
  await post(alwaysBare, {
    model: REMOTE_MODEL, max_tokens: 50,
    tools: [WEB_SEARCH_STUB], messages: [{ role: 'user', content: 'szukaj' }],
  });
  ok('always without endpoint: Anthropic keeps its native stub',
    anthSeen[0]?.body?.tools?.[0]?.type === 'web_search_20250305' && anthSeen.length === 1);
}

// 9) A tool the model was never offered is answered here, not handed to the
//    client — the client has no such tool either. Regression: the search tool's
//    description used to advertise web_fetch even when it was not served, and
//    the invented call was passed straight through.
{
  seen.length = 0;
  const r = await post(local, {
    model: 'claude-sonnet-4-6', max_tokens: 50,
    tools: [WEB_SEARCH_STUB],
    messages: [{ role: 'user', content: 'HALUCYNACJA: wymyśl narzędzie' }],
  });
  const j = await r.json();
  const desc = seen[0]?.tools?.[0]?.function?.description || '';

  ok('search-only: description does not advertise web_fetch', !/web_fetch/.test(desc));
  ok('invented tool: never reaches the client', !JSON.stringify(j).includes('"tool_use"'));
  ok('invented tool: answered with an error the model can read',
    (seen[1]?.messages || []).some(m => m.role === 'tool' && /no tool by that name/.test(m.content)));
  ok('invented tool: the turn still completes', j.content?.[0]?.text === 'Odpowiedź po wyszukaniu.');
}

// 10) With crawl4ai configured, web_fetch is advertised and actually runs
{
  seen.length = 0; lastFetch = null;
  const r = await post(both, {
    model: 'claude-sonnet-4-6', max_tokens: 50,
    tools: [WEB_SEARCH_STUB, WEB_FETCH_STUB],
    messages: [{ role: 'user', content: 'POBIERZ https://example.com' }],
  });
  const j = await r.json();
  const desc = (seen[0]?.tools || []).find(t => t.function?.name === 'web_search')?.function?.description || '';

  ok('both served: description points at web_fetch', /web_fetch/.test(desc));
  ok('both served: web_fetch offered with a url schema',
    !!(seen[0]?.tools || []).find(t => t.function?.name === 'web_fetch')?.function?.parameters?.properties?.url);
  ok('web_fetch: crawl4ai hit on /md with the model’s URL',
    lastFetch?.path === '/md' && lastFetch?.body?.url === 'https://example.com');
  ok('web_fetch: token sent as a bearer', lastFetch?.auth === 'Bearer tok-123');
  ok('web_fetch: markdown fed back to the model',
    (seen[1]?.messages || []).some(m => m.role === 'tool' && /Treść pobranej strony/.test(m.content)));
  ok('web_fetch: client sees only the answer', j.content?.[0]?.text === 'Odpowiedź po wyszukaniu.');
}

// 11) An Anthropic-flavor local gateway gets the request in its own dialect on
//     every round of the in-proxy loop: its model name and its effort level
{
  anthSeen.length = 0;
  const r = await post(localAnth, {
    model: 'claude-sonnet-4-6', max_tokens: 50,
    tools: [WEB_SEARCH_STUB], output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: 'znajdź dokumentację crawl4ai' }],
  });
  const j = await r.json();
  ok('local anthropic flavor: two rounds, answer delivered',
    anthSeen.length === 2 && j.content.some(c => c.text === 'Odpowiedź z Anthropic.'));
  ok('local anthropic flavor: model and effort rewritten on every round',
    anthSeen.every(s => s.body.model === 'my-local-model' && s.body.output_config.effort === 'high'));
  ok('local anthropic flavor: client still sees its own model name', j.model === 'claude-sonnet-4-6');
}

finish();
