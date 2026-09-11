import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REASONING_PRESETS = ["auto", "gpt_six", "openai", "openrouter", "deepseek", "thinking", "none"];
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "ultra", "max"];

const PROFILES = [
  { pattern: /^gpt-5\.6-sol$/i, contextWindow: 272_000, supportsImages: true, reasoningPreset: "gpt_six", defaultReasoningLevel: "low", useResponsesLite: true, toolMode: "code_mode_only", multiAgentVersion: "v2", includeSkillsUsageInstructions: false, supportsReasoningSummaries: true, defaultReasoningSummary: "none", supportVerbosity: true, defaultVerbosity: "low", supportsSearchTool: true, webSearchToolType: "text_and_image", compHash: "3000", truncationLimit: 10_000 },
  { pattern: /^gpt-5\.6-terra$/i, contextWindow: 272_000, supportsImages: true, reasoningPreset: "gpt_six", defaultReasoningLevel: "medium", useResponsesLite: true, toolMode: "code_mode_only", multiAgentVersion: "v2", includeSkillsUsageInstructions: false, supportsReasoningSummaries: true, defaultReasoningSummary: "none", supportVerbosity: true, defaultVerbosity: "low", supportsSearchTool: true, webSearchToolType: "text_and_image", compHash: "3000", truncationLimit: 10_000 },
  { pattern: /^gpt-5\.6-luna$/i, contextWindow: 272_000, supportsImages: true, reasoningPreset: "gpt_six", defaultReasoningLevel: "medium", useResponsesLite: true, toolMode: "code_mode_only", multiAgentVersion: "v1", includeSkillsUsageInstructions: false, supportsReasoningSummaries: true, defaultReasoningSummary: "none", supportVerbosity: true, defaultVerbosity: "low", supportsSearchTool: true, webSearchToolType: "text_and_image", compHash: "3000", truncationLimit: 10_000 },
  { pattern: /^gpt-5\.6(?:-|$)/i, contextWindow: 272_000, supportsImages: true, reasoningPreset: "gpt_six" },
  // Astra is a newer Responses model; keep the conservative context size but
  // expose its native image input so Codex does not hide the attachment control.
  { pattern: /^gpt-6-astra$/i, contextWindow: 262_144, supportsImages: true, reasoningPreset: "openai" },
  { pattern: /^gpt-5\.5(?:-|$)/i, contextWindow: 272_000, supportsImages: true, reasoningPreset: "openai" },
  { pattern: /^gpt-5\.4(?:-|$)/i, contextWindow: 272_000, supportsImages: true, reasoningPreset: "openai" },
  { pattern: /^gpt-4\.1(?:-|$)/i, contextWindow: 1_047_576, supportsImages: true },
  { pattern: /^deepseek-v4-(?:pro|flash)$/i, contextWindow: 1_000_000, supportsImages: true, reasoningPreset: "deepseek" },
  { pattern: /^deepseek-(?:chat|reasoner)$/i, contextWindow: 128_000, supportsImages: true, reasoningPreset: "deepseek" },
  { pattern: /^kimi-k2(?:\.5|-thinking|-thinking-turbo|\.7-code)/i, contextWindow: 262_144, supportsImages: true, reasoningPreset: "thinking" },
  { pattern: /^qwen3-coder-plus$/i, contextWindow: 1_048_576, supportsImages: true, reasoningPreset: "thinking" },
  // Gemini API documents Gemini 3.8 Flash with a 1,048,576-token input limit.
  // This exact gateway variant otherwise falls through to the 262,144 Responses default.
  { pattern: /^gemini-3\.8-flash-high$/i, contextWindow: 1_048_576, supportsImages: true },
  { pattern: /^glm-5\.2$/i, contextWindow: 1_000_000, supportsImages: true, reasoningPreset: "thinking" },
  { pattern: /^glm-4\.(?:7|7-flash|5-air)$/i, contextWindow: 128_000, supportsImages: true, reasoningPreset: "thinking" },
  { pattern: /^minimax-m2(?:\.1|-lightning)/i, contextWindow: 200_000, supportsImages: true, reasoningPreset: "thinking" },
];

