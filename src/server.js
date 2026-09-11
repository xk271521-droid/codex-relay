import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createArchivePathRepairMonitor } from "./archive-path-repair-monitor.js";
import { buildModelCatalog, activeRoutes } from "./catalog.js";
import { computerUseEnvironment } from "./computer-use-status.js";
import { compactCapabilityStatus, compactCapabilityTarget } from "./compact-capabilities.js";
import { closeCompactCapabilityWriter, compactCapabilityProfiles, enqueueCompactCapabilityResult } from "./compact-capability-persistence.js";
import { ROUTER_HOST, ROUTER_PORT, THIRD_PARTY_SLOT_IDS } from "./constants.js";
import { detectCodexClientVersion } from "./codex-version.js";
import { closeCcSwitchForHandoff, externalProcessStatus, reopenCcSwitchAfterRollback } from "./external-processes.js";
import { fetchOfficialModels } from "./official-models.js";
import { fetchOfficialUsageWithTimeout } from "./official-usage.js";
import { applyTheme, ensureThemeAgent, restoreDefaultTheme, selectTheme, themeView } from "./theme-manager.js";
import { createChatHistory, forwardOfficialImageEdit, forwardOfficialImageGeneration, forwardResponses, forwardResponsesCompact, hasCompactionTrigger, isEventStreamResponse, providerCompactEndpoint, recordPassthroughResponse, responseContextMode, responseDiagnostics, responseHistoryInfo, responseManagesHistory, responseReasoningMode, routeForRequest, routingContextMode } from "./router.js";
import { IMAGE_EDIT_BODY_LIMIT_BYTES, readJsonRequest, readRawRequest, RESPONSES_BODY_LIMIT_BYTES } from "./request-body.js";
import { closeRequestHistoryWriter, clearRequestHistory, enqueueRequestHistory, flushRequestHistory, listRequestHistory, primeRequestHistoryCache, requestHistoryCachedSummary, requestHistoryWriterState, usageStatistics } from "./request-history.js";
import { closeContextCacheWriter, enqueueContextCache, flushContextCacheWriter } from "./context-cache.js";
import { applyReasoningToChatPayload, applyReasoningToResponsesPayload, capabilityFromModelItem, REASONING_PRESETS, resolveModelCapability } from "./model-capabilities.js";
import { fetchProvider, normalizeProviderProxyUrl, providerNetworkLabel, providerNetworkMode } from "./provider-fetch.js";
import { attachResponsesWebSocket } from "./responses-websocket.js";
import { inspectCodexArchivePathCompatibility, repairCodexArchivePaths, rollbackCodexArchivePaths } from "./session-history.js";
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
  officialAccessToken,
  officialAccountId,
  paths,
  providerKey,
  relayApplicationStatus,
  relayOfficialAuthPlan,
  relayPublicationStatus,
  refreshRelayHandoffSessionBaseline,
  replaceSettings,
  rollbackRelayConfig,
  relayHandoffSnapshot,
  restorePreview,
  restorePreRelayState,
  saveProviderKey,
  saveSettings,
  switchToOfficialDirect,
  verifySessionProtection,
  writeCatalog,
} from "./store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const events = [];
const MODEL_HEALTH_GOOD_MS = 3_000;
const MODEL_HEALTH_RECENT_REQUEST_MS = 30 * 60 * 1_000;
const MODEL_HEALTH_PROBE_TIMEOUT_MS = 20_000;
const THIRD_PARTY_HTTP_FIRST_BYTE_TIMEOUT_MS = 60_000;
const THIRD_PARTY_HTTP_STREAM_IDLE_TIMEOUT_MS = 120_000;
const modelHealthState = { running: false, startedAt: null, completedAt: null, entries: new Map(), promise: null };
const thirdPartyInFlight = new Map();
let thirdPartyInFlightSequence = 0;
let contextCacheTimer;
const chatHistory = createChatHistory(loadContextCache(), (entries) => {
  if (!loadSettings().contextCache.persist) return;
  clearTimeout(contextCacheTimer);
  contextCacheTimer = setTimeout(() => {
    if (!loadSettings().contextCache.persist) return;
    try { enqueueContextCache(entries); } catch (error) { console.error(`Codex Relay could not queue context cache persistence: ${error.message}`); }
  }, 1_200);
});
let server;
let archivePathRepairMonitor;
let lastOfficialAuthState = null;
let officialUsageSnapshot = null;

async function flushContextCache() {
  clearTimeout(contextCacheTimer);
  if (!loadSettings().contextCache.persist) return;
  try {
    enqueueContextCache(chatHistory.snapshot());
    await flushContextCacheWriter();
  }
  catch (error) { console.error(`Codex Relay could not flush context cache: ${error.message}`); }
}

function synchronizeOfficialLogin() {
  const login = codexLoginStatus();
  const signedIn = Boolean(login.signedIn && login.authType === "official");
  const savedOfficial = signedIn || hasOfficialAuthSnapshot();
  const officialAvailable = officialSessionAvailable(login, savedOfficial);
  const settings = loadSettings();
  let changed = settings.official.verified !== officialAvailable;
  if (!officialAvailable) officialUsageSnapshot = null;
  if (signedIn) {
    const captured = captureOfficialAuth();
    if (!captured.captured) return { login, changed: false };
    const accountFingerprint = officialAccountFingerprint();
    if (officialUsageSnapshot?.accountFingerprint !== accountFingerprint) officialUsageSnapshot = null;
    if (settings.official.accountFingerprint && accountFingerprint && settings.official.accountFingerprint !== accountFingerprint) {
      settings.official.availableModels = [];
      settings.official.modelsFetchedAt = null;
      changed = true;
    }
    if (accountFingerprint && settings.official.accountFingerprint !== accountFingerprint) {
      settings.official.accountFingerprint = accountFingerprint;
      changed = true;
    }
    settings.official.lastCheckedAt = new Date().toISOString();
    changed ||= lastOfficialAuthState !== "official";
  }
  settings.official.verified = officialAvailable;
  if (changed) {
    saveSettings(settings);
    writeCatalog(buildModelCatalog(settings));
  }
  lastOfficialAuthState = signedIn ? "official" : savedOfficial ? "saved_official" : "not_official";
  return { login, changed };
}

function repairRelayConnectionIfNeeded() {
  const settings = loadSettings();
  const application = relayApplicationStatus();
  const expectedRoutes = activeRoutes(settings).map((route) => route.id);
  const routerUrl = `http://127.0.0.1:${settings.router.port}/v1`;
  const catalog = buildModelCatalog(settings);
  const publication = relayPublicationStatus({ expectedRoutes, expectedCatalog: catalog, routerUrl });
  if (!settings.router.running || !application.applied || (application.configMatches && publication.verified)) return { repaired: false, attempted: false, application, publication };
  if (!application.relayManaged) return { repaired: false, attempted: false, application, externalTakeover: true, error: "Codex configuration is now controlled by another tool." };
  const handoff = relayHandoffSnapshot();
  if (!handoff) return { repaired: false, attempted: false, application, error: "Relay handoff is missing." };
  const authHandoff = relayOfficialAuthPlan({ restoreOfficial: settings.official.verified });
  const externalProcesses = externalProcessStatus();
  if (authHandoff.requiresRestore && externalProcesses.codexRunning) {
    return {
      repaired: false,
      attempted: false,
      application,
      authHandoff,
      error: "Codex is currently running. Close Codex completely before Relay restores its saved official sign-in.",
    };
  }
  const sessionBaseline = currentSessionInventory();
  if (!sessionBaseline.filesAvailable) return { repaired: false, attempted: false, application, error: "Conversation files could not be inventoried." };
  if (!catalog.models.length) return { repaired: false, attempted: false, application, error: "No Relay model is currently available." };
  let applied;
  try {
    writeCatalog(catalog);
    applied = applyRelayConfig({
      model: catalog.models[0].slug,
      catalogPath: paths().catalog,
      routerUrl,
      deferCommit: true,
      handoff: { created: false, snapshot: handoff },
      restoreOfficial: settings.official.verified,
    });
    const protection = verifySessionProtection(sessionBaseline);
    if (!protection.safe) throw apiError(409, "Conversation protection failed during automatic Relay repair.", "session_protection_failed");
    const preparedPublication = relayPublicationStatus({ expectedRoutes, expectedCatalog: catalog, routerUrl });
    if (!preparedPublication.configTargetsRelay || !preparedPublication.catalogReadable || !preparedPublication.catalogMatches || !preparedPublication.catalogContentMatches) {
      throw apiError(409, "Relay repair could not verify the Codex model publication.", "relay_publication_failed");
    }
    const repairedApplication = commitRelayConfig(applied.transaction);
    const repairedPublication = relayPublicationStatus({ expectedRoutes, expectedCatalog: catalog, routerUrl });
    if (!repairedPublication.verified) throw apiError(409, "Relay repair did not become active after verification.", "relay_publication_failed");
    return { repaired: true, attempted: true, application: repairedApplication, publication: repairedPublication, authHandoff: applied.authHandoff };
  } catch (error) {
    if (applied?.transaction) rollbackRelayConfig(applied.transaction);
    return { repaired: false, attempted: true, application: relayApplicationStatus(), error: String(error.message || "Automatic Relay repair failed.") };
  }
}

function app(options = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname.startsWith("/api/") && req.method !== "GET" && !validManagementOrigin(req)) throw apiError(403, "The local management request origin is not allowed.", "origin_not_allowed");
      if (req.method === "GET" && url.pathname === "/health") {
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
      if (req.method === "POST" && ["/v1/responses", "/responses"].includes(url.pathname)) return await handleResponses(req, res, thirdPartyHttpLimits(options.thirdPartyHttp));
      if (req.method === "POST" && ["/v1/responses/compact", "/responses/compact"].includes(url.pathname)) return await handleResponsesCompact(req, res);
      if (req.method === "POST" && ["/v1/images/generations", "/images/generations"].includes(url.pathname)) return await handleImageGeneration(req, res);
      if (req.method === "POST" && ["/v1/images/edits", "/images/edits"].includes(url.pathname)) return await handleImageEdit(req, res);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      return await serveUi(req, res, url);
    } catch (error) {
      const status = error.statusCode || 500;
      console.error(`Codex Relay request failed (${status}): ${error.message || "Unexpected server error."}`);
      if (!res.headersSent) json(res, status, { error: { message: error.message || "Unexpected server error.", code: error.code || "relay_error", stage: error.stage || null } });
      else if (!res.writableEnded) res.end();
    }
  });
}

function validManagementOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = String(req.headers.host || "");
    const requestPort = host.match(/:(\d+)$/)?.[1] || "80";
    return parsed.protocol === "http:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase())
      && (parsed.port || "80") === requestPort;
  } catch { return false; }
}

async function handleResponses(req, res, thirdPartyHttp = thirdPartyHttpLimits()) {
  const settings = loadSettings();
  if (!settings.router.running) throw apiError(503, "Codex Relay is not applied. Open the local manager and apply a configured route first.", "router_disabled");
  const body = await readJsonRequest(req, RESPONSES_BODY_LIMIT_BYTES);
  const route = routeForRequest(settings, body.model);
  const contextMode = routingContextMode(settings, body, route, chatHistory);
  const request = requestMetrics(body, req.headers);
  const started = Date.now();
  const requestAbort = requestAbortController(req, res);
  const thirdPartyCompaction = route.kind === "third_party" && hasCompactionTrigger(body);
  const enforceStreamingFirstByte = route.kind === "third_party" && Boolean(body.stream) && !thirdPartyCompaction;
  const inFlight = trackThirdPartyInFlight(route, requestAbort.signal);
  try {
    const upstreamRequest = forwardResponses({ settings, route, body, headers: req.headers, signal: requestAbort.signal, history: chatHistory, thirdPartyCompactionFirstByteTimeoutMs: thirdPartyHttp.firstByteTimeoutMs });
    const upstream = enforceStreamingFirstByte
      ? await waitForThirdPartyHttpProgress(upstreamRequest, thirdPartyHttp.firstByteTimeoutMs, requestAbort, "Third-party upstream did not return response headers within the configured first-byte timeout.", "upstream_first_byte_timeout")
      : await upstreamRequest;
    const headersAt = Date.now();
    if (upstream instanceof Response) {
      const effectiveContextMode = responseContextMode(upstream) || contextMode;
      const classified = enforceStreamingFirstByte
        ? await waitForThirdPartyHttpProgress(classifyStreamingResponse(upstream, true), remainingThirdPartyHttpTimeout(thirdPartyHttp.firstByteTimeoutMs, started), requestAbort, "Third-party upstream did not send its first response data within the configured first-byte timeout.", "upstream_first_byte_timeout")
        : await classifyStreamingResponse(upstream, Boolean(body.stream));
      if (classified.streaming) {
        const streamed = await pipeEventStream(res, classified.response, { startedAt: started, headersAt, detectedBy: classified.detectedBy, upstreamContentType: classified.upstreamContentType }, route.kind === "third_party" ? {
          firstByteTimeoutMs: thirdPartyHttp.firstByteTimeoutMs,
          streamIdleTimeoutMs: thirdPartyHttp.streamIdleTimeoutMs,
          startedAt: started,
          abortController: requestAbort,
          responseHeaders: thirdPartyResponseHeaders(classified.response.headers, true),
          requireCompletedResponse: true,
        } : {});
        if (classified.response.ok && !streamed.error && !responseManagesHistory(upstream)) recordPassthroughResponse(chatHistory, body, route, streamed.text, req.headers, responseHistoryInfo(upstream));
        const status = streamed.error ? (streamed.statusCode || 502) : classified.response.status;
        const streamFailure = streamed.error && route.kind === "third_party"
          ? thirdPartyStreamFailure(route, streamed.failureCode)
          : null;
        logEvent({ route, status, durationMs: Date.now() - started, ok: classified.response.ok && !streamed.error, contextMode: effectiveContextMode, reasoning: responseReasoningMode(upstream), diagnostics: responseDiagnostics(upstream), request, stream: streamed.metrics, error: streamFailure, usage: usageFromResponseText(streamed.text) });
        return;
      }
      const text = await classified.response.text();
      const upstreamError = classified.response.ok
        ? thirdPartySuccessfulPayloadFailure(route, classified.response.status, text, classified.response.headers.get("content-type"))
        : officialUpstreamFailure(route, classified.response.status, text)
          || thirdPartyUpstreamFailure(route, classified.response.status, text, classified.response.headers.get("content-type"));
      const status = upstreamError && classified.response.ok ? 502 : classified.response.status;
      if (!upstreamError && classified.response.ok && !responseManagesHistory(upstream)) recordPassthroughResponse(chatHistory, body, route, text, req.headers, responseHistoryInfo(upstream));
      logEvent({ route, status, durationMs: Date.now() - started, ok: classified.response.ok && !upstreamError, contextMode: effectiveContextMode, reasoning: responseReasoningMode(upstream), diagnostics: responseDiagnostics(upstream), request, stream: nonStreamingMetrics(body, headersAt - started, classified.upstreamContentType), error: upstreamError, usage: usageFromResponseText(text) });
      if (upstreamError) {
        return json(res, status, { error: upstreamError }, route.kind === "third_party" ? thirdPartyResponseHeaders(classified.response.headers, false, false) : {});
      }
      res.writeHead(classified.response.status, route.kind === "third_party"
        ? thirdPartyResponseHeaders(classified.response.headers)
        : { "content-type": classified.response.headers.get("content-type") || "application/json" });
      res.end(text);
      return;
    }
    logEvent({ route, status: 200, durationMs: Date.now() - started, ok: true, contextMode: upstream?.codex_relay?.context_mode || contextMode, reasoning: responseReasoningMode(upstream), diagnostics: responseDiagnostics(upstream), request, usage: usageFromResponseObject(upstream) });
    json(res, 200, upstream);
  } catch (error) {
    const status = error.statusCode || 502;
    logEvent({ route, status, durationMs: Date.now() - started, ok: false, contextMode, diagnostics: null, request });
    if (error.statusCode) throw error;
    const target = route.kind === "official"
      ? "the official Codex service"
      : `${route.provider.name} using ${providerNetworkLabel(route.provider)}`;
    throw apiError(502, `The local Router could not reach ${target}. Check that route's API address and network setting.`, "upstream_unreachable");
  } finally {
    if (route.kind === "third_party") archivePathRepairMonitor?.notifyThirdPartyTurn();
    inFlight.release();
  }
}

