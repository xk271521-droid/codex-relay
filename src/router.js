import crypto from "node:crypto";
import { thirdPartyResponsesCacheTrace } from "./cache-trace.js";
import { OFFICIAL_CODEX_BASE_URL } from "./constants.js";
import { activeRoutes } from "./catalog.js";
import { buildChatToolContext, responseInputToChatMessages, responseToolCallFromChat } from "./chat-tools.js";
import { compactCapabilityStatus, compactCapabilityTarget } from "./compact-capabilities.js";
import { fetchOfficial } from "./official-fetch.js";
import { applyReasoningToChatPayload, applyReasoningToResponsesPayload, reasoningMetadata } from "./model-capabilities.js";
import { classifyNativeCompactHttpResult, classifyNativeCompactTransportError } from "./native-compact-contract.js";
import { fetchProvider } from "./provider-fetch.js";
import { officialAccessToken, officialAccountId, providerKey } from "./store.js";

const historyManagedResponses = new WeakSet();
const responseContextModes = new WeakMap();
const responseReasoningModes = new WeakMap();
const responseRequestDiagnostics = new WeakMap();
const responseHistoryMetadata = new WeakMap();
const chatCachePrefixStates = new Map();
const CHAT_CACHE_PREFIX_LIMIT = 200;
const DEEPSEEK_SAVINGS_START_RATIO = 0.6;
const DEEPSEEK_SAVINGS_HIGH_RATIO = 0.8;
const DEEPSEEK_LARGE_TOOL_OUTPUT_CHARS = 6_000;
const DEEPSEEK_RECENT_TOOL_OUTPUTS = 6;
const RELAY_COMPACTION_PREFIX = "codex-relay:compaction:v1:";
const RELAY_NATIVE_COMPACTION_PREFIX = "codex-relay:native-compaction:v1:";
const THIRD_PARTY_COMPACTION_CACHE_TTL_MS = 10 * 60 * 1000;
const THIRD_PARTY_COMPACTION_FIRST_BYTE_TIMEOUT_MS = 60 * 1000;
const THIRD_PARTY_COMPACTION_CACHE_LIMIT = 50;
const THIRD_PARTY_NATIVE_AUTH_CIRCUIT_TTL_MS = 5 * 60 * 1000;
const REQUEST_TEMPLATE_MAX_BYTES = 1_000_000;
const THIRD_PARTY_COMPACTION_PROMPT = `You are creating a CONTEXT CHECKPOINT for another model that will resume this exact task.

Return a factual, structured handoff with these sections when applicable:
1. Objective and current status
2. Completed work and key decisions
3. Constraints and user preferences
4. Files, exact paths, commands, tests, errors, and verified results
5. Important tool calls and tool results needed to continue
6. Open issues, risks, and the next concrete steps

Preserve exact identifiers, paths, model names, error text, and numerical results when they matter. Do not invent missing facts, hidden reasoning, credentials, API keys, access tokens, or response IDs. Do not repeat full tool schemas. Use the conversation's language. Be compact without dropping task-critical state.`;
const thirdPartyCompactionCache = new Map();
const thirdPartyCompactionInFlight = new Map();
const thirdPartyCompactionCircuit = new Map();
const thirdPartyNativeCompactCircuit = new Map();

function bodyBytes(body) {
  return Buffer.byteLength(JSON.stringify(body || {}));
}

export function routeForRequest(settings, model) {
  const route = activeRoutes(settings).find((item) => item.id === model);
  if (!route) {
    const error = new Error(`Model is not configured: ${model || "(none)"}.`);
    error.statusCode = 404;
    error.code = "model_not_configured";
    throw error;
  }
  return route;
}

export function createChatHistory(initialEntries = [], onChange = null) {
  const entries = new Map();
  const routes = new Map();
  const routeInfos = new Map();
  const responseIdStates = new Map();
  const nativeStates = new Map();
  const requestTemplates = new Map();
  for (const item of Array.isArray(initialEntries) ? initialEntries.slice(-200) : []) {
    if (!item?.id || !Array.isArray(item.messages) || !item.routeId) continue;
    entries.set(String(item.id), conversationHistoryMessages(item.messages));
    routes.set(String(item.id), String(item.routeId));
    if (item.routeInfo && typeof item.routeInfo === "object") routeInfos.set(String(item.id), normalizeRouteInfo(item.routeInfo));
    const responseIdState = normalizeResponseIdState(item.responseIdState);
    if (responseIdState) responseIdStates.set(String(item.id), responseIdState);
    const nativeState = normalizeNativeContinuationState(item.nativeState);
    if (nativeState) nativeStates.set(String(item.id), nativeState);
    const requestTemplate = normalizeRequestTemplate(item.requestTemplate);
    if (requestTemplate) requestTemplates.set(String(item.id), requestTemplate);
  }

  function snapshot() {
    return [...entries.entries()].map(([id, messages]) => ({
      id,
      messages,
      routeId: routes.get(id) || "",
      routeInfo: routeInfos.get(id) || null,
      responseIdState: responseIdStates.get(id) || null,
      nativeState: nativeStates.get(id) || null,
      requestTemplate: requestTemplates.get(id) || null,
    }));
  }

  function changed() {
    if (typeof onChange === "function") onChange(snapshot());
  }

  return {
    get(responseId) { return entries.get(responseId) || []; },
    routeFor(responseId) { return routes.get(responseId) || null; },
    routeInfoFor(responseId) { return routeInfos.get(responseId) || null; },
    responseIdStateFor(responseId) { return responseIdStates.get(responseId) || null; },
    requestTemplateFor(responseId, currentRouteInfo = null) {
      const id = String(responseId || "");
      const current = normalizeRouteInfo(currentRouteInfo);
      const recorded = routeInfos.get(id) || null;
      if (!id || !current?.routeSignature || recorded?.routeSignature !== current.routeSignature) return null;
      const template = requestTemplates.get(id);
      return template ? structuredClone(template) : null;
    },
    rememberRequestTemplate(responseId, currentRouteInfo, value) {
      const id = String(responseId || "");
      const current = normalizeRouteInfo(currentRouteInfo);
      const recorded = routeInfos.get(id) || null;
      const template = normalizeRequestTemplate(value);
      if (!id || !entries.has(id) || !template || !current?.routeSignature || recorded?.routeSignature !== current.routeSignature) return false;
      requestTemplates.set(id, template);
      changed();
      return true;
    },
    responseIdCandidate(taskHash, currentRouteInfo = null) {
      const normalizedTaskHash = normalizedSha256(taskHash);
      const routeSignature = normalizedSha256(currentRouteInfo?.routeSignature);
      if (!normalizedTaskHash || !routeSignature) return null;
      const ids = [...entries.keys()].reverse();
      for (const id of ids) {
        const responseIdState = responseIdStates.get(id);
        const routeInfo = routeInfos.get(id) || null;
        if (responseIdState?.taskHash === normalizedTaskHash && routeInfo?.routeSignature === routeSignature) {
          return { id, routeInfo, responseIdState, nativeState: nativeStates.get(id) || null };
        }
      }
      return null;
    },
    blockNativeRoute(responseId, routeSignature) {
      const id = String(responseId || "");
      const signature = normalizedSha256(routeSignature);
      const nativeState = nativeStates.get(id);
      if (!id || !signature || !nativeState) return false;
      if (nativeState.blockedRouteSignatures.includes(signature)) return true;
      nativeStates.set(id, {
        ...nativeState,
        blockedRouteSignatures: [...nativeState.blockedRouteSignatures, signature].slice(-20),
      });
      changed();
      return true;
    },
    toolCallFor(callId, currentRouteInfo = null) {
      const target = String(callId || "").trim();
      if (!target) return null;
      let match = null;
      let fingerprint = "";
      for (const id of [...entries.keys()].reverse()) {
        const routeInfo = routeInfos.get(id) || null;
        if (currentRouteInfo?.stateDomain && routeInfo?.stateDomain !== currentRouteInfo.stateDomain) continue;
        const messages = entries.get(id) || [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (message?.role !== "assistant") continue;
          const call = (Array.isArray(message.tool_calls) ? message.tool_calls : []).find((item) => String(item?.id || "") === target);
          if (!call) continue;
          const candidate = { call: structuredClone(call), reasoningContent: String(message.reasoning_content || "") };
          const candidateFingerprint = stableCanonicalJson(candidate);
          if (match && candidateFingerprint !== fingerprint) return null;
          match = candidate;
          fingerprint = candidateFingerprint;
        }
      }
      return match;
    },
    record(responseId, messages, routeValue = "", metadata = {}) {
      const routeInfo = typeof routeValue === "object" ? normalizeRouteInfo(routeValue) : null;
      const routeId = routeInfo?.routeId || String(routeValue || "");
      entries.set(responseId, conversationHistoryMessages(messages));
      if (routeId) routes.set(responseId, routeId);
      if (routeInfo) routeInfos.set(responseId, routeInfo);
      const responseIdState = normalizeResponseIdState(metadata.responseIdState);
      if (responseIdState) responseIdStates.set(responseId, responseIdState);
      else responseIdStates.delete(responseId);
      const nativeState = normalizeNativeContinuationState(metadata.nativeState);
      if (nativeState) nativeStates.set(responseId, nativeState);
      const requestTemplate = normalizeRequestTemplate(metadata.requestTemplate);
      if (requestTemplate) requestTemplates.set(responseId, requestTemplate);
      else requestTemplates.delete(responseId);
      while (entries.size > 200) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
        routes.delete(oldest);
        routeInfos.delete(oldest);
        responseIdStates.delete(oldest);
        nativeStates.delete(oldest);
        requestTemplates.delete(oldest);
      }
      changed();
    },
    snapshot,
    clear() { entries.clear(); routes.clear(); routeInfos.clear(); responseIdStates.clear(); nativeStates.clear(); requestTemplates.clear(); changed(); },
  };
}

