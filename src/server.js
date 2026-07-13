import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelCatalog, activeRoutes } from "./catalog.js";
import { ROUTER_HOST, ROUTER_PORT } from "./constants.js";
import { createChatHistory, forwardResponses, isEventStreamResponse, recordPassthroughResponse, responseContextMode, responseManagesHistory, routeForRequest, routingContextMode } from "./router.js";
import { readJsonRequest } from "./request-body.js";
import {
  applyRelayConfig,
  captureOfficialAuth,
  captureRelayHandoff,
  commitRelayConfig,
  codexConfigPreflight,
  codexLoginStatus,
  clearContextCache,
  currentSessionInventory,
  discardRelayHandoff,
  hasProviderKey,
  hasOfficialAuthSnapshot,
  loadContextCache,
  loadSettings,
  paths,
  providerKey,
  relayApplicationStatus,
  replaceSettings,
  rollbackRelayConfig,
  relayHandoffSnapshot,
  restorePreview,
  restorePreRelayState,
  saveProviderKey,
  saveContextCache,
  saveSettings,
  verifySessionProtection,
  writeCatalog,
} from "./store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const events = [];
let contextCacheTimer;
const chatHistory = createChatHistory(loadContextCache(), (entries) => {
  if (!loadSettings().contextCache.persist) return;
  clearTimeout(contextCacheTimer);
  contextCacheTimer = setTimeout(() => {
    if (!loadSettings().contextCache.persist) return;
    try { saveContextCache(entries); } catch (error) { console.error(`Codex Relay could not persist context cache: ${error.message}`); }
  }, 1_200);
});
let server;
let lastOfficialAuthState = null;

function synchronizeOfficialLogin() {
  const login = codexLoginStatus();
  const signedIn = Boolean(login.signedIn && login.authType === "official");
  const settings = loadSettings();
  let changed = settings.official.verified !== signedIn;
  if (signedIn) {
    const captured = captureOfficialAuth();
    if (!captured.captured) return { login, changed: false };
    settings.official.lastCheckedAt = new Date().toISOString();
    changed ||= lastOfficialAuthState !== "official";
  }
  settings.official.verified = signedIn;
  if (changed) {
    saveSettings(settings);
    writeCatalog(buildModelCatalog(settings));
  }
  lastOfficialAuthState = signedIn ? "official" : "not_official";
  return { login, changed };
}

function repairRelayConnectionIfNeeded() {
  const settings = loadSettings();
  const application = relayApplicationStatus();
  if (!settings.router.running || !application.applied || application.configMatches) return { repaired: false, attempted: false, application };
  if (!application.relayManaged) return { repaired: false, attempted: false, application, externalTakeover: true, error: "Codex configuration is now controlled by another tool." };
  const handoff = relayHandoffSnapshot();
  if (!handoff) return { repaired: false, attempted: false, application, error: "Relay handoff is missing." };
  const sessionBaseline = currentSessionInventory();
  if (!sessionBaseline.filesAvailable) return { repaired: false, attempted: false, application, error: "Conversation files could not be inventoried." };
  const catalog = buildModelCatalog(settings);
  if (!catalog.models.length) return { repaired: false, attempted: false, application, error: "No Relay model is currently available." };
  let applied;
  try {
    writeCatalog(catalog);
    applied = applyRelayConfig({
      model: catalog.models[0].slug,
      catalogPath: paths().catalog,
      routerUrl: `http://127.0.0.1:${settings.router.port}/v1`,
      deferCommit: true,
      handoff: { created: false, snapshot: handoff },
    });
    const protection = verifySessionProtection(sessionBaseline);
    if (!protection.safe) throw apiError(409, "Conversation protection failed during automatic Relay repair.", "session_protection_failed");
    const repairedApplication = commitRelayConfig(applied.transaction);
    return { repaired: true, attempted: true, application: repairedApplication };
  } catch (error) {
    if (applied?.transaction) rollbackRelayConfig(applied.transaction);
    return { repaired: false, attempted: true, application: relayApplicationStatus(), error: String(error.message || "Automatic Relay repair failed.") };
  }
}

