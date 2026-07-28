import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { APP_DATA_DIR, CONFIG_VERSION, DEFAULT_CONFIG, LEGACY_OFFICIAL_SLOTS } from "./constants.js";
import { normalizeCompactCapabilityProfiles } from "./compact-capabilities.js";
import { normalizeModelCapabilities, normalizeReasoningLevels, REASONING_PRESETS, resolveModelCapability, runtimeProfileFromModelItem } from "./model-capabilities.js";
import { normalizeProviderProxyUrl, providerNetworkMode } from "./provider-fetch.js";
import { codexSessionIndexInventory } from "./session-history.js";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const APP_DIR = process.env.CODEX_RELAY_HOME || path.join(os.homedir(), APP_DATA_DIR);
const CONFIG_PATH = path.join(APP_DIR, "settings.json");
const SECRETS_PATH = path.join(APP_DIR, "secrets.dpapi.json");
const CONTEXT_PATH = path.join(APP_DIR, "context.dpapi.json");
const APPLIED_PATH = path.join(APP_DIR, "relay-applied-state.json");
const CATALOG_PATH = path.join(APP_DIR, "model-catalog.json");
const REQUEST_HISTORY_PATH = path.join(APP_DIR, "request-history.sqlite");
const CODEX_CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
const CODEX_AUTH_PATH = path.join(CODEX_HOME, "auth.json");
const OFFICIAL_AUTH_PATH = path.join(APP_DIR, "official-auth.dpapi.json");
const THEME_STATE_PATH = path.join(APP_DIR, "theme-state.json");
// These three files describe one explicit handoff into Relay mode. They are
// replaced on the next handoff and cleared when the user exits Relay mode.
// Legacy pre-relay files are intentionally not read here: restoring a stale
// snapshot can overwrite a later external tool or official setup.
const HANDOFF_CONFIG_PATH = path.join(APP_DIR, "relay-handoff-config.toml.bak");
const HANDOFF_AUTH_PATH = path.join(APP_DIR, "relay-handoff-auth.dpapi.json");
const HANDOFF_MANIFEST_PATH = path.join(APP_DIR, "relay-handoff-state.json");
let secretsCache = null;
let officialAuthSnapshotCache = { signature: "", available: false };

export function paths() {
  return {
    appDir: APP_DIR, config: CONFIG_PATH, secrets: SECRETS_PATH, context: CONTEXT_PATH,
    handoffConfig: HANDOFF_CONFIG_PATH, handoffAuth: HANDOFF_AUTH_PATH, handoffManifest: HANDOFF_MANIFEST_PATH,
    applied: APPLIED_PATH, catalog: CATALOG_PATH, requestHistory: REQUEST_HISTORY_PATH, codexConfig: CODEX_CONFIG_PATH, codexAuth: CODEX_AUTH_PATH, officialAuth: OFFICIAL_AUTH_PATH, themeState: THEME_STATE_PATH,
  };
}

export function codexConfigPreflight() {
  const configExists = fs.existsSync(CODEX_CONFIG_PATH);
  const configText = configExists ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const writableTarget = configExists ? CODEX_CONFIG_PATH : nearestExistingParent(CODEX_HOME);
  const providerIdentity = providerIdentityFromConfig(configText);
  const openaiBaseUrl = rootTomlValue(configText, "openai_base_url");
  const providerBaseUrl = providerIdentity === "openai" ? openaiBaseUrl : tableTomlValue(configText, `model_providers.${providerIdentity}`, "base_url");
  try {
    fs.accessSync(writableTarget, fs.constants.W_OK);
    return { writable: true, configExists, providerIdentity, openaiBaseUrl, providerBaseUrl, relayManaged: hasRelayBlock(configText), writeTarget: writableTarget };
  } catch (error) {
    return { writable: false, configExists, providerIdentity, openaiBaseUrl, providerBaseUrl, relayManaged: hasRelayBlock(configText), writeTarget: writableTarget, error: String(error.message || "Codex configuration is not writable.") };
  }
}

export function ensureAppDir() {
  fs.mkdirSync(APP_DIR, { recursive: true });
}

export function loadSettings() {
  ensureAppDir();
  if (!fs.existsSync(CONFIG_PATH)) return structuredClone(DEFAULT_CONFIG);
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return normalizeSettings(parsed);
}

export function saveSettings(settings) {
  ensureAppDir();
  writeJsonAtomic(CONFIG_PATH, normalizeSettings(settings));
}

export function replaceSettings(nextSettings) {
  const normalized = normalizeSettings(nextSettings);
  saveSettings(normalized);
  return normalized;
}

export function loadSecrets() {
  ensureAppDir();
  if (secretsCache) return structuredClone(secretsCache);
  if (!fs.existsSync(SECRETS_PATH)) {
    secretsCache = {};
    return {};
  }
  const encrypted = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
  secretsCache = decryptForCurrentUser(encrypted.payload || "");
  return structuredClone(secretsCache);
}

export function saveSecrets(secrets) {
  ensureAppDir();
  const normalized = secrets && typeof secrets === "object" ? structuredClone(secrets) : {};
  writeJsonAtomic(SECRETS_PATH, { version: 1, payload: encryptForCurrentUser(normalized) });
  secretsCache = normalized;
}

export function saveProviderKey(providerId, apiKey) {
  const secrets = loadSecrets();
  if (apiKey) secrets[providerId] = apiKey;
  else delete secrets[providerId];
  saveSecrets(secrets);
}

export function providerKey(providerId) {
  return loadSecrets()[providerId] || "";
}

export function hasProviderKey(providerId) {
  return Boolean(providerKey(providerId));
}

