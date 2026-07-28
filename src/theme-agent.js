import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { themeById, themeCss } from "./theme-catalog.js";
import { themeRuntimeBootstrap } from "./theme-runtime.js";
import { loadThemeState, updateThemeIntent, updateThemeRuntime } from "./theme-state.js";

export { themeRuntimeBootstrap };

const STARTUP_TIMEOUT_MS = 25_000;
const CLOSE_TIMEOUT_MS = 12_000;
const PUBLIC_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const heroCache = new Map();

export async function runThemeAgent({
  mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) || "watch",
  readState = loadThemeState,
  writeRuntime = updateThemeRuntime,
  writeIntent = updateThemeIntent,
  findInstallation = findOfficialCodexInstallation,
  listProcesses = listCodexProcesses,
  closeWindows = closeCodexWindows,
  launchThemed = launchThemedCodex,
  launchNormal = launchNormalCodex,
  wait = delay,
} = {}) {
  const previous = readState();
  if (previous.runtime.agentPid && previous.runtime.agentPid !== process.pid && processIsAlive(previous.runtime.agentPid)) return { started: false, reason: "already_running" };

  let session = null;
  let lastRequest = "";
  let startImmediately = mode === "apply";
  writeRuntime({ status: "starting", message: "主题助手正在准备。", agentPid: process.pid, codexPid: null });
  try {
    while (true) {
      const state = readState();
      const requestKey = `${state.enabled}:${state.selectedThemeId}:${state.requestedAt || ""}`;
      if (!state.enabled) {
        if (session) await restoreThemeSession(session, { writeRuntime, launchNormal });
        else if (state.runtime.codexPid) await restoreRecordedThemeSession(state.runtime, { findInstallation, listProcesses, launchNormal });
        writeRuntime({ status: "idle", message: "Codex 当前使用默认外观。", agentPid: null, codexPid: null, appliedThemeId: null });
        return { started: true, restored: Boolean(session) };
      }

      if (!session) {
        const installation = findInstallation();
        const existing = listProcesses(installation.installLocation);
        if (!startImmediately && !existing.length) {
          writeRuntime({ status: "queued", message: "主题已保留；主题助手正在等待 Codex 启动。", agentPid: process.pid, codexPid: null, codexVersion: installation.version, appliedThemeId: null });
          await wait(900);
          continue;
        }
        session = await createThemeSession({ themeId: state.selectedThemeId, installation, existing, findInstallation, listProcesses, closeWindows, launchThemed, writeRuntime });
        startImmediately = false;
        lastRequest = requestKey;
      } else if (session.child.exitCode !== null || session.child.killed) {
        session.pipe.close();
        session = null;
        writeRuntime({ status: "queued", message: "主题已保留；主题助手正在等待 Codex 再次启动。", agentPid: process.pid, codexPid: null, appliedThemeId: null });
        await wait(900);
        continue;
      } else if (requestKey !== lastRequest) {
        await injectTheme(session, state.selectedThemeId);
        lastRequest = requestKey;
        writeRuntime({ status: "applied", message: `已应用“${themeById(state.selectedThemeId).name}”。`, agentPid: process.pid, codexPid: session.child.pid, codexVersion: session.installation.version, appliedThemeId: state.selectedThemeId });
      } else {
        await ensureThemeInjected(session, state.selectedThemeId);
      }
      await wait(900);
    }
  } catch (error) {
    writeRuntime({ status: "error", message: friendlyError(error), agentPid: null, codexPid: session?.child?.pid || null, appliedThemeId: null });
    try { session?.pipe.close(); } catch { /* best effort */ }
    return { started: true, error: error.message };
  }
}

