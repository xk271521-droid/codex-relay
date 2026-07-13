import crypto from "node:crypto";
import { OFFICIAL_CODEX_BASE_URL } from "./constants.js";
import { activeRoutes } from "./catalog.js";
import { fetchOfficial } from "./official-fetch.js";
import { officialAccessToken, officialAccountId, providerKey } from "./store.js";

const historyManagedResponses = new WeakSet();
const responseContextModes = new WeakMap();

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
  for (const item of Array.isArray(initialEntries) ? initialEntries.slice(-200) : []) {
    if (!item?.id || !Array.isArray(item.messages) || !item.routeId) continue;
    entries.set(String(item.id), item.messages);
    routes.set(String(item.id), String(item.routeId));
  }

  function snapshot() {
    return [...entries.entries()].map(([id, messages]) => ({ id, messages, routeId: routes.get(id) || "" }));
  }

  function changed() {
    if (typeof onChange === "function") onChange(snapshot());
  }

  return {
    get(responseId) { return entries.get(responseId) || []; },
    routeFor(responseId) { return routes.get(responseId) || null; },
    record(responseId, messages, routeId = "") {
      entries.set(responseId, messages);
      if (routeId) routes.set(responseId, routeId);
      while (entries.size > 200) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
        routes.delete(oldest);
      }
      changed();
    },
    snapshot,
    clear() { entries.clear(); routes.clear(); changed(); },
  };
}