function normalizeRequestTemplate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized) > REQUEST_TEMPLATE_MAX_BYTES) return null;
    const normalized = JSON.parse(serialized);
    return normalized && typeof normalized === "object" && !Array.isArray(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

export function thirdPartyRequestTemplate(frame) {
  const template = { ...(frame || {}) };
  for (const field of ["type", "input", "previous_response_id", "generate", "client_metadata", "turn_metadata"]) delete template[field];
  return template;
}

function conversationHistoryMessages(messages) {
  return Array.isArray(messages) ? messages.filter((message) => message?.role !== "system") : [];
}

export async function forwardResponses({ settings, route, body, headers, signal, history, officialBaseUrl = OFFICIAL_CODEX_BASE_URL, thirdPartyCompactionFirstByteTimeoutMs = THIRD_PARTY_COMPACTION_FIRST_BYTE_TIMEOUT_MS }) {
  const contextMode = routingContextMode(settings, body, route, history);
  const thirdPartyKey = route.kind === "third_party" ? providerKey(route.providerId) : "";
  const expandedBody = expandRelayCompactions(body, route, thirdPartyKey);
  const normalizedBody = rehydrateCrossRouteRequest(expandedBody, route, history, settings);
  if (route.kind === "official") {
    const bearer = officialAccessToken();
    if (!bearer) throw httpError(401, "Official route requires a saved official Codex sign-in. Sign in and verify the official channel again.", "official_auth_missing");
    const accountId = officialAccountId();
    let upstreamBody = officialStoredBaselineBody(normalizedBody);
    let response = await fetchOfficialResponse(upstreamBody, route, headers, bearer, accountId, signal, officialBaseUrl);
    let diagnostics = requestDiagnostics(body, upstreamBody);
    const effectiveContextMode = !body?.previous_response_id
      ? "official_native_baseline"
      : contextMode;
    if (contextMode === "official_native_continuation" && await shouldReplayPreviousContext(response, upstreamBody)) {
      const fallbackBody = rehydrateCrossRouteRequest(body, route, history, settings, { forcePortableContext: true });
      if (fallbackBody !== body) {
        await response.body?.cancel();
        response = await fetchOfficialResponse(fallbackBody, route, headers, bearer, accountId, signal, officialBaseUrl);
        diagnostics = requestDiagnostics(body, fallbackBody, { attempts: 2, retryReason: "previous_response_rejected" });
        responseContextModes.set(response, "official_fallback_replayed");
        responseReasoningModes.set(response, reasoningMetadata(fallbackBody, route));
        responseRequestDiagnostics.set(response, diagnostics);
        return response;
      }
    }
    responseContextModes.set(response, effectiveContextMode);
    responseReasoningModes.set(response, reasoningMetadata(upstreamBody, route));
    responseRequestDiagnostics.set(response, diagnostics);
    return response;
  }

  const key = thirdPartyKey;
  if (!key) throw httpError(400, `No API key is saved for ${route.provider.name}.`, "provider_key_missing");
  if (route.provider.apiType === "responses") {
    const adapted = applyReasoningToResponsesPayload(stripUnsupported(normalizedBody, route.dropParams), route);
    let upstreamBody = { ...adapted.payload, model: route.upstreamModel };
    if (hasCompactionTrigger(upstreamBody)) {
      const response = await forwardThirdPartyCompatibleCompaction({ route, key, body: upstreamBody, requestedModel: body.model, signal, clientHeaders: headers, firstByteTimeoutMs: thirdPartyCompactionFirstByteTimeoutMs });
      responseContextModes.set(response, contextMode);
      responseReasoningModes.set(response, adapted.reasoning);
      return response;
    }
    if (route.provider.nativeResponseContinuation === true) upstreamBody.store = true;
    const currentInfo = routeHistoryInfo(route, key);
    const automaticContinuation = automaticNativeContinuation(route, key, upstreamBody, headers, history);
    if (automaticContinuation?.applied) upstreamBody = automaticContinuation.body;
    const previousInfo = automaticContinuation?.previousInfo || history?.routeInfoFor?.(body.previous_response_id);
    const sameProviderNative = Boolean(
      body.previous_response_id
      && sameResponsesStateDomain(previousInfo, currentInfo),
    );
    let response = await fetchThirdPartyResponses(route, key, upstreamBody, signal, headers);
    let diagnostics = requestDiagnostics(body, upstreamBody, {
      cacheTrace: thirdPartyResponsesCacheTrace(upstreamBody),
      nativeContinuation: continuationDiagnostics(route, body, history, automaticContinuation),
    });
    let effectiveContextMode = automaticContinuation?.applied ? "third_party_automatic_native" : contextMode;
    let sameProviderFallback = false;
    if ((sameProviderNative || automaticContinuation?.applied) && await shouldReplayPreviousContext(response, upstreamBody, Boolean(automaticContinuation?.applied))) {
      if (automaticContinuation?.applied) history?.blockNativeRoute?.(upstreamBody.previous_response_id, currentInfo.routeSignature);
      const portable = automaticContinuation?.fallbackBody || rehydrateCrossRouteRequest(expandedBody, route, history, settings, { forcePortableContext: true });
      if (!portable.previous_response_id && portable !== expandedBody) {
        await response.body?.cancel();
        const fallbackAdapted = applyReasoningToResponsesPayload(stripUnsupported(portable, route.dropParams), route);
        upstreamBody = { ...fallbackAdapted.payload, model: route.upstreamModel };
        response = await fetchThirdPartyResponses(route, key, upstreamBody, signal, headers);
        diagnostics = requestDiagnostics(body, upstreamBody, {
          attempts: 2,
          retryReason: automaticContinuation?.applied ? "automatic_previous_response_rejected" : "same_provider_previous_response_rejected",
          cacheTrace: thirdPartyResponsesCacheTrace(upstreamBody),
          nativeContinuation: continuationDiagnostics(route, body, history, automaticContinuation),
        });
        effectiveContextMode = automaticContinuation?.applied ? "third_party_automatic_fallback" : "third_party_same_provider_fallback";
        sameProviderFallback = true;
      }
    }
    if (!sameProviderFallback && await shouldRetryWithoutImageGeneration(response, upstreamBody)) {
      const reduced = removeToolByName(upstreamBody, "image_gen");
      if (reduced.removed) {
        await response.body?.cancel();
        upstreamBody = reduced.body;
        response = await fetchThirdPartyResponses(route, key, upstreamBody, signal, headers);
        diagnostics = requestDiagnostics(body, upstreamBody, {
          attempts: 2,
          retryReason: "image_generation_not_enabled",
          removedTools: ["image_gen"],
          cacheTrace: thirdPartyResponsesCacheTrace(upstreamBody),
        });
      }
    }
    responseContextModes.set(response, effectiveContextMode);
    responseReasoningModes.set(response, adapted.reasoning);
    responseRequestDiagnostics.set(response, diagnostics);
    if (route.provider.nativeResponseContinuation === true) {
      const blockedRouteSignatures = new Set(automaticContinuation?.blockedRouteSignatures || []);
      if (effectiveContextMode === "third_party_automatic_fallback") blockedRouteSignatures.add(currentInfo.routeSignature);
      responseHistoryMetadata.set(response, {
        blockedRouteSignatures: [...blockedRouteSignatures],
      });
    }
    return response;
  }
  let response = await forwardChatCompletions(route, normalizedBody, key, signal, history, settings.deepSeekSavings, headers);
  const diagnostics = responseDiagnostics(response);
  const reasoning = responseReasoningMode(response);
  if ((response instanceof Response ? response.ok : true) && hasCompactionTrigger(normalizedBody)) {
    response = await adaptThirdPartyCompactionResponse(response, body.model, route, normalizedBody);
  }
  if (response instanceof Response) {
    responseContextModes.set(response, contextMode);
    if (reasoning) responseReasoningModes.set(response, reasoning);
    responseRequestDiagnostics.set(response, { ...diagnostics, inboundBytes: bodyBytes(body) });
  }
  else if (response?.codex_relay) response.codex_relay.context_mode = contextMode;
  return response;
}

export async function forwardResponsesCompact({ settings = null, route, body, headers, signal, officialBaseUrl = OFFICIAL_CODEX_BASE_URL, compactCapabilityRecorder = null }) {
  if (route.kind === "official") {
    const bearer = officialAccessToken();
    if (!bearer) throw httpError(401, "Official route requires a saved official Codex sign-in. Sign in and verify the official channel again.", "official_auth_missing");
    const expandedBody = expandRelayCompactions(body, route, "");
    const upstreamBody = { ...expandedBody, model: route.upstreamModel };
    const response = await fetchOfficial(joinEndpoint(officialBaseUrl, "/responses/compact"), {
      method: "POST",
      headers: passthroughHeaders(headers, bearer, officialAccountId()),
      body: JSON.stringify(upstreamBody),
      signal,
    });
    responseRequestDiagnostics.set(response, requestDiagnostics(body, upstreamBody));
    return response;
  }

  const key = providerKey(route.providerId);
  if (!key) throw httpError(400, `No API key is saved for ${route.provider.name}.`, "provider_key_missing");
  const expandedBody = expandRelayCompactions(body, route, key);
  if (route.provider.apiType === "responses") {
    const upstreamBody = { ...stripUnsupported(expandedBody, route.dropParams), model: route.upstreamModel };
    const nativeCompact = thirdPartyNativeCompactPlan(settings, route, key);
    return forwardThirdPartyCompatibleCompaction({ route, key, body: upstreamBody, requestedModel: body.model, signal, nativeCompact, compactCapabilityRecorder, clientHeaders: headers });
  }

  // Chat-only providers have no native compact endpoint. Return a deterministic
  // portable transcript that Codex can keep as the next conversation input.
  const toolContext = buildChatToolContext(expandedBody.tools, expandedBody.input);
  const messages = responseInputToChatMessages(expandedBody.input, toolContext);
  const compacted = compactMessages(messages, route.contextWindow);
  const responseBody = {
    id: `cmp_${crypto.randomUUID()}`,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    model: body.model,
    output: messagesToResponsesInput(compacted, undefined, route.contextWindow),
  };
  const response = new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  responseRequestDiagnostics.set(response, requestDiagnostics(body, responseBody));
  return response;
}

export function isEventStreamResponse(response) {
  return response instanceof Response && /text\/event-stream/i.test(response.headers.get("content-type") || "");
}

export function responseManagesHistory(response) {
  return historyManagedResponses.has(response);
}

export function responseContextMode(response) {
  return responseContextModes.get(response) || "";
}

export function responseReasoningMode(response) {
  return responseReasoningModes.get(response) || response?.codex_relay?.reasoning || null;
}

export function responseDiagnostics(response) {
  return responseRequestDiagnostics.get(response) || response?.codex_relay?.diagnostics || { attempts: 1, retryReason: null, removedTools: [] };
}

export function routingContextMode(settings, body, route, history) {
  if (!body?.previous_response_id) return "new";
  const previousRouteId = history?.routeFor?.(body.previous_response_id);
  if (!previousRouteId) return "unknown";
  const previousRoute = activeRoutes(settings).find((item) => item.id === previousRouteId);
  if (!previousRoute) return "unknown";
  if (previousRoute.kind === "official" && route.kind === "official") return "official_native_continuation";
  const previousInfo = history?.routeInfoFor?.(body.previous_response_id);
  const currentInfo = route.kind === "third_party" ? routeHistoryInfo(route, providerKey(route.providerId)) : null;
  if (route.kind === "third_party" && route.provider?.apiType === "responses" && history?.responseIdStateFor?.(body.previous_response_id)?.storage === "not_stored") {
    return "third_party_portable_unstored";
  }
  if (sameResponsesStateDomain(previousInfo, currentInfo)) {
    return previousInfo.routeSignature === currentInfo.routeSignature ? "third_party_native_continuation" : "third_party_same_provider_native";
  }
  if (previousRoute.id === route.id && route.provider?.apiType !== "responses") return "third_party_continued";
  return "portable_context";
}

export function recordPassthroughResponse(history, requestBody, route, rawBody, requestHeaders = {}, metadata = {}) {
  if (!history?.record) return;
  const response = responseObjectFromRaw(rawBody);
  if (!response?.id) return;
  const sourceMessages = responseToChat(requestBody, route, history);
  const assistant = assistantMessageFromResponse(response);
  const responseIdState = responseIdStateForRecord(requestBody, requestHeaders, route, response);
  const nativeState = nativeContinuationStateForRecord(requestBody, requestHeaders, route, metadata, response, responseIdState);
  const routeIdentity = route.kind === "third_party" ? providerKey(route.providerId) : officialAccountId() || officialAccessToken();
  history.record(response.id, [...sourceMessages, assistant], routeHistoryInfo(route, routeIdentity), {
    responseIdState,
    nativeState,
    requestTemplate: route.kind === "third_party" ? thirdPartyRequestTemplate(requestBody) : null,
  });
}

export function forwardOfficialImageGeneration({ body, headers, signal, officialBaseUrl = OFFICIAL_CODEX_BASE_URL }) {
  const bearer = officialAccessToken();
  if (!bearer) throw httpError(401, "Official image generation requires a saved official Codex sign-in. Sign in and verify the official channel again.", "official_auth_missing");
  return fetchOfficial(joinEndpoint(officialBaseUrl, "/images/generations"), {
    method: "POST",
    headers: passthroughHeaders(headers, bearer, officialAccountId(), "application/json"),
    body: JSON.stringify(body || {}),
    signal,
  });
}

export function responseHistoryInfo(response) { return responseHistoryMetadata.get(response) || null; }

export function currentRouteHistoryInfo(route) {
  const identity = route?.kind === "third_party" ? providerKey(route.providerId) : officialAccountId() || officialAccessToken();
  return routeHistoryInfo(route, identity);
}

async function forwardChatCompletions(route, body, key, signal, history, savingsPreference = {}, clientHeaders = {}) {
  const toolContext = buildChatToolContext(body.tools, body.input);
  const historyMessages = responseToChat(body, route, history, toolContext);
  const payload = {
    model: route.upstreamModel,
    stream: Boolean(body.stream),
    messages: historyMessages,
    tools: toolContext.chatTools,
    tool_choice: chatToolChoice(body.tool_choice, toolContext),
  };
  copyChatRequestOptions(payload, body, route);
  if (!payload.tools.length) {
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.parallel_tool_calls;
  }
  const reasoning = applyReasoningToChatPayload(payload, body, route);
  const savings = deepSeekSavingsMessages(historyMessages, payload.tools || [], route.contextWindow, reasoning, savingsPreference);
  const sourceMessages = savings.messages;
  payload.messages = sourceMessages;
  if (payload.stream) payload.stream_options = { ...(payload.stream_options && typeof payload.stream_options === "object" ? payload.stream_options : {}), include_usage: true };
  const cachePrefix = chatCachePrefixDiagnostics(route, body, sourceMessages, payload.tools || [], reasoning);
  const diagnostics = requestDiagnostics(body, payload, {
    ...(cachePrefix.diagnostics ? { cache: cachePrefix.diagnostics } : {}),
    ...(savings.diagnostics ? { savings: savings.diagnostics } : {}),
  });
  const upstream = await fetchProvider(route.provider, providerEndpoint(route.provider, "/chat/completions"), {
    method: "POST",
    headers: thirdPartyHeaders(route.provider, key, Boolean(body.stream), clientHeaders),
    body: JSON.stringify(payload),
    signal,
  });
  if (!upstream.ok) {
    responseReasoningModes.set(upstream, reasoning);
    responseRequestDiagnostics.set(upstream, diagnostics);
    return upstream;
  }
  if (body.stream && isEventStreamResponse(upstream)) {
    const response = streamChatCompletions(upstream, body.model, route, sourceMessages, historyMessages, history, toolContext, cachePrefix.state, thirdPartyRequestTemplate(body));
    responseReasoningModes.set(response, reasoning);
    responseRequestDiagnostics.set(response, diagnostics);
    return response;
  }
  if (body.stream) {
    const rawSse = await upstream.text();
    const response = responseFromChatStream(rawSse, body.model, route, sourceMessages, toolContext);
    rememberChatCachePrefix(response.id, cachePrefix.state);
    history?.record(response.id, [...historyMessages, response.__assistantMessage], routeHistoryInfo(route, key), { requestTemplate: thirdPartyRequestTemplate(body) });
    delete response.__assistantMessage;
    const converted = new Response(responseToSse(response), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
    responseReasoningModes.set(converted, reasoning);
    responseRequestDiagnostics.set(converted, diagnostics);
    return converted;
  }
  const chat = await upstream.json();
  const response = responseFromChat(chat, body.model, route, sourceMessages, toolContext);
  rememberChatCachePrefix(response.id, cachePrefix.state);
  history?.record(response.id, [...historyMessages, response.__assistantMessage], routeHistoryInfo(route, key), { requestTemplate: thirdPartyRequestTemplate(body) });
  delete response.__assistantMessage;
  response.codex_relay = { ...(response.codex_relay || {}), reasoning, diagnostics };
  return response;
}

function streamChatCompletions(upstream, requestedModel, route, sourceMessages, historyMessages, history, toolContext, cachePrefixState = null, requestTemplate = null) {
  const responseId = `relay_${crypto.randomUUID()}`;
  const messageId = `msg_${crypto.randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const initialResponse = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model: requestedModel,
    output: [],
    output_text: "",
  };
  let upstreamReader = null;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoning = "";
      let usage;
      let finishReason = null;
      let validEvents = 0;
      let malformedEvents = 0;
      let messageStarted = false;
      let contentMode = "pending";
      let pendingContent = "";
      const toolCalls = new Map();
      const emit = (event) => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      const beginMessage = () => {
        if (messageStarted) return;
        messageStarted = true;
        emit({
          type: "response.output_item.added",
          output_index: 0,
          item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [{ type: "output_text", text: "", annotations: [] }] },
        });
      };
      const appendVisibleContent = (value) => {
        if (!value) return;
        beginMessage();
        content += value;
        emit({ type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: value });
      };
      const consumeContent = (value, flush = false) => {
        const piece = chatContentText(value);
        if (contentMode === "visible") {
          appendVisibleContent(piece);
          return;
        }
        pendingContent += piece;
        if (contentMode === "pending") {
          const trimmed = pendingContent.replace(/^\s+/, "");
          const opening = trimmed.match(/^<think>/i);
          if (opening) {
            contentMode = "thinking";
            pendingContent = trimmed.slice(opening[0].length);
          } else if (!/^<think>/i.test(trimmed) && !"<think>".startsWith(trimmed.toLowerCase()) && (trimmed || flush)) {
            contentMode = "visible";
            const visible = pendingContent;
            pendingContent = "";
            appendVisibleContent(visible);
            return;
          }
        }
        if (contentMode === "thinking") {
          const closingIndex = pendingContent.toLowerCase().indexOf("</think>");
          if (closingIndex >= 0) {
            reasoning = joinReasoningText(reasoning, pendingContent.slice(0, closingIndex));
            const visible = pendingContent.slice(closingIndex + "</think>".length).replace(/^\s+/, "");
            pendingContent = "";
            contentMode = "visible";
            appendVisibleContent(visible);
          } else if (flush) {
            reasoning = joinReasoningText(reasoning, pendingContent);
            pendingContent = "";
          }
        }
      };
      const consumeEvent = (data) => {
        if (!data || data === "[DONE]") return;
        try {
          const event = JSON.parse(data);
          const choice = event?.choices?.[0];
          const delta = choice?.delta || choice?.message || null;
          if (!delta && !event?.usage) return;
          validEvents += 1;
          if (delta) {
            reasoning += extractChatReasoningDelta(delta);
            consumeContent(delta.content);
          }
          for (const part of delta?.tool_calls || []) {
            const index = Number.isInteger(part.index) ? part.index : toolCalls.size;
            const current = toolCalls.get(index) || { id: part.id || `call_${crypto.randomUUID()}`, type: "function", function: { name: "", arguments: "" } };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.function.name += part.function.name;
            if (part.function?.arguments) current.function.arguments += part.function.arguments;
            toolCalls.set(index, current);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (event?.usage) usage = event.usage;
        } catch { malformedEvents += 1; }
      };
      const consumeFrames = (flush = false) => {
        const frames = buffer.split(/\r?\n\r?\n/);
        const remainder = frames.pop() || "";
        buffer = flush ? "" : remainder;
        if (flush && remainder.trim()) frames.push(remainder);
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).filter((line) => /^data:/i.test(line)).map((line) => line.replace(/^data:\s?/i, "")).join("\n");
          const trimmed = frame.trim();
          consumeEvent(data || (/^[\[{]/.test(trimmed) ? trimmed : ""));
        }
      };

      try {
        emit({ type: "response.created", response: initialResponse });
        upstreamReader = upstream.body?.getReader();
        if (!upstreamReader) throw new Error("Provider did not return a response stream.");
        while (true) {
          const { done, value } = await upstreamReader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          consumeFrames();
        }
        buffer += decoder.decode();
        consumeFrames(true);
        consumeContent("", true);
        if (!validEvents) throw httpError(502, "The Chat Completions provider returned an unreadable JSON/SSE response.", "upstream_stream_invalid");

        const response = responseFromAssistant({
          content,
          reasoning,
          toolCalls: [...toolCalls.values()],
          usage,
          finishReason,
        }, requestedModel, route, sourceMessages, { responseId, messageId, createdAt, reasoningAfterMessage: messageStarted }, toolContext);
        const assistantMessage = response.__assistantMessage;
        delete response.__assistantMessage;
        const message = response.output.find((item) => item.type === "message");
        if (messageStarted && message) emit({ type: "response.output_item.done", output_index: 0, item: message });
        for (let index = message ? 1 : 0; index < response.output.length; index += 1) {
          const item = response.output[index];
          if (item.type === "message") continue;
          emit({ type: "response.output_item.added", output_index: index, item });
          if (item.type === "reasoning") {
            const summary = item.summary?.map((part) => part?.text || "").filter(Boolean).join("\n") || "";
            if (summary) emit({ type: "response.reasoning_summary_text.delta", item_id: item.id, output_index: index, summary_index: 0, delta: summary });
            if (summary) emit({ type: "response.reasoning_summary_text.done", item_id: item.id, output_index: index, summary_index: 0, text: summary });
          }
          emit({ type: "response.output_item.done", output_index: index, item });
        }
        emit({ type: "response.completed", response });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        history?.record(response.id, [...historyMessages, assistantMessage], routeHistoryInfo(route, providerKey(route.providerId)), { requestTemplate });
        controller.close();
      } catch (error) {
        emit({ type: "error", error: { message: error.message || "Provider stream failed.", code: error.code || "upstream_stream_error" } });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
    async cancel(reason) {
      try { await upstreamReader?.cancel(reason); }
      catch { /* The upstream may already be closed by the request abort signal. */ }
    },
  });
  rememberChatCachePrefix(responseId, cachePrefixState);
  const response = new Response(stream, { status: upstream.status, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  historyManagedResponses.add(response);
  return response;
}

function responseToChat(body, route, history, toolContext = buildChatToolContext(body?.tools, body?.input)) {
  const prior = body.previous_response_id ? history?.get(body.previous_response_id) || [] : [];
  const retained = retainPortableMessages(prior, route.contextWindow);
  const continuityNotice = retained.trimmed
    ? [{ role: "system", content: "Earlier conversation turns were omitted to fit the target model context window. Continue the current task from the retained conversation and workspace." }]
    : [];
  const instructions = typeof body.instructions === "string" && body.instructions.trim()
    ? [{ role: "system", content: body.instructions.trim() }]
    : [];
  const current = responseInputToChatMessages(body.input, toolContext);
  const currentSystem = current.filter((message) => message.role === "system");
  const currentConversation = current.filter((message) => message.role !== "system");
  const routeInfo = route?.kind === "third_party" ? routeHistoryInfo(route, providerKey(route.providerId)) : null;
  return normalizeChatToolMessages(
    [...instructions, ...currentSystem, ...continuityNotice, ...retained.messages, ...currentConversation],
    (callId) => history?.toolCallFor?.(callId, routeInfo),
  );
}

// Codex may compact a conversation between a tool call and its output. Chat
// Completions rejects a standalone `tool` role, so preserve the output as a
// normal continuation when the matching function call is no longer present.
function normalizeChatToolMessages(messages, restoreToolCall = null) {
  const pendingCalls = new Set();
  const normalized = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (call?.id) pendingCalls.add(call.id);
      }
      normalized.push(message);
      continue;
    }
    if (message.role === "tool") {
      if (message.tool_call_id && pendingCalls.has(message.tool_call_id)) {
        pendingCalls.delete(message.tool_call_id);
        normalized.push(message);
      } else {
        const restored = typeof restoreToolCall === "function" ? restoreToolCall(message.tool_call_id) : null;
        if (restored?.call) {
          normalized.push({
            role: "assistant",
            content: null,
            tool_calls: [restored.call],
            ...(restored.reasoningContent ? { reasoning_content: restored.reasoningContent } : {}),
          });
          normalized.push(message);
        } else {
          normalized.push({
            role: "user",
            content: `Codex tool output from an earlier compacted step:\n${message.content || ""}`,
          });
        }
      }
      continue;
    }
    normalized.push(message);
  }
  return normalized;
}

function rehydrateCrossRouteRequest(body, route, history, settings, options = {}) {
  const previous = body?.previous_response_id;
  const responsesRoute = route?.provider?.apiType === "responses";
  if (!previous) return body;
  if (!history?.routeFor) return responsesRoute ? { ...body, previous_response_id: undefined } : body;
  const previousRoute = history.routeFor(previous);
  if (!previousRoute) return responsesRoute ? { ...body, previous_response_id: undefined } : body;
  const previousDefinition = activeRoutes(settings).find((item) => item.id === previousRoute);
  if (!options.forcePortableContext && previousDefinition?.kind === "official" && route.kind === "official") return body;
  const previousInfo = history.routeInfoFor?.(previous);
  if (responsesRoute && (!normalizedSha256(previousInfo?.stateDomain) || !normalizedSha256(previousInfo?.routeSignature))) return { ...body, previous_response_id: undefined };
  const currentInfo = route.kind === "third_party" ? routeHistoryInfo(route, providerKey(route.providerId)) : null;
  const explicitlyUnstored = route.kind === "third_party"
    && history?.responseIdStateFor?.(previous)?.storage === "not_stored";
  if (!options.forcePortableContext && explicitlyUnstored) {
    const messages = history.get(previous);
    if (messages.length) {
      return {
        ...body,
        previous_response_id: undefined,
        input: messagesToResponsesInput(messages, body.input, route.contextWindow),
      };
    }
  }
  if (!options.forcePortableContext && sameResponsesStateDomain(previousInfo, currentInfo)) return body;
  if (!options.forcePortableContext && previousRoute === route.id && route.provider?.apiType !== "responses") return body;
  const messages = history.get(previous);
  if (!messages.length) return body;
  return {
    ...body,
    previous_response_id: undefined,
    input: messagesToResponsesInput(messages, body.input, route.contextWindow),
  };
}

function fetchOfficialResponse(body, route, headers, bearer, accountId, signal, officialBaseUrl) {
  return fetchOfficial(joinEndpoint(officialBaseUrl, "/responses"), {
    method: "POST",
    headers: passthroughHeaders(headers, bearer, accountId),
    body: JSON.stringify({ ...body, model: route.upstreamModel }),
    signal,
  });
}

function messagesToResponsesInput(messages, latestInput, contextWindow) {
  const { messages: retained, trimmed } = retainPortableMessages(messages, contextWindow);
  const result = [];
  if (trimmed) {
    result.push({
      role: "developer",
      content: [{ type: "input_text", text: "Earlier conversation turns were omitted to fit the target model context window. Continue the current task using the retained transcript and workspace; do not assume omitted work is complete." }],
    });
  }
  for (const message of retained) {
    if (message.role === "tool") {
      result.push({ type: "function_call_output", call_id: message.tool_call_id || "relay_prior_tool", output: message.content || "" });
      continue;
    }
    if (message.content) {
      const role = message.role === "system" ? "developer" : message.role || "user";
      result.push({
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text: message.content }],
      });
    }
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      result.push({
        type: "function_call",
        call_id: call.id || `call_${crypto.randomUUID()}`,
        name: call.function?.name || "unknown",
        arguments: call.function?.arguments || "{}",
        status: "completed",
      });
    }
  }
  if (latestInput !== undefined && latestInput !== null) {
    if (typeof latestInput === "string") result.push({ role: "user", content: [{ type: "input_text", text: latestInput }] });
    else if (Array.isArray(latestInput)) result.push(...latestInput);
  }
  return result;
}

function retainPortableMessages(messages, contextWindow) {
  const budget = Math.max(8_000, Math.floor((Number(contextWindow) || 128_000) * 0.72));
  const pinned = messages.filter((message) => message.role === "system");
  const regular = messages.filter((message) => message.role !== "system");
  let used = pinned.reduce((total, message) => total + estimateMessageTokens(message), 0);
  const retained = [];
  let trimmed = false;
  for (let index = regular.length - 1; index >= 0; index -= 1) {
    const message = regular[index];
    const cost = estimateMessageTokens(message);
    if (used + cost > budget && retained.length) {
      trimmed = true;
      break;
    }
    retained.unshift(message);
    used += cost;
  }
  if (retained.length < regular.length) trimmed = true;
  return { messages: [...pinned, ...retained], trimmed };
}

function compactMessages(messages, contextWindow) {
  const retained = retainPortableMessages(messages, Math.max(8_000, Math.floor((Number(contextWindow) || 128_000) * 0.5)));
  if (!retained.trimmed) return retained.messages;
  return [
    { role: "system", content: "Earlier turns were compacted by Codex Relay. Continue from the retained recent transcript and current workspace state." },
    ...retained.messages,
  ];
}

function estimateMessageTokens(message) {
  const toolText = Array.isArray(message.tool_calls) ? JSON.stringify(message.tool_calls) : "";
  return Math.max(1, Math.ceil(`${message.content || ""}${toolText}`.length / 3));
}

function deepSeekSavingsMessages(messages, tools, contextWindow, reasoning, preference) {
  if (reasoning?.preset !== "deepseek" || !preference?.enabled) return { messages, diagnostics: null };
  const windowTokens = Math.max(8_000, Number(contextWindow) || 128_000);
  const toolTokens = Math.ceil(JSON.stringify(tools || []).length / 3);
  const messageTokens = messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  const before = messageTokens + toolTokens;
  const ratio = before / windowTokens;
  const toolIndexes = messages.map((message, index) => message?.role === "tool" ? index : -1).filter((index) => index >= 0);
  const protectedIndexes = new Set(toolIndexes.slice(-DEEPSEEK_RECENT_TOOL_OUTPUTS));
  if (ratio < DEEPSEEK_SAVINGS_START_RATIO) {
    return { messages, diagnostics: deepSeekSavingsDiagnostics(false, "below_threshold", before, before, 0, protectedIndexes.size) };
  }

  const high = ratio >= DEEPSEEK_SAVINGS_HIGH_RATIO;
  const edgeChars = high ? 700 : 1_200;
  let prunedToolOutputs = 0;
  const optimized = messages.map((message, index) => {
    if (message?.role !== "tool" || protectedIndexes.has(index)) return message;
    const content = String(message.content || "");
    if (content.length < DEEPSEEK_LARGE_TOOL_OUTPUT_CHARS || importantToolOutput(content)) return message;
    prunedToolOutputs += 1;
    return { ...message, content: shortenedToolOutput(content, edgeChars) };
  });
  const after = optimized.reduce((total, message) => total + estimateMessageTokens(message), toolTokens);
  const level = prunedToolOutputs ? (high ? "high" : "moderate") : "no_safe_candidates";
  return {
    messages: prunedToolOutputs ? optimized : messages,
    diagnostics: deepSeekSavingsDiagnostics(prunedToolOutputs > 0, level, before, after, prunedToolOutputs, protectedIndexes.size),
  };
}

function deepSeekSavingsDiagnostics(applied, level, before, after, prunedToolOutputs, protectedRecentToolOutputs) {
  return {
    enabled: true,
    applied,
    level,
    estimatedInputTokensBefore: before,
    estimatedInputTokensAfter: after,
    estimatedTokensSaved: Math.max(0, before - after),
    prunedToolOutputs,
    protectedRecentToolOutputs,
  };
}

function importantToolOutput(content) {
  return /(?:^|\b)(?:error|failed|failure|exception|traceback|permission denied|timed? out|not found|stderr)(?:\b|:)/i.test(content);
}

function shortenedToolOutput(content, edgeChars) {
  const omitted = Math.max(0, content.length - edgeChars * 2);
  return `${content.slice(0, edgeChars)}\n\n[Codex Relay DeepSeek savings: omitted ${omitted} characters from an older successful tool output; the full result remains in the local encrypted context.]\n\n${content.slice(-edgeChars)}`;
}

function responseFromChat(chat, requestedModel, route, sourceMessages, toolContext) {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  return responseFromAssistant({
    content: message.content || "",
    reasoning: extractChatReasoningText(message),
    toolCalls: message.tool_calls || [],
    usage: chat?.usage,
    finishReason: choice.finish_reason,
  }, requestedModel, route, sourceMessages, {}, toolContext);
}

function responseFromChatStream(rawSse, requestedModel, route, sourceMessages, toolContext) {
  const state = collectChatCompletionStream(rawSse);
  return responseFromAssistant({
    content: state.content,
    reasoning: state.reasoning,
    toolCalls: [...state.toolCalls.values()],
    usage: state.usage,
    finishReason: state.finishReason,
  }, requestedModel, route, sourceMessages, {}, toolContext);
}

function responseFromAssistant({ content, reasoning, toolCalls, usage, finishReason }, requestedModel, route, sourceMessages, identity = {}, toolContext = buildChatToolContext()) {
  const normalized = normalizeAssistantText(content, reasoning);
  const text = normalized.text;
  const reasoningText = normalized.reasoning;
  const inputTokens = Number(usage?.prompt_tokens) || 0;
  const outputTokens = Number(usage?.completion_tokens) || 0;
  const id = identity.responseId || `relay_${crypto.randomUUID()}`;
  const messageItem = text ? { id: identity.messageId || `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } : null;
  const reasoningItem = reasoningText ? { id: identity.reasoningId || `rs_${crypto.randomUUID()}`, type: "reasoning", summary: [{ type: "summary_text", text: reasoningText }] } : null;
  const output = identity.reasoningAfterMessage
    ? [messageItem, reasoningItem].filter(Boolean)
    : [reasoningItem, messageItem].filter(Boolean);
  for (const call of toolCalls || []) {
    const item = responseToolCallFromChat(call, toolContext);
    if (reasoningText) item.reasoning_content = reasoningText;
    output.push(item);
  }
  const assistantMessage = { role: "assistant", content: text || null };
  if (reasoningText) assistantMessage.reasoning_content = reasoningText;
  if (toolCalls?.length) assistantMessage.tool_calls = toolCalls;
  const cacheUsage = chatCacheUsage(usage, inputTokens);
  const cachedTokens = cacheUsage.hitTokens;
  const reasoningTokens = Number(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens) || 0;
  const incomplete = finishReason === "length";
  return {
    id,
    object: "response",
    created_at: identity.createdAt || Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    model: requestedModel,
    output,
    output_text: text,
    ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: Number(usage?.total_tokens) || inputTokens + outputTokens,
      input_tokens_details: { cached_tokens: cachedTokens },
      output_tokens_details: { reasoning_tokens: reasoningTokens },
    },
    codex_relay: {
      provider: route.provider.name,
      upstream_model: route.upstreamModel,
      diagnostics: { attempts: 1, retryReason: null, removedTools: [] },
      ...(cacheUsage.deepSeekReported ? { cache_usage: { cache_reported: true, prompt_cache_hit_tokens: cacheUsage.hitTokens, prompt_cache_miss_tokens: cacheUsage.missTokens } } : {}),
    },
    __assistantMessage: assistantMessage,
  };
}