export function loadContextCache() {
  ensureAppDir();
  if (!fs.existsSync(CONTEXT_PATH)) return [];
  try {
    const encrypted = JSON.parse(fs.readFileSync(CONTEXT_PATH, "utf8"));
    const version = Number(encrypted.version) || 1;
    const cache = version >= 3
      ? JSON.parse(gunzipSync(Buffer.from(unprotectBytesForCurrentUser(encrypted.payload || "", 32 * 1024 * 1024), "base64")).toString("utf8"))
      : version >= 2
        ? JSON.parse(Buffer.from(String(decryptForCurrentUser(encrypted.payload || "", 32 * 1024 * 1024) || ""), "base64").toString("utf8"))
        : decryptForCurrentUser(encrypted.payload || "", 32 * 1024 * 1024);
    return Array.isArray(cache) ? cache : [];
  } catch {
    return [];
  }
}

export function saveContextCache(entries) {
  ensureAppDir();
  const normalized = trimContextCache(entries);
  const compressed = gzipSync(Buffer.from(JSON.stringify(normalized), "utf8")).toString("base64");
  writeJsonAtomic(CONTEXT_PATH, { version: 3, payload: protectBytesForCurrentUser(compressed, 32 * 1024 * 1024) });
}

export function clearContextCache() {
  if (fs.existsSync(CONTEXT_PATH)) fs.rmSync(CONTEXT_PATH, { force: true });
}

export function captureRelayHandoff({ replaceExisting = false } = {}) {
  ensureAppDir();
  const existing = relayHandoffSnapshot();
  // Re-applying while Relay owns Codex must preserve the original handoff.
  if (existing && !replaceExisting) return { created: false, snapshot: existing };

  const configText = fs.existsSync(CODEX_CONFIG_PATH) ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const configExisted = fs.existsSync(CODEX_CONFIG_PATH);
  const authExisted = fs.existsSync(CODEX_AUTH_PATH);
  const authText = authExisted ? fs.readFileSync(CODEX_AUTH_PATH, "utf8") : "";
  fs.writeFileSync(HANDOFF_CONFIG_PATH, configText, "utf8");
  writeJsonAtomic(HANDOFF_AUTH_PATH, {
    version: 1,
    exists: authExisted,
    sha256: sha256(authText),
    payload: authExisted ? encryptForCurrentUser(authText) : "",
  });
  const snapshot = {
    version: 2,
    capturedAt: new Date().toISOString(),
    configExisted,
    configSha256: sha256(configText),
    providerIdentity: providerIdentityFromConfig(configText),
    defaultModel: rootTomlValue(configText, "model") || null,
    modelCatalogPath: rootTomlValue(configText, "model_catalog_json") || null,
    auth: { exists: authExisted, sha256: sha256(authText) },
    sessions: sessionInventory(),
  };
  writeJsonAtomic(HANDOFF_MANIFEST_PATH, snapshot);
  return { created: true, snapshot };
}

