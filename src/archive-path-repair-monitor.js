import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { codexArchivePathDatabaseTargets } from "./session-history.js";

const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_RETRY_DELAYS_MS = [250, 750, 2_500, 7_500];
const STATE_FILE_NAMES = new Set(["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]);

// This monitor deliberately keeps all SQLite work off the Router's request path.
// Codex may persist rollout_path after a response has completed, so a debounced
// watch plus bounded delayed retries closes that timing window without retries upstream.
export function createArchivePathRepairMonitor(options = {}) {
  const codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex"));
  const relayHome = path.resolve(options.relayHome || process.env.CODEX_RELAY_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex-relay"));
  const initialDelayMs = positiveDelay(options.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  const retryDelaysMs = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs.map((value) => positiveDelay(value, 0)).filter(Boolean) : DEFAULT_RETRY_DELAYS_MS;
  const runRepair = options.runRepair || ((workerOptions) => runArchivePathRepairWorker(workerOptions));
  const watch = options.watch !== false;
  const timers = new Set();
  const watchers = [];
  let running = false;
  let queued = false;
  let closed = false;
  let watchTimer = null;

  function start() {
    if (closed) return;
    if (watch) startWatchers();
    for (const delayMs of retryDelaysMs) schedule(delayMs);
  }

  function notifyThirdPartyTurn() {
    if (closed) return;
    for (const delayMs of retryDelaysMs) schedule(delayMs);
  }

  function close() {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
    for (const watcher of watchers) {
      try { watcher.close(); } catch { /* A failed watch must not block shutdown. */ }
    }
    watchers.length = 0;
  }

  function schedule(delayMs) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      requestRepair();
    }, delayMs);
    timer.unref?.();
    timers.add(timer);
  }

  function scheduleWatchRepair() {
    if (closed || watchTimer) return;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      requestRepair();
    }, initialDelayMs);
    watchTimer.unref?.();
  }

  function requestRepair() {
    if (closed) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    Promise.resolve()
      .then(() => runRepair({ codexHome, relayHome }))
      .catch((error) => console.warn(`Codex Relay archive compatibility monitor skipped: ${error?.message || error}`))
      .finally(() => {
        running = false;
        if (!closed && queued) {
          queued = false;
          schedule(0);
        }
      });
  }

  function startWatchers() {
    const directories = new Set(codexArchivePathDatabaseTargets({ codexHome }).map((target) => path.dirname(target)));
    for (const directory of directories) {
      if (!fs.existsSync(directory)) continue;
      try {
        const watcher = fs.watch(directory, { persistent: false }, (_eventType, filename) => {
          if (closed || !isStateDatabaseFile(filename)) return;
          scheduleWatchRepair();
        });
        watcher.on("error", (error) => console.warn(`Codex Relay archive compatibility monitor watch stopped: ${error.message}`));
        watchers.push(watcher);
      } catch (error) {
        console.warn(`Codex Relay archive compatibility monitor could not watch ${directory}: ${error.message}`);
      }
    }
  }

  return { start, notifyThirdPartyTurn, close };
}

export function runArchivePathRepairWorker(options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./archive-path-repair-worker.js", import.meta.url), {
      workerData: options,
      // Electron adds process flags which Node workers reject. The repair worker
      // has no command-line dependency, so never inherit the host process flags.
      execArgv: [],
    });
    let settled = false;
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    worker.once("message", finish((message) => {
      worker.terminate().catch(() => {});
      if (message?.ok) resolve(message.result);
      else {
        const error = new Error(message?.error || "Codex archive compatibility repair failed.");
        error.code = message?.code || "archive_path_repair_failed";
        reject(error);
      }
    }));
    worker.once("error", finish((error) => reject(error)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish((error) => reject(error))(new Error(`Codex archive compatibility worker exited with code ${code}.`));
    });
  });
}

function isStateDatabaseFile(filename) {
  if (!filename) return true;
  return STATE_FILE_NAMES.has(path.basename(String(filename)).toLowerCase());
}

function positiveDelay(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}