function collectChatCompletionStream(rawSse) {
  const state = { content: "", reasoning: "", usage: null, finishReason: null, toolCalls: new Map(), validEvents: 0, malformedEvents: 0 };
  const raw = String(rawSse || "");
  for (const data of completeSseDataFrames(raw)) {
    if (!data || data === "[DONE]") continue;
    try {
      consumeChatCompletionEvent(state, JSON.parse(data));
    } catch {
      state.malformedEvents += 1;
    }
  }
  if (!state.validEvents && raw.trim()) {
    try { consumeChatCompletionEvent(state, JSON.parse(raw)); }
    catch { /* The controlled error below replaces malformed provider output. */ }
  }
  if (!state.validEvents && raw.trim()) throw httpError(502, "The Chat Completions provider returned an unreadable JSON/SSE response.", "upstream_stream_invalid");
  return state;
}

function completeSseDataFrames(raw) {
  const frames = String(raw || "").split(/\r?\n\r?\n/);
  const result = [];
  for (const frame of frames) {
    const trimmed = frame.trim();
    if (!trimmed) continue;
    const dataLines = frame.split(/\r?\n/).filter((line) => /^data:/i.test(line)).map((line) => line.replace(/^data:\s?/i, ""));
    if (dataLines.length) result.push(dataLines.join("\n").trim());
    else if (/^[\[{]/.test(trimmed)) result.push(trimmed);
  }
  return result;
}

function consumeChatCompletionEvent(state, event) {
  const choice = event?.choices?.[0];
  const delta = choice?.delta || choice?.message || null;
  if (!delta && !event?.usage) return;
  state.validEvents += 1;
  if (delta) {
    state.content += chatContentText(delta.content);
    state.reasoning += extractChatReasoningDelta(delta);
    for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = Number.isInteger(part.index) ? `index:${part.index}` : part.id ? `id:${part.id}` : state.toolCalls.size === 1 ? [...state.toolCalls.keys()][0] : `index:${state.toolCalls.size}`;
      const current = state.toolCalls.get(key) || { id: part.id || `call_${crypto.randomUUID()}`, type: "function", function: { name: "", arguments: "" } };
      if (part.id) current.id = part.id;
      if (part.function?.name) current.function.name += part.function.name;
      if (part.function?.arguments) current.function.arguments += part.function.arguments;
      state.toolCalls.set(key, current);
    }
  }
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  if (event?.usage) state.usage = event.usage;
}

function normalizeAssistantText(content, reasoning) {
  const raw = chatContentText(content);
  const think = splitLeadingThinkBlock(raw);
  return {
    text: think ? think.answer : raw,
    reasoning: joinReasoningText(reasoning, think?.reasoning),
  };
}

function extractChatReasoningText(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["reasoning_content", "reasoning"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      for (const nested of ["content", "text", "summary"]) {
        if (typeof candidate[nested] === "string" && candidate[nested].trim()) return candidate[nested].trim();
      }
    }
  }
  const details = value.reasoning_details;
  if (typeof details === "string" && details.trim()) return details.trim();
  if (Array.isArray(details)) return details.map((item) => item?.text || item?.content || item?.summary || (typeof item === "string" ? item : "")).filter(Boolean).join("\n\n").trim();
  return "";
}