export function discardRelayHandoff(handoff) {
  if (!handoff?.created) return;
  for (const target of [HANDOFF_CONFIG_PATH, HANDOFF_AUTH_PATH, HANDOFF_MANIFEST_PATH]) {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
}

export function hasOfficialAuthSnapshot() {
  const signature = fileSignature(OFFICIAL_AUTH_PATH);
  if (signature === officialAuthSnapshotCache.signature) return officialAuthSnapshotCache.available;
  const snapshot = readEncryptedAuthSnapshot(OFFICIAL_AUTH_PATH);
  if (!snapshot?.payload) {
    officialAuthSnapshotCache = { signature, available: false };
    return false;
  }
  try {
    const available = isOfficialAuthText(decryptForCurrentUser(snapshot.payload));
    officialAuthSnapshotCache = { signature, available };
    return available;
  } catch {
    officialAuthSnapshotCache = { signature, available: false };
    return false;
  }
}

export function relayOfficialAuthPlan({ restoreOfficial = false } = {}) {
  let currentOfficial = false;
  try {
    currentOfficial = fs.existsSync(CODEX_AUTH_PATH) && isOfficialAuthText(fs.readFileSync(CODEX_AUTH_PATH, "utf8"));
  } catch { /* An unreadable current auth file is handled like a missing official login. */ }
  const savedOfficial = hasOfficialAuthSnapshot();
  if (!restoreOfficial) {
    return { action: "not_requested", currentOfficial, savedOfficial, requiresRestore: false };
  }
  if (currentOfficial) {
    return { action: "preserve_current", currentOfficial: true, savedOfficial, requiresRestore: false };
  }
  if (savedOfficial) {
    return { action: "restore_saved", currentOfficial: false, savedOfficial: true, requiresRestore: true };
  }
  return { action: "unavailable", currentOfficial: false, savedOfficial: false, requiresRestore: false };
}

// The Router must never borrow Codex's incoming Authorization header for an
// official route: another switcher may have left an API key there. Read only
// the encrypted official sign-in snapshot captured after `codex login`.
export function officialAccessToken() {
  const current = readOfficialAccessToken(CODEX_AUTH_PATH);
  if (current) return current;
  const snapshot = readEncryptedAuthSnapshot(OFFICIAL_AUTH_PATH);
  if (!snapshot?.payload) return "";
  try { return officialAccessTokenFromText(decryptForCurrentUser(snapshot.payload)); } catch { return ""; }
}

export function officialAccountId() {
  const current = readOfficialAccountId(CODEX_AUTH_PATH);
  if (current) return current;
  const snapshot = readEncryptedAuthSnapshot(OFFICIAL_AUTH_PATH);
  if (!snapshot?.payload) return "";
  try { return officialAccountIdFromText(decryptForCurrentUser(snapshot.payload)); } catch { return ""; }
}

export function captureOfficialAuth() {
  if (!fs.existsSync(CODEX_AUTH_PATH)) return { captured: false, reason: "missing" };
  const text = fs.readFileSync(CODEX_AUTH_PATH, "utf8");
  if (!isOfficialAuthText(text)) return { captured: false, reason: "not_official" };
  ensureAppDir();
  const digest = sha256(text);
  const existing = readEncryptedAuthSnapshot(OFFICIAL_AUTH_PATH);
  if (existing?.payload && existing.sha256 === digest) {
    officialAuthSnapshotCache = { signature: fileSignature(OFFICIAL_AUTH_PATH), available: true };
    return { captured: true };
  }
  writeJsonAtomic(OFFICIAL_AUTH_PATH, { version: 1, capturedAt: new Date().toISOString(), sha256: digest, payload: encryptForCurrentUser(text) });
  officialAuthSnapshotCache = { signature: fileSignature(OFFICIAL_AUTH_PATH), available: true };
  return { captured: true };
}

export function restoreSavedOfficialAuth() {
  const snapshot = readEncryptedAuthSnapshot(OFFICIAL_AUTH_PATH);
  if (!snapshot?.payload) return { restored: false, available: false, transaction: null };
  let officialText;
  try { officialText = decryptForCurrentUser(snapshot.payload); } catch { return { restored: false, available: false, transaction: null }; }
  if (!isOfficialAuthText(officialText)) return { restored: false, available: false, transaction: null };
  const existed = fs.existsSync(CODEX_AUTH_PATH);
  const previousText = existed ? fs.readFileSync(CODEX_AUTH_PATH, "utf8") : "";
  writeTextAtomic(CODEX_AUTH_PATH, officialText);
  return { restored: true, available: true, transaction: { existed, previousText, restoredSha256: sha256(officialText) } };
}

export function rollbackOfficialAuthRestore(transaction) {
  if (!transaction) return;
  if (transaction.existed) writeTextAtomic(CODEX_AUTH_PATH, transaction.previousText || "");
  else if (fs.existsSync(CODEX_AUTH_PATH)) fs.rmSync(CODEX_AUTH_PATH, { force: true });
}

export function relayHandoffSnapshot() {
  if (!fs.existsSync(HANDOFF_MANIFEST_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(HANDOFF_MANIFEST_PATH, "utf8")); } catch { return null; }
}

export function refreshRelayHandoffSessionBaseline(historyVisibility = null) {
  const snapshot = relayHandoffSnapshot();
  if (!snapshot) throw new Error("Relay handoff is missing while refreshing the conversation protection baseline.");
  const next = {
    ...snapshot,
    sessionsBeforeHistoryVisibility: snapshot.sessionsBeforeHistoryVisibility || snapshot.sessions,
    sessions: sessionInventory(),
    historyVisibility: historyVisibility ? {
      active: true,
      files: Number(historyVisibility.files) || 0,
      rows: Number(historyVisibility.rows) || 0,
      sourceProvider: "custom",
      targetProvider: "openai",
    } : snapshot.historyVisibility || null,
  };
  writeJsonAtomic(HANDOFF_MANIFEST_PATH, next);
  return next;
}

export function restorePreview() {
  const snapshot = relayHandoffSnapshot();
  if (!snapshot || !fs.existsSync(HANDOFF_CONFIG_PATH) || !fs.existsSync(HANDOFF_AUTH_PATH)) return { available: false, snapshot: null, configurationChanged: false };
  const application = relayApplicationStatus();
  const configurationChanged = application.configurationChanged;
  return { available: true, snapshot, configurationChanged };
}

// A saved `running` preference is not evidence that Codex still targets Relay.
// The config hash is the source of truth when another tool has since changed
// config.toml.
export function relayApplicationStatus() {
  const applied = readJson(APPLIED_PATH);
  const configExists = fs.existsSync(CODEX_CONFIG_PATH);
  const current = configExists ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const configShaMatches = Boolean(applied?.configSha256 && sha256(current) === applied.configSha256);
  const configMatches = Boolean(applied?.configSha256 && relayManagedConfigMatches(current, applied));
  return {
    applied: Boolean(applied?.configSha256),
    configExists,
    configMatches,
    configShaMatches,
    relayManaged: hasRelayBlock(current),
    configurationChanged: Boolean(applied?.configSha256 && !configShaMatches),
  };
}

export function relayPublicationStatus({ expectedRoutes = [], expectedCatalog = null, routerUrl = "" } = {}) {
  const application = relayApplicationStatus();
  const config = codexConfigPreflight();
  const current = config.configExists ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const configuredCatalogPath = rootTomlValue(current, "model_catalog_json");
  const expected = Array.isArray(expectedRoutes) ? expectedRoutes.map(String) : [];
  let publishedRoutes = [];
  let catalogReadable = false;
  let catalogContentMatches = false;
  let catalogSha256 = null;

  try {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    publishedRoutes = Array.isArray(catalog?.models) ? catalog.models.map((model) => String(model?.slug || "")) : [];
    catalogReadable = true;
    catalogSha256 = sha256(stableJson(catalog));
    catalogContentMatches = expectedCatalog ? sha256(stableJson(catalog)) === sha256(stableJson(expectedCatalog)) : true;
  } catch { /* A missing or invalid catalog is reported through the status fields below. */ }

  const providerMatches = config.providerIdentity === "openai";
  const routerUrlMatches = sameUrl(config.openaiBaseUrl, routerUrl);
  const catalogPathMatches = samePath(configuredCatalogPath, CATALOG_PATH);
  const catalogMatches = sameOrderedItems(publishedRoutes, expected);
  const configTargetsRelay = providerMatches && routerUrlMatches && catalogPathMatches && config.relayManaged;

  return {
    verified: Boolean(application.configMatches && configTargetsRelay && catalogReadable && catalogMatches && catalogContentMatches),
    configTargetsRelay,
    providerMatches,
    routerUrlMatches,
    catalogPathMatches,
    catalogReadable,
    catalogMatches,
    catalogContentMatches,
    catalogSha256,
    expectedCatalogSha256: expectedCatalog ? sha256(stableJson(expectedCatalog)) : null,
    expectedRoutes: expected,
    publishedRoutes,
    modelCount: publishedRoutes.length,
  };
}

export function currentSessionInventory() {
  return sessionInventory();
}

export function verifySessionProtection(baseline) {
  if (!baseline?.filesAvailable || !Array.isArray(baseline.files)) {
    return { safe: false, comparable: false, missing: [], deleted: [], deletedSessionIds: [], missingIndex: [], truncated: [], changedPrefix: [], current: sessionInventory() };
  }
  const current = sessionInventory();
  if (!current.filesAvailable) return { safe: false, comparable: false, missing: [], deleted: [], deletedSessionIds: [], missingIndex: [], truncated: [], changedPrefix: [], current };
  const currentFiles = sessionFiles({ includeTargets: true });
  const currentById = new Map(currentFiles.files.map((file) => [file.id, file]));
  const currentIndex = codexSessionIndexInventory({ codexHome: CODEX_HOME });
  const indexedIds = new Set(currentIndex.ids);
  const legacyBaselineIndexed = !baseline.index && Number(baseline.totalRows) >= baseline.files.length;
  const missing = [];
  const deleted = [];
  const deletedSessionIds = [];
  const missingIndex = [];
  const truncated = [];
  const changedPrefix = [];
  for (const original of baseline.files) {
    const next = currentById.get(original.id);
    const sessionId = sessionIdFromRolloutName(original.id);
    const expectedIndexed = original.indexed === true || legacyBaselineIndexed;
    const currentlyIndexed = Boolean(sessionId && indexedIds.has(sessionId));
    if (!next) {
      if (currentIndex.supported && expectedIndexed && sessionId && !currentlyIndexed) {
        deleted.push(original.id);
        deletedSessionIds.push(sessionId);
      } else {
        missing.push(original.id);
      }
      continue;
    }
    if (currentIndex.supported && expectedIndexed && sessionId && !currentlyIndexed) missingIndex.push(original.id);
    if (next.size < original.size) truncated.push(original.id);
    if (filePrefixSha256(next.target, original.prefixBytes) !== original.prefixSha256) changedPrefix.push(original.id);
  }
  return {
    safe: missing.length === 0 && missingIndex.length === 0 && truncated.length === 0 && changedPrefix.length === 0,
    comparable: true,
    missing,
    deleted,
    deletedSessionIds,
    missingIndex,
    truncated,
    changedPrefix,
    current,
  };
}

export function writeCatalog(catalog) {
  ensureAppDir();
  writeJsonAtomic(CATALOG_PATH, catalog);
}

export function applyRelayConfig({ model, catalogPath, routerUrl, deferCommit = false, handoff = null, restoreOfficial = false }) {
  const handoffSnapshot = handoff || captureRelayHandoff({ replaceExisting: !relayApplicationStatus().applied });
  const configExisted = fs.existsSync(CODEX_CONFIG_PATH);
  const current = configExisted ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const priorAppliedState = readJson(APPLIED_PATH);
  const previousProviderIdentity = providerIdentityFromConfig(current);
  const providerIdentity = "openai";
  const transaction = {
    configExisted,
    previousConfig: current,
    priorAppliedState,
    officialAuthTransaction: null,
    officialAuthAction: "not_requested",
    nextConfigSha256: null,
    managedConfig: { providerIdentity, routerUrl, catalogPath },
    handoff: handoffSnapshot,
  };
  try {
    const authHandoff = relayOfficialAuthPlan({ restoreOfficial });
    transaction.officialAuthAction = authHandoff.action;
    if (authHandoff.action === "restore_saved") {
      const restored = restoreSavedOfficialAuth();
      if (!restored.restored) {
        const error = new Error("The saved official Codex sign-in could not be restored for Relay mode.");
        error.code = "official_auth_restore_failed";
        throw error;
      }
      transaction.officialAuthTransaction = restored.transaction;
    }
    if (authHandoff.action === "unavailable") {
      const error = new Error("No current or saved official Codex sign-in is available for Relay mode.");
      error.code = "official_auth_restore_failed";
      throw error;
    }
    const withoutRelay = removeRelayRootSettings(removeRelayBlock(current));
    const relayBlock = [
      "# BEGIN CODEX RELAY",
      "# Managed locally by Codex Relay. Restore use-before state restores the original file.",
      'model_provider = "openai"',
      `model = \"${escapeTomlString(model)}\"`,
      `model_catalog_json = \"${tomlPath(catalogPath)}\"`,
      `openai_base_url = \"${escapeTomlString(routerUrl)}\"`,
      "# END CODEX RELAY",
      "",
    ].join("\n");
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    const nextConfig = `${relayBlock}${withoutRelay.trimStart()}`;
    transaction.nextConfigSha256 = sha256(nextConfig);
    writeTextAtomic(CODEX_CONFIG_PATH, nextConfig);
    if (!deferCommit) commitRelayConfig(transaction);
    return { providerIdentity, previousProviderIdentity, handoff: handoffSnapshot, authHandoff, transaction };
  } catch (error) {
    rollbackRelayConfig(transaction);
    throw error;
  }
}

export function commitRelayConfig(transaction) {
  const current = fs.existsSync(CODEX_CONFIG_PATH) ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  if (!transaction?.nextConfigSha256 || sha256(current) !== transaction.nextConfigSha256) {
    const error = new Error("Codex config.toml changed while Relay was verifying the apply operation.");
    error.code = "relay_config_changed";
    throw error;
  }
  writeJsonAtomic(APPLIED_PATH, {
    appliedAt: new Date().toISOString(),
    configSha256: transaction.nextConfigSha256,
    managedConfig: transaction.managedConfig,
  });
  return relayApplicationStatus();
}

export function rollbackRelayConfig(transaction) {
  if (!transaction || typeof transaction !== "object") return { restored: false };
  if (transaction.configExisted) {
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    writeTextAtomic(CODEX_CONFIG_PATH, String(transaction.previousConfig || ""));
  } else if (fs.existsSync(CODEX_CONFIG_PATH)) {
    fs.rmSync(CODEX_CONFIG_PATH, { force: true });
  }

  if (transaction.priorAppliedState) writeJsonAtomic(APPLIED_PATH, transaction.priorAppliedState);
  else if (fs.existsSync(APPLIED_PATH)) fs.rmSync(APPLIED_PATH, { force: true });
  rollbackOfficialAuthRestore(transaction.officialAuthTransaction);
  discardRelayHandoff(transaction.handoff);

  return { restored: true, application: relayApplicationStatus() };
}

export function restoreRelayHandoff(sessionBaseline = currentSessionInventory()) {
  const snapshot = relayHandoffSnapshot();
  const preview = restorePreview();
  if (!preview.available) return { restored: false, verified: false, authRestored: false, authVerified: false, configurationChanged: false };
  const originalConfig = fs.readFileSync(HANDOFF_CONFIG_PATH, "utf8");
  const authSnapshot = readEncryptedAuthSnapshot(HANDOFF_AUTH_PATH);
  if (!authSnapshot) throw new Error("Relay handoff authentication snapshot is unreadable.");
  let originalAuth = "";
  if (authSnapshot.exists) originalAuth = decryptForCurrentUser(authSnapshot.payload || "");

  if (snapshot.configExisted) {
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    writeTextAtomic(CODEX_CONFIG_PATH, originalConfig);
  } else if (fs.existsSync(CODEX_CONFIG_PATH)) {
    fs.rmSync(CODEX_CONFIG_PATH, { force: true });
  }
  if (authSnapshot.exists) writeTextAtomic(CODEX_AUTH_PATH, originalAuth);
  else if (fs.existsSync(CODEX_AUTH_PATH)) fs.rmSync(CODEX_AUTH_PATH, { force: true });

  const restoredText = fs.existsSync(CODEX_CONFIG_PATH) ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const verified = snapshot.configExisted ? sha256(restoredText) === snapshot.configSha256 : !fs.existsSync(CODEX_CONFIG_PATH);
  const restoredAuth = fs.existsSync(CODEX_AUTH_PATH) ? fs.readFileSync(CODEX_AUTH_PATH, "utf8") : "";
  const authVerified = authSnapshot.exists ? sha256(restoredAuth) === authSnapshot.sha256 : !fs.existsSync(CODEX_AUTH_PATH);
  const sessionProtection = verifySessionProtection(sessionBaseline);
  if (fs.existsSync(APPLIED_PATH)) fs.rmSync(APPLIED_PATH, { force: true });
  // Retain the handoff if verification fails so the user can retry recovery.
  if (verified && authVerified && sessionProtection.safe) discardRelayHandoff({ created: true });
  return { restored: true, verified: verified && authVerified && sessionProtection.safe, configVerified: verified, authRestored: true, authVerified, sessionProtection, configurationChanged: preview.configurationChanged };
}

// This intentionally differs from restoreRelayHandoff: it creates a normal
// official Codex configuration instead of restoring a prior third-party or
// CC Switch route. The original handoff remains available so the user can
// still choose to return to the exact pre-Relay setup later.
export function switchToOfficialDirect() {
  const configExisted = fs.existsSync(CODEX_CONFIG_PATH);
  const previousConfig = configExisted ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const previousSettings = loadSettings();
  const priorAppliedState = readJson(APPLIED_PATH);
  const transaction = { configExisted, previousConfig, previousSettings, priorAppliedState, officialAuthTransaction: null };
  try {
    const authPlan = relayOfficialAuthPlan({ restoreOfficial: true });
    if (authPlan.action === "unavailable") {
      const error = new Error("没有可用的官方 Codex 登录可供恢复。请先在 Codex 中完成官方登录。");
      error.code = "official_auth_restore_failed";
      throw error;
    }
    if (authPlan.action === "restore_saved") {
      const restored = restoreSavedOfficialAuth();
      if (!restored.restored) {
        const error = new Error("保存的官方 Codex 登录无法恢复。");
        error.code = "official_auth_restore_failed";
        throw error;
      }
      transaction.officialAuthTransaction = restored.transaction;
    }

    const withoutRelay = removeRelayRootSettings(removeRelayBlock(previousConfig));
    const nextConfig = `model_provider = "openai"\n${withoutRelay.trimStart()}`;
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    writeTextAtomic(CODEX_CONFIG_PATH, nextConfig);
    const restoredAuth = fs.existsSync(CODEX_AUTH_PATH) ? fs.readFileSync(CODEX_AUTH_PATH, "utf8") : "";
    if (!isOfficialDirectConfig(nextConfig) || !isOfficialAuthText(restoredAuth)) {
      const error = new Error("官方直连配置或官方登录验证未通过。");
      error.code = "official_direct_verification_failed";
      throw error;
    }

    const settings = loadSettings();
    settings.router.running = false;
    saveSettings(settings);
    if (fs.existsSync(APPLIED_PATH)) fs.rmSync(APPLIED_PATH, { force: true });
    return {
      switched: true,
      verified: true,
      authAction: authPlan.action,
      preRelaySnapshotRetained: Boolean(relayHandoffSnapshot()),
      application: relayApplicationStatus(),
    };
  } catch (error) {
    if (transaction.configExisted) writeTextAtomic(CODEX_CONFIG_PATH, transaction.previousConfig);
    else if (fs.existsSync(CODEX_CONFIG_PATH)) fs.rmSync(CODEX_CONFIG_PATH, { force: true });
    rollbackOfficialAuthRestore(transaction.officialAuthTransaction);
    try { saveSettings(transaction.previousSettings); } catch { /* Preserve the direct-mode failure. */ }
    if (transaction.priorAppliedState) writeJsonAtomic(APPLIED_PATH, transaction.priorAppliedState);
    else if (fs.existsSync(APPLIED_PATH)) fs.rmSync(APPLIED_PATH, { force: true });
    throw error;
  }
}

// Compatibility aliases for internal callers while the UI moves to the more
// accurate "Relay mode" language.
export const restorePreRelayState = restoreRelayHandoff;

export function codexLoginStatus() {
  const fileStatus = authStatusFromFile();
  if (fileStatus) return fileStatus;
  try {
    // On this Windows setup Node cannot spawn the npm `codex` shim directly
    // (EPERM/EINVAL), while PowerShell resolves the same command correctly.
    // Codex writes its status message to stderr on this build, so collect both
    // streams instead of treating an empty stdout as an official login.
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "codex login status"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (result.error) throw result.error;
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const apiKey = /api key/i.test(output);
    const signedIn = !/not logged in|not authenticated/i.test(output) && !apiKey;
    return {
      signedIn,
      authType: signedIn ? "official" : apiKey ? "api_key" : "none",
      summary: signedIn
        ? "Official Codex sign-in detected."
        : apiKey
          ? "Codex is currently authenticated with an API Key, not an official account."
          : "No official Codex sign-in detected.",
    };
  } catch (error) {
    return { signedIn: false, authType: "none", summary: "No official Codex sign-in detected." };
  }
}

function authStatusFromFile() {
  try {
    if (!fs.existsSync(CODEX_AUTH_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, "utf8"));
    if (parsed?.auth_mode === "chatgpt" && parsed?.tokens?.access_token && parsed?.tokens?.refresh_token) {
      return { signedIn: true, authType: "official", summary: "Official Codex sign-in detected." };
    }
    if (parsed?.OPENAI_API_KEY) return { signedIn: false, authType: "api_key", summary: "Codex is currently authenticated with an API Key, not an official account." };
    return { signedIn: false, authType: "none", summary: "No official Codex sign-in detected." };
  } catch { return null; }
}

function isOfficialAuthText(text) {
  return Boolean(officialAccessTokenFromText(text) && officialRefreshTokenFromText(text));
}

function readOfficialAccessToken(target) {
  try { return fs.existsSync(target) ? officialAccessTokenFromText(fs.readFileSync(target, "utf8")) : ""; } catch { return ""; }
}

function readOfficialAccountId(target) {
  try { return fs.existsSync(target) ? officialAccountIdFromText(fs.readFileSync(target, "utf8")) : ""; } catch { return ""; }
}

function officialAccessTokenFromText(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.auth_mode === "chatgpt" ? String(parsed?.tokens?.access_token || "") : "";
  } catch { return ""; }
}