async function handleResponsesCompact(req, res) {
  const settings = loadSettings();
  settings.compactCapabilities = compactCapabilityProfiles(settings.compactCapabilities);
  if (!settings.router.running) throw apiError(503, "Codex Relay is not applied. Open the local manager and apply a configured route first.", "router_disabled");
  const body = await readJsonRequest(req);
  const route = routeForRequest(settings, body.model);
  const started = Date.now();
  const requestAbort = requestAbortController(req, res);
  const inFlight = trackThirdPartyInFlight(route, requestAbort.signal);
  try {
    const upstream = await forwardResponsesCompact({ settings, route, body, headers: req.headers, signal: requestAbort.signal, compactCapabilityRecorder: enqueueCompactCapabilityResult });
    const classified = await classifyStreamingResponse(upstream, Boolean(body.stream));
    if (classified.streaming) {
      const streamed = await pipeEventStream(res, classified.response, { startedAt: started, headersAt: Date.now(), detectedBy: classified.detectedBy, upstreamContentType: classified.upstreamContentType });
      logEvent({ route, status: streamed.error ? 499 : classified.response.status, durationMs: Date.now() - started, ok: classified.response.ok && !streamed.error, contextMode: "compact", diagnostics: responseDiagnostics(upstream), request: requestMetrics(body, req.headers), stream: streamed.metrics, usage: usageFromResponseText(streamed.text) });
      return;
    }
    const text = await classified.response.text();
    logEvent({ route, status: classified.response.status, durationMs: Date.now() - started, ok: classified.response.ok, contextMode: "compact", diagnostics: responseDiagnostics(upstream), request: requestMetrics(body, req.headers), stream: nonStreamingMetrics(body, Date.now() - started, classified.upstreamContentType), usage: usageFromResponseText(text) });
    res.writeHead(classified.response.status, { "content-type": classified.response.headers.get("content-type") || "application/json" });
    res.end(text);
  } finally {
    if (route.kind === "third_party") archivePathRepairMonitor?.notifyThirdPartyTurn();
    inFlight.release();
  }
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  if (method === "GET" && url.pathname === "/api/state") {
    synchronizeOfficialLogin();
    return json(res, 200, stateView());
  }
  if (method === "GET" && url.pathname === "/api/apply-preview") return json(res, 200, await applyPreview());
  if (method === "GET" && url.pathname === "/api/restore-preview") return json(res, 200, await restorePreviewView());
  if (method === "GET" && url.pathname === "/api/themes") return json(res, 200, themeView());
  if (method === "GET" && url.pathname === "/api/login-status") return json(res, 200, codexLoginStatus());
  if (method === "GET" && url.pathname === "/api/session-inventory") return json(res, 200, sessionInventoryView());
  if (method === "GET" && url.pathname === "/api/archive-compatibility") return json(res, 200, inspectCodexArchivePathCompatibility());
  if (method === "POST" && url.pathname === "/api/archive-compatibility/repair") return repairArchiveCompatibility(res);
  if (method === "POST" && url.pathname === "/api/archive-compatibility/rollback") return rollbackArchiveCompatibility(res);
  if (method === "GET" && url.pathname === "/api/model-health") return json(res, 200, modelHealthView());
  if (method === "GET" && url.pathname === "/api/third-party-inflight") return json(res, 200, thirdPartyInFlightView());
  if (method === "GET" && url.pathname === "/api/usage-statistics") return await usageStatisticsResponse(res);
  if (method === "GET" && url.pathname === "/api/request-history") return await requestHistory(res, url);
  if (method === "DELETE" && url.pathname === "/api/request-history") return await deleteRequestHistory(res);
  if (method === "GET" && url.pathname === "/api/browser-use-status") return await browserUseStatus(res);
  if (method === "POST" && url.pathname === "/api/official/verify") {
    const login = codexLoginStatus();
    const settings = loadSettings();
    const captured = login.signedIn ? captureOfficialAuth() : { captured: false };
    settings.official.verified = Boolean(login.signedIn && captured.captured);
    settings.official.lastCheckedAt = new Date().toISOString();
    saveSettings(settings);
    return json(res, settings.official.verified ? 200 : 409, { ...login, verified: settings.official.verified, credentialStored: Boolean(captured.captured) });
  }
  if (method === "POST" && url.pathname === "/api/official/usage/refresh") return await refreshOfficialUsage(res);
  if (method === "POST" && url.pathname === "/api/official/models/refresh") return await refreshOfficialModels(res);
  if (method === "POST" && url.pathname === "/api/official/slots") return saveOfficialSlots(req, res);
  if (method === "POST" && url.pathname === "/api/context-cache") return saveContextCachePreference(req, res);
  if (method === "POST" && url.pathname === "/api/deepseek-savings") return saveDeepSeekSavingsPreference(req, res);
  if (method === "POST" && url.pathname === "/api/model-health/refresh") {
    startModelHealthRefresh();
    return json(res, 202, modelHealthView());
  }
  if (method === "POST" && url.pathname === "/api/connection/repair") {
    const result = repairRelayConnectionIfNeeded();
    if (result.error && !result.externalTakeover) throw apiError(409, result.error, "relay_repair_failed");
    return json(res, result.externalTakeover ? 409 : 200, result);
  }
  if (method === "POST" && url.pathname === "/api/providers") return saveProvider(req, res);
  if (method === "GET" && url.pathname === "/api/model-capability") return modelCapability(res, url);
  if (method === "DELETE" && /^\/api\/providers\/[^/]+$/.test(url.pathname)) return deleteProvider(res, url);
  if (method === "GET" && /^\/api\/providers\/[^/]+\/models$/.test(url.pathname)) return await listProviderModels(res, url);
  if (method === "POST" && /^\/api\/providers\/[^/]+\/balance$/.test(url.pathname)) return await refreshProviderBalance(res, url);
  if (method === "POST" && /^\/api\/providers\/[^/]+\/test-model$/.test(url.pathname)) return await testProviderModel(req, res, url);
  if (method === "POST" && url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/key")) return saveKey(req, res, url);
  if (method === "POST" && url.pathname === "/api/slots/batch") return saveSlotsBatch(req, res);
  if (method === "POST" && url.pathname === "/api/slots") return saveSlot(req, res);
  if (method === "DELETE" && url.pathname.startsWith("/api/slots/")) return deleteSlot(res, url);
  if (method === "POST" && url.pathname === "/api/apply") return await apply(req, res);
  if (method === "POST" && url.pathname === "/api/restore") return await restore(res);
  if (method === "POST" && url.pathname === "/api/official-direct") return await switchOfficialDirect(res);
  if (method === "POST" && url.pathname === "/api/themes/select") return json(res, 200, selectTheme((await bodyJson(req)).themeId));
  if (method === "POST" && url.pathname === "/api/themes/apply") return json(res, 202, applyTheme((await bodyJson(req)).themeId));
  if (method === "POST" && url.pathname === "/api/themes/restore") return json(res, 202, restoreDefaultTheme());
  json(res, 404, { error: { message: "Unknown API route." } });
}

async function browserUseStatus(res) {
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./browser-use-status-worker.js", import.meta.url), {
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    });
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(apiError(504, "浏览器操控检测超时，请关闭占用 Codex 文件的程序后重试。", "browser_use_detection_timeout"));
    }, 20_000);
    worker.once("message", (message) => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (message?.ok) resolve(message.result);
      else reject(apiError(500, message?.error || "浏览器操控检测失败。", "browser_use_detection_failed"));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(apiError(500, error.message || "浏览器操控检测失败。", "browser_use_detection_failed"));
    });
    worker.once("exit", (code) => {
      if (code === 0) return;
      clearTimeout(timer);
      reject(apiError(500, "浏览器操控检测进程异常退出。", "browser_use_detection_failed"));
    });
  });
  return json(res, 200, result);
}