function extractChatReasoningDelta(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["reasoning_content", "reasoning"]) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      for (const nested of ["content", "text", "summary"]) if (typeof candidate[nested] === "string") return candidate[nested];
    }
  }
  return "";
}

function chatContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text || part?.content || (typeof part === "string" ? part : "")).filter(Boolean).join("");
}

function splitLeadingThinkBlock(text) {
  const match = String(text || "").match(/^\s*<think>([\s\S]*?)<\/think>\s*/i);
  if (!match) return null;
  return { reasoning: match[1].trim(), answer: String(text).slice(match[0].length).replace(/^\s+/, "") };
}

function joinReasoningText(...values) {
  return values.map((value) => String(value || "").trim()).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join("\n\n");
}

function chatCacheUsage(usage, inputTokens) {
  const has = (target, key) => Boolean(target && Object.prototype.hasOwnProperty.call(target, key));
  const deepSeekReported = has(usage, "prompt_cache_hit_tokens") || has(usage, "prompt_cache_miss_tokens");
  const nested = usage?.prompt_tokens_details || usage?.input_tokens_details;
  const hitTokens = nonNegativeToken(usage?.prompt_cache_hit_tokens ?? nested?.cached_tokens) ?? 0;
  const missTokens = nonNegativeToken(usage?.prompt_cache_miss_tokens) ?? Math.max(0, inputTokens - hitTokens);
  return { deepSeekReported, hitTokens, missTokens };
}

