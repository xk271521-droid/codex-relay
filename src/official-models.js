import { OFFICIAL_CODEX_BASE_URL } from "./constants.js";
import { fetchOfficial } from "./official-fetch.js";
import { runtimeProfileFromModelItem } from "./model-capabilities.js";

const MAX_OFFICIAL_MODELS = 100;

export async function fetchOfficialModels({ token, accountId, clientVersion = "", officialBaseUrl = OFFICIAL_CODEX_BASE_URL, signal } = {}) {
  if (!token) throw modelError(401, "当前没有可用的官方 Codex 登录凭据。", "official_auth_missing");
  if (!accountId) throw modelError(400, "当前官方登录缺少账户 ID，请在 Codex 中重新登录后再试。", "official_account_missing");

  const endpoint = new URL(`${String(officialBaseUrl).replace(/\/+$/, "")}/models`);
  if (clientVersion) endpoint.searchParams.set("client_version", String(clientVersion));
  const response = await fetchOfficial(endpoint, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "chatgpt-account-id": accountId,
      originator: "codex-relay",
    },
    signal,
  });
  const raw = await response.text();
  if (!response.ok) {
    const detail = upstreamMessage(raw);
    throw modelError(response.status, `官方模型列表读取失败，HTTP ${response.status}${detail ? `：${detail}` : "。"}`, "official_models_failed");
  }

  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { throw modelError(502, "官方模型列表返回了无法识别的数据。", "official_models_invalid"); }
  const models = parseOfficialModels(payload);
  if (!models.length) throw modelError(502, "当前官方账号没有返回可识别的 Codex 模型。现有官方槽位未改变。", "official_models_empty");
  return models;
}

export function parseOfficialModels(payload) {
  const entries = modelEntries(payload);
  const models = [];
  for (const entry of entries) {
    const model = normalizeOfficialModel(entry);
    if (model) models.push(model);
    if (models.length >= MAX_OFFICIAL_MODELS) break;
  }
  models.sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { numeric: true }));
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

export function normalizeOfficialModel(entry) {
  if (typeof entry === "string") {
    const id = modelId(entry);
    return id ? baseModel(id, id) : null;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = modelId(entry.slug || entry.id || entry.model || entry.name);
  if (!id) return null;
  const displayName = cleanText(entry.display_name || entry.displayName || entry.title || entry.name || id, 120) || id;
  const description = cleanText(entry.description, 240);
  const contextWindow = positiveInteger(entry.context_window ?? entry.max_context_window);
  const inputModalities = Array.isArray(entry.input_modalities) ? entry.input_modalities.map((value) => String(value).toLowerCase()) : [];
  const reasoningLevels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels.map((item) => ({
      effort: cleanText(typeof item === "string" ? item : item?.effort, 32).toLowerCase(),
      description: cleanText(typeof item === "object" ? item?.description : "", 160),
    })).filter((item) => item.effort).slice(0, 8)
    : [];
  const defaultReasoningLevel = cleanText(entry.default_reasoning_level || entry.defaultReasoningLevel, 32).toLowerCase();
  return {
    ...baseModel(id, displayName),
    ...runtimeProfileFromModelItem(entry),
    ...(description ? { description } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    supportsImages: Boolean(entry.supports_image_detail_original || inputModalities.includes("image")),
    ...(reasoningLevels.length ? { reasoningLevels } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
  };
}

function modelEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  if (Array.isArray(payload?.items)) return payload.items;
  if (payload?.models && typeof payload.models === "object") {
    return Object.entries(payload.models).map(([id, value]) => typeof value === "object" && value ? { id, ...value } : id);
  }
  return [];
}

function baseModel(id, displayName) {
  return {
    id,
    displayName,
    upstreamModel: id,
    description: "Uses the signed-in Codex account when verified.",
  };
}

function modelId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id) ? id : "";
}

function cleanText(value, limit) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 8_000 && number <= 10_000_000 ? number : null;
}

function upstreamMessage(raw) {
  try { return cleanText(JSON.parse(raw)?.error?.message || JSON.parse(raw)?.message, 240); }
  catch { return ""; }
}

function modelError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
