import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { accumulateUsageStatistics, createUsageStatisticsAccumulator, ensureUsageStatistics, persistUsageStatistics } from "./usage-statistics.js";

const appDir = String(workerData?.appDir || "");
const databasePath = String(workerData?.databasePath || "");
const retainedLimit = Math.max(1, Number(workerData?.limit) || 10_000);

fs.mkdirSync(appDir, { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 2500; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
database.exec("CREATE TABLE IF NOT EXISTS request_history (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, event_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS request_history_created_at ON request_history(created_at DESC);");
ensureUsageStatistics(database);
const insert = database.prepare("INSERT OR IGNORE INTO request_history (fingerprint, created_at, event_json) VALUES (?, ?, ?)");
const count = database.prepare("SELECT COUNT(*) AS count FROM request_history");
const trim = database.prepare("DELETE FROM request_history WHERE id IN (SELECT id FROM request_history ORDER BY id ASC LIMIT ?)");

parentPort.on("message", (message) => {
  if (message?.type === "append") appendBatch(message);
  else if (message?.type === "close") closeWriter();
});

function appendBatch(message) {
  let inserted = 0;
  try {
    const statistics = createUsageStatisticsAccumulator();
    database.exec("BEGIN IMMEDIATE");
    for (const item of Array.isArray(message.records) ? message.records : []) {
      const eventJson = JSON.stringify(item);
      const fingerprint = crypto.createHash("sha256").update(eventJson).digest("hex");
      const changes = Number(insert.run(fingerprint, item.at, eventJson).changes || 0);
      inserted += changes;
      if (changes) accumulateUsageStatistics(statistics, item);
    }
    persistUsageStatistics(database, statistics);
    const beforeTrim = Number(count.get().count || 0);
    const overflow = Math.max(0, beforeTrim - retainedLimit);
    if (overflow) trim.run(overflow);
    const total = Number(count.get().count || 0);
    database.exec("COMMIT");
    parentPort.postMessage({ type: "appended", id: message.id, result: { inserted, trimmed: overflow, total } });
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Keep the original database error. */ }
    parentPort.postMessage({ type: "append_error", id: message.id, error: error.message || String(error) });
  }
}

function closeWriter() {
  try { database.close(); }
  finally {
    parentPort.postMessage({ type: "closed" });
    parentPort.close();
  }
}
