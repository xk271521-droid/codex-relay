import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { APP_DATA_DIR } from "./constants.js";
import { accumulateUsageStatistics, createUsageStatisticsAccumulator, ensureUsageStatistics, persistUsageStatistics, readUsageStatistics } from "./usage-statistics.js";

export const REQUEST_HISTORY_LIMIT = 10_000;
const WRITE_BATCH_SIZE = 32;
const WRITE_BATCH_DELAY_MS = 100;
const WRITE_RETRY_LIMIT = 2;
const WRITE_RETRY_DELAY_MS = 150;
const WRITE_FLUSH_TIMEOUT_MS = 5_000;
const APP_DIR = process.env.CODEX_RELAY_HOME || path.join(os.homedir(), APP_DATA_DIR);
const DATABASE_PATH = path.join(APP_DIR, "request-history.sqlite");
let pendingRecords = [];
let inFlightBatch = null;
let writer = null;
let batchTimer = null;
let retryTimer = null;
let nextBatchId = 1;
let cachedTotal = null;
let completedBatches = 0;
let lastWriterError = null;
let closeWaiter = null;
let closingPromise = null;
let writerClosing = false;
const flushWaiters = new Set();

export function requestHistoryPath() { return DATABASE_PATH; }

export function appendRequestHistory(records) {
  const items = (Array.isArray(records) ? records : [records]).map(sanitizeRequestRecord).filter(Boolean);
  if (!items.length) return { inserted: 0, trimmed: 0, total: requestHistoryCount() };
  const result = withDatabase((database) => {
    const insert = database.prepare("INSERT OR IGNORE INTO request_history (fingerprint, created_at, event_json) VALUES (?, ?, ?)");
    const count = database.prepare("SELECT COUNT(*) AS count FROM request_history");
    const trim = database.prepare("DELETE FROM request_history WHERE id IN (SELECT id FROM request_history ORDER BY id ASC LIMIT ?)");
    const statistics = createUsageStatisticsAccumulator();
    let inserted = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        const eventJson = JSON.stringify(item);
        const fingerprint = crypto.createHash("sha256").update(eventJson).digest("hex");
        const changes = Number(insert.run(fingerprint, item.at, eventJson).changes || 0);
        inserted += changes;
        if (changes) accumulateUsageStatistics(statistics, item);
      }
      persistUsageStatistics(database, statistics);
      const beforeTrim = Number(count.get().count || 0);
      const overflow = Math.max(0, beforeTrim - REQUEST_HISTORY_LIMIT);
      if (overflow) trim.run(overflow);
      const total = Number(count.get().count || 0);
      database.exec("COMMIT");
      return { inserted, trimmed: Math.max(0, beforeTrim - total), total };
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Keep the original database error. */ }
      throw error;
    }
  });
  cachedTotal = result.total;
  return result;
}

export function enqueueRequestHistory(records) {
  const items = (Array.isArray(records) ? records : [records]).map(sanitizeRequestRecord).filter(Boolean);
  if (!items.length) return { queued: 0, pending: pendingRecords.length + (inFlightBatch?.records.length || 0) };
  pendingRecords.push(...items.map((record) => ({ record, attempts: 0 })));
  cachedTotal = Math.min(REQUEST_HISTORY_LIMIT, Math.max(0, Number(cachedTotal) || 0) + items.length);
  lastWriterError = null;
  if (writerClosing) return { queued: items.length, pending: pendingRecords.length + (inFlightBatch?.records.length || 0) };
  ensureWriter();
  if (pendingRecords.length >= WRITE_BATCH_SIZE) dispatchNextBatch();
  else scheduleBatch();
  return { queued: items.length, pending: pendingRecords.length + (inFlightBatch?.records.length || 0) };
}

