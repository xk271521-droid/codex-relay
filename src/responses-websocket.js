import path from "node:path";
import { Worker } from "node:worker_threads";
import { WebSocket, WebSocketServer } from "ws";
import { activeRoutes } from "./catalog.js";
import { OFFICIAL_CODEX_BASE_URL } from "./constants.js";
import { currentWindowsHttpsProxy, officialWebSocketAgent } from "./official-fetch.js";
import {
  recordPassthroughResponse,
  routeForRequest,
  routingContextMode,
} from "./router.js";
import { loadSettings, officialAccessToken, officialAccountId, paths } from "./store.js";

const RESPONSES_PATHS = new Set(["/v1/responses", "/responses"]);
const HANDSHAKE_HEADER_ALLOWLIST = new Set([
  "openai-model",
  "openai-version",
  "x-codex-turn-state",
  "x-models-etag",
  "x-reasoning-included",
]);
const CLIENT_HEADER_SKIP = new Set([
  "authorization",
  "connection",
  "host",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
  "x-api-key",
  "api-key",
  "openai-api-key",
]);
const DEFAULTS = Object.freeze({
  maxConnections: 32,
  maxPayloadBytes: 64 * 1024 * 1024,
  heartbeatIntervalMs: 15_000,
  // The resolver is warmed when the Relay server is created. Keep a bounded
  // allowance for a slow first worker/SQLite response after a desktop restart.
  threadLookupTimeoutMs: 500,
  threadCacheTtlMs: 2_000,
  mismatchCooldownMs: 30_000,
  backpressureHighWaterMark: 4 * 1024 * 1024,
  backpressureLowWaterMark: 1 * 1024 * 1024,
  backpressureTimeoutMs: 10_000,
});

