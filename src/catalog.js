import { LEGACY_OFFICIAL_SLOTS, OFFICIAL_CODEX_BASE_URL } from "./constants.js";
import { normalizeReasoningLevels, resolveCodexRuntimeProfile, resolveModelCapability, resolveReasoningCapability } from "./model-capabilities.js";

export function activeRoutes(settings) {
  const thirdParty = settings.thirdPartySlots
    .filter((slot) => slot.displayName && slot.providerId && slot.upstreamModel)
    .map((slot) => {
      const provider = settings.providers.find((item) => item.id === slot.providerId);
      return provider ? { kind: "third_party", ...slot, provider } : null;
    })
    .filter(Boolean);

  const selectedOfficial = Array.isArray(settings.official?.slots) ? settings.official.slots : LEGACY_OFFICIAL_SLOTS;
  const official = settings.official.verified
    ? selectedOfficial.slice(0, 2).map((slot) => ({ kind: "official", ...slot, apiType: "responses", baseUrl: OFFICIAL_CODEX_BASE_URL }))
    : [];
  return [...official, ...thirdParty];
}

export function buildModelCatalog(settings) {
  return {
    models: activeRoutes(settings).map((route, priority) => {
      const reasoning = catalogReasoning(route);
      const runtime = catalogRuntime(route);
      return ({
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
      base_instructions: runtime.baseInstructions || "You are Codex, a coding agent. Follow developer and user instructions in the current session.",
      ...(runtime.modelMessages ? { model_messages: runtime.modelMessages } : {}),
      include_skills_usage_instructions: Boolean(runtime.includeSkillsUsageInstructions),
      default_reasoning_level: reasoning.defaultLevel,
      supported_reasoning_levels: reasoning.levels,
      supports_reasoning_summaries: Boolean(runtime.supportsReasoningSummaries),
      default_reasoning_summary: runtime.defaultReasoningSummary || "auto",
      support_verbosity: Boolean(runtime.supportVerbosity),
      default_verbosity: runtime.defaultVerbosity || null,
      apply_patch_tool_type: runtime.applyPatchToolType || "freeform",
      web_search_tool_type: runtime.webSearchToolType || "text",
      truncation_policy: { mode: "tokens", limit: runtime.truncationLimit || 10_000 },
      supports_parallel_tool_calls: runtime.supportsParallelToolCalls !== false,
      supports_image_detail_original: Boolean(route.supportsImages || route.kind === "official"),
      context_window: contextWindow(route),
      max_context_window: contextWindow(route),
      effective_context_window_percent: 95,
      experimental_supported_tools: runtime.experimentalSupportedTools || [],
      input_modalities: route.supportsImages || route.kind === "official" ? ["text", "image"] : ["text"],
      supports_search_tool: Boolean(runtime.supportsSearchTool),
      use_responses_lite: Boolean(runtime.useResponsesLite),
      ...(runtime.toolMode ? { tool_mode: runtime.toolMode } : {}),
      ...(runtime.multiAgentVersion ? { multi_agent_version: runtime.multiAgentVersion } : {}),
      ...(runtime.compHash ? { comp_hash: runtime.compHash } : {}),
      });
    }),
  };
}

function contextWindow(route) {
  if (route.kind === "third_party") {
    return resolveModelCapability(route.upstreamModel, { provider: route.provider, reasoningPreset: route.reasoningPreset }).contextWindow;
  }
  return Number(route.contextWindow) || 258400;
}
function catalogRuntime(route) {
  if (route.kind !== "official" && route.provider?.apiType === "chat_completions") {
    const runtime = resolveCodexRuntimeProfile("gpt-5.5");
    return /^glm-5\.2$/i.test(String(route.upstreamModel || ""))
      ? { ...runtime, includeSkillsUsageInstructions: false }
      : runtime;
  }
  if (route.kind !== "official" && route.provider?.apiType !== "responses") return {};
  return resolveCodexRuntimeProfile(route.upstreamModel, route);
}
function catalogReasoning(route) {
  if (route.kind === "official") {
    const levels = normalizeReasoningLevels(route.reasoningLevels);
    if (levels.length) return { levels, defaultLevel: levels.some((level) => level.effort === route.defaultReasoningLevel) ? route.defaultReasoningLevel : levels[0].effort };
    const inferred = resolveReasoningCapability(route.upstreamModel, { provider: { apiType: "responses" }, preset: "auto" });
    return inferred.levels.length ? { levels: inferred.levels, defaultLevel: inferred.defaultLevel } : { levels: compatibilityReasoningLevels(), defaultLevel: "medium" };
  }
  const capability = resolveReasoningCapability(route.upstreamModel, { provider: route.provider, preset: route.reasoningPreset });
  return { levels: capability.levels, defaultLevel: capability.defaultLevel };
}

function compatibilityReasoningLevels() {
  return [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balanced speed and reasoning depth" },
    { effort: "high", description: "Greater reasoning depth for complex tasks" },
    { effort: "xhigh", description: "Extra high reasoning depth for complex tasks" },
  ];
}