let codexCache = { mtimeMs: -1, models: new Map() };

export function resolveModelCapability(modelId, { provider = null, reasoningPreset = "auto" } = {}) {
  const id = String(modelId || "").trim();
  const discovered = provider?.modelCapabilities?.[id];
  const local = localCodexModels().get(id.toLowerCase());
  const profile = PROFILES.find((item) => item.pattern.test(id));
  const fallback = provider?.apiType === "responses"
    ? { contextWindow: 262_144, supportsImages: true, source: "responses_default" }
    : { contextWindow: 128_000, supportsImages: true, source: "chat_default" };
  // Provider-scoped metadata still controls context and reasoning details. Image
  // input is intentionally enabled for every published model, including new IDs
  // and stale caches, so Codex keeps the attachment control available.
  const base = provider
    ? profile
      ? { ...profileWithoutPattern(profile), source: "builtin_profile" }
      : fallback
    : validCapability(local)
      ? { ...local, source: "codex_cache" }
      : profile
        ? { ...profileWithoutPattern(profile), source: "builtin_profile" }
        : fallback;
  const capability = discovered && typeof discovered === "object"
    ? { ...base, ...discovered, source: "provider_metadata" }
    : base;
  return { ...capability, supportsImages: true, reasoning: resolveReasoningCapability(id, { provider, preset: reasoningPreset, discovered: discovered || local }) };
}

export function resolveCodexRuntimeProfile(modelId, preferred = null) {
  const id = String(modelId || "").trim().toLowerCase();
  const preferredProfile = runtimeProfileFromModelItem(preferred);
  const localModels = localCodexModels();
  const exact = localModels.get(id);
  const compatible = !exact && id === "gpt-5.6-sol" ? localModels.get("gpt-5.6-terra") : null;
  const builtin = PROFILES.find((item) => item.pattern.test(modelId));
  return {
    ...(builtin ? runtimeFields(builtin) : {}),
    ...(compatible ? runtimeFields(compatible) : {}),
    ...(exact ? runtimeFields(exact) : {}),
    ...preferredProfile,
  };
}

export function resolveReasoningCapability(modelId, { provider = null, preset = "auto", discovered = null } = {}) {
  const id = String(modelId || "").trim();
  const selected = REASONING_PRESETS.includes(preset) ? preset : "auto";
  const metadataLevels = normalizeReasoningLevels(discovered?.reasoningLevels);
  if (selected === "auto" && metadataLevels.length) {
    return reasoningCapability("provider", metadataLevels, discovered?.defaultReasoningLevel, provider?.apiType === "responses" ? "responses" : "reasoning_effort");
  }
  const effective = selected === "auto" ? inferReasoningPreset(id, provider) : selected;
  if (effective === "gpt_six") {
    const profile = PROFILES.find((item) => item.pattern.test(id));
    return reasoningCapability(effective, ["low", "medium", "high", "xhigh", "ultra", "max"], profile?.defaultReasoningLevel || "medium", provider?.apiType === "responses" ? "responses" : "reasoning_effort");
  }
  if (effective === "openai") return reasoningCapability(effective, ["low", "medium", "high", "xhigh"], "medium", provider?.apiType === "responses" ? "responses" : "reasoning_effort");
  if (effective === "openrouter") return reasoningCapability(effective, ["minimal", "low", "medium", "high", "xhigh"], "medium", provider?.apiType === "responses" ? "responses" : "reasoning.effort");
  if (effective === "deepseek") return reasoningCapability(effective, ["high", "max"], "high", provider?.apiType === "responses" ? "responses" : "reasoning_effort");
  if (effective === "thinking") return reasoningCapability(effective, ["medium"], "medium", "thinking_toggle");
  return reasoningCapability("none", [], null, "none");
}

