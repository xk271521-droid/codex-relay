import crypto from "node:crypto";

const TRACE_HASH_KEYS = ["instructions", "tools", "input", "include"];

export function thirdPartyResponsesCacheTrace(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const trace = { version: 1 };
  const canonicalFields = new Map();
  for (const key of TRACE_HASH_KEYS) {
    if (body[key] === undefined) {
      trace[`${key}Hash`] = "absent";
      continue;
    }
    const canonical = canonicalJson(body[key]);
    canonicalFields.set(key, canonical);
    trace[`${key}Hash`] = shortHash(canonical);
  }
  trace.bodyHash = shortHash(canonicalTopLevelObject(body, canonicalFields));
  return trace;
}

export function shortCanonicalHash(value) {
  if (value === undefined) return "absent";
  return shortHash(canonicalJson(value));
}

function shortHash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function canonicalTopLevelObject(value, canonicalFields) {
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalFields.get(key) ?? canonicalJson(value[key])}`).join(",")}}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return "null";
}
