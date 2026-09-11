import { parentPort, workerData } from "node:worker_threads";
import { repairCodexArchivePaths } from "./session-history.js";

try {
  const result = repairCodexArchivePaths(workerData || {});
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: String(error?.message || "Codex archive compatibility repair failed."),
    code: error?.code || "archive_path_repair_failed",
  });
}
