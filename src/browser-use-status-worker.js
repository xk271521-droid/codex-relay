import { parentPort } from "node:worker_threads";
import { browserUseEnvironment } from "./browser-use-status.js";

try {
  parentPort?.postMessage({ ok: true, result: browserUseEnvironment() });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: String(error?.message || "Browser control detection failed.") });
}
