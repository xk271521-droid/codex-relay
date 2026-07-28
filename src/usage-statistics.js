const ALL_TIME_DAY_KEY = "*";
const STATISTICS_VERSION = 1;

export function localUsageDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safe.getFullYear();
  const month = String(safe.getMonth() + 1).padStart(2, "0");
  const day = String(safe.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function ensureUsageStatistics(database, { providerIdsByRoute = null } = {}) {
  createSchema(database);
  const initialized = readMeta(database, "initialized");
  if (initialized === String(STATISTICS_VERSION)) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    if (readMeta(database, "initialized") === String(STATISTICS_VERSION)) {
      database.exec("COMMIT");
      return;
    }
    const rows = database.prepare("SELECT event_json FROM request_history ORDER BY id ASC").all();
    const accumulator = createUsageStatisticsAccumulator();
    for (const row of rows) {
      try {
        const event = JSON.parse(row.event_json);
        const providerId = providerIdForRoute(providerIdsByRoute, event?.route?.id);
        accumulateUsageStatistics(accumulator, providerId ? { ...event, route: { ...event.route, providerId } } : event);
      } catch { /* Invalid historical rows remain available as request records but are not aggregated. */ }
    }
    persistUsageStatistics(database, accumulator);
    writeMeta(database, "initialized", String(STATISTICS_VERSION));
    writeMeta(database, "initialized_at", new Date().toISOString());
    writeMeta(database, "backfilled_records", String(rows.length));
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Keep the original migration error. */ }
    throw error;
  }
}

export function createUsageStatisticsAccumulator() { return new Map(); }

export function accumulateUsageStatistics(accumulator, event) {
  if (!(accumulator instanceof Map) || !event || typeof event !== "object") return accumulator;
  const at = validTimestamp(event.at) || new Date().toISOString();
  const route = event.route && typeof event.route === "object" ? event.route : {};
  const routeKind = route.kind === "official" ? "official" : "third_party";
  const providerId = routeKind === "official" ? "official" : safeText(route.providerId) || legacyProviderId(route.providerName, route.id);
  const providerName = routeKind === "official" ? "Official Codex" : safeText(route.providerName) || "未命名供应商";
  const upstreamModel = safeText(route.upstreamModel) || "未知模型";
  const delta = usageDelta(event, at);
  const dimensions = [
    { dimension: "relay", dimensionKey: "all", routeKind: null, providerId: null, providerName: null, upstreamModel: null },
    { dimension: "provider", dimensionKey: providerId, routeKind, providerId, providerName, upstreamModel: null },
    { dimension: "model", dimensionKey: upstreamModel, routeKind: null, providerId: null, providerName: null, upstreamModel },
  ];
  for (const dayKey of [ALL_TIME_DAY_KEY, localUsageDayKey(at)]) {
    for (const dimension of dimensions) mergeDelta(accumulator, { ...dimension, dayKey }, delta);
  }
  return accumulator;
}

export function persistUsageStatistics(database, accumulator) {
  if (!(accumulator instanceof Map) || !accumulator.size) return;
  const upsert = database.prepare(`
    INSERT INTO usage_statistics (
      day_key, dimension, dimension_key, route_kind, provider_id, provider_name, upstream_model,
      request_count, success_count, failure_count, compaction_count, usage_count, cache_reported_count,
      input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      first_at, last_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day_key, dimension, dimension_key) DO UPDATE SET
      route_kind = COALESCE(excluded.route_kind, usage_statistics.route_kind),
      provider_id = COALESCE(excluded.provider_id, usage_statistics.provider_id),
      provider_name = COALESCE(excluded.provider_name, usage_statistics.provider_name),
      upstream_model = COALESCE(excluded.upstream_model, usage_statistics.upstream_model),
      request_count = usage_statistics.request_count + excluded.request_count,
      success_count = usage_statistics.success_count + excluded.success_count,
      failure_count = usage_statistics.failure_count + excluded.failure_count,
      compaction_count = usage_statistics.compaction_count + excluded.compaction_count,
      usage_count = usage_statistics.usage_count + excluded.usage_count,
      cache_reported_count = usage_statistics.cache_reported_count + excluded.cache_reported_count,
      input_tokens = usage_statistics.input_tokens + excluded.input_tokens,
      cached_input_tokens = usage_statistics.cached_input_tokens + excluded.cached_input_tokens,
      uncached_input_tokens = usage_statistics.uncached_input_tokens + excluded.uncached_input_tokens,
      output_tokens = usage_statistics.output_tokens + excluded.output_tokens,
      reasoning_output_tokens = usage_statistics.reasoning_output_tokens + excluded.reasoning_output_tokens,
      total_tokens = usage_statistics.total_tokens + excluded.total_tokens,
      first_at = CASE WHEN usage_statistics.first_at IS NULL OR excluded.first_at < usage_statistics.first_at THEN excluded.first_at ELSE usage_statistics.first_at END,
      last_at = CASE WHEN usage_statistics.last_at IS NULL OR excluded.last_at > usage_statistics.last_at THEN excluded.last_at ELSE usage_statistics.last_at END
  `);
  let trackingStartedAt = null;
  for (const row of accumulator.values()) {
    trackingStartedAt = !trackingStartedAt || row.firstAt < trackingStartedAt ? row.firstAt : trackingStartedAt;
    upsert.run(
      row.dayKey, row.dimension, row.dimensionKey, row.routeKind, row.providerId, row.providerName, row.upstreamModel,
      row.requestCount, row.successCount, row.failureCount, row.compactionCount, row.usageCount, row.cacheReportedCount,
      row.inputTokens, row.cachedInputTokens, row.uncachedInputTokens, row.outputTokens, row.reasoningOutputTokens, row.totalTokens,
      row.firstAt, row.lastAt,
    );
  }
  if (trackingStartedAt) database.prepare("INSERT INTO usage_statistics_meta (key, value) VALUES ('tracking_started_at', ?) ON CONFLICT(key) DO UPDATE SET value = CASE WHEN excluded.value < usage_statistics_meta.value THEN excluded.value ELSE usage_statistics_meta.value END").run(trackingStartedAt);
}