async function refreshOfficialModels(res) {
  synchronizeOfficialLogin();
  const token = officialAccessToken();
  const accountId = officialAccountId();
  if (!token) {
    throw apiError(401, "请先在 Codex 中登录官方账号，再刷新官方模型。", "official_auth_missing");
  }
  let models;
  try {
    models = await fetchOfficialModels({
      token,
      accountId,
      clientVersion: detectCodexClientVersion(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error.statusCode) throw error;
    throw apiError(502, "无法连接官方模型列表。现有两个官方槽位没有改变，请检查网络后重试。", "official_models_unreachable");
  }
  const settings = loadSettings();
  settings.official.availableModels = models;
  settings.official.accountFingerprint = officialAccountFingerprint();
  settings.official.modelsFetchedAt = new Date().toISOString();
  saveSettings(settings);
  json(res, 200, { models: settings.official.availableModels, fetchedAt: settings.official.modelsFetchedAt, slots: settings.official.slots });
}

async function refreshOfficialUsage(res) {
  const synchronized = synchronizeOfficialLogin();
  const token = officialAccessToken();
  if (!token) {
    officialUsageSnapshot = null;
    throw apiError(401, "请先在 Codex 中登录官方账号，再刷新账号额度。", "official_auth_missing");
  }
  const accountFingerprint = officialAccountFingerprint();
  if (!accountFingerprint) {
    officialUsageSnapshot = null;
    throw apiError(409, "当前官方登录缺少账号信息，请在 Codex 中重新登录后再刷新额度。", "official_account_missing");
  }
  try {
    const usage = await fetchOfficialUsageWithTimeout({
      token,
      timeoutMs: 8_000,
    });
    officialUsageSnapshot = {
      accountFingerprint,
      status: "available",
      fetchedAt: new Date().toISOString(),
      ...usage,
    };
    return json(res, 200, officialUsageView(synchronized.login));
  } catch (error) {
    officialUsageSnapshot = {
      accountFingerprint,
      status: officialUsageStatus(error),
      fetchedAt: new Date().toISOString(),
      planType: null,
      fiveHour: null,
      weekly: null,
    };
    throw apiError(error.statusCode || 502, error.message || "无法读取官方账号额度。", error.code || "official_usage_unreachable");
  }
}

function officialAccountFingerprint() {
  const accountId = officialAccountId();
  return accountId ? crypto.createHash("sha256").update(accountId, "utf8").digest("hex") : null;
}

function officialUsageStatus(error) {
  if (error?.statusCode === 401 || error?.statusCode === 403) return "login_expired";
  if (error?.statusCode === 429) return "rate_limited";
  return "unavailable";
}

async function saveOfficialSlots(req, res) {
  const input = await bodyJson(req);
  const settings = loadSettings();
  if (!settings.official.verified) throw apiError(409, "请先同步官方登录状态并刷新可用模型。", "official_not_verified");
  if (!settings.official.modelsFetchedAt || !settings.official.availableModels.length) {
    throw apiError(409, "请先成功刷新当前账号的官方模型，再选择两个官方位置。", "official_models_not_fetched");
  }
  const ids = Array.isArray(input.modelIds) ? input.modelIds.map((value) => String(value || "").trim()).filter(Boolean) : [];
  if (ids.length > 2) throw apiError(400, "官方位置最多选择两个模型。", "official_slots_too_many");
  if (new Set(ids).size !== ids.length) throw apiError(400, "两个官方位置不能选择同一个模型。", "official_slots_duplicate");
  const byId = new Map(settings.official.availableModels.map((model) => [model.id, model]));
  const invalid = ids.find((id) => !byId.has(id));
  if (invalid) throw apiError(400, `模型“${invalid}”不在当前账号最近读取的官方模型列表中。`, "official_slot_invalid");
  settings.official.slots = ids.map((id) => byId.get(id));
  saveSettings(settings);
  writeCatalog(buildModelCatalog(settings));
  json(res, 200, { slots: settings.official.slots, routes: activeRoutes(settings).map((route) => route.id) });
}

async function saveProvider(req, res) {
  const input = await bodyJson(req);
  const settings = loadSettings();
  const index = settings.providers.findIndex((provider) => provider.id === input.id);
  const existing = index >= 0 ? settings.providers[index] : null;
  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  let parsedBase;
  try { parsedBase = new URL(baseUrl); } catch { /* Validated below. */ }
  const validBase = parsedBase && ["http:", "https:"].includes(parsedBase.protocol);
  if (!String(input.name || "").trim() || !validBase) throw apiError(400, "请填写供应商名称和有效的 API 地址。", "provider_invalid");
  const sameOrigin = existing && safeOrigin(existing.baseUrl) === parsedBase.origin;
  const networkMode = providerNetworkMode({ networkMode: input.networkMode });
  const proxyUrl = networkMode === "custom" ? normalizeProviderProxyUrl(input.proxyUrl) : "";
  if (networkMode === "custom" && !proxyUrl) {
    throw apiError(400, "请填写有效的自定义 HTTP(S) 代理地址，且不要在地址中包含账号或密码。", "provider_proxy_invalid");
  }
  const provider = {
    id: String(input.id || crypto.randomUUID()),
    name: String(input.name || "").trim(),
    baseUrl,
    endpointUrl: sameOrigin ? existing.endpointUrl : "",
    modelListUrl: sameOrigin ? existing.modelListUrl : "",
    balanceUrl: sameOrigin ? existing.balanceUrl : "",
    balancePath: sameOrigin ? existing.balancePath : "",
    balanceCurrency: sameOrigin ? existing.balanceCurrency : "",
    balanceSnapshot: sameOrigin ? existing.balanceSnapshot : null,
    balanceProbe: sameOrigin ? existing.balanceProbe : { status: "never", checkedAt: null },
    apiType: input.apiType === "responses" ? "responses" : "chat_completions",
    responsesCompatibility: input.apiType === "responses" && input.responsesCompatibility === "deepseek" ? "deepseek" : "standard",
    networkMode,
    proxyUrl,
    nativeResponseContinuation: input.apiType === "responses" && input.responsesCompatibility !== "deepseek" && input.nativeResponseContinuation === true,
    note: existing?.note || "",
    authHeaderName: sameOrigin ? existing.authHeaderName : "authorization",
    authHeaderPrefix: sameOrigin ? existing.authHeaderPrefix : "Bearer ",
    extraHeaders: sameOrigin ? existing.extraHeaders : {},
    modelCapabilities: sameOrigin ? existing.modelCapabilities : {},
  };
  if (index >= 0) settings.providers[index] = provider; else settings.providers.push(provider);
  replaceSettings(settings);
  if (existing && !sameOrigin) saveProviderKey(provider.id, "");
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
  if (!key) throw apiError(400, `供应商“${provider.name}”尚未保存 API Key。`, "provider_key_missing");
  const candidates = modelListEndpoints(provider);
  const attempts = [];
  for (const endpoint of candidates) {
    try {
      const response = await fetchProvider(provider, endpoint, { headers: providerRequestHeaders(provider, key), redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const raw = await response.text();
      if (!response.ok) {
        attempts.push(`${endpoint}: HTTP ${response.status}${upstreamErrorMessage(raw) ? `（${upstreamErrorMessage(raw)}）` : ""}`);
        continue;
      }
      const details = modelDetailsFromPayload(raw);
      const models = details.map((item) => item.id);
      if (models.length) {
        const discovered = Object.fromEntries(details.filter((item) => item.capability).map((item) => [item.id, item.capability]));
        if (Object.keys(discovered).length) {
          const settings = loadSettings();
          const index = settings.providers.findIndex((item) => item.id === provider.id);
          if (index >= 0) {
            settings.providers[index].modelCapabilities = { ...(settings.providers[index].modelCapabilities || {}), ...discovered };
            replaceSettings(settings);
          }
        }
        return json(res, 200, { providerId: provider.id, models, endpoint });
      }
      attempts.push(`${endpoint}: JSON 中没有可识别的模型 ID`);
    } catch (error) {
      attempts.push(`${endpoint}: ${error.name === "TimeoutError" ? "连接超时" : "无法连接"}`);
    }
  }
  throw apiError(502, `供应商“${provider.name}”没有返回可用的模型列表。${attempts.join("；") || "没有可尝试的模型列表地址。"}。你仍可选择常用建议或直接手填准确的模型 ID。`, "provider_models_invalid");
}

async function refreshProviderBalance(res, url) {
  const provider = providerFromApiPath(url);
  const key = providerKey(provider.id);
  if (!key) throw apiError(400, `供应商“${provider.name}”尚未保存 API Key。`, "provider_key_missing");
  let balance = null;
  let detectedBy = "";
  for (const probe of balanceProbeEndpoints(provider)) {
    try {
      const response = await fetchProvider(provider, probe.url, {
        headers: providerRequestHeaders(provider, key),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      balance = balanceFromPayload(await response.text(), provider, probe);
      if (balance) {
        detectedBy = probe.kind;
        break;
      }
    } catch { /* Try the next same-origin candidate. */ }
  }
  const checkedAt = new Date().toISOString();
  const settings = loadSettings();
  const index = settings.providers.findIndex((item) => item.id === provider.id);
  if (index < 0) throw apiError(404, "Provider not found.", "provider_not_found");
  settings.providers[index].balanceSnapshot = balance;
  settings.providers[index].balanceProbe = balance
    ? { status: "detected", checkedAt, endpointKind: detectedBy }
    : { status: "unsupported", checkedAt };
  replaceSettings(settings);
  json(res, 200, { providerId: provider.id, detected: Boolean(balance), balance });
}

async function testProviderModel(req, res, url) {
  const provider = providerFromApiPath(url);
  const key = providerKey(provider.id);
  if (!key) throw apiError(400, `No API Key is saved for ${provider.name}.`, "provider_key_missing");
  const input = await bodyJson(req);
  const model = String(input.model || "").trim();
  if (!model || model.length > 120) throw apiError(400, "Enter a valid model ID before testing.", "model_id_invalid");
  const reasoningPreset = REASONING_PRESETS.includes(input.reasoningPreset) ? input.reasoningPreset : "auto";
  let result;
  try { result = await performProviderModelProbe({ provider, key, model, reasoningPreset, lightweight: false }); }
  catch {
    throw apiError(502, `Could not reach ${provider.name} using ${providerNetworkLabel(provider)}. Check its API address and network setting.`, "provider_test_unreachable");
  }
  if (!result.ok) {
    throw apiError(result.status, `Model test failed with HTTP ${result.status}${result.message ? `: ${result.message}` : "."}`, "provider_model_test_failed");
  }
  recordModelHealthForMatchingSlots({ provider, model, healthStatus: "available", source: "manual_probe", ...result });
  json(res, 200, { ok: true, providerId: provider.id, model, status: result.status, durationMs: result.durationMs, reasoning: result.reasoning, usage: result.usage });
}

function repairArchiveCompatibility(res) {
  try {
    const result = repairCodexArchivePaths();
    return json(res, 200, result);
  } catch (error) {
    throw apiError(409, error.message || "第三方线程归档兼容修复失败。", error.code || "archive_path_repair_failed");
  }
}

function rollbackArchiveCompatibility(res) {
  try {
    const result = rollbackCodexArchivePaths();
    return json(res, 200, result);
  } catch (error) {
    throw apiError(409, error.message || "第三方线程归档兼容回滚失败。", error.code || "archive_path_rollback_failed");
  }
}

async function handleImageGeneration(req, res) {
  const settings = loadSettings();
  if (!settings.router.running) throw apiError(503, "Codex Relay is not applied. Open the local manager and apply a configured route first.", "router_disabled");
  const body = await readJsonRequest(req);
  const route = {
    kind: "official",
    id: "official-image-generation",
    displayName: "Official image generation",
    upstreamModel: typeof body.model === "string" && body.model.trim() ? body.model.trim() : "gpt-image",
  };
  const started = Date.now();
  const request = requestMetrics(body, req.headers);
  try {
    const upstream = await forwardOfficialImageGeneration({ body, headers: req.headers, signal: abortSignal(req, res) });
    const text = await upstream.text();
    const upstreamError = officialUpstreamFailure(route, upstream.status, text);
    logEvent({ route, status: upstream.status, durationMs: Date.now() - started, ok: upstream.ok, contextMode: "official_image_generation", request, usage: usageFromResponseText(text), error: upstreamError });
    if (upstreamError) return json(res, upstream.status, { error: upstreamError });
    const responseHeaders = { "content-type": upstream.headers.get("content-type") || "application/json" };
    for (const name of ["x-request-id", "openai-request-id", "openai-processing-ms", "openai-version"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    res.end(text);
  } catch (error) {
    const status = error.statusCode || 502;
    logEvent({ route, status, durationMs: Date.now() - started, ok: false, contextMode: "official_image_generation", request });
    if (error.statusCode) throw error;
    throw apiError(502, "The local Router could not reach the official Codex image generation service. Check the official login and Windows network connection.", "upstream_unreachable");
  }
}

async function handleImageEdit(req, res) {
  const settings = loadSettings();
  if (!settings.router.running) throw apiError(503, "Codex Relay is not applied. Open the local manager and apply a configured route first.", "router_disabled");
  const contentType = String(headerValue(req.headers, "content-type") || "");
  if (!isOfficialImageEditContentType(contentType)) {
    throw apiError(415, "Reference-image editing requires application/json or multipart/form-data.", "image_edit_content_type");
  }
  const body = await readRawRequest(req, IMAGE_EDIT_BODY_LIMIT_BYTES);
  const route = {
    kind: "official",
    id: "official-image-edit",
    displayName: "Official image edit",
    upstreamModel: "gpt-image",
  };
  const started = Date.now();
  const request = binaryRequestMetrics(body.length, req.headers);
  try {
    const upstream = await forwardOfficialImageEdit({ body, contentType, headers: req.headers, signal: abortSignal(req, res) });
    const text = await upstream.text();
    const upstreamError = officialUpstreamFailure(route, upstream.status, text);
    logEvent({ route, status: upstream.status, durationMs: Date.now() - started, ok: upstream.ok, contextMode: "official_image_edit", request, usage: usageFromResponseText(text), error: upstreamError });
    if (upstreamError) return json(res, upstream.status, { error: upstreamError });
    const responseHeaders = { "content-type": upstream.headers.get("content-type") || "application/json" };
    for (const name of ["x-request-id", "openai-request-id", "openai-processing-ms", "openai-version"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    res.end(text);
  } catch (error) {
    const status = error.statusCode || 502;
    logEvent({ route, status, durationMs: Date.now() - started, ok: false, contextMode: "official_image_edit", request });
    if (error.statusCode) throw error;
    throw apiError(502, "The local Router could not reach the official Codex image editing service. Check the official login and Windows network connection.", "upstream_unreachable");
  }
}

async function performProviderModelProbe({ provider, key, model, reasoningPreset = "auto", lightweight = false }) {
  const responses = provider.apiType === "responses";
  const endpoint = provider.endpointUrl || `${provider.baseUrl.replace(/\/+$/, "")}${responses ? "/responses" : "/chat/completions"}`;
  const capability = resolveModelCapability(model, { provider, reasoningPreset });
  const selectedEffort = lightweight ? lightweightReasoningEffort(capability.reasoning) : capability.reasoning.defaultLevel;
  const testRoute = { provider, upstreamModel: model, reasoningPreset };
  const testBody = selectedEffort ? { reasoning: { effort: selectedEffort } } : {};
  const basePayload = responses
    ? { model, input: lightweight ? "OK" : "Reply with OK.", max_output_tokens: 8, stream: false, ...testBody }
    : { model, messages: [{ role: "user", content: lightweight ? "OK" : "Reply with OK." }], max_tokens: lightweight ? 1 : 8, stream: false };
  const adapted = responses ? applyReasoningToResponsesPayload(basePayload, testRoute) : null;
  const payload = adapted?.payload || basePayload;
  const reasoning = adapted?.reasoning || applyReasoningToChatPayload(payload, testBody, testRoute);
  const started = Date.now();
  const response = await fetchProvider(provider, endpoint, {
    method: "POST",
    headers: providerRequestHeaders(provider, key),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(MODEL_HEALTH_PROBE_TIMEOUT_MS),
  });
  const raw = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - started,
    reasoning,
    usage: usageFromResponseText(raw),
    message: response.ok ? "" : upstreamErrorMessage(raw),
  };
}

function lightweightReasoningEffort(reasoning) {
  if (!reasoning || ["none", "thinking", "deepseek"].includes(reasoning.preset)) return null;
  return reasoning.levels?.[0]?.effort || null;
}

function startModelHealthRefresh() {
  if (modelHealthState.running) return modelHealthState.promise;
  const settings = loadSettings();
  const targets = settings.thirdPartySlots.map((slot) => {
    const provider = settings.providers.find((item) => item.id === slot.providerId) || null;
    const key = provider ? providerKey(provider.id) : "";
    return { slot, provider, key, signature: modelHealthTargetSignature(slot, provider, key) };
  });
  const startedAt = new Date().toISOString();
  modelHealthState.running = true;
  modelHealthState.startedAt = startedAt;
  for (const target of targets) {
    modelHealthState.entries.set(target.slot.id, {
      ...(modelHealthState.entries.get(target.slot.id)?.signature === target.signature ? modelHealthState.entries.get(target.slot.id) : {}),
      signature: target.signature,
      status: target.provider && target.key ? "checking" : "unavailable",
      checkedAt: target.provider && target.key ? null : startedAt,
      source: "configuration",
      durationMs: null,
      httpStatus: null,
      tokenTotal: null,
      message: target.provider ? "缺少 API Key" : "供应商不存在",
    });
  }
  modelHealthState.promise = runModelHealthRefresh(targets)
    .catch((error) => console.error(`Codex Relay model health refresh failed: ${error.message}`))
    .finally(() => {
      modelHealthState.running = false;
      modelHealthState.completedAt = new Date().toISOString();
      modelHealthState.promise = null;
    });
  return modelHealthState.promise;
}

async function runModelHealthRefresh(targets) {
  const repeatedTargets = new Map();
  for (const target of targets) {
    if (!target.provider || !target.key) continue;
    const repeatedKey = `${target.provider.id}\u0000${target.slot.upstreamModel}`;
    let entry = repeatedTargets.get(repeatedKey);
    if (!entry) {
      entry = recentSuccessfulModelHealth(target.slot) || await lightweightModelHealth(target);
      repeatedTargets.set(repeatedKey, entry);
    }
    modelHealthState.entries.set(target.slot.id, { ...entry, signature: target.signature });
    await delay(250);
  }
}

function recentSuccessfulModelHealth(slot) {
  const cutoff = Date.now() - MODEL_HEALTH_RECENT_REQUEST_MS;
  const event = events.find((item) => item.route?.id === slot.id
    && item.ok
    && Number(item.status) >= 200
    && Number(item.status) < 300
    && Number.isFinite(Number(item.durationMs))
    && Date.parse(item.at) >= cutoff);
  return event ? modelHealthEntry({ status: "available", source: "recent_request", durationMs: event.durationMs, httpStatus: event.status, checkedAt: event.at }) : null;
}

async function lightweightModelHealth(target) {
  try {
    const result = await performProviderModelProbe({
      provider: target.provider,
      key: target.key,
      model: target.slot.upstreamModel,
      reasoningPreset: target.slot.reasoningPreset,
      lightweight: true,
    });
    return modelHealthEntry({
      status: result.ok ? "available" : "unavailable",
      source: "minimal_probe",
      durationMs: result.durationMs,
      httpStatus: result.status,
      tokenTotal: result.usage?.total,
      message: result.ok ? "" : result.message || `HTTP ${result.status}`,
    });
  } catch (error) {
    return modelHealthEntry({
      status: "unavailable",
      source: "minimal_probe",
      message: error.name === "TimeoutError" ? "连接超时" : "无法连接",
    });
  }
}

function modelHealthEntry({ status, source, durationMs = null, httpStatus = null, tokenTotal = null, message = "", checkedAt = null }) {
  return {
    status,
    source,
    checkedAt: checkedAt || new Date().toISOString(),
    durationMs: durationMs === null || durationMs === undefined ? null : finiteMetric(durationMs),
    httpStatus: httpStatus === null || httpStatus === undefined ? null : Number.isInteger(Number(httpStatus)) ? Number(httpStatus) : null,
    tokenTotal: tokenTotal === null || tokenTotal === undefined ? null : Number.isFinite(Number(tokenTotal)) ? Math.max(0, Math.round(Number(tokenTotal))) : null,
    message: sanitizeUpstreamErrorText(message).slice(0, 180),
  };
}

function modelHealthTargetSignature(slot, provider, key) {
  return shortRequestHash(JSON.stringify({
    slotId: slot?.id,
    providerId: provider?.id,
    model: slot?.upstreamModel,
    baseUrl: provider?.baseUrl,
    endpointUrl: provider?.endpointUrl,
    apiType: provider?.apiType,
    networkMode: providerNetworkMode(provider),
    proxyUrl: provider?.proxyUrl,
    authHeaderName: provider?.authHeaderName,
    authHeaderPrefix: provider?.authHeaderPrefix,
    extraHeaders: provider?.extraHeaders,
    keyHash: key ? shortRequestHash(key) : "",
  }));
}

function modelHealthView(settings = loadSettings()) {
  const entries = {};
  for (const slot of settings.thirdPartySlots) {
    const provider = settings.providers.find((item) => item.id === slot.providerId) || null;
    const key = provider ? providerKey(provider.id) : "";
    const signature = modelHealthTargetSignature(slot, provider, key);
    const stored = modelHealthState.entries.get(slot.id);
    if (stored?.signature === signature) {
      const { signature: _signature, ...entry } = stored;
      entries[slot.id] = entry;
      continue;
    }
    entries[slot.id] = {
      status: provider && key ? "unknown" : "unavailable",
      source: "configuration",
      checkedAt: null,
      durationMs: null,
      httpStatus: null,
      tokenTotal: null,
      message: provider && key ? "" : provider ? "缺少 API Key" : "供应商不存在",
    };
  }
  return {
    running: modelHealthState.running,
    startedAt: modelHealthState.startedAt,
    completedAt: modelHealthState.completedAt,
    goodThresholdMs: MODEL_HEALTH_GOOD_MS,
    entries,
  };
}

function recordModelHealthForMatchingSlots({ provider, model, healthStatus, source, durationMs, status: httpStatus, usage, message }) {
  const settings = loadSettings();
  const key = providerKey(provider.id);
  const entry = modelHealthEntry({ status: healthStatus, source, durationMs, httpStatus, tokenTotal: usage?.total, message });
  for (const slot of settings.thirdPartySlots.filter((item) => item.providerId === provider.id && item.upstreamModel === model)) {
    modelHealthState.entries.set(slot.id, { ...entry, signature: modelHealthTargetSignature(slot, provider, key) });
  }
}

export function resetModelHealthForTests() {
  modelHealthState.running = false;
  modelHealthState.startedAt = null;
  modelHealthState.completedAt = null;
  modelHealthState.entries.clear();
  modelHealthState.promise = null;
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
  const base = new URL(provider.baseUrl);
  const origin = base.origin;
  const candidates = [provider.modelListUrl, `${provider.baseUrl.replace(/\/+$/, "")}/models`, `${origin}/v1/models`, `${origin}/models`];
  return sameOriginUrls(candidates, origin);
}

function modelsFromPayload(raw) {
  return modelDetailsFromPayload(raw).map((item) => item.id);
}

function modelDetailsFromPayload(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return []; }
  const lists = findModelLists(payload);
  const byId = new Map();
  for (const item of lists.flat()) {
    const id = String(modelIdFromItem(item) || "").trim();
    if (!id || byId.has(id) || byId.size >= 500) continue;
    byId.set(id, { id, capability: capabilityFromModelItem(item) });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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

function balanceFromPayload(raw, provider, probe) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (provider.balancePath && probe.kind === "legacy") {
    return balanceResult(valueAtPath(payload, provider.balancePath), provider.balanceCurrency || currencyFromPayload(payload), probe.kind);
  }
  if (probe.kind === "deepseek") {
    const balances = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    const selected = balances.find((item) => String(item?.currency || "").toUpperCase() === "CNY") || balances[0];
    return balanceResult(selected?.total_balance, selected?.currency, probe.kind);
  }
  if (probe.kind === "openrouter") {
    const total = numericValue(payload?.data?.total_credits);
    const used = numericValue(payload?.data?.total_usage);
    return total !== null && used !== null ? balanceResult(total - used, "USD", probe.kind) : null;
  }
  if (probe.kind === "siliconflow") return balanceResult(payload?.data?.totalBalance ?? payload?.data?.balance, probe.currency || currencyFromPayload(payload?.data), probe.kind);
  if (probe.kind === "novita") {
    const amount = numericValue(payload?.availableBalance ?? payload?.data?.availableBalance);
    return amount === null ? null : balanceResult(amount / 10_000, "USD", probe.kind);
  }
  if (probe.kind === "stepfun") return balanceResult(payload?.balance ?? payload?.data?.balance, "CNY", probe.kind);
  const value = firstBalanceValue(payload);
  return balanceResult(value, currencyFromPayload(value) || firstCurrencyValue(payload) || probe.currency, probe.kind);
}

function balanceResult(value, currency, source) {
  const amount = numericValue(value);
  if (amount === null) return null;
  return { amount, currency: String(currency || "").trim().toUpperCase().slice(0, 12), checkedAt: new Date().toISOString(), source };
}

function valueAtPath(payload, pathValue) {
  return String(pathValue || "").split(".").filter(Boolean).reduce((value, part) => {
    if (value === null || value === undefined) return undefined;
    return value[part];
  }, payload);
}

function firstBalanceValue(payload) {
  const preferredKeys = ["remaining", "remaining_balance", "remainingbalance", "balance", "available_balance", "availablebalance", "total_balance", "totalbalance"];
  const pending = [{ value: payload, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.shift();
    if (!value || typeof value !== "object" || depth > 3) continue;
    for (const preferred of preferredKeys) {
      const match = Object.entries(value).find(([key]) => key.toLowerCase() === preferred);
      if (match && numericValue(match[1]) !== null) return match[1];
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
    }
  }
  return undefined;
}

function firstCurrencyValue(payload) {
  const pending = [{ value: payload, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.shift();
    if (!value || typeof value !== "object" || depth > 3) continue;
    const currency = currencyFromPayload(value);
    if (currency) return currency;
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
    }
  }
  return "";
}

function balanceProbeEndpoints(provider) {
  const base = new URL(provider.baseUrl);
  const origin = base.origin;
  const host = base.hostname.toLowerCase();
  const probes = [];
  if (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) probes.push({ url: `${origin}/user/balance`, kind: "deepseek" });
  if (host === "api.stepfun.com" || host.endsWith(".stepfun.com")) probes.push({ url: `${origin}/v1/accounts`, kind: "stepfun" });
  if (host.includes("siliconflow")) probes.push({ url: `${origin}/v1/user/info`, kind: "siliconflow", currency: host.endsWith(".cn") ? "CNY" : "USD" });
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) probes.push({ url: `${origin}/api/v1/credits`, kind: "openrouter" });
  if (host === "api.novita.ai" || host.endsWith(".novita.ai")) probes.push({ url: `${origin}/v3/user/balance`, kind: "novita" });
  if (provider.balanceUrl) probes.push({ url: provider.balanceUrl, kind: "legacy", currency: provider.balanceCurrency });
  probes.push(
    { url: `${origin}/v1/usage`, kind: "usage" },
    { url: `${provider.baseUrl.replace(/\/+$/, "")}/usage`, kind: "usage" },
    { url: `${origin}/usage`, kind: "usage" },
    { url: `${origin}/user/balance`, kind: "generic_balance" },
    { url: `${origin}/v1/user/balance`, kind: "generic_balance" },
    { url: `${origin}/v1/user/info`, kind: "generic_balance" },
  );
  const seen = new Set();
  return probes.filter((probe) => {
    const urls = sameOriginUrls([probe.url], origin);
    if (!urls.length || seen.has(urls[0])) return false;
    probe.url = urls[0];
    seen.add(probe.url);
    return true;
  });
}

function sameOriginUrls(candidates, origin) {
  const values = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) continue;
      values.push(parsed.toString());
    } catch { /* Ignore invalid legacy candidates. */ }
  }
  return [...new Set(values)];
}

function safeOrigin(value) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : "";
  } catch { return ""; }
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
  const provider = settings.providers.find((item) => item.id === String(input.providerId || ""));
  const slot = modelSlot(input, provider);
  if (!THIRD_PARTY_SLOT_IDS.includes(slot.id)) throw apiError(400, "Invalid model slot.", "slot_invalid");
  if (!slot.displayName || !slot.providerId || !slot.upstreamModel) throw apiError(400, "Display name, provider, and upstream model are required.", "slot_incomplete");
  if (!provider) throw apiError(400, "Choose an existing provider first.", "slot_provider_missing");
  assertProviderModelSupported(provider, slot.upstreamModel);
  const index = settings.thirdPartySlots.findIndex((item) => item.id === slot.id);
  if (index >= 0) settings.thirdPartySlots[index] = slot; else settings.thirdPartySlots.push(slot);
  replaceSettings(settings);
  json(res, 200, { slot });
}

async function saveSlotsBatch(req, res) {
  const input = await bodyJson(req);
  const settings = loadSettings();
  const providerId = String(input.providerId || "");
  const provider = settings.providers.find((item) => item.id === providerId);
  if (!provider) throw apiError(400, "请先选择已有供应商。", "slot_provider_missing");
  const models = [...new Set((Array.isArray(input.models) ? input.models : []).map((model) => String(model || "").trim()).filter(Boolean))];
  if (!models.length) throw apiError(400, "请至少选择一个上游模型。", "slot_batch_empty");
  if (models.some((model) => model.length > 120)) throw apiError(400, "上游模型 ID 不能超过 120 个字符。", "model_id_invalid");
  for (const model of models) assertProviderModelSupported(provider, model);
  const duplicate = models.find((model) => settings.thirdPartySlots.some((slot) => slot.providerId === providerId && slot.upstreamModel === model));
  if (duplicate) throw apiError(409, `模型“${duplicate}”已经使用这个供应商添加。`, "slot_batch_duplicate");
  const occupied = new Set(settings.thirdPartySlots.map((slot) => slot.id));
  const availableIds = THIRD_PARTY_SLOT_IDS.filter((id) => !occupied.has(id));
  if (models.length > availableIds.length) throw apiError(409, `剩余 ${availableIds.length} 个第三方槽位，无法一次添加 ${models.length} 个模型。`, "slot_capacity_exceeded");
  const slots = models.map((upstreamModel, index) => modelSlot({
    id: availableIds[index],
    displayName: friendlyModelName(upstreamModel),
    providerId,
    upstreamModel,
    reasoningPreset: "auto",
  }, provider));
  settings.thirdPartySlots.push(...slots);
  replaceSettings(settings);
  json(res, 200, { slots, remaining: availableIds.length - slots.length });
}

function modelSlot(input, provider) {
  const reasoningPreset = REASONING_PRESETS.includes(input.reasoningPreset) ? input.reasoningPreset : "auto";
  const upstreamModel = String(input.upstreamModel || "").trim();
  const capability = resolveModelCapability(upstreamModel, { provider, reasoningPreset });
  return {
    id: String(input.id || ""), displayName: String(input.displayName || "").trim(), providerId: String(input.providerId || ""), upstreamModel,
    contextWindow: capability.contextWindow, supportsImages: capability.supportsImages, reasoningPreset, dropParams: [],
  };
}

function assertProviderModelSupported(provider, model) {
  if (provider?.responsesCompatibility === "deepseek" && String(model || "").trim().toLowerCase() !== "deepseek-v4-flash") {
    throw apiError(400, "DeepSeek Responses 当前只支持 deepseek-v4-flash；DeepSeek-V4-Pro 暂不能作为 Codex Responses 模型发布。", "deepseek_responses_model_unsupported");
  }
}

function friendlyModelName(value) {
  return String(value).trim().split(/[-_/]+/).filter(Boolean).map((part) => /^(gpt|glm|qwen|kimi|mimo)$/i.test(part)
    ? part.toUpperCase()
    : part.charAt(0).toUpperCase() + part.slice(1)).join(" ").slice(0, 48);
}

function modelCapability(res, url) {
  const model = String(url.searchParams.get("model") || "").trim();
  const providerId = String(url.searchParams.get("providerId") || "");
  const provider = loadSettings().providers.find((item) => item.id === providerId);
  if (!model || !provider) throw apiError(400, "请选择供应商并填写上游模型 ID。", "model_capability_incomplete");
  const reasoningPreset = REASONING_PRESETS.includes(url.searchParams.get("reasoningPreset")) ? url.searchParams.get("reasoningPreset") : "auto";
  json(res, 200, resolveModelCapability(model, { provider, reasoningPreset }));
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
  if (settings.contextCache.persist) {
    enqueueContextCache(chatHistory.snapshot());
    await flushContextCacheWriter();
  }
  else {
    clearTimeout(contextCacheTimer);
    try { await flushContextCacheWriter(); }
    catch (error) { console.error(`Codex Relay could not finish an earlier context cache write before clearing it: ${error.message}`); }
    clearContextCache();
  }
  json(res, 200, { persist: settings.contextCache.persist });
}

async function saveDeepSeekSavingsPreference(req, res) {
  const input = await bodyJson(req);
  const settings = loadSettings();
  settings.deepSeekSavings = { enabled: Boolean(input.enabled) };
  saveSettings(settings);
  json(res, 200, settings.deepSeekSavings);
}

async function apply(req, res) {
  const input = await optionalBodyJson(req);
  const showCcSwitchHistory = input.historyVisibilityAction === "show_custom_in_openai";
  synchronizeOfficialLogin();
  const preview = await applyPreview();
  if (!preview.ready) throw apiError(400, preview.problems[0], "apply_preflight_failed");
  if (showCcSwitchHistory) {
    if (preview.historyVisibility?.blockedReason === "history_database_schema_changed") {
      throw apiError(409, "The Codex conversation index database uses an unsupported schema. Nothing was modified; update Codex Relay before adjusting history visibility.", "history_database_schema_changed");
    }
    if (!preview.historyVisibility?.migratable) throw apiError(409, "No eligible custom conversation history is available to show in Relay.", "history_migration_unavailable");
    if (preview.externalProcesses?.codexRunning) throw apiError(409, "Close Codex completely before Relay adjusts CC Switch conversation visibility.", "codex_running_for_history_migration");
    if (!input.historyVisibilityPlanSha256 || input.historyVisibilityPlanSha256 !== preview.historyVisibility.planHash) {
      throw apiError(409, "CC Switch conversation history changed after the preview. Nothing was modified; reopen the confirmation and try again.", "history_plan_changed");
    }
  }
  const { settings, catalog } = preview;
  const location = paths();
  let stage = "router_preflight";
  try {
    await verifyLocalRouter(settings, catalog);
  } catch {
    throw apiError(503, "The local Router did not pass its health check. Codex configuration was not changed; keep Codex Relay open and try again.", "router_health_failed");
  }

  let switcherHandoff;
  let handoff;
  let historyVisibility = null;
  const previousRunning = settings.router.running;
  const expectedRoutes = activeRoutes(settings).map((route) => route.id);
  const routerUrl = `http://127.0.0.1:${settings.router.port}/v1`;
  let applied;
  try {
    stage = "close_cc_switch";
    switcherHandoff = await closeCcSwitchForHandoff();
    // Capture the exact state that existed at this handoff before restoring
    // authentication or adjusting the optional conversation visibility bucket.
    stage = "capture_handoff";
    const priorApplication = relayApplicationStatus();
    handoff = captureRelayHandoff({ replaceExisting: !priorApplication.applied });
    if (showCcSwitchHistory) {
      stage = "history_visibility";
      const history = await import("./session-history.js");
      historyVisibility = await history.migrateCodexCustomHistory({ planHash: input.historyVisibilityPlanSha256 });
      if (historyVisibility.migrated) {
        handoff.snapshot = refreshRelayHandoffSessionBaseline(historyVisibility);
      }
    }
    // Publish the complete catalog before config.toml starts pointing at it. Codex
    // can observe config changes immediately, so the opposite order can briefly
    // expose an empty catalog that the desktop app then caches.
    stage = "write_catalog";
    writeCatalog(catalog);
    stage = "write_codex_config";
    applied = applyRelayConfig({ model: catalog.models[0].slug, catalogPath: location.catalog, routerUrl, deferCommit: true, handoff, restoreOfficial: settings.official.verified });
    stage = "router_post_write";
    await verifyLocalRouter(settings, catalog);
    stage = "publication_precommit";
    const preparedPublication = relayPublicationStatus({ expectedRoutes, expectedCatalog: catalog, routerUrl });
    if (!preparedPublication.configTargetsRelay || !preparedPublication.catalogReadable || !preparedPublication.catalogMatches || !preparedPublication.catalogContentMatches) {
      throw apiError(409, "Relay 写入后发现 Codex 配置或模型目录已被其他程序改写。已自动恢复启用前状态，请关闭其他切换工具后重试。", "relay_publication_failed");
    }
    stage = "session_protection";
    const sessionProtection = verifySessionProtection(handoff.snapshot.sessions);
    if (!sessionProtection.safe) throw apiError(409, "Relay 无法确认现有聊天文件保持不变，因此已经停止启用并恢复原配置。聊天正文没有被 Relay 改写。", "session_protection_failed");
    stage = "config_stability";
    await delay(600);
    stage = "commit";
    const application = commitRelayConfig(applied.transaction);
    stage = "save_settings";
    settings.router.running = true;
    saveSettings(settings);
    stage = "publication_final";
    const publication = relayPublicationStatus({ expectedRoutes, expectedCatalog: catalog, routerUrl });
    if (!publication.verified) throw apiError(409, "Relay 的最终发布校验没有通过，已自动恢复启用前状态。请根据错误阶段重新尝试。", "relay_publication_failed");
    json(res, 200, { applied: true, verified: application.configMatches, publication, sessionProtected: true, catalog: location.catalog, handoffCreated: handoff.created, snapshot: handoff.snapshot, switcherHandoff, authHandoff: applied.authHandoff, historyVisibility: historyVisibility ? { status: historyVisibility.migrated ? "migrated" : "already_active", sessions: historyVisibility.sessions || historyVisibility.manifest?.eligibleCount || 0, files: historyVisibility.files || historyVisibility.manifest?.files?.length || 0, rows: historyVisibility.rows || 0 } : { status: "not_requested", sessions: 0, files: 0, rows: 0 } });
  } catch (error) {
    if (historyVisibility?.migrated) {
      try { (await import("./session-history.js")).rollbackCodexHistoryMigration(); }
      catch (historyError) { error.message = `${error.message || "Relay apply failed."} Conversation visibility rollback also failed: ${historyError.message}`; }
    }
    if (applied?.transaction) rollbackRelayConfig(applied.transaction);
    if (handoff?.created) discardRelayHandoff(handoff);
    settings.router.running = previousRunning;
    try { saveSettings(settings); } catch { /* Preserve the original apply error after the Codex rollback. */ }
    const switcherRestore = reopenCcSwitchAfterRollback(switcherHandoff);
    const mapped = applyStageError(error, stage);
    if (switcherRestore.reopened) mapped.message += " CC Switch 已自动重新打开。";
    throw mapped;
  }
}

function applyStageError(error, stage) {
  if (error?.statusCode) {
    error.stage ||= stage;
    return error;
  }
  const code = String(error?.code || "apply_rolled_back");
  const stageName = applyStageName(stage);
  if (code === "relay_config_changed") {
    return apiError(409, "Relay 写入后，Codex 配置在“" + stageName + "”阶段被其他程序改写。已自动恢复启用前状态；请关闭其他切换工具后重试。", code, stage);
  }
  if (code === "official_auth_restore_failed") {
    return apiError(409, "保存的官方登录无法恢复，Relay 已保持原来的 Codex 配置。请先在 Codex 重新登录官方账号。", code, stage);
  }
  if (code === "cc_switch_close_failed") {
    return apiError(409, "检测到 CC Switch 正在占用 Codex 配置，但 Relay 无法自动关闭它。Codex 配置没有改变，请退出 CC Switch 后重试。", code, stage);
  }
  const detail = String(error?.message || "未知错误").replace(/\s+/g, " ").slice(0, 240);
  return apiError(503, "Relay 在“" + stageName + "”阶段失败：" + detail + "。已自动恢复启用前的 Codex 配置和认证。", code, stage);
}

function applyStageName(stage) {
  return ({
    router_preflight: "Router 预检查",
    close_cc_switch: "关闭 CC Switch",
    capture_handoff: "创建使用前快照",
    history_visibility: "调整 CC Switch 旧会话可见性",
    write_catalog: "写入模型目录",
    write_codex_config: "写入 Codex 配置与认证",
    router_post_write: "写入后 Router 校验",
    publication_precommit: "模型发布预校验",
    session_protection: "聊天记录保护校验",
    config_stability: "配置稳定性校验",
    commit: "提交 Relay 配置",
    save_settings: "保存 Relay 状态",
    publication_final: "最终发布校验",
  })[stage] || "启用 Relay";
}

async function restore(res) {
  if (!restorePreview().available) throw apiError(409, "Relay is not currently applied, so there is no active handoff to restore.", "handoff_missing");
  ensureCodexClosedForRestore();
  const handoffProtection = verifySessionProtection(relayHandoffSnapshot()?.sessions);
  if (!handoffProtection.safe) throw apiError(409, `会话保护未通过：缺失文件 ${handoffProtection.missing.length}，缺失索引 ${handoffProtection.missingIndex.length}，正文截断 ${handoffProtection.truncated.length}，旧正文变化 ${handoffProtection.changedPrefix.length}。Codex 文件没有被修改。`, "session_protection_failed");
  const history = await import("./session-history.js");
  const activeHistory = history.activeCodexHistoryMigration();
  let historyResult = null;
  try {
    if (activeHistory) historyResult = await history.restoreCodexHistoryMigration({ keepActive: true, deletedSessionIds: handoffProtection.deletedSessionIds });
    const sessionBaseline = currentSessionInventory();
    const result = restorePreRelayState(sessionBaseline);
    if (!result.restored) throw apiError(409, "The active Relay handoff is no longer available.", "handoff_missing");
    if (!result.verified) {
      if (historyResult?.restored) history.reapplyCodexHistoryMigration();
      throw apiError(409, "Codex files were restored, but verification did not complete. The active handoff was kept so the operation can be retried.", "restore_verification_failed");
    }
    if (historyResult?.restored) history.finalizeCodexHistoryMigration();
    const settings = loadSettings();
    settings.router.running = false;
    saveSettings(settings);
    json(res, 200, {
      restored: true,
      verified: result.verified,
      sessionProtected: Boolean(result.sessionProtection?.safe),
      configurationChanged: result.configurationChanged,
      historyVisibility: historyResult ? { restored: historyResult.restored, sessions: historyResult.sessions, files: historyResult.files, rows: historyResult.rows } : { restored: false, sessions: 0, files: 0, rows: 0 },
      deletedConversationsSkipped: handoffProtection.deleted.length,
      message: `已恢复并验证进入 Relay 前的 Codex 配置和认证。Relay 模型、供应商、加密 Key 均已保留${handoffProtection.deleted.length ? `；已跳过 ${handoffProtection.deleted.length} 个此前删除的旧对话，未从备份复活` : ""}。`,
    });
  } catch (error) {
    if (historyResult?.restored && history.activeCodexHistoryMigration()) {
      try { history.reapplyCodexHistoryMigration({ deletedSessionIds: handoffProtection.deletedSessionIds }); } catch { /* Keep the original restore error. */ }
    }
    throw error;
  }
}

async function switchOfficialDirect(res) {
  if (!restorePreview().available) throw apiError(409, "Relay 当前没有可用的使用前快照，无法安全切换到官方直连。", "handoff_missing");
  ensureCodexClosedForRestore();
  const result = switchToOfficialDirect();
  if (!result.verified) throw apiError(409, "官方直连验证没有通过；Codex 文件已回滚。", "official_direct_verification_failed");
  json(res, 200, {
    ...result,
    message: "已切回官方直连：Codex 不再指向 Relay 的本地 Router 或模型目录，官方登录已验证。Relay 和 CC Switch 的本地设置、请求记录与对话文件均已保留。",
  });
}

export function ensureCodexClosedForRestore(status = externalProcessStatus()) {
  if (!status?.codexRunning) return status;
  throw apiError(409, "请先完全退出 Codex，再恢复使用前状态。恢复会写回 config.toml 和 auth.json；当前运行中的 Codex 仍保留内存配置，继续恢复可能造成模型列表和登录状态不同步。Codex 文件没有被修改。", "codex_running_for_restore");
}

async function restorePreviewView() {
  const preview = restorePreview();
  const history = await import("./session-history.js");
  const active = history.activeCodexHistoryMigration();
  const sessionProtection = preview.snapshot?.sessions ? verifySessionProtection(preview.snapshot.sessions) : null;
  return {
    ...preview,
    sessionProtection,
    codexRunning: externalProcessStatus().codexRunning,
    historyVisibility: active ? {
      restoreRequired: true,
      sessions: active.eligibleCount || 0,
      files: active.files?.length || 0,
      rows: (active.databases || []).reduce((sum, item) => sum + (item.threadIds?.length || 0), 0),
      requiresCodexClosed: true,
    } : { restoreRequired: false, sessions: 0, files: 0, rows: 0, requiresCodexClosed: false },
  };
}

async function applyPreview() {
  const settings = loadSettings();
  const catalog = buildModelCatalog(settings);
  const login = codexLoginStatus();
  const config = codexConfigPreflight();
  const application = relayApplicationStatus();
  const officialCredentialStored = hasOfficialAuthSnapshot();
  const officialAuthHandoff = relayOfficialAuthPlan({ restoreOfficial: settings.official.verified });
  const officialReady = Boolean(settings.official.verified && officialAuthHandoff.action !== "unavailable");
  const computerUse = computerUseView(login, officialCredentialStored);
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
  const externalProcesses = externalProcessStatus();
  let historyVisibility;
  try {
    const history = await import("./session-history.js");
    const inspected = history.inspectCodexHistoryBuckets();
    const active = history.activeCodexHistoryMigration();
    historyVisibility = {
      status: active ? "active" : inspected.migrationBlocked ? "unavailable" : inspected.migratable ? externalProcesses.codexRunning ? "blocked" : "available" : "none",
      sourceProvider: "custom",
      targetProvider: "openai",
      eligibleCount: inspected.customSessions,
      jsonlCount: inspected.jsonl.custom,
      stateRowCount: inspected.state.custom,
      migratable: inspected.migratable && !active,
      canMigrate: inspected.migratable && !active && !externalProcesses.codexRunning,
      requiresCodexClosed: true,
      planHash: inspected.planHash,
      blockedReason: inspected.blockedReason,
      unsupportedDatabases: inspected.unsupportedDatabases,
      active: Boolean(active),
      ledger: active ? { files: active.files?.length || 0, rows: (active.databases || []).reduce((sum, item) => sum + (item.threadIds?.length || 0), 0), createdAt: active.createdAt } : null,
    };
  } catch (error) {
    historyVisibility = { status: "unavailable", eligibleCount: 0, migratable: false, canMigrate: false, requiresCodexClosed: true, planHash: null, error: String(error.message || "Could not inspect CC Switch history.") };
  }
  if (officialAuthHandoff.requiresRestore && externalProcesses.codexRunning) {
    problems.push("Close Codex completely before Relay restores its saved official sign-in. Relay will preserve a current official login without rewriting auth.json.");
  }
  return {
    ready: problems.length === 0,
    problems,
    settings,
    catalog,
    routes: activeRoutes(settings).map((route) => ({ id: route.id, displayName: route.displayName, kind: route.kind })),
    snapshot,
    application,
    officialCredentialStored,
    officialAuthHandoff,
    computerUse,
    externalProcesses,
    historyVisibility,
    onboarding,
    createsHandoff: !application.applied,
    config: {
      writable: config.writable,
      configExists: config.configExists,
      providerIdentity: config.providerIdentity,
      targetProviderIdentity: "openai",
      writes: ["model_provider", "model", "model_catalog_json", "openai_base_url", "model_reasoning_effort (reset to model default)"],
    },
  };
}

function trackThirdPartyInFlight(route, signal) {
  if (route?.kind !== "third_party") return { release() {} };
  const providerId = String(route.providerId || route.provider?.id || "");
  if (!providerId) return { release() {} };

  // Provider id is the local credential domain. Do not decrypt or hash API
  // keys on the Router hot path just to produce a diagnostic counter.
  const ticket = {
    id: ++thirdPartyInFlightSequence,
    startedAt: Date.now(),
    cancellingAt: null,
  };
  const active = thirdPartyInFlight.get(providerId) || new Map();
  active.set(ticket.id, ticket);
  thirdPartyInFlight.set(providerId, active);

  const markCancelling = () => { if (!ticket.cancellingAt) ticket.cancellingAt = Date.now(); };
  if (signal?.aborted) markCancelling();
  else signal?.addEventListener?.("abort", markCancelling, { once: true });

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      signal?.removeEventListener?.("abort", markCancelling);
      active.delete(ticket.id);
      if (!active.size) thirdPartyInFlight.delete(providerId);
    },
  };
}

function thirdPartyInFlightView(settings = loadSettings()) {
  const checkedAt = new Date().toISOString();
  const now = Date.now();
  const providers = (settings.providers || []).map((provider) => {
    const entries = [...(thirdPartyInFlight.get(provider.id)?.values() || [])];
    const oldest = entries.reduce((result, entry) => !result || entry.startedAt < result.startedAt ? entry : result, null);
    return {
      providerId: provider.id,
      current: entries.length,
      cancelling: entries.filter((entry) => Boolean(entry.cancellingAt)).length,
      oldestStartedAt: oldest ? new Date(oldest.startedAt).toISOString() : null,
      oldestElapsedMs: oldest ? now - oldest.startedAt : null,
    };
  });
  return { checkedAt, total: providers.reduce((sum, provider) => sum + provider.current, 0), providers };
}

function stateView(repair = null) {
  const settings = loadSettings();
  const compactCapabilities = compactCapabilityProfiles(settings.compactCapabilities);
  const login = codexLoginStatus();
  const credentialStored = Boolean(login?.signedIn && login?.authType === "official") || hasOfficialAuthSnapshot();
  const application = relayApplicationStatus();
  const config = codexConfigPreflight();
  const listening = Boolean(server?.listening);
  const expectedRoutes = activeRoutes(settings).map((route) => route.id);
  const routerUrl = `http://127.0.0.1:${settings.router.port}/v1`;
  const catalog = buildModelCatalog(settings);
  const publication = relayPublicationStatus({ expectedRoutes, expectedCatalog: catalog, routerUrl });
  const computerUse = computerUseView(login, credentialStored);
  const thirdPartyInFlightViewData = thirdPartyInFlightView(settings);
  const thirdPartyInFlightByProvider = new Map(thirdPartyInFlightViewData.providers.map((entry) => [entry.providerId, entry]));
  return {
    router: {
      host: settings.router.host,
      port: settings.router.port,
      configured: Boolean(settings.router.running),
      listening,
      configMatches: application.configMatches,
      active: Boolean(settings.router.running && listening && publication.verified),
    }, connection: {
      providerIdentity: config.providerIdentity,
      openaiBaseUrl: config.openaiBaseUrl || null,
      providerBaseUrl: config.providerBaseUrl || null,
      expectedProviderIdentity: "openai",
      expectedBaseUrl: `http://127.0.0.1:${settings.router.port}/v1`,
      repaired: Boolean(repair?.repaired),
      repairError: repair?.error || null,
      repairEligible: Boolean(settings.router.running && application.applied && application.relayManaged && (!application.configMatches || !publication.verified)),
      externalTakeover: Boolean(settings.router.running && application.applied && !application.relayManaged && !application.configMatches),
    }, official: officialView(settings, login, credentialStored), computerUse, contextCache: settings.contextCache, deepSeekSavings: settings.deepSeekSavings, modelHealth: modelHealthView(settings), thirdPartyInFlight: thirdPartyInFlightViewData,
    providers: settings.providers.map((provider) => providerView(provider, settings, compactCapabilities, thirdPartyInFlightByProvider.get(provider.id))), thirdPartySlots: settings.thirdPartySlots,
    routes: activeRoutes(settings).map((route) => ({ id: route.id, displayName: route.displayName, kind: route.kind, providerName: route.provider?.name || "Official Codex", upstreamModel: route.upstreamModel })),
    events: recentRequestEvents(12), requestHistory: requestHistorySummary(), snapshot: relayHandoffSnapshot(), application, publication, onboarding: onboardingState(settings, config, login, application), restorePreview: restorePreview(), themes: themeView(), paths: paths(),
  };
}

function computerUseView(login, credentialStored) {
  const environment = computerUseEnvironment();
  const desktopSessionReady = Boolean(login?.signedIn && login?.authType === "official");
  return {
    ...environment,
    desktopSessionReady,
    credentialStored: Boolean(credentialStored),
    available: Boolean(environment.environmentReady && desktopSessionReady),
    status: !environment.environmentReady ? environment.reason : desktopSessionReady ? "ready" : credentialStored ? "restart_official_session" : "official_session_required",
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
  const requestOptions = () => ({ headers: { connection: "close" }, signal: AbortSignal.timeout(2_000) });
  const health = await fetch(`${baseUrl}/health`, requestOptions());
  if (!health.ok) throw new Error(`Health endpoint returned ${health.status}.`);
  const healthBody = await health.json();
  const expectedRoutes = catalog.models.map((model) => model.slug);
  if (!healthBody?.ok || !sameItems(healthBody.routes, expectedRoutes)) throw new Error("Health endpoint returned a different route set.");

  const modelCatalog = await fetch(`${baseUrl}/model-catalog.json`, requestOptions());
  if (!modelCatalog.ok) throw new Error(`Model catalog endpoint returned ${modelCatalog.status}.`);
  const catalogBody = await modelCatalog.json();
  if (!sameItems(catalogBody?.models?.map((model) => model.slug), expectedRoutes)) throw new Error("Model catalog returned a different route set.");
}

function sameItems(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sessionInventoryView() {
  const baseline = relayHandoffSnapshot()?.sessions || null;
  const current = currentSessionInventory();
  const protection = baseline ? verifySessionProtection(baseline) : null;
  const comparable = Boolean(protection?.comparable);
  const same = Boolean(protection?.safe);
  return { baseline, current, comparable, same, protection };
}

function providerView(provider, settings = loadSettings(), compactCapabilities = compactCapabilityProfiles(settings.compactCapabilities), inFlight = null) {
  const key = providerKey(provider.id);
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiType: provider.apiType,
    responsesCompatibility: provider.responsesCompatibility || "standard",
    networkMode: providerNetworkMode(provider),
    proxyUrl: providerNetworkMode(provider) === "custom" ? normalizeProviderProxyUrl(provider.proxyUrl) : "",
    nativeResponseContinuation: provider.nativeResponseContinuation === true,
    hasApiKey: Boolean(key),
    inFlight: {
      current: Math.max(0, Number(inFlight?.current || 0)),
      cancelling: Math.max(0, Number(inFlight?.cancelling || 0)),
      oldestStartedAt: inFlight?.oldestStartedAt || null,
      oldestElapsedMs: Number.isFinite(Number(inFlight?.oldestElapsedMs)) ? Math.max(0, Math.round(Number(inFlight.oldestElapsedMs))) : null,
    },
    balanceSnapshot: provider.balanceSnapshot,
    balanceProbe: provider.balanceProbe,
    compactCapability: providerCompactCapabilityView(provider, key, settings, compactCapabilities),
  };
}

function providerCompactCapabilityView(provider, key, settings, compactCapabilities) {
  if (provider.apiType !== "responses") return { status: "not_applicable", verifiedAt: null };
  // DeepSeek documents only the stateless Responses endpoint. Do not let the
  // generic capability probe create an extra /responses/compact request.
  if (provider.responsesCompatibility === "deepseek") return { status: "unsupported", verifiedAt: null };
  const models = [...new Set(settings.thirdPartySlots
    .filter((slot) => slot.providerId === provider.id)
    .map((slot) => String(slot.upstreamModel || "").trim())
    .filter(Boolean))];
  if (!key || !models.length) return { status: "automatic", verifiedAt: null };

  const endpointUrl = providerCompactEndpoint(provider);
  const statuses = models.map((upstreamModel) => compactCapabilityStatus(
    compactCapabilities,
    compactCapabilityTarget({ provider, apiKey: key, upstreamModel, endpointUrl }),
  ));
  const verifiedAt = statuses
    .map((item) => item.profile?.verifiedAt || "")
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  const uniformStatus = ["supported", "unsupported", "temporary_failure"]
    .find((status) => statuses.every((item) => item.status === status));
  return { status: uniformStatus || "automatic", verifiedAt };
}
function officialView(settings, login, credentialStored = hasOfficialAuthSnapshot()) {
  const { accountFingerprint: _accountFingerprint, ...official } = settings.official;
  return { ...official, login, credentialStored, usage: officialUsageView(login, credentialStored) };
}

function officialUsageView(login, credentialStored = hasOfficialAuthSnapshot()) {
  const signedIn = officialSessionAvailable(login, credentialStored);
  if (!signedIn) return { status: login?.authType === "api_key" ? "api_key" : "not_signed_in" };
  const accountFingerprint = officialAccountFingerprint();
  if (!accountFingerprint) return { status: "unavailable" };
  if (!officialUsageSnapshot || officialUsageSnapshot.accountFingerprint !== accountFingerprint) return { status: "not_loaded" };
  const { accountFingerprint: _snapshotFingerprint, ...usage } = officialUsageSnapshot;
  return usage;
}
export function officialSessionAvailable(login, credentialStored = false) {
  return Boolean((login?.signedIn && login?.authType === "official") || credentialStored);
}
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
export function thirdPartyUpstreamFailure(route, status, rawText, contentType = "") {
  if (route.kind !== "third_party") return null;
  const provider = String(route.provider?.name || "The third-party provider").trim();
  const raw = String(rawText || "");
  const looksHtml = /(?:text\/html|application\/xhtml)/i.test(String(contentType || ""))
    || /^\s*(?:<!doctype\s+html|<html\b)/i.test(raw);
  let parsedError = null;
  if (!looksHtml) {
    try {
      const parsed = JSON.parse(raw);
      parsedError = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
    } catch { /* Use the concise status-specific message below. */ }
  }

  const upstreamMessage = sanitizeUpstreamErrorText(parsedError?.message);
  const genericMessage = status === 413
    ? `${provider} returned HTTP 413 because the request context is too large. Compact the task or reduce the retained context before retrying.`
    : status === 429
      ? `${provider} returned HTTP 429. Its current rate limit or balance does not allow this request.`
      : status === 401 || status === 403
        ? `${provider} returned HTTP ${status}. Check that provider's API Key, permissions, and account status.`
        : status >= 500
          ? `${provider} returned HTTP ${status}. The upstream service is temporarily unavailable; try again later or switch routes.`
          : `${provider} returned HTTP ${status} and rejected the request.`;
  const code = sanitizeUpstreamErrorCode(parsedError?.code) || `upstream_http_${status}`;
  return {
    code,
    message: upstreamMessage ? `${genericMessage} Upstream message: ${upstreamMessage}` : genericMessage,
    ...(typeof parsedError?.type === "string" && parsedError.type.trim() ? { type: parsedError.type.trim().slice(0, 100) } : {}),
    ...(typeof parsedError?.param === "string" && parsedError.param.trim() ? { param: parsedError.param.trim().slice(0, 100) } : {}),
  };
}
function thirdPartySuccessfulPayloadFailure(route, status, rawText, contentType = "") {
  if (route.kind !== "third_party" || route.provider?.apiType !== "responses" || status < 200 || status >= 300) return null;
  const provider = String(route.provider?.name || "The third-party provider").trim();
  if (/(?:text\/html|application\/xhtml)/i.test(String(contentType || ""))) {
    return { code: "upstream_success_invalid_json", message: `${provider} returned HTTP ${status} with HTML instead of a Responses JSON payload.` };
  }
  let payload;
  try { payload = JSON.parse(String(rawText || "")); }
  catch { return { code: "upstream_success_invalid_json", message: `${provider} returned HTTP ${status} with malformed JSON instead of a Responses payload.` }; }
  if (!payload || typeof payload !== "object") {
    return { code: "upstream_success_invalid_json", message: `${provider} returned HTTP ${status} with a non-object Responses payload.` };
  }
  const error = payload.error && typeof payload.error === "object" ? payload.error : null;
  if (!error || payload.id || payload.object === "response") return null;
  const upstreamMessage = sanitizeUpstreamErrorText(error.message);
  return {
    code: sanitizeUpstreamErrorCode(error.code) || "upstream_success_error_envelope",
    message: upstreamMessage
      ? `${provider} returned HTTP ${status} with an error envelope. Upstream message: ${upstreamMessage}`
      : `${provider} returned HTTP ${status} with an error envelope instead of a Responses payload.`,
  };
}
function thirdPartyStreamFailure(route, code = "") {
  const provider = String(route.provider?.name || "The third-party provider").trim();
  const messages = {
    upstream_stream_error_envelope: `${provider} sent an error event after starting a stream. The partial stream was preserved, but it was not recorded as a completed response.`,
    upstream_stream_truncated: `${provider} ended a Responses stream before completion. The partial stream was preserved, but it was not recorded as a completed response.`,
    upstream_stream_interrupted: `${provider} interrupted a Responses stream. The partial stream was preserved, but it was not recorded as a completed response.`,
  };
  return { code: code || "upstream_stream_interrupted", message: messages[code] || messages.upstream_stream_interrupted };
}
function sanitizeUpstreamErrorText(value) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || /<!doctype\s+html|<html\b|<body\b/i.test(text)) return "";
  return text.slice(0, 600);
}
function sanitizeUpstreamErrorCode(value) {
  if (typeof value !== "string") return "";
  const code = value.trim();
  return /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : "";
}
function logEvent(event) {
  const usage = normalizeUsage(event.usage);
  const request = normalizeRequestMetrics(event.request);
  const record = {
    at: new Date().toISOString(),
    ...event,
    usage,
    request,
    contextPressure: classifyContextPressure({ usage, request, status: event.status, contextMode: event.contextMode }),
    stream: normalizeStreamMetrics(event.stream),
    diagnostics: normalizeDiagnostics(event.diagnostics),
    route: { id: event.route.id, displayName: event.route.displayName, kind: event.route.kind, providerId: event.route.kind === "official" ? "official" : event.route.providerId || event.route.provider?.id, providerName: event.route.provider?.name || "Official Codex", upstreamModel: event.route.upstreamModel },
  };
  events.unshift(record);
  if (events.length > 50) events.pop();
  try { enqueueRequestHistory(record); }
  catch (error) { console.error(`Codex Relay could not persist request history: ${error.message}`); }
}

async function requestHistory(res, url) {
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100));
  const beforeId = Number.parseInt(url.searchParams.get("before") || "", 10) || null;
  try {
    await flushRequestHistory();
    return json(res, 200, listRequestHistory({ limit, beforeId }));
  }
  catch (error) { throw apiError(500, `无法读取本机请求记录：${error.message}`, "request_history_read_failed"); }
}

