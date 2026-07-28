import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { APP_DATA_DIR } from "./constants.js";
import { COMPACT_CAPABILITY_TTL_MS, compactCapabilityStatus, normalizeCompactCapabilityProfiles, recordCompactCapability } from "./compact-capabilities.js";

const STATE_VERSION = 1;
const SAVE_RETRY_LIMIT = 1;
const FLUSH_TIMEOUT_MS = 30_000;
const APP_DIR = process.env.CODEX_RELAY_HOME || path.join(os.homedir(), APP_DATA_DIR);
const STATE_PATH = path.join(APP_DIR, "compact-capabilities.json");

let profiles = readPersistedProfiles();
let writer = null;
let pendingSnapshot = null;
let inFlight = null;
let nextSaveId = 1;
let completedSaves = 0;
let lastError = null;
let closeWaiter = null;
let closingPromise = null;
const flushWaiters = new Set();

export function compactCapabilityProfiles(baseProfiles = []) {
  const normalized = normalizeCompactCapabilityProfiles([...(Array.isArray(baseProfiles) ? baseProfiles : []), ...profiles]);
  const byFamily = new Map();
  for (const profile of normalized) byFamily.set(`${profile.providerId}\n${profile.upstreamModel}`, profile);
  return [...byFamily.values()];
}

export function enqueueCompactCapabilityResult(target, classification, { now = Date.now() } = {}) {
  const status = storedStatus(classification);
  if (!status || !target?.routeSignature) return { queued: false, status: "unknown" };
  const current = compactCapabilityStatus(profiles, target, { now });
  const nowMs = new Date(now).getTime();
  const remainingMs = current.profile ? Date.parse(current.profile.expiresAt) - nowMs : 0;
  if (current.status === status && current.reason === (classification?.reason || classification?.outcome || "unknown") && remainingMs > COMPACT_CAPABILITY_TTL_MS[status] / 2) {
    return { queued: false, status, unchanged: true };
  }
  profiles = recordCompactCapability(profiles, target, {
    status,
    reason: classification?.reason || classification?.outcome || "unknown",
    now,
  });
  pendingSnapshot = { profiles: structuredClone(profiles), attempts: 0 };
  lastError = null;
  ensureWriter();
  dispatchLatest();
  return { queued: true, status };
}

export async function flushCompactCapabilityWriter({ timeoutMs = FLUSH_TIMEOUT_MS } = {}) {
  if (!pendingSnapshot && !inFlight) return compactCapabilityWriterState();
  ensureWriter();
  const result = new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      flushWaiters.delete(waiter);
      reject(new Error(`Compact capability flush timed out after ${timeoutMs} ms.`));
    }, Math.max(250, Number(timeoutMs) || FLUSH_TIMEOUT_MS));
    flushWaiters.add(waiter);
  });
  dispatchLatest();
  return await result;
}

export async function closeCompactCapabilityWriter({ timeoutMs = 3_000 } = {}) {
  if (closingPromise) return await closingPromise;
  closingPromise = (async () => {
    await flushCompactCapabilityWriter({ timeoutMs: Math.max(timeoutMs, FLUSH_TIMEOUT_MS) });
    const activeWriter = writer;
    if (!activeWriter) return compactCapabilityWriterState();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Compact capability writer close timed out after ${timeoutMs} ms.`)), Math.max(250, Number(timeoutMs) || 3_000));
      closeWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      activeWriter.postMessage({ type: "close" });
    });
    if (writer === activeWriter) writer = null;
    await activeWriter.terminate().catch(() => {});
    return compactCapabilityWriterState();
  })().finally(() => {
    closeWaiter = null;
    closingPromise = null;
  });
  return await closingPromise;
}

export function compactCapabilityWriterState() {
  return {
    pending: Boolean(pendingSnapshot),
    inFlight: Boolean(inFlight),
    active: Boolean(writer),
    completedSaves,
    lastError,
  };
}

export function compactCapabilityPersistencePath() {
  return STATE_PATH;
}

export function reloadCompactCapabilityPersistenceForTests() {
  profiles = readPersistedProfiles();
  return structuredClone(profiles);
}

export function resetCompactCapabilityPersistenceForTests() {
  profiles = [];
  pendingSnapshot = null;
  inFlight = null;
  lastError = null;
  const activeWriter = writer;
  writer = null;
  closeWaiter = null;
  closingPromise = null;
  for (const waiter of flushWaiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("Compact capability persistence was reset."));
  }
  flushWaiters.clear();
  activeWriter?.terminate().catch(() => {});
}

function storedStatus(classification) {
  if (classification?.outcome === "supported") return "supported";
  if (classification?.outcome === "unsupported") return "unsupported";
  if (classification?.outcome === "temporary_failure") return "temporary_failure";
  return "";
}

function readPersistedProfiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (Number(parsed?.version) !== STATE_VERSION) return [];
    return normalizeCompactCapabilityProfiles(parsed?.profiles);
  } catch {
    return [];
  }
}

function ensureWriter() {
  if (writer) return writer;
  writer = new Worker(new URL("./compact-capability-persistence-worker.js", import.meta.url), {
    execArgv: [],
    workerData: { statePath: STATE_PATH, version: STATE_VERSION },
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
      else closeWaiter.reject(new Error(`Compact capability writer stopped with exit code ${code}.`));
      return;
    }
    if (code !== 0) failPending(new Error(`Compact capability writer stopped with exit code ${code}.`));
  });
  return activeWriter;
}

function dispatchLatest() {
  if (inFlight || !pendingSnapshot) return;
  const activeWriter = ensureWriter();
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  inFlight = { id: nextSaveId++, ...snapshot };
  activeWriter.postMessage({ type: "save", id: inFlight.id, profiles: inFlight.profiles });
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
  if (message.type === "save_error") failPending(new Error(message.error || "Compact capability writer failed."));
}

function handleWriterFailure(activeWriter, error) {
  if (writer !== activeWriter) return;
  writer = null;
  if (closeWaiter) closeWaiter.reject(error);
  else failPending(error);
}

function failPending(error) {
  const failed = inFlight;
  inFlight = null;
  lastError = error.message;
  if (pendingSnapshot) {
    ensureWriter();
    dispatchLatest();
    return;
  }
  if (failed && failed.attempts < SAVE_RETRY_LIMIT) {
    pendingSnapshot = { profiles: failed.profiles, attempts: failed.attempts + 1 };
    ensureWriter();
    dispatchLatest();
    return;
  }
  console.error(`Codex Relay could not persist Compact capability state: ${error.message}`);
  settleFlushWaiters(error);
}

function settleFlushWaiters(error = null) {
  if (!error && (pendingSnapshot || inFlight)) return;
  for (const waiter of flushWaiters) {
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(compactCapabilityWriterState());
  }
  flushWaiters.clear();
}
