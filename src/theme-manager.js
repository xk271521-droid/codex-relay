import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { themeById, themeCatalog } from "./theme-catalog.js";
import { loadThemeState, updateThemeIntent, updateThemeRuntime } from "./theme-state.js";

const AGENT_PATH = fileURLToPath(new URL("./theme-agent.js", import.meta.url));

export function themeView() {
  const state = loadThemeState();
  return {
    themes: themeCatalog(),
    selectedThemeId: state.selectedThemeId,
    enabled: state.enabled,
    runtime: state.runtime,
  };
}

export function selectTheme(themeId) {
  assertTheme(themeId);
  updateThemeIntent({ themeId, enabled: loadThemeState().enabled });
  return themeView();
}

export function applyTheme(themeId, { startAgent = launchThemeAgent, state = loadThemeState } = {}) {
  assertTheme(themeId);
  const before = state();
  const next = updateThemeIntent({ themeId, enabled: true });
  const running = processIsAlive(before.runtime.agentPid);
  updateThemeRuntime({
    status: running ? "starting" : "queued",
    message: running ? "主题助手正在更新外观。" : "正在启动独立主题助手。",
    appliedThemeId: running ? before.runtime.appliedThemeId : null,
  });
  if (!running) startAgent({ mode: "apply" });
  return themeView();
}

export function restoreDefaultTheme({ startAgent = launchThemeAgent, state = loadThemeState } = {}) {
  const before = state();
  updateThemeIntent({ enabled: false });
  const running = processIsAlive(before.runtime.agentPid);
  updateThemeRuntime({
    status: running || before.runtime.codexPid ? "restoring" : "idle",
    message: running || before.runtime.codexPid ? "正在恢复 Codex 默认外观。" : "Codex 当前已使用默认外观。",
  });
  if (!running && before.runtime.codexPid) startAgent({ mode: "restore" });
  return themeView();
}

export function ensureThemeAgent({ startAgent = launchThemeAgent } = {}) {
  const state = loadThemeState();
  if (!state.enabled || processIsAlive(state.runtime.agentPid)) return themeView();
  updateThemeRuntime({ status: "queued", message: "主题已保留；主题助手正在等待 Codex 启动。", agentPid: null, codexPid: null });
  startAgent({ mode: "watch" });
  return themeView();
}

export function launchThemeAgent({ mode = "watch", spawnProcess = spawn, executable = process.execPath, agentPath = AGENT_PATH } = {}) {
  const child = spawnProcess(executable, [agentPath, `--mode=${mode}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEX_RELAY_THEME_AGENT: "1" },
  });
  child.unref?.();
  return child.pid || null;
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function assertTheme(themeId) {
  if (!themeById(themeId)) {
    const error = new Error("未知主题，Codex 未做任何改动。");
    error.statusCode = 400;
    error.code = "theme_unknown";
    throw error;
  }
}
