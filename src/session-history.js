import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const DEFAULT_RELAY_HOME = process.env.CODEX_RELAY_HOME || path.join(os.homedir(), ".codex-relay");
const ACTIVE_MANIFEST_NAME = "cc-switch-history-handoff.json";
const BACKUP_GROUP = "cc-switch-history-unify-v1";
const SOURCE_PROVIDER = "custom";
const TARGET_PROVIDER = "openai";
const CODEX_STATE_DB_FILENAME = "state_5.sqlite";
const ARCHIVE_PATH_REPAIR_MANIFEST_NAME = "codex-archive-path-repair.json";
const THIRD_PARTY_MODEL_PATTERN = /^relay-third-party-\d+$/;
let historyOperationActive = false;

export function inspectCodexHistoryBuckets(options = {}) {
  const codexHome = path.resolve(options.codexHome || DEFAULT_CODEX_HOME);
  const files = codexSessionFiles(codexHome);
  const planFiles = [];
  const customSessionIds = new Set();
  let customSessionsWithoutId = 0;
  const jsonl = { custom: 0, openai: 0, other: 0, unknown: 0 };
  for (const target of files) {
    const meta = readSessionMeta(target);
    if (!meta?.provider) jsonl.unknown += 1;
    else if (meta.provider === SOURCE_PROVIDER) {
      jsonl.custom += 1;
      if (meta.id) customSessionIds.add(meta.id);
      else customSessionsWithoutId += 1;
      planFiles.push({ relative: safeRelative(codexHome, target), sessionId: meta.id || "", sha256: fileSha256(target) });
    }
    else if (meta.provider === TARGET_PROVIDER) jsonl.openai += 1;
    else jsonl.other += 1;
  }

  const databases = [];
  const planDatabases = [];
  const unsupportedDatabases = [];
  const state = { custom: 0, openai: 0, other: 0 };
  for (const target of codexStateDatabases(codexHome, options)) {
    const counts = databaseProviderCounts(target);
    if (!counts) {
      unsupportedDatabases.push(target);
      continue;
    }
    const threadIds = databaseThreadIds(target, SOURCE_PROVIDER);
    databases.push({ path: target, ...counts, supported: true });
    state.custom += counts.custom;
    state.openai += counts.openai;
    state.other += counts.other;
    for (const id of threadIds) customSessionIds.add(id);
    if (threadIds.length) {
      planDatabases.push({
        target: canonicalPath(target),
        backupRelative: databaseBackupRelative(codexHome, target),
        threadIds,
      });
    }
  }

  const planHash = crypto.createHash("sha256").update(JSON.stringify({
    codexHome: canonicalPath(codexHome),
    files: planFiles,
    databases: planDatabases,
    unsupportedDatabases: unsupportedDatabases.map(canonicalPath),
  })).digest("hex");
  const hasCandidates = jsonl.custom > 0 || state.custom > 0;
  const migrationBlocked = unsupportedDatabases.length > 0;

  return {
    codexHome,
    jsonl,
    state,
    customSessions: customSessionIds.size + customSessionsWithoutId,
    migratable: hasCandidates && !migrationBlocked,
    migrationBlocked,
    blockedReason: migrationBlocked ? "history_database_schema_changed" : null,
    filesScanned: files.length,
    databases: databases.map((item) => displayDatabasePath(codexHome, item.path)),
    unsupportedDatabases: unsupportedDatabases.map((target) => displayDatabasePath(codexHome, target)),
    planHash,
    active: Boolean(activeCodexHistoryMigration(options)),
  };
}

export function activeCodexHistoryMigration(options = {}) {
  const relayHome = path.resolve(options.relayHome || DEFAULT_RELAY_HOME);
  const target = path.join(relayHome, ACTIVE_MANIFEST_NAME);
  try {
    const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
    if (manifest?.version !== 1 || !manifest.backupRoot) return null;
    return manifest;
  } catch {
    return null;
  }
}

export function codexSessionIndexInventory(options = {}) {
  const codexHome = path.resolve(options.codexHome || DEFAULT_CODEX_HOME);
  const databases = codexStateDatabases(codexHome, options);
  const ids = new Set();
  let supported = databases.length > 0;
  for (const target of databases) {
    const current = databaseAllThreadIds(target);
    if (!current) {
      supported = false;
      continue;
    }
    for (const id of current) ids.add(id);
  }
  return {
    available: databases.length > 0,
    supported,
    ids: [...ids].sort(),
  };
}

