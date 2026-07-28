import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_MS = 10_000;
const CODEX_EXECUTABLES = ["codex.exe", "codex-code-mode-host.exe", "codex-windows-sandbox-setup.exe", "codex-command-runner.exe"];
const RG_EXECUTABLES = ["rg.exe"];
let cached = null;
let cachedAt = 0;

export function browserUseEnvironment(options = {}) {
  const useCache = !Object.keys(options).length;
  if (useCache && cached && Date.now() - cachedAt < CACHE_MS) return cached;

  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const resources = options.resources || resourcesFromAppx(options.appxInstallLocation);
  const plugins = inspectPlugins({ codexHome, resources });
  const executables = inspectStableExecutables({ localAppData, resources });
  const extensionConfig = plugins.extensionConfig || {};
  const chromePath = options.chromePath || findChrome(localAppData);
  const chromeRunning = options.chromeRunning ?? isChromeRunning(options.runCommand || defaultRunCommand);
  const extension = inspectChromeExtension({
    chromeUserDataDir: options.chromeUserDataDir || path.join(localAppData, "Google", "Chrome", "User Data"),
    extensionId: extensionConfig.extensionId,
    profileDirectory: options.profileDirectory,
  });
  const nativeHost = inspectNativeHost({
    extensionId: extensionConfig.extensionId,
    hostName: extensionConfig.extensionHostName,
    registryManifestPath: options.registryManifestPath,
    runCommand: options.runCommand || defaultRunCommand,
  });

  const browserReady = Boolean(plugins.ready && executables.ready);
  const chromeReady = Boolean(browserReady && chromePath && extension.enabled && nativeHost.ready && chromeRunning);
  const status = !resources ? "resources_unknown"
    : !plugins.ready ? plugins.reason
      : !executables.ready ? "stable_executables_missing"
        : !chromePath ? "chrome_missing"
          : !extension.installed ? "extension_missing"
            : !extension.enabled ? "extension_disabled"
              : !nativeHost.ready ? nativeHost.reason
                : !chromeRunning ? "chrome_not_running"
                  : "ready";
  const result = {
    browserReady,
    chromeReady,
    pluginReady: plugins.ready,
    stableExecutablesReady: executables.ready,
    chromeInstalled: Boolean(chromePath),
    chromeRunning: Boolean(chromeRunning),
    extensionInstalled: extension.installed,
    extensionEnabled: extension.enabled,
    nativeHostReady: nativeHost.ready,
    selectedProfile: extension.profileDirectory,
    sourcePluginVersion: plugins.sourceVersion,
    installedPluginVersion: plugins.installedVersion,
    expectedCodexBinId: executables.codexId,
    expectedRgBinId: executables.rgId,
    status,
  };
  if (useCache) {
    cached = result;
    cachedAt = Date.now();
  }
  return result;
}

export function resetBrowserUseStatusCache() {
  cached = null;
  cachedAt = 0;
}

function inspectPlugins({ codexHome, resources }) {
  if (!resources) return { ready: false, reason: "resources_unknown", sourceVersion: "", installedVersion: "", extensionConfig: null };
  const sourceRoot = path.join(resources, "plugins", "openai-bundled", "plugins");
  const targetRoots = [
    path.join(codexHome, "plugins", "cache", "openai-bundled", "marketplace-source", "plugins"),
    path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins"),
  ];
  const targetRoot = targetRoots.find((root) => fs.existsSync(path.join(root, "browser", ".codex-plugin", "plugin.json"))) || targetRoots[0];
  const sourceBrowser = pluginDetails(sourceRoot, "browser");
  const sourceChrome = pluginDetails(sourceRoot, "chrome");
  const targetBrowser = pluginDetails(targetRoot, "browser");
  const targetChrome = pluginDetails(targetRoot, "chrome");
  const ready = Boolean(
    sourceBrowser.version && sourceChrome.version &&
    sourceBrowser.version === targetBrowser.version &&
    sourceChrome.version === targetChrome.version &&
    sourceBrowser.fingerprint === targetBrowser.fingerprint &&
    sourceChrome.fingerprint === targetChrome.fingerprint &&
    targetBrowser.clientExists && targetChrome.clientExists,
  );
  return {
    ready,
    reason: !targetBrowser.version || !targetChrome.version ? "plugin_cache_missing" : "plugin_cache_outdated",
    sourceVersion: sourceBrowser.version || sourceChrome.version,
    installedVersion: targetBrowser.version || targetChrome.version,
    extensionConfig: readJson(path.join(targetRoot, "chrome", "scripts", "extension-id.json")) || readJson(path.join(sourceRoot, "chrome", "scripts", "extension-id.json")),
  };
}

function pluginDetails(root, name) {
  const manifestPath = path.join(root, name, ".codex-plugin", "plugin.json");
  const manifest = readJson(manifestPath);
  return {
    version: String(manifest?.version || ""),
    fingerprint: fileFingerprint(manifestPath),
    clientExists: fs.existsSync(path.join(root, name, "scripts", "browser-client.mjs")),
  };
}

function inspectStableExecutables({ localAppData, resources }) {
  if (!resources) return { ready: false, codexId: "", rgId: "" };
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    const codex = executableGroup(resources, CODEX_EXECUTABLES);
    const rg = executableGroup(resources, RG_EXECUTABLES);
    return {
      ready: groupReady(binRoot, codex) && groupReady(binRoot, rg),
      codexId: codex.id,
      rgId: rg.id,
    };
  } catch {
    return { ready: false, codexId: "", rgId: "" };
  }
}

