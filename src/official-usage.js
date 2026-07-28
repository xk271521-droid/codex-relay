import { fetchOfficial } from "./official-fetch.js";

export const OFFICIAL_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

// This endpoint is not part of the public API. Keep its use isolated so a
// contract change affects only the optional account-information display.
export async function fetchOfficialUsage({ token, signal, fetcher = fetchOfficial } = {}) {
  if (!token) throw usageError(401, "当前没有可用的官方 Codex 登录凭据。", "official_auth_missing");

  const response = await fetcher(OFFICIAL_USAGE_ENDPOINT, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "OAI-Language": "zh-CN",
      originator: "codex-relay",
    },
    signal,
  });
  const raw = await response.text();
  if (!response.ok) throw usageError(response.status, usageFailureMessage(response.status), usageFailureCode(response.status));

  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { throw usageError(502, "官方额度服务返回了无法识别的数据。", "official_usage_invalid"); }

  const usage = parseOfficialUsage(payload);
  if (!usage) throw usageError(502, "官方额度服务没有返回可识别的套餐或用量数据。", "official_usage_empty");
  return usage;
}

export async function fetchOfficialUsageWithTimeout({ token, timeoutMs = 8_000, fetcher = fetchOfficial } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(usageError(504, "官方额度读取超时，请稍后重试。", "official_usage_timeout"));
    }, timeoutMs);
  });
  timer.unref?.();
  try {
    return await Promise.race([
      fetchOfficialUsage({ token, signal: controller.signal, fetcher }),
      timeout,
    ]);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw usageError(504, "官方额度读取超时，请稍后重试。", "official_usage_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parseOfficialUsage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rateLimit = objectValue(payload.rate_limit);
  const usage = {
    planType: normalizePlanType(payload.plan_type),
    fiveHour: usageWindow(rateLimit?.primary_window),
    weekly: usageWindow(rateLimit?.secondary_window),
  };
  return usage.planType || usage.fiveHour || usage.weekly ? usage : null;
}

export function normalizePlanType(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "free") return "free";
  if (normalized === "plus") return "plus";
  if (normalized === "pro") return "pro";
  if (["pro5x", "pro_5x", "pro-5x"].includes(normalized)) return "pro5x";
  if (["pro20x", "pro_20x", "pro-20x"].includes(normalized)) return "pro20x";
  return null;
}

function usageWindow(value) {
  const window = objectValue(value);
  const usedPercent = finiteNumber(window?.used_percent ?? window?.used_percentage);
  if (usedPercent === null) return null;
  return {
    usedPercent: Math.round(Math.min(100, Math.max(0, usedPercent))),
    resetsAt: resetTimestamp(window?.reset_at ?? window?.resets_at),
  };
}

function resetTimestamp(value) {
  const timestamp = finiteNumber(value);
  if (timestamp === null || timestamp <= 0) return null;
  const milliseconds = timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function usageFailureCode(status) {
  if (status === 401 || status === 403) return "official_usage_auth_failed";
  if (status === 429) return "official_usage_rate_limited";
  return "official_usage_failed";
}

function usageFailureMessage(status) {
  if (status === 401 || status === 403) return "官方登录已失效，请在 Codex 中重新登录后再刷新额度。";
  if (status === 429) return "官方额度服务暂时限制了刷新，请稍后再试。";
  return `官方额度读取失败，HTTP ${status}。`;
}

function usageError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