export function attachResponsesWebSocket(server, options = {}) {
  const limits = websocketLimits(options);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true, maxPayload: limits.maxPayloadBytes });
  const contexts = new WeakMap();
  const officialBaseUrl = options.officialBaseUrl || OFFICIAL_CODEX_BASE_URL;
  const history = options.history;
  const resolver = options.threadModelResolver || createThreadModelResolver({
    databasePath: path.join(path.dirname(paths().codexConfig), "state_5.sqlite"),
    cacheTtlMs: limits.threadCacheTtlMs,
    mismatchCooldownMs: limits.mismatchCooldownMs,
  });
  resolver.warm?.();
  let pendingUpgrades = 0;

  wss.on("headers", (headers, request) => {
    for (const [name, value] of Object.entries(request.codexRelayUpgradeHeaders || {})) headers.push(`${name}: ${value}`);
  });

  const heartbeat = setInterval(() => sweepConnections(wss, contexts, limits), limits.heartbeatIntervalMs);
  heartbeat.unref?.();

  const onUpgrade = async (request, socket, head) => {
    // Clients may abandon a speculative WebSocket upgrade while Relay is
    // resolving the route or writing an HTTP fallback response. Consume those
    // transport errors so Electron does not surface them as main-process
    // uncaught exceptions.
    socket.on("error", ignoreUpgradeSocketError);
    let pathname = "";
    try { pathname = new URL(request.url || "/", "http://localhost").pathname; }
    catch { return rejectUpgrade(socket, 400, "Bad Request"); }
    if (!RESPONSES_PATHS.has(pathname)) return rejectUpgrade(socket, 404, "Not Found");
    if (wss.clients.size + pendingUpgrades >= limits.maxConnections) return rejectUpgrade(socket, 503, "WebSocket capacity reached");

    pendingUpgrades += 1;
    let preconnectedUpstream = null;
    try {
      const settings = loadSettings();
      if (!settings.router.running) return rejectUpgrade(socket, 503, "Relay is not applied");

      const threadId = threadIdFromMetadata(request.headers?.["x-codex-turn-metadata"]);
      const route = await routeFromThread(settings, threadId, resolver, limits.threadLookupTimeoutMs);
      if (route?.kind !== "official") return rejectUpgrade(socket, 426, "Responses use HTTP/SSE.");
      const context = createConnectionContext({ route, threadId, routeSource: route ? "thread_index" : "first_frame" });
      if (route?.kind === "official") {
        try {
          const connected = await connectOfficialWebSocket(request.headers, officialBaseUrl);
          preconnectedUpstream = connected.socket;
          context.upstream = connected.socket;
          request.codexRelayUpgradeHeaders = connected.headers;
        } catch (error) {
          return rejectUpgrade(socket, error.statusCode || 502, "Official WebSocket unavailable");
        }
      }

      wss.handleUpgrade(request, socket, head, (client) => {
        preconnectedUpstream = null;
        contexts.set(client, context);
        serveClientSocket(client, request, contexts, {
          officialBaseUrl,
          history,
          recordEvent: options.recordEvent,
          resolver,
          limits,
        });
      });
    } catch {
      rejectUpgrade(socket, 502, "Responses WebSocket unavailable");
    } finally {
      pendingUpgrades -= 1;
      if (preconnectedUpstream?.readyState < WebSocket.CLOSING) preconnectedUpstream.close(1000);
    }
  };

  server.on("upgrade", onUpgrade);
  return {
    close() {
      server.off("upgrade", onUpgrade);
      clearInterval(heartbeat);
      resolver.close?.();
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

function createConnectionContext({ route = null, threadId = "", routeSource = "first_frame" } = {}) {
  return {
    route,
    routeSource,
    threadId,
    upstream: null,
    upstreamSender: null,
    isAlive: true,
    lastActivityAt: Date.now(),
    inFlight: false,
    officialPending: [],
    officialActive: new Map(),
  };
}

function serveClientSocket(client, request, contexts, options) {
  let context = contexts.get(client) || createConnectionContext();
  let messageChain = Promise.resolve();
  const clientSender = createBufferedSender(client, options.limits, () => {
    context.lastActivityAt = Date.now();
  });

  const closeUpstream = () => {
    finishOfficialRequests(context, options.recordEvent, 499, false);
    if (context.upstream && context.upstream.readyState < WebSocket.CLOSING) context.upstream.close(1000);
  };
  client.on("pong", () => { context.isAlive = true; });
  client.once("close", closeUpstream);
  client.once("error", closeUpstream);

  if (context.upstream) bindOfficialSockets(client, context, clientSender, options);

  client.on("message", (data, isBinary) => {
    context.lastActivityAt = Date.now();
    context.isAlive = true;
    messageChain = messageChain.then(async () => {
      if (isBinary) throw websocketError("Binary Responses frames are not supported.", "binary_frame_unsupported");
      const requestFrame = parseRequestFrame(data);
      const settings = loadSettings();
      const route = routeForRequest(settings, requestFrame.model);

      if (context.route && routeStateKey(context.route) !== routeStateKey(route)) {
        if (context.routeSource === "thread_index" && context.threadId) options.resolver.disablePreRouting?.(context.threadId);
        client.close(1012, "Model route changed; reconnecting.");
        return;
      }
      context.route = route;
      context.routeSource = "first_frame";
      contexts.set(client, context);

      if (route.kind === "official") {
        if (!context.upstream) {
          const connected = await connectOfficialWebSocket(request.headers, options.officialBaseUrl);
          context.upstream = connected.socket;
          contexts.set(client, context);
          bindOfficialSockets(client, context, clientSender, options);
        }
        const body = officialRequestFrame(requestFrame, route);
        context.officialPending.push(createRequestTracker(requestFrame, route, settings, request.headers, options.history));
        await context.upstreamSender.send(JSON.stringify(body));
        return;
      }
      client.close(1012, "Model route changed; reconnecting.");
    }).catch((error) => {
      void sendWebSocketError(client, error);
    });
  });
}

function bindOfficialSockets(client, context, clientSender, options) {
  const upstream = context.upstream;
  context.upstreamSender = createBufferedSender(upstream, options.limits);
  upstream.on("message", (data, isBinary) => {
    context.lastActivityAt = Date.now();
    if (!isBinary) observeOfficialEvent(context, data, options.recordEvent);
    clientSender.send(data, { binary: isBinary }).catch(() => {
      if (client.readyState < WebSocket.CLOSING) client.close(1013, "WebSocket client is too slow.");
    });
  });
  upstream.on("close", (code, reason) => {
    finishOfficialRequests(context, options.recordEvent, code === 1000 ? 499 : 502, false);
    if (client.readyState < WebSocket.CLOSING) client.close(normalizeCloseCode(code), reason.toString().slice(0, 120));
  });
  upstream.on("error", () => {
    finishOfficialRequests(context, options.recordEvent, 502, false);
    if (client.readyState < WebSocket.CLOSING) client.close(1011, "Official WebSocket connection failed.");
  });
}

function observeOfficialEvent(context, data, recordEvent) {
  let event;
  try { event = JSON.parse(Buffer.from(data).toString("utf8")); }
  catch { return; }
  const responseId = String(event?.response?.id || event?.response_id || "");
  let tracker = responseId ? context.officialActive.get(responseId) : null;
  if (event?.type === "response.created") {
    tracker = context.officialPending.shift() || tracker;
    if (tracker && responseId) context.officialActive.set(responseId, tracker);
  }
  tracker ||= context.officialActive.values().next().value || context.officialPending[0] || null;
  if (!tracker) return;
  tracker.firstChunkAt ||= Date.now();
  tracker.chunks += 1;
  if (event?.type === "response.completed") {
    try {
      recordPassthroughResponse(tracker.history, tracker.body, tracker.route, JSON.stringify(event.response || {}), tracker.headers);
    } catch (error) {
      console.error(`Codex Relay could not record official WebSocket history: ${error?.message || "unknown error"}`);
    }
    recordTracker(recordEvent, tracker, 200, true, {
      usage: event.response?.usage || null,
      stream: trackerStreamMetrics(tracker, "official_websocket"),
    });
    if (responseId) context.officialActive.delete(responseId);
  } else if (event?.type === "error" || event?.type === "response.failed") {
    recordTracker(recordEvent, tracker, Number(event?.error?.status || 502), false, {
      usage: event?.response?.usage || null,
      stream: trackerStreamMetrics(tracker, "official_websocket"),
    });
    if (responseId) context.officialActive.delete(responseId);
  }
}

function finishOfficialRequests(context, recordEvent, status, ok) {
  for (const tracker of [...context.officialPending, ...context.officialActive.values()]) {
    recordTracker(recordEvent, tracker, status, ok, { stream: trackerStreamMetrics(tracker, "official_websocket") });
  }
  context.officialPending.length = 0;
  context.officialActive.clear();
}

function createRequestTracker(frame, route, settings, headers, history) {
  const body = { ...frame };
  delete body.type;
  delete body.generate;
  return {
    route,
    startedAt: Date.now(),
    firstChunkAt: null,
    chunks: 0,
    recorded: false,
    contextMode: route.kind === "official" && body.previous_response_id
      ? "official_native_continuation"
      : routingContextMode(settings, body, route, history),
    request: websocketRequestMetrics(body, headers),
    body,
    headers,
    history,
  };
}

function recordTracker(recordEvent, tracker, status, ok, result = {}) {
  if (!tracker || tracker.recorded || typeof recordEvent !== "function") return;
  tracker.recorded = true;
  try {
    recordEvent({
      route: tracker.route,
      status,
      ok,
      durationMs: Date.now() - tracker.startedAt,
      contextMode: result.contextMode || tracker.contextMode,
      reasoning: result.reasoning || null,
      diagnostics: result.diagnostics || { attempts: 1, retryReason: null, transport: "websocket" },
      request: tracker.request,
      stream: result.stream || trackerStreamMetrics(tracker, "websocket"),
      usage: result.usage || null,
    });
  } catch { /* Request diagnostics must not break the WebSocket path. */ }
}

function trackerStreamMetrics(tracker, detectedBy) {
  return {
    requested: true,
    streaming: true,
    headersMs: 0,
    firstChunkMs: tracker.firstChunkAt ? Math.max(0, tracker.firstChunkAt - tracker.startedAt) : null,
    chunks: tracker.chunks,
    detectedBy,
    contentType: "application/websocket",
  };
}

function websocketRequestMetrics(body, headers = {}) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const additionalTools = Array.isArray(body?.input)
    ? body.input.filter((item) => item?.type === "additional_tools").flatMap((item) => Array.isArray(item.tools) ? item.tools : [])
    : [];
  return {
    inboundBytes: Buffer.byteLength(JSON.stringify(body || {})),
    inputBytes: Buffer.byteLength(JSON.stringify(body?.input ?? null)),
    toolsBytes: Buffer.byteLength(JSON.stringify([...tools, ...additionalTools])),
    toolCount: tools.length + additionalTools.length,
    previousResponseIdPresent: Boolean(body?.previous_response_id),
    promptCacheKeyPresent: typeof body?.prompt_cache_key === "string" && Boolean(body.prompt_cache_key),
    clientMetadataPresent: Boolean(body?.client_metadata && typeof body.client_metadata === "object"),
    turnMetadataPresent: Boolean(headers?.["x-codex-turn-metadata"]),
  };
}

function connectOfficialWebSocket(headers, officialBaseUrl) {
  const bearer = officialAccessToken();
  if (!bearer) throw websocketError("Official sign-in is unavailable.", "official_auth_missing", 401);
  const url = officialWebSocketUrl(officialBaseUrl);
  const proxyUrl = url.startsWith("wss:") ? currentWindowsHttpsProxy() : "";
  return connectWebSocketAttempt(url, officialHeaders(headers, bearer, officialAccountId()), proxyUrl)
    .catch((error) => {
      if (!proxyUrl || !isProxyConnectionError(error)) throw error;
      return connectWebSocketAttempt(url, officialHeaders(headers, bearer, officialAccountId()), "");
    });
}

function connectWebSocketAttempt(url, headers, proxyUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers,
      agent: proxyUrl ? officialWebSocketAgent(proxyUrl) : undefined,
      perMessageDeflate: true,
      handshakeTimeout: 10_000,
    });
    let upgradeHeaders = {};
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve({ socket, headers: upgradeHeaders });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.once("upgrade", (response) => { upgradeHeaders = selectHandshakeHeaders(response.headers); });
    socket.once("open", succeed);
    socket.once("unexpected-response", (_request, response) => {
      const error = websocketError(`Official WebSocket returned HTTP ${response.statusCode}.`, "official_websocket_rejected", response.statusCode || 502);
      response.resume();
      fail(error);
    });
    socket.once("error", fail);
  });
}