export async function createThemeSession({ themeId, installation = null, existing = null, findInstallation, listProcesses, closeWindows, launchThemed, writeRuntime }) {
  const theme = themeById(themeId);
  if (!theme) throw themedError("未知主题，Codex 未做任何改动。", "theme_unknown");
  const resolvedInstallation = installation || findInstallation();
  const resolvedExisting = existing || listProcesses(resolvedInstallation.installLocation);
  if (resolvedExisting.length) {
    writeRuntime({ status: "starting", message: "正在等待 Codex 正常关闭。", codexVersion: resolvedInstallation.version });
    const closed = await closeWindows(resolvedExisting, CLOSE_TIMEOUT_MS);
    if (!closed) throw themedError("Codex 仍在运行。请先保存未完成内容并完全退出 Codex，再重新应用主题。", "codex_close_required");
  }

  writeRuntime({ status: "starting", message: "正在启动受控 Codex 外观会话。", codexVersion: resolvedInstallation.version });
  const child = launchThemed(resolvedInstallation.executablePath);
  const pipe = new DevToolsPipe(child);
  const target = await waitForCodexTarget(pipe, resolvedInstallation.installLocation);
  const session = { child, pipe, target, installation: resolvedInstallation, themeId: null };
  await injectTheme(session, themeId);
  writeRuntime({ status: "applied", message: `已应用“${theme.name}”。`, agentPid: process.pid, codexPid: child.pid, codexVersion: resolvedInstallation.version, appliedThemeId: themeId });
  return session;
}

export async function injectTheme(session, themeId) {
  const theme = themeById(themeId);
  if (!theme) throw themedError("主题已不存在，未修改 Codex。", "theme_unknown");
  const target = session.target || await waitForCodexTarget(session.pipe, session.installation.installLocation);
  const sessionId = await attachedSessionId(session, target.targetId);
  const expression = themeInjectionExpression(theme, themeCss(themeId), themeHeroData(theme));
  const evaluation = await session.pipe.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (evaluation?.exceptionDetails) {
    const detail = evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text || "Codex 执行主题脚本失败。";
    throw themedError(detail, "theme_injection_failed");
  }
  if (evaluation?.result?.value?.themeId !== themeId) throw themedError("Codex 未确认主题已应用。", "theme_injection_unverified");
  session.target = target;
  session.themeId = themeId;
}

export async function ensureThemeInjected(session, themeId, { inject = injectTheme } = {}) {
  const sessionId = await attachedSessionId(session, session.target.targetId);
  const result = await session.pipe.send("Runtime.evaluate", { expression: `window.__CODEX_RELAY_THEME_ID__ === ${JSON.stringify(themeId)}`, returnByValue: true }, sessionId);
  const installed = result?.result?.value === true;
  const needsInjection = !installed || session.themeId !== themeId;
  if (needsInjection) await inject(session, themeId);
  return { installed, reinjected: needsInjection };
}

export async function restoreThemeSession(session, { writeRuntime, launchNormal }) {
  writeRuntime({ status: "restoring", message: "正在恢复 Codex 默认外观。", agentPid: process.pid, codexPid: session.child.pid });
  try {
    const sessionId = await attachedSessionId(session, session.target.targetId);
    await session.pipe.send("Runtime.evaluate", { expression: "window.__CODEX_RELAY_THEME_CLEANUP__?.()", returnByValue: true }, sessionId);
  } catch { /* The subsequent restart still restores the original app session. */ }
  session.pipe.close();
  await closeOwnedProcess(session.child.pid);
  launchNormal(session.installation.executablePath);
}

export async function restoreRecordedThemeSession(runtime, { findInstallation, listProcesses, launchNormal }) {
  const installation = findInstallation();
  const process = listProcesses(installation.installLocation).find((item) => item.pid === runtime.codexPid && String(item.commandLine || "").includes("--remote-debugging-pipe"));
  if (!process) return false;
  await closeOwnedProcess(process.pid);
  launchNormal(installation.executablePath);
  return true;
}

export function findOfficialCodexInstallation({ run = powershellJson, exists = fileExists } = {}) {
  const packageInfo = run("$p = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1; if ($null -eq $p) { exit 3 }; [PSCustomObject]@{ InstallLocation=$p.InstallLocation; Version=$p.Version; PackageFullName=$p.PackageFullName; PackageFamilyName=$p.PackageFamilyName } | ConvertTo-Json -Compress");
  const installLocation = String(packageInfo?.InstallLocation || "");
  if (!installLocation) throw themedError("未找到官方 Codex 安装包。请先从 Microsoft Store 安装 Codex。", "codex_not_installed");
  const executablePath = [
    `${installLocation}\\app\\ChatGPT.exe`,
    `${installLocation}\\ChatGPT.exe`,
    `${installLocation}\\app\\Codex.exe`,
    `${installLocation}\\Codex.exe`,
  ].find(exists);
  if (!executablePath) throw themedError("已找到 Codex 安装包，但没有发现可启动的主程序。Codex 未做任何改动。", "codex_executable_missing");
  return { installLocation, executablePath, version: String(packageInfo.Version || "未知版本"), packageFullName: String(packageInfo.PackageFullName || ""), packageFamilyName: String(packageInfo.PackageFamilyName || "") };
}

