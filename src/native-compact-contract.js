const COMPACT_OBJECT_TYPES = new Set(["response", "response.compaction"]);
const TEMPORARY_HTTP_STATUSES = new Set([408, 409, 425, 429]);
const UNSUPPORTED_HTTP_STATUSES = new Set([404, 405, 501]);
const CONDITIONAL_UNSUPPORTED_STATUSES = new Set([400, 415, 422]);
const MESSAGE_LIMIT = 240;
const SINGLE_COMPACTION_CONTRACT = "single_compaction_v1";
const RETAINED_OUTPUT_COMPACTION_CONTRACT = "retained_output_compaction_v2";

export function validateNativeCompactPayload(payload, { expectedModel = "" } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid("payload_type");
  if (typeof payload.id !== "string" || !payload.id.trim()) return invalid("response_id_missing");
  if (!COMPACT_OBJECT_TYPES.has(payload.object)) return invalid("object_type");
  if (payload.status != null && payload.status !== "completed") return invalid("response_status");

  if (!Array.isArray(payload.output)) return invalid("output_type");
  const compactionIndexes = [];
  for (let index = 0; index < payload.output.length; index += 1) {
    if (payload.output[index]?.type === "compaction") compactionIndexes.push(index);
  }
  if (compactionIndexes.length === 0) return invalid("compaction_item_missing");
  if (compactionIndexes.length > 1) return invalid("compaction_item_multiple");

  const compactionIndex = compactionIndexes[0];
  const compactionItem = payload.output[compactionIndex];
  if (typeof compactionItem.encrypted_content !== "string" || !compactionItem.encrypted_content.trim()) {
    return invalid("encrypted_content_missing");
  }

  const routeModel = String(expectedModel || "").trim();
  const responseModel = typeof payload.model === "string" ? payload.model.trim() : "";
  if (routeModel && responseModel && routeModel !== responseModel) return invalid("model_mismatch");

  return {
    valid: true,
    reason: "valid_compaction",
    contractVersion: payload.output.length === 1 ? SINGLE_COMPACTION_CONTRACT : RETAINED_OUTPUT_COMPACTION_CONTRACT,
    compactionIndex,
    compactionItem,
  };
}

export function classifyNativeCompactHttpResult({ status, contentType = "", bodyText = "", expectedModel = "" } = {}) {
  const httpStatus = Number(status) || 0;
  const type = String(contentType || "").toLowerCase();
  const raw = String(bodyText || "");

  if (httpStatus >= 200 && httpStatus < 300) {
    const parsed = parseCompactPayload(raw, type);
    if (!parsed.ok) {
      return classification("invalid_response", "unknown", false, parsed.reason, safeMessage(raw));
    }
    const validation = validateNativeCompactPayload(parsed.payload, { expectedModel });
    if (!validation.valid) {
      return classification("invalid_response", "unknown", false, validation.reason, "Upstream returned an invalid Compact response.");
    }
    return {
      ...classification("supported", "supported", false, "valid_compaction", ""),
      payload: parsed.payload,
      contractVersion: validation.contractVersion,
      compactionIndex: validation.compactionIndex,
      compactionItem: validation.compactionItem,
    };
  }

  const message = errorMessage(raw);
  if (UNSUPPORTED_HTTP_STATUSES.has(httpStatus)) {
    return classification("unsupported", "unsupported", false, `http_${httpStatus}`, message);
  }
  if (CONDITIONAL_UNSUPPORTED_STATUSES.has(httpStatus) && signalsUnsupportedCompact(message)) {
    return classification("unsupported", "unsupported", false, `http_${httpStatus}_unsupported`, message);
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return classification("authentication_failure", "unknown", false, `http_${httpStatus}`, message);
  }
  if (TEMPORARY_HTTP_STATUSES.has(httpStatus) || httpStatus >= 500 || httpStatus === 0) {
    return classification("temporary_failure", "unknown", true, `http_${httpStatus || "unknown"}`, message);
  }
  return classification("request_rejected", "unknown", false, `http_${httpStatus || "unknown"}`, message);
}

export function classifyNativeCompactTransportError(error) {
  const name = String(error?.name || "");
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const message = String(error?.message || "");
  if (name === "TimeoutError" || code === "ETIMEDOUT" || /timed?\s*out|timeout/i.test(message)) {
    return classification("temporary_failure", "unknown", true, "upstream_timeout", safeMessage(message));
  }
  if (name === "AbortError") {
    return classification("cancelled", "unknown", false, "request_cancelled", "Request was cancelled.");
  }
  return classification("temporary_failure", "unknown", true, "network_failure", safeMessage(message));
}

function parseCompactPayload(raw, contentType) {
  if (/text\/event-stream/i.test(contentType)) return parseCompactEventStream(raw);
  if (/text\/html/i.test(contentType) || /^\s*</.test(raw)) return { ok: false, reason: "unexpected_content_type" };
  try {
    return { ok: true, payload: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "malformed_json" };
  }
}

function parseCompactEventStream(raw) {
  const frames = raw.split(/\r?\n\r?\n/).filter((frame) => frame.trim());
  let completed = null;
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (event?.type === "response.completed" && event.response) completed = event.response;
      else if (event?.object === "response" || event?.object === "response.compaction") completed = event;
    } catch {
      return { ok: false, reason: "truncated_stream" };
    }
  }
  return completed ? { ok: true, payload: completed } : { ok: false, reason: "truncated_stream" };
}

function signalsUnsupportedCompact(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return /(?:compact|responses\/compact)/.test(text)
    && /(?:not supported|unsupported|unknown endpoint|unknown route|endpoint[^.]*not found|route[^.]*not found|not implemented|unavailable)/.test(text);
}

function errorMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? parsed?.error;
    if (typeof message === "string") return safeMessage(message);
  } catch {
    // Non-JSON upstream errors are reduced to a short, markup-free preview.
  }
  return safeMessage(raw);
}

function safeMessage(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MESSAGE_LIMIT);
}

function classification(outcome, capability, retryable, reason, message) {
  return { outcome, capability, retryable, reason, message: safeMessage(message) };
}

function invalid(reason) {
  return { valid: false, reason };
}
