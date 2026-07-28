import crypto from "node:crypto";

export const COMPACT_CAPABILITY_PROFILE_VERSION = 1;
export const COMPACT_CAPABILITY_TTL_MS = Object.freeze({
  supported: 30 * 24 * 60 * 60 * 1000,
  unsupported: 7 * 24 * 60 * 60 * 1000,
  temporary_failure: 5 * 60 * 1000,
});

const STORED_STATUSES = new Set(Object.keys(COMPACT_CAPABILITY_TTL_MS));
const MAX_PROFILES = 500;

export function compactCapabilityTarget({ provider, apiKey, upstreamModel, endpointUrl = "" } = {}) {
  const providerId = safeText(provider?.id, 128);
  const model = safeText(upstreamModel, 240);
  const endpoint = canonicalEndpoint(endpointUrl || provider?.endpointUrl || provider?.baseUrl);
  const key = String(apiKey || "");
  if (provider?.apiType !== "responses" || !providerId || !model || !endpoint || !key) return null;

  const authShape = JSON.stringify({
    header: safeText(provider?.authHeaderName || "authorization", 80).toLowerCase(),
    prefix: String(provider?.authHeaderPrefix ?? "Bearer ").replace(/[\r\n]/g, "").slice(0, 80),
    extraHeaders: Object.entries(provider?.extraHeaders || {})
      .map(([name, value]) => [String(name).toLowerCase(), String(value)])
      .sort(([left], [right]) => left.localeCompare(right)),
    networkMode: ["windows", "custom"].includes(provider?.networkMode) ? provider.networkMode : "direct",
    proxyFingerprint: provider?.networkMode === "custom" ? sha256(String(provider?.proxyUrl || "")) : "",
  });
  const keyFingerprint = sha256(key);
  const stateDomain = sha256([providerId, "responses", endpoint, authShape, keyFingerprint].join("\n"));
  return {
    providerId,
    upstreamModel: model,
    stateDomain,
    routeSignature: sha256(`${stateDomain}\n${model}`),
  };
}

export function compactCapabilityStatus(profiles, target, { now = Date.now() } = {}) {
  if (!target?.routeSignature) return unknown("ineligible_route");
  const raw = Array.isArray(profiles)
    ? profiles.find((profile) => profile?.routeSignature === target.routeSignature)
    : null;
  if (!raw) return unknown("not_verified");
  if (Number(raw.version) !== COMPACT_CAPABILITY_PROFILE_VERSION) return unknown("profile_version_mismatch");
  const profile = normalizeProfile(raw);
  if (!profile) return unknown("invalid_profile");
  if (Date.parse(profile.expiresAt) <= timestampMs(now)) return unknown("expired");
  return { status: profile.status, reason: profile.reason, profile };
}

export function recordCompactCapability(profiles, target, { status, reason = "", now = Date.now(), ttlMs } = {}) {
  if (!target?.routeSignature) return normalizeCompactCapabilityProfiles(profiles);
  const normalized = pruneCompactCapabilityProfiles(profiles, { now });
  const retained = normalized.filter((profile) => !sameCapabilityFamily(profile, target));
  if (status === "unknown") return retained;
  if (!STORED_STATUSES.has(status)) return normalized;

  const verifiedAtMs = timestampMs(now);
  const duration = positiveTtl(ttlMs) ?? COMPACT_CAPABILITY_TTL_MS[status];
  const profile = normalizeProfile({
    version: COMPACT_CAPABILITY_PROFILE_VERSION,
    providerId: target.providerId,
    upstreamModel: target.upstreamModel,
    stateDomain: target.stateDomain,
    routeSignature: target.routeSignature,
    status,
    reason: safeReason(reason),
    verifiedAt: new Date(verifiedAtMs).toISOString(),
    expiresAt: new Date(verifiedAtMs + duration).toISOString(),
  });
  return profile ? [...retained, profile].slice(-MAX_PROFILES) : retained;
}

export function clearCompactCapabilityProfiles(profiles, target = null) {
  if (!target?.routeSignature) return [];
  return normalizeCompactCapabilityProfiles(profiles).filter((profile) => profile.routeSignature !== target.routeSignature);
}

export function pruneCompactCapabilityProfiles(profiles, { now = Date.now() } = {}) {
  const current = timestampMs(now);
  return normalizeCompactCapabilityProfiles(profiles).filter((profile) => Date.parse(profile.expiresAt) > current);
}

export function normalizeCompactCapabilityProfiles(value) {
  if (!Array.isArray(value)) return [];
  const byRoute = new Map();
  for (const candidate of value.slice(-MAX_PROFILES * 2)) {
    const profile = normalizeProfile(candidate);
    if (!profile) continue;
    const previous = byRoute.get(profile.routeSignature);
    if (!previous || Date.parse(previous.verifiedAt) <= Date.parse(profile.verifiedAt)) byRoute.set(profile.routeSignature, profile);
  }
  return [...byRoute.values()]
    .sort((left, right) => Date.parse(left.verifiedAt) - Date.parse(right.verifiedAt))
    .slice(-MAX_PROFILES);
}

function normalizeProfile(profile) {
  const version = Number(profile?.version);
  const providerId = safeText(profile?.providerId, 128);
  const upstreamModel = safeText(profile?.upstreamModel, 240);
  const stateDomain = hash(profile?.stateDomain);
  const routeSignature = hash(profile?.routeSignature);
  const status = STORED_STATUSES.has(profile?.status) ? profile.status : "";
  const verifiedAt = isoTimestamp(profile?.verifiedAt);
  const expiresAt = isoTimestamp(profile?.expiresAt);
  if (version !== COMPACT_CAPABILITY_PROFILE_VERSION || !providerId || !upstreamModel || !stateDomain || !routeSignature || !status || !verifiedAt || !expiresAt) return null;
  if (Date.parse(expiresAt) <= Date.parse(verifiedAt)) return null;
  return {
    version,
    providerId,
    upstreamModel,
    stateDomain,
    routeSignature,
    status,
    reason: safeReason(profile?.reason),
    verifiedAt,
    expiresAt,
  };
}

function sameCapabilityFamily(profile, target) {
  return profile.providerId === target.providerId && profile.upstreamModel === target.upstreamModel;
}

function unknown(reason) {
  return { status: "unknown", reason, profile: null };
}

function canonicalEndpoint(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hash(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

function safeText(value, limit) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
}

function safeReason(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 120);
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function timestampMs(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : Date.now();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function positiveTtl(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