async function usageStatisticsResponse(res) {
  try {
    await flushRequestHistory();
    const settings = loadSettings();
    const snapshot = usageStatistics({ providerIdsByRoute: providerIdsByRoute(settings), providerIdentities: providerIdentities(settings) });
    return json(res, 200, usageStatisticsView(snapshot, settings, requestHistoryWriterState()));
  } catch (error) {
    throw apiError(500, `无法读取本机用量统计：${error.message}`, "usage_statistics_read_failed");
  }
}

function usageStatisticsView(snapshot, settings, writerState = {}) {
  const historical = new Map((snapshot.providers || []).map((provider) => [provider.providerId, provider]));
  const used = new Set();
  const official = historical.get("official");
  if (official) used.add("official");
  const providers = [{
    providerId: "official",
    providerName: "Official Codex",
    routeKind: "official",
    apiType: "responses",
    deleted: false,
    today: official?.today || emptyUsageStatistics(),
    total: official?.total || emptyUsageStatistics(),
  }];
  for (const provider of settings.providers || []) {
    const statistics = historical.get(provider.id);
    if (statistics) used.add(statistics.providerId);
    providers.push({
      providerId: provider.id,
      providerName: provider.name,
      routeKind: "third_party",
      apiType: provider.apiType,
      deleted: false,
      today: statistics?.today || emptyUsageStatistics(),
      total: statistics?.total || emptyUsageStatistics(),
    });
  }
  for (const provider of snapshot.providers || []) {
    if (used.has(provider.providerId) || provider.providerId === "official") continue;
    providers.push({ ...provider, apiType: null, deleted: true });
  }
  return {
    ...snapshot,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "本机时区",
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    providers,
    synchronization: {
      status: writerState.lastError ? "error" : "synchronized",
      pending: Math.max(0, Number(writerState.pending || 0)) + Math.max(0, Number(writerState.inFlight || 0)),
      lastError: writerState.lastError ? String(writerState.lastError.message || writerState.lastError) : null,
      checkedAt: new Date().toISOString(),
    },
  };
}

