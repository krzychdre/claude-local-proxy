// Shared test harness: mock upstreams, the real router as a child process, and
// a PASS/FAIL tally. Every test file runs as its own process, so the tally is
// plain module state.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROUTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'router.mjs');

export const wait = ms => new Promise(r => setTimeout(r, ms));

// Poll `check` (sync or async) until it returns true; false after 5 s.
export async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return true;
    await wait(50);
  }
  return false;
}

// A mock upstream on a free loopback port. `respond(req, res, body)` is called
// once the request is read, with its JSON body parsed.
export function mockServer(respond) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => respond(req, res, raw ? JSON.parse(raw) : {}));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

// Ask the OS for a port nobody is using right now.
function freePort() {
  return new Promise(resolve => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const routers = [];

// Spawn the router with `configText` as its config file. ROUTER_CONFIG always
// points at that temp file, so no config from the working directory or the
// home directory is ever picked up. `router.logs` collects stdout + stderr,
// `router.configPath` is that file, for tests that edit it under a live router.
async function spawnRouter(env, configText) {
  const port = await freePort();
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-')), 'config.json');
  fs.writeFileSync(configPath, configText);
  const proc = spawn('node', [ROUTER], {
    env: { ...process.env, ROUTER_CONFIG: configPath, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const router = { proc, configPath, base: `http://127.0.0.1:${port}`, logs: '', stop: () => proc.kill() };
  proc.stdout.on('data', d => router.logs += d);
  proc.stderr.on('data', d => router.logs += d);
  routers.push(router);
  return router;
}

// Start the router and wait until it answers. `env` holds env-var overrides,
// `config` the content of its config file.
export async function startRouter(env, config = {}) {
  const router = await spawnRouter(env, JSON.stringify(config));
  const up = await until(() => fetch(`${router.base}/health`).then(() => true, () => false));
  if (!up) throw new Error(`router did not start:\n${router.logs}`);
  return router;
}

// Run the router with a config it must refuse, and resolve with how it died.
// A router that starts anyway is killed after 5 s and reports code null.
export async function routerStartupFailure(env, configText) {
  const router = await spawnRouter(env, configText);
  const timer = setTimeout(router.stop, 5000);
  const code = await new Promise(resolve => router.proc.on('close', resolve));
  clearTimeout(timer);
  return { code, logs: router.logs };
}

// The parsed `data:` payloads of an SSE response body, in order.
export function sseEvents(text) {
  return text.split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

let pass = 0;
let fail = 0;

export function ok(name, cond) {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
}

// Stop every router and remove its temp config, print the tally (and the router
// logs if anything failed), and exit non-zero on any failure.
export function finish() {
  for (const r of routers) {
    r.stop();
    fs.rmSync(path.dirname(r.configPath), { recursive: true });
  }
  if (fail) for (const r of routers) console.log(`\n--- router logs ---\n${r.logs}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