function executableGroup(resources, names) {
  const hash = crypto.createHash("sha256");
  const files = names.map((name) => {
    const source = path.join(resources, name);
    const stat = fs.statSync(source);
    const digest = fileFingerprint(source);
    if (!stat.isFile() || !digest) throw new Error(`Missing bundled executable: ${name}`);
    hash.update(name);
    hash.update("\0");
    hash.update(digest);
    hash.update("\0");
    return { name, digest, size: stat.size };
  });
  return { id: hash.digest("hex").slice(0, 16), files };
}

function groupReady(binRoot, group) {
  const target = path.join(binRoot, group.id);
  return group.files.every((file) => {
    const candidate = path.join(target, file.name);
    try {
      const stat = fs.statSync(candidate);
      return stat.isFile() && stat.size === file.size && fileFingerprint(candidate) === file.digest;
    } catch { return false; }
  });
}

function inspectChromeExtension({ chromeUserDataDir, extensionId, profileDirectory }) {
  if (!extensionId) return { installed: false, enabled: false, profileDirectory: "" };
  const profile = profileDirectory || selectedChromeProfile(chromeUserDataDir);
  if (!profile) return { installed: false, enabled: false, profileDirectory: "" };
  const profilePath = path.join(chromeUserDataDir, profile);
  const settings = chromeExtensionSettings(profilePath, extensionId);
  const extensionPath = path.join(profilePath, "Extensions", extensionId);
  const installed = directoryHasChildren(extensionPath) || Boolean(settings.path && fs.existsSync(settings.path));
  const disabled = settings.state === 0 || settings.disableReasons.length > 0;
  return { installed, enabled: Boolean(installed && settings.registered && !disabled), profileDirectory: profile };
}

function selectedChromeProfile(root) {
  const localState = readJson(path.join(root, "Local State"));
  const preferred = [localState?.profile?.last_used, ...(localState?.profile?.last_active_profiles || [])]
    .find((name) => typeof name === "string" && fs.existsSync(path.join(root, name, "Preferences")));
  if (preferred) return preferred;
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name)) && fs.existsSync(path.join(root, entry.name, "Preferences")))
      .map((entry) => entry.name)
      .sort(profileSort)
      .at(-1) || "";
  } catch { return ""; }
}

function chromeExtensionSettings(profilePath, extensionId) {
  for (const name of ["Secure Preferences", "Preferences"]) {
    const settings = readJson(path.join(profilePath, name))?.extensions?.settings?.[extensionId];
    if (!settings || typeof settings !== "object") continue;
    const disableReasons = Array.isArray(settings.disable_reasons) ? settings.disable_reasons : settings.disable_reasons ? [settings.disable_reasons] : [];
    return { registered: true, state: settings.state, path: typeof settings.path === "string" ? settings.path : "", disableReasons };
  }
  return { registered: false, state: null, path: "", disableReasons: [] };
}

function inspectNativeHost({ extensionId, hostName, registryManifestPath, runCommand }) {
  if (!extensionId || !hostName) return { ready: false, reason: "native_host_unknown" };
  let manifestPath = Object.hasOwn({ registryManifestPath }, "registryManifestPath") && registryManifestPath !== undefined
    ? String(registryManifestPath || "")
    : nativeHostManifestPath(hostName, runCommand);
  const manifest = readJson(manifestPath);
  const expectedOrigin = `chrome-extension://${extensionId}/`;
  const ready = Boolean(
    manifest && manifest.name === hostName &&
    Array.isArray(manifest.allowed_origins) && manifest.allowed_origins.includes(expectedOrigin) &&
    typeof manifest.path === "string" && fs.existsSync(manifest.path),
  );
  return { ready, reason: manifest ? "native_host_invalid" : "native_host_missing" };
}

function nativeHostManifestPath(hostName, runCommand) {
  if (process.platform !== "win32") return "";
  try {
    const output = runCommand("reg.exe", ["query", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`, "/ve"]);
    return String(output || "").match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/mi)?.[1]?.trim() || "";
  } catch { return ""; }
}

function findChrome(localAppData) {
  const candidates = [
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe") : "",
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function isChromeRunning(runCommand) {
  if (process.platform !== "win32") return false;
  try { return /"chrome\.exe","\d+",/i.test(runCommand("tasklist.exe", ["/fo", "csv", "/nh", "/fi", "imagename eq chrome.exe"])); }
  catch { return false; }
}

function resourcesFromAppx(installLocation) {
  let location = String(installLocation || "").trim();
  if (!location && process.platform === "win32") {
    try {
      location = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
      ], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
    } catch { return ""; }
  }
  if (!location) return "";
  const resources = path.join(location, "app", "resources");
  return fs.existsSync(path.join(resources, "plugins", "openai-bundled")) ? resources : "";
}

function defaultRunCommand(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
}

function profileSort(left, right) {
  if (left === "Default") return -1;
  if (right === "Default") return 1;
  return Number(left.match(/\d+/)?.[0] || 0) - Number(right.match(/\d+/)?.[0] || 0);
}

function directoryHasChildren(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => entry.isDirectory()); }
  catch { return false; }
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