function app() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname.startsWith("/api/") && req.method !== "GET" && !validManagementOrigin(req)) throw apiError(403, "The local management request origin is not allowed.", "origin_not_allowed");
      if (req.method === "GET" && url.pathname === "/health") {
        synchronizeOfficialLogin();
        return json(res, 200, { app: "codex-relay", ok: true, routes: activeRoutes(loadSettings()).map((route) => route.id), listening: Boolean(server?.listening) });
      }
      if (req.method === "GET" && ["/v1/models", "/models"].includes(url.pathname)) {
        synchronizeOfficialLogin();
        return json(res, 200, { object: "list", data: activeRoutes(loadSettings()).map((route) => ({ id: route.id, object: "model", owned_by: route.kind === "official" ? "openai" : route.provider.name })) });
      }
      if (req.method === "GET" && ["/model-catalog.json", "/v1/model-catalog.json"].includes(url.pathname)) {
        synchronizeOfficialLogin();
        return json(res, 200, buildModelCatalog(loadSettings()));
      }
      // Awaiting the async handlers keeps upstream connection failures inside
      // this boundary. Returning the Promise directly leaves Node with an
      // unhandled rejection and can terminate the local Router.
      if (req.method === "POST" && ["/v1/responses", "/responses"].includes(url.pathname)) return await handleResponses(req, res);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      return await serveUi(req, res, url);
    } catch (error) {
      const status = error.statusCode || 500;
      console.error(`Codex Relay request failed (${status}): ${error.message || "Unexpected server error."}`);
      if (!res.headersSent) json(res, status, { error: { message: error.message || "Unexpected server error.", code: error.code || "relay_error" } });
      else if (!res.writableEnded) res.end();
    }
  });
}

function validManagementOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  return origin === `http://${ROUTER_HOST}:${ROUTER_PORT}` || origin === `http://localhost:${ROUTER_PORT}`;
}