function emptyUsageStatistics() {
  return {
    requestCount: 0, successCount: 0, failureCount: 0, compactionCount: 0,
    usageCount: 0, usageCoverage: null, cacheReportedCount: 0, cacheCoverage: null, cacheHitRate: null,
    inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
    firstAt: null, lastAt: null,
  };
}

function providerIdsByRoute(settings) {
  return Object.fromEntries((settings.thirdPartySlots || []).filter((slot) => slot.id && slot.providerId).map((slot) => [slot.id, slot.providerId]));
}
function providerIdentities(settings) { return (settings.providers || []).map((provider) => ({ providerId: provider.id, providerName: provider.name })); }

async function deleteRequestHistory(res) {
  try {
    await flushRequestHistory();
    const result = clearRequestHistory();
    events.length = 0;
    return json(res, 200, result);
  } catch (error) { throw apiError(500, `无法删除本机请求记录：${error.message}`, "request_history_delete_failed"); }
}

function recentRequestEvents(limit) { return events.slice(0, limit); }

function requestHistorySummary() { return requestHistoryCachedSummary(); }

function primeRequestEvents() {
  try {
    const settings = loadSettings();
    const history = primeRequestHistoryCache({ limit: 50, providerIdsByRoute: providerIdsByRoute(settings) });
    events.splice(0, events.length, ...history.items.map(({ historyId: _historyId, ...event }) => event));
  } catch (error) {
    events.length = 0;
    console.error(`Codex Relay could not initialize request history: ${error.message}`);
  }
}