export function readUsageStatistics(database, { dayKey = localUsageDayKey(), providerIdentities = [] } = {}) {
  createSchema(database);
  reconcileLegacyProviderIdentities(database, providerIdentities);
  const rows = database.prepare("SELECT * FROM usage_statistics WHERE day_key IN (?, ?)").all(ALL_TIME_DAY_KEY, dayKey);
  const byIdentity = new Map(rows.map((row) => [`${row.day_key}\n${row.dimension}\n${row.dimension_key}`, row]));
  const todayOverall = presentStatistics(byIdentity.get(`${dayKey}\nrelay\nall`));
  const totalOverall = presentStatistics(byIdentity.get(`${ALL_TIME_DAY_KEY}\nrelay\nall`));
  const providerKeys = new Set(rows.filter((row) => row.dimension === "provider").map((row) => row.dimension_key));
  const modelKeys = new Set(rows.filter((row) => row.dimension === "model").map((row) => row.dimension_key));
  const providers = [...providerKeys].map((key) => {
    const totalRow = byIdentity.get(`${ALL_TIME_DAY_KEY}\nprovider\n${key}`);
    const todayRow = byIdentity.get(`${dayKey}\nprovider\n${key}`);
    const identity = totalRow || todayRow || {};
    return {
      providerId: identity.provider_id || key,
      providerName: identity.provider_name || "未命名供应商",
      routeKind: identity.route_kind || "third_party",
      today: presentStatistics(todayRow),
      total: presentStatistics(totalRow),
    };
  });
  const models = [...modelKeys].map((key) => ({
    upstreamModel: key,
    today: presentStatistics(byIdentity.get(`${dayKey}\nmodel\n${key}`)),
    total: presentStatistics(byIdentity.get(`${ALL_TIME_DAY_KEY}\nmodel\n${key}`)),
  }));
  const trendDays = 30;
  const trendKeys = usageDayKeysEndingAt(dayKey, trendDays);
  const trendRows = database.prepare("SELECT * FROM usage_statistics WHERE dimension = 'relay' AND dimension_key = 'all' AND day_key >= ? AND day_key <= ?").all(trendKeys[0], dayKey);
  const trendByDay = new Map(trendRows.map((row) => [row.day_key, row]));
  return {
    dayKey,
    trackingStartedAt: readMeta(database, "tracking_started_at") || totalOverall.firstAt,
    initializedAt: readMeta(database, "initialized_at"),
    updatedAt: totalOverall.lastAt,
    overall: { today: todayOverall, total: totalOverall },
    providers,
    models,
    trend: { days: trendDays, items: trendKeys.map((key) => ({ dayKey: key, ...presentStatistics(trendByDay.get(key)) })) },
  };
}