async function handleResponses(req, res) {
  const settings = loadSettings();
  if (!settings.router.running) throw apiError(503, "Codex Relay is not applied. Open the local manager and apply a configured route first.", "router_disabled");
  const body = await readJsonRequest(req);
  const route = routeForRequest(settings, body.model);
  const contextMode = routingContextMode(settings, body, route, chatHistory);
  const started = Date.now();
  try {
    const upstream = await forwardResponses({ settings, route, body, headers: req.headers, signal: abortSignal(req, res), history: chatHistory });
    if (upstream instanceof Response) {
      const effectiveContextMode = responseContextMode(upstream) || contextMode;
      if (isEventStreamResponse(upstream)) {
        const streamed = await pipeEventStream(res, upstream);
        if (upstream.ok && !streamed.error && !responseManagesHistory(upstream)) recordPassthroughResponse(chatHistory, body, route, streamed.text);
        logEvent({ route, status: streamed.error ? 499 : upstream.status, durationMs: Date.now() - started, ok: upstream.ok && !streamed.error, contextMode: effectiveContextMode, usage: usageFromResponseText(streamed.text) });
        return;
      }
      const text = await upstream.text();
      if (upstream.ok && !responseManagesHistory(upstream)) recordPassthroughResponse(chatHistory, body, route, text);
      const upstreamError = upstream.ok ? null : officialUpstreamFailure(route, upstream.status, text);
      logEvent({ route, status: upstream.status, durationMs: Date.now() - started, ok: upstream.ok, contextMode: effectiveContextMode, error: upstreamError, usage: usageFromResponseText(text) });
      if (upstreamError?.code === "official_login_invalidated") {
        return json(res, upstream.status, { error: upstreamError });
      }
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      res.end(text);
      return;
    }
    logEvent({ route, status: 200, durationMs: Date.now() - started, ok: true, contextMode: upstream?.codex_relay?.context_mode || contextMode, usage: normalizeUsage(upstream?.usage) });
    json(res, 200, upstream);
  } catch (error) {
    logEvent({ route, status: error.statusCode || 502, durationMs: Date.now() - started, ok: false, contextMode });
    if (error.statusCode) throw error;
    throw apiError(502, `The local Router could not reach ${route.kind === "official" ? "the official Codex service" : route.provider.name}. Check that route's API address and network connection.`, "upstream_unreachable");
  }
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  if (method === "GET" && url.pathname === "/api/state") {
    synchronizeOfficialLogin();
    return json(res, 200, stateView());
  }
  if (method === "GET" && url.pathname === "/api/apply-preview") return json(res, 200, applyPreview());
  if (method === "GET" && url.pathname === "/api/restore-preview") return json(res, 200, restorePreview());
  if (method === "GET" && url.pathname === "/api/login-status") return json(res, 200, codexLoginStatus());
  if (method === "GET" && url.pathname === "/api/session-inventory") return json(res, 200, sessionInventoryView());
  if (method === "POST" && url.pathname === "/api/official/verify") {
    const login = codexLoginStatus();
    const settings = loadSettings();
    const captured = login.signedIn ? captureOfficialAuth() : { captured: false };
    settings.official.verified = Boolean(login.signedIn && captured.captured);
    settings.official.lastCheckedAt = new Date().toISOString();
    saveSettings(settings);
    return json(res, settings.official.verified ? 200 : 409, { ...login, verified: settings.official.verified, credentialStored: Boolean(captured.captured) });
  }
  if (method === "POST" && url.pathname === "/api/context-cache") return saveContextCachePreference(req, res);
  if (method === "POST" && url.pathname === "/api/connection/repair") {
    const result = repairRelayConnectionIfNeeded();
    if (result.error && !result.externalTakeover) throw apiError(409, result.error, "relay_repair_failed");
    return json(res, result.externalTakeover ? 409 : 200, result);
  }
  if (method === "POST" && url.pathname === "/api/providers") return saveProvider(req, res);
  if (method === "DELETE" && /^\/api\/providers\/[^/]+$/.test(url.pathname)) return deleteProvider(res, url);
  if (method === "GET" && /^\/api\/providers\/[^/]+\/models$/.test(url.pathname)) return await listProviderModels(res, url);
  if (method === "POST" && /^\/api\/providers\/[^/]+\/balance$/.test(url.pathname)) return await refreshProviderBalance(res, url);
  if (method === "POST" && /^\/api\/providers\/[^/]+\/test-model$/.test(url.pathname)) return await testProviderModel(req, res, url);
  if (method === "POST" && url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/key")) return saveKey(req, res, url);
  if (method === "POST" && url.pathname === "/api/slots") return saveSlot(req, res);
  if (method === "DELETE" && url.pathname.startsWith("/api/slots/")) return deleteSlot(res, url);
  if (method === "POST" && url.pathname === "/api/apply") return await apply(res);
  if (method === "POST" && url.pathname === "/api/restore") return restore(res);
  json(res, 404, { error: { message: "Unknown API route." } });
}

async function saveProvider(req, res) {
  const input = await bodyJson(req);
  const settings = loadSettings();
  const index = settings.providers.findIndex((provider) => provider.id === input.id);
  const existing = index >= 0 ? settings.providers[index] : null;
  const provider = {
    id: String(input.id || crypto.randomUUID()), name: String(input.name || "").trim(), baseUrl: String(input.baseUrl || "").trim().replace(/\/+$/, ""),
    endpointUrl: String(input.endpointUrl || "").trim(), modelListUrl: String(input.modelListUrl || "").trim(),
    balanceUrl: String(input.balanceUrl || "").trim(), balancePath: String(input.balancePath || "").trim().replace(/^\.+|\.+$/g, "").slice(0, 160),
    balanceCurrency: String(input.balanceCurrency || "").trim().toUpperCase().slice(0, 12), balanceSnapshot: existing?.balanceSnapshot || null,
    apiType: input.apiType === "responses" ? "responses" : "chat_completions", note: String(input.note || "").trim(),
    authHeaderName: String(input.authHeaderName || "authorization").trim().toLowerCase(), authHeaderPrefix: String(input.authHeaderPrefix ?? "Bearer "),
    extraHeaders: input.extraHeaders && typeof input.extraHeaders === "object" ? input.extraHeaders : {},
  };
  if (!provider.name || !/^https?:\/\//i.test(provider.baseUrl) || [provider.endpointUrl, provider.modelListUrl, provider.balanceUrl].some((value) => value && !/^https?:\/\//i.test(value))) throw apiError(400, "Provider name and valid API addresses are required.", "provider_invalid");
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,80}$/i.test(provider.authHeaderName) || /[\r\n]/.test(provider.authHeaderPrefix)) throw apiError(400, "Authentication header configuration is invalid.", "provider_auth_invalid");
  if (index >= 0) settings.providers[index] = provider; else settings.providers.push(provider);
  replaceSettings(settings);
  json(res, 200, { provider: providerView(provider) });
}

async function saveKey(req, res, url) {
  const id = decodeURIComponent(url.pathname.split("/")[3]);
  const settings = loadSettings();
  if (!settings.providers.some((provider) => provider.id === id)) throw apiError(404, "Provider not found.", "provider_not_found");
  const input = await bodyJson(req);
  saveProviderKey(id, String(input.apiKey || "").trim());
  json(res, 200, { providerId: id, hasApiKey: hasProviderKey(id) });
}

