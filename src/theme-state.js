import fs from "node:fs";
import path from "node:path";
import { paths } from "./store.js";
import { themeById } from "./theme-catalog.js";

export const DEFAULT_THEME_STATE = Object.freeze({
  version: 1,
  selectedThemeId: "inspiration-notes",
  enabled: false,
  requestedAt: null,
  runtime: {
    status: "idle",
    message: "尚未应用主题。",
    agentPid: null,
    codexPid: null,
    codexVersion: null,
    appliedThemeId: null,
    updatedAt: null,
  },
});

export function loadThemeState({ file = paths().themeState } = {}) {
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_THEME_STATE);
  try {
    return normalizeThemeState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return structuredClone(DEFAULT_THEME_STATE);
  }
}

export function saveThemeState(value, { file = paths().themeState } = {}) {
  const state = normalizeThemeState(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, state);
  return state;
}

export function updateThemeIntent({ themeId, enabled }, { file = paths().themeState } = {}) {
  const current = loadThemeState({ file });
  const selectedThemeId = themeId === undefined ? current.selectedThemeId : validThemeId(themeId, current.selectedThemeId);
  return saveThemeState({
    ...current,
    selectedThemeId,
    enabled: Boolean(enabled),
    requestedAt: new Date().toISOString(),
  }, { file });
}

export function updateThemeRuntime(patch, { file = paths().themeState } = {}) {
  const current = loadThemeState({ file });
  return saveThemeState({
    ...current,
    runtime: {
      ...current.runtime,
      ...(patch && typeof patch === "object" ? patch : {}),
      updatedAt: new Date().toISOString(),
    },
  }, { file });
}

export function normalizeThemeState(value) {
  const source = value && typeof value === "object" ? value : {};
  const runtime = source.runtime && typeof source.runtime === "object" ? source.runtime : {};
  const selectedThemeId = validThemeId(source.selectedThemeId, DEFAULT_THEME_STATE.selectedThemeId);
  return {
    version: 1,
    selectedThemeId,
    enabled: source.enabled === true,
    requestedAt: validDate(source.requestedAt),
    runtime: {
      status: validRuntimeStatus(runtime.status),
      message: String(runtime.message || DEFAULT_THEME_STATE.runtime.message).slice(0, 500),
      agentPid: validPid(runtime.agentPid),
      codexPid: validPid(runtime.codexPid),
      codexVersion: runtime.codexVersion ? String(runtime.codexVersion).slice(0, 120) : null,
      appliedThemeId: themeById(runtime.appliedThemeId) ? runtime.appliedThemeId : null,
      updatedAt: validDate(runtime.updatedAt),
    },
  };
}

function validThemeId(value, fallback) { return themeById(value) ? value : fallback; }
function validDate(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null; }
function validPid(value) { return Number.isInteger(value) && value > 0 ? value : null; }
function validRuntimeStatus(value) { return ["idle", "queued", "starting", "applied", "restoring", "error"].includes(value) ? value : "idle"; }
function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}
