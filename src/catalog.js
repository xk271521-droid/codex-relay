import { OFFICIAL_CODEX_BASE_URL, OFFICIAL_SLOTS } from "./constants.js";

export function activeRoutes(settings) {
  const thirdParty = settings.thirdPartySlots
    .filter((slot) => slot.displayName && slot.providerId && slot.upstreamModel)
    .map((slot) => {
      const provider = settings.providers.find((item) => item.id === slot.providerId);
      return provider ? { kind: "third_party", ...slot, provider } : null;
    })
    .filter(Boolean);

  const official = settings.official.verified
    ? OFFICIAL_SLOTS.map((slot) => ({ kind: "official", ...slot, apiType: "responses", baseUrl: OFFICIAL_CODEX_BASE_URL }))
    : [];
  return [...official, ...thirdParty];
}

export function buildModelCatalog(settings) {
  return {
    models: activeRoutes(settings).map((route, priority) => ({
      slug: route.id,
      display_name: route.displayName,
      description: route.description || (route.kind === "official" ? "Official Codex subscription route." : `${route.provider.name} via local router.`),
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority,
      additional_speed_tiers: route.kind === "official" ? ["fast"] : [],
      service_tiers: route.kind === "official" ? [{ id: "priority", name: "Fast", description: "Official accelerated tier when available." }] : [],
      availability_nux: null,
      upgrade: null,
      base_instructions: "You are Codex, a coding agent. Follow developer and user instructions in the current session.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: reasoningLevels(),
      supports_reasoning_summaries: false,
      default_reasoning_summary: "auto",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: Math.floor(contextWindow(route) * 0.95) },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: Boolean(route.supportsImages || route.kind === "official"),
      context_window: contextWindow(route),
      max_context_window: contextWindow(route),
      effective_context_window_percent: 95,
      auto_compact_token_limit: Math.floor(contextWindow(route) * 0.8),
      experimental_supported_tools: [],
      input_modalities: route.supportsImages || route.kind === "official" ? ["text", "image"] : ["text"],
      supports_search_tool: false,
    })),
  };
}

function contextWindow(route) { return Number(route.contextWindow) || 258400; }
function reasoningLevels() {
  return [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balanced speed and reasoning depth" },
    { effort: "high", description: "Greater reasoning depth for complex tasks" },
    { effort: "xhigh", description: "Extra high reasoning depth for complex tasks" },
  ];
}