export async function forwardResponses({ settings, route, body, headers, signal, history, officialBaseUrl = OFFICIAL_CODEX_BASE_URL }) {
  const contextMode = routingContextMode(settings, body, route, history);
  const normalizedBody = rehydrateCrossRouteRequest(body, route, history, settings);
  if (route.kind === "official") {
    const bearer = officialAccessToken();
    if (!bearer) throw httpError(401, "Official route requires a saved official Codex sign-in. Sign in and verify the official channel again.", "official_auth_missing");
    const accountId = officialAccountId();
    let response = await fetchOfficialResponse(normalizedBody, route, headers, bearer, accountId, signal, officialBaseUrl);
    if (contextMode === "official_native_continuation" && response.status >= 400 && response.status < 500) {
      const fallbackBody = rehydrateCrossRouteRequest(body, route, history, settings, { forcePortableContext: true });
      if (fallbackBody !== body) {
        await response.body?.cancel();
        response = await fetchOfficialResponse(fallbackBody, route, headers, bearer, accountId, signal, officialBaseUrl);
        responseContextModes.set(response, "official_fallback_replayed");
        return response;
      }
    }
    responseContextModes.set(response, contextMode);
    return response;
  }

  const key = providerKey(route.providerId);
  if (!key) throw httpError(400, `No API key is saved for ${route.provider.name}.`, "provider_key_missing");
  if (route.provider.apiType === "responses") {
    const response = await fetch(providerEndpoint(route.provider, "/responses"), {
      method: "POST",
      headers: thirdPartyHeaders(route.provider, key),
      body: JSON.stringify({ ...stripUnsupported(normalizedBody, route.dropParams), model: route.upstreamModel }),
      signal,
    });
    responseContextModes.set(response, contextMode);
    return response;
  }
  const response = await forwardChatCompletions(route, normalizedBody, key, signal, history);
  if (response instanceof Response) responseContextModes.set(response, contextMode);
  else if (response?.codex_relay) response.codex_relay.context_mode = contextMode;
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

export function routingContextMode(settings, body, route, history) {
  if (!body?.previous_response_id) return "new";
  const previousRouteId = history?.routeFor?.(body.previous_response_id);
  if (!previousRouteId) return "unknown";
  const previousRoute = activeRoutes(settings).find((item) => item.id === previousRouteId);
  if (!previousRoute) return "unknown";
  if (previousRoute.kind === "official" && route.kind === "official") return "official_native_continuation";
  if (previousRoute.id === route.id) return route.provider?.apiType === "responses" ? "third_party_native_continuation" : "third_party_continued";
  return "portable_context";
}

export function recordPassthroughResponse(history, requestBody, route, rawBody) {
  if (!history?.record) return;
  const response = responseObjectFromRaw(rawBody);
  if (!response?.id) return;
  const sourceMessages = responseToChat(requestBody, route, history);
  const assistant = assistantMessageFromResponse(response);
  history.record(response.id, [...sourceMessages, assistant], route.id);
}

async function forwardChatCompletions(route, body, key, signal, history) {
  const sourceMessages = responseToChat(body, route, history);
  const payload = {
    model: route.upstreamModel,
    stream: Boolean(body.stream),
    messages: sourceMessages,
    tools: responseToolsToChatTools(body.tools),
    tool_choice: body.tool_choice === "auto" ? "auto" : undefined,
    temperature: body.temperature,
  };
  const upstream = await fetch(providerEndpoint(route.provider, "/chat/completions"), {
    method: "POST",
    headers: thirdPartyHeaders(route.provider, key, Boolean(body.stream)),
    body: JSON.stringify(payload),
    signal,
  });
  if (!upstream.ok) return upstream;
  if (body.stream && isEventStreamResponse(upstream)) {
    return streamChatCompletions(upstream, body.model, route, sourceMessages, history);
  }
  if (body.stream) {
    const rawSse = await upstream.text();
    const response = responseFromChatStream(rawSse, body.model, route, sourceMessages);
    history?.record(response.id, [...sourceMessages, response.__assistantMessage], route.id);
    delete response.__assistantMessage;
    return new Response(responseToSse(response), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  }
  const chat = await upstream.json();
  const response = responseFromChat(chat, body.model, route, sourceMessages);
  history?.record(response.id, [...sourceMessages, response.__assistantMessage], route.id);
  delete response.__assistantMessage;
  return response;
}

function streamChatCompletions(upstream, requestedModel, route, sourceMessages, history) {
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
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let usage;
      let messageStarted = false;
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
      const consumeEvent = (data) => {
        if (!data || data === "[DONE]") return;
        try {
          const event = JSON.parse(data);
          const delta = event?.choices?.[0]?.delta || {};
          if (typeof delta.content === "string" && delta.content) {
            beginMessage();
            content += delta.content;
            emit({ type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: delta.content });
          }
          for (const part of delta.tool_calls || []) {
            const index = Number.isInteger(part.index) ? part.index : toolCalls.size;
            const current = toolCalls.get(index) || { id: part.id || `call_${crypto.randomUUID()}`, type: "function", function: { name: "", arguments: "" } };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.function.name += part.function.name;
            if (part.function?.arguments) current.function.arguments += part.function.arguments;
            toolCalls.set(index, current);
          }
          if (event?.usage) usage = event.usage;
        } catch { /* Ignore malformed provider SSE events. */ }
      };
      const consumeFrames = (flush = false) => {
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = flush ? "" : frames.pop() || "";
        for (const frame of flush ? frames : frames) {
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          consumeEvent(data);
        }
        if (flush && buffer.trim()) consumeEvent(buffer.trim().replace(/^data:\s*/m, ""));
      };

      try {
        emit({ type: "response.created", response: initialResponse });
        const reader = upstream.body?.getReader();
        if (!reader) throw new Error("Provider did not return a response stream.");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          consumeFrames();
        }
        buffer += decoder.decode();
        consumeFrames(true);

        const response = responseFromAssistant({
          content,
          toolCalls: [...toolCalls.values()],
          usage,
        }, requestedModel, route, sourceMessages, { responseId, messageId, createdAt });
        const assistantMessage = response.__assistantMessage;
        delete response.__assistantMessage;
        const message = response.output.find((item) => item.type === "message");
        if (messageStarted && message) emit({ type: "response.output_item.done", output_index: 0, item: message });
        for (let index = message ? 1 : 0; index < response.output.length; index += 1) {
          const item = response.output[index];
          if (item.type === "message") continue;
          emit({ type: "response.output_item.added", output_index: index, item });
          emit({ type: "response.output_item.done", output_index: index, item });
        }
        emit({ type: "response.completed", response });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        history?.record(response.id, [...sourceMessages, assistantMessage], route.id);
        controller.close();
      } catch (error) {
        emit({ type: "error", error: { message: error.message || "Provider stream failed.", code: "upstream_stream_error" } });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
  const response = new Response(stream, { status: upstream.status, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  historyManagedResponses.add(response);
  return response;
}

function responseToChat(body, route, history) {
  const prior = body.previous_response_id ? history?.get(body.previous_response_id) || [] : [];
  const retained = retainPortableMessages(prior, route.contextWindow);
  const continuityNotice = retained.trimmed
    ? [{ role: "system", content: "Earlier conversation turns were omitted to fit the target model context window. Continue the current task from the retained conversation and workspace." }]
    : [];
  return normalizeChatToolMessages([...continuityNotice, ...retained.messages, ...responseInputToMessages(body.input)]);
}

// Codex may compact a conversation between a tool call and its output. Chat
// Completions rejects a standalone `tool` role, so preserve the output as a
// normal continuation when the matching function call is no longer present.
function normalizeChatToolMessages(messages) {
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
        normalized.push({
          role: "user",
          content: `Codex tool output from an earlier compacted step:\n${message.content || ""}`,
        });
      }
      continue;
    }
    normalized.push(message);
  }
  return normalized;
}

function rehydrateCrossRouteRequest(body, route, history, settings, options = {}) {
  const previous = body?.previous_response_id;
  if (!previous || !history?.routeFor) return body;
  const previousRoute = history.routeFor(previous);
  if (!previousRoute) return body;
  const previousDefinition = activeRoutes(settings).find((item) => item.id === previousRoute);
  if (!options.forcePortableContext && previousDefinition?.kind === "official" && route.kind === "official") return body;
  if (!options.forcePortableContext && previousRoute === route.id) return body;
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
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length
      ? `\n\nCompleted tool calls:\n${message.tool_calls.map((call) => `${call.function?.name || "unknown"}(${call.function?.arguments || "{}"})`).join("\n")}`
      : "";
    result.push({
      role: message.role === "system" ? "developer" : message.role || "user",
      content: [{ type: "input_text", text: `${message.content || ""}${toolCalls}` }],
    });
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

function estimateMessageTokens(message) {
  const toolText = Array.isArray(message.tool_calls) ? JSON.stringify(message.tool_calls) : "";
  return Math.max(1, Math.ceil(`${message.content || ""}${toolText}`.length / 3));
}

function responseInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const items = Array.isArray(input) ? input : [];
  return items.map((item) => {
    if (item?.type === "function_call_output") return { role: "tool", tool_call_id: item.call_id, content: contentToText(item.output) };
    const role = item?.role === "developer" ? "system" : item?.role || "user";
    return { role, content: contentToText(item?.content) };
  }).filter((item) => item.content);
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text || part?.input_text || "").filter(Boolean).join("\n");
}