export function listCodexProcesses(installLocation, { run = powershellJson } = {}) {
  if (!installLocation) return [];
  const encoded = Buffer.from(String(installLocation), "utf8").toString("base64");
  const script = "$root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')); @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [PSCustomObject]@{ Name=$_.Name; ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; ExecutablePath=$_.ExecutablePath; CommandLine=$_.CommandLine; MainWindowHandle=if($p){[Int64]$p.MainWindowHandle}else{0} } }) | ConvertTo-Json -Compress";
  const data = run(script, { empty: [] });
  const items = Array.isArray(data) ? data : data ? [data] : [];
  return items.map((item) => ({
    name: String(item.Name || ""),
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId) || null,
    mainWindowHandle: Number(item.MainWindowHandle) || 0,
    executablePath: String(item.ExecutablePath || ""),
    commandLine: String(item.CommandLine || ""),
  })).filter((item) => item.pid > 0 && item.executablePath);
}

export async function closeCodexWindows(processes, timeoutMs, { run = powershellJson, wait = delay, isAlive = processIsAlive } = {}) {
  const pids = [...new Set((processes || []).map((item) => Number(item.pid)).filter((pid) => pid > 0))];
  if (!pids.length) return true;
  const pidSet = new Set(pids);
  const appProcesses = (processes || []).filter((item) => String(item.name || "").toLowerCase() === "chatgpt.exe");
  const windowProcesses = appProcesses.filter((item) => Number(item.mainWindowHandle) > 0);
  const rootProcesses = appProcesses.filter((item) => !pidSet.has(Number(item.parentPid)));
  const tracked = windowProcesses.length ? windowProcesses : rootProcesses.length ? rootProcesses : appProcesses.length ? appProcesses : processes;
  const trackedPids = [...new Set(tracked.map((item) => Number(item.pid)).filter((pid) => pid > 0))];
  const closePids = [...new Set((windowProcesses.length ? windowProcesses : tracked).map((item) => Number(item.pid)).filter((pid) => pid > 0))];
  run("@(" + closePids.join(",") + ") | ForEach-Object { try { $p=Get-Process -Id $_ -ErrorAction Stop; [void]$p.CloseMainWindow() } catch {} }", { empty: null });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!trackedPids.some(isAlive)) return true;
    await wait(180);
  }
  return !trackedPids.some(isAlive);
}