async function listProviderModels(res, url) {
  const provider = providerFromApiPath(url);
  const key = providerKey(provider.id);
  if (!key) throw apiError(400, `No API Key is saved for ${provider.name}.`, "provider_key_missing");
  const candidates = modelListEndpoints(provider);
  const attempts = [];
  for (const endpoint of candidates) {
    try {
      const response = await fetch(endpoint, { headers: providerRequestHeaders(provider, key), signal: AbortSignal.timeout(10_000) });
      const raw = await response.text();
      if (!response.ok) {
        attempts.push(`${endpoint}: HTTP ${response.status}${upstreamErrorMessage(raw) ? ` (${upstreamErrorMessage(raw)})` : ""}`);
        continue;
      }
      const models = modelsFromPayload(raw);
      if (models.length) return json(res, 200, { providerId: provider.id, models, endpoint });
      attempts.push(`${endpoint}: returned JSON without recognizable model IDs`);
    } catch (error) {
      attempts.push(`${endpoint}: ${error.name === "TimeoutError" ? "timed out" : "could not be reached"}`);
    }
  }
  throw apiError(502, `${provider.name} did not return a usable model list. ${attempts.join("; ") || "No compatible endpoint was available."} You can still choose a preset or enter the exact model ID manually.`, "provider_models_invalid");
}

async function refreshProviderBalance(res, url) {
  const provider = providerFromApiPath(url);
  if (!provider.balanceUrl) throw apiError(400, `${provider.name} has no balance query address configured. Add it under Advanced compatibility settings.`, "provider_balance_unconfigured");
  const key = providerKey(provider.id);
  if (!key) throw apiError(400, `No API Key is saved for ${provider.name}.`, "provider_key_missing");

  let response;
  try {
    response = await fetch(provider.balanceUrl, { headers: providerRequestHeaders(provider, key), signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw apiError(502, `Could not reach ${provider.name}'s balance endpoint. Check its address and network connection.`, "provider_balance_unreachable");
  }
  const raw = await response.text();
  if (!response.ok) {
    const detail = upstreamErrorMessage(raw);
    throw apiError(response.status, `Balance query failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`, "provider_balance_failed");
  }
  const balance = balanceFromPayload(raw, provider);
  if (!balance) throw apiError(502, `${provider.name}'s balance response did not contain a readable numeric balance. Set the optional balance field path if this provider uses a custom response.`, "provider_balance_invalid");

  const settings = loadSettings();
  const index = settings.providers.findIndex((item) => item.id === provider.id);
  if (index < 0) throw apiError(404, "Provider not found.", "provider_not_found");
  settings.providers[index].balanceSnapshot = balance;
  replaceSettings(settings);
  json(res, 200, { providerId: provider.id, balance });
}

async function testProviderModel(req, res, url) {
  const provider = providerFromApiPath(url);
  const key = providerKey(provider.id);
  if (!key) throw apiError(400, `No API Key is saved for ${provider.name}.`, "provider_key_missing");
  const input = await bodyJson(req);
  const model = String(input.model || "").trim();
  if (!model || model.length > 120) throw apiError(400, "Enter a valid model ID before testing.", "model_id_invalid");
  const responses = provider.apiType === "responses";
  const endpoint = provider.endpointUrl || `${provider.baseUrl.replace(/\/+$/, "")}${responses ? "/responses" : "/chat/completions"}`;
  const payload = responses
    ? { model, input: "Reply with OK.", max_output_tokens: 8, stream: false }
    : { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 8, stream: false };
  const started = Date.now();
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: providerRequestHeaders(provider, key),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw apiError(502, `Could not reach ${provider.name}. Check its API address and network connection.`, "provider_test_unreachable");
  }
  const raw = await response.text();
  if (!response.ok) {
    const upstreamMessage = upstreamErrorMessage(raw);
    throw apiError(response.status, `Model test failed with HTTP ${response.status}${upstreamMessage ? `: ${upstreamMessage}` : "."}`, "provider_model_test_failed");
  }
  json(res, 200, { ok: true, providerId: provider.id, model, status: response.status, durationMs: Date.now() - started, usage: usageFromResponseText(raw) });
}

function providerFromApiPath(url) {
  const id = decodeURIComponent(url.pathname.split("/")[3] || "");
  const provider = loadSettings().providers.find((item) => item.id === id);
  if (!provider) throw apiError(404, "Provider not found.", "provider_not_found");
  return provider;
}

function providerRequestHeaders(provider, key) {
  return {
    "content-type": "application/json",
    ...(provider.extraHeaders || {}),
    [provider.authHeaderName || "authorization"]: `${provider.authHeaderPrefix ?? "Bearer "}${key}`,
  };
}

function modelListEndpoints(provider) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const candidates = provider.modelListUrl ? [provider.modelListUrl] : [];
  candidates.push(`${base}/models`);
  if (!/\/v\d+(?:\.\d+)?$/i.test(base)) candidates.push(`${base}/v1/models`);
  return [...new Set(candidates)];
}