export function codexArchivePathDatabaseTargets(options = {}) {
  const codexHome = path.resolve(options.codexHome || DEFAULT_CODEX_HOME);
  return codexStateDatabaseCandidates(codexHome, options);
}

// Codex Desktop's local archive service compares rollout_path with the normal
// sessions directory.  Windows extended paths (\\?\C:\...) are valid for
// file I/O but fail that comparison, so this compatibility repair only removes
// the prefix after verifying the file remains inside .codex\sessions.
export function inspectCodexArchivePathCompatibility(options = {}) {
  const codexHome = path.resolve(options.codexHome || DEFAULT_CODEX_HOME);
  const relayHome = path.resolve(options.relayHome || DEFAULT_RELAY_HOME);
  const databases = [];
  const candidates = [];
  const blocked = [];
  let supported = true;
  for (const target of codexStateDatabases(codexHome, options)) {
    const result = readArchivePathCandidates(target, codexHome);
    if (!result.supported) {
      supported = false;
      databases.push({ path: displayDatabasePath(codexHome, target), supported: false, candidates: 0, blocked: 0 });
      continue;
    }
    databases.push({
      path: displayDatabasePath(codexHome, target),
      supported: true,
      candidates: result.candidates.length,
      blocked: result.blocked.length,
    });
    candidates.push(...result.candidates.map((entry) => ({ ...entry, database: displayDatabasePath(codexHome, target) })));
    blocked.push(...result.blocked.map((entry) => ({ ...entry, database: displayDatabasePath(codexHome, target) })));
  }
  return {
    codexHome,
    available: databases.length > 0,
    supported,
    databases,
    candidates,
    blocked,
    fixable: candidates.length,
    active: Boolean(readArchivePathRepairManifest(relayHome)),
  };
}

export function repairCodexArchivePaths(options = {}) {
  return runHistoryOperationSync(() => repairCodexArchivePathsInner(options));
}

export function rollbackCodexArchivePaths(options = {}) {
  return runHistoryOperationSync(() => rollbackCodexArchivePathsInner(options));
}

function repairCodexArchivePathsInner(options = {}) {
  const codexHome = path.resolve(options.codexHome || DEFAULT_CODEX_HOME);
  const relayHome = path.resolve(options.relayHome || DEFAULT_RELAY_HOME);
  const inspection = inspectCodexArchivePathCompatibility({ ...options, codexHome, relayHome });
  if (!inspection.supported) throw historyError("Codex state database schema does not expose archive paths.", "archive_path_schema_unsupported");
  if (!inspection.fixable) {
    return { repaired: false, reused: Boolean(inspection.active), entries: 0, blocked: inspection.blocked.length, inspection };
  }

  const manifestPath = path.join(relayHome, ARCHIVE_PATH_REPAIR_MANIFEST_NAME);
  const previous = readArchivePathRepairManifest(relayHome);
  const priorEntries = previous?.entries || [];
  const known = new Set(priorEntries.map((entry) => `${entry.database}\u0000${entry.id}`));
  const entries = [...priorEntries];
  for (const entry of inspection.candidates) {
    const key = `${entry.database}\u0000${entry.id}`;
    if (!known.has(key)) {
      entries.push({
        database: path.resolve(codexHome, entry.database),
        id: entry.id,
        model: entry.model,
        oldPath: entry.rawPath,
        newPath: entry.normalizedPath,
      });
      known.add(key);
    }
  }
  const manifest = {
    version: 1,
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    codexHome,
    entries,
  };
  fs.mkdirSync(relayHome, { recursive: true });
  writeJsonAtomic(manifestPath, manifest);

  const changed = [];
  const groups = new Map();
  for (const entry of inspection.candidates) {
    const database = path.resolve(codexHome, entry.database);
    if (!groups.has(database)) groups.set(database, []);
    groups.get(database).push(entry);
  }
  try {
    for (const [database, group] of groups) {
      const db = new DatabaseSync(database);
      try {
        if (!hasArchivePathColumns(db)) throw historyError(`Codex state database has no archive path index: ${database}`, "archive_path_schema_unsupported");
        db.exec("BEGIN IMMEDIATE");
        const update = db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ? AND model = ? AND COALESCE(archived, 0) = 0 AND rollout_path = ?");
        for (const entry of group) {
          const result = update.run(entry.normalizedPath, entry.id, entry.model, entry.rawPath);
          if (Number(result.changes || 0) !== 1) throw historyError(`The Codex thread changed while archive compatibility was being repaired: ${entry.id}`, "archive_path_changed");
          changed.push(entry);
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* The transaction may not have started. */ }
        throw error;
      } finally {
        db.close();
      }
    }
    return { repaired: changed.length > 0, reused: false, entries: changed.length, blocked: inspection.blocked.length, manifest, inspection };
  } catch (error) {
    if (!previous) fs.rmSync(manifestPath, { force: true });
    throw error;
  }
}