export function launchThemedCodex(executablePath, { spawnProcess = spawn } = {}) {
  const child = spawnProcess(executablePath, ["--remote-debugging-pipe"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  if (!child?.pid || !child.stdio?.[3] || !child.stdio?.[4]) throw themedError("Codex 不支持受控主题会话；未启用不安全的调试端口。", "debug_pipe_unavailable");
  return child;
}

export function launchNormalCodex(executablePath, { spawnProcess = spawn } = {}) {
  const child = spawnProcess(executablePath, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref?.();
  return child.pid || null;
}

export function themeInjectionExpression(theme, css, heroDataUrl) {
  const config = {
    id: theme.id,
    name: theme.name,
    brand: theme.brand,
    signature: theme.signature,
    badge: theme.badge,
    headline: theme.headline,
    subheadline: theme.subheadline,
    cards: theme.cards,
    appearance: theme.appearance,
    art: theme.art,
    palette: theme.palette,
    artMetadata: theme.artMetadata,
  };
  return `(async () => {
    if (!document.documentElement) await new Promise((resolve) => addEventListener("DOMContentLoaded", resolve, { once: true }));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const shell = document.querySelector("main.main-surface");
      const sidebar = document.querySelector("aside.app-shell-left-panel");
      const composer = document.querySelector(".composer-surface-chrome");
      if (shell && sidebar && composer) return (${themeRuntimeBootstrap.toString()})(${JSON.stringify(config)}, ${JSON.stringify(css)}, ${JSON.stringify(heroDataUrl)});
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error("Codex 外观结构尚未在限定时间内准备完成。");
  })()`;
}

function themeHeroData(theme) {
  const cached = heroCache.get(theme.id);
  if (cached) return cached;
  const relative = String(theme.image || theme.preview || "").replace(/^[/\\]+/, "");
  const file = path.resolve(PUBLIC_DIRECTORY, relative);
  if (!file.startsWith(`${PUBLIC_DIRECTORY}${path.sep}`)) throw themedError("主题图片路径无效。", "theme_asset_invalid");
  let data;
  try { data = fs.readFileSync(file); }
  catch { throw themedError("主题图片缺失，Codex 未做任何改动。", "theme_asset_missing"); }
  const mime = themeAssetMime(data, path.extname(file));
  const url = `data:${mime};base64,${data.toString("base64")}`;
  heroCache.set(theme.id, url);
  return url;
}

export function themeAssetMime(data, extension = "") {
  if (data?.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data?.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data?.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const normalized = String(extension).toLowerCase();
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  if (normalized === ".webp") return "image/webp";
  return "image/png";
}

function legacyThemeRuntimeBootstrap(config, css, heroDataUrl) {
  const stateKey = "__CODEX_RELAY_THEME_STATE__";
  const styleId = "codex-relay-theme-style";
  const chromeId = "codex-relay-theme-chrome";
  const fallbackId = "codex-relay-theme-fallback-actions";
  const homeUtilityClass = "cr-theme-home-utility";
  const themeVersion = `${config.id}:4`;
  const previous = window[stateKey];
  if (
    previous?.themeVersion === themeVersion
    && window.__CODEX_RELAY_THEME_ID__ === config.id
    && typeof previous.ensure === "function"
    && typeof previous.snapshot === "function"
  ) {
    previous.metrics.healthChecks += 1;
    previous.ensure();
    return previous.snapshot();
  }
  window.__CODEX_RELAY_THEME_CLEANUP__?.();
  const comma = heroDataUrl.indexOf(",");
  const mime = /^data:([^;,]+)/.exec(heroDataUrl)?.[1] || "image/png";
  const binary = atob(heroDataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const artUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const scheduler = { timeout: null, refreshHome: false, refreshChrome: false };
  const metrics = { ensureRuns: 0, domRefreshes: 0, healthChecks: 0 };
  const structure = { mainSurface: null, sidebar: null, home: null };
  let observer = null;
  let timer = null;
  const findHome = () => document.querySelector('[role="main"]:has([data-feature="game-source"]), [role="main"]:has([data-testid="home-icon"])');

  const ensureStyle = () => {
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      style.dataset.owner = "codex-relay";
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.dataset.themeVersion !== themeVersion || style.textContent !== css) {
      style.textContent = css;
      style.dataset.themeVersion = themeVersion;
    }
  };

  const fillComposer = (prompt) => {
    const editor = document.querySelector('main.main-surface .ProseMirror[contenteditable="true"], main.main-surface [contenteditable="true"]');
    if (!editor) return;
    editor.focus();
    if (String(editor.textContent || "").trim()) return;
    const selection = window.getSelection();
    selection?.selectAllChildren(editor);
    const inserted = document.execCommand("insertText", false, prompt);
    if (!inserted) {
      editor.textContent = prompt;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    }
  };

  const ensureFallbackActions = (home) => {
    const native = home?.querySelector('[class*="home-suggestions"]');
    const nativeButtons = native?.querySelectorAll("button") || [];
    if (nativeButtons.length) {
      native.classList.add("cr-theme-native-actions");
      document.getElementById(fallbackId)?.remove();
      return "native";
    }
    native?.classList.remove("cr-theme-native-actions");
    const stage = home?.firstElementChild?.firstElementChild;
    if (!stage) return "missing";
    let actions = document.getElementById(fallbackId);
    if (actions?.parentElement !== stage) {
      actions?.remove();
      actions = document.createElement("div");
      actions.id = fallbackId;
      actions.className = "cr-theme-fallback-actions";
      const marks = ["✦", "→", "↗", "!"];
      config.cards.forEach(([titleText, description, prompt], index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cr-theme-fallback-action";
        const mark = document.createElement("span");
        mark.className = "cr-theme-fallback-action-mark";
        mark.textContent = marks[index] || "✦";
        mark.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = titleText;
        const small = document.createElement("small");
        small.textContent = description;
        text.append(strong, small);
        button.append(mark, text);
        button.addEventListener("click", () => fillComposer(prompt));
        actions.appendChild(button);
      });
      stage.appendChild(actions);
    }
    return "fallback";
  };

  const ensureChrome = (mainSurface, home) => {
    let chrome = document.getElementById(chromeId);
    if (!chrome || chrome.parentElement !== document.body) {
      chrome?.remove();
      chrome = document.createElement("div");
      chrome.id = chromeId;
      chrome.setAttribute("aria-hidden", "true");
      const brand = document.createElement("div");
      brand.className = "cr-theme-brand";
      const brandMark = document.createElement("span");
      brandMark.className = "cr-theme-brand-mark";
      brandMark.textContent = "E";
      const brandText = document.createElement("span");
      const brandName = document.createElement("b");
      brandName.textContent = config.brand;
      const brandSummary = document.createElement("small");
      brandSummary.textContent = "Codex 专属创作皮肤";
      brandText.append(brandName, brandSummary);
      brand.append(brandMark, brandText);

      const signature = document.createElement("div");
      signature.className = "cr-theme-signature";
      signature.textContent = config.signature;

      const confetti = document.createElement("div");
      confetti.className = "cr-theme-confetti";
      for (let index = 0; index < 5; index += 1) confetti.appendChild(document.createElement("i"));

      const energy = document.createElement("div");
      energy.className = "cr-theme-energy";
      energy.textContent = config.badge;
      chrome.append(brand, signature, confetti, energy);
      document.body.appendChild(chrome);
    }
    const box = mainSurface.getBoundingClientRect();
    chrome.style.left = `${Math.round(box.left)}px`;
    chrome.style.top = `${Math.round(box.top)}px`;
    chrome.style.width = `${Math.round(box.width)}px`;
    chrome.style.height = `${Math.round(box.height)}px`;
    chrome.classList.toggle("cr-theme-home-shell", Boolean(home));
  };

  const reconcileHome = (home, mainSurface) => {
    document.querySelectorAll(".cr-theme-home").forEach((element) => {
      if (element !== home) element.classList.remove("cr-theme-home");
    });
    document.querySelectorAll(".cr-theme-home-shell").forEach((element) => {
      if (element !== mainSurface) element.classList.remove("cr-theme-home-shell");
    });
    document.querySelectorAll(".cr-theme-native-actions").forEach((element) => {
      if (!home || !home.contains(element)) element.classList.remove("cr-theme-native-actions");
    });
    const utilityBars = new Set(home ? home.querySelectorAll('[class*="_homeUtilityBar_"]') : []);
    document.querySelectorAll(`.${homeUtilityClass}`).forEach((element) => {
      if (!utilityBars.has(element)) element.classList.remove(homeUtilityClass);
    });
    utilityBars.forEach((element) => element.classList.add(homeUtilityClass));
    mainSurface.classList.toggle("cr-theme-home-shell", Boolean(home));
    if (!home) {
      document.getElementById(fallbackId)?.remove();
    }
  };

  const clearThemeDom = () => {
    document.querySelectorAll(".cr-theme-home").forEach((element) => element.classList.remove("cr-theme-home"));
    document.querySelectorAll(".cr-theme-home-shell").forEach((element) => element.classList.remove("cr-theme-home-shell"));
    document.querySelectorAll(".cr-theme-native-actions").forEach((element) => element.classList.remove("cr-theme-native-actions"));
    document.querySelectorAll(`.${homeUtilityClass}`).forEach((element) => element.classList.remove(homeUtilityClass));
    document.getElementById(fallbackId)?.remove();
  };

  const ensure = ({ refreshHome = false, refreshChrome = false } = {}) => {
    metrics.ensureRuns += 1;
    const root = document.documentElement;
    const mainSurface = document.querySelector("main.main-surface");
    const sidebar = document.querySelector("aside.app-shell-left-panel");
    if (!root || !document.body || !mainSurface || !sidebar) return false;
    ensureStyle();
    root.classList.add("codex-relay-skin");
    root.dataset.codexRelayTheme = config.id;
    root.style.setProperty("--cr-theme-art", `url("${artUrl}")`);

    const home = findHome();
    const structureChanged = structure.mainSurface !== mainSurface || structure.sidebar !== sidebar || structure.home !== home;
    if (structureChanged || refreshHome) {
      metrics.domRefreshes += 1;
      reconcileHome(home, mainSurface);
      if (home) {
        home.classList.add("cr-theme-home");
        ensureFallbackActions(home);
      }
      structure.mainSurface = mainSurface;
      structure.sidebar = sidebar;
      structure.home = home;
    }
    if (structureChanged || refreshChrome || !document.getElementById(chromeId)) ensureChrome(mainSurface, home);
    return true;
  };

  const scheduleEnsure = (reason = "dom") => {
    scheduler.refreshHome ||= reason !== "resize";
    scheduler.refreshChrome ||= reason === "resize";
    if (scheduler.timeout) clearTimeout(scheduler.timeout);
    scheduler.timeout = setTimeout(() => {
      scheduler.timeout = null;
      const refreshHome = scheduler.refreshHome;
      const refreshChrome = scheduler.refreshChrome;
      scheduler.refreshHome = false;
      scheduler.refreshChrome = false;
      ensure({ refreshHome, refreshChrome });
    }, 90);
  };

  const relevantMutationSelector = '[role="main"], [data-feature="game-source"], [data-testid="home-icon"], [class*="home-suggestions"], .composer-surface-chrome';
  const containsRelevantNode = (node) => node?.nodeType === 1 && (node.matches?.(relevantMutationSelector) || node.querySelector?.(relevantMutationSelector));
  const mutationNeedsRefresh = (records) => records.some((record) => {
    const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
    if (!target?.closest) return false;
    if (target.closest(`#${chromeId}, #${fallbackId}`)) return false;
    if (target.closest('.composer-surface-chrome, [data-message-author-role], article')) return false;
    if (target.matches?.('[class*="home-suggestions"]')) return true;
    return [...record.addedNodes, ...record.removedNodes].some(containsRelevantNode);
  });

  const onResize = () => scheduleEnsure("resize");

  const snapshot = () => {
    const home = findHome();
    return {
      applied: true,
      themeId: config.id,
      markers: {
        shell: Boolean(document.querySelector("main.main-surface")),
        sidebar: Boolean(document.querySelector("aside.app-shell-left-panel")),
        composer: Boolean(document.querySelector(".composer-surface-chrome")),
        home: Boolean(home),
        hero: Boolean(home?.querySelector('[data-feature="game-source"]')),
        actions: home ? (document.getElementById(fallbackId) ? "fallback" : home.querySelector('[class*="home-suggestions"] button') ? "native" : "missing") : "deferred",
      },
      metrics: { ...metrics },
    };
  };

  const cleanup = () => {
    observer?.disconnect();
    if (timer) clearInterval(timer);
    if (scheduler.timeout) clearTimeout(scheduler.timeout);
    removeEventListener("resize", onResize);
    clearThemeDom();
    document.getElementById(styleId)?.remove();
    document.getElementById(chromeId)?.remove();
    document.documentElement?.classList.remove("codex-relay-skin");
    document.documentElement?.style.removeProperty("--cr-theme-art");
    delete document.documentElement?.dataset.codexRelayTheme;
    URL.revokeObjectURL(artUrl);
    delete window[stateKey];
    delete window.__CODEX_RELAY_THEME_ID__;
    delete window.__CODEX_RELAY_THEME_CLEANUP__;
    return true;
  };

  ensureStyle();
  if (!ensure({ refreshHome: true, refreshChrome: true })) throw new Error("Codex 外观结构尚未准备完成。");
  observer = new MutationObserver((records) => {
    if (mutationNeedsRefresh(records)) scheduleEnsure("dom");
  });
  observer.observe(document.body, { childList: true, subtree: true });
  timer = setInterval(() => ensure(), 5000);
  addEventListener("resize", onResize);
  window[stateKey] = { themeVersion, observer, timer, scheduler, artUrl, ensure, cleanup, snapshot, metrics };
  window.__CODEX_RELAY_THEME_ID__ = config.id;
  window.__CODEX_RELAY_THEME_CLEANUP__ = cleanup;
  return snapshot();
}

export function isCodexPageTarget(target, installLocation) {
  if (!target || target.type !== "page") return false;
  const url = String(target.url || "");
  if (/^(app|codex):\/\//i.test(url)) return true;
  if (!/^file:\/\//i.test(url)) return false;
  const decoded = decodeURIComponent(url.replace(/^file:\/+/i, "").replaceAll("/", "\\"));
  return decoded.toLowerCase().startsWith(String(installLocation || "").toLowerCase());
}

export async function waitForCodexTarget(pipe, installLocation, { timeoutMs = STARTUP_TIMEOUT_MS, wait = delay } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await pipe.send("Target.getTargets");
      const target = (result.targetInfos || []).find((item) => isCodexPageTarget(item, installLocation));
      if (target) return target;
    } catch (error) { lastError = error; }
    await wait(220);
  }
  throw themedError(lastError ? `Codex 未建立可验证的主题页面：${lastError.message}` : "Codex 未建立可验证的主题页面。", "codex_target_unavailable");
}

async function attachedSessionId(session, targetId) {
  if (session.sessionId && session.attachedTargetId === targetId) return session.sessionId;
  const result = await session.pipe.send("Target.attachToTarget", { targetId, flatten: true });
  if (!result?.sessionId) throw themedError("Codex 未提供可控制的主题页面会话。", "codex_attach_failed");
  session.sessionId = result.sessionId;
  session.attachedTargetId = targetId;
  return result.sessionId;
}

export class DevToolsPipe {
  constructor(child) {
    this.input = child?.stdio?.[4];
    this.output = child?.stdio?.[3];
    if (!this.input || !this.output) throw themedError("Codex 未提供安全调试管道。", "debug_pipe_unavailable");
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.input.on("data", (chunk) => this.onData(chunk));
    this.input.once("error", (error) => this.failAll(error));
    this.input.once("close", () => this.failAll(themedError("Codex 调试会话已关闭。", "debug_pipe_closed")));
  }

  send(method, params = {}, sessionId = null) {
    if (this.closed) return Promise.reject(themedError("Codex 调试会话已关闭。", "debug_pipe_closed"));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const frame = Buffer.from(`${JSON.stringify(payload)}\0`, "utf8");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(themedError(`Codex 未在限定时间内响应 ${method}。`, "debug_pipe_timeout"));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.output.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length) {
      const delimiter = this.buffer.indexOf(0);
      if (delimiter < 0) {
        if (this.buffer.length > 8 * 1024 * 1024) this.failAll(themedError("Codex 调试响应异常过大。", "debug_pipe_invalid"));
        return;
      }
      const raw = this.buffer.subarray(0, delimiter).toString("utf8");
      this.buffer = this.buffer.subarray(delimiter + 1);
      let message;
      try { message = JSON.parse(raw); } catch { continue; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(themedError(message.error.message || "Codex 拒绝主题请求。", "debug_protocol_error"));
      else pending.resolve(message.result || {});
    }
  }

  failAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.input.destroy();
    this.output.end();
    this.failAll(themedError("Codex 调试会话已关闭。", "debug_pipe_closed"));
  }
}

async function closeOwnedProcess(pid) {
  if (!processIsAlive(pid)) return;
  try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T"], { windowsHide: true, timeout: 5_000, stdio: "ignore" }); } catch { /* Retry below after the graceful request. */ }
  const deadline = Date.now() + 4_000;
  while (processIsAlive(pid) && Date.now() < deadline) await delay(150);
  if (processIsAlive(pid)) execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, stdio: "ignore" });
}

function powershellJson(script, { empty = null } = {}) {
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); " + script], { encoding: "utf8", windowsHide: true, timeout: 8_000 });
    if (!String(output).trim()) return empty;
    return JSON.parse(output);
  } catch (error) {
    if (error.status === 3) throw themedError("未找到官方 Codex 安装包。请先从 Microsoft Store 安装 Codex。", "codex_not_installed");
    throw themedError("无法读取本机 Codex 安装信息。Codex 未做任何改动。", "codex_inspection_failed");
  }
}

function fileExists(file) {
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Test-Path -LiteralPath '${String(file).replaceAll("'", "''")}'`], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    return /^True$/i.test(String(output).trim());
  } catch { return false; }
}
function processIsAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function themedError(message, code) { const error = new Error(message); error.code = code; return error; }
function friendlyError(error) { return String(error?.message || "主题会话未能启动，Codex 未被修改。").slice(0, 500); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

if (process.env.CODEX_RELAY_THEME_AGENT === "1") {
  runThemeAgent().catch((error) => {
    try { updateThemeRuntime({ status: "error", message: friendlyError(error), agentPid: null }); } catch { /* nothing else can be recovered here */ }
    process.exitCode = 1;
  });
}
