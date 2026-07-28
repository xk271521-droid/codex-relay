export const PERFORMANCE_BASELINE_SCHEMA_VERSION = 1;

export function buildPerformanceBaseline(events, options = {}) {
  const filters = normalizeFilters(options);
  const selected = (Array.isArray(events) ? events : []).filter((event) => matchesFilters(event, filters));
  const grouped = new Map();

  for (const event of selected) {
    const identity = routeIdentity(event?.route);
    const key = [identity.kind, identity.providerId, identity.upstreamModel, identity.routeId].join("\u0000");
    const group = grouped.get(key) || createGroup(identity);
    accumulate(group, event);
    grouped.set(key, group);
  }

  return {
    schemaVersion: PERFORMANCE_BASELINE_SCHEMA_VERSION,
    generatedAt: validTimestamp(options.generatedAt) || new Date().toISOString(),
    filters,
    sampleCount: selected.length,
    groups: [...grouped.values()]
      .sort((left, right) => groupLabel(left).localeCompare(groupLabel(right)))
      .map(finalizeGroup),
    interpretation: {
      tokenSource: "upstream_usage_only",
      missingUsage: "not_reported",
      byteMetricsAreNotTokenCost: true,
      correctnessRequiresManualFixedTaskReview: true,
    },
  };
}

function createGroup(identity) {
  return {
    identity,
    totals: {
      requests: 0,
      succeeded: 0,
      failed: 0,
      streaming: 0,
      cancelled: 0,
      retryRequests: 0,
      attempts: 0,
      upstreamAttempts: 0,
      compactions: 0,
    },
    metrics: {
      durationMs: [], headersMs: [], firstChunkMs: [], successDurationMs: [], successHeadersMs: [], successFirstChunkMs: [],
      inboundBytes: [], upstreamBytes: [], relayAddedBytes: [], successInboundBytes: [], successUpstreamBytes: [],
    },
    usage: {
      reportedCount: 0, cacheReportedCount: 0, input: 0, cachedInput: 0, uncachedInput: 0, output: 0, reasoningOutput: 0, total: 0,
    },
    contextModes: new Map(),
    statuses: new Map(),
    compactionStrategies: new Map(),
  };
}

function accumulate(group, event) {
  const totals = group.totals;
  totals.requests += 1;
  totals.succeeded += event?.ok ? 1 : 0;
  totals.failed += event?.ok ? 0 : 1;
  totals.streaming += event?.stream?.streaming ? 1 : 0;
  totals.cancelled += Number(event?.status) === 499 || event?.contextPressure?.cancelled === true ? 1 : 0;
  const attempts = nonNegativeNumber(event?.diagnostics?.attempts) ?? 1;
  const upstreamAttempts = nonNegativeNumber(event?.diagnostics?.upstreamAttempts) ?? attempts;
  totals.retryRequests += attempts > 1 || upstreamAttempts > 1 ? 1 : 0;
  totals.attempts += attempts;
  totals.upstreamAttempts += upstreamAttempts;
  totals.compactions += event?.diagnostics?.isCompaction || event?.contextMode === "compact" ? 1 : 0;

  pushMetric(group.metrics.durationMs, event?.durationMs);
  pushMetric(group.metrics.headersMs, event?.stream?.headersMs);
  pushMetric(group.metrics.firstChunkMs, event?.stream?.firstChunkMs);
  pushMetric(group.metrics.inboundBytes, event?.diagnostics?.inboundBytes ?? event?.request?.inboundBytes);
  pushMetric(group.metrics.upstreamBytes, event?.diagnostics?.upstreamBytes);
  pushMetric(group.metrics.relayAddedBytes, event?.diagnostics?.relayAddedBytes);
  if (event?.ok) {
    pushMetric(group.metrics.successDurationMs, event?.durationMs);
    pushMetric(group.metrics.successHeadersMs, event?.stream?.headersMs);
    pushMetric(group.metrics.successFirstChunkMs, event?.stream?.firstChunkMs);
    pushMetric(group.metrics.successInboundBytes, event?.diagnostics?.inboundBytes ?? event?.request?.inboundBytes);
    pushMetric(group.metrics.successUpstreamBytes, event?.diagnostics?.upstreamBytes);
  }

  const usage = event?.usage;
  if (hasReportedUsage(usage)) {
    group.usage.reportedCount += 1;
    for (const field of ["input", "output", "reasoningOutput", "total"]) group.usage[field] += nonNegativeNumber(usage?.[field]) ?? 0;
  }
  if (usage?.cacheReported === true) {
    group.usage.cacheReportedCount += 1;
    group.usage.cachedInput += nonNegativeNumber(usage.cachedInput) ?? 0;
    group.usage.uncachedInput += nonNegativeNumber(usage.uncachedInput) ?? 0;
  }

  increment(group.contextModes, cleanString(event?.contextMode) || "unknown");
  const status = nonNegativeNumber(event?.status);
  increment(group.statuses, status === null ? "unknown" : String(Math.round(status)));
  const strategy = cleanString(event?.diagnostics?.compactionStrategy);
  if (strategy) increment(group.compactionStrategies, strategy);
}