function rollbackCodexArchivePathsInner(options = {}) {
  const codexHome = path.resolve(options.codexHome || DEFAULT_CODEX_HOME);
  const relayHome = path.resolve(options.relayHome || DEFAULT_RELAY_HOME);
  const manifest = readArchivePathRepairManifest(relayHome);
  if (!manifest) return { restored: false, entries: 0 };
  const groups = new Map();
  for (const entry of manifest.entries || []) {
    const database = path.resolve(entry.database);
    if (!groups.has(database)) groups.set(database, []);
    groups.get(database).push(entry);
  }
  let restored = 0;
  for (const [database, group] of groups) {
    const db = new DatabaseSync(database);
    try {
      if (!hasArchivePathColumns(db)) throw historyError(`Codex state database has no archive path index: ${database}`, "archive_path_schema_unsupported");
      db.exec("BEGIN IMMEDIATE");
      const update = db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?");
      for (const entry of group) {
        const result = update.run(entry.oldPath, entry.id, entry.newPath);
        if (Number(result.changes || 0) === 1) restored += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may not have started. */ }
      throw error;
    } finally {
      db.close();
    }
  }
  fs.rmSync(path.join(relayHome, ARCHIVE_PATH_REPAIR_MANIFEST_NAME), { force: true });
  return { restored: true, entries: restored, codexHome };
}

export async function migrateCodexCustomHistory(options = {}) {
  return runHistoryOperation(() => migrateCodexCustomHistoryInner(options));
}

async function migrateCodexCustomHistoryInner(options = {}) {
  const codexHome = path.resolve(options.codexHome || DEFAULT_CODEX_HOME);
  const relayHome = path.resolve(options.relayHome || DEFAULT_RELAY_HOME);
  const existing = activeCodexHistoryMigration({ relayHome });
  if (existing) {
    if (canonicalPath(existing.codexHome || "") !== canonicalPath(codexHome)) {
      throw historyError("The active CC Switch history handoff belongs to a different Codex directory.", "history_home_mismatch");
    }
    return { migrated: false, reused: true, manifest: existing };
  }
  const inspection = inspectCodexHistoryBuckets({ ...options, codexHome, relayHome });
  if (options.planHash && options.planHash !== inspection.planHash) {
    throw historyError("CC Switch conversation files changed after the preview. Nothing was modified; review the updated count and try again.", "history_plan_changed");
  }
  if (inspection.migrationBlocked) {
    throw historyError("The Codex conversation index database uses an unsupported schema. Nothing was modified; update Codex Relay before adjusting history visibility.", "history_database_schema_changed");
  }

  const fileTargets = codexSessionFiles(codexHome)
    .map((target) => ({ target, meta: readSessionMeta(target) }))
    .filter((item) => item.meta?.provider === SOURCE_PROVIDER);
  const databaseTargets = codexStateDatabases(codexHome, options)
    .map((target) => ({ target, threadIds: databaseThreadIds(target, SOURCE_PROVIDER) }))
    .filter((item) => item.threadIds.length > 0);
  if (!fileTargets.length && !databaseTargets.length) {
    return { migrated: false, reused: false, manifest: null, files: 0, rows: 0 };
  }

  fs.mkdirSync(relayHome, { recursive: true });
  const generation = `${timestampForPath()}-${crypto.randomUUID()}`;
  const backupRoot = path.join(relayHome, "backups", BACKUP_GROUP, generation);
  const manifestPath = path.join(relayHome, ACTIVE_MANIFEST_NAME);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    codexHome,
    sourceProvider: SOURCE_PROVIDER,
    targetProvider: TARGET_PROVIDER,
    planHash: inspection.planHash,
    eligibleCount: inspection.customSessions,
    backupRoot,
    files: [],
    databases: [],
  };

  try {
    for (const item of fileTargets) {
      const relative = safeRelative(codexHome, item.target);
      const backup = path.join(backupRoot, "jsonl", relative);
      copyFileWithParents(item.target, backup);
      manifest.files.push({
        relative,
        sessionId: item.meta.id || "",
        sha256: fileSha256(item.target),
      });
    }
    for (const item of databaseTargets) {
      const backupRelative = databaseBackupRelative(codexHome, item.target);
      const bundle = await backupSqliteBundle(item.target, path.join(backupRoot, "state", backupRelative));
      manifest.databases.push({
        target: path.resolve(item.target),
        backupRelative,
        threadIds: item.threadIds,
        bundle,
      });
    }
    writeJsonAtomic(manifestPath, manifest);

    const fileLedger = new Map(manifest.files.map((entry) => [entry.relative, entry]));
    for (const item of fileTargets) {
      const ledger = fileLedger.get(safeRelative(codexHome, item.target));
      if (!ledger || fileSha256(item.target) !== ledger.sha256) {
        throw historyError("A CC Switch conversation changed while its backup was being prepared. The migration was rolled back.", "history_plan_changed");
      }
      rewriteSessionProvider(item.target, SOURCE_PROVIDER, TARGET_PROVIDER, item.meta.id || null);
    }
    for (const item of databaseTargets) {
      if (!sameStringArrays(databaseThreadIds(item.target, SOURCE_PROVIDER), item.threadIds)) {
        throw historyError("The Codex conversation index changed while its backup was being prepared. The migration was rolled back.", "history_plan_changed");
      }
      updateDatabaseThreads(item.target, item.threadIds, SOURCE_PROVIDER, TARGET_PROVIDER);
    }
    verifyMigration(manifest);
    return {
      migrated: true,
      reused: false,
      manifest,
      sessions: inspection.customSessions,
      files: manifest.files.length,
      rows: manifest.databases.reduce((sum, item) => sum + item.threadIds.length, 0),
    };
  } catch (error) {
    try { restoreExactBackups(manifest); } catch { /* Preserve the migration error. */ }
    if (fs.existsSync(manifestPath)) fs.rmSync(manifestPath, { force: true });
    throw error;
  }
}