function officialRefreshTokenFromText(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.auth_mode === "chatgpt" ? String(parsed?.tokens?.refresh_token || "") : "";
  } catch { return ""; }
}

function officialAccountIdFromText(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.auth_mode === "chatgpt" ? String(parsed?.tokens?.account_id || "") : "";
  } catch { return ""; }
}

function readEncryptedAuthSnapshot(target) {
  try { return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : null; } catch { return null; }
}

function normalizeSettings(raw) {
  const providers = Array.isArray(raw?.providers) ? raw.providers.map(normalizeProvider) : [];
  return {
    version: CONFIG_VERSION,
    router: { ...DEFAULT_CONFIG.router, ...(raw?.router || {}) },
    official: normalizeOfficial(raw?.official),
    contextCache: { ...DEFAULT_CONFIG.contextCache, ...(raw?.contextCache || {}) },
    deepSeekSavings: { enabled: Boolean(raw?.deepSeekSavings?.enabled) },
    compactCapabilities: normalizeCompactCapabilityProfiles(raw?.compactCapabilities),
    providers,
    thirdPartySlots: Array.isArray(raw?.thirdPartySlots) ? raw.thirdPartySlots.map((slot) => normalizeSlot(slot, providers.find((provider) => provider.id === safeId(slot?.providerId)))) : [],
  };
}