function nonNegativeToken(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function responseObjectFromRaw(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed?.object === "response" || parsed?.id && parsed?.output) return parsed;
  } catch { /* Fall through to streamed events. */ }
  let latest = null;
  for (const line of String(rawBody || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event?.response?.id && (event.type === "response.completed" || event.response.output)) latest = event.response;
    } catch { /* Ignore non-JSON SSE lines. */ }
  }
  return latest;
}

function assistantMessageFromResponse(response) {
  const text = [];
  const toolCalls = [];
  for (const item of response.output || []) {
    if (item?.type === "message") {
      for (const part of item.content || []) {
        if (part?.text || part?.output_text) text.push(part.text || part.output_text);
      }
    }
    if (item?.type === "function_call") {
      const name = item.namespace && !String(item.name || "").startsWith(item.namespace) ? `${item.namespace}${String(item.namespace).endsWith("__") ? "" : "__"}${item.name || "unknown"}` : item.name || "unknown";
      toolCalls.push({ id: item.call_id || item.id, type: "function", function: { name, arguments: item.arguments || "{}" } });
    }
    if (item?.type === "compaction") {
      const portable = decodeRelayCompaction(item.encrypted_content);
      if (portable?.summary) text.push(`Codex Relay compacted context:\n${portable.summary}`);
    }
  }
  const message = { role: "assistant", content: text.join("\n") || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

async function forwardThirdPartyCompatibleCompaction({ route, key, body, requestedModel, signal, nativeCompact = null, compactCapabilityRecorder = null, clientHeaders = {}, firstByteTimeoutMs = THIRD_PARTY_COMPACTION_FIRST_BYTE_TIMEOUT_MS }) {
  pruneThirdPartyCompactionState();
  const routeIdentity = nativeCompact?.target?.routeSignature || "";
  const fingerprint = thirdPartyCompactionFingerprint(route, body, routeIdentity);
  const routeKey = routeIdentity || `${route.providerId}:${route.upstreamModel}`;
  const cached = thirdPartyCompactionCache.get(fingerprint);
  if (cached?.expiresAt > Date.now()) {
    return responseFromCompactionSnapshot(cached.snapshot, body, {
      cacheHit: true,
      deduplicated: true,
      upstreamAttempts: 0,
      bytesAvoided: cached.snapshot.diagnostics.upstreamBytes || bodyBytes(body),
    });
  }

  const circuit = thirdPartyCompactionCircuit.get(routeKey);
  if (circuit?.expiresAt > Date.now()) {
    const snapshot = localCompactionSnapshot({ route, body, requestedModel, fingerprint, reason: circuit.reason || "upstream_compaction_failed", circuitOpen: true });
    rememberCompactionSnapshot(fingerprint, snapshot);
    return responseFromCompactionSnapshot(snapshot, body, {
      cacheHit: false,
      deduplicated: true,
      upstreamAttempts: 0,
      bytesAvoided: bodyBytes(body),
    });
  }

  let pending = thirdPartyCompactionInFlight.get(fingerprint);
  const joined = Boolean(pending);
  if (!pending) {
    pending = performThirdPartyCompatibleCompaction({ route, key, body, requestedModel, signal, fingerprint, routeKey, nativeCompact, compactCapabilityRecorder, clientHeaders, firstByteTimeoutMs })
      .then((snapshot) => {
        rememberCompactionSnapshot(fingerprint, snapshot);
        return snapshot;
      })
      .finally(() => thirdPartyCompactionInFlight.delete(fingerprint));
    thirdPartyCompactionInFlight.set(fingerprint, pending);
  }
  const snapshot = await waitForCompactionSnapshot(pending, signal);
  return responseFromCompactionSnapshot(snapshot, body, {
    cacheHit: false,
    deduplicated: joined,
    upstreamAttempts: joined ? 0 : snapshot.diagnostics.upstreamAttempts,
    bytesAvoided: joined ? snapshot.diagnostics.upstreamBytes || bodyBytes(body) : 0,
  });
}

async function performThirdPartyCompatibleCompaction({ route, key, body, requestedModel, signal, fingerprint, routeKey, nativeCompact, compactCapabilityRecorder, clientHeaders, firstByteTimeoutMs }) {
  let nativeResult = null;
  if (nativeCompact?.attempt) {
    nativeResult = await performThirdPartyNativeCompaction({ route, key, body, requestedModel, signal, fingerprint, nativeCompact, clientHeaders });
    rememberNativeCompactClassification(compactCapabilityRecorder, nativeCompact.target, nativeResult.classification);
    if (nativeResult.snapshot) return nativeResult.snapshot;
    if (nativeResult.classification.outcome === "authentication_failure") {
      openThirdPartyNativeCompactCircuit(nativeCompact.target.routeSignature, nativeResult.classification.reason, THIRD_PARTY_NATIVE_AUTH_CIRCUIT_TTL_MS);
    }
  }
  const priorAttempts = nativeResult?.attempted ? 1 : 0;
  const nativeDiagnostics = nativeResult ? {
    attempted: true,
    capabilityBefore: nativeCompact.capability.status,
    outcome: nativeResult.classification.outcome,
    reason: nativeResult.classification.reason,
  } : {
    attempted: false,
    capabilityBefore: nativeCompact?.capability?.status || "disabled",
    reason: nativeCompact?.reason || "not_requested",
  };
  const prepared = thirdPartyCompactionSummaryBody(body, route);
  const deadline = compactionFirstByteDeadline(signal, firstByteTimeoutMs);
  let upstream;
  try {
    upstream = await fetchThirdPartyResponses(route, key, prepared.body, deadline.signal, clientHeaders);
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = deadline.timedOut() ? "upstream_first_byte_timeout" : "upstream_unreachable";
    openThirdPartyCompactionCircuit(routeKey, reason);
    return localCompactionSnapshot({ route, body, requestedModel, fingerprint, reason, upstreamBody: prepared.body, priorAttempts, nativeCompact: nativeDiagnostics });
  } finally {
    deadline.dispose();
  }

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    openThirdPartyCompactionCircuit(routeKey, `upstream_http_${upstream.status}`);
    return localCompactionSnapshot({ route, body, requestedModel, fingerprint, reason: `upstream_http_${upstream.status}`, upstreamBody: prepared.body, priorAttempts, nativeCompact: nativeDiagnostics });
  }

  let raw;
  try {
    raw = await upstream.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    openThirdPartyCompactionCircuit(routeKey, "upstream_stream_interrupted");
    return localCompactionSnapshot({ route, body, requestedModel, fingerprint, reason: "upstream_stream_interrupted", upstreamBody: prepared.body, priorAttempts, nativeCompact: nativeDiagnostics });
  }
  const parsed = responseObjectFromRaw(raw);
  const summary = assistantTextFromResponse(parsed);
  if (!hasSingleCompactionOutput(parsed) && !summary) {
    openThirdPartyCompactionCircuit(routeKey, "upstream_summary_missing");
    return localCompactionSnapshot({ route, body, requestedModel, fingerprint, reason: "upstream_summary_missing", upstreamBody: prepared.body, priorAttempts, nativeCompact: nativeDiagnostics });
  }

  const compacted = hasSingleCompactionOutput(parsed)
    ? parsed
    : compactionResponseFromSummary(parsed, requestedModel, route, body);
  compacted.codex_relay = {
    ...(compacted.codex_relay || {}),
    compaction_strategy: "model_summary",
    compaction_fingerprint: fingerprint,
  };
  return {
    compacted,
    headers: Object.fromEntries(rebuiltResponseHeaders(upstream.headers)),
    diagnostics: requestDiagnostics(body, prepared.body, {
      attempts: priorAttempts + 1,
      upstreamAttempts: priorAttempts + 1,
      compactionStrategy: "model_summary",
      compactionFingerprint: fingerprint,
      isCompaction: true,
      removedTools: prepared.removedTools,
      cacheHit: false,
      deduplicated: false,
      circuitOpen: false,
      nativeCompact: nativeDiagnostics,
    }),
  };
}

async function performThirdPartyNativeCompaction({ route, key, body, requestedModel, signal, fingerprint, nativeCompact, clientHeaders = {} }) {
  let upstream;
  try {
    upstream = await fetchProvider(route.provider, providerCompactEndpoint(route.provider), {
      method: "POST",
      headers: thirdPartyHeaders(route.provider, key, Boolean(body.stream), clientHeaders),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    return { attempted: true, snapshot: null, classification: classifyNativeCompactTransportError(error) };
  }

  let raw;
  try {
    raw = await upstream.text();
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    return { attempted: true, snapshot: null, classification: classifyNativeCompactTransportError(error) };
  }
  const classification = classifyNativeCompactHttpResult({
    status: upstream.status,
    contentType: upstream.headers.get("content-type") || "",
    bodyText: raw,
    expectedModel: route.upstreamModel,
  });
  if (classification.outcome !== "supported") return { attempted: true, snapshot: null, classification };

  const compacted = structuredClone(classification.payload);
  const nativeItem = compacted.output[classification.compactionIndex];
  nativeItem.encrypted_content = encodeRelayNativeCompaction({
    routeSignature: nativeCompact.target.routeSignature,
    encryptedContent: nativeItem.encrypted_content,
    portableSummary: portableCompactionFallback(body.input),
  });
  compacted.codex_relay = {
    ...(compacted.codex_relay || {}),
    compaction_strategy: "native_compact",
    compaction_fingerprint: fingerprint,
  };
  return {
    attempted: true,
    classification,
    snapshot: {
      compacted,
      headers: Object.fromEntries(rebuiltResponseHeaders(upstream.headers)),
      diagnostics: requestDiagnostics(body, body, {
        attempts: 1,
        upstreamAttempts: 1,
        compactionStrategy: "native_compact",
        compactionFingerprint: fingerprint,
        isCompaction: true,
        removedTools: [],
        cacheHit: false,
        deduplicated: false,
        circuitOpen: false,
        nativeCompact: {
          attempted: true,
          capabilityBefore: nativeCompact.capability.status,
          outcome: classification.outcome,
          reason: classification.reason,
        },
        requestedModel,
      }),
    },
  };
}

function thirdPartyCompactionSummaryBody(body, route) {
  const copy = structuredClone(body || {});
  const sourceInput = Array.isArray(copy.input)
    ? copy.input
    : [{ role: "user", content: [{ type: "input_text", text: String(copy.input || "") }] }];
  let removedAdditionalTools = 0;
  copy.input = sourceInput.filter((item) => {
    if (item?.type === "compaction_trigger") return false;
    if (item?.type === "additional_tools") {
      removedAdditionalTools += Array.isArray(item.tools) ? item.tools.length : 1;
      return false;
    }
    return true;
  });
  copy.input.push({ role: "user", content: [{ type: "input_text", text: THIRD_PARTY_COMPACTION_PROMPT }] });
  const removedTools = [
    ...((copy.tools || []).map((tool) => tool?.name || tool?.type || "tool")),
    ...(removedAdditionalTools ? [`additional_tools:${removedAdditionalTools}`] : []),
  ];
  for (const field of ["tools", "tool_choice", "parallel_tool_calls", "max_tool_calls", "previous_response_id", "include", "client_metadata", "prompt_cache_key", "text", "response_format"]) delete copy[field];
  copy.model = route.upstreamModel;
  copy.stream = false;
  return { body: copy, removedTools };
}

function thirdPartyCompactionFingerprint(route, body, routeIdentity = "") {
  const copy = structuredClone(body || {});
  delete copy.stream;
  delete copy.client_metadata;
  if (Array.isArray(copy.input)) {
    copy.input = copy.input.filter((item) => item?.type !== "compaction_trigger" && item?.type !== "additional_tools");
  }
  return crypto.createHash("sha256")
    .update(`${routeIdentity || route.providerId}\n${route.upstreamModel}\n${JSON.stringify(copy)}`)
    .digest("hex");
}

function localCompactionSnapshot({ route, body, requestedModel, fingerprint, reason, upstreamBody = null, circuitOpen = false, priorAttempts = 0, nativeCompact = null }) {
  const compacted = compactionResponseFromSummary(null, requestedModel, route, body);
  compacted.codex_relay = {
    ...(compacted.codex_relay || {}),
    compaction_strategy: "local_emergency",
    compaction_fingerprint: fingerprint,
    compaction_failure: reason,
  };
  return {
    compacted,
    headers: {},
    diagnostics: requestDiagnostics(body, upstreamBody || {}, {
      attempts: priorAttempts + (upstreamBody ? 1 : 0),
      upstreamAttempts: priorAttempts + (upstreamBody ? 1 : 0),
      compactionStrategy: "local_emergency",
      compactionFingerprint: fingerprint,
      isCompaction: true,
      removedTools: [],
      cacheHit: false,
      deduplicated: circuitOpen,
      circuitOpen,
      failureReason: reason,
      ...(nativeCompact ? { nativeCompact } : {}),
    }),
  };
}

function responseFromCompactionSnapshot(snapshot, requestBody, diagnosticOverrides = {}) {
  const compacted = structuredClone(snapshot.compacted);
  const streaming = Boolean(requestBody?.stream);
  const headers = new Headers(snapshot.headers || {});
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("content-type", streaming ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
  headers.set("cache-control", "no-cache");
  const response = new Response(streaming ? responseToSse(compacted) : JSON.stringify(compacted), { status: 200, headers });
  responseRequestDiagnostics.set(response, { ...snapshot.diagnostics, ...diagnosticOverrides });
  return response;
}

function rememberCompactionSnapshot(fingerprint, snapshot) {
  thirdPartyCompactionCache.set(fingerprint, { snapshot, expiresAt: Date.now() + THIRD_PARTY_COMPACTION_CACHE_TTL_MS });
  while (thirdPartyCompactionCache.size > THIRD_PARTY_COMPACTION_CACHE_LIMIT) {
    thirdPartyCompactionCache.delete(thirdPartyCompactionCache.keys().next().value);
  }
}

function openThirdPartyCompactionCircuit(routeKey, reason) {
  thirdPartyCompactionCircuit.set(routeKey, { reason, expiresAt: Date.now() + THIRD_PARTY_COMPACTION_CACHE_TTL_MS });
}

function openThirdPartyNativeCompactCircuit(routeSignature, reason, ttlMs = THIRD_PARTY_COMPACTION_CACHE_TTL_MS) {
  if (!routeSignature) return;
  thirdPartyNativeCompactCircuit.set(routeSignature, { reason, expiresAt: Date.now() + Math.max(1, Number(ttlMs) || THIRD_PARTY_COMPACTION_CACHE_TTL_MS) });
}

function rememberNativeCompactClassification(recorder, target, classification) {
  if (typeof recorder !== "function" || !target || !classification) return;
  try { recorder(target, classification); }
  catch (error) { console.error(`Codex Relay could not queue Compact capability state: ${error.message}`); }
}

function pruneThirdPartyCompactionState() {
  const now = Date.now();
  for (const [key, value] of thirdPartyCompactionCache) if (value.expiresAt <= now) thirdPartyCompactionCache.delete(key);
  for (const [key, value] of thirdPartyCompactionCircuit) if (value.expiresAt <= now) thirdPartyCompactionCircuit.delete(key);
  for (const [key, value] of thirdPartyNativeCompactCircuit) if (value.expiresAt <= now) thirdPartyNativeCompactCircuit.delete(key);
}

function thirdPartyNativeCompactPlan(settings, route, key) {
  if (!settings || route?.kind === "official" || route?.provider?.apiType !== "responses") return { attempt: false, reason: "not_enabled" };
  const endpointUrl = providerCompactEndpoint(route.provider);
  const target = compactCapabilityTarget({ provider: route.provider, apiKey: key, upstreamModel: route.upstreamModel, endpointUrl });
  if (!target) return { attempt: false, reason: "ineligible_route" };
  const capability = compactCapabilityStatus(settings.compactCapabilities, target);
  if (capability.status === "unsupported" || capability.status === "temporary_failure") {
    return { attempt: false, reason: `capability_${capability.status}`, capability, target };
  }
  const circuit = thirdPartyNativeCompactCircuit.get(target.routeSignature);
  if (circuit?.expiresAt > Date.now()) return { attempt: false, reason: circuit.reason || "native_compact_circuit_open", capability, target };
  return { attempt: true, reason: "native_compact_candidate", capability, target };
}

function waitForCompactionSnapshot(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function adaptThirdPartyCompactionResponse(upstream, requestedModel, route, requestBody) {
  if (!(upstream instanceof Response)) {
    if (hasSingleCompactionOutput(upstream)) return upstream;
    return compactionResponseFromSummary(upstream, requestedModel, route, requestBody);
  }

  const raw = await upstream.text();
  const parsed = responseObjectFromRaw(raw);
  if (hasSingleCompactionOutput(parsed)) {
    return new Response(raw, { status: upstream.status, statusText: upstream.statusText, headers: rebuiltResponseHeaders(upstream.headers) });
  }

  const compacted = compactionResponseFromSummary(parsed, requestedModel, route, requestBody);
  const headers = rebuiltResponseHeaders(upstream.headers);
  const streaming = Boolean(requestBody.stream);
  headers.set("content-type", streaming ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
  headers.set("cache-control", "no-cache");
  return new Response(streaming ? responseToSse(compacted) : JSON.stringify(compacted), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function rebuiltResponseHeaders(source) {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return headers;
}

function compactionResponseFromSummary(upstream, requestedModel, route, requestBody) {
  const summary = assistantTextFromResponse(upstream) || portableCompactionFallback(requestBody.input);
  const inputTokens = Number(upstream?.usage?.input_tokens) || 0;
  const outputTokens = Number(upstream?.usage?.output_tokens) || 0;
  return {
    id: upstream?.id || `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: upstream?.created_at || Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output: [{
      id: `cmp_${crypto.randomUUID()}`,
      type: "compaction",
      encrypted_content: encodeRelayCompaction(summary),
    }],
    output_text: "",
    usage: upstream?.usage || {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    codex_relay: {
      ...(upstream?.codex_relay || {}),
      provider: route.provider.name,
      upstream_model: route.upstreamModel,
      compaction_fallback: "portable_v1",
    },
  };
}

function hasSingleCompactionOutput(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.filter((item) => item?.type === "compaction").length === 1;
}

function assistantTextFromResponse(response) {
  const text = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      const value = part?.text || part?.output_text;
      if (typeof value === "string" && value.trim()) text.push(value.trim());
    }
  }
  return text.join("\n").trim();
}

function portableCompactionFallback(input) {
  const pieces = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type === "compaction_trigger" || item?.type === "additional_tools") continue;
    const role = item?.role || item?.type || "context";
    const content = Array.isArray(item?.content) ? item.content : [];
    const text = content.map((part) => part?.text || part?.input_text || part?.output_text || "").filter(Boolean).join("\n")
      || (typeof item?.output === "string" ? item.output : "")
      || (typeof item?.input === "string" ? item.input : "")
      || (item?.arguments ? `${item.name || "tool"} ${typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments)}` : "");
    if (text.trim()) pieces.push(`[${role}] ${text.trim()}`);
  }
  const joined = pieces.join("\n\n");
  const retained = joined.length > 120_000
    ? `${joined.slice(0, 20_000)}\n\n[Earlier middle context omitted by emergency compaction]\n\n${joined.slice(-100_000)}`
    : joined;
  return retained || "Continue the current Codex task from the retained local conversation and workspace state.";
}

function encodeRelayCompaction(summary) {
  return `${RELAY_COMPACTION_PREFIX}${Buffer.from(JSON.stringify({ summary }), "utf8").toString("base64url")}`;
}

function encodeRelayNativeCompaction({ routeSignature, encryptedContent, portableSummary }) {
  return `${RELAY_NATIVE_COMPACTION_PREFIX}${Buffer.from(JSON.stringify({
    routeSignature,
    encryptedContent,
    portableSummary,
  }), "utf8").toString("base64url")}`;
}

function decodeRelayCompaction(value) {
  const encoded = String(value || "");
  if (!encoded.startsWith(RELAY_COMPACTION_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded.slice(RELAY_COMPACTION_PREFIX.length), "base64url").toString("utf8"));
    return typeof parsed?.summary === "string" && parsed.summary.trim() ? { summary: parsed.summary.trim() } : null;
  } catch {
    return null;
  }
}

function decodeRelayNativeCompaction(value) {
  const encoded = String(value || "");
  if (!encoded.startsWith(RELAY_NATIVE_COMPACTION_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded.slice(RELAY_NATIVE_COMPACTION_PREFIX.length), "base64url").toString("utf8"));
    const routeSignature = String(parsed?.routeSignature || "").toLowerCase();
    const encryptedContent = typeof parsed?.encryptedContent === "string" ? parsed.encryptedContent : "";
    const portableSummary = typeof parsed?.portableSummary === "string" ? parsed.portableSummary.trim() : "";
    if (!/^[a-f0-9]{64}$/.test(routeSignature) || !encryptedContent || !portableSummary) return null;
    return { routeSignature, encryptedContent, portableSummary };
  } catch {
    return null;
  }
}

function expandRelayCompactions(body, route = null, key = "") {
  if (!Array.isArray(body?.input)) return body;
  const nativeTarget = route?.kind === "third_party" && route?.provider?.apiType === "responses" && key
    ? compactCapabilityTarget({ provider: route.provider, apiKey: key, upstreamModel: route.upstreamModel, endpointUrl: providerCompactEndpoint(route.provider) })
    : null;
  let changed = false;
  const input = body.input.flatMap((item) => {
    if (item?.type !== "compaction") return [item];
    const portable = decodeRelayCompaction(item.encrypted_content);
    if (portable) {
      changed = true;
      return [{
        role: "developer",
        content: [{ type: "input_text", text: `Compacted context from an earlier Codex Relay window:\n${portable.summary}` }],
      }];
    }
    const native = decodeRelayNativeCompaction(item.encrypted_content);
    if (!native) return [item];
    changed = true;
    if (nativeTarget?.routeSignature === native.routeSignature) {
      return [{ ...item, encrypted_content: native.encryptedContent }];
    }
    return [{
      role: "developer",
      content: [{ type: "input_text", text: `Portable context from a different Codex Relay upstream:\n${native.portableSummary}` }],
    }];
  });
  return changed ? { ...body, input } : body;
}

function responseToSse(response) {
  const events = [{ type: "response.created", response }];
  for (let index = 0; index < response.output.length; index += 1) {
    const item = response.output[index];
    events.push({ type: "response.output_item.added", output_index: index, item });
    if (item.type === "message") {
      const text = item.content?.[0]?.text || "";
      if (text) events.push({ type: "response.output_text.delta", item_id: item.id, output_index: index, content_index: 0, delta: text });
    }
    if (item.type === "reasoning") {
      const summary = item.summary?.map((part) => part?.text || "").filter(Boolean).join("\n") || "";
      if (summary) events.push({ type: "response.reasoning_summary_text.delta", item_id: item.id, output_index: index, summary_index: 0, delta: summary });
      if (summary) events.push({ type: "response.reasoning_summary_text.done", item_id: item.id, output_index: index, summary_index: 0, text: summary });
    }
    events.push({ type: "response.output_item.done", output_index: index, item });
  }
  events.push({ type: "response.completed", response });
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function thirdPartyHeaders(provider, key, stream = false, clientHeaders = {}) {
  const authHeader = provider.authHeaderName || "authorization";
  const authValue = `${provider.authHeaderPrefix ?? "Bearer "}${key}`;
  const result = new Headers();
  for (const [name, value] of Object.entries(clientHeaders || {})) {
    if (isThirdPartyHeaderSafeToForward(name) && value !== undefined) {
      result.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }
  result.set("content-type", "application/json");
  for (const [name, value] of Object.entries(provider.extraHeaders || {})) {
    if (value !== undefined) result.set(name, String(value));
  }
  result.set(authHeader, authValue);
  if (stream) {
    // Compressed SSE is a common cause of upstream buffering. Match the
    // native proxy behavior without changing non-streaming responses.
    result.set("accept", "text/event-stream");
    result.set("accept-encoding", "identity");
  }
  return Object.fromEntries(result);
}

function isThirdPartyHeaderSafeToForward(name) {
  const normalized = String(name || "").toLowerCase();
  if (!normalized || normalized.startsWith("x-codex-turn-")) return false;
  if (normalized.startsWith("proxy-") || normalized.startsWith("sec-") || normalized.startsWith("x-forwarded-") || normalized.startsWith("cf-") || normalized.startsWith("x-b3-")) return false;
  return !new Set([
    "accept", "accept-encoding", "authorization", "api-key", "content-encoding", "content-length", "content-type",
    "connection", "cookie", "host", "keep-alive", "openai-api-key", "origin", "referer", "te", "trailer",
    "transfer-encoding", "upgrade", "x-api-key", "traceparent", "tracestate",
  ]).has(normalized);
}

function chatToolChoice(value, context) {
  if (!value || value === "auto" || value === "none" || value === "required") return value || "auto";
  const responseName = `${value.namespace ? `${value.namespace}__` : ""}${value.name || value.function?.name || ""}`;
  const chatName = context.responseToChat.get(responseName)?.chatName;
  return chatName ? { type: "function", function: { name: chatName } } : "auto";
}

function copyChatRequestOptions(payload, body, route) {
  const dropped = new Set(Array.isArray(route?.dropParams) ? route.dropParams : []);
  const copy = (field, value = body?.[field]) => {
    if (value !== undefined && !dropped.has(field)) payload[field] = structuredClone(value);
  };
  for (const field of [
    "temperature", "top_p", "frequency_penalty", "presence_penalty", "seed", "stop",
    "service_tier", "user", "metadata", "logprobs", "top_logprobs", "n",
    "parallel_tool_calls", "stream_options",
  ]) copy(field);

  if (body?.max_completion_tokens !== undefined) copy("max_completion_tokens");
  else if (body?.max_tokens !== undefined) copy("max_tokens");
  else if (body?.max_output_tokens !== undefined && !dropped.has("max_output_tokens")) {
    const target = /^o\d/i.test(String(route?.upstreamModel || "")) ? "max_completion_tokens" : "max_tokens";
    if (!dropped.has(target)) payload[target] = structuredClone(body.max_output_tokens);
  }

  if (body?.response_format !== undefined) copy("response_format");
  else if (!dropped.has("response_format")) {
    const responseFormat = responsesTextFormatToChat(body?.text?.format);
    if (responseFormat) payload.response_format = responseFormat;
  }
}

function responsesTextFormatToChat(format) {
  if (!format || typeof format !== "object") return null;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type !== "json_schema") return null;
  const { type: _type, name, schema, strict, description, ...rest } = format;
  if (!name || !schema || typeof schema !== "object") return null;
  return {
    type: "json_schema",
    json_schema: {
      name,
      schema,
      ...(typeof strict === "boolean" ? { strict } : {}),
      ...(description ? { description } : {}),
      ...rest,
    },
  };
}

function requestDiagnostics(inboundBody, upstreamBody, overrides = {}) {
  const inboundBytes = bodyBytes(inboundBody);
  const upstreamBytes = bodyBytes(upstreamBody);
  const inboundCacheKey = typeof inboundBody?.prompt_cache_key === "string" ? inboundBody.prompt_cache_key : null;
  const upstreamCacheKey = typeof upstreamBody?.prompt_cache_key === "string" ? upstreamBody.prompt_cache_key : null;
  const replayBytes = inboundBody?.previous_response_id && !upstreamBody?.previous_response_id
    ? Math.max(0, bodyBytes(upstreamBody?.input) - bodyBytes(inboundBody?.input))
    : 0;
  return {
    attempts: 1,
    retryReason: null,
    removedTools: [],
    inboundBytes,
    upstreamBytes,
    relayAddedBytes: Math.max(0, upstreamBytes - inboundBytes),
    replayBytes,
    cacheKey: {
      inboundPresent: Boolean(inboundCacheKey),
      upstreamPresent: Boolean(upstreamCacheKey),
      preserved: inboundCacheKey ? inboundCacheKey === upstreamCacheKey : null,
    },
    ...overrides,
  };
}

function chatCachePrefixDiagnostics(route, body, messages, tools, reasoning) {
  const tracksDeepSeek = reasoning?.preset === "deepseek";
  const tracksGlm52 = /^glm-5\.2$/i.test(String(route?.upstreamModel || ""));
  if (!tracksDeepSeek && !tracksGlm52) return { diagnostics: null, state: null };
  const systemPrompt = messages.filter((message) => message?.role === "system").map((message) => message.content || "").join("\n");
  const toolsJson = JSON.stringify(tools || []);
  const state = {
    systemHash: shortDiagnosticHash(systemPrompt),
    toolsHash: shortDiagnosticHash(toolsJson),
    prefixHash: shortDiagnosticHash(JSON.stringify({ systemPrompt, tools: toolsJson })),
    messageHashes: messages.map((message) => shortDiagnosticHash(JSON.stringify(message))),
  };
  const previousId = String(body?.previous_response_id || "");
  const previous = previousId ? chatCachePrefixStates.get(previousId) : null;
  const reasons = [];
  if (!previousId) reasons.push("new_session");
  else if (!previous) reasons.push("baseline_unavailable");
  else {
    if (previous.systemHash !== state.systemHash) reasons.push("system");
    if (previous.toolsHash !== state.toolsHash) reasons.push("tools");
    if (!messageHashesArePrefix(previous.messageHashes, state.messageHashes)) reasons.push("history_rewrite");
  }
  return {
    diagnostics: {
      tracked: true,
      prefixHash: state.prefixHash,
      systemHash: state.systemHash,
      toolsHash: state.toolsHash,
      prefixChanged: previous ? reasons.length > 0 : null,
      changeReasons: reasons,
      toolSchemaBytes: Buffer.byteLength(toolsJson),
      toolSchemaTokens: Math.floor(Buffer.byteLength(toolsJson) / 4),
    },
    state,
  };
}

function rememberChatCachePrefix(responseId, state) {
  if (!responseId || !state) return;
  chatCachePrefixStates.set(String(responseId), state);
  while (chatCachePrefixStates.size > CHAT_CACHE_PREFIX_LIMIT) chatCachePrefixStates.delete(chatCachePrefixStates.keys().next().value);
}

function messageHashesArePrefix(previous = [], current = []) {
  return previous.length <= current.length && previous.every((hash, index) => hash === current[index]);
}

function shortDiagnosticHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function fetchThirdPartyResponses(route, key, body, signal, clientHeaders = {}) {
  return fetchProvider(route.provider, providerEndpoint(route.provider, "/responses"), {
    method: "POST",
    headers: thirdPartyHeaders(route.provider, key, Boolean(body.stream), clientHeaders),
    body: JSON.stringify(body),
    signal,
  });
}

export function providerCompactEndpoint(provider) {
  const configured = String(provider?.endpointUrl || "").trim();
  if (!configured) return joinEndpoint(provider?.baseUrl, "/responses/compact");
  try {
    const url = new URL(configured);
    const trimmed = url.pathname.replace(/\/+$/, "");
    url.pathname = /\/responses\/compact$/i.test(trimmed)
      ? trimmed
      : /\/responses$/i.test(trimmed)
        ? `${trimmed}/compact`
        : `${trimmed}/compact`;
    return url.toString();
  } catch {
    return `${configured.replace(/\/+$/, "")}/compact`;
  }
}

export function classifyPreviousResponseRejection(status, responseText) {
  if (![400, 404, 409, 422].includes(status)) return false;
  const text = String(responseText || "");
  let searchable = text;
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error && typeof parsed.error === "object" && !Array.isArray(parsed.error) ? parsed.error : {};
    const fields = [
      error.code, error.type, error.param, error.message, error.detail, error.details,
      parsed?.code, parsed?.type, parsed?.param, parsed?.message, parsed?.detail, parsed?.details, parsed?.errors,
      typeof parsed?.error === "string" ? parsed.error : "",
    ];
    searchable = fields.map((value) => {
      if (typeof value === "string") return value;
      if (value == null) return "";
      try { return JSON.stringify(value); } catch { return ""; }
    }).join(" ");
  } catch { /* Match the plain-text upstream error below. */ }
  const refersToPrevious = /previous(?:[_\s-]*response)(?:[_\s-]*(?:id|identifier))?/i.test(searchable);
  const rejectsContinuation = /invalid|not[_\s-]*found|does\s+not\s+exist|unknown|belongs|different[_\s-]*(?:model|account|project|organization)|cannot.{0,80}(?:continue|use|resume)|unable.{0,80}(?:continue|use|resume)|unsupported|not[_\s-]*supported|expired|stale|unrecognized|mismatch|not[_\s-]*available|(?:not[_\s-]*)?(?:stored|storage)|must\s+(?:be\s+)?stored|不存在|无效|未知|不支持|已过期|无法.{0,40}(?:继续|使用)|不属于/i.test(searchable);
  return refersToPrevious && rejectsContinuation;
}

async function shouldReplayPreviousContext(response, body, extendedAutomatic = false) {
  if (!body?.previous_response_id) return false;
  const text = await response.clone().text();
  return classifyPreviousResponseRejection(response.status, text);
}

async function shouldRetryWithoutImageGeneration(response, body) {
  if (![400, 403].includes(response.status) || !containsTool(body, "image_gen")) return false;
  const text = await response.clone().text();
  return /image generation.*(?:not enabled|not available|forbidden|permission)|(?:not enabled|permission).*image generation/i.test(text);
}

function containsTool(body, name) {
  if ((body.tools || []).some((tool) => tool?.name === name)) return true;
  return (body.input || []).some((item) => item?.type === "additional_tools" && (item.tools || []).some((tool) => tool?.name === name));
}

function removeToolByName(body, name) {
  const copy = structuredClone(body);
  let removed = false;
  if (Array.isArray(copy.tools)) {
    const kept = copy.tools.filter((tool) => tool?.name !== name);
    removed ||= kept.length !== copy.tools.length;
    copy.tools = kept;
  }
  if (Array.isArray(copy.input)) {
    for (const item of copy.input) {
      if (item?.type !== "additional_tools" || !Array.isArray(item.tools)) continue;
      const kept = item.tools.filter((tool) => tool?.name !== name);
      removed ||= kept.length !== item.tools.length;
      item.tools = kept;
    }
  }
  return { body: copy, removed };
}

export function hasCompactionTrigger(body) {
  return Array.isArray(body?.input) && body.input.some((item) => item?.type === "compaction_trigger");
}

function compactionFirstByteDeadline(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Third-party compaction first-byte timeout", "TimeoutError"));
    }, Math.floor(timeoutMs))
    : null;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function passthroughHeaders(headers, bearer, accountId, accept = "text/event-stream") {
  const result = { "content-type": "application/json", authorization: `Bearer ${bearer}`, accept };
  if (accountId) result["chatgpt-account-id"] = accountId;
  const skip = new Set(["authorization", "x-api-key", "api-key", "openai-api-key", "content-type", "content-length", "host", "connection", "transfer-encoding", "content-encoding", "accept-encoding"]);
  for (const [name, value] of Object.entries(headers || {})) {
    if (skip.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

function routeHistoryInfo(route, key = "") {
  if (!route || typeof route !== "object") return null;
  const provider = route.provider || {};
  const apiType = route.kind === "official" ? "responses" : String(provider.apiType || route.apiType || "");
  const endpoint = route.kind === "official"
    ? OFFICIAL_CODEX_BASE_URL
    : String(provider.endpointUrl || provider.baseUrl || route.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  const providerId = route.kind === "official" ? "official" : String(route.providerId || provider.id || "");
  const keyFingerprint = key ? crypto.createHash("sha256").update(String(key)).digest("hex") : "";
  const authShape = JSON.stringify({
    header: String(provider.authHeaderName || "authorization").toLowerCase(),
    prefix: String(provider.authHeaderPrefix ?? "Bearer "),
    extraHeaders: Object.entries(provider.extraHeaders || {}).sort(([left], [right]) => left.localeCompare(right)),
  });
  const stateDomain = crypto.createHash("sha256")
    .update([route.kind || "", providerId, apiType, endpoint, keyFingerprint, authShape].join("\n"))
    .digest("hex");
  const routeSignature = crypto.createHash("sha256").update(`${stateDomain}\n${route.upstreamModel || ""}`).digest("hex");
  return normalizeRouteInfo({
    routeId: route.id,
    kind: route.kind,
    providerId,
    apiType,
    endpoint,
    upstreamModel: route.upstreamModel,
    stateDomain,
    routeSignature,
  });
}

function normalizeRouteInfo(value) {
  if (!value || typeof value !== "object") return null;
  return {
    routeId: String(value.routeId || "").slice(0, 128),
    kind: value.kind === "official" ? "official" : "third_party",
    providerId: String(value.providerId || "").slice(0, 128),
    apiType: String(value.apiType || "").slice(0, 40),
    endpoint: String(value.endpoint || "").slice(0, 2048),
    upstreamModel: String(value.upstreamModel || "").slice(0, 240),
    stateDomain: String(value.stateDomain || "").replace(/[^a-f0-9]/gi, "").slice(0, 64),
    routeSignature: String(value.routeSignature || "").replace(/[^a-f0-9]/gi, "").slice(0, 64),
  };
}

function sameResponsesStateDomain(previous, current) {
  return Boolean(
    previous?.kind === "third_party"
    && current?.kind === "third_party"
    && previous.apiType === "responses"
    && current.apiType === "responses"
    && previous.stateDomain
    && previous.stateDomain === current.stateDomain,
  );
}

function officialStoredBaselineBody(body) {
  return body?.store === false ? body : { ...body, store: false };
}

function automaticNativeContinuation(route, key, body, headers, history) {
  if (body?.previous_response_id || route?.provider?.nativeResponseContinuation !== true || !history?.responseIdCandidate || !Array.isArray(body?.input)) return null;
  const taskHash = nativeTaskHash(body, headers);
  if (!taskHash) return null;
  const currentInfo = routeHistoryInfo(route, key);
  const candidate = history.responseIdCandidate(taskHash, currentInfo);
  if (!candidate?.nativeState || !sameResponsesStateDomain(candidate.routeInfo, currentInfo)) return null;
  const blockedRouteSignatures = candidate.nativeState.blockedRouteSignatures || [];
  if (blockedRouteSignatures.includes(currentInfo.routeSignature)) {
    return { applied: false, blockedRouteSignatures, diagnostics: { applied: false, reason: "route_rejected_previous_response" } };
  }
  const inputHashes = nativeInputHashes(body.input);
  const previousHashes = candidate.nativeState.inputHashes;
  if (!hashesAreStrictPrefix(previousHashes, inputHashes) || candidate.nativeState.fixedHash !== nativeFixedRequestHash(body)) return null;
  const incrementalInput = body.input.slice(previousHashes.length);
  if (!incrementalInput.length) return null;
  return {
    applied: true,
    body: { ...body, store: true, previous_response_id: candidate.id, input: incrementalInput },
    fallbackBody: { ...body, store: true, previous_response_id: undefined },
    previousInfo: candidate.routeInfo,
    blockedRouteSignatures,
    diagnostics: { applied: true, priorItems: previousHashes.length, incrementalItems: incrementalInput.length },
  };
}

function continuationDiagnostics(route, body, history, automaticContinuation) {
  if (route?.provider?.apiType !== "responses") return { mode: "not_responses" };
  if (body?.previous_response_id) {
    const previousInfo = history?.routeInfoFor?.(body.previous_response_id);
    const currentInfo = routeHistoryInfo(route, providerKey(route.providerId));
    if (route.kind === "third_party" && history?.responseIdStateFor?.(body.previous_response_id)?.storage === "not_stored") {
      return { mode: "client_id_portable", reason: "previous_response_not_stored" };
    }
    if (route.provider.nativeResponseContinuation !== true) return { mode: "client_id_portable", reason: "provider_automatic_disabled" };
    return sameResponsesStateDomain(previousInfo, currentInfo)
      ? { mode: "client_id_same_domain" }
      : { mode: "client_id_portable", reason: previousInfo ? "foreign_state_domain" : "unknown_response_id" };
  }
  if (route.provider.nativeResponseContinuation !== true) return { mode: "automatic_not_used", reason: "provider_automatic_disabled" };
  if (automaticContinuation?.applied) return { mode: "automatic_applied", priorItems: automaticContinuation.diagnostics.priorItems, incrementalItems: automaticContinuation.diagnostics.incrementalItems };
  if (automaticContinuation?.diagnostics?.reason) return { mode: "automatic_not_used", reason: automaticContinuation.diagnostics.reason };
  return { mode: "automatic_not_used", reason: Array.isArray(body?.input) ? "candidate_or_input_not_eligible" : "input_not_array" };
}

function responseIdStateForRecord(body, headers, route, response) {
  const responsesRoute = route?.kind === "official" || (route?.kind === "third_party" && route?.provider?.apiType === "responses");
  if (!responsesRoute) return null;
  if (!isStandardCompletedResponsesResult(response, route)) return null;
  const taskHash = nativeTaskHash(body, headers);
  const storage = body?.store === false ? "not_stored" : null;
  if (!taskHash && !storage) return null;
  return normalizeResponseIdState({
    version: 1,
    taskHash,
    storage,
  });
}

function isStandardCompletedResponsesResult(response, route) {
  const responseId = String(response?.id || "");
  return response?.object === "response"
    && response?.status === "completed"
    && Array.isArray(response?.output)
    && response?.error == null
    && response?.model === route?.upstreamModel
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(responseId);
}

function normalizeResponseIdState(value) {
  if (!value || typeof value !== "object" || Number(value.version) !== 1) return null;
  const taskHash = normalizedSha256(value.taskHash);
  const storage = value.storage === "not_stored" ? "not_stored" : null;
  return taskHash || storage ? { version: 1, taskHash, storage } : null;
}

function nativeContinuationStateForRecord(body, headers, route, metadata = {}, response = null, responseIdState = null) {
  const enabledThirdPartyRoute = route?.kind === "third_party" && route?.provider?.apiType === "responses" && route.provider.nativeResponseContinuation === true;
  if (!responseIdState || body?.previous_response_id || !enabledThirdPartyRoute || !Array.isArray(body?.input)) return null;
  const taskHash = nativeTaskHash(body, headers);
  if (!taskHash) return null;
  return normalizeNativeContinuationState({
    taskHash,
    inputHashes: nativeInputHashes([...body.input, ...(Array.isArray(response?.output) ? response.output : [])]),
    fixedHash: nativeFixedRequestHash(body),
    blockedRouteSignatures: metadata?.blockedRouteSignatures,
  });
}

function normalizedSha256(value) {
  const normalized = String(value || "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function normalizeNativeContinuationState(value) {
  if (!value || typeof value !== "object") return null;
  const taskHash = String(value.taskHash || "").replace(/[^a-f0-9]/gi, "").slice(0, 64);
  const fixedHash = String(value.fixedHash || "").replace(/[^a-f0-9]/gi, "").slice(0, 64);
  const inputHashes = Array.isArray(value.inputHashes)
    ? value.inputHashes.map((hash) => String(hash || "").replace(/[^a-f0-9]/gi, "").slice(0, 64)).filter((hash) => hash.length === 64).slice(0, 20_000)
    : [];
  if (taskHash.length !== 64 || fixedHash.length !== 64 || !inputHashes.length) return null;
  const blockedRouteSignatures = Array.isArray(value.blockedRouteSignatures)
    ? [...new Set(value.blockedRouteSignatures.map((hash) => String(hash || "").replace(/[^a-f0-9]/gi, "").slice(0, 64)).filter((hash) => hash.length === 64))].slice(-20)
    : [];
  return { taskHash, fixedHash, inputHashes, blockedRouteSignatures };
}

function nativeTaskHash(body, headers) {
  const candidates = [body?.client_metadata, parseNativeMetadata(nativeHeaderValue(headers, "x-codex-turn-metadata"))];
  for (const value of candidates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const alias of ["thread_id", "threadId", "conversation_id", "conversationId", "session_id", "sessionId"]) {
      if (typeof value[alias] === "string" && value[alias].trim()) return sha256Text(`${alias}:${value[alias].trim().slice(0, 512)}`);
    }
  }
  return null;
}

function parseNativeMetadata(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  for (const candidate of [raw, decodeNativeBase64(raw)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* Only structured metadata may identify a task. */ }
  }
  return null;
}

function decodeNativeBase64(value) {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) return "";
  try { return Buffer.from(value, "base64url").toString("utf8"); }
  catch { return ""; }
}

function nativeHeaderValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function nativeInputHashes(input) { return input.map((item) => sha256Text(stableCanonicalJson(item))); }

function nativeFixedRequestHash(body) {
  const copy = structuredClone(body || {});
  for (const field of ["input", "model", "previous_response_id", "stream", "store", "client_metadata"]) delete copy[field];
  return sha256Text(stableCanonicalJson(copy));
}

function hashesAreStrictPrefix(previous, current) {
  return Array.isArray(previous) && previous.length > 0 && previous.length < current.length && previous.every((hash, index) => hash === current[index]);
}

function stableCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256Text(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }

function joinEndpoint(baseUrl, endpoint) { return `${String(baseUrl).replace(/\/+$/, "")}${endpoint}`; }
function providerEndpoint(provider, endpoint) { return provider.endpointUrl || joinEndpoint(provider.baseUrl, endpoint); }
function stripUnsupported(body, fields = []) { const copy = structuredClone(body); for (const field of fields || []) delete copy[field]; return copy; }
function httpError(statusCode, message, code) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