export function rollbackCodexHistoryMigration(options = {}) {
  return runHistoryOperationSync(() => rollbackCodexHistoryMigrationInner(options));
}

function rollbackCodexHistoryMigrationInner(options = {}) {
  const relayHome = path.resolve(options.relayHome || DEFAULT_RELAY_HOME);
  const manifest = activeCodexHistoryMigration({ relayHome });
  if (!manifest) return { restored: false, files: 0, rows: 0 };
  restoreExactBackups(manifest);
  clearActiveManifest(relayHome);
  return {
    restored: true,
    sessions: manifest.eligibleCount || ledgerSessionCount(manifest),
    files: manifest.files.length,
    rows: manifest.databases.reduce((sum, item) => sum + item.threadIds.length, 0),
  };
}

export async function restoreCodexHistoryMigration(options = {}) {
  return runHistoryOperation(() => restoreCodexHistoryMigrationInner(options));
}

async function restoreCodexHistoryMigrationInner(options = {}) {
  const relayHome = path.resolve(options.relayHome || DEFAULT_RELAY_HOME);
  const manifest = activeCodexHistoryMigration({ relayHome });
  if (!manifest) return { restored: false, files: 0, rows: 0 };
  const codexHome = path.resolve(options.codexHome || manifest.codexHome || DEFAULT_CODEX_HOME);
  if (canonicalPath(codexHome) !== canonicalPath(manifest.codexHome)) {
    throw historyError("The active CC Switch history handoff belongs to a different Codex directory.", "history_home_mismatch");
  }

  const live = liveHistoryManifest(manifest, options.deletedSessionIds);
  const restoreRoot = path.join(relayHome, "backups", `${BACKUP_GROUP}-restore-v1`, `${timestampForPath()}-${crypto.randomUUID()}`);
  const currentBackups = { version: 1, codexHome, backupRoot: restoreRoot, files: [], databases: [] };
  try {
    for (const item of live.files) {
      const target = resolveInside(codexHome, item.relative);
      const backup = path.join(restoreRoot, "jsonl", item.relative);
      copyFileWithParents(target, backup);
      currentBackups.files.push({ relative: item.relative });
      rewriteSessionProvider(target, TARGET_PROVIDER, SOURCE_PROVIDER, item.sessionId || null);
    }
    for (const item of live.databases) {
      const target = resolveDatabaseTarget(codexHome, item);
      const label = displayDatabasePath(codexHome, target);
      if (!fs.existsSync(target)) throw historyError(`A migrated Codex state database is missing: ${label}`, "history_database_missing");
      const backupRelative = item.backupRelative || databaseBackupRelative(codexHome, target);
      const bundle = await backupSqliteBundle(target, path.join(restoreRoot, "state", backupRelative));
      currentBackups.databases.push({
        target: path.resolve(target),
        backupRelative,
        threadIds: item.threadIds,
        bundle,
      });
      updateDatabaseThreads(target, item.threadIds, TARGET_PROVIDER, SOURCE_PROVIDER);
    }
    verifyRestoration(live);
    if (!options.keepActive) clearActiveManifest(relayHome);
    return {
      restored: true,
      sessions: ledgerSessionCount(live),
      files: live.files.length,
      rows: live.databases.reduce((sum, item) => sum + item.threadIds.length, 0),
      skippedDeleted: live.skippedDeleted.length,
      backupRoot: restoreRoot,
    };
  } catch (error) {
    try { restoreExactBackups(currentBackups); } catch { /* Preserve the restoration error. */ }
    throw error;
  }
}