function normalizeStreamMetrics(value) {
  if (!value || typeof value !== "object") return null;
  return {
    requested: Boolean(value.requested), streaming: Boolean(value.streaming),
    headersMs: finiteMetric(value.headersMs), firstChunkMs: finiteMetric(value.firstChunkMs), chunks: finiteMetric(value.chunks),
    detectedBy: String(value.detectedBy || "").slice(0, 32), contentType: String(value.contentType || "").slice(0, 100),
  };
}
function finiteMetric(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.round(number) : null; }
function nonStreamingMetrics(body, headersMs, contentType) { return { requested: Boolean(body?.stream), streaming: false, headersMs, firstChunkMs: null, chunks: 0, detectedBy: body?.stream ? "non_sse_response" : "not_requested", contentType }; }

function usageFromResponseText(rawText) {
  let latest = null;
  let cacheUsage = null;
  try {
    const response = JSON.parse(rawText);
    latest = response?.usage || null;
    cacheUsage = response?.codex_relay?.cache_usage || null;
  } catch { /* SSE is handled below. */ }
  for (const line of String(rawText || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event?.response?.usage) {
        latest = event.response.usage;
        cacheUsage = event.response?.codex_relay?.cache_usage || cacheUsage;
      }
      else if (event?.usage) latest = event.usage;
    } catch { /* Ignore non-JSON SSE frames. */ }
  }
  return normalizeUsage(cacheUsage ? { ...(latest || {}), ...cacheUsage } : latest);
}

