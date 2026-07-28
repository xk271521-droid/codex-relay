import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const databasePath = String(workerData?.databasePath || "");

parentPort?.on("message", (message) => {
  if (message?.type !== "resolve") return;
  parentPort.postMessage({
    type: "resolved",
    id: message.id,
    threadId: message.threadId,
    model: resolveThreadModel(message.threadId),
  });
});

parentPort?.postMessage({ type: "ready" });

function resolveThreadModel(threadId) {
  if (!databasePath || !threadId || !fs.existsSync(databasePath)) return "";
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 25");
    return String(database.prepare("SELECT model FROM threads WHERE id = ? LIMIT 1").get(threadId)?.model || "");
  } catch {
    return "";
  } finally {
    database?.close();
  }
}