export function reapplyCodexHistoryMigration(options = {}) {
  return runHistoryOperationSync(() => reapplyCodexHistoryMigrationInner(options));
}

function reapplyCodexHistoryMigrationInner(options = {}) {
  const relayHome = path.resolve(options.relayHome || DEFAULT_RELAY_HOME);
  const manifest = activeCodexHistoryMigration({ relayHome });
  if (!manifest) return { reapplied: false, files: 0, rows: 0 };
  const codexHome = path.resolve(options.codexHome || manifest.codexHome || DEFAULT_CODEX_HOME);
  const live = liveHistoryManifest(manifest, options.deletedSessionIds);
  for (const item of live.files) {
    const target = resolveInside(codexHome, item.relative);
    rewriteSessionProvider(target, SOURCE_PROVIDER, TARGET_PROVIDER, item.sessionId || null);
  }
  for (const item of live.databases) {
    const target = resolveDatabaseTarget(codexHome, item);
    updateDatabaseThreads(target, item.threadIds, SOURCE_PROVIDER, TARGET_PROVIDER);
  }
  verifyMigration(live);
  return {
    reapplied: true,
    files: live.files.length,
    rows: live.databases.reduce((sum, item) => sum + item.threadIds.length, 0),
    skippedDeleted: live.skippedDeleted.length,
  };
}

export function finalizeCodexHistoryMigration(options = {}) {
  return runHistoryOperationSync(() => finalizeCodexHistoryMigrationInner(options));
}

function finalizeCodexHistoryMigrationInner(options = {}) {
  const relayHome = path.resolve(options.relayHome || DEFAULT_RELAY_HOME);
  const active = Boolean(activeCodexHistoryMigration({ relayHome }));
  if (active) clearActiveManifest(relayHome);
  return { finalized: active };
}

function codexSessionFiles(codexHome) {
  const files = [];
  for (const [folder, maxDepth] of [["sessions", 8], ["archived_sessions", 4]]) {
    const root = path.join(codexHome, folder);
    if (!fs.existsSync(root)) continue;
    walk(root, files, 0, maxDepth);
  }
  return files.filter((target) => target.toLowerCase().endsWith(".jsonl"));
}

function codexStateDatabases(codexHome, options = {}) {
  return codexStateDatabaseCandidates(codexHome, options)
    .filter((target) => fs.existsSync(target) && fs.statSync(target).isFile());
}

function codexStateDatabaseCandidates(codexHome, options = {}) {
  const candidates = [path.join(codexHome, CODEX_STATE_DB_FILENAME)];
  const configText = options.configText ?? readOptionalText(path.join(codexHome, "config.toml"));
  const configuredHome = rootTomlValue(configText, "sqlite_home");
  const sqliteHome = configuredHome || options.sqliteHome || process.env.CODEX_SQLITE_HOME || "";
  if (String(sqliteHome).trim()) candidates.push(path.join(resolveUserPath(String(sqliteHome).trim()), CODEX_STATE_DB_FILENAME));
  const unique = new Map();
  for (const target of candidates) unique.set(canonicalPath(target), path.resolve(target));
  return [...unique.values()];
}

function walk(root, files, depth, maxDepth) {
  if (depth > maxDepth) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walk(target, files, depth + 1, maxDepth);
    else if (entry.isFile()) files.push(target);
  }
}

function readSessionMeta(target) {
  let handle;
  try {
    handle = fs.openSync(target, "r");
    const size = Math.min(fs.fstatSync(handle).size, 256 * 1024);
    const buffer = Buffer.alloc(size);
    if (size) fs.readSync(handle, buffer, 0, size, 0);
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      if (!line.includes("session_meta")) continue;
      const parsed = JSON.parse(line);
      if (parsed?.type !== "session_meta") continue;
      return {
        id: String(parsed?.payload?.id || ""),
        provider: String(parsed?.payload?.model_provider || "").trim(),
      };
    }
  } catch { /* Unreadable or older session files remain untouched. */ }
  finally { if (handle !== undefined) fs.closeSync(handle); }
  return null;
}