function modelsFromPayload(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return []; }
  const lists = findModelLists(payload);
  const values = lists.flatMap((source) => source.map(modelIdFromItem));
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()).slice(0, 500))].sort((a, b) => a.localeCompare(b));
}

function findModelLists(payload) {
  if (Array.isArray(payload)) return [payload];
  const lists = [];
  const pending = [{ value: payload, depth: 0 }];
  const listKeys = new Set(["data", "models", "model_list", "modellist", "available_models", "availablemodels", "items", "results", "list"]);
  while (pending.length) {
    const { value, depth } = pending.shift();
    if (!value || typeof value !== "object" || depth > 3) continue;
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child) && listKeys.has(key.toLowerCase())) lists.push(child);
      else if (child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
    }
  }
  return lists;
}

function modelIdFromItem(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.id || item.model_id || item.modelId || item.name || item.model || item.slug || item.code || "";
}

function balanceFromPayload(raw, provider) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  const value = provider.balancePath ? valueAtPath(payload, provider.balancePath) : firstBalanceValue(payload);
  const amount = numericValue(value);
  if (amount === null) return null;
  const currency = provider.balanceCurrency || currencyFromPayload(value) || currencyFromPayload(payload);
  return { amount, currency, checkedAt: new Date().toISOString(), source: provider.balancePath || "automatic" };
}

function valueAtPath(payload, pathValue) {
  return String(pathValue || "").split(".").filter(Boolean).reduce((value, part) => {
    if (value === null || value === undefined) return undefined;
    return value[part];
  }, payload);
}

function firstBalanceValue(payload) {
  const preferredKeys = new Set(["balance", "available_balance", "availablebalance", "remaining", "remaining_balance", "remainingbalance", "credit", "credits", "amount", "total_balance", "totalbalance"]);
  const pending = [{ value: payload, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.shift();
    if (!value || typeof value !== "object" || depth > 3) continue;
    for (const [key, child] of Object.entries(value)) {
      if (preferredKeys.has(key.toLowerCase()) && numericValue(child) !== null) return child;
      if (child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
    }
  }
  return undefined;
}

function numericValue(value) {
  const source = value && typeof value === "object" ? value.amount ?? value.value ?? value.balance : value;
  if (typeof source === "string" && !/^[-+]?\d+(?:\.\d+)?$/.test(source.trim())) return null;
  const number = Number(source);
  return Number.isFinite(number) ? number : null;
}

function currencyFromPayload(value) {
  if (!value || typeof value !== "object") return "";
  return String(value.currency || value.unit || value.currency_code || "").trim().toUpperCase().slice(0, 12);
}

function upstreamErrorMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.error?.message || parsed?.message || "").replace(/[\r\n]+/g, " ").slice(0, 240);
  } catch { return ""; }
}

async function saveSlot(req, res) {
  const input = await bodyJson(req);
  const settings = loadSettings();
  const slot = {
    id: String(input.id || ""), displayName: String(input.displayName || "").trim(), providerId: String(input.providerId || ""), upstreamModel: String(input.upstreamModel || "").trim(),
    contextWindow: Number(input.contextWindow) || 128000, supportsImages: Boolean(input.supportsImages), dropParams: Array.isArray(input.dropParams) ? input.dropParams.map(String) : ["response_format", "parallel_tool_calls"],
  };
  if (!/^relay-third-party-[1-5]$/.test(slot.id)) throw apiError(400, "Invalid model slot.", "slot_invalid");
  if (!slot.displayName || !slot.providerId || !slot.upstreamModel) throw apiError(400, "Display name, provider, and upstream model are required.", "slot_incomplete");
  if (!settings.providers.some((provider) => provider.id === slot.providerId)) throw apiError(400, "Choose an existing provider first.", "slot_provider_missing");
  const index = settings.thirdPartySlots.findIndex((item) => item.id === slot.id);
  if (index >= 0) settings.thirdPartySlots[index] = slot; else settings.thirdPartySlots.push(slot);
  replaceSettings(settings);
  json(res, 200, { slot });
}