function officialRequestFrame(frame, route) {
  return { ...frame, model: route.upstreamModel, store: false };
}

function officialHeaders(headers, bearer, accountId) {
  const result = { authorization: `Bearer ${bearer}` };
  if (accountId) result["chatgpt-account-id"] = accountId;
  for (const [name, value] of Object.entries(headers || {})) {
    if (CLIENT_HEADER_SKIP.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

function selectHandshakeHeaders(headers) {
  const selected = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (HANDSHAKE_HEADER_ALLOWLIST.has(name.toLowerCase()) && value !== undefined) selected[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return selected;
}

function officialWebSocketUrl(baseUrl) {
  const url = new URL(`${String(baseUrl).replace(/\/+$/, "")}/responses`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function routeFromThread(settings, threadId, resolver, timeoutMs) {
  if (!threadId) return null;
  const deadline = Date.now() + Math.max(10, Number(timeoutMs) || DEFAULTS.threadLookupTimeoutMs);
  while (true) {
    const remainingMs = Math.max(10, deadline - Date.now());
    const model = await resolver.resolve(threadId, remainingMs);
    if (model) return activeRoutes(settings).find((route) => route.id === model) || null;
    if (Date.now() >= deadline) return null;
    // A new Codex task can open its speculative WebSocket just before the
    // threads row/model becomes visible. Retry only inside the existing
    // bounded handshake budget so third-party fallback stays prompt.
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
}

function threadIdFromMetadata(value) {
  const raw = Array.isArray(value) ? value[0] : String(value || "").trim();
  if (!raw) return "";
  for (const candidate of [raw, decodeBase64Url(raw)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.thread_id) return String(parsed.thread_id);
    } catch { /* Try the next representation. */ }
  }
  return "";
}

function decodeBase64Url(value) {
  try { return Buffer.from(String(value), "base64url").toString("utf8"); }
  catch { return ""; }
}

function parseRequestFrame(data) {
  let frame;
  try { frame = JSON.parse(Buffer.from(data).toString("utf8")); }
  catch { throw websocketError("Responses WebSocket frame is not valid JSON.", "invalid_json"); }
  if (frame?.type !== "response.create" || !frame.model) throw websocketError("Expected a response.create frame with a model.", "invalid_response_create");
  return frame;
}

function routeStateKey(route) {
  return route?.kind === "official"
    ? `official:${route.id}`
    : `${route?.kind || "unknown"}:${route?.providerId || ""}:${route?.id || ""}`;
}

function createThreadModelResolver({ databasePath, cacheTtlMs, mismatchCooldownMs }) {
  let worker = null;
  let workerReady = false;
  let readyWaiters = [];
  const pending = new Map();
  const cache = new Map();
  const cooldowns = new Map();
  let nextId = 1;
  let closed = false;

  function ensureWorker() {
    if (worker || closed) return worker;
    workerReady = false;
    worker = new Worker(new URL("./thread-model-worker.js", import.meta.url), { workerData: { databasePath } });
    worker.on("message", (message) => {
      if (message?.type === "ready") {
        workerReady = true;
        const waiters = readyWaiters;
        readyWaiters = [];
        for (const resolve of waiters) resolve(true);
        return;
      }
      if (message?.type !== "resolved") return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      const model = String(message.model || "");
      // Do not cache a transient empty lookup: task creation and the first
      // speculative WebSocket handshake can race the SQLite thread insert.
      if (model) cache.set(message.threadId, { model, expiresAt: Date.now() + cacheTtlMs });
      else cache.delete(message.threadId);
      item?.resolve?.(model);
    });
    worker.on("error", () => {
      workerReady = false;
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const resolve of waiters) resolve(false);
      settlePending("");
    });
    worker.on("exit", () => {
      worker = null;
      workerReady = false;
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const resolve of waiters) resolve(false);
      settlePending("");
    });
    return worker;
  }

  function settlePending(value) {
    for (const item of pending.values()) item.resolve?.(value);
    pending.clear();
  }

  function waitForReady(timeoutMs) {
    if (workerReady) return Promise.resolve(true);
    const timeout = Math.max(10, Number(timeoutMs) || DEFAULTS.threadLookupTimeoutMs);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = readyWaiters.indexOf(done);
        if (index >= 0) readyWaiters.splice(index, 1);
        resolve(false);
      }, timeout);
      timer.unref?.();
      function done(value) {
        clearTimeout(timer);
        resolve(value);
      }
      readyWaiters.push(done);
    });
  }

  return {
    warm(timeoutMs = 1_000) {
      if (closed) return Promise.resolve(false);
      ensureWorker();
      return waitForReady(timeoutMs);
    },
    async resolve(threadId, timeoutMs) {
      if (closed || !threadId) return "";
      const now = Date.now();
      if ((cooldowns.get(threadId) || 0) > now) return "";
      const cached = cache.get(threadId);
      if (cached && cached.expiresAt > now) return cached.model;
      const activeWorker = ensureWorker();
      if (!activeWorker) return "";
      if (!await waitForReady(timeoutMs)) return "";
      const id = nextId++;
      return await new Promise((resolve) => {
        const item = { resolve };
        pending.set(id, item);
        activeWorker.postMessage({ type: "resolve", id, threadId });
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          item.resolve = null;
          resolve("");
        }, Math.max(10, Number(timeoutMs) || DEFAULTS.threadLookupTimeoutMs));
        timer.unref?.();
        const originalResolve = item.resolve;
        item.resolve = (value) => {
          clearTimeout(timer);
          originalResolve(value);
        };
      });
    },
    disablePreRouting(threadId) {
      if (!threadId) return;
      cache.delete(threadId);
      cooldowns.set(threadId, Date.now() + mismatchCooldownMs);
    },
    close() {
      closed = true;
      workerReady = false;
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const resolve of waiters) resolve(false);
      settlePending("");
      worker?.terminate().catch(() => {});
      worker = null;
    },
  };
}