function rewriteSessionProvider(target, fromProvider, toProvider, expectedId = null) {
  const original = fs.readFileSync(target, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("session_meta") || !line.includes("model_provider")) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.type !== "session_meta" || parsed?.payload?.model_provider !== fromProvider) continue;
    const id = String(parsed?.payload?.id || "");
    if (expectedId && id !== expectedId) continue;
    parsed.payload.model_provider = toProvider;
    lines[index] = JSON.stringify(parsed);
    changed = true;
    break;
  }
  if (!changed) return false;
  writeTextAtomic(target, lines.join(newline));
  return true;
}

function databaseProviderCounts(target) {
  let db;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    if (!hasProviderColumn(db)) return null;
    const rows = db.prepare("SELECT COALESCE(model_provider, '') AS provider, COUNT(*) AS count FROM threads GROUP BY model_provider").all();
    const result = { custom: 0, openai: 0, other: 0 };
    for (const row of rows) {
      const provider = String(row.provider || "");
      const count = Number(row.count) || 0;
      if (provider === SOURCE_PROVIDER) result.custom += count;
      else if (provider === TARGET_PROVIDER) result.openai += count;
      else result.other += count;
    }
    return result;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* Ignore close failures during inspection. */ }
  }
}

function databaseThreadIds(target, provider) {
  let db;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    if (!hasProviderColumn(db)) return [];
    return db.prepare("SELECT id FROM threads WHERE model_provider = ? ORDER BY id").all(provider).map((row) => String(row.id));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* Ignore close failures during inspection. */ }
  }
}

function databaseAllThreadIds(target) {
  let db;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    if (!hasProviderColumn(db)) return null;
    return db.prepare("SELECT id FROM threads ORDER BY id").all().map((row) => String(row.id));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* Ignore close failures during inspection. */ }
  }
}

function readArchivePathCandidates(target, codexHome) {
  let db;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    if (!hasArchivePathColumns(db)) return { supported: false, candidates: [], blocked: [] };
    const rows = db.prepare("SELECT id, model, archived, rollout_path FROM threads WHERE COALESCE(archived, 0) = 0").all();
    const candidates = [];
    const blocked = [];
    for (const row of rows) {
      if (!THIRD_PARTY_MODEL_PATTERN.test(String(row.model || ""))) continue;
      const rawPath = String(row.rollout_path || "");
      const normalizedPath = stripWindowsExtendedPrefix(rawPath);
      if (!normalizedPath || normalizedPath === rawPath) continue;
      const status = archivePathStatus(codexHome, normalizedPath);
      const item = { id: String(row.id), model: String(row.model), rawPath, normalizedPath, reason: status.reason || null };
      if (status.fixable) candidates.push(item);
      else blocked.push(item);
    }
    return { supported: true, candidates, blocked };
  } catch {
    return { supported: false, candidates: [], blocked: [] };
  } finally {
    try { db?.close(); } catch { /* Ignore read-only inspection failures. */ }
  }
}

function hasArchivePathColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
  if (!table) return false;
  const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
  return columns.has("id") && columns.has("model") && columns.has("archived") && columns.has("rollout_path");
}

