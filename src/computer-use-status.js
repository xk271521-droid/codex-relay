import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_MS = 30_000;
let cached = null;
let cachedAt = 0;

export function computerUseEnvironment(options = {}) {
  const useCache = !Object.keys(options).length;
  if (useCache && cached && Date.now() - cachedAt < CACHE_MS) return cached;

  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const logRoot = options.logRoot || path.join(localAppData, "Codex", "Logs");
  const logs = recentLogFiles(logRoot);
  const resources = options.resources || resourcesFromLogs(logs) || resourcesFromAppx(options.appxInstallLocation);
  const sourceRuntime = resources ? path.join(resources, "cua_node") : "";
  const sourceManifest = readJson(path.join(sourceRuntime, "manifest.json"));
  const runtimeRoot = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
  const runtimeId = options.runtimeId ||
    matchingInstalledRuntimeId(runtimeRoot, sourceManifest?.runtime_archive_version) ||
    runtimeIdFromStaging(runtimeRoot) ||
    runtimeIdFromLogs(logs);
  const runtimeTarget = runtimeId ? path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node", runtimeId) : "";
  const targetManifest = readJson(path.join(runtimeTarget, "manifest.json"));
  const pluginTarget = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled");
  const sourcePluginManifestPath = resources ? path.join(resources, "plugins", "openai-bundled", "plugins", "computer-use", ".codex-plugin", "plugin.json") : "";
  const targetPluginManifestPath = path.join(pluginTarget, "plugins", "computer-use", ".codex-plugin", "plugin.json");
  const sourcePluginManifest = readJson(sourcePluginManifestPath);
  const targetPluginManifest = readJson(targetPluginManifestPath);
  const pluginReady = Boolean(
    sourcePluginManifest?.version &&
    sourcePluginManifest.version === targetPluginManifest?.version &&
    fileFingerprint(sourcePluginManifestPath) === fileFingerprint(targetPluginManifestPath) &&
    fs.existsSync(path.join(pluginTarget, "plugins", "computer-use", "scripts", "computer-use-client.mjs")),
  );
  const runtimeReady = Boolean(
    sourceManifest?.runtime_archive_version &&
    sourceManifest.runtime_archive_version === targetManifest?.runtime_archive_version &&
    fs.existsSync(path.join(runtimeTarget, "bin", "node.exe")),
  );
  const environmentReady = pluginReady && runtimeReady;
  const result = {
    environmentReady,
    pluginReady,
    runtimeReady,
    runtimeId,
    repairAvailable: Boolean(resources && runtimeId && sourceManifest && sourcePluginManifest),
    sourcePluginVersion: String(sourcePluginManifest?.version || ""),
    installedPluginVersion: String(targetPluginManifest?.version || ""),
    sourceRuntimeVersion: String(sourceManifest?.runtime_archive_version || ""),
    installedRuntimeVersion: String(targetManifest?.runtime_archive_version || ""),
    reason: environmentReady ? "ready" : !resources ? "resources_unknown" : !runtimeId ? "runtime_missing" : !targetPluginManifest ? "plugin_cache_missing" : !pluginReady ? "plugin_cache_outdated" : "runtime_missing",
  };
  if (useCache) {
    cached = result;
    cachedAt = Date.now();
  }
  return result;
}

export function resetComputerUseStatusCache() {
  cached = null;
  cachedAt = 0;
}

function recentLogFiles(root) {
  const files = [];
  walk(root, files);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 80);
}

function walk(root, files) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walk(target, files);
    else if (entry.isFile() && entry.name.endsWith(".log")) {
      try { files.push({ path: target, mtimeMs: fs.statSync(target).mtimeMs }); } catch { /* Ignore transient logs. */ }
    }
  }
}

function resourcesFromLogs(logs) {
  for (const log of logs) {
    const text = readTail(log.path);
    const matches = [...text.matchAll(/sourcePath="([^"]+cua_node)"/g)];
    const raw = matches.at(-1)?.[1];
    if (!raw) continue;
    const sourceRuntime = raw.replaceAll("\\\\", "\\");
    const resources = path.dirname(sourceRuntime);
    if (fs.existsSync(path.join(resources, "cua_node", "manifest.json"))) return resources;
  }
  return "";
}

function runtimeIdFromLogs(logs) {
  for (const log of logs) {
    const text = readTail(log.path);
    const matches = [...text.matchAll(/runtimes(?:\\\\|\\)cua_node(?:\\\\|\\)\.staging-([A-Fa-f0-9]+)-/g)];
    if (matches.length) return matches.at(-1)[1];
  }
  return "";
}

function resourcesFromAppx(installLocation) {
  let location = String(installLocation || "").trim();
  if (!location && process.platform === "win32") {
    try {
      location = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
      ], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
    } catch { return ""; }
  }
  if (!location) return "";
  const resources = path.join(location, "app", "resources");
  return fs.existsSync(path.join(resources, "cua_node", "manifest.json")) &&
    fs.existsSync(path.join(resources, "plugins", "openai-bundled")) ? resources : "";
}

function matchingInstalledRuntimeId(root, sourceVersion) {
  if (!sourceVersion) return "";
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return ""; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]+$/i.test(entry.name)) continue;
    const target = path.join(root, entry.name);
    const manifest = readJson(path.join(target, "manifest.json"));
    if (manifest?.runtime_archive_version !== sourceVersion || !fs.existsSync(path.join(target, "bin", "node.exe"))) continue;
    try { candidates.push({ id: entry.name, mtimeMs: fs.statSync(target).mtimeMs }); }
    catch { /* Ignore transient runtime entries. */ }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.id || "";
}

function runtimeIdFromStaging(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return ""; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^\.staging-([a-f0-9]+)-/i);
    if (!match) continue;
    try { candidates.push({ id: match[1], mtimeMs: fs.statSync(path.join(root, entry.name)).mtimeMs }); }
    catch { /* Ignore transient staging entries. */ }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.id || "";
}

function readTail(file) {
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, 512_000);
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally { fs.closeSync(handle); }
  } catch { return ""; }
}

function readJson(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function fileFingerprint(file) {
  if (!file) return "";
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
  catch { return ""; }
}
