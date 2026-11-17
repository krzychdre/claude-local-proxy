// Anthropic-flavor local path: routing, model rewrite, auth swap, per-tier
// backends from the config file (with their effort-level mapping), and the
// /health view of that routing table.
import { mockServer, startRouter, routerStartupFailure, ok, finish } from './helpers.mjs';

// Two mock Anthropic-compatible local gateways: each echoes what it received.
const gateway = name => mockServer((req, res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    where: name, path: req.url, model: body.model, outputConfig: body.output_config,
    auth: req.headers['authorization'] || null, xapikey: req.headers['x-api-key'] || null,
  }));
});
const gw = await gateway('local-gateway');
const haikuGw = await gateway('haiku-gateway');

// mock real Anthropic upstream
const ant = await mockServer((req, res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ where: 'anthropic', model: body.model, auth: req.headers['authorization'] || null }));
});

// sonnet uses the flat local* settings, haiku overrides all of them and renames
// the 'medium' effort level, as a model without that level needs.
const router = await startRouter(
  { LOCAL_BASE_URL: gw, LOCAL_API_KEY: 'gw-secret', ANTHROPIC_UPSTREAM_URL: ant, ROUTER_LOG_LEVEL: 'info' },
  {
    localFlavor: 'anthropic',
    localModel: 'my-local-model',
    localTiers: ['sonnet', 'haiku'],
    localBackends: [{ tier: 'haiku', model: 'my-haiku-model', baseUrl: haikuGw, apiKey: 'haiku-secret', effortMap: { medium: 'high' } }],
  },
);
const post = (m, extra) => fetch(`${router.base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-oat-REAL' },
  body: JSON.stringify({ model: m, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...extra }),
}).then(r => r.json());

{
  const j = await post('claude-sonnet-4-6');
  ok('sonnet -> local gateway', j.where === 'local-gateway');
  ok('  model rewritten to local', j.model === 'my-local-model');
  ok('  real Anthropic auth NOT leaked to gateway', j.auth === 'Bearer gw-secret' && j.xapikey === 'gw-secret');
}
{
  const j = await post('claude-haiku-4-5');
  ok('haiku -> its own gateway', j.where === 'haiku-gateway');
  ok('  per-tier model and key applied', j.model === 'my-haiku-model' && j.xapikey === 'haiku-secret');
}
{
  const mapped = await post('claude-haiku-4-5', { output_config: { effort: 'medium', format: { type: 'text' } } });
  ok('effort level renamed for the backend that maps it', mapped.outputConfig.effort === 'high');
  ok('  the rest of output_config untouched', mapped.outputConfig.format.type === 'text');
  const unlisted = await post('claude-haiku-4-5', { output_config: { effort: 'low' } });
  ok('  a level the map does not list passes through', unlisted.outputConfig.effort === 'low');
  const unmapped = await post('claude-sonnet-4-6', { output_config: { effort: 'medium' } });
  ok('  a backend without a map is left alone', unmapped.outputConfig.effort === 'medium');
}
{
  const j = await post('claude-opus-4-8[1m]');
  ok('opus[1m] -> real Anthropic', j.where === 'anthropic');
  ok('  opus keeps real subscription auth', j.auth === 'Bearer sk-ant-oat-REAL');
}
{
  const r = await fetch(`${router.base}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello there friend' }] }) });
  const j = await r.json();
  ok('count_tokens(local) estimated', typeof j.input_tokens === 'number' && j.input_tokens > 0);
}
{
  const health = await (await fetch(`${router.base}/health`)).text();
  ok('/health shows the per-tier backend', JSON.parse(health).localBackends[0].model === 'my-haiku-model');
  ok('/health does not expose backend keys', !health.includes('haiku-secret') && !health.includes('gw-secret'));
}
{
  ok('banner shows what each tier resolves to',
    router.logs.includes(`tier 'sonnet' -> anthropic @ ${gw} (model my-local-model)`)
    && router.logs.includes(`tier 'haiku' -> anthropic @ ${haikuGw} (model my-haiku-model)`));
}

// A config the router cannot honour stops it at startup instead of sending the
// local tiers somewhere nobody asked for.
{
  const { code, logs } = await routerStartupFailure({}, JSON.stringify({ localTiers: ['sonnet'], localFlavor: 'ollama' }));
  ok('unknown flavor: refuses to start', code === 1);
  ok('unknown flavor: names the tier and the flavor', logs.includes(`tier 'sonnet': unknown flavor "ollama"`));
}
{
  const { code, logs } = await routerStartupFailure({}, '{ "localTiers": ["haiku"], ');
  ok('unparseable config: refuses to start', code === 1);
  ok('unparseable config: says which file', logs.includes('cannot load') && logs.includes('config.json'));
}

finish();