function normalizeOfficial(official) {
  const availableModels = Array.isArray(official?.availableModels)
    ? official.availableModels.map(normalizeOfficialModel).filter(Boolean).slice(0, 100)
    : [];
  const slots = Array.isArray(official?.slots)
    ? official.slots.map(normalizeOfficialModel).filter(Boolean).slice(0, 2)
    : LEGACY_OFFICIAL_SLOTS.map(normalizeOfficialModel);
  return {
    verified: Boolean(official?.verified),
    lastCheckedAt: timestamp(official?.lastCheckedAt),
    accountFingerprint: fingerprint(official?.accountFingerprint),
    modelsFetchedAt: timestamp(official?.modelsFetchedAt),
    availableModels,
    slots: uniqueModels(slots),
  };
}

function normalizeOfficialModel(model) {
  const id = safeModelId(model?.id || model?.upstreamModel);
  if (!id) return null;
  const contextWindow = Number(model?.contextWindow);
  const reasoningLevels = normalizeReasoningLevels(model?.reasoningLevels);
  const defaultReasoningLevel = String(model?.defaultReasoningLevel || "").trim().toLowerCase();
  const { baseInstructions: _baseInstructions, modelMessages: _modelMessages, ...runtime } = runtimeProfileFromModelItem(model);
  return {
    id,
    displayName: String(model?.displayName || id).replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || id,
    upstreamModel: id,
    description: String(model?.description || "Uses the signed-in Codex account when verified.").replace(/[\r\n\t]+/g, " ").trim().slice(0, 240),
    ...(Number.isInteger(contextWindow) && contextWindow >= 8_000 && contextWindow <= 10_000_000 ? { contextWindow } : {}),
    supportsImages: Boolean(model?.supportsImages),
    ...(reasoningLevels.length ? { reasoningLevels } : {}),
    ...(reasoningLevels.some((level) => level.effort === defaultReasoningLevel) ? { defaultReasoningLevel } : {}),
    ...runtime,
  };
}