export async function flushRequestHistory({ timeoutMs = WRITE_FLUSH_TIMEOUT_MS } = {}) {
  if (writerClosing) throw new Error("Request history writer is closing.");
  clearTimeout(batchTimer);
  batchTimer = null;
  clearTimeout(retryTimer);
  retryTimer = null;
  if (!pendingRecords.length && !inFlightBatch) return { total: Math.max(0, Number(cachedTotal) || 0), batches: completedBatches };
  ensureWriter();
  const result = new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      flushWaiters.delete(waiter);
      reject(new Error(`Request history flush timed out after ${timeoutMs} ms.`));
    }, Math.max(250, Number(timeoutMs) || WRITE_FLUSH_TIMEOUT_MS));
    flushWaiters.add(waiter);
  });
  if (!inFlightBatch) dispatchNextBatch();
  return await result;
}

export async function closeRequestHistoryWriter({ timeoutMs = 3_000 } = {}) {
  if (closingPromise) return await closingPromise;
  closingPromise = (async () => {
    let flushError = null;
    try { await flushRequestHistory({ timeoutMs }); }
    catch (error) { flushError = error; }
    writerClosing = true;
    clearTimeout(batchTimer);
    clearTimeout(retryTimer);
    batchTimer = null;
    retryTimer = null;
    const activeWriter = writer;
    if (activeWriter) {
      if (flushError) {
        requeueInFlightBatch();
        writer = null;
        settleFlushWaiters(flushError);
        await activeWriter.terminate().catch(() => {});
      } else {
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Request history writer close timed out after ${timeoutMs} ms.`)), Math.max(250, Number(timeoutMs) || 3_000));
            closeWaiter = {
              resolve: () => { clearTimeout(timer); resolve(); },
              reject: (error) => { clearTimeout(timer); reject(error); },
            };
            activeWriter.postMessage({ type: "close" });
          });
        } finally {
          requeueInFlightBatch();
          closeWaiter = null;
          if (writer === activeWriter) writer = null;
          await activeWriter.terminate().catch(() => {});
        }
      }
    } else if (flushError) {
      requeueInFlightBatch();
      settleFlushWaiters(flushError);
    }
    clearTimeout(batchTimer);
    clearTimeout(retryTimer);
    batchTimer = null;
    retryTimer = null;
    closeWaiter = null;
    writer = null;
    if (flushError) throw flushError;
    return { total: Math.max(0, Number(cachedTotal) || 0), batches: completedBatches };
  })().finally(() => {
    writerClosing = false;
    clearTimeout(batchTimer);
    clearTimeout(retryTimer);
    batchTimer = null;
    retryTimer = null;
    closeWaiter = null;
    if (writerClosing) writer = null;
    closingPromise = null;
  });
  return await closingPromise;
}

export function primeRequestHistoryCache({ limit = 50, providerIdsByRoute = null } = {}) {
  const snapshot = withDatabase((database) => listRequestHistoryFromDatabase(database, { limit }), { providerIdsByRoute });
  cachedTotal = snapshot.total;
  return snapshot;
}

export function requestHistoryCachedSummary() {
  return { total: Math.max(0, Number(cachedTotal) || 0), retainedLimit: REQUEST_HISTORY_LIMIT };
}

export function requestHistoryWriterState() {
  return {
    pending: pendingRecords.length,
    inFlight: inFlightBatch?.records.length || 0,
    batches: completedBatches,
    total: Math.max(0, Number(cachedTotal) || 0),
    active: Boolean(writer),
    closing: writerClosing,
    lastError: lastWriterError,
  };
}

export function listRequestHistory({ limit = 100, beforeId = null } = {}) {
  return withDatabase((database) => listRequestHistoryFromDatabase(database, { limit, beforeId }));
}

function listRequestHistoryFromDatabase(database, { limit = 100, beforeId = null } = {}) {
  const pageSize = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 100)));
  const cursor = Number.isSafeInteger(Number(beforeId)) && Number(beforeId) > 0 ? Number(beforeId) : null;
  const rows = cursor
    ? database.prepare("SELECT id, event_json FROM request_history WHERE id < ? ORDER BY id DESC LIMIT ?").all(cursor, pageSize + 1)
    : database.prepare("SELECT id, event_json FROM request_history ORDER BY id DESC LIMIT ?").all(pageSize + 1);
  const hasMore = rows.length > pageSize;
  if (hasMore) rows.pop();
  const items = rows.map((row) => {
    try { return { historyId: Number(row.id), ...JSON.parse(row.event_json) }; }
    catch { return null; }
  }).filter(Boolean);
  const total = Number(database.prepare("SELECT COUNT(*) AS count FROM request_history").get().count || 0);
  return { items, total, limit: pageSize, hasMore, nextBeforeId: hasMore ? items.at(-1)?.historyId || null : null, retainedLimit: REQUEST_HISTORY_LIMIT };
}

export function clearRequestHistory() {
  const result = withDatabase((database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const deleted = Number(database.prepare("DELETE FROM request_history").run().changes || 0);
      database.exec("COMMIT");
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return { deleted, total: 0, retainedLimit: REQUEST_HISTORY_LIMIT };
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Keep the original database error. */ }
      throw error;
    }
  });
  cachedTotal = 0;
  return result;
}

export function requestHistoryCount() {
  const total = withDatabase((database) => Number(database.prepare("SELECT COUNT(*) AS count FROM request_history").get().count || 0));
  cachedTotal = total;
  return total;
}

export function usageStatistics({ dayKey, providerIdsByRoute = null, providerIdentities = [] } = {}) {
  return withDatabase((database) => readUsageStatistics(database, { dayKey, providerIdentities }), { providerIdsByRoute });
}

export function sanitizeRequestRecord(event) {
  if (!event || typeof event !== "object") return null;
  const at = validTimestamp(event.at) || new Date().toISOString();
  return compactObject({
    at,
    status: finiteNumber(event.status),
    ok: Boolean(event.ok),
    durationMs: finiteNumber(event.durationMs),
    contextMode: safeString(event.contextMode, 80),
    route: pick(event.route, ["id", "displayName", "kind", "providerId", "providerName", "upstreamModel"]),
    reasoning: pick(event.reasoning, ["selected", "sent", "parameter", "preset", "changed"]),
    usage: pickNumbersAndBooleans(event.usage, ["input", "cachedInput", "uncachedInput", "cacheReported", "cacheHitRate", "output", "reasoningOutput", "total"]),
    stream: pickNumbersAndBooleans(event.stream, ["requested", "streaming", "headersMs", "firstChunkMs", "chunks", "detectedBy", "contentType"]),
    diagnostics: sanitizeDiagnostics(event.diagnostics),
    request: sanitizeRequest(event.request),
    contextPressure: pick(event.contextPressure, ["level", "fullContext", "cancelled", "basedOn"]),
  });
}

function withDatabase(operation, { providerIdsByRoute = null } = {}) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const database = new DatabaseSync(DATABASE_PATH);
  try {
    database.exec("PRAGMA busy_timeout = 2500; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    database.exec("CREATE TABLE IF NOT EXISTS request_history (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, event_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS request_history_created_at ON request_history(created_at DESC);");
    ensureUsageStatistics(database, { providerIdsByRoute });
    return operation(database);
  } finally { database.close(); }
}

function ensureWriter() {
  if (writerClosing) return null;
  if (writer) return writer;
  writer = new Worker(new URL("./request-history-worker.js", import.meta.url), {
    workerData: { appDir: APP_DIR, databasePath: DATABASE_PATH, limit: REQUEST_HISTORY_LIMIT },
    execArgv: [],
  });
  writer.unref();
  const activeWriter = writer;
  activeWriter.on("message", (message) => handleWriterMessage(activeWriter, message));
  activeWriter.on("error", (error) => handleWriterFailure(activeWriter, error));
  activeWriter.on("exit", (code) => {
    if (writer !== activeWriter) return;
    writer = null;
    if (closeWaiter) {
      if (code === 0) closeWaiter.resolve();
      else closeWaiter.reject(new Error(`Request history writer stopped with exit code ${code}.`));
      return;
    }
    if (code !== 0) handleInterruptedBatch(new Error(`Request history writer stopped with exit code ${code}.`));
  });
  return activeWriter;
}

function scheduleBatch() {
  if (writerClosing || batchTimer || inFlightBatch || !pendingRecords.length) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    dispatchNextBatch();
  }, WRITE_BATCH_DELAY_MS);
  batchTimer.unref?.();
}

function dispatchNextBatch() {
  clearTimeout(batchTimer);
  batchTimer = null;
  if (inFlightBatch || !pendingRecords.length) {
    if (!pendingRecords.length && !inFlightBatch) settleFlushWaiters();
    return;
  }
  const activeWriter = ensureWriter();
  if (!activeWriter) return;
  const queued = pendingRecords.splice(0, WRITE_BATCH_SIZE);
  inFlightBatch = {
    id: nextBatchId++,
    records: queued.map((item) => item.record),
    attempts: Math.max(...queued.map((item) => item.attempts), 0),
  };
  activeWriter.postMessage({ type: "append", id: inFlightBatch.id, records: inFlightBatch.records });
}

function handleWriterMessage(activeWriter, message) {
  if (writer !== activeWriter || !message || typeof message !== "object") return;
  if (message.type === "closed") {
    closeWaiter?.resolve();
    return;
  }
  if (!inFlightBatch || message.id !== inFlightBatch.id) return;
  if (message.type === "appended") {
    cachedTotal = Math.max(0, Number(message.result?.total) || 0);
    completedBatches += 1;
    lastWriterError = null;
    inFlightBatch = null;
    if (pendingRecords.length) dispatchNextBatch();
    else settleFlushWaiters();
    return;
  }
  if (message.type === "append_error") retryInterruptedBatch(new Error(message.error || "Request history writer failed."));
}

function handleWriterFailure(activeWriter, error) {
  if (writer !== activeWriter) return;
  writer = null;
  if (closeWaiter) closeWaiter.reject(error);
  else handleInterruptedBatch(error);
}

function handleInterruptedBatch(error) {
  if (!inFlightBatch) {
    lastWriterError = error.message;
    settleFlushWaiters(error);
    return;
  }
  retryInterruptedBatch(error);
}

function retryInterruptedBatch(error) {
  const batch = inFlightBatch;
  inFlightBatch = null;
  lastWriterError = error.message;
  if (writerClosing) {
    if (batch) pendingRecords.unshift(...batch.records.map((record) => ({ record, attempts: batch.attempts })));
    settleFlushWaiters(error);
    return;
  }
  if (!batch || batch.attempts >= WRITE_RETRY_LIMIT) {
    console.error(`Codex Relay could not persist request history: ${error.message}`);
    if (batch) {
      pendingRecords.unshift(...batch.records.map((record) => ({ record, attempts: batch.attempts })));
      if (pendingRecords.length > REQUEST_HISTORY_LIMIT) pendingRecords = pendingRecords.slice(-REQUEST_HISTORY_LIMIT);
    }
    settleFlushWaiters(error);
    return;
  }
  pendingRecords.unshift(...batch.records.map((record) => ({ record, attempts: batch.attempts + 1 })));
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!writer) ensureWriter();
    dispatchNextBatch();
  }, WRITE_RETRY_DELAY_MS);
  retryTimer.unref?.();
}

function requeueInFlightBatch() {
  const batch = inFlightBatch;
  inFlightBatch = null;
  if (!batch) return;
  pendingRecords.unshift(...batch.records.map((record) => ({ record, attempts: batch.attempts })));
  if (pendingRecords.length > REQUEST_HISTORY_LIMIT) pendingRecords = pendingRecords.slice(-REQUEST_HISTORY_LIMIT);
}

function settleFlushWaiters(error = null) {
  if (!error && (pendingRecords.length || inFlightBatch)) return;
  for (const waiter of flushWaiters) {
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve({ total: Math.max(0, Number(cachedTotal) || 0), batches: completedBatches });
  }
  flushWaiters.clear();
}

function sanitizeDiagnostics(value) {
  if (!value || typeof value !== "object") return null;
  return compactObject({
    attempts: finiteNumber(value.attempts),
    upstreamAttempts: finiteNumber(value.upstreamAttempts),
    retryReason: safeString(value.retryReason, 80),
    removedTools: Array.isArray(value.removedTools) ? value.removedTools.map((item) => safeString(item, 80)).filter(Boolean).slice(0, 10) : [],
    inboundBytes: finiteNumber(value.inboundBytes),
    upstreamBytes: finiteNumber(value.upstreamBytes),
    relayAddedBytes: finiteNumber(value.relayAddedBytes),
    replayBytes: finiteNumber(value.replayBytes),
    cacheKey: pick(value.cacheKey, ["inboundPresent", "upstreamPresent", "preserved"]),
    cacheTrace: pick(value.cacheTrace, ["version", "instructionsHash", "toolsHash", "inputHash", "includeHash", "bodyHash"]),
    cache: pick(value.cache, ["tracked", "prefixHash", "systemHash", "toolsHash", "prefixChanged", "changeReasons", "toolSchemaBytes", "toolSchemaTokens"]),
    savings: pick(value.savings, ["enabled", "applied", "level", "estimatedInputTokensBefore", "estimatedInputTokensAfter", "estimatedTokensSaved", "prunedToolOutputs", "protectedRecentToolOutputs"]),
    paidProtection: pick(value.paidProtection, ["active", "blocked", "triggerStatus", "retryAfterSeconds", "bytesAvoided", "retryAllowed", "scope"]),
    retryProtection: pick(value.retryProtection, ["active", "blocked", "triggerStatus", "retryAfterSeconds", "bytesAvoided", "retryAllowed", "scope"]),
    isCompaction: typeof value.isCompaction === "boolean" ? value.isCompaction : undefined,
    compactionStrategy: ["native_compact", "model_summary", "local_emergency"].includes(value.compactionStrategy) ? value.compactionStrategy : undefined,
    cacheHit: typeof value.cacheHit === "boolean" ? value.cacheHit : undefined,
    deduplicated: typeof value.deduplicated === "boolean" ? value.deduplicated : undefined,
    circuitOpen: typeof value.circuitOpen === "boolean" ? value.circuitOpen : undefined,
    failureReason: safeString(value.failureReason, 120),
    nativeCompact: pick(value.nativeCompact, ["attempted", "capabilityBefore", "outcome", "reason"]),
    nativeContinuation: pick(value.nativeContinuation, ["mode", "reason", "priorItems", "incrementalItems"]),
  });
}

function sanitizeRequest(value) {
  if (!value || typeof value !== "object") return null;
  return compactObject({
    inboundBytes: finiteNumber(value.inboundBytes), inputBytes: finiteNumber(value.inputBytes), toolsBytes: finiteNumber(value.toolsBytes), toolCount: finiteNumber(value.toolCount),
    previousResponseIdPresent: Boolean(value.previousResponseIdPresent), promptCacheKeyPresent: Boolean(value.promptCacheKeyPresent), clientMetadataPresent: Boolean(value.clientMetadataPresent), turnMetadataPresent: Boolean(value.turnMetadataPresent),
    identitySource: safeString(value.identitySource, 80), identityHash: /^[a-f0-9]{16}$/.test(String(value.identityHash || "")) ? String(value.identityHash) : null,
  });
}

function pick(value, keys) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "boolean" || typeof item === "number") result[key] = item;
    else if (typeof item === "string") result[key] = safeString(item, 2048);
    else if (Array.isArray(item)) result[key] = item.map((entry) => safeString(entry, 120)).filter(Boolean).slice(0, 20);
    else if (item === null) result[key] = null;
  }
  return compactObject(result);
}

function pickNumbersAndBooleans(value, keys) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of keys) {
    if (typeof value[key] === "boolean") result[key] = value[key];
    else result[key] = finiteNumber(value[key]);
  }
  return compactObject(result);
}

function compactObject(value) {
  const entries = Object.entries(value || {}).filter(([, item]) => item !== undefined);
  return entries.length ? Object.fromEntries(entries) : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function safeString(value, limit) { return typeof value === "string" && value.trim() ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, limit) : null; }
function validTimestamp(value) { const text = String(value || ""); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text) ? text : ""; }
