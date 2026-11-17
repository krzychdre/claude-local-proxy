# Changelog

Notable changes to the Claude Code model router. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Effort mapping.** `effortMap` on a `localBackends` entry, and
  `localEffortMap` for every backend without its own, rename the
  `output_config.effort` levels a local model does not know (for example
  `{ "medium": "high" }`). Unlisted levels pass through. Applies to
  `anthropic`-flavor backends.
- **Config reload without a restart.** The config file is checked once a second
  and the new config is swapped in as soon as the file changes. An edit that
  cannot be honoured is refused with an error in the log and the running config
  stays. `port` and `host` are still fixed at startup.
- **Cancellation reaches the upstream.** When the client drops a request, the
  proxy aborts its upstream call, so a local model stops generating an answer
  nobody will read. The single binary needs a Bun whose `node:http` reports a
  client disconnect: 1.4.4 does, 1.2.18 does not.
- `CHANGELOG.md`.

### Changed

- **Node 20.3 or newer is required** (was 18), for `AbortSignal.any`.
- **A config the proxy cannot honour stops it at startup**: a config file that
  does not parse (it used to fall back to the defaults) or an unknown
  `localFlavor` / per-tier `flavor`.
- **Upstream errors keep their status.** A `400` or `429` answered by the local
  server or, in the in-proxy web-tool loop, by Anthropic used to reach the
  client as a `502`, which it retries even when the error is final. `502` and
  `504` now mean only that the proxy could not reach the upstream.
- The startup banner prints one line per local tier with the backend it
  resolves to, instead of listing every `localBackends` entry whether or not
  its tier is routed.
- The example config shows three per-tier backends, one of them with an effort
  map.

### Fixed

- The Anthropic path dropped every response header except `content-type` and
  `request-id`, so the client never saw `retry-after` or the
  `anthropic-ratelimit-*` state. All headers are relayed now, except those
  describing how the upstream framed the body.
- An unknown `localFlavor` silently sent the local tiers to the Anthropic
  upstream with the client's own credentials, while the log said they went
  local.
- A request body sent with chunked transfer encoding failed with a `502`.
- On the OpenAI streaming path the client never learned the prompt size:
  `input_tokens` now arrives in `message_delta`. The SSE replay of the web-tool
  loop keeps the cache token counts.
- With `logUsage` on, a request that failed left no request line in the log.
- README: the Quick start referred to a settings profile that is not in the
  repository, and the `countTokens` description did not match what the option
  does.

### Security

- `/health` no longer returns the `apiKey` of `localBackends` entries. The
  endpoint needs no authentication, so with the proxy bound to a non-loopback
  address those keys were readable by anyone who could reach it.