function uniqueModels(models) {
  return [...new Map(models.map((model) => [model.id, model])).values()].slice(0, 2);
}

function timestamp(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text : null;
}

function fingerprint(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function normalizeProvider(provider) {
  const networkMode = providerNetworkMode(provider);
  return {
    id: safeId(provider?.id) || crypto.randomUUID(),
    name: String(provider?.name || "").trim(),
    baseUrl: String(provider?.baseUrl || "").trim().replace(/\/+$/, ""),
    endpointUrl: String(provider?.endpointUrl || "").trim(),
    modelListUrl: String(provider?.modelListUrl || "").trim(),
    balanceUrl: String(provider?.balanceUrl || "").trim(),
    balancePath: String(provider?.balancePath || "").trim().replace(/^\.+|\.+$/g, "").slice(0, 160),
    balanceCurrency: String(provider?.balanceCurrency || "").trim().toUpperCase().slice(0, 12),
    balanceSnapshot: normalizeBalanceSnapshot(provider?.balanceSnapshot),
    balanceProbe: normalizeBalanceProbe(provider?.balanceProbe),
    modelCapabilities: normalizeModelCapabilities(provider?.modelCapabilities),
    apiType: provider?.apiType === "responses" ? "responses" : "chat_completions",
    networkMode,
    proxyUrl: networkMode === "custom" ? normalizeProviderProxyUrl(provider?.proxyUrl) : "",
    nativeResponseContinuation: provider?.apiType === "responses" && provider?.nativeResponseContinuation === true,
    note: String(provider?.note || "").trim(),
    authHeaderName: headerName(provider?.authHeaderName) || "authorization",
    authHeaderPrefix: String(provider?.authHeaderPrefix ?? "Bearer ").replace(/[\r\n]/g, "").slice(0, 80),
    extraHeaders: normalizeHeaders(provider?.extraHeaders),
  };
}

function normalizeBalanceProbe(probe) {
  const status = ["detected", "unsupported"].includes(probe?.status) ? probe.status : "never";
  const checkedAt = String(probe?.checkedAt || "");
  return {
    status,
    checkedAt: /^\d{4}-\d{2}-\d{2}T/.test(checkedAt) ? checkedAt : null,
    ...(status === "detected" && probe?.endpointKind ? { endpointKind: String(probe.endpointKind).slice(0, 40) } : {}),
  };
}

function normalizeBalanceSnapshot(snapshot) {
  const amount = Number(snapshot?.amount);
  if (!Number.isFinite(amount)) return null;
  const checkedAt = String(snapshot?.checkedAt || "");
  return {
    amount,
    currency: String(snapshot?.currency || "").trim().toUpperCase().slice(0, 12),
    checkedAt: /^\d{4}-\d{2}-\d{2}T/.test(checkedAt) ? checkedAt : null,
    source: String(snapshot?.source || "").trim().slice(0, 120),
  };
}

function normalizeSlot(slot, provider) {
  const upstreamModel = String(slot?.upstreamModel || "").trim();
  const reasoningPreset = REASONING_PRESETS.includes(slot?.reasoningPreset) ? slot.reasoningPreset : "auto";
  const capability = resolveModelCapability(upstreamModel, { provider, reasoningPreset });
  return {
    id: safeId(slot?.id),
    displayName: String(slot?.displayName || "").trim(),
    providerId: safeId(slot?.providerId),
    upstreamModel,
    contextWindow: capability.contextWindow,
    supportsImages: capability.supportsImages,
    reasoningPreset,
    dropParams: normalizeDropParams(slot?.dropParams),
  };
}

function safeId(value) { return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128); }
function normalizeDropParams(value) {
  const values = Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
  // Early Relay versions added these to every third-party slot without provider
  // evidence. They suppress valid native Responses features, so migrate them away.
  return values.length === 2 && values.includes("response_format") && values.includes("parallel_tool_calls") ? [] : values;
}
function safeModelId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id) ? id : "";
}
function nearestExistingParent(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
function headerName(value) { const name = String(value || "").trim().toLowerCase(); return /^[!#$%&'*+.^_`|~0-9a-z-]{1,80}$/.test(name) ? name : ""; }
function normalizeHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const name = headerName(key);
    const headerValue = String(rawValue ?? "").replace(/[\r\n]/g, "").slice(0, 2048);
    if (name && headerValue && !["authorization", "x-api-key"].includes(name) && Object.keys(result).length < 20) result[name] = headerValue;
  }
  return result;
}
function trimContextCache(entries) {
  const newestFirst = Array.isArray(entries) ? entries.slice(-200).reverse() : [];
  const retained = [];
  for (const entry of newestFirst) {
    const candidate = [entry, ...retained];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 8 * 1024 * 1024 && retained.length) break;
    retained.unshift(entry);
  }
  return retained;
}
function readJson(target) {
  try { return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : null; } catch { return null; }
}

