// Editing the config file reconfigures the running router: no restart, and a
// file that does not load leaves the running config in place.
import fs from 'node:fs';
import { mockServer, startRouter, until, wait, ok, finish } from './helpers.mjs';

// Mock Anthropic-compatible local gateway: echoes the model it was asked for.
const gateway = await mockServer((req, res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ where: 'local', model: body.model }));
});
const anthropic = await mockServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ where: 'anthropic' }));
});

const config = {
  anthropicBaseUrl: anthropic,
  localBaseUrl: gateway,
  localFlavor: 'anthropic',
  localModel: 'model-a',
  localTiers: ['sonnet'],
};
const router = await startRouter({ ROUTER_LOG_LEVEL: 'info' }, config);
const ask = model => fetch(`${router.base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
  body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
}).then(r => r.json());

ok('starts on the config it was given', (await ask('claude-sonnet-4-6')).model === 'model-a');
ok('haiku not local yet', (await ask('claude-haiku-4-5')).where === 'anthropic');

// 1) a valid edit is picked up
fs.writeFileSync(router.configPath, JSON.stringify({ ...config, localModel: 'model-b', localTiers: ['sonnet', 'haiku'] }));
ok('edited model picked up without a restart', await until(async () => (await ask('claude-sonnet-4-6')).model === 'model-b'));
ok('edited tier list picked up too', (await ask('claude-haiku-4-5')).where === 'local');

// 2) a file that does not load is refused, and the router keeps serving
fs.writeFileSync(router.configPath, '{ "localModel": "model-c", ');
ok('unloadable edit refused', await until(() => router.logs.includes('config reload refused')));
ok('running config kept after a refused edit', (await ask('claude-sonnet-4-6')).model === 'model-b');

// 3) the listening address is fixed at startup: the rest of the edit applies
fs.writeFileSync(router.configPath, JSON.stringify({ ...config, localModel: 'model-d', host: '127.0.0.2' }));
ok('edit with a new host still applied on the old address', await until(async () => (await ask('claude-sonnet-4-6')).model === 'model-d'));
ok('host change reported as needing a restart', router.logs.includes('restart to apply a port/host change'));
// ...and it is reported again on the next edit, for as long as it is pending
fs.writeFileSync(router.configPath, JSON.stringify({ ...config, localModel: 'model-e', host: '127.0.0.2' }));
await until(async () => (await ask('claude-sonnet-4-6')).model === 'model-e');
ok('pending host change reported on every reload', router.logs.split('restart to apply a port/host change').length === 3);

// 4) a deleted file (some editors delete and recreate on save) is not "no
//    config": nothing to wait for, so give the 1 s file poll time to notice
fs.rmSync(router.configPath);
await wait(1500);
ok('running config kept while the file is gone', (await ask('claude-sonnet-4-6')).model === 'model-e');

finish();