function sweepConnections(wss, contexts, limits) {
  for (const client of wss.clients) {
    const context = contexts.get(client);
    if (!context) continue;
    if (!context.isAlive) {
      client.terminate();
      continue;
    }
    context.isAlive = false;
    try { client.ping(); }
    catch { client.terminate(); }
  }
}

function createBufferedSender(socket, limits, onActivity = null) {
  let chain = Promise.resolve();
  return {
    send(data, options = {}) {
      const task = chain.then(async () => {
        await waitForWebSocketCapacity(socket, limits);
        await new Promise((resolve, reject) => {
          if (socket.readyState !== WebSocket.OPEN) return reject(websocketError("WebSocket is not open.", "websocket_closed", 499));
          socket.send(data, options, (error) => error ? reject(error) : resolve());
        });
        onActivity?.();
        await waitForWebSocketCapacity(socket, limits);
      });
      chain = task.catch(() => {});
      return task;
    },
  };
}

export async function waitForWebSocketCapacity(socket, options = {}) {
  const limits = websocketLimits(options);
  if (Number(socket?.bufferedAmount || 0) <= limits.backpressureHighWaterMark) return;
  const deadline = Date.now() + limits.backpressureTimeoutMs;
  while (Number(socket?.bufferedAmount || 0) > limits.backpressureLowWaterMark) {
    if (socket.readyState !== WebSocket.OPEN) throw websocketError("WebSocket closed while waiting for backpressure.", "websocket_closed", 499);
    if (Date.now() >= deadline) throw websocketError("WebSocket backpressure timed out.", "websocket_backpressure_timeout", 503);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function websocketLimits(options = {}) {
  const value = { ...DEFAULTS, ...options };
  value.maxConnections = boundedInteger(value.maxConnections, 1, 256, DEFAULTS.maxConnections);
  value.maxPayloadBytes = boundedInteger(value.maxPayloadBytes, 1024, 256 * 1024 * 1024, DEFAULTS.maxPayloadBytes);
  value.heartbeatIntervalMs = boundedInteger(value.heartbeatIntervalMs, 10, 60_000, DEFAULTS.heartbeatIntervalMs);
  value.threadLookupTimeoutMs = boundedInteger(value.threadLookupTimeoutMs, 10, 2_000, DEFAULTS.threadLookupTimeoutMs);
  value.threadCacheTtlMs = boundedInteger(value.threadCacheTtlMs, 50, 60_000, DEFAULTS.threadCacheTtlMs);
  value.mismatchCooldownMs = boundedInteger(value.mismatchCooldownMs, 100, 10 * 60_000, DEFAULTS.mismatchCooldownMs);
  value.backpressureHighWaterMark = boundedInteger(value.backpressureHighWaterMark, 1, 128 * 1024 * 1024, DEFAULTS.backpressureHighWaterMark);
  value.backpressureLowWaterMark = boundedInteger(value.backpressureLowWaterMark, 0, value.backpressureHighWaterMark, DEFAULTS.backpressureLowWaterMark);
  value.backpressureTimeoutMs = boundedInteger(value.backpressureTimeoutMs, 20, 60_000, DEFAULTS.backpressureTimeoutMs);
  return value;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

async function sendWebSocketError(socket, error) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify({
    type: "error",
    error: {
      code: String(error?.code || "relay_websocket_error"),
      message: String(error?.message || "Relay WebSocket request failed."),
    },
  });
  try {
    await new Promise((resolve, reject) => socket.send(payload, (sendError) => sendError ? reject(sendError) : resolve()));
  } catch {
    return;
  }
}

function websocketError(message, code, statusCode = 502) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isProxyConnectionError(error) {
  return ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "PROXY_CONNECT_FAILED"].includes(error?.code);
}

function normalizeCloseCode(code) {
  const value = Number(code);
  return value >= 1000 && value <= 4999 && ![1004, 1005, 1006, 1015].includes(value) ? value : 1011;
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed || !socket.writable) return;
  const body = `${message}\n`;
  const response = `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  try {
    socket.end(response, (error) => {
      if (error && !isExpectedUpgradeSocketError(error)) socket.destroy(error);
    });
  } catch (error) {
    if (!isExpectedUpgradeSocketError(error)) socket.destroy(error);
  }
}

function ignoreUpgradeSocketError(error) {
  if (!isExpectedUpgradeSocketError(error)) {
    console.error(`Codex Relay WebSocket upgrade socket failed: ${error?.message || error}`);
  }
}

function isExpectedUpgradeSocketError(error) {
  return ["ECONNABORTED", "ECONNRESET", "EPIPE", "ERR_STREAM_DESTROYED", "ERR_SOCKET_CLOSED", "ERR_STREAM_WRITE_AFTER_END"].includes(error?.code);
}