function fileSignature(target) {
  try {
    const stat = fs.statSync(target);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return "missing";
  }
}

function encryptForCurrentUser(value, maxBuffer = 1024 * 1024) {
  // ConvertFrom-SecureString uses DPAPI for the current Windows user when no
  // explicit key is supplied. Passing the plaintext via stdin keeps it out of
  // the spawned PowerShell command line.
  const script = "$plain=[Console]::In.ReadToEnd();$secure=ConvertTo-SecureString $plain -AsPlainText -Force;ConvertFrom-SecureString $secure";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: JSON.stringify(value), encoding: "utf8", windowsHide: true, maxBuffer }).trim();
}

function decryptForCurrentUser(payload, maxBuffer = 1024 * 1024) {
  if (!payload) return {};
  const script = "$payload=[Console]::In.ReadToEnd();$secure=ConvertTo-SecureString $payload;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}";
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: String(payload), encoding: "utf8", windowsHide: true, maxBuffer }).trim());
}

function protectBytesForCurrentUser(value, maxBuffer = 32 * 1024 * 1024) {
  const script = "Add-Type -AssemblyName System.Security;$plain=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($plain);$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: String(value || ""), encoding: "utf8", windowsHide: true, maxBuffer }).trim();
}

function unprotectBytesForCurrentUser(payload, maxBuffer = 32 * 1024 * 1024) {
  const script = "Add-Type -AssemblyName System.Security;$payload=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($payload);$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: String(payload || ""), encoding: "utf8", windowsHide: true, maxBuffer });
}

function removeRelayBlock(value) {
  return String(value || "").replace(/\r?\n?# BEGIN CODEX RELAY[\s\S]*?# END CODEX RELAY\r?\n?/g, "\n");
}

function hasRelayBlock(value) {
  const text = String(value || "");
  return text.includes("# BEGIN CODEX RELAY") && text.includes("# END CODEX RELAY");
}

function relayManagedConfigMatches(configText, applied) {
  const expected = applied?.managedConfig;
  if (!expected || !hasRelayBlock(configText)) return Boolean(applied?.configSha256 && sha256(configText) === applied.configSha256);
  return providerIdentityFromConfig(configText) === expected.providerIdentity
    && sameUrl(rootTomlValue(configText, "openai_base_url"), expected.routerUrl)
    && samePath(rootTomlValue(configText, "model_catalog_json"), expected.catalogPath);
}

function removeRelayRootSettings(value) {
  // A switcher may leave a global xhigh/ultra override behind. Relay uses each
  // published model's own default until the user explicitly changes it in Codex.
  const managed = new Set(["model_provider", "model", "model_catalog_json", "openai_base_url", "model_reasoning_effort"]);
  let inRootTable = true;
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^\[.*\]$/.test(trimmed)) {
        inRootTable = false;
        return true;
      }
      if (!inRootTable || trimmed.startsWith("#")) return true;
      const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
      return !match || !managed.has(match[1]);
    })
    .join("\n");
}

