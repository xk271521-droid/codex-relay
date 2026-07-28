import { Worker } from "node:worker_threads";

const SAVE_RETRY_LIMIT = 1;
const FLUSH_TIMEOUT_MS = 30_000;
let writer = null;
let pendingSnapshot = null;
let inFlight = null;
let nextSaveId = 1;
let completedSaves = 0;
let lastError = null;
let closeWaiter = null;
let closingPromise = null;
const flushWaiters = new Set();

export function enqueueContextCache(entries) {
  pendingSnapshot = { entries: Array.isArray(entries) ? entries : [], attempts: 0 };
  lastError = null;
  ensureWriter();
  dispatchLatest();
  return contextCacheWriterState();
}

export async function flushContextCacheWriter({ timeoutMs = FLUSH_TIMEOUT_MS } = {}) {
  if (!pendingSnapshot && !inFlight) return contextCacheWriterState();
  ensureWriter();
  const result = new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      flushWaiters.delete(waiter);
      reject(new Error(`Context cache flush timed out after ${timeoutMs} ms.`));
    }, Math.max(250, Number(timeoutMs) || FLUSH_TIMEOUT_MS));
    flushWaiters.add(waiter);
  });
  dispatchLatest();
  return await result;
}

export async function closeContextCacheWriter({ timeoutMs = 3_000 } = {}) {
  if (closingPromise) return await closingPromise;
  closingPromise = (async () => {
    await flushContextCacheWriter({ timeoutMs: Math.max(timeoutMs, FLUSH_TIMEOUT_MS) });
    const activeWriter = writer;
    if (!activeWriter) return contextCacheWriterState();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Context cache writer close timed out after ${timeoutMs} ms.`)), Math.max(250, Number(timeoutMs) || 3_000));
      closeWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      activeWriter.postMessage({ type: "close" });
    });
    if (writer === activeWriter) writer = null;
    await activeWriter.terminate().catch(() => {});
    return contextCacheWriterState();
  })().finally(() => {
    closeWaiter = null;
    closingPromise = null;
  });
  return await closingPromise;
}

export function contextCacheWriterState() {
  return {
    pending: Boolean(pendingSnapshot),
    inFlight: Boolean(inFlight),
    active: Boolean(writer),
    completedSaves,
    lastError,
  };
}

function ensureWriter() {
  if (writer) return writer;
  writer = new Worker(new URL("./context-cache-worker.js", import.meta.url), { execArgv: [] });
  writer.unref();
  const activeWriter = writer;
  activeWriter.on("message", (message) => handleWriterMessage(activeWriter, message));
  activeWriter.on("error", (error) => handleWriterFailure(activeWriter, error));
  activeWriter.on("exit", (code) => {
    if (writer !== activeWriter) return;
    writer = null;
    if (closeWaiter) {
      if (code === 0) closeWaiter.resolve();
      else closeWaiter.reject(new Error(`Context cache writer stopped with exit code ${code}.`));
      return;
    }
    if (code !== 0) retryOrFail(new Error(`Context cache writer stopped with exit code ${code}.`));
  });
  return activeWriter;
}

function dispatchLatest() {
  if (inFlight || !pendingSnapshot) return;
  const activeWriter = ensureWriter();
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  inFlight = { id: nextSaveId++, ...snapshot };
  activeWriter.postMessage({ type: "save", id: inFlight.id, entries: inFlight.entries });
}

function handleWriterMessage(activeWriter, message) {
  if (writer !== activeWriter || !message || typeof message !== "object") return;
  if (message.type === "closed") {
    closeWaiter?.resolve();
    return;
  }
  if (!inFlight || message.id !== inFlight.id) return;
  if (message.type === "saved") {
    completedSaves += 1;
    lastError = null;
    inFlight = null;
    if (pendingSnapshot) dispatchLatest();
    else settleFlushWaiters();
    return;
  }
  if (message.type === "save_error") retryOrFail(new Error(message.error || "Context cache writer failed."));
}

function handleWriterFailure(activeWriter, error) {
  if (writer !== activeWriter) return;
  writer = null;
  if (closeWaiter) closeWaiter.reject(error);
  else retryOrFail(error);
}

function retryOrFail(error) {
  const failed = inFlight;
  inFlight = null;
  lastError = error.message;
  if (pendingSnapshot) {
    ensureWriter();
    dispatchLatest();
    return;
  }
  if (failed && failed.attempts < SAVE_RETRY_LIMIT) {
    pendingSnapshot = { entries: failed.entries, attempts: failed.attempts + 1 };
    ensureWriter();
    dispatchLatest();
    return;
  }
  console.error(`Codex Relay could not persist context cache: ${error.message}`);
  settleFlushWaiters(error);
}

function settleFlushWaiters(error = null) {
  if (!error && (pendingSnapshot || inFlight)) return;
  for (const waiter of flushWaiters) {
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(contextCacheWriterState());
  }
  flushWaiters.clear();
}
