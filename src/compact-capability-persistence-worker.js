import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { normalizeCompactCapabilityProfiles } from "./compact-capabilities.js";

const statePath = String(workerData?.statePath || "");
const version = Number(workerData?.version) || 1;

parentPort.on("message", (message) => {
  if (message?.type === "save") saveSnapshot(message);
  else if (message?.type === "close") closeWriter();
});

function saveSnapshot(message) {
  try {
    const profiles = normalizeCompactCapabilityProfiles(message.profiles);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${message.id}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ version, profiles }, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, statePath);
    parentPort.postMessage({ type: "saved", id: message.id });
  } catch (error) {
    parentPort.postMessage({ type: "save_error", id: message.id, error: error.message || String(error) });
  }
}

function closeWriter() {
  parentPort.postMessage({ type: "closed" });
  parentPort.close();
}