export function applyReasoningToChatPayload(payload, body, route) {
  const selected = reasoningEffortFromBody(body);
  const capability = resolveReasoningCapability(route.upstreamModel, { provider: route.provider, preset: route.reasoningPreset });
  const result = { selected, sent: null, parameter: "none", preset: capability.preset, changed: false };
  if (!selected || capability.transport === "none") return result;
  if (capability.transport === "thinking_toggle") {
    const target = thinkingParameter(route.upstreamModel, route.provider);
    if (target === "enable_thinking") payload.enable_thinking = true;
    else if (target === "reasoning_split") payload.reasoning_split = true;
    else payload.thinking = { type: "enabled" };
    return { ...result, sent: "enabled", parameter: target, changed: selected !== "enabled" };
  }
  const sent = mapReasoningEffort(selected, capability.preset);
  if (!sent) return result;
  if (capability.preset === "deepseek") payload.thinking = { type: "enabled" };
  if (capability.transport === "reasoning.effort") payload.reasoning = { effort: sent };
  else payload.reasoning_effort = sent;
  return { ...result, sent, parameter: capability.transport, changed: sent !== selected };
}

export function applyReasoningToResponsesPayload(body, route) {
  const payload = structuredClone(body);
  const selected = reasoningEffortFromBody(body);
  const capability = resolveReasoningCapability(route.upstreamModel, { provider: route.provider, preset: route.reasoningPreset });
  const result = { selected, sent: null, parameter: "none", preset: capability.preset, changed: false };
  delete payload.reasoning_effort;
  if (!selected) return { payload, reasoning: result };
  if (capability.transport === "none") {
    return { payload, reasoning: { ...result, sent: selected, parameter: "reasoning.effort", changed: false } };
  }
  if (capability.transport === "thinking_toggle") {
    delete payload.reasoning;
    return { payload, reasoning: result };
  }
  const sent = mapReasoningEffort(selected, capability.preset);
  if (!sent) {
    delete payload.reasoning;
    return { payload, reasoning: result };
  }
  payload.reasoning = { ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}), effort: sent };
  return { payload, reasoning: { ...result, sent, parameter: "reasoning.effort", changed: sent !== selected } };
}

export function reasoningMetadata(body, route) {
  const selected = reasoningEffortFromBody(body);
  return { selected, sent: selected, parameter: selected ? "reasoning.effort" : "none", preset: route.kind === "official" ? "official" : resolveReasoningCapability(route.upstreamModel, { provider: route.provider, preset: route.reasoningPreset }).preset, changed: false };
}

export function capabilityFromModelItem(item) {
  if (!item || typeof item !== "object") return null;
  const contextWindow = firstValidInteger([
    item.context_window, item.contextWindow, item.max_context_window, item.maxContextWindow,
    item.context_length, item.contextLength, item.max_tokens, item.maxTokens,
  ]);
  const modalities = item.input_modalities || item.inputModalities || item.modalities;
  const explicitImages = [item.supports_images, item.supportsImages, item.supports_vision, item.supportsVision, item.capabilities?.vision]
    .find((value) => typeof value === "boolean");
  const supportsImages = Array.isArray(modalities)
    ? modalities.some((value) => /^(image|vision)$/i.test(String(value)))
    : explicitImages;
  const reasoningLevels = normalizeReasoningLevels(item.supported_reasoning_levels || item.supportedReasoningLevels || item.reasoning_levels || item.reasoningLevels);
  const defaultReasoningLevel = validEffort(item.default_reasoning_level || item.defaultReasoningLevel);
  if (!contextWindow && typeof supportsImages !== "boolean" && !reasoningLevels.length) return null;
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(typeof supportsImages === "boolean" ? { supportsImages } : {}),
    ...(reasoningLevels.length ? { reasoningLevels } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
    ...runtimeProfileFromModelItem(item),
  };
}