function deleteSlot(res, url) {
  const id = decodeURIComponent(url.pathname.split("/").pop());
  const settings = loadSettings();
  settings.thirdPartySlots = settings.thirdPartySlots.filter((slot) => slot.id !== id);
  replaceSettings(settings);
  json(res, 200, { removed: id });
}

function deleteProvider(res, url) {
  const id = decodeURIComponent(url.pathname.split("/").pop());
  const settings = loadSettings();
  if (settings.thirdPartySlots.some((slot) => slot.providerId === id)) throw apiError(409, "This provider is still used by a model slot. Clear or change that slot first.", "provider_in_use");
  if (!settings.providers.some((provider) => provider.id === id)) throw apiError(404, "Provider not found.", "provider_not_found");
  settings.providers = settings.providers.filter((provider) => provider.id !== id);
  saveProviderKey(id, "");
  replaceSettings(settings);
  json(res, 200, { removed: id });
}

async function saveContextCachePreference(req, res) {
  const input = await bodyJson(req);
  const settings = loadSettings();
  settings.contextCache.persist = Boolean(input.persist);
  saveSettings(settings);
  if (settings.contextCache.persist) saveContextCache(chatHistory.snapshot());
  else {
    clearTimeout(contextCacheTimer);
    clearContextCache();
  }
  json(res, 200, { persist: settings.contextCache.persist });
}

async function apply(res) {
  synchronizeOfficialLogin();
  const preview = applyPreview();
  if (!preview.ready) throw apiError(400, preview.problems[0], "apply_preflight_failed");
  const { settings, catalog } = preview;
  const location = paths();
  try {
    await verifyLocalRouter(settings, catalog);
  } catch {
    throw apiError(503, "The local Router did not pass its health check. Codex configuration was not changed; keep Codex Relay open and try again.", "router_health_failed");
  }

  // Capture the exact state that existed at this handoff before restoring the
  // official login needed for Relay's two official routes.
  const priorApplication = relayApplicationStatus();
  const handoff = captureRelayHandoff({ replaceExisting: !priorApplication.applied });
  let applied;
  try {
    applied = applyRelayConfig({ model: catalog.models[0].slug, catalogPath: location.catalog, routerUrl: `http://127.0.0.1:${settings.router.port}/v1`, deferCommit: true, handoff });
    await verifyLocalRouter(settings, catalog);
    writeCatalog(catalog);
    const sessionProtection = verifySessionProtection(handoff.snapshot.sessions);
    if (!sessionProtection.safe) throw apiError(409, "Relay stopped because the existing Codex conversation files could not be verified unchanged. The previous Codex configuration will be restored automatically.", "session_protection_failed");
    const application = commitRelayConfig(applied.transaction);
    settings.router.running = true;
    saveSettings(settings);
    json(res, 200, { applied: true, verified: application.configMatches, sessionProtected: true, catalog: location.catalog, handoffCreated: handoff.created, snapshot: handoff.snapshot });
  } catch (error) {
    if (applied?.transaction) rollbackRelayConfig(applied.transaction);
    if (handoff.created) discardRelayHandoff(handoff);
    if (error.statusCode) throw error;
    throw apiError(503, "Relay could not verify the new configuration, so the previous Codex configuration and authentication were restored automatically. Nothing needs to be repaired manually.", "apply_rolled_back");
  }
}

function restore(res) {
  if (!restorePreview().available) throw apiError(409, "Relay is not currently applied, so there is no active handoff to restore.", "handoff_missing");
  const handoffProtection = verifySessionProtection(relayHandoffSnapshot()?.sessions);
  if (!handoffProtection.safe) throw apiError(409, "Relay will not restore configuration because one or more conversations that existed before Relay can no longer be verified. No Codex files were changed.", "session_protection_failed");
  const sessionBaseline = currentSessionInventory();
  const result = restorePreRelayState(sessionBaseline);
  if (!result.restored) throw apiError(409, "The active Relay handoff is no longer available.", "handoff_missing");
  const settings = loadSettings();
  settings.router.running = false;
  saveSettings(settings);
  json(res, 200, {
    restored: true,
    verified: result.verified,
    sessionProtected: Boolean(result.sessionProtection?.safe),
    configurationChanged: result.configurationChanged,
    message: result.verified
      ? "The exact Codex state from before this Relay session was restored and verified. Relay models, provider settings, and encrypted keys were kept."
      : "Codex files were restored, but verification did not complete. The active handoff was kept so it can be retried; check config.toml before restarting Codex.",
  });
}

