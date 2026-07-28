import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

export function parseCodexClientVersion(value) {
  return String(value || "").match(VERSION_PATTERN)?.[1] || "";
}

export function detectCodexClientVersion({ runVersionCommand = defaultVersionCommand, cachePath = defaultModelsCachePath() } = {}) {
  try {
    const detected = parseCodexClientVersion(runVersionCommand());
    if (detected) return detected;
  } catch { /* Fall through to the local model cache. */ }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return parseCodexClientVersion(cached?.client_version);
  } catch {
    return "";
  }
}

function defaultVersionCommand() {
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "codex";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "codex --version"] : ["--version"];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 3_000, windowsHide: true });
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function defaultModelsCachePath() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "models_cache.json");
}