export function runtimeProfileFromModelItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return {};
  const result = {};
  copyString(result, "baseInstructions", item.base_instructions ?? item.baseInstructions, 250_000);
  copyObject(result, "modelMessages", item.model_messages ?? item.modelMessages, 750_000);
  copyBoolean(result, "includeSkillsUsageInstructions", item.include_skills_usage_instructions ?? item.includeSkillsUsageInstructions);
  copyEnum(result, "shellType", item.shell_type ?? item.shellType, ["shell_command", "unified_exec"]);
  copyEnum(result, "applyPatchToolType", item.apply_patch_tool_type ?? item.applyPatchToolType, ["freeform", "function"]);
  copyEnum(result, "webSearchToolType", item.web_search_tool_type ?? item.webSearchToolType, ["text", "text_and_image"]);
  copyBoolean(result, "supportsSearchTool", item.supports_search_tool ?? item.supportsSearchTool);
  copyArray(result, "experimentalSupportedTools", item.experimental_supported_tools ?? item.experimentalSupportedTools, 100);
  copyEnum(result, "toolMode", item.tool_mode ?? item.toolMode, ["direct", "code_mode", "code_mode_only"]);
  copyEnum(result, "multiAgentVersion", item.multi_agent_version ?? item.multiAgentVersion, ["v1", "v2"]);
  copyBoolean(result, "useResponsesLite", item.use_responses_lite ?? item.useResponsesLite);
  copyString(result, "compHash", item.comp_hash ?? item.compHash, 128);
  copyBoolean(result, "supportsParallelToolCalls", item.supports_parallel_tool_calls ?? item.supportsParallelToolCalls);
  copyBoolean(result, "supportsReasoningSummaries", item.supports_reasoning_summaries ?? item.supportsReasoningSummaries);
  copyEnum(result, "defaultReasoningSummary", item.default_reasoning_summary ?? item.defaultReasoningSummary, ["none", "auto", "concise", "detailed"]);
  copyBoolean(result, "supportVerbosity", item.support_verbosity ?? item.supportVerbosity);
  copyEnum(result, "defaultVerbosity", item.default_verbosity ?? item.defaultVerbosity, ["low", "medium", "high"]);
  const truncation = item.truncation_policy ?? item.truncationPolicy;
  const truncationLimit = firstValidInteger([truncation?.limit]);
  if (truncationLimit) result.truncationLimit = truncationLimit;
  return result;
}

export function normalizeModelCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [id, capability] of Object.entries(value).slice(0, 500)) {
    if (!id || id.length > 128 || !capability || typeof capability !== "object") continue;
    const contextWindow = firstValidInteger([capability.contextWindow]);
    const supportsImages = typeof capability.supportsImages === "boolean" ? capability.supportsImages : undefined;
    const reasoningLevels = normalizeReasoningLevels(capability.reasoningLevels);
    const defaultReasoningLevel = validEffort(capability.defaultReasoningLevel);
    if (contextWindow || supportsImages !== undefined || reasoningLevels.length) result[id] = { ...(contextWindow ? { contextWindow } : {}), ...(supportsImages !== undefined ? { supportsImages } : {}), ...(reasoningLevels.length ? { reasoningLevels } : {}), ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}) };
  }
  return result;
}

function localCodexModels() {
  const target = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
  let stat;
  try { stat = fs.statSync(target); } catch { return new Map(); }
  if (codexCache.mtimeMs === stat.mtimeMs) return codexCache.models;
  const models = new Map();
  try {
    const payload = JSON.parse(fs.readFileSync(target, "utf8"));
    for (const item of Array.isArray(payload?.models) ? payload.models : []) {
      const id = String(item?.slug || item?.id || "").trim();
      if (!id) continue;
      const capability = capabilityFromModelItem(item);
      if (capability) models.set(id.toLowerCase(), capability);
    }
  } catch { /* A stale or malformed Codex cache must not block Relay. */ }
  codexCache = { mtimeMs: stat.mtimeMs, models };
  return models;
}

function profileWithoutPattern(profile) {
  const { pattern: _pattern, ...capability } = profile;
  return capability;
}