function applyPreview() {
  const settings = loadSettings();
  const catalog = buildModelCatalog(settings);
  const login = codexLoginStatus();
  const config = codexConfigPreflight();
  const application = relayApplicationStatus();
  const officialCredentialStored = hasOfficialAuthSnapshot();
  const officialReady = Boolean(login.signedIn && settings.official.verified && officialCredentialStored);
  const onboarding = onboardingState(settings, config, login, application);
  const problems = [];
  if (!server?.listening) problems.push("The local Router is not running.");
  if (!config.writable) problems.push("Codex config.toml is not writable. Check the file permissions before applying.");
  if (!catalog.models.length) problems.push("Configure at least one third-party model or verify official sign-in first.");
  const sessions = currentSessionInventory();
  if (!sessions.filesAvailable) problems.push("Codex conversation files could not be inventoried, so Relay will not change the configuration.");
  if (settings.official.verified && !officialReady) problems.push("Official routes need a current Codex account sign-in. Sign in again before applying.");
  const missingKeys = [...new Set(activeRoutes(settings).filter((route) => route.kind === "third_party" && !hasProviderKey(route.provider.id)).map((route) => route.provider.name))];
  if (missingKeys.length) problems.push(`Missing API Key for: ${missingKeys.join(", ")}.`);
  const snapshot = relayHandoffSnapshot();
  return {
    ready: problems.length === 0,
    problems,
    settings,
    catalog,
    routes: catalog.models.map((model) => ({ id: model.slug, displayName: model.display_name })),
    snapshot,
    application,
    officialCredentialStored,
    onboarding,
    createsHandoff: !application.applied,
    config: {
      writable: config.writable,
      configExists: config.configExists,
      providerIdentity: config.providerIdentity,
      targetProviderIdentity: "openai",
      writes: ["model_provider", "model", "model_catalog_json", "openai_base_url"],
    },
  };
}

function stateView(repair = null) {
  const settings = loadSettings();
  const login = codexLoginStatus();
  const application = relayApplicationStatus();
  const config = codexConfigPreflight();
  const listening = Boolean(server?.listening);
  return {
    router: {
      host: settings.router.host,
      port: settings.router.port,
      configured: Boolean(settings.router.running),
      listening,
      configMatches: application.configMatches,
      active: Boolean(settings.router.running && listening && application.configMatches),
    }, connection: {
      providerIdentity: config.providerIdentity,
      openaiBaseUrl: config.openaiBaseUrl || null,
      providerBaseUrl: config.providerBaseUrl || null,
      expectedProviderIdentity: "openai",
      expectedBaseUrl: `http://127.0.0.1:${settings.router.port}/v1`,
      repaired: Boolean(repair?.repaired),
      repairError: repair?.error || null,
      repairEligible: Boolean(settings.router.running && application.applied && application.relayManaged && !application.configMatches),
      externalTakeover: Boolean(settings.router.running && application.applied && !application.relayManaged && !application.configMatches),
    }, official: { ...settings.official, login, credentialStored: hasOfficialAuthSnapshot() }, contextCache: settings.contextCache,
    providers: settings.providers.map(providerView), thirdPartySlots: settings.thirdPartySlots,
    routes: activeRoutes(settings).map((route) => ({ id: route.id, displayName: route.displayName, kind: route.kind, providerName: route.provider?.name || "Official Codex", upstreamModel: route.upstreamModel })),
    events: events.slice(0, 12), snapshot: relayHandoffSnapshot(), application, onboarding: onboardingState(settings, config, login, application), restorePreview: restorePreview(), paths: paths(),
  };
}

export function onboardingState(settings, config, login, application) {
  const hasRoutes = activeRoutes(settings).length > 0;
  if (!hasRoutes) return { stage: "configure_routes" };
  if (application.configMatches) return { stage: "relay_active" };
  if (settings.official.verified) return { stage: "ready_with_official" };
  if (login.signedIn) return { stage: "verify_official" };
  return { stage: "ready_third_party" };
}

async function verifyLocalRouter(settings, catalog) {
  const baseUrl = `http://${ROUTER_HOST}:${settings.router.port}`;
  const timeout = AbortSignal.timeout(2_000);
  const health = await fetch(`${baseUrl}/health`, { signal: timeout });
  if (!health.ok) throw new Error(`Health endpoint returned ${health.status}.`);
  const healthBody = await health.json();
  const expectedRoutes = catalog.models.map((model) => model.slug);
  if (!healthBody?.ok || !sameItems(healthBody.routes, expectedRoutes)) throw new Error("Health endpoint returned a different route set.");

  const modelCatalog = await fetch(`${baseUrl}/model-catalog.json`, { signal: AbortSignal.timeout(2_000) });
  if (!modelCatalog.ok) throw new Error(`Model catalog endpoint returned ${modelCatalog.status}.`);
  const catalogBody = await modelCatalog.json();
  if (!sameItems(catalogBody?.models?.map((model) => model.slug), expectedRoutes)) throw new Error("Model catalog returned a different route set.");
}

