// Route decision: given the request's model name, decide which upstream serves it.
//
// Returns 'anthropic' for anything not matched, or a backend config object for
// the local path: { route: 'local', tier, model, baseUrl, flavor, apiKey }.

// Resolve a per-tier override, falling back to the flat local* config for any
// field the override leaves unset.
function backendFor(cfg, tier) {
  const override = Array.isArray(cfg.localBackends) && cfg.localBackends.length
    ? cfg.localBackends.find(b => String(b.tier).toLowerCase() === String(tier).toLowerCase())
    : null;
  const b = override || {};
  return {
    route: 'local',
    tier,
    model: b.model || cfg.localModel,
    baseUrl: b.baseUrl || cfg.localBaseUrl,
    flavor: b.flavor || cfg.localFlavor,
    apiKey: b.apiKey || cfg.localApiKey,
  };
}

export function pickUpstream(cfg, model) {
  const m = String(model || '').toLowerCase();
  for (const tier of cfg.localTiers) {
    if (m.includes(String(tier).toLowerCase())) return backendFor(cfg, tier);
  }
  return 'anthropic';
}