function runtimeFields(value) {
  const keys = ["baseInstructions", "modelMessages", "includeSkillsUsageInstructions", "shellType", "applyPatchToolType", "webSearchToolType", "supportsSearchTool", "experimentalSupportedTools", "toolMode", "multiAgentVersion", "useResponsesLite", "compHash", "supportsParallelToolCalls", "supportsReasoningSummaries", "defaultReasoningSummary", "supportVerbosity", "defaultVerbosity", "truncationLimit"];
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, structuredClone(value[key])]));
}

function copyString(target, key, value, maxLength) {
  if (typeof value === "string" && value.length <= maxLength) target[key] = value;
}

function copyObject(target, key, value, maxLength) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length <= maxLength) target[key] = JSON.parse(encoded);
  } catch { /* Ignore malformed cached model metadata. */ }
}

function copyBoolean(target, key, value) {
  if (typeof value === "boolean") target[key] = value;
}

function copyEnum(target, key, value, allowed) {
  if (allowed.includes(value)) target[key] = value;
}

function copyArray(target, key, value, limit) {
  if (!Array.isArray(value)) return;
  target[key] = value.filter((item) => typeof item === "string").slice(0, limit);
}

function validCapability(value) {
  return Number.isInteger(value?.contextWindow) && value.contextWindow >= 8_000 && value.contextWindow <= 10_000_000 && typeof value.supportsImages === "boolean";
}

function firstValidInteger(values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isInteger(number) && number >= 8_000 && number <= 10_000_000) return number;
  }
  return null;
}

function inferReasoningPreset(modelId, provider) {
  const platform = `${provider?.name || ""} ${provider?.baseUrl || ""}`.toLowerCase();
  const model = String(modelId || "").toLowerCase();
  if (platform.includes("openrouter")) return "openrouter";
  const profile = PROFILES.find((item) => item.pattern.test(modelId));
  if (profile?.reasoningPreset) return profile.reasoningPreset;
  if (model.includes("deepseek")) return "deepseek";
  if (/kimi|moonshot|glm|zhipu|qwen|minimax|mimo/.test(`${platform} ${model}`)) return "thinking";
  return provider?.apiType === "responses" && /^(o\d|gpt-5)/i.test(model) ? "openai" : "none";
}

function reasoningCapability(preset, levels, defaultLevel, transport) {
  const normalized = normalizeReasoningLevels(levels);
  const selectedDefault = validEffort(defaultLevel) || normalized[0]?.effort || null;
  return { preset, levels: normalized, defaultLevel: selectedDefault, transport };
}

export function normalizeReasoningLevels(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    const effort = validEffort(typeof item === "string" ? item : item?.effort);
    if (!effort || result.some((entry) => entry.effort === effort)) continue;
    const description = String(typeof item === "object" ? item?.description || "" : "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 160);
    result.push({ effort, description: description || effortDescription(effort) });
  }
  return result.slice(0, 8);
}

function validEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  return REASONING_EFFORTS.includes(effort) ? effort : "";
}

function reasoningEffortFromBody(body) {
  return validEffort(body?.reasoning?.effort || body?.reasoning_effort);
}

function mapReasoningEffort(effort, preset) {
  if (preset === "deepseek") return ["max", "ultra", "xhigh"].includes(effort) ? "max" : "high";
  if (preset === "openrouter") return ["max", "ultra"].includes(effort) ? "xhigh" : ["minimal", "low", "medium", "high", "xhigh"].includes(effort) ? effort : null;
  return validEffort(effort) || null;
}

function thinkingParameter(modelId, provider) {
  const value = `${provider?.name || ""} ${provider?.baseUrl || ""} ${modelId || ""}`.toLowerCase();
  if (/qwen|dashscope|bailian|siliconflow/.test(value)) return "enable_thinking";
  if (value.includes("minimax")) return "reasoning_split";
  return "thinking";
}

function effortDescription(effort) {
  return ({ minimal: "Minimal reasoning", low: "Light reasoning", medium: "Balanced reasoning", high: "High reasoning", xhigh: "Extra high reasoning", ultra: "Ultra reasoning", max: "Maximum reasoning" })[effort] || effort;
}
