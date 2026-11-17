#!/usr/bin/env node
// Test runner for the model-router proxy.
// Runs each test file as a child process, reports results, exits non-zero on failure.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const tests = [
  'router_test.mjs',     // OpenAI-flavor path (translation, tool calls, count_tokens, upstream errors) + the transparent Anthropic path
  'router_test2.mjs',    // Anthropic-flavor path: routing, model rewrite, auth swap, per-tier backends + effort mapping, /health, configs refused at startup
  'usage_log_test.mjs',  // Token-usage logging (streaming + non-stream, no extra upstream calls)
  'websearch_test.mjs',  // Server-side web tools: 'off' strips the stubs, 'local' resolves them in-proxy, 'always' does so on the Anthropic route too
  'cancel_test.mjs',     // A client hanging up mid-stream cancels the upstream call
  'reload_test.mjs',     // Editing the config file reconfigures the running router
];

let suiteFail = 0;

for (const t of tests) {
  const file = path.join(__dir, t);
  console.log(`\n${'='.repeat(60)}\n  ${t}\n${'='.repeat(60)}`);
  const exitCode = await new Promise(resolve => {
    const child = spawn('node', [file], { stdio: 'inherit' });
    child.on('close', code => resolve(code ?? 1));
  });
  if (exitCode !== 0) suiteFail++;
}

console.log(`\n${'='.repeat(60)}`);
if (suiteFail === 0) {
  console.log('All test suites passed.');
} else {
  console.error(`${suiteFail} of ${tests.length} test suite(s) failed.`);
}
process.exit(suiteFail > 0 ? 1 : 0);