export function reconcileLegacyProviderIdentities(database, providerIdentities = []) {
  const stableByName = new Map();
  for (const identity of Array.isArray(providerIdentities) ? providerIdentities : []) {
    const providerId = safeText(identity?.providerId || identity?.id);
    const providerName = safeText(identity?.providerName || identity?.name);
    const normalizedName = normalizeProviderName(providerName);
    if (!providerId || !normalizedName) continue;
    if (stableByName.has(normalizedName)) stableByName.set(normalizedName, null);
    else stableByName.set(normalizedName, { providerId, providerName });
  }
  const legacyRows = database.prepare("SELECT DISTINCT provider_id, provider_name FROM usage_statistics WHERE dimension = 'provider' AND provider_id LIKE 'legacy:%'").all();
  const mergeTargets = legacyRows.map((row) => ({ legacyId: safeText(row.provider_id), legacyName: safeText(row.provider_name), target: stableByName.get(normalizeProviderName(row.provider_name)) }))
    .filter((item) => item.legacyId && item.target);
  if (!mergeTargets.length) return { merged: 0 };

  const upsert = database.prepare(`
    INSERT INTO usage_statistics (
      day_key, dimension, dimension_key, route_kind, provider_id, provider_name, upstream_model,
      request_count, success_count, failure_count, compaction_count, usage_count, cache_reported_count,
      input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      first_at, last_at
    )
    SELECT day_key, dimension, ?, route_kind, ?, ?, upstream_model,
      request_count, success_count, failure_count, compaction_count, usage_count, cache_reported_count,
      input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      first_at, last_at
    FROM usage_statistics WHERE dimension = 'provider' AND dimension_key = ?
    ON CONFLICT(day_key, dimension, dimension_key) DO UPDATE SET
      route_kind = COALESCE(excluded.route_kind, usage_statistics.route_kind),
      provider_id = excluded.provider_id,
      provider_name = excluded.provider_name,
      request_count = usage_statistics.request_count + excluded.request_count,
      success_count = usage_statistics.success_count + excluded.success_count,
      failure_count = usage_statistics.failure_count + excluded.failure_count,
      compaction_count = usage_statistics.compaction_count + excluded.compaction_count,
      usage_count = usage_statistics.usage_count + excluded.usage_count,
      cache_reported_count = usage_statistics.cache_reported_count + excluded.cache_reported_count,
      input_tokens = usage_statistics.input_tokens + excluded.input_tokens,
      cached_input_tokens = usage_statistics.cached_input_tokens + excluded.cached_input_tokens,
      uncached_input_tokens = usage_statistics.uncached_input_tokens + excluded.uncached_input_tokens,
      output_tokens = usage_statistics.output_tokens + excluded.output_tokens,
      reasoning_output_tokens = usage_statistics.reasoning_output_tokens + excluded.reasoning_output_tokens,
      total_tokens = usage_statistics.total_tokens + excluded.total_tokens,
      first_at = CASE WHEN usage_statistics.first_at IS NULL OR excluded.first_at < usage_statistics.first_at THEN excluded.first_at ELSE usage_statistics.first_at END,
      last_at = CASE WHEN usage_statistics.last_at IS NULL OR excluded.last_at > usage_statistics.last_at THEN excluded.last_at ELSE usage_statistics.last_at END
  `);
  const remove = database.prepare("DELETE FROM usage_statistics WHERE dimension = 'provider' AND dimension_key = ?");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const item of mergeTargets) {
      upsert.run(item.target.providerId, item.target.providerId, item.target.providerName, item.legacyId);
      remove.run(item.legacyId);
    }
    database.exec("COMMIT");
    return { merged: mergeTargets.length };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Keep the original merge error. */ }
    throw error;
  }
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS usage_statistics_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_statistics (
      day_key TEXT NOT NULL,
      dimension TEXT NOT NULL,
      dimension_key TEXT NOT NULL,
      route_kind TEXT,
      provider_id TEXT,
      provider_name TEXT,
      upstream_model TEXT,
      request_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      compaction_count INTEGER NOT NULL DEFAULT 0,
      usage_count INTEGER NOT NULL DEFAULT 0,
      cache_reported_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      first_at TEXT,
      last_at TEXT,
      PRIMARY KEY(day_key, dimension, dimension_key)
    );
    CREATE INDEX IF NOT EXISTS usage_statistics_dimension ON usage_statistics(dimension, day_key);
  `);
}

function usageDelta(event, at) {
  const usage = event.usage && typeof event.usage === "object" ? event.usage : null;
  const input = tokenNumber(usage?.input);
  const output = tokenNumber(usage?.output);
  const reportedTotal = tokenNumber(usage?.total);
  const total = reportedTotal ?? (input !== null && output !== null ? input + output : null);
  const usageReported = input !== null || output !== null || total !== null;
  const cacheReported = Boolean(usageReported && usage?.cacheReported === true);
  const cachedInput = cacheReported ? tokenNumber(usage?.cachedInput) ?? 0 : 0;
  const uncachedInput = cacheReported ? tokenNumber(usage?.uncachedInput) ?? Math.max(0, (input ?? 0) - cachedInput) : 0;
  return {
    requestCount: 1,
    successCount: event.ok ? 1 : 0,
    failureCount: event.ok ? 0 : 1,
    compactionCount: event.contextMode === "compact" || event.diagnostics?.isCompaction === true ? 1 : 0,
    usageCount: usageReported ? 1 : 0,
    cacheReportedCount: cacheReported ? 1 : 0,
    inputTokens: input ?? 0,
    cachedInputTokens: cachedInput,
    uncachedInputTokens: uncachedInput,
    outputTokens: output ?? 0,
    reasoningOutputTokens: usageReported ? tokenNumber(usage?.reasoningOutput) ?? 0 : 0,
    totalTokens: total ?? 0,
    firstAt: at,
    lastAt: at,
  };
}

function mergeDelta(accumulator, identity, delta) {
  const key = `${identity.dayKey}\n${identity.dimension}\n${identity.dimensionKey}`;
  const current = accumulator.get(key);
  if (!current) {
    accumulator.set(key, { ...identity, ...delta });
    return;
  }
  current.routeKind = identity.routeKind || current.routeKind;
  current.providerId = identity.providerId || current.providerId;
  current.providerName = identity.providerName || current.providerName;
  current.upstreamModel = identity.upstreamModel || current.upstreamModel;
  for (const field of ["requestCount", "successCount", "failureCount", "compactionCount", "usageCount", "cacheReportedCount", "inputTokens", "cachedInputTokens", "uncachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]) current[field] += delta[field];
  if (delta.firstAt < current.firstAt) current.firstAt = delta.firstAt;
  if (delta.lastAt > current.lastAt) current.lastAt = delta.lastAt;
}

function presentStatistics(row) {
  const requestCount = integer(row?.request_count);
  const usageCount = integer(row?.usage_count);
  const cacheReportedCount = integer(row?.cache_reported_count);
  const cachedInputTokens = integer(row?.cached_input_tokens);
  const uncachedInputTokens = integer(row?.uncached_input_tokens);
  const cacheDenominator = cachedInputTokens + uncachedInputTokens;
  return {
    requestCount,
    successCount: integer(row?.success_count),
    failureCount: integer(row?.failure_count),
    compactionCount: integer(row?.compaction_count),
    usageCount,
    usageCoverage: requestCount ? roundPercent(usageCount, requestCount) : null,
    cacheReportedCount,
    cacheCoverage: requestCount ? roundPercent(cacheReportedCount, requestCount) : null,
    cacheHitRate: cacheReportedCount && cacheDenominator ? roundPercent(cachedInputTokens, cacheDenominator) : null,
    inputTokens: integer(row?.input_tokens),
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens: integer(row?.output_tokens),
    reasoningOutputTokens: integer(row?.reasoning_output_tokens),
    totalTokens: integer(row?.total_tokens),
    firstAt: row?.first_at || null,
    lastAt: row?.last_at || null,
  };
}

function legacyProviderId(providerName, routeId) {
  const name = safeText(providerName);
  return `legacy:${name || safeText(routeId) || "unknown"}`;
}
function providerIdForRoute(mapping, routeId) {
  if (!mapping || !routeId) return null;
  if (mapping instanceof Map) return safeText(mapping.get(routeId));
  return safeText(mapping[routeId]);
}
function readMeta(database, key) { return database.prepare("SELECT value FROM usage_statistics_meta WHERE key = ?").get(key)?.value || null; }
function writeMeta(database, key, value) { database.prepare("INSERT INTO usage_statistics_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); }
function tokenNumber(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null; }
function integer(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0; }
function roundPercent(part, total) { return Math.round((part / total) * 1000) / 10; }
function safeText(value) { return typeof value === "string" && value.trim() ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 2048) : null; }
function validTimestamp(value) { const text = String(value || ""); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text) ? text : ""; }
function usageDayKeysEndingAt(dayKey, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  const end = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date();
  const count = Math.max(1, Math.trunc(Number(days) || 1));
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setDate(end.getDate() - (count - 1 - index));
    return localUsageDayKey(date);
  });
}
function normalizeProviderName(value) { return safeText(value)?.toLocaleLowerCase("zh-CN").replace(/\s+/g, " ") || ""; }