function finalizeGroup(group) {
  const requests = group.totals.requests;
  const reported = group.usage.reportedCount;
  const cacheReported = group.usage.cacheReportedCount;
  const cacheInput = group.usage.cachedInput + group.usage.uncachedInput;
  return {
    identity: group.identity,
    requests: group.totals,
    latency: {
      durationMs: metricSummary(group.metrics.durationMs),
      headersMs: metricSummary(group.metrics.headersMs),
      firstChunkMs: metricSummary(group.metrics.firstChunkMs),
      successfulDurationMs: metricSummary(group.metrics.successDurationMs),
      successfulHeadersMs: metricSummary(group.metrics.successHeadersMs),
      successfulFirstChunkMs: metricSummary(group.metrics.successFirstChunkMs),
    },
    bytes: {
      inbound: metricSummary(group.metrics.inboundBytes),
      upstream: metricSummary(group.metrics.upstreamBytes),
      relayAdded: metricSummary(group.metrics.relayAddedBytes),
      successfulInbound: metricSummary(group.metrics.successInboundBytes),
      successfulUpstream: metricSummary(group.metrics.successUpstreamBytes),
    },
    usage: {
      reportedCount: reported,
      coveragePercent: percentage(reported, requests),
      cacheReportedCount: cacheReported,
      cacheCoveragePercent: percentage(cacheReported, requests),
      inputTokens: reported ? group.usage.input : null,
      cachedInputTokens: cacheReported ? group.usage.cachedInput : null,
      uncachedInputTokens: cacheReported ? group.usage.uncachedInput : null,
      weightedCacheHitPercent: cacheReported && cacheInput > 0 ? round((group.usage.cachedInput / cacheInput) * 100, 1) : null,
      outputTokens: reported ? group.usage.output : null,
      reasoningOutputTokens: reported ? group.usage.reasoningOutput : null,
      totalTokens: reported ? group.usage.total : null,
    },
    contextModes: mapCounts(group.contextModes),
    statuses: mapCounts(group.statuses),
    compactionStrategies: mapCounts(group.compactionStrategies),
  };
}

function normalizeFilters(options) {
  return {
    from: validTimestamp(options.from),
    to: validTimestamp(options.to),
    routeKind: cleanString(options.routeKind),
    routeId: cleanString(options.routeId),
    providerId: cleanString(options.providerId),
    model: cleanString(options.model),
  };
}

function matchesFilters(event, filters) {
  const at = validTimestamp(event?.at);
  if (filters.from && (!at || Date.parse(at) < Date.parse(filters.from))) return false;
  if (filters.to && (!at || Date.parse(at) > Date.parse(filters.to))) return false;
  if (filters.routeKind && cleanString(event?.route?.kind) !== filters.routeKind) return false;
  if (filters.routeId && cleanString(event?.route?.id) !== filters.routeId) return false;
  if (filters.providerId && cleanString(event?.route?.providerId) !== filters.providerId) return false;
  if (filters.model && cleanString(event?.route?.upstreamModel) !== filters.model) return false;
  return true;
}

function routeIdentity(route) {
  return {
    routeId: cleanString(route?.id) || "unknown",
    displayName: cleanString(route?.displayName) || "Unknown route",
    kind: cleanString(route?.kind) || "unknown",
    providerId: cleanString(route?.providerId) || (route?.kind === "official" ? "official" : "unknown"),
    providerName: cleanString(route?.providerName) || (route?.kind === "official" ? "Official Codex" : "Unknown provider"),
    upstreamModel: cleanString(route?.upstreamModel) || "unknown",
  };
}

function metricSummary(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, min: null, median: null, p95: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    count: sorted.length,
    min: sorted[0],
    median: round(median, 1),
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    max: sorted.at(-1),
  };
}

function hasReportedUsage(usage) {
  return usage && typeof usage === "object" && ["input", "output", "total"].some((field) => nonNegativeNumber(usage[field]) !== null);
}

function pushMetric(target, value) {
  const number = nonNegativeNumber(value);
  if (number !== null) target.push(number);
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percentage(part, total) { return total > 0 ? round((part / total) * 100, 1) : null; }
function round(value, digits) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function increment(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function mapCounts(map) { return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right))); }
function groupLabel(group) { return [group.identity.providerName, group.identity.upstreamModel, group.identity.routeId].join("\u0000"); }
function cleanString(value) { return typeof value === "string" ? value.trim().slice(0, 160) : ""; }
function validTimestamp(value) {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