function providerIdentityFromConfig(configText) {
  return rootTomlValue(configText, "model_provider") || "openai";
}

function rootTomlValue(configText, key) {
  let inRootTable = true;
  for (const line of String(configText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inRootTable = false;
      continue;
    }
    if (!inRootTable || trimmed.startsWith("#")) continue;
    const match = trimmed.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*\"([^\"]*)\"`));
    if (match) return match[1];
  }
  return "";
}

function tableTomlValue(configText, table, key) {
  let inTarget = false;
  const acceptedHeaders = new Set([`[${table}]`, `[\"${table}\"]`]);
  for (const line of String(configText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inTarget = acceptedHeaders.has(trimmed);
      continue;
    }
    if (!inTarget || trimmed.startsWith("#")) continue;
    const match = trimmed.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*\"([^\"]*)\"`));
    if (match) return match[1];
  }
  return "";
}

function sameOrderedItems(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameUrl(actual, expected) {
  return String(actual || "").replace(/\/+$/, "") === String(expected || "").replace(/\/+$/, "");
}

function samePath(actual, expected) {
  if (!actual || !expected) return false;
  try {
    return path.resolve(actual).toLowerCase() === path.resolve(expected).toLowerCase();
  } catch {
    return false;
  }
}

function sessionInventory() {
  const files = sessionFiles();
  const index = codexSessionIndexInventory({ codexHome: CODEX_HOME });
  const indexedIds = new Set(index.ids);
  const inventoryFiles = files.files.map((file) => {
    const sessionId = sessionIdFromRolloutName(file.id);
    return { ...file, sessionId, indexed: sessionId ? indexedIds.has(sessionId) : false };
  });
  let doctor = null;
  try {
    const output = execFileSync("codex", ["doctor", "--json"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    const payload = JSON.parse(output);
    const details = payload?.checks?.["state.rollout_db_parity"]?.details || {};
    doctor = {
      activeRows: Number(details["rollout DB active rows"]) || 0,
      archivedRows: Number(details["rollout DB archived rows"]) || 0,
      totalRows: Number(details["rollout DB rows"]) || 0,
      providers: String(details["rollout DB model providers"] || ""),
    };
  } catch { /* File-level protection remains available when the CLI doctor cannot run. */ }
  return {
    available: files.available || Boolean(doctor),
    filesAvailable: files.available,
    capturedAt: new Date().toISOString(),
    activeRows: doctor?.activeRows ?? files.activeCount,
    archivedRows: doctor?.archivedRows ?? files.archivedCount,
    totalRows: doctor?.totalRows ?? files.files.length,
    providers: doctor?.providers || "",
    index: { available: index.available, supported: index.supported },
    files: inventoryFiles,
  };
}

function isOfficialDirectConfig(configText) {
  return providerIdentityFromConfig(configText) === "openai"
    && !hasRelayBlock(configText)
    && !rootTomlValue(configText, "model_catalog_json")
    && !rootTomlValue(configText, "openai_base_url");
}

function sessionFiles({ includeTargets = false } = {}) {
  const roots = [
    { root: path.join(CODEX_HOME, "sessions"), archived: false },
    { root: path.join(CODEX_HOME, "archived_sessions"), archived: true },
  ];
  const byId = new Map();
  let available = fs.existsSync(CODEX_HOME);
  for (const source of roots) {
    if (!fs.existsSync(source.root)) continue;
    available = true;
    for (const target of walkFiles(source.root)) {
      if (!target.toLowerCase().endsWith(".jsonl")) continue;
      const stats = fs.statSync(target);
      const id = path.basename(target).toLowerCase();
      const prefixLength = Math.min(stats.size, 64 * 1024);
      const handle = fs.openSync(target, "r");
      const prefix = Buffer.alloc(prefixLength);
      try { if (prefixLength) fs.readSync(handle, prefix, 0, prefixLength, 0); } finally { fs.closeSync(handle); }
      const entry = {
        id,
        size: stats.size,
        archived: source.archived,
        prefixBytes: prefixLength,
        prefixSha256: crypto.createHash("sha256").update(prefix).digest("hex"),
      };
      if (includeTargets) entry.target = target;
      const previous = byId.get(id);
      if (!previous || entry.size > previous.size) byId.set(id, entry);
    }
  }
  const files = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    available,
    files,
    activeCount: files.filter((file) => !file.archived).length,
    archivedCount: files.filter((file) => file.archived).length,
  };
}

function filePrefixSha256(target, length) {
  const prefixLength = Math.max(0, Number(length) || 0);
  const prefix = Buffer.alloc(prefixLength);
  const handle = fs.openSync(target, "r");
  try { if (prefixLength) fs.readSync(handle, prefix, 0, prefixLength, 0); } finally { fs.closeSync(handle); }
  return crypto.createHash("sha256").update(prefix).digest("hex");
}

function sessionIdFromRolloutName(value) {
  return String(value || "").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] || "";
}

function walkFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files;
}

function escapeTomlString(value) { return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function tomlPath(value) { return escapeTomlString(String(value).replace(/\\/g, "/")); }
function sha256(value) { return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function writeJsonAtomic(target, value) { writeTextAtomic(target, `${JSON.stringify(value, null, 2)}\n`); }
function writeTextAtomic(target, value) { const temp = `${target}.${process.pid}.tmp`; fs.writeFileSync(temp, value, "utf8"); fs.renameSync(temp, target); }