function sameItems(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sessionInventoryView() {
  const baseline = relayHandoffSnapshot()?.sessions || null;
  const current = currentSessionInventory();
  const protection = baseline ? verifySessionProtection(baseline) : null;
  const comparable = Boolean(protection?.comparable);
  const same = Boolean(protection?.safe);
  return { baseline, current, comparable, same, protection };
}

function providerView(provider) { return { ...provider, hasApiKey: hasProviderKey(provider.id) }; }
export function officialUpstreamFailure(route, status, rawText) {
  if (route.kind !== "official" || status !== 401) return null;
  let upstreamCode = "";
  try { upstreamCode = String(JSON.parse(rawText)?.error?.code || JSON.parse(rawText)?.code || ""); } catch { /* Preserve the upstream payload below. */ }
  if (upstreamCode !== "token_invalidated" && !/token has been invalidated/i.test(rawText)) return null;
  return {
    code: "official_login_invalidated",
    message: "The official Codex login token is no longer valid. Sign in again in Codex, then open Codex Relay and verify the official channel before retrying.",
  };
}
function logEvent(event) { events.unshift({ at: new Date().toISOString(), ...event, usage: normalizeUsage(event.usage), route: { id: event.route.id, displayName: event.route.displayName, kind: event.route.kind, providerName: event.route.provider?.name || "Official Codex", upstreamModel: event.route.upstreamModel } }); if (events.length > 50) events.pop(); }

function usageFromResponseText(rawText) {
  let latest = null;
  try { latest = JSON.parse(rawText)?.usage || null; } catch { /* SSE is handled below. */ }
  for (const line of String(rawText || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event?.response?.usage) latest = event.response.usage;
      else if (event?.usage) latest = event.usage;
    } catch { /* Ignore non-JSON SSE frames. */ }
  }
  return normalizeUsage(latest);
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = finiteToken(usage.input ?? usage.input_tokens ?? usage.prompt_tokens);
  const output = finiteToken(usage.output ?? usage.output_tokens ?? usage.completion_tokens);
  const total = finiteToken(usage.total ?? usage.total_tokens) ?? (input !== null && output !== null ? input + output : null);
  if (input === null && output === null && total === null) return null;
  return { input, output, total };
}

function finiteToken(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
async function serveUi(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = path.resolve(PUBLIC, `.${pathname}`);
  if (!target.startsWith(`${PUBLIC}${path.sep}`)) return json(res, 403, { error: { message: "Forbidden." } });
  try {
    const content = await readFile(target);
    res.writeHead(200, {
      "content-type": contentType(target),
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(content);
  } catch { json(res, 404, { error: { message: "Not found." } }); }
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}
function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
function apiError(statusCode, message, code) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
async function bodyJson(req) { return readJsonRequest(req, 2 * 1024 * 1024); }
export async function pipeEventStream(res, upstream) {
  const chunks = [];
  const contentType = upstream.headers.get("content-type") || "text/event-stream; charset=utf-8";
  res.writeHead(upstream.status, { "content-type": contentType, "cache-control": upstream.headers.get("cache-control") || "no-cache" });
  try {
    const reader = upstream.body?.getReader();
    if (!reader) throw new Error("Upstream response body is missing.");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      if (!res.write(chunk)) await waitForDrain(res);
    }
    res.end();
    return { text: Buffer.concat(chunks).toString("utf8"), error: false };
  } catch {
    if (!res.writableEnded) res.end();
    return { text: Buffer.concat(chunks).toString("utf8"), error: true };
  }
}
function waitForDrain(res) { return new Promise((resolve) => { res.once("drain", resolve); res.once("close", resolve); }); }
function abortSignal(req, res) {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });
  return controller.signal;
}

export function createRelayServer() {
  server = app();
  server.on("error", (error) => console.error(`Codex Relay server error: ${error.message}`));
  server.on("close", () => console.log("Codex Relay stopped listening."));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createRelayServer().listen(ROUTER_PORT, ROUTER_HOST, () => console.log(`Codex Relay is ready at http://${ROUTER_HOST}:${ROUTER_PORT}`));
}