function responseToolsToChatTools(tools = []) {
  return tools.filter((tool) => tool?.type === "function").map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters || {} },
  }));
}

function responseFromChat(chat, requestedModel, route, sourceMessages) {
  const choice = chat?.choices?.[0]?.message || {};
  return responseFromAssistant({ content: choice.content || "", toolCalls: choice.tool_calls || [], usage: chat?.usage }, requestedModel, route, sourceMessages);
}

function responseFromChatStream(rawSse, requestedModel, route, sourceMessages) {
  let content = "";
  let usage;
  const toolCalls = new Map();
  for (const rawLine of String(rawSse).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try {
      const event = JSON.parse(value);
      const delta = event?.choices?.[0]?.delta || {};
      content += delta.content || "";
      for (const part of delta.tool_calls || []) {
        const current = toolCalls.get(part.index) || { id: part.id || `call_${crypto.randomUUID()}`, type: "function", function: { name: "", arguments: "" } };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.function.name += part.function.name;
        if (part.function?.arguments) current.function.arguments += part.function.arguments;
        toolCalls.set(part.index, current);
      }
      if (event?.usage) usage = event.usage;
    } catch { /* Ignore malformed provider SSE events. */ }
  }
  return responseFromAssistant({ content, toolCalls: [...toolCalls.values()], usage }, requestedModel, route, sourceMessages);
}

function responseFromAssistant({ content, toolCalls, usage }, requestedModel, route, sourceMessages, identity = {}) {
  const text = content || "";
  const inputTokens = Number(usage?.prompt_tokens) || 0;
  const outputTokens = Number(usage?.completion_tokens) || 0;
  const id = identity.responseId || `relay_${crypto.randomUUID()}`;
  const output = [];
  if (text) output.push({ id: identity.messageId || `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  for (const call of toolCalls || []) {
    output.push({ id: `fc_${crypto.randomUUID()}`, type: "function_call", status: "completed", call_id: call.id || `call_${crypto.randomUUID()}`, name: call.function?.name || "unknown", arguments: call.function?.arguments || "{}" });
  }
  const assistantMessage = { role: "assistant", content: text || null };
  if (toolCalls?.length) assistantMessage.tool_calls = toolCalls;
  return {
    id,
    object: "response",
    created_at: identity.createdAt || Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    output_text: text,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: Number(usage?.total_tokens) || inputTokens + outputTokens },
    codex_relay: { provider: route.provider.name, upstream_model: route.upstreamModel },
    __assistantMessage: assistantMessage,
  };
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
      toolCalls.push({ id: item.call_id || item.id, type: "function", function: { name: item.name || "unknown", arguments: item.arguments || "{}" } });
    }
  }
  const message = { role: "assistant", content: text.join("\n") || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
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
    events.push({ type: "response.output_item.done", output_index: index, item });
  }
  events.push({ type: "response.completed", response });
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function thirdPartyHeaders(provider, key, stream = false) {
  const authHeader = provider.authHeaderName || "authorization";
  const authValue = `${provider.authHeaderPrefix ?? "Bearer "}${key}`;
  return { "content-type": "application/json", ...(provider.extraHeaders || {}), [authHeader]: authValue, ...(stream ? { accept: "text/event-stream" } : {}) };
}

function passthroughHeaders(headers, bearer, accountId) {
  const result = { "content-type": "application/json", authorization: `Bearer ${bearer}` };
  if (accountId) result["chatgpt-account-id"] = accountId;
  const skip = new Set(["authorization", "x-api-key", "api-key", "openai-api-key", "content-type", "content-length", "host", "connection", "transfer-encoding", "content-encoding", "accept-encoding"]);
  for (const [name, value] of Object.entries(headers || {})) {
    if (skip.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

function joinEndpoint(baseUrl, endpoint) { return `${String(baseUrl).replace(/\/+$/, "")}${endpoint}`; }
function providerEndpoint(provider, endpoint) { return provider.endpointUrl || joinEndpoint(provider.baseUrl, endpoint); }
function stripUnsupported(body, fields = []) { const copy = structuredClone(body); for (const field of fields || []) delete copy[field]; return copy; }
function httpError(statusCode, message, code) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
