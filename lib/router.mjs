// Route decision: given the request's model name, decide which upstream serves it.
//
// Returns 'anthropic' for anything not matched, or a backend config object for
// the local path: { route: 'local', tier, model, baseUrl, flavor, apiKey, effortMap }.

// Resolve a per-tier override, falling back to the flat local* config for any
// field the override leaves unset.
export function backendFor(cfg, tier) {
  const b = cfg.localBackends.find(o => o.tier.toLowerCase() === tier.toLowerCase()) || {};
  return {
    route: 'local',
    tier,
    model: b.model || cfg.localModel,
    baseUrl: b.baseUrl || cfg.localBaseUrl,
    flavor: b.flavor || cfg.localFlavor,
    apiKey: b.apiKey || cfg.localApiKey,
    effortMap: b.effortMap || cfg.localEffortMap,
  };
}

export function pickUpstream(cfg, model) {
  const m = String(model || '').toLowerCase();
  for (const tier of cfg.localTiers) {
    if (m.includes(tier.toLowerCase())) return backendFor(cfg, tier);
  }
  return 'anthropic';
}