function usageFromResponseObject(response) {
  const usage = response?.usage || null;
  const cacheUsage = response?.codex_relay?.cache_usage || null;
  return normalizeUsage(cacheUsage ? { ...(usage || {}), ...cacheUsage } : usage);
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const has = (target, key) => Boolean(target && Object.prototype.hasOwnProperty.call(target, key));
  const input = finiteToken(usage.input ?? usage.input_tokens ?? usage.prompt_tokens);
  const output = finiteToken(usage.output ?? usage.output_tokens ?? usage.completion_tokens);
  const total = finiteToken(usage.total ?? usage.total_tokens) ?? (input !== null && output !== null ? input + output : null);
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details;
  const cacheReported = Boolean(usage.cacheReported ?? usage.cache_reported)
    || has(usage, "prompt_cache_hit_tokens")
    || has(usage, "prompt_cache_miss_tokens")
    || has(inputDetails, "cached_tokens");
  const cachedInput = finiteToken(usage.cachedInput ?? usage.cached_input ?? usage.prompt_cache_hit_tokens ?? inputDetails?.cached_tokens) ?? 0;
  const explicitMiss = finiteToken(usage.uncachedInput ?? usage.uncached_input ?? usage.prompt_cache_miss_tokens);
  const uncachedInput = explicitMiss ?? (input === null ? null : Math.max(0, input - cachedInput));
  const cacheTotal = cachedInput + (uncachedInput ?? 0);
  const cacheHitRate = cacheReported && cacheTotal > 0 ? Math.round((cachedInput / cacheTotal) * 1000) / 10 : null;
  const reasoningOutput = finiteToken(usage.reasoningOutput ?? usage.reasoning_output ?? usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens) ?? 0;
  if (input === null && output === null && total === null) return null;
  return { input, cachedInput, uncachedInput, cacheReported, cacheHitRate, output, reasoningOutput, total };
}

function requestMetrics(body, headers = {}) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const additionalTools = Array.isArray(body?.input)
    ? body.input.filter((item) => item?.type === "additional_tools").flatMap((item) => Array.isArray(item.tools) ? item.tools : [])
    : [];
  const identity = requestIdentity(body, headers);
  return {
    inboundBytes: Buffer.byteLength(JSON.stringify(body || {})),
    inputBytes: Buffer.byteLength(JSON.stringify(body?.input ?? null)),
    toolsBytes: Buffer.byteLength(JSON.stringify([...tools, ...additionalTools])),
    toolCount: tools.length + additionalTools.length,
    previousResponseIdPresent: Boolean(body?.previous_response_id),
    promptCacheKeyPresent: typeof body?.prompt_cache_key === "string" && Boolean(body.prompt_cache_key),
    clientMetadataPresent: Boolean(body?.client_metadata && typeof body.client_metadata === "object"),
    turnMetadataPresent: Boolean(headerValue(headers, "x-codex-turn-metadata")),
    identitySource: identity.source,
    identityHash: identity.hash,
  };
}

function binaryRequestMetrics(byteLength, headers = {}) {
  const identity = requestIdentity({}, headers);
  return {
    inboundBytes: byteLength,
    inputBytes: byteLength,
    toolsBytes: 0,
    toolCount: 0,
    previousResponseIdPresent: false,
    promptCacheKeyPresent: false,
    clientMetadataPresent: false,
    turnMetadataPresent: Boolean(headerValue(headers, "x-codex-turn-metadata")),
    identitySource: identity.source,
    identityHash: identity.hash,
  };
}

function isOfficialImageEditContentType(value) {
  return /^(?:application\/json|multipart\/form-data)(?:\s*;|$)/i.test(String(value || ""));
}

function normalizeRequestMetrics(value) {
  if (!value || typeof value !== "object") return null;
  return {
    inboundBytes: finiteMetric(value.inboundBytes), inputBytes: finiteMetric(value.inputBytes), toolsBytes: finiteMetric(value.toolsBytes),
    toolCount: finiteMetric(value.toolCount), previousResponseIdPresent: Boolean(value.previousResponseIdPresent),
    promptCacheKeyPresent: Boolean(value.promptCacheKeyPresent), clientMetadataPresent: Boolean(value.clientMetadataPresent), turnMetadataPresent: Boolean(value.turnMetadataPresent),
    identitySource: /^[a-z_]+\.(?:thread_id|conversation_id|session_id)$/.test(String(value.identitySource || "")) ? String(value.identitySource) : null,
    identityHash: /^[a-f0-9]{16}$/.test(String(value.identityHash || "")) ? String(value.identityHash) : null,
  };
}

export function classifyContextPressure({ usage, request, status, contextMode } = {}) {
  const inputTokens = Number(usage?.input);
  const inputBytes = Number(request?.inputBytes);
  const hasTokens = Number.isFinite(inputTokens) && inputTokens >= 0;
  const hasBytes = Number.isFinite(inputBytes) && inputBytes >= 0;
  const high = (hasTokens && inputTokens >= 100_000) || (hasBytes && inputBytes >= 2_000_000);
  const elevated = high || (hasTokens && inputTokens >= 50_000) || (hasBytes && inputBytes >= 1_000_000);
  return {
    level: high ? "high" : elevated ? "elevated" : "normal",
    fullContext: Boolean(elevated && contextMode === "new" && !request?.previousResponseIdPresent),
    cancelled: Number(status) === 499,
    basedOn: hasTokens ? "upstream_usage" : hasBytes ? "request_bytes" : "unavailable",
  };
}

function requestIdentity(body, headers) {
  const candidates = [
    ["client_metadata", body?.client_metadata],
    ["turn_metadata", parseTurnMetadata(headerValue(headers, "x-codex-turn-metadata"))],
  ];
  for (const [container, value] of candidates) {
    const found = identityField(value);
    if (!found) continue;
    return { source: `${container}.${found.field}`, hash: shortRequestHash(`${container}:${found.field}:${found.value}`) };
  }
  return { source: null, hash: null };
}

function identityField(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const [field, aliases] of Object.entries({ thread_id: ["thread_id", "threadId"], conversation_id: ["conversation_id", "conversationId"], session_id: ["session_id", "sessionId"] })) {
    for (const alias of aliases) {
      const candidate = value[alias];
      if (typeof candidate === "string" && candidate.trim()) return { field, value: candidate.trim().slice(0, 512) };
    }
  }
  return null;
}

function parseTurnMetadata(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  for (const candidate of [raw, decodeBase64Json(raw)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* Only known JSON metadata is eligible as a stable identity signal. */ }
  }
  return null;
}

function decodeBase64Json(value) {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) return "";
  try { return Buffer.from(value, "base64url").toString("utf8"); }
  catch { return ""; }
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function shortRequestHash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16); }

function normalizeDiagnostics(value) {
  if (!value || typeof value !== "object") return { attempts: 1, retryReason: null, removedTools: [] };
  const compactionStrategy = normalizeCompactionStrategy(value.compactionStrategy);
  const nativeCompact = normalizeNativeCompactDiagnostics(value.nativeCompact);
  const cacheTrace = normalizeCacheTrace(value.cacheTrace);
  return {
    attempts: Number(value.attempts) === 0 ? 0 : Math.max(1, finiteMetric(value.attempts) || 1),
    upstreamAttempts: value.upstreamAttempts === undefined ? null : finiteMetric(value.upstreamAttempts),
    retryReason: value.retryReason ? String(value.retryReason).slice(0, 80) : null,
    removedTools: Array.isArray(value.removedTools) ? value.removedTools.map(String).slice(0, 10) : [],
    inboundBytes: finiteMetric(value.inboundBytes),
    upstreamBytes: finiteMetric(value.upstreamBytes),
    relayAddedBytes: finiteMetric(value.relayAddedBytes),
    replayBytes: finiteMetric(value.replayBytes),
    cacheKey: normalizeCacheKeyDiagnostics(value.cacheKey),
    ...(cacheTrace ? { cacheTrace } : {}),
    cache: normalizeCacheDiagnostics(value.cache),
    savings: normalizeDeepSeekSavingsDiagnostics(value.savings),
    paidProtection: normalizePaidProtection(value.paidProtection),
    retryProtection: normalizeRetryProtection(value.retryProtection),
    ...(typeof value.isCompaction === "boolean" ? { isCompaction: value.isCompaction } : {}),
    ...(compactionStrategy ? { compactionStrategy } : {}),
    ...(typeof value.cacheHit === "boolean" ? { cacheHit: value.cacheHit } : {}),
    ...(typeof value.deduplicated === "boolean" ? { deduplicated: value.deduplicated } : {}),
    ...(typeof value.circuitOpen === "boolean" ? { circuitOpen: value.circuitOpen } : {}),
    ...(value.failureReason ? { failureReason: String(value.failureReason).slice(0, 120) } : {}),
    ...(nativeCompact ? { nativeCompact } : {}),
  };
}