function archivePathStatus(codexHome, normalizedPath) {
  const target = path.resolve(normalizedPath);
  const sessionsRoot = path.resolve(codexHome, "sessions");
  const relative = path.relative(sessionsRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return { fixable: false, reason: "outside_sessions" };
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { fixable: false, reason: "rollout_missing" };
  return { fixable: true, reason: null };
}

function stripWindowsExtendedPrefix(value) {
  const prefix = "\\\\?\\";
  if (!String(value || "").startsWith(prefix)) return String(value || "");
  const stripped = String(value).slice(prefix.length);
  return /^UNC\\/i.test(stripped) ? `\\\\${stripped.slice(4)}` : stripped;
}

function readArchivePathRepairManifest(relayHome) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(relayHome, ARCHIVE_PATH_REPAIR_MANIFEST_NAME), "utf8"));
    if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function liveHistoryManifest(manifest, deletedSessionIds = []) {
  const deleted = new Set((deletedSessionIds || []).map(String));
  const skippedDeleted = new Set();
  const files = [];
  for (const item of manifest.files || []) {
    const target = resolveInside(manifest.codexHome, item.relative);
    if (fs.existsSync(target)) {
      files.push(item);
      continue;
    }
    const relocated = locateSessionById(manifest.codexHome, item.sessionId);
    if (relocated) {
      // Codex can move a conversation from sessions to archived_sessions.  Its
      // path is not its identity: preserve that move and restore in place.
      files.push({ ...item, relative: safeRelative(manifest.codexHome, relocated) });
      continue;
    }
    if (item.sessionId && deleted.has(String(item.sessionId))) {
      skippedDeleted.add(String(item.sessionId));
      continue;
    }
    throw historyError(`A migrated conversation is missing: ${item.relative}`, "history_file_missing");
  }

  const databases = [];
  for (const item of manifest.databases || []) {
    const target = resolveDatabaseTarget(manifest.codexHome, item);
    const existing = databaseAllThreadIds(target);
    if (!existing) {
      throw historyError(`A migrated Codex state database is missing or unreadable: ${displayDatabasePath(manifest.codexHome, target)}`, "history_database_missing");
    }
    const current = new Set(existing);
    const threadIds = [];
    for (const idValue of item.threadIds || []) {
      const id = String(idValue);
      if (current.has(id)) threadIds.push(id);
      else if (deleted.has(id)) skippedDeleted.add(id);
      else throw historyError(`A migrated Codex state row is missing: ${id}`, "history_row_missing");
    }
    if (threadIds.length) databases.push({ ...item, threadIds });
  }

  return { ...manifest, files, databases, skippedDeleted: [...skippedDeleted].sort() };
}

function locateSessionById(codexHome, sessionId) {
  const expected = String(sessionId || "");
  if (!expected) return null;
  const matches = codexSessionFiles(codexHome)
    .filter((target) => readSessionMeta(target)?.id === expected);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw historyError(`A migrated conversation has multiple files for session: ${expected}`, "history_file_ambiguous");
  }
  return null;
}

function hasProviderColumn(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
  if (!table) return false;
  return db.prepare("PRAGMA table_info(threads)").all().some((column) => column.name === "model_provider")
    && db.prepare("PRAGMA table_info(threads)").all().some((column) => column.name === "id");
}

function updateDatabaseThreads(target, threadIds, fromProvider, toProvider) {
  if (!threadIds.length) return;
  const db = new DatabaseSync(target);
  try {
    if (!hasProviderColumn(db)) throw historyError(`Codex state database has no provider index: ${target}`, "history_database_schema_changed");
    db.exec("BEGIN IMMEDIATE");
    const update = db.prepare("UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?");
    for (const id of threadIds) update.run(toProvider, id, fromProvider);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* The transaction may not have started. */ }
    throw error;
  } finally {
    db.close();
  }
}

function verifyMigration(manifest) {
  for (const item of manifest.files) {
    const meta = readSessionMeta(resolveInside(manifest.codexHome, item.relative));
    if (meta?.provider !== TARGET_PROVIDER || item.sessionId && meta.id !== item.sessionId) {
      throw historyError(`Could not verify migrated conversation metadata: ${item.relative}`, "history_migration_verification_failed");
    }
  }
  for (const item of manifest.databases) {
    const remaining = new Set(databaseThreadIds(resolveDatabaseTarget(manifest.codexHome, item), SOURCE_PROVIDER));
    if (item.threadIds.some((id) => remaining.has(id))) {
      throw historyError(`Could not verify migrated Codex state rows: ${item.backupRelative || item.relative}`, "history_migration_verification_failed");
    }
  }
}

function verifyRestoration(manifest) {
  for (const item of manifest.files) {
    const meta = readSessionMeta(resolveInside(manifest.codexHome, item.relative));
    if (meta?.provider !== SOURCE_PROVIDER || item.sessionId && meta.id !== item.sessionId) {
      throw historyError(`Could not verify restored conversation metadata: ${item.relative}`, "history_restore_verification_failed");
    }
  }
  for (const item of manifest.databases) {
    const restored = new Set(databaseThreadIds(resolveDatabaseTarget(manifest.codexHome, item), SOURCE_PROVIDER));
    if (item.threadIds.some((id) => !restored.has(id))) {
      throw historyError(`Could not verify restored Codex state rows: ${item.backupRelative || item.relative}`, "history_restore_verification_failed");
    }
  }
}

async function backupSqliteBundle(target, backupBase) {
  fs.mkdirSync(path.dirname(backupBase), { recursive: true });
  if (fs.existsSync(backupBase)) fs.rmSync(backupBase, { force: true });
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    await backup(db, backupBase);
  } finally {
    db.close();
  }
  return [{ suffix: "", sha256: fileSha256(backupBase) }];
}

