import { parentPort } from "node:worker_threads";
import { saveContextCache } from "./store.js";

parentPort.on("message", (message) => {
  if (message?.type === "save") saveSnapshot(message);
  else if (message?.type === "close") closeWriter();
});

function saveSnapshot(message) {
  try {
    saveContextCache(message.entries);
    parentPort.postMessage({ type: "saved", id: message.id });
  } catch (error) {
    parentPort.postMessage({ type: "save_error", id: message.id, error: error.message || String(error) });
  }
}

function closeWriter() {
  parentPort.postMessage({ type: "closed" });
  parentPort.close();
}