function normalizeCacheTrace(value) {
  if (!value || typeof value !== "object" || Number(value.version) !== 1) return null;
  const trace = { version: 1 };
  for (const key of ["instructionsHash", "toolsHash", "inputHash", "includeHash", "bodyHash"]) {
    const hash = String(value[key] || "");
    if (hash !== "absent" && !/^[a-f0-9]{16}$/.test(hash)) return null;
    trace[key] = hash;
  }
  return trace;
}

function normalizeCompactionStrategy(value) {
  return ["native_compact", "model_summary", "local_emergency"].includes(value) ? value : "";
}

function normalizeNativeCompactDiagnostics(value) {
  if (!value || typeof value !== "object") return null;
  return {
    attempted: Boolean(value.attempted),
    capabilityBefore: String(value.capabilityBefore || "").slice(0, 40),
    outcome: String(value.outcome || "").slice(0, 40),
    reason: String(value.reason || "").slice(0, 120),
  };
}

function normalizePaidProtection(value) {
  if (!value || typeof value !== "object" || !value.active) return null;
  return {
    active: true,
    blocked: Boolean(value.blocked),
    triggerStatus: finiteMetric(value.triggerStatus),
    retryAfterSeconds: finiteMetric(value.retryAfterSeconds),
    bytesAvoided: finiteMetric(value.bytesAvoided),
    retryAllowed: Boolean(value.retryAllowed),
    scope: value.scope === "turn" ? "turn" : null,
  };
}

function normalizeRetryProtection(value) {
  if (!value || typeof value !== "object" || !value.active) return null;
  return {
    active: true,
    blocked: Boolean(value.blocked),
    triggerStatus: finiteMetric(value.triggerStatus),
    retryAfterSeconds: finiteMetric(value.retryAfterSeconds),
    bytesAvoided: finiteMetric(value.bytesAvoided),
    retryAllowed: Boolean(value.retryAllowed),
    scope: value.scope === "turn" ? "turn" : null,
  };
}

function normalizeCacheKeyDiagnostics(value) {
  if (!value || typeof value !== "object") return null;
  return {
    inboundPresent: Boolean(value.inboundPresent),
    upstreamPresent: Boolean(value.upstreamPresent),
    preserved: typeof value.preserved === "boolean" ? value.preserved : null,
  };
}

function normalizeCacheDiagnostics(value) {
  if (!value || typeof value !== "object" || !value.tracked) return null;
  return {
    tracked: true,
    prefixHash: String(value.prefixHash || "").replace(/[^a-f0-9]/gi, "").slice(0, 16),
    systemHash: String(value.systemHash || "").replace(/[^a-f0-9]/gi, "").slice(0, 16),
    toolsHash: String(value.toolsHash || "").replace(/[^a-f0-9]/gi, "").slice(0, 16),
    prefixChanged: typeof value.prefixChanged === "boolean" ? value.prefixChanged : null,
    changeReasons: Array.isArray(value.changeReasons) ? value.changeReasons.map(String).filter((reason) => ["new_session", "baseline_unavailable", "system", "tools", "history_rewrite"].includes(reason)).slice(0, 5) : [],
    toolSchemaBytes: finiteMetric(value.toolSchemaBytes),
    toolSchemaTokens: finiteMetric(value.toolSchemaTokens),
  };
}

function normalizeDeepSeekSavingsDiagnostics(value) {
  if (!value || typeof value !== "object" || !value.enabled) return null;
  return {
    enabled: true,
    applied: Boolean(value.applied),
    level: ["below_threshold", "moderate", "high", "no_safe_candidates"].includes(value.level) ? value.level : "below_threshold",
    estimatedInputTokensBefore: finiteMetric(value.estimatedInputTokensBefore),
    estimatedInputTokensAfter: finiteMetric(value.estimatedInputTokensAfter),
    estimatedTokensSaved: finiteMetric(value.estimatedTokensSaved),
    prunedToolOutputs: finiteMetric(value.prunedToolOutputs),
    protectedRecentToolOutputs: finiteMetric(value.protectedRecentToolOutputs),
  };
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
function json(res, status, value, headers = {}) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(value)); }
function apiError(statusCode, message, code, stage = null) { const error = new Error(message); error.statusCode = statusCode; error.code = code; error.stage = stage; return error; }
async function bodyJson(req) { return readJsonRequest(req, 2 * 1024 * 1024); }
function optionalBodyJson(req) {
  const length = Number(req.headers["content-length"] || 0);
  if (!length && !req.headers["transfer-encoding"]) return Promise.resolve({});
  return bodyJson(req);
}
export async function classifyStreamingResponse(upstream, streamRequested = false) {
  const upstreamContentType = upstream.headers.get("content-type") || "";
  if (isEventStreamResponse(upstream)) return { response: upstream, streaming: true, detectedBy: "content_type", upstreamContentType };
  if (!streamRequested || !upstream.ok || !upstream.body) return { response: upstream, streaming: false, detectedBy: "not_streaming", upstreamContentType };
  const reader = upstream.body.getReader();
  const prefixChunks = [];
  let prefix = "";
  let done = false;
  while (prefix.length < 512 && prefixChunks.length < 4) {
    const next = await reader.read();
    done = next.done;
    if (done) break;
    prefixChunks.push(next.value);
    prefix += new TextDecoder().decode(next.value, { stream: true });
    if (/^(?:\s)*(?:event|data):/m.test(prefix) || /^(?:\s)*[\[{]/.test(prefix)) break;
  }
  const streaming = /^(?:\s)*(?:event|data):/m.test(prefix);
  const detectedBy = streaming ? "body_sniff" : prefixChunks.length ? "non_sse_response" : "empty_body";
  return { response: rebuildResponse(upstream, prefixChunks, reader, streaming), streaming, detectedBy, upstreamContentType };
}

function rebuildResponse(upstream, prefixChunks, reader, forceEventStream = false) {
  const queued = Array.isArray(prefixChunks) ? [...prefixChunks] : [];
  const stream = new ReadableStream({
    async pull(controller) {
      if (queued.length) { controller.enqueue(queued.shift()); return; }
      const next = await reader.read();
      if (next.done) controller.close(); else controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const headers = new Headers(upstream.headers);
  if (forceEventStream) headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function pipeEventStream(res, upstream, diagnostics = {}, options = {}) {
  const chunks = [];
  const contentType = upstream.headers.get("content-type") || "text/event-stream; charset=utf-8";
  let firstChunkMs = null;
  let chunkCount = 0;
  let receivedChunk = false;
  let headersWritten = false;
  try {
    const reader = upstream.body?.getReader();
    if (!reader) throw new Error("Upstream response body is missing.");
    const writeHeaders = () => {
      if (headersWritten) return;
      headersWritten = true;
      res.writeHead(upstream.status, {
        "content-type": contentType,
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        ...(options.responseHeaders || {}),
      });
      res.flushHeaders?.();
    };
    const nextChunk = async () => {
      const timeoutMs = receivedChunk
        ? options.streamIdleTimeoutMs
        : remainingThirdPartyHttpTimeout(options.firstByteTimeoutMs, options.startedAt || diagnostics.startedAt);
      if (!timeoutMs) return reader.read();
      return waitForThirdPartyHttpProgress(
        reader.read(),
        timeoutMs,
        options.abortController,
        receivedChunk
          ? "Third-party upstream produced no stream data within the configured idle timeout."
          : "Third-party upstream did not send its first response data within the configured first-byte timeout.",
        receivedChunk ? "upstream_stream_idle_timeout" : "upstream_first_byte_timeout",
      );
    };
    const writeChunk = async (value) => {
      const chunk = Buffer.from(value);
      receivedChunk = true;
      chunkCount += 1;
      if (firstChunkMs === null && diagnostics.startedAt) firstChunkMs = Date.now() - diagnostics.startedAt;
      writeHeaders();
      chunks.push(chunk);
      if (!res.write(chunk)) await waitForDrain(res);
    };

    const first = await nextChunk();
    if (first.done) {
      if (options.requireCompletedResponse) throw apiError(502, "Third-party upstream ended the Responses stream before completion.", "upstream_stream_truncated");
      writeHeaders();
      res.end();
      return { text: "", error: false, metrics: streamMetrics(diagnostics, firstChunkMs, chunkCount, contentType) };
    }
    await writeChunk(first.value);
    while (true) {
      const { done, value } = await nextChunk();
      if (done) break;
      await writeChunk(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    // Once bytes reached Codex, HTTP status cannot be rewritten. A terminal
    // Responses event is therefore required before the stream enters history.
    const streamFailure = options.requireCompletedResponse ? responsesStreamFailure(text) : null;
    res.end();
    if (streamFailure) return { text, error: true, statusCode: 502, failureCode: streamFailure, metrics: streamMetrics(diagnostics, firstChunkMs, chunkCount, contentType) };
    return { text, error: false, metrics: streamMetrics(diagnostics, firstChunkMs, chunkCount, contentType) };
  } catch (error) {
    const clientCancelled = options.abortController?.signal?.aborted && !options.abortController?.signal?.reason?.statusCode;
    const statusCode = error?.statusCode || (clientCancelled ? 499 : 502);
    const failureCode = error?.code || (clientCancelled ? "client_cancelled" : "upstream_stream_interrupted");
    if (!headersWritten && statusCode !== 499) throw apiError(statusCode, error?.message || "Third-party upstream interrupted the Responses stream.", failureCode);
    if (!res.writableEnded) res.end();
    return { text: Buffer.concat(chunks).toString("utf8"), error: true, statusCode, failureCode, metrics: streamMetrics(diagnostics, firstChunkMs, chunkCount, contentType) };
  }
}
function responsesStreamFailure(text) {
  let completed = false;
  for (const frame of String(text || "").split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "";
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (event === "error") return "upstream_stream_error_envelope";
    if (event === "response.completed" || data === "[DONE]") completed = true;
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data);
      if (payload?.type === "error" || (payload?.error && !payload?.response)) return "upstream_stream_error_envelope";
      if (payload?.type === "response.completed") completed = true;
    } catch { /* A partial JSON frame is classified as an incomplete stream below. */ }
  }
  return completed ? null : "upstream_stream_truncated";
}
function streamMetrics(diagnostics, firstChunkMs, chunks, contentType) { return { requested: true, streaming: true, headersMs: diagnostics.headersAt && diagnostics.startedAt ? diagnostics.headersAt - diagnostics.startedAt : null, firstChunkMs, chunks, detectedBy: diagnostics.detectedBy || "content_type", contentType: diagnostics.upstreamContentType || contentType }; }
function waitForDrain(res) { return new Promise((resolve) => { res.once("drain", resolve); res.once("close", resolve); }); }
function requestAbortController(req, res) {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });
  return controller;
}
function abortSignal(req, res) { return requestAbortController(req, res).signal; }

function thirdPartyHttpLimits(overrides = {}) {
  const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return {
    firstByteTimeoutMs: positive(overrides.firstByteTimeoutMs, THIRD_PARTY_HTTP_FIRST_BYTE_TIMEOUT_MS),
    streamIdleTimeoutMs: positive(overrides.streamIdleTimeoutMs, THIRD_PARTY_HTTP_STREAM_IDLE_TIMEOUT_MS),
  };
}

function remainingThirdPartyHttpTimeout(timeoutMs, startedAt) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !startedAt) return 0;
  return Math.max(1, timeoutMs - Math.max(0, Date.now() - startedAt));
}

function waitForThirdPartyHttpProgress(promise, timeoutMs, controller, message, code) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = apiError(504, message, code);
      reject(error);
      controller?.abort(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function thirdPartyResponseHeaders(headers, streaming = false, includeContentType = true) {
  const result = includeContentType ? { "content-type": headers.get("content-type") || "application/json" } : {};
  for (const name of ["x-request-id", "openai-request-id", "openai-processing-ms", "openai-version", "retry-after"]) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  for (const [name, value] of headers.entries()) {
    if (/^x-ratelimit-/i.test(name) && value) result[name] = value;
  }
  if (streaming && includeContentType) result["content-type"] = headers.get("content-type") || "text/event-stream; charset=utf-8";
  return result;
}

export function createRelayServer(options = {}) {
  primeRequestEvents();
  ensureThemeAgent();
  server = app(options);
  archivePathRepairMonitor = options.archivePathMonitor
    ? createArchivePathRepairMonitor(typeof options.archivePathMonitor === "object" ? options.archivePathMonitor : {})
    : null;
  if (archivePathRepairMonitor) server.once("listening", () => archivePathRepairMonitor?.start());
  const responsesWebSocket = attachResponsesWebSocket(server, {
    ...options.responsesWebSocket,
    history: chatHistory,
    officialBaseUrl: options.officialBaseUrl,
    recordEvent: options.responsesWebSocket?.recordEvent || logEvent,
  });
  server.on("error", (error) => console.error(`Codex Relay server error: ${error.message}`));
  const closeHttpServer = server.close.bind(server);
  server.close = function closeRelayServer(callback) {
    responsesWebSocket.close();
    archivePathRepairMonitor?.close();
    archivePathRepairMonitor = null;
    return closeHttpServer(async (error) => {
      await flushContextCache();
      try { await closeContextCacheWriter(); }
      catch (contextError) { console.error(`Codex Relay could not finish context cache persistence during shutdown: ${contextError.message}`); }
      try { await closeRequestHistoryWriter(); }
      catch (historyError) { console.error(`Codex Relay could not finish request history persistence during shutdown: ${historyError.message}`); }
      try { await closeCompactCapabilityWriter(); }
      catch (compactError) { console.error(`Codex Relay could not finish Compact capability persistence during shutdown: ${compactError.message}`); }
      console.log("Codex Relay stopped listening.");
      if (typeof callback === "function") callback(error);
    });
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliServer = createRelayServer({ archivePathMonitor: true });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    cliServer.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  cliServer.listen(ROUTER_PORT, ROUTER_HOST, () => console.log(`Codex Relay is ready at http://${ROUTER_HOST}:${ROUTER_PORT}`));
}