function restoreExactBackups(manifest) {
  const codexHome = path.resolve(manifest.codexHome);
  for (const item of manifest.files || []) {
    const target = resolveInside(codexHome, item.relative);
    const backup = path.join(manifest.backupRoot, "jsonl", item.relative);
    copyFileWithParents(backup, target);
    if (item.sha256 && fileSha256(target) !== item.sha256) throw historyError(`Could not restore conversation backup: ${item.relative}`, "history_rollback_failed");
  }
  for (const item of manifest.databases || []) {
    const target = resolveDatabaseTarget(codexHome, item);
    const backupRelative = item.backupRelative || item.relative;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${target}${suffix}`)) fs.rmSync(`${target}${suffix}`, { force: true });
    }
    for (const file of item.bundle || []) {
      const backup = path.join(manifest.backupRoot, "state", `${backupRelative}${file.suffix}`);
      copyFileWithParents(backup, `${target}${file.suffix}`);
      if (file.sha256 && fileSha256(`${target}${file.suffix}`) !== file.sha256) throw historyError(`Could not restore Codex state backup: ${backupRelative}${file.suffix}`, "history_rollback_failed");
    }
  }
}

function clearActiveManifest(relayHome) {
  const target = path.join(relayHome, ACTIVE_MANIFEST_NAME);
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
}

function ledgerSessionCount(manifest) {
  const ids = new Set();
  let withoutId = 0;
  for (const item of manifest.files || []) {
    if (item.sessionId) ids.add(item.sessionId);
    else withoutId += 1;
  }
  for (const item of manifest.databases || []) {
    for (const id of item.threadIds || []) ids.add(String(id));
  }
  return ids.size + withoutId;
}

function safeRelative(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw historyError("A Codex history path escaped its data directory.", "history_path_invalid");
  return relative;
}

function databaseBackupRelative(codexHome, target) {
  const relative = path.relative(codexHome, target);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  const fingerprint = crypto.createHash("sha256").update(canonicalPath(target)).digest("hex").slice(0, 24);
  return path.join("external", `${fingerprint}-${path.basename(target)}`);
}

function displayDatabasePath(codexHome, target) {
  const relative = path.relative(codexHome, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : path.resolve(target);
}

function resolveDatabaseTarget(codexHome, item) {
  if (item?.target) {
    const target = path.resolve(item.target);
    const allowed = new Set(codexStateDatabaseCandidates(codexHome).map(canonicalPath));
    if (!allowed.has(canonicalPath(target))) {
      throw historyError("A Codex history database path is no longer allowed by config.toml.", "history_path_invalid");
    }
    safeBackupRelative(item.backupRelative || databaseBackupRelative(codexHome, target));
    return target;
  }
  const target = resolveInside(codexHome, item?.relative || "");
  if (path.basename(target).toLowerCase() !== CODEX_STATE_DB_FILENAME) {
    throw historyError("A Codex history database path is invalid.", "history_path_invalid");
  }
  return target;
}

function safeBackupRelative(relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) {
    throw historyError("A Codex history backup path is invalid.", "history_path_invalid");
  }
  return relative;
}

function resolveInside(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`.toLowerCase();
  if (!target.toLowerCase().startsWith(prefix)) throw historyError("A Codex history backup path is invalid.", "history_path_invalid");
  return target;
}

function copyFileWithParents(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function fileSha256(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function canonicalPath(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function sameStringArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readOptionalText(target) {
  try { return fs.readFileSync(target, "utf8"); }
  catch { return ""; }
}

function rootTomlValue(configText, key) {
  let inRootTable = true;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const line of String(configText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inRootTable = false;
      continue;
    }
    if (!inRootTable || trimmed.startsWith("#")) continue;
    const match = trimmed.match(new RegExp(`^${escapedKey}\\s*=\\s*"([^"]*)"`));
    if (match) return match[1];
  }
  return "";
}

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeJsonAtomic(target, value) {
  writeTextAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, value, "utf8");
  fs.renameSync(temp, target);
}

async function runHistoryOperation(operation) {
  if (historyOperationActive) throw historyError("Another Codex history operation is already running.", "history_operation_in_progress");
  historyOperationActive = true;
  try { return await operation(); }
  finally { historyOperationActive = false; }
}

function runHistoryOperationSync(operation) {
  if (historyOperationActive) throw historyError("Another Codex history operation is already running.", "history_operation_in_progress");
  historyOperationActive = true;
  try { return operation(); }
  finally { historyOperationActive = false; }
}

function historyError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
