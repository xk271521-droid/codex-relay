import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-test-"));
process.env.CODEX_RELAY_HOME = path.join(sandbox, "relay-data");
process.env.CODEX_HOME = path.join(sandbox, "codex-home");
process.env.CODEX_RELAY_DISABLE_EXTERNAL_PROCESS_CONTROL = "1";

const { activeRoutes, buildModelCatalog } = await import("../src/catalog.js");
const { THIRD_PARTY_SLOT_IDS } = await import("../src/constants.js");
const { detectCodexClientVersion, parseCodexClientVersion } = await import("../src/codex-version.js");
const { browserUseEnvironment, resetBrowserUseStatusCache } = await import("../src/browser-use-status.js");
const { computerUseEnvironment, resetComputerUseStatusCache } = await import("../src/computer-use-status.js");
const { fetchOfficialModels, parseOfficialModels } = await import("../src/official-models.js");
const { OFFICIAL_USAGE_ENDPOINT, fetchOfficialUsage, fetchOfficialUsageWithTimeout, normalizePlanType, parseOfficialUsage } = await import("../src/official-usage.js");
const { classifyIntegrationProcesses, closeCcSwitchForHandoff, parseTaskListCsv, reopenCcSwitchAfterRollback } = await import("../src/external-processes.js");
const store = await import("../src/store.js");
const contextCache = await import("../src/context-cache.js");
const compactCapabilityPersistence = await import("../src/compact-capability-persistence.js");
const { fetchOfficial, proxyForHttps } = await import("../src/official-fetch.js");
const { fetchProvider, normalizeProviderProxyUrl, providerNetworkMode, resolveProviderProxy } = await import("../src/provider-fetch.js");
const { classifyNativeCompactHttpResult, classifyNativeCompactTransportError, validateNativeCompactPayload } = await import("../src/native-compact-contract.js");
const { clearCompactCapabilityProfiles, compactCapabilityStatus, compactCapabilityTarget, COMPACT_CAPABILITY_PROFILE_VERSION, recordCompactCapability } = await import("../src/compact-capabilities.js");
const { resolveModelCapability } = await import("../src/model-capabilities.js");
const { buildPerformanceBaseline } = await import("../src/performance-baseline.js");
const { classifyPreviousResponseRejection, createChatHistory, forwardOfficialImageEdit, forwardOfficialImageGeneration, forwardResponses, forwardResponsesCompact, providerCompactEndpoint, recordPassthroughResponse, responseContextMode, responseDiagnostics, responseHistoryInfo, routeForRequest } = await import("../src/router.js");
const { attachResponsesWebSocket, waitForWebSocketCapacity } = await import("../src/responses-websocket.js");
const { classifyContextPressure, classifyStreamingResponse, createRelayServer: createRawRelayServer, ensureCodexClosedForRestore, normalizeUsage, officialSessionAvailable, officialUpstreamFailure, onboardingState, pipeEventStream, resetModelHealthForTests } = await import("../src/server.js");
const { createArchivePathRepairMonitor, runArchivePathRepairWorker } = await import("../src/archive-path-repair-monitor.js");
const { readJsonRequest, RESPONSES_BODY_LIMIT_BYTES } = await import("../src/request-body.js");
const requestHistory = await import("../src/request-history.js");
const { localUsageDayKey } = await import("../src/usage-statistics.js");
const historyMigration = await import("../src/session-history.js");
const { DatabaseSync } = await import("node:sqlite");
const { themeCatalog, themeById, themeCss } = await import("../src/theme-catalog.js");
const { closeCodexWindows, ensureThemeInjected, findOfficialCodexInstallation, injectTheme, themeAssetMime, themeInjectionExpression, themeRuntimeBootstrap } = await import("../src/theme-agent.js");
const { runProbePlan } = await import("../scripts/s3f-native-continuation-probe.mjs");

function settings(overrides = {}) {
  return {
    version: 1,
    router: { host: "127.0.0.1", port: 15723, running: false },
    official: { verified: false, lastCheckedAt: null },
    contextCache: { persist: false },
    deepSeekSavings: { enabled: false },
    providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: "http://127.0.0.1:19999/v1", apiType: "chat_completions", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "DeepSeek V4", providerId: "deepseek", upstreamModel: "deepseek-v4", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    ...overrides,
  };
}

function settingsForOfficialRoute() {
  return settings({
    official: { verified: true, lastCheckedAt: "2026-07-12T00:00:00.000Z" },
    providers: [],
    thirdPartySlots: [],
  });
}

function resetTestState() {
  resetModelHealthForTests();
  compactCapabilityPersistence.resetCompactCapabilityPersistenceForTests();
  fs.rmSync(store.paths().appDir, { recursive: true, force: true });
  if (fs.existsSync(store.paths().codexConfig)) fs.rmSync(store.paths().codexConfig, { force: true });
  if (fs.existsSync(store.paths().codexAuth)) fs.rmSync(store.paths().codexAuth, { force: true });
  fs.rmSync(path.join(path.dirname(store.paths().codexConfig), "sessions"), { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(store.paths().codexConfig), "archived_sessions"), { recursive: true, force: true });
  for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
    fs.rmSync(path.join(path.dirname(store.paths().codexConfig), name), { force: true });
  }
}

function assertCheckpointPrompt(value) {
  assert.match(value, /You are creating a CONTEXT CHECKPOINT for another model/);
  assert.match(value, /Files, exact paths, commands, tests, errors, and verified results/);
  assert.match(value, /Do not invent missing facts, hidden reasoning, credentials, API keys, access tokens, or response IDs/);
}

function createRelayServer(options = {}) {
  return createRawRelayServer(options);
}

async function waitForModelHealth(baseUrl, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/model-health`);
    const result = await response.json();
    if (!result.running) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Model health refresh did not finish in time.");
}

test("theme catalog exposes independently selectable visual presets", () => {
  const themes = themeCatalog();
  assert.deepEqual(themes.map((theme) => theme.id), ["inspiration-notes", "inspiration-scrapbook"]);
  assert.equal(themeById("inspiration-notes").name, "ENFP 灵感版");
  assert.equal(themeById("inspiration-scrapbook").name, "ENFP 灵感手帐");
  assert.ok(themes.every((theme) => theme.preview.startsWith("/themes/") && theme.cards.length === 4));
  assert.equal(themeById("inspiration-notes").image, "/themes/enfp-fresh-background.webp");
  assert.equal(themeById("inspiration-scrapbook").image, "/themes/inspiration-scrapbook-background.webp");
  assert.equal(themeById("inspiration-notes").appearance, "light");
  assert.equal(themeById("inspiration-scrapbook").appearance, "light");
  assert.equal(themeById("inspiration-notes").art.safeArea, "left");
  assert.match(themeCss("inspiration-notes"), /data-feature="game-source"/);
  assert.match(themeCss("inspiration-notes"), /cr-theme-fallback-actions/);
  assert.match(themeCss("inspiration-notes"), /cr-theme-art-wide/);
  assert.match(themeCss("inspiration-notes"), /cr-theme-task/);
  assert.match(themeCss("inspiration-notes"), /--cr-theme-task-text/);
  assert.match(themeCss("inspiration-notes"), /main\.main-surface:not\(\.cr-theme-home-shell\) \[role="main"\]/);
  assert.match(themeCss("inspiration-notes"), /button\[class\*="text-token-text-tertiary"\]/);
  assert.match(themeCss("inspiration-notes"), /_markdownText_/);
  assert.match(themeCss("inspiration-notes"), /_cadencedShimmerHighlight_/);
  assert.match(themeCss("inspiration-notes"), /data-thread-title/);
  assert.match(themeCss("inspiration-notes"), /text-token-text-primary/);
  assert.match(themeCss("inspiration-notes"), /cr-theme-home.*home-suggestions/s);
  assert.match(themeCss("inspiration-notes"), /composer-surface-chrome/);
  assert.doesNotMatch(themeCss("inspiration-notes"), /cr-theme-native-actions\s*\{\s*display:\s*none/);
  assert.doesNotMatch(themeCss("inspiration-notes"), /html\.codex-relay-skin \[class\*="text-token-text"\]/);
  assert.match(themeCss("inspiration-scrapbook"), /cr-scrapbook-card/);
});

test("theme assets are typed from their bytes instead of a misleading extension", () => {
  assert.equal(themeAssetMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), ".png"), "image/jpeg");
  assert.equal(themeAssetMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ".jpg"), "image/png");
  assert.equal(themeAssetMime(Buffer.from("RIFF0000WEBP"), ".png"), "image/webp");
  const art = fs.readFileSync(path.resolve("public/themes/enfp-fresh-background.webp"));
  assert.equal(themeAssetMime(art, ".webp"), "image/webp");
  assert.ok(art.length > 50_000);
  const scrapbookArt = fs.readFileSync(path.resolve("public/themes/inspiration-scrapbook-background.webp"));
  assert.equal(themeAssetMime(scrapbookArt, ".webp"), "image/webp");
  assert.ok(scrapbookArt.length > 10_000);
});

test("theme runtime reconciles without deleting the active home on every mutation", () => {
  const source = themeRuntimeBootstrap.toString();
  assert.match(source, /dataset\.themeVersion/);
  assert.match(source, /previous\?\.themeVersion === themeVersion/);
  assert.match(source, /reconcileHome\(home, mainSurface\)/);
  assert.doesNotMatch(source, /clearHome\(\);\s*if \(home\)/);
  assert.doesNotMatch(source, /home\.querySelectorAll\("\*"\)/);
  assert.match(source, /const analyzeArt/);
  assert.match(source, /const applyProfile/);
  assert.match(source, /observer\.observe\(document\.documentElement/);
  assert.match(source, /composer-surface-chrome, \[data-message-author-role\], article/);
  assert.match(source, /URL\.revokeObjectURL\(artUrl\)/);
  assert.match(source, /delete window\.__CODEX_RELAY_THEME_CLEANUP__/);
  const expression = themeInjectionExpression(themeById("inspiration-notes"), themeCss("inspiration-notes"), "data:image/jpeg;base64,/9j/");
  assert.match(expression, /ENFP 灵感发动机/);
  assert.match(expression, /data:image\/jpeg/);
  assert.match(expression, /main\.main-surface/);
  assert.match(expression, /composer-surface-chrome/);
  assert.match(expression, /Date\.now\(\) \+ 20000/);
});

test("theme health check reuses a verified runtime instead of reinjecting it", async () => {
  let injections = 0;
  const session = {
    sessionId: "session-1",
    attachedTargetId: "target-1",
    target: { targetId: "target-1" },
    themeId: "inspiration-notes",
    pipe: { send: async () => ({ result: { value: true } }) },
  };
  const reused = await ensureThemeInjected(session, "inspiration-notes", { inject: async () => { injections += 1; } });
  assert.deepEqual(reused, { installed: true, reinjected: false });
  assert.equal(injections, 0);

  session.pipe.send = async () => ({ result: { value: false } });
  const restored = await ensureThemeInjected(session, "inspiration-notes", { inject: async () => { injections += 1; } });
  assert.deepEqual(restored, { installed: false, reinjected: true });
  assert.equal(injections, 1);
});

test("management UI wires theme selection, apply, and restore", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /data-view="themes"/);
  assert.match(app, /function renderThemes\(/);
  assert.match(app, /\/api\/themes\/select/);
  assert.match(app, /\/api\/themes\/apply/);
  assert.match(app, /\/api\/themes\/restore/);
  assert.match(app, /\$\("\.top-actions"\)\.hidden = view === "themes"/);
});

test("theme launcher discovers the current Appx app executable", () => {
  const installation = findOfficialCodexInstallation({
    run: () => ({
      InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test",
      Version: "26.707.12708.0",
      PackageFullName: "OpenAI.Codex_test",
      PackageFamilyName: "OpenAI.Codex_test_family",
    }),
    exists: (file) => file === "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe",
  });
  assert.equal(installation.executablePath, "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe");
  assert.equal(installation.version, "26.707.12708.0");
});

test("theme shutdown waits for the Codex main process instead of lingering helpers", async () => {
  const alive = new Set([10, 11, 12]);
  const commands = [];
  const closed = await closeCodexWindows([
    { name: "ChatGPT.exe", pid: 10, parentPid: 99, mainWindowHandle: 123 },
    { name: "ChatGPT.exe", pid: 11, parentPid: 10, mainWindowHandle: 0 },
    { name: "codex.exe", pid: 12, parentPid: 10, mainWindowHandle: 0 },
  ], 500, {
    run: (command) => { commands.push(command); alive.delete(10); },
    wait: async () => {},
    isAlive: (pid) => alive.has(pid),
  });
  assert.equal(closed, true);
  assert.match(commands[0], /@\(10\)/);
  assert.doesNotMatch(commands[0], /11|12/);
  assert.deepEqual([...alive].sort(), [11, 12]);
});

test("theme injection attaches to the renderer and verifies the applied marker", async () => {
  const calls = [];
  const session = {
    target: { targetId: "page-1", type: "page", url: "app://codex/index.html" },
    installation: { installLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test" },
    pipe: {
      send: async (method, params, sessionId) => {
        calls.push({ method, params, sessionId });
        if (method === "Target.attachToTarget") return { sessionId: "renderer-session" };
        if (method === "Runtime.evaluate") return { result: { value: { applied: true, themeId: "inspiration-notes" } } };
        return {};
      },
    },
  };
  await injectTheme(session, "inspiration-notes");
  assert.equal(session.sessionId, "renderer-session");
  assert.equal(session.themeId, "inspiration-notes");
  assert.deepEqual(calls.map((call) => call.method), ["Target.attachToTarget", "Runtime.evaluate"]);
  assert.equal(calls[1].sessionId, "renderer-session");
});

test("theme UI follows the background operation through success or error", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function monitorThemeRuntime\(operation\)/);
  assert.match(app, /status === "error"/);
  assert.match(app, /operation === "apply" && status === "applied"/);
  assert.match(app, /operation === "restore" && status === "idle"/);
});

test("management UI exposes consistent async loading feedback", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8");

  assert.match(html, /class="mode-icon loading" id="mode-icon"><i data-lucide="loader-circle"/);
  assert.equal((html.match(/class="switch-loader"/g) || []).length, 3);
  assert.match(app, /button\.setAttribute\("aria-busy", "true"\)/);
  assert.match(app, /input\.setAttribute\("aria-busy", "true"\)/);
  for (const functionName of ["deleteSlot", "deleteProvider", "openApplyDialog", "openRestoreDialog", "checkSessions", "openDataFolder"]) {
    assert.match(app, new RegExp(`async function ${functionName}\\([^)]*\\) \\{[\\s\\S]*?setButtonLoading\\(button, true`));
  }
  for (const functionName of ["saveContextCachePreference", "saveDeepSeekSavingsPreference", "setLaunchAtLogin"]) {
    assert.match(app, new RegExp(`async function ${functionName}\\([^)]*\\) \\{[\\s\\S]*?setControlLoading\\(event\\.target, true`));
  }
  assert.match(app, /if \(!silent\) setButtonLoading\(button, true\)/);
  assert.match(app, /DeepSeek 前缀稳定/);
  assert.match(app, /上游未返回缓存命中明细/);
  assert.match(html, /id="context-advisory"[^>]*aria-live="polite"/);
  assert.match(app, /function renderContextAdvisory\(events\)/);
  assert.match(app, /未使用响应 ID 原生续接/);
  assert.doesNotMatch(app, /本地保护，未请求上游/);
  assert.doesNotMatch(app, /已停止同一次发送的 502 自动重试/);
  assert.match(app, /function diagnosticUpstreamAttempts\(diagnostics\)/);
  assert.match(app, /function formatBytes\(value\)/);
  assert.match(app, /function providerCompactPresentation\(provider\)/);
  assert.match(app, /function compactEventBadge\(event\)/);
  for (const label of ["原生 Compact", "兼容摘要", "便携压缩", "临时熔断", "自动检测", "已支持", "不支持", "临时不可用"]) assert.match(app, new RegExp(label));
  assert.match(html, /id="refresh-request-history"[^>]*aria-label="刷新请求记录"/);
  assert.match(html, /id="delete-request-history"[^>]*aria-label="删除全部请求记录"/);
  assert.ok(html.indexOf('data-view="safety"') < html.indexOf('data-view="monitoring"'));
  assert.ok(html.indexOf('data-view="monitoring"') < html.indexOf('data-view="themes"'));
  assert.match(html, /id="refresh-usage-statistics"[^>]*aria-label="刷新监控数据"/);
  assert.match(html, /id="model-health-interval"[^>]*aria-label="第三方模型自动连接检测频率"/);
  assert.match(html, /id="refresh-model-health"[^>]*aria-label="立即检测全部第三方模型"/);
  assert.match(html, /<option value="0" selected>自动检测：关闭<\/option>/);
  assert.doesNotMatch(html, /<option value="30" selected>/);
  for (const interval of ["15", "30", "60"]) assert.match(html, new RegExp(`<option value="${interval}"`));
  assert.match(app, /function modelHealthPresentation\(entry, threshold = 3_000\)/);
  assert.match(app, /async function refreshModelHealth\(\{ silent = true \} = \{\}\)/);
  assert.match(app, /source: "recent_request"|recent_request: "最近真实请求"/);
  assert.doesNotMatch(app, /if \(view === "models"\) scheduleModelHealthRefresh/);
  assert.doesNotMatch(app, /visibilitychange", handleModelHealthVisibility/);
  assert.match(app, /scheduleModelHealthRefresh\(\{ fromNow: true \}\)/);
  assert.match(app, /if \(value === 30\) \{\s*localStorage\.setItem\(MODEL_HEALTH_INTERVAL_KEY, "0"\);\s*return 0;/);
  assert.match(app, /function startThirdPartyInFlightPolling\(\)/);
  assert.match(app, /api\("\/api\/third-party-inflight"\)/);
  assert.match(app, /const completedAt = Date\.parse\(state\.data\.modelHealth\?\.completedAt/);
  assert.match(css, /\.model-health-state\.good \{[^}]*var\(--success\)/);
  assert.match(css, /\.model-health-state\.slow \{[^}]*var\(--warning\)/);
  assert.match(css, /\.model-health-state\.bad \{[^}]*var\(--danger\)/);
  for (const id of ["monitor-today-requests", "monitor-today-token", "monitor-total-token", "monitor-cache-hit", "monitor-provider-list", "monitor-token-donut", "monitor-model-list"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="delete-request-history-dialog"/);
  assert.match(html, /最多保留最近 10,000 条/);
  assert.match(html, /请求记录、对话、插件、Relay 供应商/);
  assert.match(app, /async function refreshRequestHistory\(event\)/);
  assert.match(app, /async function refreshUsageStatistics\(event\)/);
  assert.match(app, /function renderProviderUsage\(providers\)/);
  assert.match(app, /function renderModelDistribution\(models\)/);
  assert.match(app, /上游未返回 usage/);
  assert.match(app, /async function deleteRequestHistory\(event\)/);
  assert.match(css, /\.context-advisory\.high/);
  assert.match(css, /\.loading-spinner \{[^}]*animation: spin 700ms linear infinite/);
  assert.match(css, /\.token-donut \{[^}]*aspect-ratio: 1/);
  assert.match(css, /\.monitor-provider-row \{[^}]*grid-template-columns:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("safety page provides a version-aware Computer Use repair handoff", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

  const launchRow = html.indexOf('id="launch-at-login"');
  const repairRow = html.indexOf('id="copy-computer-use-prompt"');
  const browserRepairRow = html.indexOf('id="check-browser-use"');
  const dataRow = html.indexOf('id="data-directory"');
  assert.ok(launchRow >= 0 && repairRow > launchRow && browserRepairRow > repairRow && dataRow > browserRepairRow);
  assert.match(html, /id="download-computer-use-guide"/);
  assert.match(html, /id="copy-browser-use-prompt"/);
  assert.match(html, /id="download-browser-use-guide"/);
  assert.match(html, /id="browser-diagnostic-result"/);
  assert.match(html, /查看本次验证过的修复过程/);
  assert.match(html, /id="persist-context"[^>]*aria-label="重启后保留跨模型上下文"/);
  assert.match(html, /id="deepseek-savings"[^>]*aria-label="启用 DeepSeek 省钱模式"/);
  assert.match(app, /async function saveDeepSeekSavingsPreference\(event\)/);
  assert.match(html, /id="launch-at-login"[^>]*aria-label="登录 Windows 后自动启动"/);
  assert.doesNotMatch(html, />重启后保留</);
  assert.doesNotMatch(html, />自动启动</);
  assert.match(app, /const computerUseRepairPrompt = String\.raw`[\s\S]*动态识别当前 Codex 安装版本/);
  assert.match(app, /computer-use native pipe/);
  assert.match(app, /manifest\.json、bin\/node\.exe、bin\/node_repl\.exe/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /new Blob\(\[computerUseRepairPrompt\]/);
  assert.match(app, /const browserUseRepairPrompt = String\.raw`[\s\S]*failed to resolve rollout path/);
  assert.match(app, /new Blob\(\[browserUseRepairPrompt\]/);
  assert.match(app, /api\("\/api\/browser-use-status"\)/);
  assert.match(server, /url\.pathname === "\/api\/browser-use-status"/);
  assert.doesNotMatch(app, /OpenAI\.Codex_\d/);
  assert.doesNotMatch(app, /C:\\\\Users\\\\xk/);
  assert.match(css, /\.repair-actions \{[^}]*display: flex/);
  assert.match(css, /\.repair-process\[open\] summary svg/);
  assert.match(css, /\.diagnostic-list li\.ok > span/);
});

test("safety page keeps its route explanation, action hierarchy, and reduced-motion fallback", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8");

  assert.match(html, /class="safety-route-list"/);
  assert.match(html, /class="safety-action-grid"/);
  assert.match(html, /id="restore-button"[\s\S]*id="official-direct-button"/);
  assert.match(css, /\.safety-route-list \{[^}]*grid-template-columns: repeat\(3/);
  assert.match(css, /\.safety-route-step \{[^}]*min-height: 64px/);
  assert.match(css, /\.safety-action-grid \{[^}]*grid-template-columns:/);
  assert.match(css, /\.safety-restore \{[^}]*grid-template-columns: 40px minmax\(0, 1fr\) auto/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.safety-route-step/);
});

test("Windows proxy parsing follows the current HTTPS or HTTP system endpoint", () => {
  assert.equal(proxyForHttps("127.0.0.1:7897"), "http://127.0.0.1:7897/");
  assert.equal(proxyForHttps("http=127.0.0.1:7897;https=127.0.0.1:7898"), "http://127.0.0.1:7898/");
  assert.equal(proxyForHttps("socks=127.0.0.1:7897"), "");
});

test("provider editor exposes isolated direct, Windows, and custom proxy modes", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(process.cwd(), "public", "app.js"), "utf8");
  assert.match(html, /id="provider-network"[\s\S]*value="direct"[\s\S]*value="windows"[\s\S]*value="custom"/);
  assert.match(html, /id="provider-proxy-url"[^>]*placeholder="http:\/\/127\.0\.0\.1:7897"/);
  assert.match(app, /function syncProviderNetworkFields\(\)/);
  assert.match(app, /networkMode: \$\("#provider-network"\)\.value/);
  assert.match(app, /不会先直连失败后再重复发送/);
});

test("third-party network modes resolve per provider and custom proxy failures never fall back to direct", async () => {
  resetTestState();
  assert.equal(providerNetworkMode({}), "direct");
  assert.equal(providerNetworkMode({ networkMode: "windows" }), "windows");
  assert.equal(providerNetworkMode({ networkMode: "unknown" }), "direct");
  assert.equal(normalizeProviderProxyUrl("127.0.0.1:7897"), "http://127.0.0.1:7897/");
  assert.equal(normalizeProviderProxyUrl("http://user:secret@127.0.0.1:7897"), "");
  assert.equal(await resolveProviderProxy({ networkMode: "windows" }, "127.0.0.1:7897"), "http://127.0.0.1:7897/");
  const normalized = store.replaceSettings(settings({
    providers: [
      { id: "legacy-direct", name: "Legacy", baseUrl: "https://legacy.example/v1", apiType: "responses" },
      { id: "windows-route", name: "Windows", baseUrl: "https://windows.example/v1", apiType: "responses", networkMode: "windows", proxyUrl: "http://ignored.example" },
      { id: "custom-route", name: "Custom", baseUrl: "https://custom.example/v1", apiType: "responses", networkMode: "custom", proxyUrl: "127.0.0.1:7897" },
    ],
    thirdPartySlots: [],
  }));
  assert.deepEqual(normalized.providers.map((provider) => [provider.networkMode, provider.proxyUrl]), [
    ["direct", ""],
    ["windows", ""],
    ["custom", "http://127.0.0.1:7897/"],
  ]);

  const proxyRequests = [];
  const proxy = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    proxyRequests.push({ url: request.url, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetchProvider({ networkMode: "custom", proxyUrl: `http://127.0.0.1:${proxy.address().port}` }, "http://unreachable.invalid/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "proxy-test" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(proxyRequests, [{ url: "http://unreachable.invalid/v1/responses", body: JSON.stringify({ model: "proxy-test" }) }]);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }

  let directRequests = 0;
  const target = http.createServer((_request, response) => {
    directRequests += 1;
    response.end("unexpected direct request");
  });
  const closedProxy = http.createServer();
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => closedProxy.listen(0, "127.0.0.1", resolve));
  const closedProxyPort = closedProxy.address().port;
  await new Promise((resolve) => closedProxy.close(resolve));
  try {
    await assert.rejects(fetchProvider({ networkMode: "custom", proxyUrl: `http://127.0.0.1:${closedProxyPort}` }, `http://127.0.0.1:${target.address().port}/v1/responses`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(2_000),
    }));
    assert.equal(directRequests, 0);
  } finally {
    await new Promise((resolve) => target.close(resolve));
  }
});

test("cancelling a proxied provider request closes the proxy connection", async () => {
  let requestSeen;
  let connectionClosed;
  const seen = new Promise((resolve) => { requestSeen = resolve; });
  const closed = new Promise((resolve) => { connectionClosed = resolve; });
  const proxy = http.createServer((request) => {
    requestSeen();
    request.socket.once("close", connectionClosed);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  try {
    const pending = fetchProvider({ networkMode: "custom", proxyUrl: `http://127.0.0.1:${proxy.address().port}` }, "http://unreachable.invalid/v1/responses", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });
    await seen;
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Proxy connection did not close after cancellation.")), 1_000))]);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("provider network settings save independently without clearing keys or changing other providers", async () => {
  resetTestState();
  store.replaceSettings(settings({
    providers: [
      { id: "chenhi", name: "Chenhi", baseUrl: "https://chenhi.example/v1", apiType: "responses" },
      { id: "blue", name: "Blue", baseUrl: "https://blue.example/v1", apiType: "responses" },
    ],
    thirdPartySlots: [],
  }));
  store.saveProviderKey("chenhi", "chenhi-secret");
  store.saveProviderKey("blue", "blue-secret");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const save = (body) => fetch(`http://127.0.0.1:${relay.address().port}/api/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const windows = await save({ id: "chenhi", name: "Chenhi", baseUrl: "https://chenhi.example/v1", apiType: "responses", networkMode: "windows" });
    assert.equal(windows.status, 200);
    let providers = store.loadSettings().providers;
    assert.deepEqual(providers.map((provider) => [provider.id, provider.networkMode, provider.proxyUrl]), [
      ["chenhi", "windows", ""],
      ["blue", "direct", ""],
    ]);
    assert.equal(store.hasProviderKey("chenhi"), true);
    assert.equal(store.hasProviderKey("blue"), true);

    const custom = await save({ id: "chenhi", name: "Chenhi", baseUrl: "https://chenhi.example/v1", apiType: "responses", networkMode: "custom", proxyUrl: "127.0.0.1:7897" });
    assert.equal(custom.status, 200);
    providers = store.loadSettings().providers;
    assert.equal(providers[0].networkMode, "custom");
    assert.equal(providers[0].proxyUrl, "http://127.0.0.1:7897/");
    assert.equal(store.hasProviderKey("chenhi"), true);

    for (const proxyUrl of ["http://user:secret@127.0.0.1:7897", "socks5://127.0.0.1:7897"]) {
      const rejected = await save({ id: "chenhi", name: "Chenhi", baseUrl: "https://chenhi.example/v1", apiType: "responses", networkMode: "custom", proxyUrl });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "provider_proxy_invalid");
    }
    providers = store.loadSettings().providers;
    assert.equal(providers[0].networkMode, "custom");
    assert.equal(providers[0].proxyUrl, "http://127.0.0.1:7897/");
    assert.equal(providers[1].networkMode, "direct");
    assert.equal(store.hasProviderKey("chenhi"), true);
    assert.equal(store.hasProviderKey("blue"), true);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("third-party Responses, Chat, and Compact share one provider proxy path", async () => {
  resetTestState();
  const proxyRequests = [];
  const proxy = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const target = new URL(request.url);
    proxyRequests.push({ path: target.pathname, authorization: request.headers.authorization, model: body.model });
    response.writeHead(200, { "content-type": "application/json" });
    if (target.pathname === "/v1/responses/compact") {
      response.end(JSON.stringify({
        id: "resp_proxy_compact",
        object: "response.compaction",
        status: "completed",
        model: body.model,
        output: [{ type: "compaction", encrypted_content: "proxy-compact-content" }],
      }));
      return;
    }
    if (target.pathname === "/v1/chat/completions") {
      response.end(JSON.stringify({
        id: "chatcmpl_proxy",
        choices: [{ message: { role: "assistant", content: "CHAT_PROXY_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
      return;
    }
    response.end(JSON.stringify({
      id: "resp_proxy",
      object: "response",
      status: "completed",
      model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "RESPONSES_PROXY_OK" }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const providers = [
    { id: "proxy-responses", name: "Proxy Responses", baseUrl: "http://responses.invalid/v1", apiType: "responses", networkMode: "custom", proxyUrl },
    { id: "proxy-chat", name: "Proxy Chat", baseUrl: "http://chat.invalid/v1", apiType: "chat_completions", networkMode: "custom", proxyUrl },
  ];
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers,
    thirdPartySlots: [
      { id: "relay-third-party-1", displayName: "Proxy Responses", providerId: "proxy-responses", upstreamModel: "gpt-proxy", contextWindow: 128000, supportsImages: false, dropParams: [] },
      { id: "relay-third-party-2", displayName: "Proxy Chat", providerId: "proxy-chat", upstreamModel: "chat-proxy", contextWindow: 128000, supportsImages: false, dropParams: [] },
    ],
  }));
  store.saveProviderKey("proxy-responses", "responses-proxy-key");
  store.saveProviderKey("proxy-chat", "chat-proxy-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayUrl = `http://127.0.0.1:${relay.address().port}/v1`;
  const invoke = (pathName, body) => fetch(`${relayUrl}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const responses = await invoke("/responses", { model: "relay-third-party-1", input: "hello", stream: false });
    const responsesBody = await responses.json();
    assert.equal(responses.status, 200);
    assert.equal(responsesBody.output[0].content[0].text, "RESPONSES_PROXY_OK");

    const chat = await invoke("/responses", { model: "relay-third-party-2", input: "hello", stream: false });
    const chatBody = await chat.json();
    assert.equal(chat.status, 200);
    assert.equal(chatBody.output[0].content[0].text, "CHAT_PROXY_OK");

    const compact = await invoke("/responses/compact", { model: "relay-third-party-1", input: "compact", stream: false });
    const compactBody = await compact.json();
    assert.equal(compact.status, 200);
    assert.match(compactBody.output[0].encrypted_content, /^codex-relay:native-compaction:v1:/);
    assert.deepEqual(proxyRequests, [
      { path: "/v1/responses", authorization: "Bearer responses-proxy-key", model: "gpt-proxy" },
      { path: "/v1/chat/completions", authorization: "Bearer chat-proxy-key", model: "chat-proxy" },
      { path: "/v1/responses/compact", authorization: "Bearer responses-proxy-key", model: "gpt-proxy" },
    ]);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("provider model discovery, balance, and model tests use the provider proxy path", async () => {
  resetTestState();
  const proxyRequests = [];
  const proxy = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const target = new URL(request.url);
    proxyRequests.push({ path: target.pathname, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    if (target.pathname === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "gpt-proxy-management" }] }));
      return;
    }
    if (target.pathname === "/v1/usage") {
      response.end(JSON.stringify({ balance: 12.5, currency: "USD" }));
      return;
    }
    response.end(JSON.stringify({
      id: "resp_proxy_management",
      object: "response",
      status: "completed",
      model: "gpt-proxy-management",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{
      id: "proxy-management",
      name: "Proxy Management",
      baseUrl: "http://management.invalid/v1",
      apiType: "responses",
      networkMode: "custom",
      proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    }],
    thirdPartySlots: [],
  }));
  store.saveProviderKey("proxy-management", "management-proxy-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${relay.address().port}/api/providers/proxy-management`;
  try {
    const models = await fetch(`${baseUrl}/models`);
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json()).models, ["gpt-proxy-management"]);

    const balance = await fetch(`${baseUrl}/balance`, { method: "POST" });
    assert.equal(balance.status, 200);
    assert.equal((await balance.json()).balance.amount, 12.5);

    const modelTest = await fetch(`${baseUrl}/test-model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-proxy-management" }),
    });
    assert.equal(modelTest.status, 200);
    assert.equal((await modelTest.json()).ok, true);

    assert.deepEqual(proxyRequests, [
      { path: "/v1/models", authorization: "Bearer management-proxy-key" },
      { path: "/v1/usage", authorization: "Bearer management-proxy-key" },
      { path: "/v1/responses", authorization: "Bearer management-proxy-key" },
    ]);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("CC Switch process handoff is detected and closed without touching Codex", async () => {
  const parsed = parseTaskListCsv('"cc-switch.exe","9296","Console","1","12,000 K"\r\n"Codex.exe","3232","Console","1","30,000 K"\r\n"ChatGPT.exe","4545","Console","1","45,000 K"\r\n');
  parsed[0].executablePath = "D:\\cc-switch.exe";
  assert.deepEqual(parsed.map((item) => [item.name, item.pid]), [["cc-switch.exe", 9296], ["Codex.exe", 3232], ["ChatGPT.exe", 4545]]);
  const classified = classifyIntegrationProcesses(parsed);
  assert.deepEqual(classified.ccSwitch.map((item) => item.pid), [9296]);
  assert.deepEqual(classified.codex.map((item) => item.pid), [3232, 4545]);

  let running = parsed;
  const terminated = [];
  const result = await closeCcSwitchForHandoff({
    listProcesses: () => running,
    terminate: (pid, force) => {
      terminated.push({ pid, force });
      running = running.filter((item) => item.pid !== pid);
    },
    wait: async () => {},
    disabled: false,
  });
  assert.deepEqual(terminated, [{ pid: 9296, force: false }]);
  assert.deepEqual(result, { detected: 1, closed: 1, forced: false, remaining: 0, executablePaths: ["D:\\cc-switch.exe"] });
  assert.equal(running.some((item) => item.name === "Codex.exe"), true);
  const relaunched = [];
  assert.deepEqual(reopenCcSwitchAfterRollback(result, { launch: (target) => relaunched.push(target) }), { attempted: 1, reopened: 1 });
  assert.deepEqual(relaunched, ["D:\\cc-switch.exe"]);
});

test("the source desktop window uses the Windows ICO asset", () => {
  const desktopMain = fs.readFileSync(path.join(process.cwd(), "desktop", "main.js"), "utf8");
  const sourceLauncher = fs.readFileSync(path.join(process.cwd(), "scripts", "start-source-desktop.ps1"), "utf8");
  assert.match(desktopMain, /process\.platform === "win32" \? "icon\.ico" : "icon\.png"/);
  assert.match(desktopMain, /if \(app\.isPackaged\) app\.setAppUserModelId/);
  assert.match(desktopMain, /enforceRelayOwnership/);
  assert.match(sourceLauncher, /Codex Relay\.exe/);
  assert.match(sourceLauncher, /--set-icon/);
  assert.equal(fs.existsSync(path.join(process.cwd(), "assets", "icon.ico")), true);
});

test("official usage keeps only recognized plans and normalized quota windows", () => {
  const usage = parseOfficialUsage({
    plan_type: "pro_5x",
    rate_limit: {
      primary_window: { used_percent: 37.6, reset_at: 1_800_000_000 },
      secondary_window: { used_percentage: 4, resets_at: 1_800_010_000_000 },
    },
  });
  assert.deepEqual(usage, {
    planType: "pro5x",
    fiveHour: { usedPercent: 38, resetsAt: "2027-01-15T08:00:00.000Z" },
    weekly: { usedPercent: 4, resetsAt: "2027-01-15T10:46:40.000Z" },
  });
  assert.equal(normalizePlanType("Plus"), "plus");
  assert.equal(normalizePlanType("Enterprise"), null);
  assert.equal(parseOfficialUsage({ rate_limit: {} }), null);
});

test("official usage request stays on the official endpoint and does not expose its token in output", async () => {
  let requested;
  const usage = await fetchOfficialUsage({
    token: "official-token-only",
    fetcher: async (url, options) => {
      requested = { url, headers: options.headers };
      return new Response(JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 0 } } }), { status: 200 });
    },
  });
  assert.equal(requested.url, OFFICIAL_USAGE_ENDPOINT);
  assert.equal(requested.headers.authorization, "Bearer official-token-only");
  assert.deepEqual(usage, { planType: "plus", fiveHour: { usedPercent: 0, resetsAt: null }, weekly: null });
  assert.doesNotMatch(JSON.stringify(usage), /official-token-only/);
});

test("official usage timeout is cleared after success and becomes a controlled error when reached", async () => {
  let completedSignal;
  const usage = await fetchOfficialUsageWithTimeout({
    token: "official-token-only",
    timeoutMs: 20,
    fetcher: async (_url, options) => {
      completedSignal = options.signal;
      return new Response(JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 1 } } }), { status: 200 });
    },
  });
  assert.equal(usage.planType, "plus");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(completedSignal.aborted, false);

  await assert.rejects(
    fetchOfficialUsageWithTimeout({
      token: "official-token-only",
      timeoutMs: 20,
      fetcher: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    }),
    (error) => error.statusCode === 504 && error.code === "official_usage_timeout",
  );

  const hardTimeoutStarted = Date.now();
  await assert.rejects(
    fetchOfficialUsageWithTimeout({
      token: "official-token-only",
      timeoutMs: 20,
      fetcher: async () => new Promise(() => {}),
    }),
    (error) => error.statusCode === 504 && error.code === "official_usage_timeout",
  );
  assert.ok(Date.now() - hardTimeoutStarted < 250);
});

test("official requests remove their Abort listener after the response body completes", async () => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  class TrackingSignal extends EventTarget {
    aborted = false;
    added = 0;
    removed = 0;
    addEventListener(type, listener, options) {
      if (type === "abort") this.added += 1;
      return super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      if (type === "abort") this.removed += 1;
      return super.removeEventListener(type, listener, options);
    }
  }
  try {
    const signal = new TrackingSignal();
    const response = await fetchOfficial(`http://127.0.0.1:${upstream.address().port}/usage`, { signal });
    assert.equal(await response.text(), "ok");
    assert.equal(signal.added, 1);
    assert.equal(signal.removed, 1);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

function captureOfficialToken(token = "stored-official-access-token", accountId = "test-account") {
  fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
  fs.writeFileSync(store.paths().codexAuth, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "test-id-token", access_token: token, refresh_token: "test-refresh-token", account_id: accountId },
  }), "utf8");
  assert.equal(store.captureOfficialAuth().captured, true);
  return token;
}

function nextWebSocketJson(socket, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a WebSocket frame."));
    }, timeoutMs);
    const onMessage = (data) => {
      cleanup();
      try { resolve(JSON.parse(Buffer.from(data).toString("utf8"))); }
      catch (error) { reject(error); }
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`WebSocket closed before a frame arrived (${code}: ${reason}).`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

function openWebSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextWebSocketClose(socket, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a WebSocket close."));
    }, timeoutMs);
    const onClose = (code, reason) => {
      cleanup();
      resolve({ code, reason: Buffer.from(reason).toString("utf8") });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("close", onClose);
    };
    socket.once("close", onClose);
  });
}

test("unverified users only receive configured third-party routes", () => {
  const routes = activeRoutes(settings());
  assert.equal(routes.length, 1);
  assert.equal(routes[0].displayName, "DeepSeek V4");
  assert.equal(buildModelCatalog(settings()).models[0].display_name, "DeepSeek V4");
});

test("GPT 5.6 Responses slots inherit Codex compact tool mode from the upstream model id", () => {
  const configured = settings({
    providers: [{ id: "responses", name: "Responses", baseUrl: "https://example.test/v1", apiType: "responses" }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "My Sol", providerId: "responses", upstreamModel: "gpt-5.6-sol", contextWindow: 372000, supportsImages: true, dropParams: [] }],
  });
  const model = buildModelCatalog(configured).models[0];
  assert.equal(model.slug, "relay-third-party-1");
  assert.equal(model.use_responses_lite, true);
  assert.equal(model.tool_mode, "code_mode_only");
  assert.equal(model.multi_agent_version, "v2");
  assert.equal(model.default_reasoning_level, "low");
  assert.equal(model.context_window, 272_000);
  assert.equal(model.max_context_window, 272_000);
  assert.equal(model.effective_context_window_percent, 95);
  assert.equal(model.truncation_policy.limit, 10_000);
  assert.equal(model.auto_compact_token_limit, undefined);
});

test("new Astra Responses slots publish image input capability", () => {
  const provider = { id: "astra", name: "Astra", baseUrl: "https://astra.example/v1", apiType: "responses" };
  const capability = resolveModelCapability("gpt-6-astra", { provider });
  assert.equal(capability.supportsImages, true);
  assert.equal(capability.contextWindow, 262_144);
  assert.equal(capability.reasoning.preset, "openai");
  assert.equal(capability.source, "builtin_profile");

  const catalog = buildModelCatalog(settings({
    providers: [provider],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Astra", providerId: "astra", upstreamModel: "gpt-6-astra", supportsImages: true }],
  }));
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.equal(catalog.models[0].supports_image_detail_original, true);
});

test("Gemini 3.8 Flash High publishes its documented 1M input context window", () => {
  const provider = { id: "gemini", name: "Gemini", baseUrl: "https://gemini.example/v1", apiType: "responses" };
  const capability = resolveModelCapability("gemini-3.8-flash-high", { provider });
  assert.equal(capability.contextWindow, 1_048_576);
  assert.equal(capability.supportsImages, true);
  assert.equal(capability.source, "builtin_profile");

  const catalog = buildModelCatalog(settings({
    providers: [provider],
    thirdPartySlots: [{ id: "relay-third-party-7", displayName: "Gemini 3.8 Flash High", providerId: "gemini", upstreamModel: "gemini-3.8-flash-high" }],
  }));
  assert.equal(catalog.models[0].context_window, 1_048_576);
  assert.equal(catalog.models[0].max_context_window, 1_048_576);
});

test("known and unknown model profiles all publish image input without changing other capabilities", () => {
  const responses = { id: "responses", name: "Responses", baseUrl: "https://example.test/v1", apiType: "responses" };
  const known = [
    ["deepseek-v4-flash", 1_000_000, "deepseek"],
    ["kimi-k2.5", 262_144, "thinking"],
    ["qwen3-coder-plus", 1_048_576, "thinking"],
    ["glm-5.2", 1_000_000, "thinking"],
    ["minimax-m2.1", 200_000, "thinking"],
  ];
  for (const [model, contextWindow, preset] of known) {
    const capability = resolveModelCapability(model, { provider: responses });
    assert.equal(capability.supportsImages, true, model);
    assert.equal(capability.contextWindow, contextWindow, model);
    assert.equal(capability.reasoning.preset, preset, model);
  }
  assert.equal(resolveModelCapability("brand-new-model", { provider: responses }).supportsImages, true);
  assert.equal(resolveModelCapability("brand-new-chat-model", { provider: { ...responses, apiType: "chat_completions" } }).supportsImages, true);
});

test("Chat Completions slots do not receive the Responses Lite tool protocol", () => {
  const configured = settings({
    providers: [{ id: "chat", name: "Chat", baseUrl: "https://example.test/v1", apiType: "chat_completions" }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Chat Sol", providerId: "chat", upstreamModel: "gpt-5.6-sol", contextWindow: 372000, supportsImages: true, dropParams: [] }],
  });
  const model = buildModelCatalog(configured).models[0];
  assert.equal(model.use_responses_lite, false);
  assert.equal(model.tool_mode, undefined);
  assert.equal(model.multi_agent_version, undefined);
});

test("third-party upstream metadata preserves context while image input remains enabled", () => {
  const provider = {
    id: "verified-provider",
    name: "Verified provider",
    baseUrl: "https://verified.example/v1",
    apiType: "responses",
    modelCapabilities: { "gpt-5.6-terra": { contextWindow: 320_000, supportsImages: false } },
  };
  const capability = resolveModelCapability("gpt-5.6-terra", { provider });
  assert.equal(capability.contextWindow, 320_000);
  assert.equal(capability.supportsImages, true);
  assert.equal(capability.source, "provider_metadata");
});

test("GLM 5.2 uses a dedicated 1M Chat profile without changing other protocol defaults", () => {
  resetTestState();
  const chatProvider = { id: "tencent", name: "Tencent", baseUrl: "https://tokenhub.tencentmaas.com/v1", apiType: "chat_completions" };
  const responsesProvider = { id: "responses", name: "Responses", baseUrl: "https://responses.example/v1", apiType: "responses" };

  const glm = resolveModelCapability("glm-5.2", { provider: chatProvider });
  assert.equal(glm.contextWindow, 1_000_000);
  assert.equal(glm.source, "builtin_profile");
  assert.equal(glm.reasoning.preset, "thinking");
  assert.equal(glm.reasoning.transport, "thinking_toggle");

  assert.equal(resolveModelCapability("unlisted-chat-model", { provider: chatProvider }).contextWindow, 128_000);
  assert.equal(resolveModelCapability("unlisted-responses-model", { provider: responsesProvider }).contextWindow, 262_144);

  const normalized = store.replaceSettings(settings({
    providers: [chatProvider, responsesProvider],
    thirdPartySlots: [
      {
        id: "relay-third-party-1",
        displayName: "GLM 5.2",
        providerId: "tencent",
        upstreamModel: "glm-5.2",
        contextWindow: 128_000,
        supportsImages: false,
        reasoningPreset: "auto",
        dropParams: [],
      },
      {
        id: "relay-third-party-2",
        displayName: "Generic Chat",
        providerId: "tencent",
        upstreamModel: "generic-chat-model",
        contextWindow: 128_000,
        supportsImages: false,
        reasoningPreset: "auto",
        dropParams: [],
      },
    ],
  }));
  assert.equal(normalized.thirdPartySlots[0].contextWindow, 1_000_000);
  const [glmCatalog, genericCatalog] = buildModelCatalog(normalized).models;
  assert.equal(glmCatalog.context_window, 1_000_000);
  assert.equal(glmCatalog.include_skills_usage_instructions, false);
  assert.equal(glmCatalog.base_instructions, genericCatalog.base_instructions);
  assert.equal(glmCatalog.supports_search_tool, genericCatalog.supports_search_tool);
  assert.deepEqual(glmCatalog.experimental_supported_tools, genericCatalog.experimental_supported_tools);
  assert.equal(glmCatalog.use_responses_lite, false);
  assert.equal(glmCatalog.tool_mode, undefined);
  assert.equal(glmCatalog.multi_agent_version, undefined);
  resetTestState();
});

test("publication verification accepts a complete third-party catalog without official login", () => {
  resetTestState();
  const configured = settings();
  const catalog = buildModelCatalog(configured);
  store.writeCatalog(catalog);
  store.applyRelayConfig({ model: catalog.models[0].slug, catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });

  const publication = store.relayPublicationStatus({
    expectedRoutes: activeRoutes(configured).map((route) => route.id),
    routerUrl: "http://127.0.0.1:15723/v1",
  });

  assert.equal(publication.verified, true);
  assert.deepEqual(publication.publishedRoutes, ["relay-third-party-1"]);
  resetTestState();
});

test("compressed Codex requests are decoded before routing", async () => {
  const payload = Buffer.from(JSON.stringify({ model: "relay-third-party-1", input: "compressed" }));
  const request = Readable.from([zlib.gzipSync(payload)]);
  request.headers = { "content-encoding": "gzip" };
  assert.deepEqual(await readJsonRequest(request), { model: "relay-third-party-1", input: "compressed" });
});

test("image-heavy Responses requests can exceed the former 25 MiB ceiling", async () => {
  const input = "x".repeat(26 * 1024 * 1024);
  const payload = Buffer.from(JSON.stringify({ model: "gpt-5.6-terra", input }));
  const request = Readable.from([payload]);
  request.headers = {};
  const parsed = await readJsonRequest(request, RESPONSES_BODY_LIMIT_BYTES);
  assert.equal(parsed.input.length, input.length);
  assert.equal(RESPONSES_BODY_LIMIT_BYTES, 64 * 1024 * 1024);
});

test("the HTTP Responses route accepts a 26 MiB decoded request before model routing", async () => {
  resetTestState();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port: 15723, running: true } }));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "not-configured-large-test", input: "x".repeat(26 * 1024 * 1024) }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "model_not_configured");
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("health checks never refresh official credentials or rewrite settings", async () => {
  resetTestState();
  fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
  fs.writeFileSync(store.paths().codexAuth, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "health-token", refresh_token: "health-refresh", account_id: "health-account" },
  }), "utf8");
  store.replaceSettings(settings({ official: { verified: true, lastCheckedAt: "2026-07-16T00:00:00.000Z" } }));
  assert.equal(store.captureOfficialAuth().captured, true);
  const settingsBefore = fs.readFileSync(store.paths().config, "utf8");
  const officialBefore = fs.readFileSync(store.paths().officialAuth, "utf8");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(fs.readFileSync(store.paths().config, "utf8"), settingsBefore);
    assert.equal(fs.readFileSync(store.paths().officialAuth, "utf8"), officialBefore);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("capturing an unchanged official login reuses the encrypted snapshot", () => {
  resetTestState();
  fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
  fs.writeFileSync(store.paths().codexAuth, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "stable-token", refresh_token: "stable-refresh", account_id: "stable-account" },
  }), "utf8");
  assert.deepEqual(store.captureOfficialAuth(), { captured: true });
  const before = fs.readFileSync(store.paths().officialAuth, "utf8");
  assert.deepEqual(store.captureOfficialAuth(), { captured: true });
  assert.equal(fs.readFileSync(store.paths().officialAuth, "utf8"), before);
});

test("dialog cancel controls bypass required-field validation", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal((html.match(/data-dialog-close=/g) || []).length, 22);
  assert.match(html, /data-dialog-close="delete-request-history-dialog"/);
  assert.doesNotMatch(html, /<button[^>]+value="cancel"/);
  assert.match(html, /id="apply-button"[^>]*>[\s\S]*?<span>启用 Relay<\/span>/);
  assert.match(html, /id="restore-top-button"[^>]*data-action="restore"[^>]*disabled/);
  assert.match(html, /id="apply-dialog"/);
  assert.match(html, /id="official-direct-dialog"/);
  assert.match(html, /data-view="home"[\s\S]*data-view="providers"[\s\S]*data-view="models"/);
  assert.match(html, /id="providers-view"[\s\S]*id="provider-list"[\s\S]*id="models-view"/);
  assert.match(html, /class="nav-item" data-view="providers"[\s\S]*<span>供应商<\/span>/);
  assert.doesNotMatch(html, /provider-(?:model-list-url|balance-url|balance-path|balance-currency|extra-headers|auth-header)/);
  assert.doesNotMatch(html, /id="(?:new-provider|slot-context|slot-images)"/);
  assert.match(html, /id="model-capability-text"/);
  assert.match(html, /<label>模型栏显示名称<input id="slot-name"/);
  assert.match(html, /id="batch-add-models"/);
  assert.match(html, /id="batch-model-form"/);
  assert.match(fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"), /保留当前 Codex 官方登录，不重写 auth\.json/);
});

test("official model discovery accepts supported payload shapes and sanitizes metadata", () => {
  const models = parseOfficialModels({
    data: [
      { slug: "gpt-5.6-terra", display_name: "5.6 Terra", context_window: 258400, input_modalities: ["text", "image"], default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }, { effort: "high", description: "Deeper" }], tool_mode: "code_mode_only", multi_agent_version: "v2", use_responses_lite: true },
      { id: "gpt-5.5", displayName: "5.5" },
      { id: "gpt-5.5", displayName: "duplicate" },
      { id: "../../invalid model", displayName: "invalid" },
    ],
  });
  assert.deepEqual(models.map((model) => model.id), ["gpt-5.5", "gpt-5.6-terra"]);
  assert.equal(models[1].contextWindow, 258400);
  assert.equal(models[1].supportsImages, true);
  assert.deepEqual(models[1].reasoningLevels, [{ effort: "medium", description: "Balanced" }, { effort: "high", description: "Deeper" }]);
  assert.equal(models[1].defaultReasoningLevel, "high");
  assert.equal(models[1].toolMode, "code_mode_only");
  assert.equal(models[1].multiAgentVersion, "v2");
  assert.equal(models[1].useResponsesLite, true);
  assert.deepEqual(parseOfficialModels({ models: { "gpt-5.4": { display_name: "GPT-5.4" } } }).map((model) => model.id), ["gpt-5.4"]);
});

test("model catalog preserves official reasoning metadata and publishes six levels for configured GPT-5.6 relays", () => {
  const catalog = buildModelCatalog(settings({
    official: {
      verified: true,
      slots: [{
        id: "official-native", displayName: "Official Native", upstreamModel: "official-native",
        defaultReasoningLevel: "max",
        reasoningLevels: [{ effort: "low", description: "Official low" }, { effort: "max", description: "Official max" }],
      }],
    },
    providers: [{ id: "responses", name: "GPT Relay", baseUrl: "https://relay.example/v1", apiType: "responses" }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "GPT 5.6", providerId: "responses", upstreamModel: "gpt-5.6-terra", reasoningPreset: "gpt_six" }],
  }));
  assert.equal(catalog.models[0].default_reasoning_level, "max");
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, [{ effort: "low", description: "Official low" }, { effort: "max", description: "Official max" }]);
  assert.deepEqual(catalog.models[1].supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "xhigh", "ultra", "max"]);
});

test("Chat Completions reasoning adapters send provider-specific fields and clamp unsupported levels", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    store.saveProviderKey("openrouter", "openrouter-key");
    store.saveProviderKey("deepseek", "deepseek-key");
    const configured = settings({
      providers: [
        { id: "openrouter", name: "OpenRouter", baseUrl, apiType: "chat_completions" },
        { id: "deepseek", name: "DeepSeek", baseUrl, apiType: "chat_completions" },
      ],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "Router GPT", providerId: "openrouter", upstreamModel: "gpt-5.6-terra", reasoningPreset: "openrouter" },
        { id: "relay-third-party-2", displayName: "DeepSeek", providerId: "deepseek", upstreamModel: "deepseek-v4-pro", reasoningPreset: "deepseek" },
      ],
    });
    await forwardResponses({ settings: configured, route: routeForRequest(configured, "relay-third-party-1"), body: { model: "relay-third-party-1", input: "test", reasoning: { effort: "max" } }, headers: {}, history: createChatHistory() });
    await forwardResponses({ settings: configured, route: routeForRequest(configured, "relay-third-party-2"), body: { model: "relay-third-party-2", input: "test", reasoning: { effort: "xhigh" } }, headers: {}, history: createChatHistory() });
    assert.deepEqual(received[0].reasoning, { effort: "xhigh" });
    assert.equal(received[0].reasoning_effort, undefined);
    assert.equal(received[1].reasoning_effort, "max");
    assert.deepEqual(received[1].thinking, { type: "enabled" });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("GPT-5.6 Responses relays preserve all configured reasoning levels in the upstream request", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_reasoning", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("gpt-relay", "gpt-relay-key");
    const configured = settings({
      providers: [{ id: "gpt-relay", name: "GPT Relay", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses" }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "GPT 5.6", providerId: "gpt-relay", upstreamModel: "gpt-5.6-terra", reasoningPreset: "gpt_six" }],
    });
    const response = await forwardResponses({ settings: configured, route: routeForRequest(configured, "relay-third-party-1"), body: { model: "relay-third-party-1", input: "test", reasoning: { effort: "ultra", summary: "auto" } }, headers: {}, history: createChatHistory() });
    assert.equal(response.status, 200);
    assert.deepEqual(received[0].reasoning, { effort: "ultra", summary: "auto" });
    assert.equal(received[0].model, "gpt-5.6-terra");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official model discovery sends the signed-in account credentials to the official model endpoint", async () => {
  let received;
  const upstream = http.createServer((req, res) => {
    received = { url: req.url, authorization: req.headers.authorization, accountId: req.headers["chatgpt-account-id"], originator: req.headers.originator };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ slug: "gpt-5.4", display_name: "GPT-5.4" }, "gpt-5.5"] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const models = await fetchOfficialModels({
      token: "official-token",
      accountId: "official-account",
      clientVersion: "test-version",
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/codex`,
    });
    assert.deepEqual(models.map((model) => model.id), ["gpt-5.4", "gpt-5.5"]);
    assert.equal(received.authorization, "Bearer official-token");
    assert.equal(received.accountId, "official-account");
    assert.equal(received.originator, "codex-relay");
    assert.equal(received.url, "/codex/models?client_version=test-version");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Codex client version detection prefers the installed CLI and falls back to the model cache", () => {
  const cachePath = path.join(sandbox, "models-cache-version.json");
  fs.writeFileSync(cachePath, JSON.stringify({ client_version: "0.143.7" }), "utf8");
  assert.equal(parseCodexClientVersion("codex-cli 0.144.1"), "0.144.1");
  assert.equal(detectCodexClientVersion({ runVersionCommand: () => "codex-cli 0.144.1", cachePath }), "0.144.1");
  assert.equal(detectCodexClientVersion({ runVersionCommand: () => "not available", cachePath }), "0.143.7");
});

test("a saved official credential remains available while Codex points at the local Relay", () => {
  assert.equal(officialSessionAvailable({ signedIn: true, authType: "official" }, false), true);
  assert.equal(officialSessionAvailable({ signedIn: true, authType: "api_key" }, true), true);
  assert.equal(officialSessionAvailable({ signedIn: true, authType: "api_key" }, false), false);
});

test("Computer Use readiness requires the current bundled plugin and matching runtime", () => {
  const root = path.join(sandbox, "computer-use-fixture");
  const codexHome = path.join(root, "codex-home");
  const localAppData = path.join(root, "local");
  const logRoot = path.join(localAppData, "Codex", "Logs");
  const resources = path.join(root, "WindowsApps", "OpenAI.Codex_test", "app", "resources");
  const runtimeId = "abcdef1234567890";
  fs.mkdirSync(path.join(resources, "cua_node", "bin"), { recursive: true });
  const sourcePluginManifest = path.join(resources, "plugins", "openai-bundled", "plugins", "computer-use", ".codex-plugin", "plugin.json");
  const sourcePluginClient = path.join(resources, "plugins", "openai-bundled", "plugins", "computer-use", "scripts", "computer-use-client.mjs");
  fs.mkdirSync(path.dirname(sourcePluginManifest), { recursive: true });
  fs.mkdirSync(path.dirname(sourcePluginClient), { recursive: true });
  fs.writeFileSync(sourcePluginManifest, JSON.stringify({ name: "computer-use", version: "plugin-v2" }), "utf8");
  fs.writeFileSync(sourcePluginClient, "client-v2", "utf8");
  fs.writeFileSync(path.join(resources, "cua_node", "manifest.json"), JSON.stringify({ runtime_archive_version: "test-runtime-v2" }), "utf8");
  const runtimeTarget = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node", runtimeId);
  fs.mkdirSync(path.join(runtimeTarget, "bin"), { recursive: true });
  fs.writeFileSync(path.join(runtimeTarget, "manifest.json"), JSON.stringify({ runtime_archive_version: "test-runtime-v2" }), "utf8");
  fs.writeFileSync(path.join(runtimeTarget, "bin", "node.exe"), "node", "utf8");
  const pluginManifest = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "computer-use", ".codex-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(pluginManifest), { recursive: true });
  fs.writeFileSync(pluginManifest, JSON.stringify({ name: "computer-use", version: "plugin-v2" }), "utf8");
  const pluginClient = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "computer-use", "scripts", "computer-use-client.mjs");
  fs.mkdirSync(path.dirname(pluginClient), { recursive: true });
  fs.writeFileSync(pluginClient, "client-v2", "utf8");
  fs.mkdirSync(logRoot, { recursive: true });
  const escapedSource = path.join(resources, "cua_node").replaceAll("\\", "\\\\");
  fs.writeFileSync(path.join(logRoot, "codex.log"), `sourcePath="${escapedSource}" runtimes\\\\cua_node\\\\.staging-${runtimeId}-test`, "utf8");

  resetComputerUseStatusCache();
  const ready = computerUseEnvironment({ codexHome, localAppData, logRoot });
  assert.equal(ready.environmentReady, true);
  assert.equal(ready.pluginReady, true);
  assert.equal(ready.runtimeReady, true);

  fs.rmSync(pluginManifest, { force: true });
  const missing = computerUseEnvironment({ codexHome, localAppData, logRoot });
  assert.equal(missing.environmentReady, false);
  assert.equal(missing.reason, "plugin_cache_missing");
});

test("Computer Use follows the current Appx runtime after a Codex update", () => {
  const root = path.join(sandbox, "computer-use-update-fixture");
  const codexHome = path.join(root, "codex-home");
  const localAppData = path.join(root, "local");
  const appxInstallLocation = path.join(root, "WindowsApps", "OpenAI.Codex_current");
  const resources = path.join(appxInstallLocation, "app", "resources");
  const runtimeRoot = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
  const oldRuntimeId = "aaaaaaaaaaaaaaaa";
  const currentRuntimeId = "bbbbbbbbbbbbbbbb";

  fs.mkdirSync(path.join(resources, "cua_node"), { recursive: true });
  const sourcePluginManifest = path.join(resources, "plugins", "openai-bundled", "plugins", "computer-use", ".codex-plugin", "plugin.json");
  const sourcePluginClient = path.join(resources, "plugins", "openai-bundled", "plugins", "computer-use", "scripts", "computer-use-client.mjs");
  fs.mkdirSync(path.dirname(sourcePluginManifest), { recursive: true });
  fs.mkdirSync(path.dirname(sourcePluginClient), { recursive: true });
  fs.writeFileSync(sourcePluginManifest, JSON.stringify({ name: "computer-use", version: "plugin-v2" }), "utf8");
  fs.writeFileSync(sourcePluginClient, "client-v2", "utf8");
  fs.writeFileSync(path.join(resources, "cua_node", "manifest.json"), JSON.stringify({ runtime_archive_version: "runtime-v2" }), "utf8");

  const oldRuntime = path.join(runtimeRoot, oldRuntimeId);
  fs.mkdirSync(path.join(oldRuntime, "bin"), { recursive: true });
  fs.writeFileSync(path.join(oldRuntime, "manifest.json"), JSON.stringify({ runtime_archive_version: "runtime-v1" }), "utf8");
  fs.writeFileSync(path.join(oldRuntime, "bin", "node.exe"), "old-node", "utf8");
  fs.mkdirSync(path.join(runtimeRoot, `.staging-${currentRuntimeId}-failed`), { recursive: true });

  resetComputerUseStatusCache();
  const missing = computerUseEnvironment({ codexHome, localAppData, appxInstallLocation, logRoot: path.join(root, "missing-logs") });
  assert.equal(missing.runtimeId, currentRuntimeId);
  assert.equal(missing.sourceRuntimeVersion, "runtime-v2");
  assert.equal(missing.installedRuntimeVersion, "");
  assert.equal(missing.repairAvailable, true);
  assert.equal(missing.environmentReady, false);

  const currentRuntime = path.join(runtimeRoot, currentRuntimeId);
  fs.mkdirSync(path.join(currentRuntime, "bin"), { recursive: true });
  fs.writeFileSync(path.join(currentRuntime, "manifest.json"), JSON.stringify({ runtime_archive_version: "runtime-v2" }), "utf8");
  fs.writeFileSync(path.join(currentRuntime, "bin", "node.exe"), "current-node", "utf8");
  const pluginManifest = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "computer-use", ".codex-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(pluginManifest), { recursive: true });
  fs.writeFileSync(pluginManifest, JSON.stringify({ name: "computer-use", version: "plugin-v2" }), "utf8");
  const pluginClient = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "computer-use", "scripts", "computer-use-client.mjs");
  fs.mkdirSync(path.dirname(pluginClient), { recursive: true });
  fs.writeFileSync(pluginClient, "client-v2", "utf8");

  const ready = computerUseEnvironment({ codexHome, localAppData, appxInstallLocation, logRoot: path.join(root, "missing-logs") });
  assert.equal(ready.runtimeId, currentRuntimeId);
  assert.equal(ready.environmentReady, true);
});

test("Computer Use rejects an outdated bundled plugin after a Codex update", () => {
  const root = path.join(sandbox, "computer-use-plugin-update-fixture");
  const codexHome = path.join(root, "codex-home");
  const localAppData = path.join(root, "local");
  const resources = path.join(root, "resources");
  const runtimeId = "cccccccccccccccc";
  const sourcePluginManifest = path.join(resources, "plugins", "openai-bundled", "plugins", "computer-use", ".codex-plugin", "plugin.json");
  const sourcePluginClient = path.join(resources, "plugins", "openai-bundled", "plugins", "computer-use", "scripts", "computer-use-client.mjs");
  fs.mkdirSync(path.dirname(sourcePluginManifest), { recursive: true });
  fs.mkdirSync(path.dirname(sourcePluginClient), { recursive: true });
  fs.writeFileSync(sourcePluginManifest, JSON.stringify({ name: "computer-use", version: "plugin-v3" }), "utf8");
  fs.writeFileSync(sourcePluginClient, "client-v3", "utf8");
  fs.mkdirSync(path.join(resources, "cua_node"), { recursive: true });
  fs.writeFileSync(path.join(resources, "cua_node", "manifest.json"), JSON.stringify({ runtime_archive_version: "runtime-v3" }), "utf8");

  const runtimeTarget = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node", runtimeId);
  fs.mkdirSync(path.join(runtimeTarget, "bin"), { recursive: true });
  fs.writeFileSync(path.join(runtimeTarget, "manifest.json"), JSON.stringify({ runtime_archive_version: "runtime-v3" }), "utf8");
  fs.writeFileSync(path.join(runtimeTarget, "bin", "node.exe"), "node-v3", "utf8");

  const pluginManifest = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "computer-use", ".codex-plugin", "plugin.json");
  const pluginClient = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "computer-use", "scripts", "computer-use-client.mjs");
  fs.mkdirSync(path.dirname(pluginManifest), { recursive: true });
  fs.mkdirSync(path.dirname(pluginClient), { recursive: true });
  fs.writeFileSync(pluginManifest, JSON.stringify({ name: "computer-use", version: "plugin-v2" }), "utf8");
  fs.writeFileSync(pluginClient, "client-v2", "utf8");

  const status = computerUseEnvironment({ codexHome, localAppData, resources, runtimeId });
  assert.equal(status.runtimeReady, true);
  assert.equal(status.pluginReady, false);
  assert.equal(status.sourcePluginVersion, "plugin-v3");
  assert.equal(status.installedPluginVersion, "plugin-v2");
  assert.equal(status.reason, "plugin_cache_outdated");
});

test("Browser control readiness verifies bundled plugins, stable executables, Chrome profile, and native host", () => {
  const root = path.join(sandbox, "browser-use-fixture");
  const codexHome = path.join(root, "codex-home");
  const localAppData = path.join(root, "local");
  const resources = path.join(root, "resources");
  const sourcePlugins = path.join(resources, "plugins", "openai-bundled", "plugins");
  const targetPlugins = path.join(codexHome, "plugins", "cache", "openai-bundled", "marketplace-source", "plugins");
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const hostName = "com.example.codexextension";

  for (const name of ["browser", "chrome"]) {
    const manifest = JSON.stringify({ name, version: "plugin-v1" });
    for (const pluginRoot of [sourcePlugins, targetPlugins]) {
      const manifestPath = path.join(pluginRoot, name, ".codex-plugin", "plugin.json");
      const clientPath = path.join(pluginRoot, name, "scripts", "browser-client.mjs");
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.mkdirSync(path.dirname(clientPath), { recursive: true });
      fs.writeFileSync(manifestPath, manifest, "utf8");
      fs.writeFileSync(clientPath, `client-${name}`, "utf8");
    }
  }
  fs.writeFileSync(path.join(targetPlugins, "chrome", "scripts", "extension-id.json"), JSON.stringify({ extensionId, extensionHostName: hostName }), "utf8");

  const executableNames = ["codex.exe", "codex-code-mode-host.exe", "codex-windows-sandbox-setup.exe", "codex-command-runner.exe", "rg.exe"];
  for (const name of executableNames) fs.writeFileSync(path.join(resources, name), `binary-${name}`, "utf8");

  const chromePath = path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe");
  fs.mkdirSync(path.dirname(chromePath), { recursive: true });
  fs.writeFileSync(chromePath, "chrome", "utf8");
  const chromeUserDataDir = path.join(localAppData, "Google", "Chrome", "User Data");
  const profilePath = path.join(chromeUserDataDir, "Profile 1");
  fs.mkdirSync(path.join(profilePath, "Extensions", extensionId, "1.0.0"), { recursive: true });
  fs.writeFileSync(path.join(chromeUserDataDir, "Local State"), JSON.stringify({ profile: { last_used: "Profile 1" } }), "utf8");
  fs.writeFileSync(path.join(profilePath, "Preferences"), "{}", "utf8");
  fs.writeFileSync(path.join(profilePath, "Secure Preferences"), JSON.stringify({ extensions: { settings: { [extensionId]: { state: 1 } } } }), "utf8");

  const nativeHostExecutable = path.join(root, "extension-host.exe");
  const nativeHostManifest = path.join(root, "native-host.json");
  fs.writeFileSync(nativeHostExecutable, "native-host", "utf8");
  fs.writeFileSync(nativeHostManifest, JSON.stringify({ name: hostName, path: nativeHostExecutable, allowed_origins: [`chrome-extension://${extensionId}/`] }), "utf8");

  resetBrowserUseStatusCache();
  const missing = browserUseEnvironment({ codexHome, localAppData, resources, chromePath, chromeRunning: true, chromeUserDataDir, registryManifestPath: nativeHostManifest });
  assert.equal(missing.pluginReady, true);
  assert.equal(missing.stableExecutablesReady, false);
  assert.equal(missing.status, "stable_executables_missing");
  assert.match(missing.expectedCodexBinId, /^[a-f0-9]{16}$/);
  assert.match(missing.expectedRgBinId, /^[a-f0-9]{16}$/);

  const stableRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  for (const [id, names] of [[missing.expectedCodexBinId, executableNames.slice(0, 4)], [missing.expectedRgBinId, ["rg.exe"]]]) {
    const target = path.join(stableRoot, id);
    fs.mkdirSync(target, { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(resources, name), path.join(target, name));
  }

  const ready = browserUseEnvironment({ codexHome, localAppData, resources, chromePath, chromeRunning: true, chromeUserDataDir, registryManifestPath: nativeHostManifest });
  assert.equal(ready.browserReady, true);
  assert.equal(ready.chromeReady, true);
  assert.equal(ready.extensionEnabled, true);
  assert.equal(ready.nativeHostReady, true);
  assert.equal(ready.selectedProfile, "Profile 1");
  assert.equal(ready.status, "ready");
});

test("version 1 settings migrate to the existing two official slots without changing routes", () => {
  resetTestState();
  fs.mkdirSync(store.paths().appDir, { recursive: true });
  fs.writeFileSync(store.paths().config, JSON.stringify(settings({
    version: 1,
    official: { verified: true, lastCheckedAt: "2026-07-12T00:00:00.000Z" },
  })), "utf8");
  const migrated = store.loadSettings();
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.official.slots.map((model) => model.id), ["gpt-5.6-terra", "gpt-5.5"]);
  assert.deepEqual(migrated.deepSeekSavings, { enabled: false });
  assert.deepEqual(migrated.compactCapabilities, []);
  assert.deepEqual(activeRoutes(migrated).map((route) => route.id), ["gpt-5.6-terra", "gpt-5.5", "relay-third-party-1"]);
  resetTestState();
});

test("DeepSeek savings preference persists without changing route publication", () => {
  resetTestState();
  const configured = store.replaceSettings(settings({ deepSeekSavings: { enabled: true } }));
  assert.deepEqual(configured.deepSeekSavings, { enabled: true });
  assert.deepEqual(activeRoutes(configured).map((route) => route.id), ["relay-third-party-1"]);
  assert.deepEqual(store.loadSettings().deepSeekSavings, { enabled: true });
  resetTestState();
});

test("DeepSeek savings API toggles only the opt-in preference", async () => {
  resetTestState();
  store.replaceSettings(settings());
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const enabled = await fetch(`http://127.0.0.1:${relay.address().port}/api/deepseek-savings`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    assert.deepEqual(await enabled.json(), { enabled: true });
    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    assert.deepEqual(state.deepSeekSavings, { enabled: true });
    assert.deepEqual(state.routes.map((route) => route.id), ["relay-third-party-1"]);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("official slot settings keep two unique models from the discovered list", () => {
  resetTestState();
  store.replaceSettings(settings({
    official: {
      verified: true,
      lastCheckedAt: "2026-07-12T00:00:00.000Z",
      modelsFetchedAt: "2026-07-13T00:00:00.000Z",
      availableModels: [
        { id: "gpt-5.4", displayName: "GPT-5.4", upstreamModel: "gpt-5.4" },
        { id: "gpt-5.5", displayName: "GPT-5.5", upstreamModel: "gpt-5.5" },
      ],
      slots: [
        { id: "gpt-5.4", displayName: "GPT-5.4", upstreamModel: "gpt-5.4" },
        { id: "gpt-5.4", displayName: "duplicate", upstreamModel: "gpt-5.4" },
      ],
    },
  }));
  const normalized = store.loadSettings();
  assert.deepEqual(normalized.official.slots.map((model) => model.id), ["gpt-5.4"]);
  assert.deepEqual(activeRoutes(normalized).map((route) => route.id), ["gpt-5.4", "relay-third-party-1"]);
  resetTestState();
});

test("account fingerprints invalidate stale official candidates without exposing the account identifier", async () => {
  resetTestState();
  captureOfficialToken("first-account-token");
  const firstAccount = store.loadSettings();
  firstAccount.official.availableModels = [{ id: "gpt-first", displayName: "First", upstreamModel: "gpt-first" }];
  firstAccount.official.modelsFetchedAt = "2026-07-13T00:00:00.000Z";
  firstAccount.official.accountFingerprint = "a".repeat(64);
  store.saveSettings(firstAccount);

  fs.writeFileSync(store.paths().codexAuth, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "test-id-token", access_token: "second-account-token", refresh_token: "test-refresh-token", account_id: "second-account" },
  }), "utf8");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    assert.deepEqual(state.official.availableModels, []);
    assert.equal(state.official.modelsFetchedAt, null);
    assert.equal("accountFingerprint" in state.official, false);
    assert.equal(store.loadSettings().official.slots.length, 2);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("saving official slots keeps third-party routes and rejects duplicate or unknown models", async () => {
  resetTestState();
  store.replaceSettings(settings({
    official: {
      verified: true,
      lastCheckedAt: "2026-07-12T00:00:00.000Z",
      modelsFetchedAt: "2026-07-13T00:00:00.000Z",
      availableModels: [
        { id: "gpt-5.4", displayName: "GPT-5.4", upstreamModel: "gpt-5.4" },
        { id: "gpt-5.5", displayName: "GPT-5.5", upstreamModel: "gpt-5.5" },
      ],
      slots: [
        { id: "gpt-5.6-terra", displayName: "5.6 Terra", upstreamModel: "gpt-5.6-terra" },
        { id: "gpt-5.5", displayName: "5.5", upstreamModel: "gpt-5.5" },
      ],
    },
  }));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${relay.address().port}/api/official/slots`;
  try {
    const duplicate = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelIds: ["gpt-5.4", "gpt-5.4"] }) });
    assert.equal(duplicate.status, 400);
    const unknown = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelIds: ["gpt-unknown"] }) });
    assert.equal(unknown.status, 400);
    const saved = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelIds: ["gpt-5.4", "gpt-5.5"] }) });
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.deepEqual(result.routes, ["gpt-5.4", "gpt-5.5", "relay-third-party-1"]);
    assert.deepEqual(store.loadSettings().official.slots.map((model) => model.id), ["gpt-5.4", "gpt-5.5"]);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("verified users receive two official routes plus configured third-party routes", () => {
  const configured = settings({ official: { verified: true, lastCheckedAt: "2026-07-12T00:00:00.000Z" } });
  const catalog = buildModelCatalog(configured);
  assert.equal(catalog.models.length, 3);
  assert.deepEqual(catalog.models.map((model) => model.display_name), ["5.6 Terra", "5.5", "DeepSeek V4"]);
});

test("a user who signs in after Relay starts automatically receives the two official slots", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const before = await (await fetch(`http://127.0.0.1:${port}/model-catalog.json`)).json();
    assert.deepEqual(before.models.map((model) => model.display_name), ["DeepSeek V4"]);

    captureOfficialToken("signed-in-after-start");
    const after = await (await fetch(`http://127.0.0.1:${port}/model-catalog.json`)).json();
    assert.deepEqual(after.models.map((model) => model.display_name), ["5.6 Terra", "5.5", "DeepSeek V4"]);
    assert.equal(store.loadSettings().official.verified, true);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("conversation protection allows append and archive moves but detects loss or truncation", () => {
  resetTestState();
  const active = path.join(store.paths().codexConfig, "..", "sessions", "2026", "07", "12");
  const archived = path.join(store.paths().codexConfig, "..", "archived_sessions");
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  const first = path.join(active, "rollout-first.jsonl");
  const second = path.join(active, "rollout-second.jsonl");
  fs.writeFileSync(first, '{"id":"first"}\n', "utf8");
  fs.writeFileSync(second, '{"id":"second"}\n', "utf8");
  const baseline = store.currentSessionInventory();

  fs.appendFileSync(first, '{"new":"message"}\n', "utf8");
  fs.renameSync(second, path.join(archived, path.basename(second)));
  assert.equal(store.verifySessionProtection(baseline).safe, true);

  fs.writeFileSync(first, "x", "utf8");
  const truncated = store.verifySessionProtection(baseline);
  assert.equal(truncated.safe, false);
  assert.deepEqual(truncated.truncated, ["rollout-first.jsonl"]);

  fs.rmSync(path.join(archived, path.basename(second)));
  const missing = store.verifySessionProtection(baseline);
  assert.equal(missing.safe, false);
  assert.deepEqual(missing.missing, ["rollout-second.jsonl"]);
});

test("official image generation uses saved Codex auth and never forwards client API keys", async () => {
  resetTestState();
  captureOfficialToken("official-image-token");
  let received;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "image-request-id" });
      response.end(JSON.stringify({ created: 1, data: [{ b64_json: "test-image" }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const body = { model: "gpt-image-2", prompt: "test prompt", size: "1024x1024" };
    const response = await forwardOfficialImageGeneration({
      body,
      headers: { authorization: "Bearer client-token", "x-api-key": "client-key", "x-codex-client": "desktop" },
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/codex`,
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [{ b64_json: "test-image" }]);
    assert.equal(received.url, "/codex/images/generations");
    assert.deepEqual(received.body, body);
    assert.equal(received.headers.authorization, "Bearer official-image-token");
    assert.equal(received.headers["chatgpt-account-id"], "test-account");
    assert.equal(received.headers.accept, "application/json");
    assert.equal(received.headers["x-api-key"], undefined);
    assert.equal(received.headers["x-codex-client"], "desktop");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official image editing preserves multipart reference bytes and never forwards client API keys", async () => {
  resetTestState();
  captureOfficialToken("official-image-edit-token");
  let received;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
    response.writeHead(200, { "content-type": "application/json", "x-request-id": "image-edit-request-id" });
    response.end(JSON.stringify({ created: 1, data: [{ b64_json: "edited-image" }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const boundary = "codex-relay-test-boundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit the marker\r\n--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n`, "utf8"),
      Buffer.from([0, 1, 2, 255]),
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const response = await forwardOfficialImageEdit({
      body,
      contentType,
      headers: { authorization: "Bearer client-token", "x-api-key": "client-key", "x-codex-client": "desktop" },
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/codex`,
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [{ b64_json: "edited-image" }]);
    assert.equal(received.url, "/codex/images/edits");
    assert.equal(received.headers["content-type"], contentType);
    assert.deepEqual(received.body, body);
    assert.equal(received.headers.authorization, "Bearer official-image-edit-token");
    assert.equal(received.headers["chatgpt-account-id"], "test-account");
    assert.equal(received.headers["x-api-key"], undefined);
    assert.equal(received.headers["x-codex-client"], "desktop");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official image editing preserves Codex JSON reference payloads", async () => {
  resetTestState();
  captureOfficialToken("official-image-edit-json-token");
  let received;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ created: 1, data: [{ b64_json: "edited-image" }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const body = Buffer.from(JSON.stringify({ prompt: "edit the marker", images: [{ b64_json: "AAEC/w==" }] }), "utf8");
    const response = await forwardOfficialImageEdit({
      body,
      contentType: "application/json",
      headers: { authorization: "Bearer client-token", "x-api-key": "client-key" },
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/codex`,
    });
    assert.equal(response.status, 200);
    assert.equal(received.url, "/codex/images/edits");
    assert.equal(received.headers["content-type"], "application/json");
    assert.deepEqual(received.body, body);
    assert.equal(received.headers.authorization, "Bearer official-image-edit-json-token");
    assert.equal(received.headers["x-api-key"], undefined);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("image generation endpoint reports missing official auth instead of a generic 404", async () => {
  resetTestState();
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    official: { verified: false, lastCheckedAt: null },
    providers: [],
    thirdPartySlots: [],
  }));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-api-key" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "test prompt" }),
    });
    assert.equal(response.status, 401);
    const result = await response.json();
    assert.equal(result.error.code, "official_auth_missing");
    assert.doesNotMatch(JSON.stringify(result), /client-api-key/);

    const boundary = "codex-relay-missing-auth";
    const edit = await fetch(`http://127.0.0.1:${relay.address().port}/v1/images/edits`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: "Bearer client-api-key" },
      body: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit\r\n--${boundary}--\r\n`, "utf8"),
    });
    assert.equal(edit.status, 401);
    const editResult = await edit.json();
    assert.equal(editResult.error.code, "official_auth_missing");
    assert.doesNotMatch(JSON.stringify(editResult), /client-api-key/);

    const jsonEdit = await fetch(`http://127.0.0.1:${relay.address().port}/v1/images/edits`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-api-key" },
      body: JSON.stringify({ prompt: "edit", images: [{ b64_json: "AAEC/w==" }] }),
    });
    assert.equal(jsonEdit.status, 401);
    const jsonEditResult = await jsonEdit.json();
    assert.equal(jsonEditResult.error.code, "official_auth_missing");
    assert.doesNotMatch(JSON.stringify(jsonEditResult), /client-api-key/);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("conversation protection skips a deliberately deleted conversation only when its file and index row are both gone", () => {
  resetTestState();
  const codexHome = path.dirname(store.paths().codexConfig);
  const sessions = path.join(codexHome, "sessions", "2026", "07", "19");
  fs.mkdirSync(sessions, { recursive: true });
  const deletedId = "019f77fb-0787-76b1-a1a8-1ae8fe10da86";
  const keptId = "019f77fd-f605-7780-a51d-7477990ed342";
  const deletedName = `rollout-2026-07-19T09-26-13-${deletedId}.jsonl`;
  const keptName = `rollout-2026-07-19T09-29-25-${keptId}.jsonl`;
  const deletedPath = path.join(sessions, deletedName);
  const keptPath = path.join(sessions, keptName);
  fs.writeFileSync(deletedPath, '{"id":"deleted"}\n', "utf8");
  fs.writeFileSync(keptPath, '{"id":"kept"}\n', "utf8");
  const state = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL);");
  state.prepare("INSERT INTO threads VALUES (?, ?)").run(deletedId, "openai");
  state.prepare("INSERT INTO threads VALUES (?, ?)").run(keptId, "openai");
  state.close();
  const baseline = store.currentSessionInventory();

  fs.rmSync(deletedPath);
  const afterDelete = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  afterDelete.prepare("DELETE FROM threads WHERE id = ?").run(deletedId);
  afterDelete.close();
  const deleted = store.verifySessionProtection(baseline);
  assert.equal(deleted.safe, true);
  assert.deepEqual(deleted.deleted, [deletedName.toLowerCase()]);
  assert.deepEqual(deleted.deletedSessionIds, [deletedId]);

  fs.rmSync(keptPath);
  const fileOnly = store.verifySessionProtection(baseline);
  assert.equal(fileOnly.safe, false);
  assert.deepEqual(fileOnly.missing, [keptName.toLowerCase()]);

  fs.writeFileSync(keptPath, '{"id":"kept"}\n', "utf8");
  const withoutIndex = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  withoutIndex.prepare("DELETE FROM threads WHERE id = ?").run(keptId);
  withoutIndex.close();
  const indexOnly = store.verifySessionProtection(baseline);
  assert.equal(indexOnly.safe, false);
  assert.deepEqual(indexOnly.missingIndex, [keptName.toLowerCase()]);
});

test("Relay onboarding is independent from other switchers", () => {
  const config = { providerIdentity: "custom" };
  assert.equal(onboardingState(settings(), config, { signedIn: false }, { configMatches: false }).stage, "ready_third_party");
  assert.equal(onboardingState(settings({ official: { verified: true } }), config, { signedIn: false }, { configMatches: false }).stage, "ready_with_official");
  assert.equal(onboardingState(settings(), config, { signedIn: true }, { configMatches: false }).stage, "verify_official");
  assert.equal(onboardingState(settings(), config, { signedIn: false }, { configMatches: true }).stage, "relay_active");
});

test("apply replaces only managed root settings and restore returns the original file", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = [
    'model_provider = "custom"',
    'model = "old-model"',
    'model_reasoning_effort = "xhigh"',
    'openai_base_url = "https://example.invalid"',
    "",
    "[model_providers.custom]",
    'name = "Existing CC Switch provider"',
    'base_url = "https://old-provider.example/v1"',
    'wire_api = "responses"',
    "",
    "[desktop]",
    'localeOverride = "zh-CN"',
    "",
  ].join("\n");
  fs.writeFileSync(target, original, "utf8");

  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const applied = fs.readFileSync(target, "utf8");
  assert.match(applied, /^# BEGIN CODEX RELAY/m);
  assert.match(applied, /model_provider = "openai"/);
  assert.doesNotMatch(applied, /^model_provider = "custom"$/m);
  assert.doesNotMatch(applied, /^model_reasoning_effort\s*=/m);
  assert.match(applied, /openai_base_url = "http:\/\/127\.0\.0\.1:15723\/v1"/);
  assert.match(applied, /\[model_providers\.custom\][\s\S]*base_url = "https:\/\/old-provider\.example\/v1"/);
  assert.match(applied, /\[desktop\]/);
  assert.equal(store.relayHandoffSnapshot().providerIdentity, "custom");
  assert.equal(store.relayHandoffSnapshot().defaultModel, "old-model");

  const restored = store.restoreRelayHandoff();
  assert.equal(restored.verified, true);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("preflight reports the existing Codex provider and config writability", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'model_provider = "custom"\n', "utf8");
  const preflight = store.codexConfigPreflight();
  assert.equal(preflight.writable, true);
  assert.equal(preflight.configExists, true);
  assert.equal(preflight.providerIdentity, "custom");
});

test("Relay preserves the current handoff while it remains applied", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");
  const first = store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const snapshot = store.relayHandoffSnapshot();
  const second = store.applyRelayConfig({ model: "relay-third-party-2", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });

  assert.equal(first.handoff.created, true);
  assert.equal(second.handoff.created, false);
  assert.deepEqual(store.relayHandoffSnapshot(), snapshot);
  store.restorePreRelayState();
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("each new Relay session restores the exact state that existed before that session", () => {
  resetTestState();
  const config = store.paths().codexConfig;
  const auth = store.paths().codexAuth;
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const officialConfig = 'model_provider = "openai"\nmodel = "official-model"\n';
  const officialAuth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "official-token", refresh_token: "official-refresh" } });
  fs.writeFileSync(config, officialConfig, "utf8");
  fs.writeFileSync(auth, officialAuth, "utf8");
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const firstExit = store.restoreRelayHandoff();
  assert.equal(firstExit.verified, true);
  assert.equal(firstExit.authVerified, true);
  assert.equal(fs.readFileSync(config, "utf8"), officialConfig);
  assert.equal(fs.readFileSync(auth, "utf8"), officialAuth);
  assert.equal(store.restorePreview().available, false);

  const thirdPartyConfig = 'model_provider = "custom"\nmodel = "third-party-model"\n\n[model_providers.custom]\nbase_url = "https://relay.example/v1"\n';
  const thirdPartyAuth = JSON.stringify({ OPENAI_API_KEY: "third-party-api-key" });
  fs.writeFileSync(config, thirdPartyConfig, "utf8");
  fs.writeFileSync(auth, thirdPartyAuth, "utf8");
  store.applyRelayConfig({ model: "relay-third-party-2", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const secondExit = store.restoreRelayHandoff();
  assert.equal(secondExit.verified, true);
  assert.equal(secondExit.authVerified, true);
  assert.equal(fs.readFileSync(config, "utf8"), thirdPartyConfig);
  assert.equal(fs.readFileSync(auth, "utf8"), thirdPartyAuth);
});

test("a failed apply transaction restores the exact configuration that existed immediately before it", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n', "utf8");
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const workingRelayConfig = fs.readFileSync(target, "utf8");

  const pending = store.applyRelayConfig({ model: "relay-third-party-2", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1", deferCommit: true });
  assert.notEqual(fs.readFileSync(target, "utf8"), workingRelayConfig);
  const rollback = store.rollbackRelayConfig(pending.transaction);

  assert.equal(rollback.restored, true);
  assert.equal(fs.readFileSync(target, "utf8"), workingRelayConfig);
  assert.equal(store.relayApplicationStatus().configMatches, true);
});

test("a failed first apply leaves no false Relay applied marker", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "keep-me"\n\n[model_providers.custom]\nbase_url = "https://provider.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const pending = store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1", deferCommit: true });
  store.rollbackRelayConfig(pending.transaction);

  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(store.relayApplicationStatus().applied, false);
});

test("restore warns about configuration drift but still verifies the original snapshot", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  fs.appendFileSync(target, "\n# Changed by another tool while Relay was applied\n", "utf8");
  assert.equal(store.restorePreview().configurationChanged, true);
  const restored = store.restorePreRelayState();
  assert.equal(restored.configurationChanged, true);
  assert.equal(restored.verified, true);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("restore keeps configured providers, encrypted keys, context, and the original backup", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");
  const configured = settings();
  store.replaceSettings(configured);
  store.saveProviderKey("deepseek", "restore-preserved-key");
  const context = [{ id: "relay_restore", routeId: "relay-third-party-1", messages: [{ role: "user", content: "keep this context" }] }];
  store.saveContextCache(context);
  requestHistory.appendRequestHistory({ at: "2026-07-15T12:00:00.000Z", status: 200, ok: true, route: { id: "relay-third-party-1", displayName: "Preserved", kind: "third_party", providerName: "DeepSeek", upstreamModel: "deepseek-v4" } });
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const snapshot = store.relayHandoffSnapshot();

  const restored = store.restorePreRelayState();
  assert.equal(restored.verified, true);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.deepEqual(store.loadSettings().thirdPartySlots, configured.thirdPartySlots.map((slot) => ({ ...slot, reasoningPreset: "auto" })));
  assert.equal(store.providerKey("deepseek"), "restore-preserved-key");
  assert.deepEqual(store.loadContextCache(), context);
  assert.equal(requestHistory.requestHistoryCount(), 1);
  assert.equal(store.relayHandoffSnapshot(), null);
  assert.equal(store.relayApplicationStatus().applied, false);
});

test("request history persists the latest ten thousand sanitized records and clears only explicitly", () => {
  resetTestState();
  const records = Array.from({ length: 10_005 }, (_, index) => ({
    at: new Date(1_750_000_000_000 + index).toISOString(),
    status: 200,
    ok: true,
    durationMs: index,
    route: { id: "relay-third-party-1", displayName: `model-${index}`, kind: "third_party", providerName: "provider", upstreamModel: "gpt-5.6-sol" },
    usage: { input: index, output: 1, total: index + 1 },
    prompt: "private-prompt-must-not-be-persisted",
    apiKey: "private-key-must-not-be-persisted",
  }));
  const saved = requestHistory.appendRequestHistory(records);
  assert.deepEqual(saved, { inserted: 10_005, trimmed: 5, total: 10_000 });

  const firstPage = requestHistory.listRequestHistory({ limit: 200 });
  assert.equal(firstPage.total, 10_000);
  assert.equal(firstPage.items.length, 200);
  assert.equal(firstPage.items[0].route.displayName, "model-10004");
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.retainedLimit, 10_000);
  const secondPage = requestHistory.listRequestHistory({ limit: 200, beforeId: firstPage.nextBeforeId });
  assert.equal(secondPage.items.length, 200);
  assert.ok(secondPage.items[0].historyId < firstPage.items.at(-1).historyId);
  let cursor = null;
  let oldest = null;
  do {
    const page = requestHistory.listRequestHistory({ limit: 200, beforeId: cursor });
    oldest = page.items.at(-1) || oldest;
    cursor = page.hasMore ? page.nextBeforeId : null;
  } while (cursor);
  assert.equal(oldest.route.displayName, "model-5");

  const rawDatabase = fs.readFileSync(requestHistory.requestHistoryPath());
  assert.equal(rawDatabase.includes(Buffer.from("private-prompt-must-not-be-persisted")), false);
  assert.equal(rawDatabase.includes(Buffer.from("private-key-must-not-be-persisted")), false);
  const statisticsBeforeClear = requestHistory.usageStatistics();
  assert.equal(statisticsBeforeClear.overall.total.requestCount, 10_005);
  assert.equal(statisticsBeforeClear.overall.total.usageCount, 10_005);
  assert.equal(statisticsBeforeClear.overall.total.totalTokens, 50_055_015);
  assert.deepEqual(requestHistory.clearRequestHistory(), { deleted: 10_000, total: 0, retainedLimit: 10_000 });
  assert.equal(requestHistory.requestHistoryCount(), 0);
  const statisticsAfterClear = requestHistory.usageStatistics();
  assert.equal(statisticsAfterClear.overall.total.requestCount, 10_005);
  assert.equal(statisticsAfterClear.overall.total.totalTokens, 50_055_015);

  requestHistory.appendRequestHistory({
    at: new Date().toISOString(), status: 200, ok: true, durationMs: 1,
    route: { id: "relay-third-party-1", displayName: "DeepSeek", kind: "third_party", providerName: "DeepSeek", upstreamModel: "deepseek-v4-pro" },
    diagnostics: { savings: { enabled: true, applied: true, level: "high", estimatedInputTokensBefore: 8_000, estimatedInputTokensAfter: 5_000, estimatedTokensSaved: 3_000, prunedToolOutputs: 2, protectedRecentToolOutputs: 6, privateExcerpt: "private-tool-output" } },
  });
  const sanitized = requestHistory.listRequestHistory({ limit: 1 }).items[0].diagnostics.savings;
  assert.deepEqual(sanitized, { enabled: true, applied: true, level: "high", estimatedInputTokensBefore: 8_000, estimatedInputTokensAfter: 5_000, estimatedTokensSaved: 3_000, prunedToolOutputs: 2, protectedRecentToolOutputs: 6 });
  assert.equal(fs.readFileSync(requestHistory.requestHistoryPath()).includes(Buffer.from("private-tool-output")), false);
  requestHistory.clearRequestHistory();
});

test("Relay stays active when Codex changes only the selected model or reasoning effort", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'model_provider = "custom"\nmodel = "before-relay"\n', "utf8");
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });

  const changed = fs.readFileSync(target, "utf8")
    .replace('model = "relay-third-party-1"', 'model = "relay-third-party-2"')
    .replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "xhigh"');
  fs.writeFileSync(target, changed, "utf8");

  const status = store.relayApplicationStatus();
  assert.equal(status.configMatches, true);
  assert.equal(status.configShaMatches, false);
  assert.equal(status.configurationChanged, true);
});

test("restore refuses to touch config or auth while Codex is running", () => {
  resetTestState();
  const config = store.paths().codexConfig;
  const auth = store.paths().codexAuth;
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, 'model_provider = "custom"\nmodel = "before-guard"\n', "utf8");
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "before-guard", refresh_token: "before-guard-refresh" } }), "utf8");
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const relayConfig = fs.readFileSync(config, "utf8");
  const relayAuth = fs.readFileSync(auth, "utf8");

  assert.throws(
    () => ensureCodexClosedForRestore({ codexRunning: true, codexCount: 1 }),
    (error) => error.statusCode === 409 && error.code === "codex_running_for_restore",
  );
  assert.equal(fs.readFileSync(config, "utf8"), relayConfig);
  assert.equal(fs.readFileSync(auth, "utf8"), relayAuth);
  assert.notEqual(store.relayHandoffSnapshot(), null);
});

test("official direct mode removes Relay routing, restores official auth, and keeps the pre-Relay snapshot", () => {
  resetTestState();
  const config = store.paths().codexConfig;
  const auth = store.paths().codexAuth;
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const officialAuth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "official-direct-token", refresh_token: "official-direct-refresh", account_id: "official-direct-account" } });
  fs.writeFileSync(auth, officialAuth, "utf8");
  assert.equal(store.captureOfficialAuth().captured, true);
  const preRelayConfig = 'model_provider = "custom"\nmodel = "cc-switch-model"\n\n[model_providers.custom]\nbase_url = "https://cc-switch.example/v1"\n';
  const preRelayAuth = JSON.stringify({ OPENAI_API_KEY: "cc-switch-key" });
  fs.writeFileSync(config, preRelayConfig, "utf8");
  fs.writeFileSync(auth, preRelayAuth, "utf8");
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port: 15723, running: true } }));
  store.saveProviderKey("deepseek", "official-direct-preserved-key");
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1", restoreOfficial: true });

  const direct = store.switchToOfficialDirect();
  const directConfig = fs.readFileSync(config, "utf8");
  assert.equal(direct.switched, true);
  assert.equal(direct.verified, true);
  assert.equal(direct.authAction, "preserve_current");
  assert.equal(direct.preRelaySnapshotRetained, true);
  assert.match(directConfig, /^model_provider = "openai"$/m);
  assert.doesNotMatch(directConfig, /# BEGIN CODEX RELAY|model_catalog_json|openai_base_url/);
  assert.match(directConfig, /\[model_providers\.custom\]/);
  assert.equal(fs.readFileSync(auth, "utf8"), officialAuth);
  assert.equal(store.codexLoginStatus().authType, "official");
  assert.equal(store.loadSettings().router.running, false);
  assert.equal(store.relayApplicationStatus().applied, false);
  assert.equal(store.restorePreview().available, true);
  assert.equal(store.providerKey("deepseek"), "official-direct-preserved-key");
});

test("official direct mode rolls back when no official sign-in is available", () => {
  resetTestState();
  const config = store.paths().codexConfig;
  const auth = store.paths().codexAuth;
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, 'model_provider = "custom"\nmodel = "api-key-only"\n', "utf8");
  fs.writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: "only-api-key" }), "utf8");
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port: 15723, running: true } }));
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const relayConfig = fs.readFileSync(config, "utf8");
  const relayAuth = fs.readFileSync(auth, "utf8");

  assert.throws(() => store.switchToOfficialDirect(), (error) => error.code === "official_auth_restore_failed");
  assert.equal(fs.readFileSync(config, "utf8"), relayConfig);
  assert.equal(fs.readFileSync(auth, "utf8"), relayAuth);
  assert.equal(store.loadSettings().router.running, true);
  assert.equal(store.relayApplicationStatus().applied, true);
});

test("official direct API exits Relay without deleting the original handoff", async () => {
  resetTestState();
  const port = await reservePort();
  const config = store.paths().codexConfig;
  const auth = store.paths().codexAuth;
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const officialAuth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "official-direct-api-token", refresh_token: "official-direct-api-refresh" } });
  fs.writeFileSync(auth, officialAuth, "utf8");
  store.captureOfficialAuth();
  fs.writeFileSync(config, 'model_provider = "custom"\nmodel = "before-official-direct-api"\n', "utf8");
  fs.writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: "before-official-direct-api" }), "utf8");
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: true } }));
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: `http://127.0.0.1:${port}/v1`, restoreOfficial: true });
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/official-direct`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.verified, true);
    assert.equal(result.preRelaySnapshotRetained, true);
    assert.equal(store.loadSettings().router.running, false);
    assert.equal(store.relayApplicationStatus().applied, false);
    assert.equal(store.restorePreview().available, true);
    assert.match(fs.readFileSync(config, "utf8"), /^model_provider = "openai"$/m);
    assert.doesNotMatch(fs.readFileSync(config, "utf8"), /openai_base_url|model_catalog_json|# BEGIN CODEX RELAY/);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("usage statistics separate periods and providers without double counting retries", () => {
  resetTestState();
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const prior = new Date(today);
  prior.setDate(prior.getDate() - 1);
  const todayKey = localUsageDayKey(today);
  const firstBlue = {
    at: today.toISOString(), status: 200, ok: true,
    route: { id: "relay-third-party-1", displayName: "Blue", kind: "third_party", providerId: "blue", providerName: "Blue", upstreamModel: "shared-model" },
    usage: { input: 100, cachedInput: 90, uncachedInput: 10, cacheReported: true, output: 10, total: 110 },
  };
  const records = [
    firstBlue,
    {
      at: new Date(today.getTime() + 1_000).toISOString(), status: 200, ok: true,
      route: { id: "relay-third-party-2", displayName: "Blue fallback", kind: "third_party", providerId: "blue", providerName: "Blue", upstreamModel: "shared-model" },
      usage: { input: 900, cachedInput: 0, uncachedInput: 900, cacheReported: true, output: 10, total: 910 },
    },
    {
      at: new Date(today.getTime() + 2_000).toISOString(), status: 502, ok: false,
      route: { id: "relay-third-party-3", displayName: "No usage", kind: "third_party", providerId: "no-usage", providerName: "No usage", upstreamModel: "missing-usage-model" },
    },
    {
      at: new Date(today.getTime() + 3_000).toISOString(), status: 200, ok: true,
      route: { id: "official-default", displayName: "Official", kind: "official", providerName: "Official Codex", upstreamModel: "gpt-5.6-sol" },
      usage: { input: 50, output: 5, total: 55 },
    },
    {
      at: prior.toISOString(), status: 200, ok: true,
      route: { id: "relay-third-party-4", displayName: "Former", kind: "third_party", providerId: "deleted-provider", providerName: "Former provider", upstreamModel: "former-model" },
      usage: { input: 20, output: 5, total: 25 },
    },
  ];
  assert.deepEqual(requestHistory.appendRequestHistory(records), { inserted: 5, trimmed: 0, total: 5 });
  assert.deepEqual(requestHistory.appendRequestHistory(firstBlue), { inserted: 0, trimmed: 0, total: 5 });

  const statistics = requestHistory.usageStatistics({ dayKey: todayKey });
  assert.equal(statistics.overall.today.requestCount, 4);
  assert.equal(statistics.overall.today.usageCount, 3);
  assert.equal(statistics.overall.today.usageCoverage, 75);
  assert.equal(statistics.overall.today.totalTokens, 1_075);
  assert.equal(statistics.overall.today.cacheHitRate, 9);
  assert.equal(statistics.overall.today.cacheCoverage, 50);
  assert.equal(statistics.overall.total.requestCount, 5);
  assert.equal(statistics.overall.total.totalTokens, 1_100);

  const blue = statistics.providers.find((provider) => provider.providerId === "blue");
  assert.equal(blue.today.requestCount, 2);
  assert.equal(blue.today.totalTokens, 1_020);
  assert.equal(blue.today.cacheHitRate, 9);
  assert.equal(blue.total.cacheHitRate, 9);
  assert.equal(statistics.providers.find((provider) => provider.providerId === "official").total.totalTokens, 55);
  assert.equal(statistics.providers.find((provider) => provider.providerId === "no-usage").today.usageCount, 0);
  assert.equal(statistics.providers.find((provider) => provider.providerId === "deleted-provider").today.requestCount, 0);
  assert.equal(statistics.models.find((model) => model.upstreamModel === "shared-model").total.totalTokens, 1_020);
  assert.equal(statistics.trend.days, 30);
  assert.equal(statistics.trend.items.length, 30);
  assert.equal(statistics.trend.items.at(-1).dayKey, todayKey);
  assert.equal(statistics.trend.items.at(-1).requestCount, 4);
  assert.equal(statistics.trend.items.at(-2).requestCount, 1);
  assert.equal(statistics.trend.items.at(-3).requestCount, 0);

  requestHistory.clearRequestHistory();
  const afterClear = requestHistory.usageStatistics({ dayKey: todayKey });
  assert.equal(afterClear.overall.total.requestCount, 5);
  assert.equal(afterClear.overall.total.totalTokens, 1_100);
});

test("S4-A performance baseline preserves missing usage and aggregates cache, retries, latency, and bytes", () => {
  const privateFields = { prompt: "do-not-report", apiKey: "secret-key", taskId: "private-task" };
  const route = { id: "relay-third-party-1", displayName: "Blue", kind: "third_party", providerId: "blue", providerName: "Blue", upstreamModel: "gpt-pool" };
  const events = [
    {
      at: "2026-07-20T00:00:00.000Z", route, status: 200, ok: true, durationMs: 1_000, contextMode: "new",
      stream: { streaming: true, headersMs: 200, firstChunkMs: 400 },
      diagnostics: { attempts: 1, upstreamAttempts: 1, inboundBytes: 100, upstreamBytes: 90, relayAddedBytes: 0 },
      usage: { input: 100, cachedInput: 80, uncachedInput: 20, cacheReported: true, output: 10, reasoningOutput: 2, total: 110 },
      ...privateFields,
    },
    {
      at: "2026-07-20T00:01:00.000Z", route, status: 499, ok: false, durationMs: 2_000, contextMode: "portable_context",
      stream: { streaming: true, headersMs: 300, firstChunkMs: 600 },
      diagnostics: { attempts: 2, upstreamAttempts: 2, inboundBytes: 200, upstreamBytes: 180, relayAddedBytes: 0, compactionStrategy: "model_summary" },
      contextPressure: { cancelled: true },
      usage: { input: null, output: null, total: null, cacheReported: false },
      ...privateFields,
    },
    {
      at: "2026-07-20T00:02:00.000Z",
      route: { id: "gpt-5.6-terra", displayName: "Terra", kind: "official", providerId: "official", providerName: "Official Codex", upstreamModel: "gpt-5.6-terra" },
      status: 200, ok: true, durationMs: 500, usage: { input: 1, output: 1, total: 2 }, ...privateFields,
    },
  ];

  const report = buildPerformanceBaseline(events, { routeKind: "third_party", generatedAt: "2026-07-20T00:03:00.000Z" });
  assert.equal(report.sampleCount, 2);
  assert.equal(report.groups.length, 1);
  const group = report.groups[0];
  assert.deepEqual(group.requests, { requests: 2, succeeded: 1, failed: 1, streaming: 2, cancelled: 1, retryRequests: 1, attempts: 3, upstreamAttempts: 3, compactions: 0 });
  assert.deepEqual(group.latency.durationMs, { count: 2, min: 1_000, median: 1_500, p95: 2_000, max: 2_000 });
  assert.deepEqual(group.latency.firstChunkMs, { count: 2, min: 400, median: 500, p95: 600, max: 600 });
  assert.deepEqual(group.bytes.upstream, { count: 2, min: 90, median: 135, p95: 180, max: 180 });
  assert.deepEqual(group.latency.successfulDurationMs, { count: 1, min: 1_000, median: 1_000, p95: 1_000, max: 1_000 });
  assert.deepEqual(group.bytes.successfulUpstream, { count: 1, min: 90, median: 90, p95: 90, max: 90 });
  assert.deepEqual(group.usage, { reportedCount: 1, coveragePercent: 50, cacheReportedCount: 1, cacheCoveragePercent: 50, inputTokens: 100, cachedInputTokens: 80, uncachedInputTokens: 20, weightedCacheHitPercent: 80, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110 });
  assert.deepEqual(group.contextModes, { new: 1, portable_context: 1 });
  assert.deepEqual(group.statuses, { 200: 1, 499: 1 });
  assert.deepEqual(group.compactionStrategies, { model_summary: 1 });
  assert.equal(report.interpretation.byteMetricsAreNotTokenCost, true);
  assert.doesNotMatch(JSON.stringify(report), /do-not-report|secret-key|private-task/);
  const missingUsage = buildPerformanceBaseline([events[1]], { routeKind: "third_party", generatedAt: "2026-07-20T00:03:00.000Z" }).groups[0].usage;
  assert.deepEqual({ inputTokens: missingUsage.inputTokens, totalTokens: missingUsage.totalTokens, weightedCacheHitPercent: missingUsage.weightedCacheHitPercent }, { inputTokens: null, totalTokens: null, weightedCacheHitPercent: null });
});

test("usage statistics safely reconcile unique legacy provider identities", () => {
  resetTestState();
  const at = new Date().toISOString();
  requestHistory.appendRequestHistory([
    { at, status: 200, ok: true, route: { id: "old-blue", displayName: "Blue legacy", kind: "third_party", providerName: "Blue", upstreamModel: "blue-model" }, usage: { input: 10, output: 2, total: 12 } },
    { at: new Date(Date.now() + 1_000).toISOString(), status: 200, ok: true, route: { id: "blue-slot", displayName: "Blue", kind: "third_party", providerId: "blue", providerName: "Blue", upstreamModel: "blue-model" }, usage: { input: 20, output: 3, total: 23 } },
    { at: new Date(Date.now() + 2_000).toISOString(), status: 200, ok: true, route: { id: "old-shared", displayName: "Shared", kind: "third_party", providerName: "Shared name", upstreamModel: "shared-model" }, usage: { input: 4, output: 1, total: 5 } },
    { at: new Date(Date.now() + 3_000).toISOString(), status: 200, ok: true, route: { id: "removed", displayName: "Removed", kind: "third_party", providerName: "Removed name", upstreamModel: "removed-model" }, usage: { input: 5, output: 1, total: 6 } },
  ]);
  const providerIdentities = [
    { providerId: "blue", providerName: " Blue " },
    { providerId: "shared-a", providerName: "Shared name" },
    { providerId: "shared-b", providerName: "Shared name" },
  ];
  const first = requestHistory.usageStatistics({ providerIdentities });
  assert.equal(first.providers.find((provider) => provider.providerId === "blue").total.totalTokens, 35);
  assert.equal(first.providers.some((provider) => provider.providerId === "legacy:Blue"), false);
  assert.equal(first.providers.some((provider) => provider.providerId === "legacy:Shared name"), true);
  assert.equal(first.providers.some((provider) => provider.providerId === "legacy:Removed name"), true);

  const repeated = requestHistory.usageStatistics({ providerIdentities });
  assert.equal(repeated.providers.find((provider) => provider.providerId === "blue").total.totalTokens, 35);
  requestHistory.clearRequestHistory();
});

test("request history worker keeps every queued request in the permanent ledger", async () => {
  resetTestState();
  const records = Array.from({ length: 10_005 }, (_, index) => ({
    at: new Date(1_780_000_000_000 + index).toISOString(), status: 200, ok: true,
    route: { id: "relay-third-party-1", displayName: "Queued", kind: "third_party", providerId: "queued", providerName: "Queued", upstreamModel: "queued-model" },
    usage: { input: 1, output: 1, total: 2 },
  }));
  try {
    assert.equal(requestHistory.enqueueRequestHistory(records).queued, 10_005);
    await requestHistory.flushRequestHistory({ timeoutMs: 60_000 });
    assert.equal(requestHistory.listRequestHistory({ limit: 1 }).total, 10_000);
    const statistics = requestHistory.usageStatistics();
    assert.equal(statistics.overall.total.requestCount, 10_005);
    assert.equal(statistics.overall.total.totalTokens, 20_010);
  } finally {
    await requestHistory.closeRequestHistoryWriter().catch(() => {});
    requestHistory.clearRequestHistory();
  }
});

test("usage statistics API keeps deleted providers and exposes no request secrets", async () => {
  resetTestState();
  store.replaceSettings(settings({
    providers: [{ id: "blue", name: "Blue current", baseUrl: "https://blue.example/v1", apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Blue", providerId: "blue", upstreamModel: "blue-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  const at = new Date().toISOString();
  requestHistory.appendRequestHistory([
    { at, status: 200, ok: true, route: { id: "official-default", displayName: "Official", kind: "official", upstreamModel: "gpt-5.6-sol" }, usage: { input: 4, output: 2, total: 6 }, prompt: "private-prompt" },
    { at, status: 200, ok: true, route: { id: "relay-third-party-1", displayName: "Blue", kind: "third_party", providerId: "blue", providerName: "Old Blue name", upstreamModel: "blue-model" }, usage: { input: 6, output: 2, total: 8 }, apiKey: "private-key" },
    { at, status: 200, ok: true, route: { id: "removed-slot", displayName: "Removed", kind: "third_party", providerId: "removed", providerName: "Removed upstream", upstreamModel: "removed-model" }, usage: { input: 8, output: 2, total: 10 }, request: { taskId: "private-task" } },
  ]);
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/usage-statistics`);
    assert.equal(response.status, 200);
    const raw = await response.text();
    const data = JSON.parse(raw);
    assert.deepEqual(data.providers.map((provider) => provider.providerId), ["official", "blue", "removed"]);
    assert.equal(data.providers[1].providerName, "Blue current");
    assert.equal(data.providers[1].deleted, false);
    assert.equal(data.providers[2].deleted, true);
    assert.equal(data.overall.total.totalTokens, 24);
    assert.equal(data.trend.items.length, 30);
    assert.equal(data.synchronization.status, "synchronized");
    assert.equal(data.synchronization.pending, 0);
    assert.equal(data.synchronization.lastError, null);
    assert.doesNotMatch(raw, /private-prompt|private-key|private-task|fingerprint|taskId/i);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    requestHistory.clearRequestHistory();
  }
});

test("request history preserves safe Compact diagnostics without storing route fingerprints", () => {
  resetTestState();
  requestHistory.appendRequestHistory({
    at: new Date().toISOString(), status: 200, ok: true, durationMs: 12, contextMode: "compact",
    route: { id: "relay-third-party-1", displayName: "Compact", kind: "third_party", providerName: "Responses", upstreamModel: "gpt-5.6-sol" },
    diagnostics: {
      isCompaction: true,
      compactionStrategy: "local_emergency",
      compactionFingerprint: "private-compaction-fingerprint",
      cacheHit: false,
      deduplicated: true,
      circuitOpen: true,
      failureReason: "upstream_timeout",
      nativeCompact: { attempted: true, capabilityBefore: "unknown", outcome: "temporary_failure", reason: "upstream_timeout", routeSignature: "private-route-signature" },
    },
  });
  const diagnostics = requestHistory.listRequestHistory({ limit: 1 }).items[0].diagnostics;
  assert.deepEqual({
    isCompaction: diagnostics.isCompaction,
    compactionStrategy: diagnostics.compactionStrategy,
    cacheHit: diagnostics.cacheHit,
    deduplicated: diagnostics.deduplicated,
    circuitOpen: diagnostics.circuitOpen,
    failureReason: diagnostics.failureReason,
    nativeCompact: diagnostics.nativeCompact,
  }, {
    isCompaction: true,
    compactionStrategy: "local_emergency",
    cacheHit: false,
    deduplicated: true,
    circuitOpen: true,
    failureReason: "upstream_timeout",
    nativeCompact: { attempted: true, capabilityBefore: "unknown", outcome: "temporary_failure", reason: "upstream_timeout" },
  });
  const database = fs.readFileSync(requestHistory.requestHistoryPath());
  assert.equal(database.includes(Buffer.from("private-compaction-fingerprint")), false);
  assert.equal(database.includes(Buffer.from("private-route-signature")), false);
  requestHistory.clearRequestHistory();
});

test("request history writer batches bursts and flushes sanitized records", async () => {
  resetTestState();
  const beforeBatches = requestHistory.requestHistoryWriterState().batches;
  const records = Array.from({ length: 90 }, (_, index) => ({
    at: new Date(1_760_000_000_000 + index).toISOString(),
    status: 502,
    ok: false,
    durationMs: index,
    route: { id: "relay-third-party-1", displayName: `batched-${index}`, kind: "third_party", providerName: "Responses", upstreamModel: "gpt-5.6-sol" },
    diagnostics: { attempts: 1, retryProtection: { active: true, blocked: false, triggerStatus: 502, retryAfterSeconds: 600, bytesAvoided: 0, retryAllowed: true, scope: "turn", privateValue: "do-not-store" } },
    privatePrompt: "private-batched-prompt",
  }));
  try {
    const queued = requestHistory.enqueueRequestHistory(records);
    assert.equal(queued.queued, 90);
    assert.equal(queued.pending, 90);
    await requestHistory.flushRequestHistory();
    const writerState = requestHistory.requestHistoryWriterState();
    assert.equal(writerState.pending, 0);
    assert.equal(writerState.inFlight, 0);
    assert.equal(writerState.batches - beforeBatches, 3);
    const persisted = requestHistory.listRequestHistory({ limit: 100 });
    assert.equal(persisted.total, 90);
    assert.equal(persisted.items[0].route.displayName, "batched-89");
    assert.deepEqual(persisted.items[0].diagnostics.retryProtection, { active: true, blocked: false, triggerStatus: 502, retryAfterSeconds: 600, bytesAvoided: 0, retryAllowed: true, scope: "turn" });
    const databaseBytes = [requestHistory.requestHistoryPath(), `${requestHistory.requestHistoryPath()}-wal`]
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file));
    assert.equal(databaseBytes.some((content) => content.includes(Buffer.from("private-batched-prompt"))), false);
    assert.equal(databaseBytes.some((content) => content.includes(Buffer.from("do-not-store"))), false);

    await requestHistory.closeRequestHistoryWriter();
    requestHistory.clearRequestHistory();
    requestHistory.enqueueRequestHistory({ at: new Date().toISOString(), status: 200, ok: true, route: { id: "warm-close", displayName: "warm-close", kind: "third_party", providerName: "warm", upstreamModel: "warm" } });
    await requestHistory.flushRequestHistory();
    requestHistory.clearRequestHistory();
    const lockedDatabase = new DatabaseSync(requestHistory.requestHistoryPath());
    let locked = false;
    try {
      lockedDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 100; BEGIN IMMEDIATE");
      locked = true;
      requestHistory.enqueueRequestHistory(Array.from({ length: 32 }, (_, index) => ({
        at: new Date(1_765_000_000_000 + index).toISOString(), status: 502, ok: false,
        route: { id: "close-timeout", displayName: `close-timeout-${index}`, kind: "third_party", providerName: "locked", upstreamModel: "locked" },
      })));
      await assert.rejects(requestHistory.closeRequestHistoryWriter({ timeoutMs: 300 }), /flush timed out/);
      const afterTimeout = requestHistory.requestHistoryWriterState();
      assert.equal(afterTimeout.active, false);
      assert.equal(afterTimeout.closing, false);
      assert.equal(afterTimeout.inFlight, 0);
      assert.equal(afterTimeout.pending, 32);
      lockedDatabase.exec("ROLLBACK");
      locked = false;
    } finally {
      if (locked) {
        try { lockedDatabase.exec("ROLLBACK"); } catch { /* Best-effort test cleanup. */ }
      }
      lockedDatabase.close();
    }
    requestHistory.enqueueRequestHistory({
      at: new Date(1_765_000_000_100).toISOString(), status: 200, ok: true,
      route: { id: "after-close-timeout", displayName: "after-close-timeout", kind: "third_party", providerName: "recovered", upstreamModel: "recovered" },
    });
    await requestHistory.flushRequestHistory();
    assert.equal(requestHistory.listRequestHistory({ limit: 100 }).total, 33);
  } finally {
    await requestHistory.closeRequestHistoryWriter().catch(() => {});
    requestHistory.clearRequestHistory();
  }
});

test("request history worker keeps Relay responsive under a SQLite write lock and server close flushes the tail", async () => {
  resetTestState();
  let upstreamCount = 0;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    upstreamCount += 1;
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "temporary gateway failure" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  let relayClosed = false;
  let lockDatabase = null;
  let locked = false;
  try {
    store.replaceSettings(settings({
      router: { host: "127.0.0.1", port: relay.address().port, running: true },
      providers: [{ id: "locked-history", name: "Locked history", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Locked history", providerId: "locked-history", upstreamModel: "gpt-5.6-sol", contextWindow: 372000, supportsImages: true, dropParams: [] }],
    }));
    store.saveProviderKey("locked-history", "locked-history-key");
    requestHistory.enqueueRequestHistory({ at: new Date().toISOString(), status: 200, ok: true, route: { id: "warm", displayName: "warm", kind: "third_party", providerName: "warm", upstreamModel: "warm" } });
    await requestHistory.flushRequestHistory();
    requestHistory.clearRequestHistory();

    lockDatabase = new DatabaseSync(requestHistory.requestHistoryPath());
    lockDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 100; BEGIN IMMEDIATE");
    locked = true;
    const endpoint = `http://127.0.0.1:${relay.address().port}`;
    const started = Date.now();
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "small locked history request", stream: false, client_metadata: { thread_id: "locked-history-task", turn_id: "locked-history-turn" } }),
    });
    await response.text();
    const responseMs = Date.now() - started;
    assert.equal(response.status, 502);
    assert.equal(upstreamCount, 1);
    assert.ok(responseMs < 1_500, `response should not wait for SQLite busy_timeout, got ${responseMs} ms`);

    const state = await (await fetch(`${endpoint}/api/state`)).json();
    assert.equal(state.events[0].status, 502);
    assert.equal(state.requestHistory.total, 1);

    lockDatabase.exec("ROLLBACK");
    locked = false;
    lockDatabase.close();
    lockDatabase = null;
    await new Promise((resolve) => relay.close(resolve));
    relayClosed = true;
    const persisted = requestHistory.listRequestHistory({ limit: 10 });
    assert.equal(persisted.total, 1);
    assert.equal(persisted.items[0].status, 502);
  } finally {
    if (locked) {
      try { lockDatabase.exec("ROLLBACK"); } catch { /* Best-effort test cleanup. */ }
    }
    try { lockDatabase?.close(); } catch { /* Best-effort test cleanup. */ }
    if (!relayClosed) await new Promise((resolve) => relay.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    requestHistory.clearRequestHistory();
  }
});

test("request history deletion drains queued writes before clearing", async () => {
  resetTestState();
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    requestHistory.enqueueRequestHistory(Array.from({ length: 3 }, (_, index) => ({
      at: new Date(1_770_000_000_000 + index).toISOString(), status: 200, ok: true,
      route: { id: "queued-delete", displayName: `queued-delete-${index}`, kind: "third_party", providerName: "queued", upstreamModel: "queued" },
    })));
    const deleted = await fetch(`http://127.0.0.1:${relay.address().port}/api/request-history`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).deleted, 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const history = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/request-history?limit=10`)).json();
    assert.equal(history.total, 0);
    assert.deepEqual(history.items, []);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    requestHistory.clearRequestHistory();
  }
});

test("official credentials are encrypted separately from the active Relay handoff", () => {
  resetTestState();
  fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
  const apiKeyAuth = JSON.stringify({ OPENAI_API_KEY: "pre-relay-api-key" });
  const officialAuth = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "test-id-token", access_token: "test-access-token", refresh_token: "test-refresh-token", account_id: "test-account" },
  });
  fs.writeFileSync(store.paths().codexAuth, apiKeyAuth, "utf8");
  const config = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(store.paths().codexConfig, config, "utf8");
  store.captureRelayHandoff();

  fs.writeFileSync(store.paths().codexAuth, officialAuth, "utf8");
  assert.deepEqual(store.captureOfficialAuth(), { captured: true });
  assert.equal(store.hasOfficialAuthSnapshot(), true);
  assert.doesNotMatch(fs.readFileSync(store.paths().officialAuth, "utf8"), /test-access-token/);

  fs.writeFileSync(store.paths().codexAuth, apiKeyAuth, "utf8");
  assert.deepEqual(store.relayOfficialAuthPlan({ restoreOfficial: true }), {
    action: "restore_saved",
    currentOfficial: false,
    savedOfficial: true,
    requiresRestore: true,
  });
  const recovered = store.restoreSavedOfficialAuth();
  assert.equal(recovered.restored, true);
  assert.equal(store.codexLoginStatus().authType, "official");
  assert.equal(fs.readFileSync(store.paths().codexAuth, "utf8"), officialAuth);

  const restored = store.restorePreRelayState();
  assert.equal(restored.authRestored, true);
  assert.equal(restored.authVerified, true);
  assert.equal(fs.readFileSync(store.paths().codexAuth, "utf8"), apiKeyAuth);
});

test("Relay apply restores saved official auth and restore returns the previous auth byte-for-byte", () => {
  resetTestState();
  fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
  const officialAuth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "official-transaction-token", refresh_token: "official-transaction-refresh", account_id: "official-account" } });
  fs.writeFileSync(store.paths().codexAuth, officialAuth, "utf8");
  assert.equal(store.captureOfficialAuth().captured, true);
  const previousConfig = 'model_provider = "custom"\nmodel = "third-party-before-relay"\n';
  const previousAuth = '{\r\n  "OPENAI_API_KEY": "third-party-before-relay"\r\n}\r\n';
  fs.writeFileSync(store.paths().codexConfig, previousConfig, "utf8");
  fs.writeFileSync(store.paths().codexAuth, previousAuth, "utf8");

  const applied = store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1", restoreOfficial: true });
  assert.equal(applied.authHandoff.action, "restore_saved");
  assert.equal(fs.readFileSync(store.paths().codexAuth, "utf8"), officialAuth);
  assert.equal(applied.transaction.officialAuthTransaction.previousText, previousAuth);
  const restored = store.restoreRelayHandoff();
  assert.equal(restored.verified, true);
  assert.equal(fs.readFileSync(store.paths().codexConfig, "utf8"), previousConfig);
  assert.equal(fs.readFileSync(store.paths().codexAuth, "utf8"), previousAuth);
});

test("Relay apply preserves a current official login instead of rewriting auth.json", () => {
  resetTestState();
  fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
  const savedOfficial = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "saved-token", refresh_token: "saved-refresh", account_id: "saved-account" } });
  const currentOfficial = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "current-token", refresh_token: "current-refresh", account_id: "current-account" }, last_refresh: "current" });
  fs.writeFileSync(store.paths().codexAuth, savedOfficial, "utf8");
  assert.equal(store.captureOfficialAuth().captured, true);
  fs.writeFileSync(store.paths().codexAuth, currentOfficial, "utf8");
  fs.writeFileSync(store.paths().codexConfig, 'model_provider = "openai"\n', "utf8");

  assert.deepEqual(store.relayOfficialAuthPlan({ restoreOfficial: true }), {
    action: "preserve_current",
    currentOfficial: true,
    savedOfficial: true,
    requiresRestore: false,
  });
  const applied = store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1", restoreOfficial: true });
  assert.equal(applied.authHandoff.action, "preserve_current");
  assert.equal(applied.transaction.officialAuthTransaction, null);
  assert.equal(fs.readFileSync(store.paths().codexAuth, "utf8"), currentOfficial);
});

test("Relay apply rollback restores config and auth byte-for-byte", () => {
  resetTestState();
  fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
  const officialAuth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "official-rollback-token", refresh_token: "official-rollback-refresh" } });
  fs.writeFileSync(store.paths().codexAuth, officialAuth, "utf8");
  store.captureOfficialAuth();
  const configBefore = 'model_provider = "custom"\nmodel = "rollback-me"\n';
  const authBefore = '{"OPENAI_API_KEY":"rollback-me"}\n';
  fs.writeFileSync(store.paths().codexConfig, configBefore, "utf8");
  fs.writeFileSync(store.paths().codexAuth, authBefore, "utf8");

  const pending = store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1", deferCommit: true, restoreOfficial: true });
  store.rollbackRelayConfig(pending.transaction);
  assert.equal(fs.readFileSync(store.paths().codexConfig, "utf8"), configBefore);
  assert.equal(fs.readFileSync(store.paths().codexAuth, "utf8"), authBefore);
});

test("catalog publication rejects stale model metadata even when route IDs match", () => {
  resetTestState();
  const configured = settings();
  const expectedCatalog = buildModelCatalog(configured);
  const staleCatalog = structuredClone(expectedCatalog);
  delete staleCatalog.models[0].apply_patch_tool_type;
  store.writeCatalog(staleCatalog);
  store.applyRelayConfig({ model: staleCatalog.models[0].slug, catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const publication = store.relayPublicationStatus({ expectedRoutes: [staleCatalog.models[0].slug], expectedCatalog, routerUrl: "http://127.0.0.1:15723/v1" });
  assert.equal(publication.catalogMatches, true);
  assert.equal(publication.catalogContentMatches, false);
  assert.equal(publication.verified, false);
});

test("official routing prefers a fresh Codex login and falls back to the encrypted snapshot", () => {
  resetTestState();
  const saved = captureOfficialToken("saved-official-access-token");
  fs.writeFileSync(store.paths().codexAuth, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "fresh-official-access-token", refresh_token: "fresh-refresh-token" },
  }), "utf8");
  assert.equal(store.officialAccessToken(), "fresh-official-access-token");

  fs.writeFileSync(store.paths().codexAuth, JSON.stringify({ OPENAI_API_KEY: "third-party-key" }), "utf8");
  assert.equal(store.officialAccessToken(), saved);
  assert.equal(store.officialAccountId(), "test-account");
});

test("restore before any apply does not modify Codex configuration", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  const untouched = 'model_provider = "custom"\nmodel = "keep-me"\n';
  fs.writeFileSync(target, untouched, "utf8");
  const result = store.restoreRelayHandoff();
  assert.equal(result.restored, false);
  assert.equal(fs.readFileSync(target, "utf8"), untouched);
});

test("restore removes Relay config when no config existed before apply", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  assert.equal(fs.existsSync(target), true);
  store.restorePreRelayState();
  assert.equal(fs.existsSync(target), false);
});

test("provider secrets use an encrypted on-disk payload", () => {
  store.saveProviderKey("deepseek", "test-secret-value");
  assert.equal(store.providerKey("deepseek"), "test-secret-value");
  const raw = fs.readFileSync(store.paths().secrets, "utf8");
  assert.doesNotMatch(raw, /test-secret-value/);
});

test("history snapshots preserve route ownership for a restarted Relay", () => {
  const firstRelay = createChatHistory();
  firstRelay.record("relay_response_1", [{ role: "system", content: "do not persist this system prompt" }, { role: "user", content: "keep this context" }], "relay-third-party-1");
  const restartedRelay = createChatHistory(firstRelay.snapshot());
  assert.equal(restartedRelay.routeFor("relay_response_1"), "relay-third-party-1");
  assert.deepEqual(restartedRelay.get("relay_response_1"), [{ role: "user", content: "keep this context" }]);
});

test("history request templates survive restart and remain isolated by route signature", () => {
  const routeInfo = {
    routeId: "relay-third-party-1",
    kind: "third_party",
    providerId: "blue",
    apiType: "responses",
    endpoint: "https://blue.example/v1",
    upstreamModel: "blue-model",
    stateDomain: "a".repeat(64),
    routeSignature: "b".repeat(64),
  };
  const firstRelay = createChatHistory();
  firstRelay.record("relay_response_template", [{ role: "user", content: "use a tool" }], routeInfo, {
    requestTemplate: { instructions: "Keep working.", tools: [{ type: "function", name: "lookup" }] },
  });
  const restartedRelay = createChatHistory(firstRelay.snapshot());

  assert.deepEqual(restartedRelay.requestTemplateFor("relay_response_template", routeInfo), {
    instructions: "Keep working.",
    tools: [{ type: "function", name: "lookup" }],
  });
  assert.equal(restartedRelay.requestTemplateFor("relay_response_template", { ...routeInfo, routeSignature: "c".repeat(64) }), null);
});

test("optional context cache is DPAPI-encrypted and can be removed", () => {
  const entries = [{ id: "relay_response_2", routeId: "relay-third-party-1", messages: [{ role: "user", content: "private cached context 中文" }] }];
  store.saveContextCache(entries);
  assert.deepEqual(store.loadContextCache(), entries);
  assert.doesNotMatch(fs.readFileSync(store.paths().context, "utf8"), /private cached context/);
  assert.equal(JSON.parse(fs.readFileSync(store.paths().context, "utf8")).version, 3);
  store.clearContextCache();
  assert.equal(fs.existsSync(store.paths().context), false);
});

test("context cache DPAPI round-trips payloads larger than the SecureString limit", () => {
  const entries = [{
    id: "relay_response_large_context",
    routeId: "relay-third-party-1",
    messages: [{ role: "user", content: `large-private-context-${"x".repeat(90_000)}` }],
    routeInfo: { routeId: "relay-third-party-1", kind: "third_party", routeSignature: "d".repeat(64), stateDomain: "e".repeat(64) },
    requestTemplate: { instructions: "Keep using the tools.", tools: [{ type: "function", name: "lookup", description: "y".repeat(10_000) }] },
  }];
  store.saveContextCache(entries);
  assert.deepEqual(store.loadContextCache(), entries);
  const raw = fs.readFileSync(store.paths().context, "utf8");
  assert.doesNotMatch(raw, /large-private-context|Keep using the tools|lookup/);
  assert.equal(JSON.parse(raw).version, 3);
});

test("Codex receives two official routes plus all ten configured third-party slots", () => {
  const providers = [{ id: "shared", name: "Shared", baseUrl: "https://relay.example/v1", apiType: "responses" }];
  const thirdPartySlots = THIRD_PARTY_SLOT_IDS.map((id, index) => ({ id, displayName: `Model ${index + 1}`, providerId: "shared", upstreamModel: `upstream-${index + 1}` }));
  const catalog = buildModelCatalog(settings({ official: { verified: true, lastCheckedAt: "2026-07-12T00:00:00.000Z" }, providers, thirdPartySlots }));
  assert.equal(catalog.models.length, 12);
  assert.deepEqual(catalog.models.slice(-2).map((model) => model.slug), ["relay-third-party-9", "relay-third-party-10"]);
});

test("slot ten is accepted, slot eleven is rejected, and batch add fills empty slots atomically", async () => {
  resetTestState();
  const provider = { id: "batch", name: "Batch", baseUrl: "https://relay.example/v1", apiType: "responses" };
  const firstFive = THIRD_PARTY_SLOT_IDS.slice(0, 5).map((id, index) => ({ id, displayName: `Existing ${index + 1}`, providerId: provider.id, upstreamModel: `existing-${index + 1}` }));
  store.replaceSettings(settings({ providers: [provider], thirdPartySlots: firstFive }));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${relay.address().port}`;
    const tenth = await fetch(`${base}/api/slots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "relay-third-party-10", displayName: "Tenth", providerId: provider.id, upstreamModel: "model-ten" }) });
    assert.equal(tenth.status, 200);
    const eleventh = await fetch(`${base}/api/slots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "relay-third-party-11", displayName: "Eleventh", providerId: provider.id, upstreamModel: "model-eleven" }) });
    assert.equal(eleventh.status, 400);
    const batch = await fetch(`${base}/api/slots/batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: provider.id, models: ["model-six", "model-seven", "model-eight", "model-nine"] }) });
    assert.equal(batch.status, 200);
    const result = await batch.json();
    assert.deepEqual(result.slots.map((slot) => slot.id), ["relay-third-party-6", "relay-third-party-7", "relay-third-party-8", "relay-third-party-9"]);
    assert.equal(result.remaining, 0);
    const saved = store.loadSettings().thirdPartySlots;
    assert.equal(saved.length, 10);
    assert.deepEqual(saved.slice(0, 5).map((slot) => slot.upstreamModel), firstFive.map((slot) => slot.upstreamModel));
    const overflow = await fetch(`${base}/api/slots/batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: provider.id, models: ["overflow"] }) });
    assert.equal(overflow.status, 409);
    assert.equal(store.loadSettings().thirdPartySlots.length, 10);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("context cache persistence coalesces snapshots in a worker and flushes the latest value", async () => {
  resetTestState();
  const first = [{ id: "relay_worker_1", routeId: "relay-third-party-1", messages: [{ role: "user", content: "first" }] }];
  const latest = [{ id: "relay_worker_2", routeId: "relay-third-party-1", messages: [{ role: "user", content: "latest 中文 context" }] }];
  contextCache.enqueueContextCache(first);
  contextCache.enqueueContextCache(latest);
  const flush = contextCache.flushContextCacheWriter();
  const eventLoopStayedResponsive = await Promise.race([
    new Promise((resolve) => setTimeout(() => resolve(true), 50)),
    flush.then(() => false),
  ]);
  assert.equal(eventLoopStayedResponsive, true);
  await flush;
  assert.deepEqual(store.loadContextCache(), latest);
  assert.equal(contextCache.contextCacheWriterState().pending, false);
  assert.equal(contextCache.contextCacheWriterState().inFlight, false);
  await contextCache.closeContextCacheWriter();
});

test("CC Switch custom history visibility migration preserves conversation content and restores only ledgered entries", async () => {
  resetTestState();
  const codexHome = path.dirname(store.paths().codexConfig);
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "14");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, "rollout-blue.jsonl");
  const responseLine = JSON.stringify({ type: "response_item", payload: { role: "user", content: "keep custom and model_provider text inside the conversation" } });
  fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: "thread-blue", model_provider: "custom", cwd: "C:/work" } })}\n${responseLine}\n`, "utf8");

  const statePath = path.join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(statePath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL); INSERT INTO threads VALUES ('thread-blue', 'custom'), ('official-old', 'openai');");
  db.close();

  const preview = historyMigration.inspectCodexHistoryBuckets({ codexHome, relayHome: store.paths().appDir });
  assert.equal(preview.customSessions, 1);
  assert.equal(preview.migratable, true);
  const migrated = await historyMigration.migrateCodexCustomHistory({ codexHome, relayHome: store.paths().appDir, planHash: preview.planHash });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.sessions, 1);
  const migratedLines = fs.readFileSync(sessionPath, "utf8").trimEnd().split(/\r?\n/);
  assert.equal(JSON.parse(migratedLines[0]).payload.model_provider, "openai");
  assert.equal(migratedLines[1], responseLine);
  let stateDb = new DatabaseSync(statePath);
  assert.equal(stateDb.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-blue").model_provider, "openai");
  stateDb.prepare("INSERT INTO threads VALUES (?, ?)").run("relay-new", "openai");
  stateDb.close();

  const appended = JSON.stringify({ type: "response_item", payload: { role: "assistant", content: "continued while Relay was active" } });
  fs.appendFileSync(sessionPath, `${appended}\n`, "utf8");
  const restored = await historyMigration.restoreCodexHistoryMigration({ codexHome, relayHome: store.paths().appDir });
  assert.equal(restored.restored, true);
  const restoredLines = fs.readFileSync(sessionPath, "utf8").trimEnd().split(/\r?\n/);
  assert.equal(JSON.parse(restoredLines[0]).payload.model_provider, "custom");
  assert.equal(restoredLines[1], responseLine);
  assert.equal(restoredLines[2], appended);
  stateDb = new DatabaseSync(statePath, { readOnly: true });
  assert.equal(stateDb.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-blue").model_provider, "custom");
  assert.equal(stateDb.prepare("SELECT model_provider FROM threads WHERE id = ?").get("official-old").model_provider, "openai");
  assert.equal(stateDb.prepare("SELECT model_provider FROM threads WHERE id = ?").get("relay-new").model_provider, "openai");
  stateDb.close();
  resetTestState();
});

test("third-party archive compatibility normalizes only safe extended rollout paths in a worker and can roll back", async () => {
  resetTestState();
  const codexHome = path.dirname(store.paths().codexConfig);
  const sessionDir = path.join(codexHome, "sessions", "2026", "08", "19");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, "rollout-third-party.jsonl");
  fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: "thread-third-party", model_provider: "openai" } })}\n`, "utf8");
  const extendedPath = `\\\\?\\${sessionPath}`;
  const missingExtendedPath = `\\\\?\\${path.join(sessionDir, "missing.jsonl")}`;
  const statePath = path.join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(statePath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, archived INTEGER NOT NULL DEFAULT 0, rollout_path TEXT);");
  db.prepare("INSERT INTO threads (id, model, archived, rollout_path) VALUES (?, ?, ?, ?)").run("thread-third-party", "relay-third-party-3", 0, extendedPath);
  db.prepare("INSERT INTO threads (id, model, archived, rollout_path) VALUES (?, ?, ?, ?)").run("thread-missing", "relay-third-party-7", 0, missingExtendedPath);
  db.prepare("INSERT INTO threads (id, model, archived, rollout_path) VALUES (?, ?, ?, ?)").run("thread-official", "gpt-5.6-terra", 0, extendedPath);
  db.close();

  const preview = historyMigration.inspectCodexArchivePathCompatibility({ codexHome, relayHome: store.paths().appDir });
  assert.equal(preview.fixable, 1);
  assert.equal(preview.blocked.length, 1);
  const repaired = await runArchivePathRepairWorker({ codexHome, relayHome: store.paths().appDir });
  assert.equal(repaired.entries, 1);

  const afterRepair = new DatabaseSync(statePath, { readOnly: true });
  assert.equal(afterRepair.prepare("SELECT rollout_path FROM threads WHERE id = ?").get("thread-third-party").rollout_path, sessionPath);
  assert.equal(afterRepair.prepare("SELECT rollout_path FROM threads WHERE id = ?").get("thread-official").rollout_path, extendedPath);
  afterRepair.close();

  const rolledBack = historyMigration.rollbackCodexArchivePaths({ codexHome, relayHome: store.paths().appDir });
  assert.equal(rolledBack.restored, true);
  assert.equal(rolledBack.entries, 1);
  const afterRollback = new DatabaseSync(statePath, { readOnly: true });
  assert.equal(afterRollback.prepare("SELECT rollout_path FROM threads WHERE id = ?").get("thread-third-party").rollout_path, extendedPath);
  afterRollback.close();
  resetTestState();
});

test("archive compatibility monitor delays and serializes third-party repair checks", async () => {
  const calls = [];
  let active = 0;
  let highestActive = 0;
  const monitor = createArchivePathRepairMonitor({
    codexHome: path.dirname(store.paths().codexConfig),
    relayHome: store.paths().appDir,
    watch: false,
    initialDelayMs: 1,
    retryDelaysMs: [1, 2, 3],
    runRepair: async () => {
      active += 1;
      highestActive = Math.max(highestActive, active);
      calls.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return { entries: 0 };
    },
  });
  const waitFor = async (predicate, timeoutMs = 1_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("archive compatibility monitor did not finish in time");
  };
  try {
    monitor.start();
    await waitFor(() => calls.length >= 1);
    monitor.notifyThirdPartyTurn();
    await waitFor(() => calls.length >= 2);
    assert.equal(highestActive, 1);
  } finally {
    monitor.close();
  }
});

test("history visibility preview rejects plan drift without changing a conversation", async () => {
  resetTestState();
  const codexHome = path.dirname(store.paths().codexConfig);
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "14");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, "rollout-drift.jsonl");
  fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: "thread-drift", model_provider: "custom" } })}\n`, "utf8");
  const preview = historyMigration.inspectCodexHistoryBuckets({ codexHome, relayHome: store.paths().appDir });
  fs.appendFileSync(sessionPath, `${JSON.stringify({ type: "response_item", payload: { role: "user", content: "added after preview" } })}\n`, "utf8");

  await assert.rejects(
    historyMigration.migrateCodexCustomHistory({ codexHome, relayHome: store.paths().appDir, planHash: preview.planHash }),
    (error) => error.code === "history_plan_changed",
  );
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, "utf8").split(/\r?\n/)[0]).payload.model_provider, "custom");
  assert.equal(historyMigration.activeCodexHistoryMigration({ relayHome: store.paths().appDir }), null);
  resetTestState();
});

test("a SQLite migration fault restores the exact JSONL and state database backups", async () => {
  resetTestState();
  const codexHome = path.dirname(store.paths().codexConfig);
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "14");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, "rollout-fault.jsonl");
  const original = `${JSON.stringify({ type: "session_meta", payload: { id: "thread-fault", model_provider: "custom" } })}\n${JSON.stringify({ type: "response_item", payload: { role: "user", content: "must survive rollback" } })}\n`;
  fs.writeFileSync(sessionPath, original, "utf8");
  const statePath = path.join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(statePath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL); INSERT INTO threads VALUES ('thread-fault', 'custom'); CREATE TRIGGER block_provider_update BEFORE UPDATE OF model_provider ON threads BEGIN SELECT RAISE(ABORT, 'blocked for rollback test'); END;");
  db.close();
  const preview = historyMigration.inspectCodexHistoryBuckets({ codexHome, relayHome: store.paths().appDir });

  await assert.rejects(historyMigration.migrateCodexCustomHistory({ codexHome, relayHome: store.paths().appDir, planHash: preview.planHash }));
  assert.equal(fs.readFileSync(sessionPath, "utf8"), original);
  const restoredDb = new DatabaseSync(statePath, { readOnly: true });
  assert.equal(restoredDb.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-fault").model_provider, "custom");
  restoredDb.close();
  assert.equal(historyMigration.activeCodexHistoryMigration({ relayHome: store.paths().appDir }), null);
  resetTestState();
});

test("unsupported Codex state schemas block history visibility before any write", async () => {
  resetTestState();
  const codexHome = path.dirname(store.paths().codexConfig);
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "14");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, "rollout-unsupported.jsonl");
  fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: "thread-unsupported", model_provider: "custom" } })}\n`, "utf8");
  const statePath = path.join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(statePath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT);");
  db.close();

  const preview = historyMigration.inspectCodexHistoryBuckets({ codexHome, relayHome: store.paths().appDir });
  assert.equal(preview.migrationBlocked, true);
  assert.equal(preview.migratable, false);
  assert.deepEqual(preview.unsupportedDatabases, ["state_5.sqlite"]);
  await assert.rejects(
    historyMigration.migrateCodexCustomHistory({ codexHome, relayHome: store.paths().appDir, planHash: preview.planHash }),
    (error) => error.code === "history_database_schema_changed",
  );
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, "utf8").trim()).payload.model_provider, "custom");
  resetTestState();
});

test("history visibility follows Codex sqlite_home and restores its external index", async () => {
  resetTestState();
  const codexHome = path.dirname(store.paths().codexConfig);
  const sqliteHome = path.join(sandbox, "external-sqlite-home");
  fs.rmSync(sqliteHome, { recursive: true, force: true });
  fs.mkdirSync(sqliteHome, { recursive: true });
  fs.writeFileSync(store.paths().codexConfig, `sqlite_home = "${sqliteHome.replaceAll("\\", "\\\\")}"\n`, "utf8");
  const statePath = path.join(sqliteHome, "state_5.sqlite");
  const db = new DatabaseSync(statePath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL); INSERT INTO threads VALUES ('thread-external', 'custom');");
  db.close();

  const preview = historyMigration.inspectCodexHistoryBuckets({ codexHome, relayHome: store.paths().appDir });
  assert.equal(preview.state.custom, 1);
  assert.equal(preview.customSessions, 1);
  const migrated = await historyMigration.migrateCodexCustomHistory({ codexHome, relayHome: store.paths().appDir, planHash: preview.planHash });
  assert.equal(migrated.rows, 1);
  let externalDb = new DatabaseSync(statePath, { readOnly: true });
  assert.equal(externalDb.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-external").model_provider, "openai");
  externalDb.close();
  await historyMigration.restoreCodexHistoryMigration({ codexHome, relayHome: store.paths().appDir });
  externalDb = new DatabaseSync(statePath, { readOnly: true });
  assert.equal(externalDb.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-external").model_provider, "custom");
  externalDb.close();
  fs.rmSync(sqliteHome, { recursive: true, force: true });
  resetTestState();
});

test("apply and restore integrate the optional CC Switch history handoff", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  store.saveProviderKey("deepseek", "history-apply-key");
  const codexHome = path.dirname(store.paths().codexConfig);
  const originalConfig = 'model_provider = "custom"\nmodel = "before-history-handoff"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(store.paths().codexConfig, originalConfig, "utf8");
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "14");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, "rollout-integrated.jsonl");
  fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: "thread-integrated", model_provider: "custom" } })}\n`, "utf8");
  const statePath = path.join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(statePath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL); INSERT INTO threads VALUES ('thread-integrated', 'custom');");
  db.close();

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const preview = await fetch(`http://127.0.0.1:${port}/api/apply-preview`).then((response) => response.json());
    assert.equal(preview.historyVisibility.canMigrate, true);
    const appliedResponse = await fetch(`http://127.0.0.1:${port}/api/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ historyVisibilityAction: "show_custom_in_openai", historyVisibilityPlanSha256: preview.historyVisibility.planHash }),
    });
    const applied = await appliedResponse.json();
    assert.equal(appliedResponse.status, 200);
    assert.equal(applied.historyVisibility.status, "migrated");
    assert.equal(applied.historyVisibility.sessions, 1);
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, "utf8").trim()).payload.model_provider, "openai");

    const restoredResponse = await fetch(`http://127.0.0.1:${port}/api/restore`, { method: "POST" });
    const restored = await restoredResponse.json();
    assert.equal(restoredResponse.status, 200);
    assert.equal(restored.historyVisibility.restored, true);
    assert.equal(restored.historyVisibility.sessions, 1);
    assert.equal(fs.readFileSync(store.paths().codexConfig, "utf8"), originalConfig);
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, "utf8").trim()).payload.model_provider, "custom");
    assert.equal(historyMigration.activeCodexHistoryMigration({ relayHome: store.paths().appDir }), null);
    assert.equal(store.providerKey("deepseek"), "history-apply-key");
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("same Responses provider switches models natively and falls back once after an explicit continuation rejection", async () => {
  const received = [];
  let rejectNextContinuation = false;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    if (rejectNextContinuation && body.previous_response_id) {
      rejectNextContinuation = false;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "previous_response_not_found", message: "previous_response_id does not exist for this model" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_${received.length}`,
      object: "response",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply-${received.length}` }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("blue-shared", "blue-shared-key");
    const configured = settings({
      providers: [{ id: "blue-shared", name: "Blue", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "responses", nativeResponseContinuation: true, note: "", extraHeaders: {} }],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "Blue Terra", providerId: "blue-shared", upstreamModel: "gpt-5.6-terra", contextWindow: 128000, supportsImages: false, dropParams: [] },
        { id: "relay-third-party-2", displayName: "Blue Sol", providerId: "blue-shared", upstreamModel: "gpt-5.6-sol", contextWindow: 128000, supportsImages: false, dropParams: [] },
      ],
    });
    let history = createChatHistory();
    const terra = routeForRequest(configured, "relay-third-party-1");
    const sol = routeForRequest(configured, "relay-third-party-2");
    const firstBody = { model: terra.id, input: "first task", stream: false };
    const first = await forwardResponses({ settings: configured, route: terra, body: firstBody, headers: {}, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, terra, firstRaw);
    const firstId = JSON.parse(firstRaw).id;
    history = createChatHistory(history.snapshot());

    const native = await forwardResponses({ settings: configured, route: sol, body: { model: sol.id, previous_response_id: firstId, input: "continue natively", stream: false }, headers: {}, history });
    assert.equal(native.status, 200);
    assert.equal(received.at(-1).previous_response_id, firstId);
    assert.equal(responseContextMode(native), "third_party_same_provider_native");

    const nextRaw = await native.text();
    recordPassthroughResponse(history, { model: sol.id, previous_response_id: firstId, input: "continue natively", stream: false }, sol, nextRaw);
    const nextId = JSON.parse(nextRaw).id;
    rejectNextContinuation = true;
    const beforeFallback = received.length;
    const fallback = await forwardResponses({ settings: configured, route: terra, body: { model: terra.id, previous_response_id: nextId, input: "continue with fallback", stream: false }, headers: {}, history });
    assert.equal(fallback.status, 200);
    assert.equal(received.length - beforeFallback, 2);
    assert.equal(received.at(-2).previous_response_id, nextId);
    assert.equal(received.at(-1).previous_response_id, undefined);
    assert.deepEqual(received.at(-1).input.map((item) => item.content[0].text), ["first task", "reply-1", "continue natively", "reply-2", "continue with fallback"]);
    assert.equal(responseDiagnostics(fallback).attempts, 2);
    assert.equal(responseDiagnostics(fallback).retryReason, "same_provider_previous_response_rejected");
    assert.equal(responseContextMode(fallback), "third_party_same_provider_fallback");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("a client-provided third-party response ID known to be unstored uses portable context without an upstream rejection", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    if (body.previous_response_id) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { param: "previous_response_id", message: "previous_response_id must reference a stored response" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_stored_${received.length}`,
      object: "response",
      status: "completed",
      model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply-${received.length}` }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("stored-response-provider", "stored-response-key");
    const configured = settings({
      providers: [{ id: "stored-response-provider", name: "Stored response provider", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: false, note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Stored response model", providerId: "stored-response-provider", upstreamModel: "gpt-5.6-sol", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const history = createChatHistory();
    const firstBody = { model: route.id, input: "first message", stream: false, store: false };
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers: {}, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, route, firstRaw);
    const firstId = JSON.parse(firstRaw).id;

    const second = await forwardResponses({ settings: configured, route, body: { model: route.id, previous_response_id: firstId, input: "second message", stream: false, store: false }, headers: {}, history });
    assert.equal(second.status, 200);
    assert.equal(received.length, 2);
    assert.equal(received[0].store, false);
    assert.equal(received[1].previous_response_id, undefined);
    assert.equal(received[1].store, false);
    assert.deepEqual(received[1].input.map((item) => item.content[0].text), ["first message", "reply-1", "second message"]);
    assert.equal(responseDiagnostics(second).attempts, 1);
    assert.equal(responseDiagnostics(second).retryReason, null);
    assert.deepEqual(responseDiagnostics(second).nativeContinuation, { mode: "client_id_portable", reason: "previous_response_not_stored" });
    assert.equal(responseContextMode(second), "third_party_portable_unstored");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("different Responses providers replay visible context without forwarding a foreign response id", async () => {
  const firstRequests = [];
  const secondRequests = [];
  const createUpstream = (requests, responseId, reply) => http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: responseId, object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] }] }));
  });
  const firstUpstream = createUpstream(firstRequests, "resp_foreign_first", "first provider reply");
  const secondUpstream = createUpstream(secondRequests, "resp_foreign_second", "second provider reply");
  await Promise.all([
    new Promise((resolve) => firstUpstream.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => secondUpstream.listen(0, "127.0.0.1", resolve)),
  ]);
  try {
    store.saveProviderKey("responses-first", "responses-first-key");
    store.saveProviderKey("responses-second", "responses-second-key");
    const configured = settings({
      providers: [
        { id: "responses-first", name: "First responses", baseUrl: `http://127.0.0.1:${firstUpstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} },
        { id: "responses-second", name: "Second responses", baseUrl: `http://127.0.0.1:${secondUpstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} },
      ],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "First", providerId: "responses-first", upstreamModel: "shared-model-name", contextWindow: 128000, supportsImages: false, dropParams: [] },
        { id: "relay-third-party-2", displayName: "Second", providerId: "responses-second", upstreamModel: "shared-model-name", contextWindow: 128000, supportsImages: false, dropParams: [] },
      ],
    });
    const history = createChatHistory();
    const firstRoute = routeForRequest(configured, "relay-third-party-1");
    const firstBody = { model: firstRoute.id, input: "first provider task", stream: false };
    const first = await forwardResponses({ settings: configured, route: firstRoute, body: firstBody, headers: {}, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, firstRoute, firstRaw);
    const secondRoute = routeForRequest(configured, "relay-third-party-2");
    const second = await forwardResponses({ settings: configured, route: secondRoute, body: { model: secondRoute.id, previous_response_id: "resp_foreign_first", input: "continue on second", stream: false }, headers: {}, history });

    assert.equal(second.status, 200);
    assert.equal(secondRequests[0].previous_response_id, undefined);
    assert.deepEqual(secondRequests[0].input.map((item) => item.content[0].text), ["first provider task", "first provider reply", "continue on second"]);
    assert.equal(responseContextMode(second), "portable_context");
  } finally {
    await Promise.all([
      new Promise((resolve) => firstUpstream.close(resolve)),
      new Promise((resolve) => secondUpstream.close(resolve)),
    ]);
  }
});

test("client-provided same-domain third-party IDs pass through while unknown IDs stay isolated", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_portable_${received.length}`,
      object: "response",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `portable-reply-${received.length}` }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const provider = { id: "portable-only", name: "Portable only", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: false, note: "", extraHeaders: {} };
    store.saveProviderKey(provider.id, "portable-only-key");
    const configured = settings({
      providers: [provider],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Portable only", providerId: provider.id, upstreamModel: "gpt-portable-only", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const history = createChatHistory();
    const firstBody = { model: route.id, input: "keep this task", stream: false };
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers: {}, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, route, firstRaw);
    const firstId = JSON.parse(firstRaw).id;

    const continued = await forwardResponses({ settings: configured, route, body: { model: route.id, previous_response_id: firstId, input: "continue safely", stream: false }, headers: {}, history });
    assert.equal(continued.status, 200);
    assert.equal(received.at(-1).previous_response_id, firstId);
    assert.equal(received.at(-1).input, "continue safely");
    assert.equal(responseContextMode(continued), "third_party_native_continuation");

    const unknown = await forwardResponses({ settings: configured, route, body: { model: route.id, previous_response_id: "resp_missing", input: "do not lose context", stream: false }, headers: {}, history: createChatHistory() });
    assert.equal(unknown.status, 200);
    assert.equal(received.at(-1).previous_response_id, undefined);
    assert.equal(received.length, 3);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("history visibility restore skips conversations deliberately deleted after Relay was enabled", async () => {
  resetTestState();
  const codexHome = path.dirname(store.paths().codexConfig);
  const sessionId = "019f77fb-0787-76b1-a1a8-1ae8fe10da86";
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "19");
  const sessionPath = path.join(sessionDir, `rollout-2026-07-19T09-26-13-${sessionId}.jsonl`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, model_provider: "custom" } })}\n`, "utf8");
  const statePath = path.join(codexHome, "state_5.sqlite");
  const state = new DatabaseSync(statePath);
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL);");
  state.prepare("INSERT INTO threads VALUES (?, ?)").run(sessionId, "custom");
  state.close();

  await historyMigration.migrateCodexCustomHistory({ codexHome, relayHome: store.paths().appDir });
  fs.rmSync(sessionPath);
  const afterDelete = new DatabaseSync(statePath);
  afterDelete.prepare("DELETE FROM threads WHERE id = ?").run(sessionId);
  afterDelete.close();

  const restored = await historyMigration.restoreCodexHistoryMigration({ codexHome, relayHome: store.paths().appDir, deletedSessionIds: [sessionId] });
  assert.equal(restored.restored, true);
  assert.equal(restored.files, 0);
  assert.equal(restored.rows, 0);
  assert.equal(restored.skippedDeleted, 1);
  assert.equal(fs.existsSync(sessionPath), false);
  const finalState = new DatabaseSync(statePath, { readOnly: true });
  assert.equal(finalState.prepare("SELECT id FROM threads WHERE id = ?").get(sessionId), undefined);
  finalState.close();
  assert.equal(historyMigration.activeCodexHistoryMigration({ relayHome: store.paths().appDir }), null);
});

test("history visibility restore keeps an archived conversation archived", async () => {
  resetTestState();
  const codexHome = path.dirname(store.paths().codexConfig);
  const sessionId = "019f77fb-0787-76b1-a1a8-1ae8fe10da86";
  const sessionName = `rollout-2026-07-19T09-26-13-${sessionId}.jsonl`;
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "19");
  const sessionPath = path.join(sessionDir, sessionName);
  const archivedPath = path.join(codexHome, "archived_sessions", sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, model_provider: "custom" } })}\n`, "utf8");
  const statePath = path.join(codexHome, "state_5.sqlite");
  const state = new DatabaseSync(statePath);
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL);");
  state.prepare("INSERT INTO threads VALUES (?, ?)").run(sessionId, "custom");
  state.close();

  await historyMigration.migrateCodexCustomHistory({ codexHome, relayHome: store.paths().appDir });
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
  fs.renameSync(sessionPath, archivedPath);

  const restored = await historyMigration.restoreCodexHistoryMigration({ codexHome, relayHome: store.paths().appDir });
  assert.equal(restored.restored, true);
  assert.equal(restored.files, 1);
  assert.equal(fs.existsSync(sessionPath), false);
  assert.equal(JSON.parse(fs.readFileSync(archivedPath, "utf8").trim()).payload.model_provider, "custom");
  const finalState = new DatabaseSync(statePath, { readOnly: true });
  assert.equal(finalState.prepare("SELECT model_provider FROM threads WHERE id = ?").get(sessionId).model_provider, "custom");
  finalState.close();
  assert.equal(historyMigration.activeCodexHistoryMigration({ relayHome: store.paths().appDir }), null);
});

test("restore returns the original config without reviving a deliberately deleted conversation", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  const codexHome = path.dirname(store.paths().codexConfig);
  const originalConfig = 'model_provider = "custom"\nmodel = "before-deleted-conversation"\n';
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(store.paths().codexConfig, originalConfig, "utf8");
  const sessionId = "019f77fb-0787-76b1-a1a8-1ae8fe10da86";
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "19");
  const sessionPath = path.join(sessionDir, `rollout-2026-07-19T09-26-13-${sessionId}.jsonl`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(sessionPath, '{"id":"deleted"}\n', "utf8");
  const statePath = path.join(codexHome, "state_5.sqlite");
  const state = new DatabaseSync(statePath);
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL);");
  state.prepare("INSERT INTO threads VALUES (?, ?)").run(sessionId, "custom");
  state.close();
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: `http://127.0.0.1:${port}/v1` });
  fs.rmSync(sessionPath);
  const afterDelete = new DatabaseSync(statePath);
  afterDelete.prepare("DELETE FROM threads WHERE id = ?").run(sessionId);
  afterDelete.close();

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/restore`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.deletedConversationsSkipped, 1);
    assert.equal(fs.readFileSync(store.paths().codexConfig, "utf8"), originalConfig);
    assert.equal(fs.existsSync(sessionPath), false);
    const finalState = new DatabaseSync(statePath, { readOnly: true });
    assert.equal(finalState.prepare("SELECT id FROM threads WHERE id = ?").get(sessionId), undefined);
    finalState.close();
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("S3-A stores completed standard Responses IDs in encrypted task and route mappings", () => {
  resetTestState();
  try {
    const history = createChatHistory();
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "s3-a-mapping-thread" }) };
    const records = [];
    const record = ({ providerId, key, upstreamModel, responseId, previousResponseId }) => {
      store.saveProviderKey(providerId, key);
      const configured = settings({
        providers: [{ id: providerId, name: providerId, baseUrl: `https://${providerId}.example/v1`, apiType: "responses" }],
        thirdPartySlots: [{ id: "relay-third-party-1", displayName: providerId, providerId, upstreamModel, contextWindow: 128000, supportsImages: false, dropParams: [] }],
      });
      const route = routeForRequest(configured, "relay-third-party-1");
      const body = {
        model: route.id,
        input: [{ role: "user", content: [{ type: "input_text", text: `request-${responseId}` }] }],
        stream: false,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      };
      recordPassthroughResponse(history, body, route, JSON.stringify({
        id: responseId,
        object: "response",
        status: "completed",
        model: upstreamModel,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply-${responseId}` }] }],
      }), headers);
      const entry = history.snapshot().find((item) => item.id === responseId);
      records.push({ responseId, entry });
      return entry;
    };

    const modelOne = record({ providerId: "s3-a-first", key: "s3-a-key-one", upstreamModel: "gpt-s3-a-one", responseId: "resp_s3_a_model_one" });
    const modelTwo = record({ providerId: "s3-a-first", key: "s3-a-key-one", upstreamModel: "gpt-s3-a-two", responseId: "resp_s3_a_model_two" });
    const changedKey = record({ providerId: "s3-a-first", key: "s3-a-key-two", upstreamModel: "gpt-s3-a-one", responseId: "resp_s3_a_changed_key", previousResponseId: modelOne.id });
    const otherProvider = record({ providerId: "s3-a-second", key: "s3-a-key-three", upstreamModel: "gpt-s3-a-one", responseId: "resp_s3_a_other_provider" });

    const taskHashes = new Set(records.map(({ entry }) => entry.responseIdState?.taskHash));
    assert.equal(taskHashes.size, 1);
    assert.match([...taskHashes][0], /^[a-f0-9]{64}$/);
    assert.ok(records.every(({ entry }) => entry.responseIdState?.version === 1));
    assert.equal(new Set(records.map(({ entry }) => entry.routeInfo.routeSignature)).size, 4);
    for (const { responseId, entry } of records) {
      assert.equal(history.responseIdCandidate(entry.responseIdState.taskHash, entry.routeInfo)?.id, responseId);
    }

    store.saveContextCache(history.snapshot());
    const encryptedText = fs.readFileSync(store.paths().context, "utf8");
    const encrypted = JSON.parse(encryptedText);
    assert.equal(encrypted.version, 3);
    for (const secret of [
      "s3-a-mapping-thread", "s3-a-key-one", "s3-a-key-two", "s3-a-key-three",
      "gpt-s3-a-one", "gpt-s3-a-two", ...records.map(({ responseId }) => responseId),
      ...records.map(({ entry }) => entry.responseIdState.taskHash),
      ...records.map(({ entry }) => entry.routeInfo.routeSignature),
    ]) assert.equal(encryptedText.includes(secret), false);

    const reloaded = createChatHistory(store.loadContextCache());
    for (const { responseId, entry } of records) {
      assert.equal(reloaded.responseIdCandidate(entry.responseIdState.taskHash, entry.routeInfo)?.id, responseId);
      assert.deepEqual(reloaded.responseIdStateFor(responseId), entry.responseIdState);
    }
    assert.equal(reloaded.responseIdCandidate(modelOne.responseIdState.taskHash, { ...modelOne.routeInfo, routeSignature: "f".repeat(64) }), null);
    assert.notEqual(modelOne.routeInfo.routeSignature, modelTwo.routeInfo.routeSignature);
    assert.notEqual(modelOne.routeInfo.stateDomain, changedKey.routeInfo.stateDomain);
    assert.notEqual(modelOne.routeInfo.stateDomain, otherProvider.routeInfo.stateDomain);
  } finally {
    resetTestState();
  }
});

test("S3-A ignores incomplete or nonstandard IDs and never injects while the provider switch is off", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_s3_a_off_${received.length}`,
      object: "response",
      status: "completed",
      model: "gpt-s3-a-off",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply-${received.length}` }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("s3-a-off", "s3-a-off-key");
    const configured = settings({
      providers: [{ id: "s3-a-off", name: "S3-A off", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses" }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "S3-A off", providerId: "s3-a-off", upstreamModel: "gpt-s3-a-off", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "s3-a-off-thread" }) };
    const history = createChatHistory();
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "first" }] }];
    const firstBody = { model: route.id, input: firstInput, stream: false };
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, route, firstRaw, headers, responseHistoryInfo(first));
    assert.ok(history.responseIdStateFor("resp_s3_a_off_1"));
    assert.equal(received[0].previous_response_id, undefined);
    assert.equal(received[0].store, undefined);

    const firstOutput = JSON.parse(firstRaw).output;
    const secondInput = [...firstInput, ...firstOutput, { role: "user", content: [{ type: "input_text", text: "second" }] }];
    const secondBody = { model: route.id, input: secondInput, stream: false };
    const second = await forwardResponses({ settings: configured, route, body: secondBody, headers, history });
    const secondRaw = await second.text();
    recordPassthroughResponse(history, secondBody, route, secondRaw, headers, responseHistoryInfo(second));
    assert.equal(received[1].previous_response_id, undefined);
    assert.equal(received[1].store, undefined);
    assert.deepEqual(received[1].input, secondInput);
    assert.ok(history.responseIdStateFor("resp_s3_a_off_2"));

    const standard = { object: "response", status: "completed", model: "gpt-s3-a-off", output: [] };
    const invalid = [
      { id: "resp_s3_a_missing_status", object: "response", model: "gpt-s3-a-off", output: [] },
      { id: "resp_s3_a_incomplete", ...standard, status: "in_progress" },
      { id: "resp_s3_a_failed", ...standard, status: "failed", error: { message: "failed" } },
      { id: "resp_s3_a_wrong_object", ...standard, object: "response.compaction" },
      { id: "resp_s3_a_wrong_model", ...standard, model: "gpt-s3-a-other" },
      { id: "resp_s3_a_missing_output", object: "response", status: "completed", model: "gpt-s3-a-off" },
      { id: "resp s3 a unsafe", ...standard },
    ];
    for (const payload of invalid) {
      recordPassthroughResponse(history, firstBody, route, JSON.stringify(payload), headers);
      assert.equal(history.responseIdStateFor(payload.id), null);
    }
    recordPassthroughResponse(history, firstBody, route, JSON.stringify({ id: "resp_s3_a_no_task", ...standard }), {});
    assert.equal(history.responseIdStateFor("resp_s3_a_no_task"), null);

    const streamed = { id: "resp_s3_a_streamed", ...standard };
    recordPassthroughResponse(history, firstBody, route, `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: streamed })}\n\ndata: [DONE]\n\n`, headers);
    assert.ok(history.responseIdStateFor(streamed.id));
    const partial = { id: "resp_s3_a_partial_stream", ...standard, status: "in_progress" };
    recordPassthroughResponse(history, firstBody, route, `event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", response: partial })}\n\n`, headers);
    assert.equal(history.responseIdStateFor(partial.id), null);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("S3-B opt-in Responses continuation sends only strict input suffixes and survives encrypted restart state", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `resp_native_${received.length}`, object: "response", status: "completed", model: "gpt-native", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply-${received.length}` }] }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("native", "native-key");
    const configured = settings({
      providers: [{ id: "native", name: "Native", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: true }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Native", providerId: "native", upstreamModel: "gpt-native", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "native-thread", turn_id: "turn-1" }) };
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "first" }] }];
    let history = createChatHistory();
    const firstBody = { model: route.id, instructions: "stable", input: firstInput, stream: false };
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, route, firstRaw, headers, responseHistoryInfo(first));
    assert.equal(received[0].store, true);
    assert.equal(received[0].previous_response_id, undefined);

    store.saveContextCache(history.snapshot());
    history = createChatHistory(store.loadContextCache());
    const firstOutput = JSON.parse(firstRaw).output;
    const secondInput = [...firstInput, ...firstOutput, { role: "user", content: [{ type: "input_text", text: "second" }] }];
    const secondBody = { model: route.id, instructions: "stable", input: secondInput, stream: false };
    const second = await forwardResponses({ settings: configured, route, body: secondBody, headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "native-thread", turn_id: "turn-2" }) }, history });
    assert.equal(responseContextMode(second), "third_party_automatic_native");
    assert.equal(received[1].previous_response_id, "resp_native_1");
    assert.deepEqual(received[1].input, secondInput.slice(firstInput.length + firstOutput.length));
    assert.equal(received[1].store, true);

    const rewritten = await forwardResponses({ settings: configured, route, body: { ...secondBody, instructions: "changed" }, headers, history });
    assert.equal(received[2].previous_response_id, undefined);
    assert.deepEqual(received[2].input, secondInput);
    await rewritten.body?.cancel();
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("S3-B requires a verified standard ID, exact route, strict prefix, and unchanged fixed parameters", async () => {
  resetTestState();
  const primaryRequests = [];
  const foreignRequests = [];
  const createUpstream = (requests) => http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const nonstandard = JSON.stringify(body.input).includes("nonstandard-seed");
    const payload = {
      id: `resp_s3_b_${requests.length}`,
      object: "response",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply-${requests.length}` }] }],
      ...(!nonstandard ? { status: "completed", model: body.model } : {}),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  const primaryUpstream = createUpstream(primaryRequests);
  const foreignUpstream = createUpstream(foreignRequests);
  await Promise.all([
    new Promise((resolve) => primaryUpstream.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => foreignUpstream.listen(0, "127.0.0.1", resolve)),
  ]);
  try {
    store.saveProviderKey("s3-b-primary", "s3-b-primary-key");
    store.saveProviderKey("s3-b-foreign", "s3-b-foreign-key");
    const configured = settings({
      providers: [
        { id: "s3-b-primary", name: "Same display", baseUrl: `http://127.0.0.1:${primaryUpstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: true },
        { id: "s3-b-foreign", name: "Same display", baseUrl: `http://127.0.0.1:${foreignUpstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: true },
      ],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "Same display", providerId: "s3-b-primary", upstreamModel: "gpt-s3-b-one", contextWindow: 128000, supportsImages: false, dropParams: [] },
        { id: "relay-third-party-2", displayName: "Same display", providerId: "s3-b-primary", upstreamModel: "gpt-s3-b-two", contextWindow: 128000, supportsImages: false, dropParams: [] },
        { id: "relay-third-party-3", displayName: "Same display", providerId: "s3-b-foreign", upstreamModel: "gpt-s3-b-one", contextWindow: 128000, supportsImages: false, dropParams: [] },
      ],
    });
    const primaryRoute = routeForRequest(configured, "relay-third-party-1");
    const secondModelRoute = routeForRequest(configured, "relay-third-party-2");
    const foreignRoute = routeForRequest(configured, "relay-third-party-3");
    const history = createChatHistory();
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "s3-b-strict-thread", turn_id: "turn-1" }) };
    const tools = [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "first" }] }];
    const fixed = {
      instructions: "stable system instructions",
      tools,
      tool_choice: "auto",
      reasoning: { effort: "high", summary: "auto" },
      max_output_tokens: 512,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "s3-b-stable-cache-key",
      stream: false,
    };
    const firstBody = { model: primaryRoute.id, ...fixed, input: firstInput };
    const first = await forwardResponses({ settings: configured, route: primaryRoute, body: firstBody, headers, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, primaryRoute, firstRaw, headers, responseHistoryInfo(first));
    const firstResponse = JSON.parse(firstRaw);
    assert.ok(history.responseIdStateFor(firstResponse.id));
    assert.ok(history.snapshot().find((item) => item.id === firstResponse.id)?.nativeState);

    const fullInput = [...firstInput, ...firstResponse.output, { role: "user", content: [{ type: "input_text", text: "second" }] }];
    const baseSecondBody = { model: primaryRoute.id, ...fixed, input: fullInput };
    const assertFullRequest = async ({ route = primaryRoute, body = baseSecondBody, requestHeaders = headers, requests = primaryRequests }) => {
      const before = requests.length;
      const result = await forwardResponses({ settings: configured, route, body: { ...body, model: route.id }, headers: requestHeaders, history });
      assert.equal(result.status, 200);
      await result.text();
      assert.equal(requests.length, before + 1);
      const sent = requests.at(-1);
      assert.equal(sent.previous_response_id, undefined);
      assert.deepEqual(sent.input, body.input);
      return sent;
    };

    await assertFullRequest({ requestHeaders: {} });
    await assertFullRequest({ requestHeaders: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "s3-b-other-thread" }) } });
    await assertFullRequest({ body: { ...baseSecondBody, input: [{ role: "user", content: [{ type: "input_text", text: "edited-first" }] }, ...fullInput.slice(1)] } });
    await assertFullRequest({ body: { ...baseSecondBody, input: [...firstInput, ...firstResponse.output] } });
    await assertFullRequest({ body: { ...baseSecondBody, instructions: "changed system instructions" } });
    await assertFullRequest({ body: { ...baseSecondBody, tools: [{ ...tools[0], description: "Changed tool" }] } });
    await assertFullRequest({ body: { ...baseSecondBody, reasoning: { effort: "medium", summary: "auto" } } });
    await assertFullRequest({ body: { ...baseSecondBody, max_output_tokens: 513 } });
    await assertFullRequest({ body: { ...baseSecondBody, prompt_cache_key: "s3-b-changed-cache-key" } });
    await assertFullRequest({ route: secondModelRoute });
    await assertFullRequest({ route: foreignRoute, requests: foreignRequests });

    const nonstandardHeaders = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "s3-b-nonstandard-thread" }) };
    const nonstandardInput = [{ role: "user", content: [{ type: "input_text", text: "nonstandard-seed" }] }];
    const nonstandardBody = { model: primaryRoute.id, ...fixed, input: nonstandardInput };
    const nonstandard = await forwardResponses({ settings: configured, route: primaryRoute, body: nonstandardBody, headers: nonstandardHeaders, history });
    const nonstandardRaw = await nonstandard.text();
    const nonstandardResponse = JSON.parse(nonstandardRaw);
    recordPassthroughResponse(history, nonstandardBody, primaryRoute, nonstandardRaw, nonstandardHeaders, responseHistoryInfo(nonstandard));
    assert.equal(history.responseIdStateFor(nonstandardResponse.id), null);
    assert.equal(history.snapshot().find((item) => item.id === nonstandardResponse.id)?.nativeState, null);
    const nonstandardFullInput = [...nonstandardInput, ...nonstandardResponse.output, { role: "user", content: [{ type: "input_text", text: "continue" }] }];
    await assertFullRequest({ body: { ...nonstandardBody, input: nonstandardFullInput }, requestHeaders: nonstandardHeaders });
  } finally {
    await Promise.all([
      new Promise((resolve) => primaryUpstream.close(resolve)),
      new Promise((resolve) => foreignUpstream.close(resolve)),
    ]);
    resetTestState();
  }
});

test("automatic Responses continuation falls back once and remembers a rejected route", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    if (body.previous_response_id) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "previous_response_not_found", message: "previous_response_id does not exist" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `resp_reject_${received.length}`, object: "response", status: "completed", model: "gpt-reject", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("reject-native", "reject-key");
    const configured = settings({
      providers: [{ id: "reject-native", name: "Reject", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: true }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Reject", providerId: "reject-native", upstreamModel: "gpt-reject", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "reject-thread" }) };
    let history = createChatHistory();
    const one = [{ role: "user", content: [{ type: "input_text", text: "one" }] }];
    const firstBody = { model: route.id, input: one, stream: false };
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, route, firstRaw, headers, responseHistoryInfo(first));

    const firstOutput = JSON.parse(firstRaw).output;
    const two = [...one, ...firstOutput, { role: "user", content: [{ type: "input_text", text: "two" }] }];
    const secondBody = { model: route.id, input: two, stream: false };
    const beforeFallback = received.length;
    const second = await forwardResponses({ settings: configured, route, body: secondBody, headers, history });
    assert.equal(received.length - beforeFallback, 2);
    assert.equal(responseDiagnostics(second).retryReason, "automatic_previous_response_rejected");
    const secondRaw = await second.text();
    recordPassthroughResponse(history, secondBody, route, secondRaw, headers, responseHistoryInfo(second));

    const secondOutput = JSON.parse(secondRaw).output;
    const three = [...two, ...secondOutput, { role: "user", content: [{ type: "input_text", text: "three" }] }];
    const beforeThird = received.length;
    const third = await forwardResponses({ settings: configured, route, body: { model: route.id, input: three, stream: false }, headers, history });
    assert.equal(received.length - beforeThird, 1);
    assert.equal(received.at(-1).previous_response_id, undefined);
    assert.deepEqual(received.at(-1).input, three);
    assert.equal(responseDiagnostics(third).nativeContinuation.reason, "route_rejected_previous_response");
    await third.body?.cancel();
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("S3-D classifies only explicit previous-response rejection error shapes", () => {
  const cases = [
    [404, { error: { code: "previous_response_not_found", message: "previous_response_id does not exist" } }, true],
    [400, { error: { type: "invalid_request_error", param: "previous_response_id", message: "Invalid value" } }, true],
    [422, { detail: [{ loc: ["body", "previous_response_id"], msg: "Unknown response ID", type: "value_error" }] }, true],
    [409, "Previous response belongs to a different account and cannot continue", true],
    [400, { code: "invalid_previous_response", message: "Unknown previous response identifier" }, true],
    [400, { error: { param: "previous_response_id", message: "The previous response was not stored." } }, true],
    [400, { error: { type: "invalid_request_error", param: "tools", message: "Invalid tool schema" } }, false],
    [400, { error: { type: "rate_limit_error", param: "previous_response_id", message: "Rate limit exceeded" } }, false],
    [422, { detail: [{ loc: ["body", "previous_response_id"], msg: "Field required", type: "missing" }] }, false],
    [400, "<html>Bad request</html>", false],
    [404, { error: { code: "model_not_found", message: "Model does not exist" } }, false],
    [401, { error: { code: "previous_response_not_found", message: "previous_response_id does not exist" } }, false],
    [429, { error: { code: "previous_response_not_found", message: "previous_response_id does not exist" } }, false],
    [500, { error: { code: "previous_response_not_found", message: "previous_response_id does not exist" } }, false],
  ];
  for (const [status, payload, expected] of cases) {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    assert.equal(classifyPreviousResponseRejection(status, text), expected, `${status}: ${text}`);
  }
});

test("S3-D remembers an explicit automatic rejection even when the one fallback fails", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    if (body.previous_response_id) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", param: "previous_response_id", message: "Invalid value" } }));
      return;
    }
    if (received.length > 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "temporary_unavailable", message: "Temporary upstream failure" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_s3_d_first", object: "response", status: "completed", model: "gpt-s3-d", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "first reply" }] }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("s3-d", "s3-d-key");
    const configured = settings({
      providers: [{ id: "s3-d", name: "S3-D", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: true }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "S3-D", providerId: "s3-d", upstreamModel: "gpt-s3-d", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "s3-d-thread" }) };
    let history = createChatHistory();
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "first" }] }];
    const firstBody = { model: route.id, input: firstInput, stream: false };
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, route, firstRaw, headers, responseHistoryInfo(first));

    const firstOutput = JSON.parse(firstRaw).output;
    const secondInput = [...firstInput, ...firstOutput, { role: "user", content: [{ type: "input_text", text: "second" }] }];
    const beforeSecond = received.length;
    const second = await forwardResponses({ settings: configured, route, body: { model: route.id, input: secondInput, stream: false }, headers, history });
    assert.equal(second.status, 503);
    assert.equal(received.length - beforeSecond, 2);
    assert.equal(responseDiagnostics(second).attempts, 2);
    assert.equal(responseDiagnostics(second).retryReason, "automatic_previous_response_rejected");
    assert.equal(history.snapshot()[0].nativeState.blockedRouteSignatures.length, 1);
    await second.body?.cancel();

    history = createChatHistory(history.snapshot());
    const thirdInput = [...firstInput, ...firstOutput, { role: "user", content: [{ type: "input_text", text: "third" }] }];
    const beforeThird = received.length;
    const third = await forwardResponses({ settings: configured, route, body: { model: route.id, input: thirdInput, stream: false }, headers, history });
    assert.equal(third.status, 503);
    assert.equal(received.length - beforeThird, 1);
    assert.equal(received.at(-1).previous_response_id, undefined);
    assert.deepEqual(received.at(-1).input, thirdInput);
    assert.equal(responseDiagnostics(third).attempts, 1);
    assert.equal(responseDiagnostics(third).nativeContinuation.reason, "route_rejected_previous_response");
    await third.body?.cancel();
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Responses native continuation stays off by default and never crosses provider state domains", async () => {
  const firstRequests = [];
  const secondRequests = [];
  const createUpstream = (requests, id) => http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id, object: "response", status: "completed", model: "same-model", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: id }] }] }));
  });
  const firstUpstream = createUpstream(firstRequests, "resp_domain_first");
  const secondUpstream = createUpstream(secondRequests, "resp_domain_second");
  await Promise.all([
    new Promise((resolve) => firstUpstream.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => secondUpstream.listen(0, "127.0.0.1", resolve)),
  ]);
  try {
    store.saveProviderKey("domain-first", "domain-first-key");
    store.saveProviderKey("domain-second", "domain-second-key");
    const configured = settings({
      providers: [
        { id: "domain-first", name: "First", baseUrl: `http://127.0.0.1:${firstUpstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: true },
        { id: "domain-second", name: "Second", baseUrl: `http://127.0.0.1:${secondUpstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: true },
      ],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "First", providerId: "domain-first", upstreamModel: "same-model", contextWindow: 128000, supportsImages: false, dropParams: [] },
        { id: "relay-third-party-2", displayName: "Second", providerId: "domain-second", upstreamModel: "same-model", contextWindow: 128000, supportsImages: false, dropParams: [] },
      ],
    });
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "shared-domain-thread" }) };
    const history = createChatHistory();
    const firstRoute = routeForRequest(configured, "relay-third-party-1");
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "first" }] }];
    const firstBody = { model: firstRoute.id, input: firstInput, stream: false };
    const first = await forwardResponses({ settings: configured, route: firstRoute, body: firstBody, headers, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, firstRoute, firstRaw, headers, responseHistoryInfo(first));

    const secondRoute = routeForRequest(configured, "relay-third-party-2");
    const fullInput = [...firstInput, ...JSON.parse(firstRaw).output, { role: "user", content: [{ type: "input_text", text: "continue" }] }];
    const second = await forwardResponses({ settings: configured, route: secondRoute, body: { model: secondRoute.id, input: fullInput, stream: false }, headers, history });
    assert.equal(secondRequests[0].previous_response_id, undefined);
    assert.deepEqual(secondRequests[0].input, fullInput);
    await second.body?.cancel();

    const normalized = store.replaceSettings(settings({ providers: [{ id: "default-off", name: "Default off", baseUrl: "https://example.test/v1", apiType: "responses" }] }));
    assert.equal(normalized.providers[0].nativeResponseContinuation, false);
  } finally {
    await Promise.all([
      new Promise((resolve) => firstUpstream.close(resolve)),
      new Promise((resolve) => secondUpstream.close(resolve)),
    ]);
  }
});

test("Responses continuation does not invent state when the upstream omits a response id", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "no id" }] }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("no-id-native", "no-id-key");
    const configured = settings({
      providers: [{ id: "no-id-native", name: "No ID", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: true }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "No ID", providerId: "no-id-native", upstreamModel: "gpt-no-id", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const history = createChatHistory();
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "no-id-thread" }) };
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "one" }] }];
    const firstBody = { model: route.id, input: firstInput, stream: false };
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, route, firstRaw, headers, responseHistoryInfo(first));
    assert.equal(history.snapshot().length, 0);

    const secondInput = [...firstInput, { role: "user", content: [{ type: "input_text", text: "two" }] }];
    const second = await forwardResponses({ settings: configured, route, body: { model: route.id, input: secondInput, stream: false }, headers, history });
    assert.equal(received[1].previous_response_id, undefined);
    assert.deepEqual(received[1].input, secondInput);
    await second.body?.cancel();
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("S3-E isolates unknown third-party IDs without blocking the client request", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `resp_s3_e_${received.length}`, object: "response", status: "completed", model: "gpt-s3-e", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("s3-e-unknown", "s3-e-key");
    const configured = settings({
      providers: [{ id: "s3-e-unknown", name: "S3-E", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses" }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "S3-E", providerId: "s3-e-unknown", upstreamModel: "gpt-s3-e", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const body = { model: route.id, previous_response_id: "resp_from_missing_cache", input: [{ role: "user", content: [{ type: "input_text", text: "continue safely" }] }], stream: false };

    const unknown = await forwardResponses({ settings: configured, route, body, headers: {}, history: createChatHistory() });
    assert.equal(unknown.status, 200);
    assert.equal(received[0].previous_response_id, undefined);
    assert.deepEqual(received[0].input, body.input);
    await unknown.text();

    const corruptCache = createChatHistory([{ id: "resp_corrupt", routeId: "relay-third-party-1", messages: [{ role: "user", content: "untrusted" }], routeInfo: { routeId: "relay-third-party-1", stateDomain: "bad", routeSignature: "bad" }, responseIdState: { version: 1, taskHash: "bad" }, nativeState: { taskHash: "bad" } }]);
    const corrupt = await forwardResponses({ settings: configured, route, body: { ...body, previous_response_id: "resp_corrupt" }, headers: {}, history: corruptCache });
    assert.equal(corrupt.status, 200);
    assert.equal(received[1].previous_response_id, undefined);
    assert.deepEqual(received[1].input, body.input);
    await corrupt.text();
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("S3-E keeps automatic continuation opt-in per provider without inheritance", () => {
  const normalized = store.replaceSettings(settings({
    providers: [
      { id: "s3-e-enabled", name: "Enabled", baseUrl: "https://enabled.example/v1", apiType: "responses", nativeResponseContinuation: true },
      { id: "s3-e-new", name: "New provider", baseUrl: "https://new.example/v1", apiType: "responses" },
      { id: "s3-e-chat", name: "New Chat", baseUrl: "https://chat.example/v1", apiType: "chat_completions", nativeResponseContinuation: true },
    ],
    thirdPartySlots: [],
  }));
  assert.deepEqual(normalized.providers.map((provider) => provider.nativeResponseContinuation), [true, false, false]);
  assert.equal(store.loadSettings().providers.find((provider) => provider.id === "s3-e-new").nativeResponseContinuation, false);
});

test("S3-F probe persists sanitized progress before requests and after failures", async () => {
  const completePath = path.join(sandbox, "s3-f-probe", "complete.json");
  let completedCalls = 0;
  const complete = await runProbePlan({
    slotId: "relay-third-party-4",
    reportPath: completePath,
    executePhase: async ({ group, round }) => {
      completedCalls += 1;
      return {
        record: {
          status: 200,
          ok: true,
          elapsedMs: 10 + completedCalls,
          responseBytes: 200,
          idHash: "a".repeat(16),
          object: "response",
          responseStatus: "completed",
          model: "gpt-probe",
          usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 8 }, output_tokens: 2, total_tokens: 14 },
          diagnostics: { attempts: group === "on" && round === 2 ? 2 : 1, retryReason: group === "on" && round === 2 ? "automatic_previous_response_rejected" : null, inboundBytes: 100, upstreamBytes: 90 },
          outputTextMatched: true,
          rawId: "resp_must_not_persist",
          prompt: "prompt must not persist",
          apiKey: "sk-must-not-persist-abcdefghijklmnopqrstuvwxyz",
        },
        carry: { rawResponse: "also private" },
      };
    },
  });
  assert.equal(complete.status, "completed");
  assert.equal(complete.completedLogicalRequests, 4);
  assert.equal(complete.observedUpstreamAttempts, 5);
  const completeText = fs.readFileSync(completePath, "utf8");
  assert.equal(completeText.includes("resp_must_not_persist"), false);
  assert.equal(completeText.includes("prompt must not persist"), false);
  assert.equal(completeText.includes("sk-must-not-persist"), false);
  assert.equal(completeText.includes("also private"), false);

  const failedPath = path.join(sandbox, "s3-f-probe", "failed.json");
  let failedCalls = 0;
  const failed = await runProbePlan({
    slotId: "relay-third-party-4",
    reportPath: failedPath,
    executePhase: async () => {
      failedCalls += 1;
      if (failedCalls === 3) throw new Error("Bearer secret-value sk-abcdefghijklmnopqrstuvwxyz123456");
      return { record: { status: 200, ok: true, idHash: "b".repeat(16), object: "response", responseStatus: "completed", model: "gpt-probe", diagnostics: { attempts: 1 } } };
    },
  });
  assert.equal(failed.status, "inconclusive");
  assert.equal(failed.completedLogicalRequests, 2);
  const failedDisk = JSON.parse(fs.readFileSync(failedPath, "utf8"));
  assert.equal(failedDisk.events.at(-2).event, "request_started");
  assert.equal(failedDisk.events.at(-1).event, "request_failed");
  assert.match(failedDisk.events.at(-1).error, /\[redacted\]/);
  assert.equal(JSON.stringify(failedDisk).includes("secret-value"), false);
  assert.equal(JSON.stringify(failedDisk).includes("abcdefghijklmnopqrstuvwxyz123456"), false);
});

test("providers can use a full endpoint and a non-Bearer key header", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    received.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "provider_response", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  store.saveProviderKey("custom-auth", "provider-secret");
  const configured = settings({
    providers: [{ id: "custom-auth", name: "Custom", baseUrl: `http://127.0.0.1:${port}/v1`, endpointUrl: `http://127.0.0.1:${port}/custom/responses`, apiType: "responses", authHeaderName: "x-api-key", authHeaderPrefix: "", note: "", extraHeaders: { "x-tenant": "relay-test" } }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Custom", providerId: "custom-auth", upstreamModel: "custom-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  });
  const route = routeForRequest(configured, "relay-third-party-1");
  const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "hello" }, headers: {}, history: createChatHistory() });
  assert.equal(response.status, 200);
  assert.equal(received[0].url, "/custom/responses");
  assert.equal(received[0].headers["x-api-key"], "provider-secret");
  assert.equal(received[0].headers["x-tenant"], "relay-test");
  await new Promise((resolve) => upstream.close(resolve));
});

test("provider model discovery uses the saved provider credentials and returns model IDs", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer((request, response) => {
    received.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({ providers: [{ id: "discover", name: "Discover", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", authHeaderName: "x-api-key", authHeaderPrefix: "", extraHeaders: { "x-tenant": "relay" } }] }));
  store.saveProviderKey("discover", "discover-secret");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/discover/models`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.models, ["model-a", "model-b"]);
    assert.equal(received[0].url, "/v1/models");
    assert.equal(received[0].headers["x-api-key"], "discover-secret");
    assert.equal(received[0].headers["x-tenant"], "relay");
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("model capabilities use the upstream model ID and ignore user-supplied capability flags", async () => {
  resetTestState();
  store.replaceSettings(settings({ providers: [{ id: "responses", name: "Responses", baseUrl: "https://relay.example/v1", apiType: "responses" }], thirdPartySlots: [] }));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/slots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "relay-third-party-1", displayName: "用户随便起的名字", providerId: "responses", upstreamModel: "gpt-5.6-terra", contextWindow: 8000, supportsImages: false }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.slot.contextWindow, 272000);
    assert.equal(result.slot.supportsImages, true);
    const saved = store.loadSettings().thirdPartySlots[0];
    assert.equal(saved.contextWindow, 272000);
    assert.equal(saved.supportsImages, true);

    const capability = await fetch(`http://127.0.0.1:${port}/api/model-capability?providerId=responses&model=gpt-5.6-luna`).then((item) => item.json());
    assert.equal(capability.contextWindow, 272000);
    assert.equal(capability.supportsImages, true);
    assert.equal(capability.source, "builtin_profile");
    assert.deepEqual(capability.reasoning.levels.map((level) => level.effort), ["low", "medium", "high", "xhigh", "ultra", "max"]);
    assert.equal(capability.reasoning.transport, "responses");
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("provider model metadata overrides the built-in capability profile", async () => {
  resetTestState();
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "vendor-vision", context_window: 524288, input_modalities: ["text", "image"] }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({ providers: [{ id: "metadata", name: "Metadata", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses" }], thirdPartySlots: [] }));
  store.saveProviderKey("metadata", "metadata-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const models = await fetch(`http://127.0.0.1:${port}/api/providers/metadata/models`);
    assert.equal(models.status, 200);
    const capability = await fetch(`http://127.0.0.1:${port}/api/model-capability?providerId=metadata&model=vendor-vision`).then((item) => item.json());
    assert.equal(capability.contextWindow, 524288);
    assert.equal(capability.supportsImages, true);
    assert.equal(capability.source, "provider_metadata");
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("provider model discovery falls back to the v1 endpoint when the root address serves a web page", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/models") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>API Gateway</title>");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-sol" }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({ providers: [{ id: "gateway", name: "Gateway", baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiType: "responses", note: "", extraHeaders: {} }] }));
  store.saveProviderKey("gateway", "gateway-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/gateway/models`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(requests, ["/models", "/v1/models"]);
    assert.deepEqual(result.models, ["gpt-5.6-sol", "gpt-5.6-terra"]);
    assert.match(result.endpoint, /\/v1\/models$/);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("provider model discovery accepts a configured endpoint and nested model IDs", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { available_models: [{ model_id: "vendor/one" }, { slug: "vendor/two" }, { code: "vendor/one" }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${upstream.address().port}/catalogue`;
  store.replaceSettings(settings({ providers: [{ id: "nested", name: "Nested", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, modelListUrl: endpoint, apiType: "responses", note: "", extraHeaders: {} }] }));
  store.saveProviderKey("nested", "nested-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/nested/models`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.models, ["vendor/one", "vendor/two"]);
    assert.deepEqual(requests, ["/catalogue"]);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("provider model discovery never sends a key to a cross-origin legacy endpoint", async () => {
  resetTestState();
  const foreignRequests = [];
  const foreign = http.createServer((request, response) => {
    foreignRequests.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "must-not-be-read" }] }));
  });
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({ providers: [{ id: "isolated", name: "Isolated", baseUrl: "http://127.0.0.1:1/v1", modelListUrl: `http://127.0.0.1:${foreign.address().port}/models`, apiType: "responses" }] }));
  store.saveProviderKey("isolated", "isolated-secret");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/isolated/models`);
    assert.equal(response.status, 502);
    assert.deepEqual(foreignRequests, []);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => foreign.close(resolve));
  }
});

test("a configured provider balance is fetched only when requested and retained locally", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer((request, response) => {
    received.push({ url: request.url, key: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { wallet: { remaining: "0.82", currency: "usd" } } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const balanceUrl = `http://127.0.0.1:${upstream.address().port}/wallet`;
  store.replaceSettings(settings({ providers: [{ id: "balance", name: "Balance", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, balanceUrl, balancePath: "data.wallet.remaining", balanceCurrency: "USD", apiType: "chat_completions", note: "", extraHeaders: {} }] }));
  store.saveProviderKey("balance", "balance-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(received.length, 0);
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/balance/balance`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.balance.amount, 0.82);
    assert.equal(result.balance.currency, "USD");
    assert.equal(received[0].url, "/wallet");
    assert.equal(received[0].key, "Bearer balance-key");
    assert.equal(store.loadSettings().providers[0].balanceSnapshot.amount, 0.82);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("provider balance is discovered automatically and unsupported probes remain non-fatal", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push({ url: request.url, key: request.headers.authorization });
    if (request.url === "/v1/usage") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ quota: { remaining: "12.5", unit: "usd" } }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  store.replaceSettings(settings({ providers: [{ id: "automatic", name: "Automatic", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions" }] }));
  store.saveProviderKey("automatic", "automatic-secret");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/automatic/balance`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.detected, true);
    assert.equal(result.balance.amount, 12.5);
    assert.equal(result.balance.currency, "USD");
    assert.equal(requests[0].url, "/v1/usage");
    assert.equal(requests[0].key, "Bearer automatic-secret");

    store.replaceSettings(settings({ providers: [{ id: "unsupported", name: "Unsupported", baseUrl: "http://127.0.0.1:1/v1", apiType: "chat_completions" }] }));
    store.saveProviderKey("unsupported", "unsupported-secret");
    const unsupported = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/unsupported/balance`, { method: "POST" });
    const unsupportedResult = await unsupported.json();
    assert.equal(unsupported.status, 200);
    assert.equal(unsupportedResult.detected, false);
    assert.equal(store.loadSettings().providers[0].balanceProbe.status, "unsupported");
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("simple provider edits retain compatible internal settings and reset stale probes after an origin change", async () => {
  resetTestState();
  store.replaceSettings(settings({
    providers: [{
      id: "legacy", name: "Legacy", baseUrl: "https://old.example/v1", endpointUrl: "https://old.example/custom", modelListUrl: "https://old.example/catalogue",
      balanceUrl: "https://old.example/wallet", balancePath: "data.balance", balanceCurrency: "USD", balanceSnapshot: { amount: 4, currency: "USD", checkedAt: new Date().toISOString(), source: "legacy" },
      balanceProbe: { status: "detected", checkedAt: new Date().toISOString(), endpointKind: "legacy" }, apiType: "responses", authHeaderName: "x-api-key", authHeaderPrefix: "", extraHeaders: { "x-tenant": "one" },
    }],
    thirdPartySlots: [],
  }));
  store.saveProviderKey("legacy", "old-origin-secret");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const sameOrigin = await fetch(`http://127.0.0.1:${port}/api/providers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy", name: "Renamed", baseUrl: "https://old.example/v1", apiType: "chat_completions" }) });
    assert.equal(sameOrigin.status, 200);
    let saved = store.loadSettings().providers[0];
    assert.equal(saved.endpointUrl, "https://old.example/custom");
    assert.equal(saved.authHeaderName, "x-api-key");
    assert.deepEqual(saved.extraHeaders, { "x-tenant": "one" });

    const changedOrigin = await fetch(`http://127.0.0.1:${port}/api/providers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy", name: "Moved", baseUrl: "https://new.example/v1", apiType: "responses" }) });
    assert.equal(changedOrigin.status, 200);
    saved = store.loadSettings().providers[0];
    assert.equal(saved.endpointUrl, "");
    assert.equal(saved.modelListUrl, "");
    assert.equal(saved.balanceSnapshot, null);
    assert.equal(saved.balanceProbe.status, "never");
    assert.equal(saved.authHeaderName, "authorization");
    assert.equal(saved.authHeaderPrefix, "Bearer ");
    assert.deepEqual(saved.extraHeaders, {});
    assert.equal(store.hasProviderKey("legacy"), false);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("provider model test sends the exact model ID without changing the saved slot", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const configured = settings({ providers: [{ id: "testable", name: "Testable", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }] });
  store.replaceSettings(configured);
  store.saveProviderKey("testable", "test-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/testable/test-model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vendor/exact-model-2026" }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, { input: 2, cachedInput: 0, uncachedInput: 2, cacheReported: false, cacheHitRate: null, output: 1, reasoningOutput: 0, total: 3 });
    assert.equal(received[0].model, "vendor/exact-model-2026");
    assert.equal(received[0].max_tokens, 8);
    assert.deepEqual(store.loadSettings().thirdPartySlots, configured.thirdPartySlots.map((slot) => ({ ...slot, reasoningPreset: "auto" })));
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("model health reuses a recent successful Relay request without another upstream call", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "health-recent", name: "Health recent", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Recent", providerId: "health-recent", upstreamModel: "recent-model", contextWindow: 128_000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("health-recent", "recent-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${relay.address().port}`;
  try {
    const request = await fetch(`${baseUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "relay-third-party-1", input: "hello", stream: false }) });
    assert.equal(request.status, 200);
    const refresh = await fetch(`${baseUrl}/api/model-health/refresh`, { method: "POST" });
    assert.equal(refresh.status, 202);
    const health = await waitForModelHealth(baseUrl);
    assert.equal(health.entries["relay-third-party-1"].status, "available");
    assert.equal(health.entries["relay-third-party-1"].source, "recent_request");
    assert.equal(health.entries["relay-third-party-1"].httpStatus, 200);
    assert.equal(received.length, 1);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("model health verifies the exact model instead of treating a model catalog as proof", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "model temporarily unavailable" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    providers: [{ id: "health-catalog", name: "Health catalog", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Catalog", providerId: "health-catalog", upstreamModel: "catalog-model", contextWindow: 128_000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("health-catalog", "catalog-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${relay.address().port}`;
  try {
    const initial = await fetch(`${baseUrl}/api/model-health`).then((response) => response.json());
    assert.equal(initial.entries["relay-third-party-1"].status, "unknown");
    assert.equal(initial.entries["relay-third-party-1"].message, "");
    await fetch(`${baseUrl}/api/model-health/refresh`, { method: "POST" });
    const health = await waitForModelHealth(baseUrl);
    assert.equal(health.goodThresholdMs, 3_000);
    assert.equal(health.entries["relay-third-party-1"].status, "unavailable");
    assert.equal(health.entries["relay-third-party-1"].source, "minimal_probe");
    assert.equal(health.entries["relay-third-party-1"].httpStatus, 503);
    assert.equal(health.entries["relay-third-party-1"].tokenTotal, null);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, "POST");
    assert.equal(received[0].path, "/v1/chat/completions");
    assert.equal(received[0].body.model, "catalog-model");
    assert.equal(received[0].body.max_tokens, 1);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("model health falls back to one lightweight request for duplicate provider-model slots", async () => {
  resetTestState();
  const generated = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(404, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: "no model catalog" } }));
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    generated.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const configured = settings({
    providers: [{ id: "health-fallback", name: "Health fallback", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
    thirdPartySlots: [
      { id: "relay-third-party-1", displayName: "GPT A", providerId: "health-fallback", upstreamModel: "gpt-5.6-sol", contextWindow: 372_000, supportsImages: true, dropParams: [] },
      { id: "relay-third-party-2", displayName: "GPT B", providerId: "health-fallback", upstreamModel: "gpt-5.6-sol", contextWindow: 372_000, supportsImages: true, dropParams: [] },
    ],
  });
  store.replaceSettings(configured);
  store.saveProviderKey("health-fallback", "fallback-key");
  const before = structuredClone(store.loadSettings().thirdPartySlots);
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${relay.address().port}`;
  try {
    await fetch(`${baseUrl}/api/model-health/refresh`, { method: "POST" });
    const health = await waitForModelHealth(baseUrl);
    assert.equal(health.entries["relay-third-party-1"].source, "minimal_probe");
    assert.equal(health.entries["relay-third-party-2"].source, "minimal_probe");
    assert.equal(health.entries["relay-third-party-1"].tokenTotal, 3);
    assert.equal(generated.length, 1);
    assert.equal(generated[0].model, "gpt-5.6-sol");
    assert.equal(generated[0].max_tokens, 1);
    assert.equal(generated[0].reasoning_effort, "low");
    assert.deepEqual(store.loadSettings().thirdPartySlots, before);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("third-party in-flight diagnostics track one forwarded request and release it after completion", async () => {
  resetTestState();
  let requestStarted;
  const requestStartedPromise = new Promise((resolve) => { requestStarted = resolve; });
  let releaseUpstream;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the request before holding its response. */ }
    requestStarted();
    await new Promise((resolve) => { releaseUpstream = resolve; });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_in_flight",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "in-flight", name: "In-flight", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "In-flight", providerId: "in-flight", upstreamModel: "in-flight-model", contextWindow: 128_000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("in-flight", "in-flight-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${relay.address().port}`;
  try {
    const pending = fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "hold", stream: false }),
    });
    await requestStartedPromise;

    const inFlight = await fetch(`${baseUrl}/api/third-party-inflight`).then((response) => response.json());
    assert.equal(inFlight.total, 1);
    const providerInFlight = inFlight.providers.find((provider) => provider.providerId === "in-flight");
    assert.equal(providerInFlight.current, 1);
    assert.equal(providerInFlight.cancelling, 0);
    assert.match(providerInFlight.oldestStartedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(providerInFlight.oldestElapsedMs >= 0);

    const state = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    assert.equal(state.providers.find((provider) => provider.id === "in-flight").inFlight.current, 1);

    releaseUpstream();
    const completed = await pending;
    assert.equal(completed.status, 200);
    await completed.text();
    let released = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      released = await fetch(`${baseUrl}/api/third-party-inflight`).then((response) => response.json());
      if (released.total === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(released.total, 0);
  } finally {
    releaseUpstream?.();
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("third-party in-flight diagnostics release a cancelled request", async () => {
  resetTestState();
  let requestStarted;
  const requestStartedPromise = new Promise((resolve) => { requestStarted = resolve; });
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the request before waiting for the client to cancel. */ }
    requestStarted();
    await new Promise((resolve) => request.once("close", resolve));
    if (!response.writableEnded) response.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "in-flight-cancel", name: "In-flight cancel", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "In-flight cancel", providerId: "in-flight-cancel", upstreamModel: "in-flight-cancel-model", contextWindow: 128_000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("in-flight-cancel", "in-flight-cancel-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${relay.address().port}`;
  try {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "cancel", stream: false }),
      signal: controller.signal,
    });
    await requestStartedPromise;
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === "AbortError");

    let released = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      released = await fetch(`${baseUrl}/api/third-party-inflight`).then((response) => response.json());
      if (released.total === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(released.total, 0);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("an unreachable provider returns a 502 while the local Router remains available", async () => {
  const heldPort = await new Promise((resolve) => {
    const holder = http.createServer();
    holder.listen(0, "127.0.0.1", () => {
      const port = holder.address().port;
      holder.close(() => resolve(port));
    });
  });
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "offline", name: "Offline provider", baseUrl: `http://127.0.0.1:${heldPort}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Offline", providerId: "offline", upstreamModel: "offline-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("offline", "offline-test-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const failed = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "hello" }),
    });
    const failure = await failed.json();
    assert.equal(failed.status, 502);
    assert.equal(failure.error.code, "upstream_unreachable");

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("an upstream connection reset returns a structured 502 while the local Router remains available", async () => {
  const upstream = http.createServer(async (request) => {
    for await (const _chunk of request) { /* Drain the request before simulating a gateway reset. */ }
    request.socket.destroy();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "reset-provider", name: "Reset provider", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Reset model", providerId: "reset-provider", upstreamModel: "gpt-5.6-sol", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("reset-provider", "reset-provider-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const failed = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "hello" }),
    });
    const failure = await failed.json();
    assert.equal(failed.status, 502);
    assert.equal(failure.error.code, "upstream_unreachable");

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("management writes reject foreign browser origins", async () => {
  resetTestState();
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/providers`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Must not save", baseUrl: "https://provider.example/v1" }),
    });
    const result = await response.json();
    assert.equal(response.status, 403);
    assert.equal(result.error.code, "origin_not_allowed");
    assert.equal(store.loadSettings().providers.length, 0);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("provider deletion is blocked while a model uses it and removes its key when unused", async () => {
  resetTestState();
  store.replaceSettings(settings());
  store.saveProviderKey("deepseek", "delete-me");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const blocked = await fetch(`http://127.0.0.1:${port}/api/providers/deepseek`, { method: "DELETE" });
    assert.equal(blocked.status, 409);
    assert.equal(store.hasProviderKey("deepseek"), true);

    const cleared = await fetch(`http://127.0.0.1:${port}/api/slots/relay-third-party-1`, { method: "DELETE" });
    assert.equal(cleared.status, 200);
    const removed = await fetch(`http://127.0.0.1:${port}/api/providers/deepseek`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(store.loadSettings().providers.length, 0);
    assert.equal(store.hasProviderKey("deepseek"), false);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("request records preserve normalized upstream token usage", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const warm = received.length > 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "usage reply" } }], usage: { prompt_tokens: 3, prompt_cache_hit_tokens: warm ? 2 : 0, prompt_cache_miss_tokens: warm ? 1 : 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const upstreamPort = upstream.address().port;
    store.replaceSettings(settings({
      router: { host: "127.0.0.1", port: relay.address().port, running: true },
      providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
    }));
    store.saveProviderKey("deepseek", "usage-key");
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "usage", stream: false, reasoning: { effort: "xhigh" } }),
    });
    assert.equal(response.status, 200);
    const first = await response.json();
    const continued = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", previous_response_id: first.id, input: "continue", stream: false, reasoning: { effort: "xhigh" } }),
    });
    assert.equal(continued.status, 200);
    const second = await continued.json();
    const changedPrefix = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", previous_response_id: second.id, instructions: "A newly changed system instruction.", input: "continue again", stream: false, reasoning: { effort: "xhigh" } }),
    });
    assert.equal(changedPrefix.status, 200);
    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    assert.deepEqual(state.events[0].usage, { input: 3, cachedInput: 2, uncachedInput: 1, cacheReported: true, cacheHitRate: 66.7, output: 2, reasoningOutput: 0, total: 5 });
    assert.deepEqual(state.events[1].usage, { input: 3, cachedInput: 2, uncachedInput: 1, cacheReported: true, cacheHitRate: 66.7, output: 2, reasoningOutput: 0, total: 5 });
    assert.deepEqual(state.events[2].usage, { input: 3, cachedInput: 0, uncachedInput: 3, cacheReported: true, cacheHitRate: 0, output: 2, reasoningOutput: 0, total: 5 });
    assert.deepEqual({ attempts: state.events[0].diagnostics.attempts, retryReason: state.events[0].diagnostics.retryReason, removedTools: state.events[0].diagnostics.removedTools }, { attempts: 1, retryReason: null, removedTools: [] });
    assert.equal(state.events[1].diagnostics.cache.tracked, true);
    assert.equal(state.events[1].diagnostics.cache.prefixChanged, false);
    assert.deepEqual(state.events[1].diagnostics.cache.changeReasons, []);
    assert.match(state.events[1].diagnostics.cache.prefixHash, /^[a-f0-9]{16}$/);
    assert.deepEqual(state.events[2].diagnostics.cache.changeReasons, ["new_session"]);
    assert.equal(state.events[0].diagnostics.cache.prefixChanged, true);
    assert.ok(state.events[0].diagnostics.cache.changeReasons.includes("system"));
    assert.ok(state.events[0].diagnostics.cache.changeReasons.includes("history_rewrite"));
    assert.ok(state.events[0].diagnostics.upstreamBytes > 0);
    assert.equal(state.events[0].request.toolCount, 0);
    assert.ok(state.events[0].request.inboundBytes > 0);
    assert.deepEqual(received[0].messages, [{ role: "user", content: "usage" }]);
    assert.deepEqual(Object.keys(received[0]).sort(), ["messages", "model", "reasoning_effort", "stream", "thinking"].sort());
    assert.equal(received[0].reasoning_effort, "max");
    assert.deepEqual(state.events[0].reasoning, { selected: "xhigh", sent: "max", parameter: "reasoning_effort", preset: "deepseek", changed: true });
    const historyPage = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/request-history?limit=2`)).json();
    assert.equal(historyPage.total, 3);
    assert.equal(historyPage.items.length, 2);
    assert.equal(historyPage.hasMore, true);
    assert.equal(historyPage.retainedLimit, 10_000);
    const cleared = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/request-history`, {
      method: "DELETE",
      headers: { origin: `http://127.0.0.1:${relay.address().port}` },
    })).json();
    assert.equal(cleared.deleted, 3);
    const clearedState = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    assert.deepEqual(clearedState.events, []);
    assert.equal(clearedState.requestHistory.total, 0);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("lossless cost diagnostics preserve cache keys, hash task identity, and flag long full-context requests", async () => {
  resetTestState();
  let received = null;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_cost_diagnostic", object: "response", output: [], usage: { input_tokens: 60_000, input_tokens_details: { cached_tokens: 55_000 }, output_tokens: 120, total_tokens: 60_120 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    store.replaceSettings(settings({
      router: { host: "127.0.0.1", port: relay.address().port, running: true },
      providers: [{ id: "responses-cost", name: "Responses cost", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Responses cost", providerId: "responses-cost", upstreamModel: "gpt-5.6-sol", contextWindow: 372000, supportsImages: true, dropParams: [] }],
    }));
    store.saveProviderKey("responses-cost", "cost-key");
    const secretThreadId = "thread-must-never-appear-in-request-log";
    const promptCacheKey = "cache-key-must-reach-upstream";
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ thread_id: "lower-priority-header-thread" }) },
      body: JSON.stringify({ model: "relay-third-party-1", input: "x".repeat(1_000_100), stream: false, prompt_cache_key: promptCacheKey, client_metadata: { thread_id: secretThreadId, turn_id: "turn-secret" } }),
    });
    assert.equal(response.status, 200);
    assert.equal(received.prompt_cache_key, promptCacheKey);
    assert.deepEqual(received.client_metadata, { thread_id: secretThreadId, turn_id: "turn-secret" });

    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    const event = state.events[0];
    assert.equal(event.request.promptCacheKeyPresent, true);
    assert.equal(event.request.clientMetadataPresent, true);
    assert.equal(event.request.turnMetadataPresent, true);
    assert.equal(event.request.identitySource, "client_metadata.thread_id");
    assert.match(event.request.identityHash, /^[a-f0-9]{16}$/);
    assert.equal(event.diagnostics.cacheKey.preserved, true);
    assert.deepEqual(event.contextPressure, { level: "elevated", fullContext: true, cancelled: false, basedOn: "upstream_usage" });
    assert.doesNotMatch(JSON.stringify(event), /thread-must-never|lower-priority-header|turn-secret|cache-key-must/);
    assert.deepEqual(classifyContextPressure({ usage: { input: 100_000 }, request: { previousResponseIdPresent: false }, status: 499, contextMode: "new" }), { level: "high", fullContext: true, cancelled: true, basedOn: "upstream_usage" });
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("large failed Responses requests remain transparent when the same task repeats on the same upstream", async () => {
  resetTestState();
  let upstreamACount = 0;
  let upstreamBCount = 0;
  let upstreamAStatus = 524;
  const createFailingUpstream = (increment, status) => http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the paid request */ }
    increment();
    response.writeHead(status(), { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "upstream may have processed the request before timing out" } }));
  });
  const upstreamA = createFailingUpstream(() => { upstreamACount += 1; }, () => upstreamAStatus);
  const upstreamB = createFailingUpstream(() => { upstreamBCount += 1; }, () => 524);
  await new Promise((resolve) => upstreamA.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => upstreamB.listen(0, "127.0.0.1", resolve));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    store.replaceSettings(settings({
      router: { host: "127.0.0.1", port: relay.address().port, running: true },
      providers: [
        { id: "responses-paid-a", name: "Paid A", baseUrl: `http://127.0.0.1:${upstreamA.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} },
        { id: "responses-paid-b", name: "Paid B", baseUrl: `http://127.0.0.1:${upstreamB.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} },
      ],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "Paid A", providerId: "responses-paid-a", upstreamModel: "gpt-5.6-sol", contextWindow: 372000, supportsImages: true, dropParams: [] },
        { id: "relay-third-party-2", displayName: "Paid B", providerId: "responses-paid-b", upstreamModel: "gpt-5.6-sol", contextWindow: 372000, supportsImages: true, dropParams: [] },
        { id: "relay-third-party-3", displayName: "Paid A Terra", providerId: "responses-paid-a", upstreamModel: "gpt-5.6-terra", contextWindow: 372000, supportsImages: true, dropParams: [] },
      ],
    }));
    store.saveProviderKey("responses-paid-a", "paid-a-key");
    store.saveProviderKey("responses-paid-b", "paid-b-key");
    const endpoint = `http://127.0.0.1:${relay.address().port}/v1/responses`;
    const hugeInput = "long-visible-context ".repeat(110_000);
    const requestBody = (model, input = hugeInput, threadId = "paid-protection-thread", turnId = crypto.randomUUID()) => ({
      model,
      input,
      stream: false,
      prompt_cache_key: "stable-paid-cache-key",
      client_metadata: { thread_id: threadId, turn_id: turnId },
    });
    const send = (body) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const firstTurn = requestBody("relay-third-party-1", hugeInput, "paid-protection-thread", "paid-turn-524");
    const first = await send(firstTurn);
    assert.equal(first.status, 524);
    const repeated = await send(firstTurn);
    assert.equal(repeated.status, 524);
    assert.equal(upstreamACount, 2);

    const changedContent = await send(requestBody("relay-third-party-1", `${hugeInput}new user instruction`));
    assert.equal(changedContent.status, 524);
    assert.equal(upstreamACount, 3);

    const switchedUpstream = await send(requestBody("relay-third-party-2"));
    assert.equal(switchedUpstream.status, 524);
    assert.equal(upstreamBCount, 1);

    const switchedModel = await send(requestBody("relay-third-party-3"));
    assert.equal(switchedModel.status, 524);
    assert.equal(upstreamACount, 4);

    const differentTask = await send(requestBody("relay-third-party-1", hugeInput, "different-paid-protection-thread"));
    assert.equal(differentTask.status, 524);
    assert.equal(upstreamACount, 5);

    const small = requestBody("relay-third-party-1", "small request");
    assert.equal((await send(small)).status, 524);
    assert.equal((await send(small)).status, 524);
    assert.equal(upstreamACount, 7);

    upstreamAStatus = 502;
    const retryTurn = requestBody("relay-third-party-1", hugeInput, "paid-protection-thread", "paid-turn-502");
    assert.equal((await send(retryTurn)).status, 502);
    assert.equal((await send(retryTurn)).status, 502);
    const repeatedAfterRetry = await send(retryTurn);
    assert.equal(repeatedAfterRetry.status, 502);
    assert.equal(upstreamACount, 10);

    const nextTurn = requestBody("relay-third-party-1", hugeInput, "paid-protection-thread", "paid-turn-next-message");
    assert.equal((await send(nextTurn)).status, 502);
    assert.equal(upstreamACount, 11);

    const missingTurnScope = requestBody("relay-third-party-1", hugeInput, "paid-protection-thread");
    delete missingTurnScope.client_metadata.turn_id;
    assert.equal((await send(missingTurnScope)).status, 502);
    assert.equal((await send(missingTurnScope)).status, 502);
    assert.equal(upstreamACount, 13);

    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    assert.equal(state.events.some((event) => event.status === 422), false);
    const persisted = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/request-history?limit=20`)).json();
    assert.equal(persisted.items.some((event) => event.status === 422), false);
  } finally {
    upstreamA.closeAllConnections();
    upstreamB.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstreamA.close(resolve));
    await new Promise((resolve) => upstreamB.close(resolve));
  }
});

test("small Responses failures remain transparent without local retry blocking", async () => {
  resetTestState();
  let upstreamAStatus = 502;
  let upstreamBStatus = 502;
  let upstreamADelayMs = 0;
  let upstreamACount = 0;
  let upstreamBCount = 0;
  const failingUpstream = (status, increment, delay = () => 0) => http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    increment();
    if (delay() > 0) await new Promise((resolve) => setTimeout(resolve, delay()));
    const currentStatus = status();
    response.writeHead(currentStatus, { "content-type": "application/json" });
    response.end(currentStatus === 200
      ? JSON.stringify({ id: "upstream-response", output: [], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } })
      : JSON.stringify({ error: { message: `upstream ${currentStatus}` } }));
  });
  const upstreamA = failingUpstream(() => upstreamAStatus, () => { upstreamACount += 1; }, () => upstreamADelayMs);
  const upstreamB = failingUpstream(() => upstreamBStatus, () => { upstreamBCount += 1; });
  await new Promise((resolve) => upstreamA.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => upstreamB.listen(0, "127.0.0.1", resolve));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    store.replaceSettings(settings({
      router: { host: "127.0.0.1", port: relay.address().port, running: true },
      providers: [
        { id: "small-502-a", name: "Small 502 A", baseUrl: `http://127.0.0.1:${upstreamA.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} },
        { id: "small-502-b", name: "Small 502 B", baseUrl: `http://127.0.0.1:${upstreamB.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} },
      ],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "Small 502 A", providerId: "small-502-a", upstreamModel: "gpt-5.6-sol", contextWindow: 372000, supportsImages: true, dropParams: [] },
        { id: "relay-third-party-2", displayName: "Small 502 B", providerId: "small-502-b", upstreamModel: "gpt-5.6-sol", contextWindow: 372000, supportsImages: true, dropParams: [] },
        { id: "relay-third-party-3", displayName: "Small 502 Terra", providerId: "small-502-a", upstreamModel: "gpt-5.6-terra", contextWindow: 372000, supportsImages: true, dropParams: [] },
      ],
    }));
    store.saveProviderKey("small-502-a", "small-502-a-key");
    store.saveProviderKey("small-502-b", "small-502-b-key");
    const endpoint = `http://127.0.0.1:${relay.address().port}/v1/responses`;
    const smallInput = "small visible context ".repeat(5_000);
    const body = (taskId, turnId, model = "relay-third-party-1", input = smallInput) => ({
      model,
      input,
      stream: false,
      prompt_cache_key: "small-storm-cache-key",
      client_metadata: { thread_id: taskId, turn_id: turnId },
    });
    const send = async (payload) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const tasks = ["small-storm-task-a", "small-storm-task-b", "small-storm-task-c"].map((taskId) => body(taskId, "small-storm-turn"));

    for (let round = 0; round < 2; round += 1) {
      const responses = await Promise.all(tasks.map(send));
      assert.deepEqual(responses.map((response) => response.status), [502, 502, 502]);
    }
    const repeated = await Promise.all(tasks.map(send));
    assert.deepEqual(repeated.map((response) => response.status), [502, 502, 502]);
    assert.equal(upstreamACount, 9);

    assert.equal((await send(body("small-storm-task-a", "small-storm-next-turn"))).status, 502);
    assert.equal((await send(body("small-storm-task-a", "small-storm-turn", "relay-third-party-1", `${smallInput}changed`))).status, 502);
    assert.equal((await send(body("small-storm-task-a", "small-storm-turn", "relay-third-party-2"))).status, 502);
    assert.equal((await send(body("small-storm-task-a", "small-storm-turn", "relay-third-party-3"))).status, 502);
    assert.equal(upstreamACount, 12);
    assert.equal(upstreamBCount, 1);

    const missingTurn = body("small-storm-no-turn", "unused");
    delete missingTurn.client_metadata.turn_id;
    assert.deepEqual(await Promise.all([send(missingTurn), send(missingTurn), send(missingTurn)]).then((items) => items.map((item) => item.status)), [502, 502, 502]);
    assert.equal(upstreamACount, 15);

    upstreamAStatus = 524;
    const small524 = body("small-storm-524", "small-storm-524-turn");
    assert.deepEqual(await Promise.all([send(small524), send(small524), send(small524)]).then((items) => items.map((item) => item.status)), [524, 524, 524]);
    assert.equal(upstreamACount, 18);

    upstreamAStatus = 502;
    const successClears = body("small-storm-success-clears", "small-storm-success-turn");
    assert.equal((await send(successClears)).status, 502);
    upstreamAStatus = 200;
    assert.equal((await send(successClears)).status, 200);
    upstreamAStatus = 502;
    assert.equal((await send(successClears)).status, 502);
    assert.equal((await send(successClears)).status, 502);
    assert.equal((await send(successClears)).status, 502);

    const concurrentRetry = body("small-storm-concurrent", "small-storm-concurrent-turn");
    assert.equal((await send(concurrentRetry)).status, 502);
    const beforeConcurrentRetry = upstreamACount;
    upstreamADelayMs = 150;
    const concurrentRetryStatuses = await Promise.all([send(concurrentRetry), send(concurrentRetry), send(concurrentRetry)]).then((items) => items.map((item) => item.status).sort());
    upstreamADelayMs = 0;
    assert.deepEqual(concurrentRetryStatuses, [502, 502, 502]);
    assert.equal(upstreamACount, beforeConcurrentRetry + 3);

    const keyBoundary = body("small-storm-key", "small-storm-key-turn");
    const beforeKeyBoundary = upstreamACount;
    assert.equal((await send(keyBoundary)).status, 502);
    assert.equal((await send(keyBoundary)).status, 502);
    assert.equal((await send(keyBoundary)).status, 502);
    assert.equal(upstreamACount, beforeKeyBoundary + 3);
    store.saveProviderKey("small-502-a", "small-502-a-rotated-key");
    assert.equal((await send(keyBoundary)).status, 502);
    assert.equal(upstreamACount, beforeKeyBoundary + 4);

    const sendWithTurnHeader = (payload, turnMetadata) => fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": turnMetadata },
      body: JSON.stringify(payload),
    });
    for (const [label, encoded] of [
      ["json", JSON.stringify({ thread_id: "small-header-json-task", turn_id: "small-header-json-turn" })],
      ["base64url", Buffer.from(JSON.stringify({ thread_id: "small-header-base64-task", turn_id: "small-header-base64-turn" })).toString("base64url")],
    ]) {
      const headerPayload = { model: "relay-third-party-1", input: `small header ${label}`, stream: false };
      assert.equal((await sendWithTurnHeader(headerPayload, encoded)).status, 502);
      assert.equal((await sendWithTurnHeader(headerPayload, encoded)).status, 502);
      assert.equal((await sendWithTurnHeader(headerPayload, encoded)).status, 502);
    }

    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    assert.equal(state.events.some((event) => event.status === 422), false);

    const persisted = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/request-history?limit=100`)).json();
    assert.equal(persisted.items.some((event) => event.status === 422), false);
  } finally {
    upstreamA.closeAllConnections();
    upstreamB.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstreamA.close(resolve));
    await new Promise((resolve) => upstreamB.close(resolve));
  }
});

test("apply commits Relay only after the local health and model catalog checks pass", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  store.saveProviderKey("deepseek", "apply-test-key");
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/apply`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.applied, true);
    assert.equal(result.verified, true);
    assert.equal(result.publication.verified, true);
    assert.deepEqual(result.publication.publishedRoutes, ["relay-third-party-1"]);
    assert.match(fs.readFileSync(target, "utf8"), new RegExp(`base_url = "http://127\\.0\\.0\\.1:${port}/v1"`));
    assert.equal(store.relayApplicationStatus().configMatches, true);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.router.active, true);
    assert.equal(state.publication.modelCount, 1);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("apply reports the exact stage and restores config when another switcher rewrites it", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  store.saveProviderKey("deepseek", "config-race-key");
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-race"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  const external = 'model_provider = "custom"\nmodel = "external-race"\n\n[model_providers.custom]\nbase_url = "https://external.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  let changed = false;
  const watcher = setInterval(() => {
    if (!fs.existsSync(target)) return;
    const current = fs.readFileSync(target, "utf8");
    if (!changed && current.includes("# BEGIN CODEX RELAY")) {
      changed = true;
      fs.writeFileSync(target, external, "utf8");
    }
  }, 10);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/apply`, { method: "POST" });
    const result = await response.json();
    assert.equal(changed, true);
    assert.equal(response.status, 409);
    assert.equal(result.error.code, "relay_publication_failed");
    assert.equal(result.error.stage, "publication_precommit");
    assert.match(result.error.message, /其他程序改写/);
    assert.equal(fs.readFileSync(target, "utf8"), original);
    assert.equal(store.relayApplicationStatus().applied, false);
  } finally {
    clearInterval(watcher);
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("state reads never rewrite an external takeover and explicit repair does not steal it back", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  store.saveProviderKey("deepseek", "repair-test-key");
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const applied = await fetch(`http://127.0.0.1:${port}/api/apply`, { method: "POST" });
    assert.equal(applied.status, 200);
    fs.writeFileSync(target, 'model_provider = "custom"\nmodel = "overridden"\n\n[model_providers.custom]\nbase_url = "https://override.example/v1"\n', "utf8");

    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.connection.repaired, false);
    assert.equal(state.connection.externalTakeover, true);
    assert.match(fs.readFileSync(target, "utf8"), /https:\/\/override\.example\/v1/);

    const repairResponse = await fetch(`http://127.0.0.1:${port}/api/connection/repair`, { method: "POST" });
    const repair = await repairResponse.json();
    assert.equal(repairResponse.status, 409);
    assert.equal(repair.externalTakeover, true);
    assert.match(fs.readFileSync(target, "utf8"), /https:\/\/override\.example\/v1/);

    const restored = store.restorePreRelayState();
    assert.equal(restored.verified, true);
    assert.equal(fs.readFileSync(target, "utf8"), original);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("explicit repair restores a drifted configuration only while the Relay marker is still present", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  store.saveProviderKey("deepseek", "repair-test-key");
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const applied = await fetch(`http://127.0.0.1:${port}/api/apply`, { method: "POST" });
    assert.equal(applied.status, 200);
    const drifted = fs.readFileSync(target, "utf8").replace('model = "relay-third-party-1"', 'model = "relay-third-party-2"');
    fs.writeFileSync(target, drifted, "utf8");

    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.connection.repairEligible, false);
    assert.match(fs.readFileSync(target, "utf8"), /relay-third-party-2/);

    const repairedResponse = await fetch(`http://127.0.0.1:${port}/api/connection/repair`, { method: "POST" });
    const repaired = await repairedResponse.json();
    assert.equal(repairedResponse.status, 200);
    assert.equal(repaired.repaired, false);
    assert.match(fs.readFileSync(target, "utf8"), /model = "relay-third-party-2"/);

    const restored = store.restorePreRelayState();
    assert.equal(restored.verified, true);
    assert.equal(fs.readFileSync(target, "utf8"), original);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("a failed local health check leaves the pre-apply Codex config untouched", async () => {
  resetTestState();
  const routerPort = await reservePort();
  let managerPort = await reservePort();
  while (managerPort === routerPort) managerPort = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port: routerPort, running: false } }));
  store.saveProviderKey("deepseek", "health-failure-key");
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "stay-direct"\n\n[model_providers.custom]\nbase_url = "https://direct.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(managerPort, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${managerPort}/api/apply`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 503);
    assert.equal(result.error.code, "router_health_failed");
    assert.equal(fs.readFileSync(target, "utf8"), original);
    assert.equal(store.relayApplicationStatus().applied, false);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("direct Responses SSE is piped before the upstream stream completes", async () => {
  class FakeResponse extends EventEmitter {
    constructor() {
      super();
      this.writableEnded = false;
      this.chunks = [];
      this.firstWrite = new Promise((resolve) => { this.resolveFirstWrite = resolve; });
    }
    writeHead(status, headers) { this.status = status; this.headers = headers; }
    write(chunk) { this.chunks.push(Buffer.from(chunk)); this.resolveFirstWrite?.(); this.resolveFirstWrite = null; return true; }
    end() { this.writableEnded = true; }
  }
  const upstream = new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => controller.enqueue(new TextEncoder().encode("data: first\n\n")), 10);
      setTimeout(() => { controller.enqueue(new TextEncoder().encode("data: final\n\n")); controller.close(); }, 220);
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const result = new FakeResponse();
  const started = Date.now();
  const piping = pipeEventStream(result, upstream, { startedAt: started, headersAt: started + 4, detectedBy: "content_type", upstreamContentType: "text/event-stream" });
  await result.firstWrite;
  assert.ok(Date.now() - started < 150, "first SSE frame was buffered until completion");
  const completed = await piping;
  assert.equal(completed.error, false);
  assert.equal(completed.text, "data: first\n\ndata: final\n\n");
  assert.equal(result.writableEnded, true);
  assert.equal(completed.metrics.chunks, 2);
  assert.equal(completed.metrics.headersMs, 4);
  assert.ok(completed.metrics.firstChunkMs < 150);
  assert.equal(result.headers["x-accel-buffering"], "no");
});

test("streaming Responses with an incorrect content type are sniffed without buffering completion", async () => {
  const upstream = new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"first"}\n\n')), 10);
      setTimeout(() => { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); }, 220);
    },
  }), { status: 200, headers: { "content-type": "application/octet-stream" } });
  const started = Date.now();
  const classified = await classifyStreamingResponse(upstream, true);
  assert.equal(classified.streaming, true);
  assert.equal(classified.detectedBy, "body_sniff");
  assert.match(classified.response.headers.get("content-type"), /text\/event-stream/);
  const reader = classified.response.body.getReader();
  const first = await reader.read();
  assert.ok(Date.now() - started < 150, "sniffed SSE was buffered until completion");
  assert.match(new TextDecoder().decode(first.value), /response\.output_text\.delta/);
  while (!(await reader.read()).done) { /* drain the simulated upstream */ }
});

test("stream-requested JSON is not misclassified as SSE", async () => {
  const upstream = new Response(JSON.stringify({ id: "resp_json", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
  const classified = await classifyStreamingResponse(upstream, true);
  assert.equal(classified.streaming, false);
  assert.equal(classified.detectedBy, "non_sse_response");
  assert.equal((await classified.response.json()).id, "resp_json");
});

test("official passthrough history records completed tool turns without crashing", () => {
  resetTestState();
  const history = createChatHistory();
  const route = routeForRequest(settingsForOfficialRoute(), "gpt-5.6-terra");
  const request = {
    model: route.id,
    tools: [{ type: "function", name: "image_gen", description: "Generate an image", parameters: { type: "object" } }],
    input: [
      { type: "function_call", id: "fc_official_image", call_id: "call_official_image", name: "image_gen", arguments: "{\"prompt\":\"a green robot\"}" },
      { type: "function_call_output", call_id: "call_official_image", output: "generated-image.png" },
    ],
    stream: true,
  };
  const response = JSON.stringify({
    id: "resp_official_image",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Image generated." }] }],
  });

  assert.doesNotThrow(() => recordPassthroughResponse(history, request, route, response));
  const recorded = history.get("resp_official_image");
  assert.equal(recorded[0].role, "assistant");
  assert.equal(recorded[0].tool_calls[0].function.name, "image_gen");
  assert.equal(recorded[1].role, "tool");
  assert.equal(recorded[1].tool_call_id, "call_official_image");
  assert.equal(recorded.at(-1).content, "Image generated.");
});

test("official WebSocket completion survives a local history recording failure", async () => {
  resetTestState();
  captureOfficialToken("official-history-failure-token", "official-history-failure-account");
  store.replaceSettings({ ...settingsForOfficialRoute(), router: { host: "127.0.0.1", port: 15723, running: true } });

  const upstream = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstreamWss.on("connection", (socket) => socket.on("message", () => {
    socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_history_failure" } }));
    socket.send(JSON.stringify({
      type: "response.completed",
      response: { id: "resp_history_failure", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 1 } },
    }));
  }));
  upstream.on("upgrade", (request, socket, head) => {
    if (new URL(request.url, "http://localhost").pathname !== "/backend-api/codex/responses") return socket.destroy();
    upstreamWss.handleUpgrade(request, socket, head, (websocket) => upstreamWss.emit("connection", websocket));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const relay = http.createServer((_request, response) => response.end());
  const recorded = [];
  const websocketBridge = attachResponsesWebSocket(relay, {
    officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
    history: { record() { throw new Error("simulated history failure"); } },
    recordEvent: (event) => recorded.push(event),
    threadModelResolver: { resolve: async () => "gpt-5.6-terra", close() {} },
  });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));

  let client;
  try {
    client = await openWebSocket(`ws://127.0.0.1:${relay.address().port}/responses`, {
      headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-history-failure-thread" }) },
    });
    client.send(JSON.stringify({
      type: "response.create",
      model: "gpt-5.6-terra",
      input: [{ type: "function_call_output", call_id: "call_history_failure", output: "tool result" }],
      stream: true,
    }));
    assert.equal((await nextWebSocketJson(client)).type, "response.created");
    assert.equal((await nextWebSocketJson(client)).type, "response.completed");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].status, 200);
    assert.equal(recorded[0].ok, true);
  } finally {
    client?.terminate();
    websocketBridge.close();
    await new Promise((resolve) => relay.close(resolve));
    for (const socket of upstreamWss.clients) socket.terminate();
    upstreamWss.close();
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("official Responses WebSocket waits for cold route resolution and preserves native authentication", async () => {
  resetTestState();
  const upstreamServer = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  let receivedHeaders = null;
  let receivedFrame = null;
  upstreamWss.on("headers", (headers) => headers.push("x-codex-turn-state: native-turn-state"));
  upstreamWss.on("connection", (socket, request) => {
    receivedHeaders = request.headers;
    socket.on("message", (data) => {
      receivedFrame = JSON.parse(Buffer.from(data).toString("utf8"));
      socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_ws_official" } }));
      socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_ws_official", status: "completed", usage: { input_tokens: 3, output_tokens: 2 }, output: [] } }));
    });
  });
  upstreamServer.on("upgrade", (request, socket, head) => {
    if (new URL(request.url, "http://localhost").pathname !== "/backend-api/codex/responses") return socket.destroy();
    upstreamWss.handleUpgrade(request, socket, head, (websocket) => upstreamWss.emit("connection", websocket, request));
  });
  await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));

  let relay;
  let client;
  const recorded = [];
  let resolverWarmCalls = 0;
  let resolverTimeoutMs = 0;
  const coldResolver = {
    warm() { resolverWarmCalls += 1; return Promise.resolve(true); },
    async resolve(_threadId, timeoutMs) {
      resolverTimeoutMs = timeoutMs;
      await new Promise((resolve) => setTimeout(resolve, 125));
      return timeoutMs >= 125 ? "gpt-5.6-terra" : "";
    },
    close() {},
  };
  try {
    captureOfficialToken("official-ws-token", "official-ws-account");
    store.replaceSettings({ ...settingsForOfficialRoute(), router: { host: "127.0.0.1", port: 15723, running: true } });

    relay = createRawRelayServer({
      officialBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}/backend-api/codex`,
      responsesWebSocket: { recordEvent: (event) => recorded.push(event), threadModelResolver: coldResolver },
    });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    let turnState = "";
    client = new WebSocket(`ws://127.0.0.1:${relay.address().port}/v1/responses`, {
      headers: {
        authorization: "Bearer must-not-reach-official",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-ws-thread" }),
      },
    });
    client.once("upgrade", (response) => { turnState = String(response.headers["x-codex-turn-state"] || ""); });
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    client.send(JSON.stringify({
      type: "response.create",
      model: "gpt-5.6-terra",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      previous_response_id: "resp_native_previous",
      store: true,
      stream: true,
    }));
    assert.equal((await nextWebSocketJson(client)).type, "response.created");
    assert.equal((await nextWebSocketJson(client)).type, "response.completed");

    assert.equal(turnState, "native-turn-state");
    assert.equal(receivedHeaders.authorization, "Bearer official-ws-token");
    assert.equal(receivedHeaders["chatgpt-account-id"], "official-ws-account");
    assert.equal(receivedFrame.model, "gpt-5.6-terra");
    assert.equal(receivedFrame.store, false);
    assert.equal(receivedFrame.previous_response_id, "resp_native_previous");
    assert.equal(resolverWarmCalls, 1);
    assert.ok(resolverTimeoutMs >= 125);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].usage.input_tokens, 3);
    assert.equal(recorded[0].request.previousResponseIdPresent, true);
  } finally {
    client?.terminate();
    if (relay) await new Promise((resolve) => relay.close(resolve));
    for (const socket of upstreamWss.clients) socket.terminate();
    upstreamWss.close();
    await new Promise((resolve) => upstreamServer.close(resolve));
    resetTestState();
  }
});

test("official WebSocket retries until a newly created task becomes visible in the thread index", async () => {
  resetTestState();
  const upstream = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (request, socket, head) => {
    if (new URL(request.url, "http://localhost").pathname !== "/backend-api/codex/responses") return socket.destroy();
    upstreamWss.handleUpgrade(request, socket, head, (websocket) => upstreamWss.emit("connection", websocket));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const stateDb = path.join(path.dirname(store.paths().codexConfig), "state_5.sqlite");
  fs.mkdirSync(path.dirname(stateDb), { recursive: true });
  const database = new DatabaseSync(stateDb);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT)");
  database.close();
  let relay;
  let client;
  try {
    captureOfficialToken("official-index-race-token", "official-index-race-account");
    store.replaceSettings({ ...settingsForOfficialRoute(), router: { host: "127.0.0.1", port: 15723, running: true } });
    relay = createRawRelayServer({ officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/backend-api/codex` });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));

    const opening = openWebSocket(`ws://127.0.0.1:${relay.address().port}/v1/responses`, {
      headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "newly-visible-official-thread" }) },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const writer = new DatabaseSync(stateDb);
    writer.prepare("INSERT INTO threads (id, model) VALUES (?, ?)").run("newly-visible-official-thread", "gpt-5.6-terra");
    writer.close();
    client = await opening;
    assert.equal(client.readyState, WebSocket.OPEN);
  } finally {
    client?.terminate();
    if (relay) await new Promise((resolve) => relay.close(resolve));
    for (const socket of upstreamWss.clients) socket.terminate();
    upstreamWss.close();
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("official WebSocket rejection stays a handshake failure so Codex can use its HTTP fallback", async () => {
  resetTestState();
  const upstream = http.createServer();
  upstream.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let relay;
  try {
    captureOfficialToken("official-ws-reject-token", "official-ws-reject-account");
    store.replaceSettings({ ...settingsForOfficialRoute(), router: { host: "127.0.0.1", port: 15723, running: true } });
    const stateDb = path.join(path.dirname(store.paths().codexConfig), "state_5.sqlite");
    fs.mkdirSync(path.dirname(stateDb), { recursive: true });
    const database = new DatabaseSync(stateDb);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT)");
    database.prepare("INSERT INTO threads (id, model) VALUES (?, ?)").run("official-ws-reject-thread", "gpt-5.6-terra");
    database.close();
    relay = createRelayServer({ officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/backend-api/codex` });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));

    const status = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${relay.address().port}/v1/responses`, {
        headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-ws-reject-thread" }) },
      });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      socket.once("open", () => reject(new Error("Relay accepted a WebSocket after the official upstream rejected it.")));
      socket.once("error", () => { /* unexpected-response is the asserted result */ });
    });
    assert.equal(status, 426);
  } finally {
    if (relay) await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("third-party HTTP/SSE preserves tool contracts across turns", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    const id = `resp_http_fallback_${received.length}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [] } })}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "http-fallback", name: "HTTP fallback", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses" }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "HTTP fallback", providerId: "http-fallback", upstreamModel: "fallback-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("http-fallback", "http-fallback-key");
  let relay;
  try {
    relay = createRawRelayServer();
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const tools = [{ type: "function", name: "read_file", description: "Read a local file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
    const firstResponse = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "inspect through HTTP", tools, stream: true, store: false }),
    });
    assert.equal(firstResponse.status, 200);
    assert.match(await firstResponse.text(), /resp_http_fallback_1/);

    const secondResponse = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "relay-third-party-1",
        previous_response_id: "resp_http_fallback_1",
        input: [{ type: "function_call_output", call_id: "call_read_file", output: "file contents" }],
        tools,
        stream: true,
        store: false,
      }),
    });
    assert.equal(secondResponse.status, 200);
    assert.match(await secondResponse.text(), /resp_http_fallback_2/);
    assert.equal(received.length, 2);
    assert.equal(received[0].model, "fallback-model");
    assert.equal(received[0].input, "inspect through HTTP");
    assert.equal(received[0].tools[0].name, "read_file");
    assert.equal(received[1].tools[0].name, "read_file");
  } finally {
    if (relay) await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("abandoned WebSocket upgrades do not escape as uncaught socket errors", async () => {
  resetTestState();
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "upgrade-reset", name: "Upgrade reset", baseUrl: "http://127.0.0.1:9/v1", apiType: "responses" }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Upgrade reset", providerId: "upgrade-reset", upstreamModel: "reset-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("upgrade-reset", "upgrade-reset-key");
  const delayedResolver = {
    warm() { return Promise.resolve(true); },
    async resolve() {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return "relay-third-party-1";
    },
    close() {},
  };
  let uncaught = null;
  const onUncaught = (error) => { uncaught = error; };
  process.prependOnceListener("uncaughtException", onUncaught);
  let relay;
  let client;
  try {
    relay = createRawRelayServer({ responsesWebSocket: { threadModelResolver: delayedResolver } });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    client = net.createConnection({ host: "127.0.0.1", port: relay.address().port });
    client.on("error", () => {});
    client.write([
      "GET /v1/responses HTTP/1.1",
      `Host: 127.0.0.1:${relay.address().port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `x-codex-turn-metadata: ${JSON.stringify({ thread_id: "upgrade-reset-thread" })}`,
      "",
      "",
    ].join("\r\n"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(uncaught, null);
    const health = await fetch(`http://127.0.0.1:${relay.address().port}/health`);
    assert.equal(health.status, 200);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    client?.destroy();
    if (relay) await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("raw upgrade sockets consume a reset while an HTTP/SSE fallback is being resolved", async () => {
  resetTestState();
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "upgrade-read-reset", name: "Upgrade read reset", baseUrl: "http://127.0.0.1:9/v1", apiType: "responses" }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Upgrade read reset", providerId: "upgrade-read-reset", upstreamModel: "reset-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("upgrade-read-reset", "upgrade-read-reset-key");
  const delayedResolver = {
    warm() { return Promise.resolve(true); },
    async resolve() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "relay-third-party-1";
    },
    close() {},
  };
  const rawSocket = new EventEmitter();
  rawSocket.destroyed = false;
  rawSocket.writable = true;
  let fallbackResponse = "";
  rawSocket.end = (response) => { fallbackResponse = response; rawSocket.writable = false; };
  const request = {
    url: "/v1/responses",
    headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "upgrade-read-reset-thread" }) },
  };
  const relay = createRawRelayServer({ responsesWebSocket: { threadModelResolver: delayedResolver } });
  try {
    relay.emit("upgrade", request, rawSocket, Buffer.alloc(0));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reset = Object.assign(new Error("peer reset during upgrade read"), { code: "ECONNRESET" });
    assert.doesNotThrow(() => rawSocket.emit("error", reset));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.match(fallbackResponse, /^HTTP\/1\.1 426 Responses use HTTP\/SSE\./);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("WebSocket backpressure waits for a slow client and times out safely", async () => {
  let bufferedAmount = 20;
  const socket = { readyState: WebSocket.OPEN, get bufferedAmount() { return bufferedAmount; } };
  const releasing = waitForWebSocketCapacity(socket, { backpressureHighWaterMark: 10, backpressureLowWaterMark: 2, backpressureTimeoutMs: 200 });
  setTimeout(() => { bufferedAmount = 1; }, 30);
  await releasing;

  const stuck = { readyState: WebSocket.OPEN, bufferedAmount: 20 };
  await assert.rejects(
    waitForWebSocketCapacity(stuck, { backpressureHighWaterMark: 10, backpressureLowWaterMark: 2, backpressureTimeoutMs: 30 }),
    (error) => error.code === "websocket_backpressure_timeout",
  );
});

test("official WebSocket connection limit rejects excess clients", async () => {
  resetTestState();
  captureOfficialToken("official-limit-token", "official-limit-account");
  store.replaceSettings({
    ...settingsForOfficialRoute(),
    router: { host: "127.0.0.1", port: 15723, running: true },
  });
  const upstream = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (request, socket, head) => upstreamWss.handleUpgrade(request, socket, head, (websocket) => upstreamWss.emit("connection", websocket)));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const resolver = {
    warm() { return Promise.resolve(true); },
    resolve: async () => "gpt-5.6-terra",
    close() {},
  };
  let relay;
  const clients = [];
  try {
    relay = createRelayServer({
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
      responsesWebSocket: { maxConnections: 2, threadModelResolver: resolver },
    });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const options = { headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-limit-thread" }) } };
    clients.push(await openWebSocket(`ws://127.0.0.1:${relay.address().port}/responses`, options));
    clients.push(await openWebSocket(`ws://127.0.0.1:${relay.address().port}/responses`, options));
    const status = await new Promise((resolve) => {
      const third = new WebSocket(`ws://127.0.0.1:${relay.address().port}/responses`, options);
      third.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); });
      third.once("error", () => {});
    });
    assert.equal(status, 503);
  } finally {
    for (const client of clients) client.terminate();
    if (relay) await new Promise((resolve) => relay.close(resolve));
    for (const socket of upstreamWss.clients) socket.terminate();
    upstreamWss.close();
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("official WebSocket follows the upstream lifetime", async () => {
  resetTestState();
  captureOfficialToken("official-lifetime-token", "official-lifetime-account");
  let officialConnections = 0;
  let officialRequests = 0;
  const officialFrames = [];
  const upstream = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstreamWss.on("connection", (socket) => {
    officialConnections += 1;
    socket.on("message", async (data) => {
      officialRequests += 1;
      const frame = JSON.parse(Buffer.from(data).toString("utf8"));
      officialFrames.push(frame);
      const id = `resp_official_lifetime_${officialRequests}`;
      if (officialRequests === 1) await new Promise((resolve) => setTimeout(resolve, 120));
      socket.send(JSON.stringify({ type: "response.created", response: { id } }));
      socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } }));
    });
  });
  upstream.on("upgrade", (request, socket, head) => upstreamWss.handleUpgrade(request, socket, head, (websocket) => upstreamWss.emit("connection", websocket)));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings({
    ...settingsForOfficialRoute(),
    router: { host: "127.0.0.1", port: 15723, running: true },
  });
  const resolver = {
    warm() { return Promise.resolve(true); },
    resolve: async () => "gpt-5.6-terra",
    close() {},
  };
  let relay;
  let officialClient;
  let nextOfficialClient;
  try {
    relay = createRelayServer({
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
      responsesWebSocket: { heartbeatIntervalMs: 20, threadModelResolver: resolver },
    });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${relay.address().port}/responses`;
    const options = { headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-lifetime-thread" }) } };

    officialClient = await openWebSocket(url, options);
    officialClient.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-terra", input: "official first" }));
    assert.equal((await nextWebSocketJson(officialClient)).type, "response.created");
    assert.equal((await nextWebSocketJson(officialClient)).type, "response.completed");
    assert.equal(officialClient.readyState, WebSocket.OPEN);

    officialClient.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-terra", input: "official second", previous_response_id: "resp_official_lifetime_1" }));
    assert.equal((await nextWebSocketJson(officialClient)).type, "response.created");
    assert.equal((await nextWebSocketJson(officialClient)).type, "response.completed");
    assert.equal(officialConnections, 1);
    assert.equal(officialFrames[1].previous_response_id, "resp_official_lifetime_1");

    const officialClosed = new Promise((resolve) => officialClient.once("close", (code) => resolve(code)));
    for (const socket of upstreamWss.clients) socket.close(1001, "Official upstream lifetime reached.");
    assert.equal(await officialClosed, 1001);

    nextOfficialClient = await openWebSocket(url, options);
    nextOfficialClient.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-terra", input: "official after upstream reconnect" }));
    assert.equal((await nextWebSocketJson(nextOfficialClient)).type, "response.created");
    assert.equal((await nextWebSocketJson(nextOfficialClient)).type, "response.completed");
    assert.equal(officialConnections, 2);
  } finally {
    officialClient?.terminate();
    nextOfficialClient?.terminate();
    if (relay) await new Promise((resolve) => relay.close(resolve));
    for (const socket of upstreamWss.clients) socket.terminate();
    upstreamWss.close();
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("stale task-index routing is disabled after a model mismatch and does not repeat 1012", async () => {
  resetTestState();
  captureOfficialToken("stale-index-token", "stale-index-account");
  const upstreamServer = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstreamWss.on("connection", (socket) => socket.on("message", () => {
    socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_stale_index" } }));
    socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_stale_index", status: "completed", output: [] } }));
  }));
  upstreamServer.on("upgrade", (request, socket, head) => upstreamWss.handleUpgrade(request, socket, head, (websocket) => upstreamWss.emit("connection", websocket)));
  await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  let disabled = false;
  let resolves = 0;
  const resolver = {
    resolve: async () => { resolves += 1; return disabled ? "gpt-5.6-terra" : "gpt-5.6-sol"; },
    disablePreRouting: () => { disabled = true; },
    close() {},
  };
  store.replaceSettings({
    ...settings({
      router: { host: "127.0.0.1", port: 15723, running: true },
      official: { verified: true, lastCheckedAt: "2026-07-12T00:00:00.000Z", slots: [{ id: "gpt-5.6-terra", displayName: "Terra", upstreamModel: "gpt-5.6-terra" }, { id: "gpt-5.6-sol", displayName: "Sol", upstreamModel: "gpt-5.6-sol" }] },
      providers: [],
      thirdPartySlots: [],
    }),
  });
  let relay;
  let first;
  let second;
  try {
    relay = createRelayServer({ officialBaseUrl: `http://127.0.0.1:${upstreamServer.address().port}/backend-api/codex`, responsesWebSocket: { threadModelResolver: resolver } });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${relay.address().port}/responses`;
    first = await openWebSocket(url, { headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "stale-thread" }) } });
    const firstClosed = new Promise((resolve) => first.once("close", (code) => resolve(code)));
    first.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-terra", input: "official" }));
    assert.equal(await firstClosed, 1012);
    second = await openWebSocket(url, { headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "stale-thread" }) } });
    second.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-terra", input: "official after mismatch" }));
    assert.equal((await nextWebSocketJson(second)).type, "response.created");
    assert.equal((await nextWebSocketJson(second)).type, "response.completed");
    assert.equal(disabled, true);
    assert.equal(resolves, 2);
  } finally {
    first?.terminate();
    second?.terminate();
    if (relay) await new Promise((resolve) => relay.close(resolve));
    for (const socket of upstreamWss.clients) socket.terminate();
    upstreamWss.close();
    await new Promise((resolve) => upstreamServer.close(resolve));
    resetTestState();
  }
});

test("switching official model slots forces a fresh WebSocket state domain", async () => {
  resetTestState();
  captureOfficialToken("official-switch-token", "official-switch-account");
  const upstream = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstreamWss.on("connection", (socket) => socket.on("message", (data) => {
    const frame = JSON.parse(Buffer.from(data).toString("utf8"));
    const id = `resp_${frame.model}`;
    socket.send(JSON.stringify({ type: "response.created", response: { id } }));
    socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [] } }));
  }));
  upstream.on("upgrade", (request, socket, head) => upstreamWss.handleUpgrade(request, socket, head, (websocket) => upstreamWss.emit("connection", websocket)));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    official: { verified: true, slots: [{ id: "gpt-5.6-terra", displayName: "Terra", upstreamModel: "gpt-5.6-terra" }, { id: "gpt-5.6-sol", displayName: "Sol", upstreamModel: "gpt-5.6-sol" }] },
    providers: [],
    thirdPartySlots: [],
  }));
  let indexedModel = "gpt-5.6-terra";
  const resolver = {
    warm() { return Promise.resolve(true); },
    resolve: async () => indexedModel,
    disablePreRouting: () => { indexedModel = "gpt-5.6-sol"; },
    close() {},
  };
  let relay;
  let client;
  let nextClient;
  try {
    relay = createRelayServer({
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
      responsesWebSocket: { threadModelResolver: resolver },
    });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${relay.address().port}/responses`;
    const options = { headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-switch-thread" }) } };
    client = await openWebSocket(url, options);
    client.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-terra", input: "terra" }));
    assert.equal((await nextWebSocketJson(client)).type, "response.created");
    assert.equal((await nextWebSocketJson(client)).type, "response.completed");
    const closed = new Promise((resolve) => client.once("close", (code) => resolve(code)));
    client.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", input: "sol" }));
    assert.equal(await closed, 1012);

    indexedModel = "gpt-5.6-sol";
    nextClient = await openWebSocket(url, options);
    nextClient.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", input: "sol after reconnect" }));
    assert.equal((await nextWebSocketJson(nextClient)).type, "response.created");
    assert.equal((await nextWebSocketJson(nextClient)).type, "response.completed");
  } finally {
    client?.terminate();
    nextClient?.terminate();
    if (relay) await new Promise((resolve) => relay.close(resolve));
    for (const socket of upstreamWss.clients) socket.terminate();
    upstreamWss.close();
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("official WebSocket history can cross to third-party HTTP without leaking the official response ID", async () => {
  resetTestState();
  captureOfficialToken("official-boundary-token", "official-boundary-account");
  const receivedThirdParty = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    receivedThirdParty.push({ body, headers: request.headers });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_third_boundary", status: "completed", output: [] } })}\n\n`);
  });
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstreamWss.on("connection", (socket) => socket.on("message", () => {
    socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_official_boundary" } }));
    socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_official_boundary", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "official context" }] }] } }));
  }));
  upstream.on("upgrade", (request, socket, head) => {
    if (new URL(request.url, "http://localhost").pathname === "/backend-api/codex/responses") {
      upstreamWss.handleUpgrade(request, socket, head, (websocket) => upstreamWss.emit("connection", websocket));
    } else socket.destroy();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    official: { verified: true, slots: [{ id: "gpt-5.6-terra", displayName: "Terra", upstreamModel: "gpt-5.6-terra" }, { id: "gpt-5.6-sol", displayName: "Sol", upstreamModel: "gpt-5.6-sol" }] },
    providers: [{ id: "boundary-provider", name: "Boundary", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses" }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Boundary", providerId: "boundary-provider", upstreamModel: "boundary-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("boundary-provider", "boundary-key");
  const resolver = {
    warm() { return Promise.resolve(true); },
    resolve: async () => "gpt-5.6-terra",
    close() {},
  };
  let relay;
  let officialClient;
  try {
    relay = createRelayServer({
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
      responsesWebSocket: { threadModelResolver: resolver },
    });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    officialClient = await openWebSocket(`ws://127.0.0.1:${relay.address().port}/responses`, {
      headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-boundary-thread" }) },
    });
    officialClient.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-terra", input: "official first" }));
    assert.equal((await nextWebSocketJson(officialClient)).type, "response.created");
    assert.equal((await nextWebSocketJson(officialClient)).type, "response.completed");
    officialClient.terminate();

    const thirdPartyResponse = await fetch(`http://127.0.0.1:${relay.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", previous_response_id: "resp_official_boundary", input: "third party follow-up", stream: true }),
    });
    assert.equal(thirdPartyResponse.status, 200);
    await thirdPartyResponse.text();
    assert.equal(receivedThirdParty.length, 1);
    assert.equal(receivedThirdParty[0].body.previous_response_id, undefined);
    assert.equal(receivedThirdParty[0].headers.authorization, "Bearer boundary-key");
  } finally {
    officialClient?.terminate();
    if (relay) await new Promise((resolve) => relay.close(resolve));
    for (const socket of upstreamWss.clients) socket.terminate();
    upstreamWss.close();
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("official baselines keep full context and never auto-inject saved response IDs", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    const index = received.length;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_official_auto_${index}`,
      object: "response",
      status: "completed",
      model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `answer-${index}` }] }],
      error: null,
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken("official-auto-token", "official-auto-account");
    const configured = settingsForOfficialRoute();
    const route = routeForRequest(configured, "gpt-5.6-terra");
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-auto-thread" }) };
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "first" }] }];
    const firstBody = { model: route.id, input: firstInput, stream: false, store: false };
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers, history: createChatHistory(), officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    const firstRaw = await first.text();
    const firstHistory = createChatHistory();
    recordPassthroughResponse(firstHistory, firstBody, route, firstRaw, headers, responseHistoryInfo(first));
    const restartedHistory = createChatHistory(firstHistory.snapshot());
    const firstResponse = JSON.parse(firstRaw);
    const nextItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
    const secondInput = [...firstInput, ...firstResponse.output, nextItem];
    const secondBody = { model: route.id, input: secondInput, stream: false, store: false };
    const second = await forwardResponses({ settings: configured, route, body: secondBody, headers, history: restartedHistory, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    await second.text();

    assert.equal(received.length, 2);
    assert.equal(received[0].store, false);
    assert.equal(received[0].previous_response_id, undefined);
    assert.deepEqual(received[0].input, firstInput);
    assert.equal(received[1].store, false);
    assert.equal(received[1].previous_response_id, undefined);
    assert.deepEqual(received[1].input, secondInput);
    assert.equal(responseContextMode(second), "official_native_baseline");
    assert.equal(responseDiagnostics(second).attempts, 1);
    assert.equal(responseDiagnostics(second).nativeContinuation, undefined);
    assert.equal(restartedHistory.snapshot()[0].nativeState, null);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official completed SSE history never enables automatic ID injection", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_official_sse_next", object: "response", status: "completed", model: body.model, output: [], error: null }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken("official-sse-token", "official-sse-account");
    const configured = settingsForOfficialRoute();
    const route = routeForRequest(configured, "gpt-5.6-terra");
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-sse-thread" }) };
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "first" }] }];
    const firstOutput = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }];
    const firstResponse = { id: "resp_official_sse", object: "response", status: "completed", model: route.upstreamModel, output: firstOutput, error: null };
    const firstBody = { model: route.id, input: firstInput, stream: true, store: false };
    const history = createChatHistory();
    recordPassthroughResponse(history, firstBody, route, `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: firstResponse })}\n\ndata: [DONE]\n\n`, headers);
    const nextItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
    const fullInput = [...firstInput, ...firstOutput, nextItem];
    const continued = await forwardResponses({ settings: configured, route, body: { model: route.id, input: fullInput, stream: true, store: false }, headers, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    await continued.text();
    const unidentified = await forwardResponses({ settings: configured, route, body: { model: route.id, input: fullInput, stream: false, store: false }, headers: {}, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    await unidentified.text();

    assert.equal(received[0].previous_response_id, undefined);
    assert.deepEqual(received[0].input, fullInput);
    assert.equal(received[0].store, false);
    assert.equal(received[1].previous_response_id, undefined);
    assert.deepEqual(received[1].input, fullInput);
    assert.equal(received[1].store, false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official full-context baselines remain isolated across models and accounts", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ body, accountId: request.headers["chatgpt-account-id"] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_official_isolated_${received.length}`,
      object: "response",
      status: "completed",
      model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      error: null,
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken("official-account-a-token", "official-account-a");
    const configured = settingsForOfficialRoute();
    const terra = routeForRequest(configured, "gpt-5.6-terra");
    const sol = routeForRequest(configured, "gpt-5.5");
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-isolation-thread" }) };
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "start" }] }];
    const firstBody = { model: terra.id, input: firstInput, stream: false };
    const history = createChatHistory();
    const first = await forwardResponses({ settings: configured, route: terra, body: firstBody, headers, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, terra, firstRaw, headers, responseHistoryInfo(first));
    const fullInput = [...firstInput, ...JSON.parse(firstRaw).output, { role: "user", content: [{ type: "input_text", text: "continue" }] }];

    const modelSwitch = await forwardResponses({ settings: configured, route: sol, body: { model: sol.id, input: fullInput, stream: false }, headers, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    await modelSwitch.text();
    captureOfficialToken("official-account-b-token", "official-account-b");
    const accountSwitch = await forwardResponses({ settings: configured, route: terra, body: { model: terra.id, input: fullInput, stream: false }, headers, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    await accountSwitch.text();

    assert.equal(received.length, 3);
    assert.equal(received[1].body.previous_response_id, undefined);
    assert.deepEqual(received[1].body.input, fullInput);
    assert.equal(received[1].body.store, false);
    assert.equal(received[2].accountId, "official-account-b");
    assert.equal(received[2].body.previous_response_id, undefined);
    assert.deepEqual(received[2].body.input, fullInput);
    assert.equal(responseContextMode(modelSwitch), "official_native_baseline");
    assert.equal(responseContextMode(accountSwitch), "official_native_baseline");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official full-context baselines avoid speculative ID rejection and retry", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    if (body.previous_response_id) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { param: "previous_response_id", message: "previous_response_id is invalid" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_official_rejection_${received.length}`,
      object: "response",
      status: "completed",
      model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      error: null,
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken("official-rejection-token", "official-rejection-account");
    const configured = settingsForOfficialRoute();
    const route = routeForRequest(configured, "gpt-5.5");
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-rejection-thread" }) };
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "first" }] }];
    const firstBody = { model: route.id, input: firstInput, stream: false };
    const history = createChatHistory();
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, route, firstRaw, headers, responseHistoryInfo(first));
    const nextItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
    const fullInput = [...firstInput, ...JSON.parse(firstRaw).output, nextItem];
    const second = await forwardResponses({ settings: configured, route, body: { model: route.id, input: fullInput, stream: false }, headers, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    const secondRaw = await second.text();
    recordPassthroughResponse(history, { model: route.id, input: fullInput, stream: false }, route, secondRaw, headers, responseHistoryInfo(second));

    assert.equal(received.length, 2);
    assert.equal(received[1].previous_response_id, undefined);
    assert.deepEqual(received[1].input, fullInput);
    assert.equal(responseContextMode(second), "official_native_baseline");
    assert.equal(responseDiagnostics(second).attempts, 1);

    const thirdInput = [...fullInput, ...JSON.parse(secondRaw).output, { role: "user", content: [{ type: "input_text", text: "third" }] }];
    const beforeThird = received.length;
    const third = await forwardResponses({ settings: configured, route, body: { model: route.id, input: thirdInput, stream: false }, headers, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    await third.text();
    assert.equal(received.length - beforeThird, 1);
    assert.equal(received.at(-1).previous_response_id, undefined);
    assert.deepEqual(received.at(-1).input, thirdInput);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("client-provided official continuation never retries a 5xx response", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    if (body.previous_response_id) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "temporary gateway failure" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_official_5xx", object: "response", status: "completed", model: body.model, output: [], error: null }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken("official-5xx-token", "official-5xx-account");
    const configured = settingsForOfficialRoute();
    const route = routeForRequest(configured, "gpt-5.5");
    const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "official-5xx-thread" }) };
    const firstInput = [{ role: "user", content: [{ type: "input_text", text: "first" }] }];
    const firstBody = { model: route.id, input: firstInput, stream: false };
    const history = createChatHistory();
    const first = await forwardResponses({ settings: configured, route, body: firstBody, headers, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, route, firstRaw, headers, responseHistoryInfo(first));
    const nextInput = [{ role: "user", content: [{ type: "input_text", text: "second" }] }];
    const beforeSecond = received.length;
    const second = await forwardResponses({ settings: configured, route, body: { model: route.id, previous_response_id: "resp_official_5xx", input: nextInput, stream: false }, headers, history, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
    assert.equal(second.status, 502);
    assert.equal(received.length - beforeSecond, 1);
    assert.equal(received.at(-1).previous_response_id, "resp_official_5xx");
    assert.equal(responseDiagnostics(second).attempts, 1);
    await second.body?.cancel();
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("disabling official auto-continuation does not alter third-party Responses payloads", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_third_party_unchanged", object: "response", status: "completed", model: "third-party-model", output: [], error: null }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("official-isolation-third-party", "third-party-key");
    const configured = settings({
      providers: [{ id: "official-isolation-third-party", name: "Third Party", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", nativeResponseContinuation: false }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Third Party", providerId: "official-isolation-third-party", upstreamModel: "third-party-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const input = [{ role: "user", content: [{ type: "input_text", text: "unchanged" }] }];
    const body = { model: route.id, input, stream: false, store: false };
    const response = await forwardResponses({ settings: configured, route, body, headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "third-party-unchanged-thread" }) }, history: createChatHistory() });
    await response.text();
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { ...body, model: "third-party-model" });
    assert.equal(route.provider.nativeResponseContinuation, false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("SSE detection tolerates a data prefix split across network chunks", async () => {
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("d"));
      controller.enqueue(new TextEncoder().encode('ata: {"type":"response.output_text.delta","delta":"split"}\n\n'));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/octet-stream" } });
  const classified = await classifyStreamingResponse(upstream, true);
  assert.equal(classified.streaming, true);
  assert.equal(classified.detectedBy, "body_sniff");
  assert.match(await classified.response.text(), /^data:/);
});

async function reservePort() {
  return new Promise((resolve) => {
    const holder = http.createServer();
    holder.listen(0, "127.0.0.1", () => {
      const port = holder.address().port;
      holder.close(() => resolve(port));
    });
  });
}

test("official model switching retains the official response chain", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_next", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken();
    const settings = settingsForOfficialRoute();
    const route = routeForRequest(settings, "gpt-5.5");
    const history = createChatHistory();
    history.record("resp_terra", [{ role: "user", content: "Continue the current task" }], "gpt-5.6-terra");
    const response = await forwardResponses({
      settings,
      route,
      body: { model: route.id, previous_response_id: "resp_terra", input: "Use the second official model" },
      headers: { authorization: "Bearer official-account-token" },
      history,
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    assert.equal(response.status, 200);
    assert.equal(responseContextMode(response), "official_native_continuation");
    assert.equal(received[0].previous_response_id, "resp_terra");
    assert.equal(received[0].input, "Use the second official model");
    assert.equal(received[0].model, "gpt-5.5");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official switching falls back to portable context only after an upstream rejection", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    if (received.length === 1) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "previous response belongs to another model" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_fallback", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken();
    const settings = settingsForOfficialRoute();
    const route = routeForRequest(settings, "gpt-5.5");
    const history = createChatHistory();
    history.record("resp_terra", [{ role: "user", content: "Original task" }, { role: "assistant", content: "Existing work" }], "gpt-5.6-terra");
    const response = await forwardResponses({
      settings,
      route,
      body: { model: route.id, previous_response_id: "resp_terra", input: "Continue with the second model" },
      headers: { authorization: "Bearer official-account-token" },
      history,
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    assert.equal(response.status, 200);
    assert.equal(responseContextMode(response), "official_fallback_replayed");
    assert.equal(received.length, 2);
    assert.equal(received[0].previous_response_id, "resp_terra");
    assert.equal(received[1].previous_response_id, undefined);
    assert.deepEqual(received[1].input.map((item) => item.content[0].text), ["Original task", "Existing work", "Continue with the second model"]);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official authentication, permission, rate-limit, and unrelated parameter errors are never replayed", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    const status = Number(String(body.input).replace("status-", ""));
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "unrelated_error", message: "The request cannot be processed." } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken();
    const configured = settingsForOfficialRoute();
    const route = routeForRequest(configured, "gpt-5.5");
    const history = createChatHistory();
    history.record("resp_previous", [{ role: "user", content: "Existing task" }], "gpt-5.6-terra");
    for (const status of [400, 401, 403, 429]) {
      const response = await forwardResponses({
        settings: configured,
        route,
        body: { model: route.id, previous_response_id: "resp_previous", input: `status-${status}` },
        headers: {},
        history,
        officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
      });
      assert.equal(response.status, status);
      assert.equal(responseDiagnostics(response).attempts, 1);
      await response.body?.cancel();
    }
    assert.equal(received.length, 4);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official 502 responses remain transparent across repeated client sends", async () => {
  let upstreamCount = 0;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    upstreamCount += 1;
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "official_gateway_error", message: "temporary official gateway failure" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken();
    const configured = settingsForOfficialRoute();
    const route = routeForRequest(configured, "gpt-5.6-terra");
    for (let index = 0; index < 3; index += 1) {
      const response = await forwardResponses({
        settings: configured,
        route,
        body: { model: route.id, input: "small official request", stream: false },
        headers: {},
        history: createChatHistory(),
        officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
      });
      assert.equal(response.status, 502);
      assert.equal(responseDiagnostics(response).attempts, 1);
      await response.body?.cancel();
    }
    assert.equal(upstreamCount, 3);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official routes never forward a third-party Authorization header", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    received.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_official", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const officialToken = captureOfficialToken("official-access-token-only");
    const settings = settingsForOfficialRoute();
    const route = routeForRequest(settings, "gpt-5.6-terra");
    const response = await forwardResponses({
      settings,
      route,
      body: { model: route.id, input: "official request", stream: false },
      headers: { authorization: "Bearer third-party-api-key-must-not-leak", "x-api-key": "third-party-x-api-key-must-not-leak" },
      history: createChatHistory(),
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    assert.equal(response.status, 200);
    assert.equal(received[0].authorization, `Bearer ${officialToken}`);
    assert.equal(received[0]["chatgpt-account-id"], "test-account");
    assert.equal(received[0]["x-api-key"], undefined);
    assert.equal(received[0].accept, "text/event-stream");
    assert.doesNotMatch(JSON.stringify(received[0]), /third-party-api-key/);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("third-party Responses preserves the Codex request except for routing fields", async () => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    if (request.headers["x-openai-internal-codex-responses-lite"]) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "third-party gateway rejects the internal Responses Lite header" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"response.completed","response":{"id":"resp_passthrough","output":[]}}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("responses-pass", "responses-pass-key");
    const configured = settings({
      providers: [{ id: "responses-pass", name: "Responses pass", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "responses" }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Pass", providerId: "responses-pass", upstreamModel: "upstream-exact", contextWindow: 128000, supportsImages: false, dropParams: ["response_format"] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const input = [{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "wait", parameters: { type: "object" } }] }, { role: "user", content: [{ type: "input_text", text: "keep this" }] }];
    const tools = [{ type: "function", name: "read_file", description: "Read", parameters: { type: "object" } }];
    const response = await forwardResponses({
      settings: configured, route,
      body: { model: route.id, input, tools, stream: true, reasoning: { effort: "high" }, response_format: { type: "json_object" }, temperature: 0.2 },
      headers: {}, history: createChatHistory(),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(received.headers.authorization, "Bearer responses-pass-key");
    assert.equal(received.headers.accept, "text/event-stream");
    assert.equal(received.headers["x-openai-internal-codex-responses-lite"], undefined);
    assert.equal(received.body.model, "upstream-exact");
    assert.deepEqual(received.body.input, input);
    assert.deepEqual(received.body.tools, tools);
    assert.deepEqual(received.body.reasoning, { effort: "high" });
    assert.equal(received.body.stream, true);
    assert.equal(received.body.temperature, 0.2);
    assert.equal(received.body.response_format, undefined);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("third-party Responses removes only image_gen and retries once for its permission error", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    if (received.length === 1) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Image generation is not enabled for this group" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_ok", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("image-retry", "image-retry-key");
    const configured = settings({
      providers: [{ id: "image-retry", name: "Image retry", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses" }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "GPT", providerId: "image-retry", upstreamModel: "gpt-5.5", contextWindow: 272000, supportsImages: true, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const imageInput = [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }];
    const response = await forwardResponses({
      settings: configured,
      route,
      body: { model: route.id, input: imageInput, tools: [{ type: "namespace", name: "image_gen", tools: [] }, { type: "function", name: "read_file", parameters: { type: "object" } }] },
      headers: {},
      history: createChatHistory(),
    });
    assert.equal(response.status, 200);
    assert.equal(received.length, 2);
    assert.deepEqual(received[1].body.input, imageInput);
    assert.deepEqual(received[1].body.tools.map((tool) => tool.name), ["read_file"]);
    assert.deepEqual({ attempts: responseDiagnostics(response).attempts, retryReason: responseDiagnostics(response).retryReason, removedTools: responseDiagnostics(response).removedTools }, { attempts: 2, retryReason: "image_generation_not_enabled", removedTools: ["image_gen"] });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("usage normalization separates cached input from newly processed input", () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 37_802,
    input_tokens_details: { cached_tokens: 36_864 },
    output_tokens: 120,
    output_tokens_details: { reasoning_tokens: 20 },
    total_tokens: 37_922,
  }), { input: 37_802, cachedInput: 36_864, uncachedInput: 938, cacheReported: true, cacheHitRate: 97.5, output: 120, reasoningOutput: 20, total: 37_922 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens: 10, total_tokens: 110 }), { input: 100, cachedInput: 80, uncachedInput: 20, cacheReported: true, cacheHitRate: 80, output: 10, reasoningOutput: 0, total: 110 });
});

test("DeepSeek cache usage preserves reported hit and miss tokens", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36, completion_tokens: 10, total_tokens: 110 }), { input: 100, cachedInput: 64, uncachedInput: 36, cacheReported: true, cacheHitRate: 64, output: 10, reasoningOutput: 0, total: 110 });
});

test("an invalidated official token tells the user to sign in again instead of reporting a network failure", () => {
  const failure = officialUpstreamFailure(
    { kind: "official" },
    401,
    JSON.stringify({ error: { code: "token_invalidated", message: "Your authentication token has been invalidated." } }),
  );
  assert.equal(failure.code, "official_login_invalidated");
  assert.match(failure.message, /Sign in again/);
  assert.equal(officialUpstreamFailure({ kind: "third_party" }, 401, "token_invalidated"), null);
});

test("chat-completions routes isolate the provider key and retain a local response history", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: `reply-${received.length}` } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  store.saveProviderKey("deepseek", "provider-only-key");
  const configured = settings({ providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }] });
  const route = routeForRequest(configured, "relay-third-party-1");
  const history = createChatHistory();
  const first = await forwardResponses({ settings: configured, route, body: { model: route.id, instructions: "stable base instructions", input: [{ role: "developer", content: [{ type: "input_text", text: "stable workspace context" }] }, { role: "user", content: [{ type: "input_text", text: "first request" }] }], stream: false }, headers: { authorization: "Bearer official-token" }, history });
  const second = await forwardResponses({ settings: configured, route, body: { model: route.id, instructions: "stable base instructions", previous_response_id: first.id, input: [{ role: "developer", content: [{ type: "input_text", text: "stable workspace context" }] }, { role: "user", content: [{ type: "input_text", text: "second request" }] }], stream: false }, headers: { authorization: "Bearer official-token" }, history });

  assert.equal(first.output_text, "reply-1");
  assert.equal(second.output_text, "reply-2");
  assert.equal(first.codex_relay.cache_usage, undefined);
  assert.equal(responseDiagnostics(first).cache.tracked, true);
  assert.equal(received[0].headers.authorization, "Bearer provider-only-key");
  assert.equal(received[0].headers["chatgpt-account-id"], undefined);
  assert.equal(received[0].body.model, "deepseek-v4");
  assert.doesNotMatch(JSON.stringify(received[0]), /official-token/);
  assert.deepEqual(received[0].body.messages.map((message) => message.content), ["stable base instructions", "stable workspace context", "first request"]);
  assert.deepEqual(received[1].body.messages.map((message) => message.content), ["stable base instructions", "stable workspace context", "first request", "reply-1", "second request"]);
  assert.equal(received[1].body.messages.filter((message) => message.role === "system").length, 2);
  await new Promise((resolve) => upstream.close(resolve));
});

test("GLM 5.2 records cache-prefix diagnostics without changing the Chat payload", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: `reply-${received.length}` } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("glm-cache", "glm-cache-key");
    const configured = settings({
      providers: [{ id: "glm-cache", name: "GLM cache", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "GLM 5.2", providerId: "glm-cache", upstreamModel: "glm-5.2", contextWindow: 1_000_000, supportsImages: false, dropParams: [] },
        { id: "relay-third-party-2", displayName: "Generic Chat", providerId: "glm-cache", upstreamModel: "generic-chat-model", contextWindow: 128_000, supportsImages: false, dropParams: [] },
      ],
    });
    const tools = [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
    const history = createChatHistory();
    const glmRoute = routeForRequest(configured, "relay-third-party-1");
    const first = await forwardResponses({ settings: configured, route: glmRoute, body: { model: glmRoute.id, instructions: "stable", input: "first", tools }, headers: {}, history });
    const second = await forwardResponses({ settings: configured, route: glmRoute, body: { model: glmRoute.id, instructions: "stable", previous_response_id: first.id, input: "second", tools }, headers: {}, history });
    const genericRoute = routeForRequest(configured, "relay-third-party-2");
    const generic = await forwardResponses({ settings: configured, route: genericRoute, body: { model: genericRoute.id, input: "generic", tools }, headers: {}, history: createChatHistory() });

    assert.equal(responseDiagnostics(first).cache.tracked, true);
    assert.deepEqual(responseDiagnostics(first).cache.changeReasons, ["new_session"]);
    assert.equal(responseDiagnostics(second).cache.prefixChanged, false);
    assert.deepEqual(responseDiagnostics(second).cache.changeReasons, []);
    assert.ok(responseDiagnostics(second).cache.toolSchemaBytes > 0);
    assert.equal(responseDiagnostics(generic).cache, undefined);
    assert.equal(received[0].model, "glm-5.2");
    assert.equal(received[0].tools.length, 1);
    assert.equal(received[0].prompt_cache_key, undefined);
    assert.equal(received[1].prompt_cache_key, undefined);
    assert.equal(received[2].prompt_cache_key, undefined);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("DeepSeek savings mode shortens only old successful tool outputs in the upstream copy", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10, completion_tokens: 2, total_tokens: 102 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("deepseek-savings", "deepseek-savings-key");
    const configured = settings({
      deepSeekSavings: { enabled: true },
      providers: [{ id: "deepseek-savings", name: "DeepSeek", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "DeepSeek savings", providerId: "deepseek-savings", upstreamModel: "deepseek-v4-pro", contextWindow: 8_000, supportsImages: false, dropParams: [] }],
    });
    const input = [];
    const originals = [];
    for (let index = 0; index < 9; index += 1) {
      const callId = `call_${index}`;
      const content = index === 0 ? `Error: preserve this failure\n${"e".repeat(7_000)}` : `successful result ${index}\n${String(index).repeat(7_000)}`;
      originals.push(content);
      input.push({ type: "function_call", call_id: callId, name: "read_file", arguments: JSON.stringify({ index }) });
      input.push({ type: "function_call_output", call_id: callId, output: content });
    }
    const route = routeForRequest(configured, "relay-third-party-1");
    const disabled = await forwardResponses({ settings: { ...configured, deepSeekSavings: { enabled: false } }, route, body: { model: route.id, input, stream: false }, headers: {}, history: createChatHistory() });
    const history = createChatHistory();
    const result = await forwardResponses({ settings: configured, route, body: { model: route.id, input, stream: false }, headers: {}, history });
    assert.deepEqual(received[0].messages.filter((message) => message.role === "tool").map((message) => message.content), originals);
    assert.equal(responseDiagnostics(disabled).savings, undefined);
    const upstreamTools = received[1].messages.filter((message) => message.role === "tool");
    assert.equal(upstreamTools.length, 9);
    assert.equal(upstreamTools[0].content, originals[0]);
    assert.match(upstreamTools[1].content, /Codex Relay DeepSeek savings: omitted/);
    assert.match(upstreamTools[2].content, /Codex Relay DeepSeek savings: omitted/);
    assert.deepEqual(upstreamTools.slice(-6).map((message) => message.content), originals.slice(-6));
    const savedTools = history.get(result.id).filter((message) => message.role === "tool");
    assert.deepEqual(savedTools.map((message) => message.content), originals);
    const diagnostics = responseDiagnostics(result).savings;
    assert.equal(diagnostics.enabled, true);
    assert.equal(diagnostics.applied, true);
    assert.equal(diagnostics.level, "high");
    assert.equal(diagnostics.prunedToolOutputs, 2);
    assert.ok(diagnostics.estimatedTokensSaved > 0);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Chat routes preserve namespace, custom, and tool-search calls", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const names = received[0].tools.map((tool) => tool.function.name);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
      { id: "call_namespace", type: "function", function: { name: names.find((name) => name.includes("gmail")), arguments: '{"query":"project"}' } },
      { id: "call_custom", type: "function", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } },
      { id: "call_search", type: "function", function: { name: "tool_search", arguments: '{"query":"calendar","limit":3}' } },
    ] } }], usage: {} }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("tool-protocol", "tool-protocol-key");
    const configured = settings({
      providers: [{ id: "tool-protocol", name: "Tool protocol", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Tool protocol", providerId: "tool-protocol", upstreamModel: "chat-tool-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const tools = [
      { type: "namespace", name: "mcp__gmail", tools: [{ type: "function", name: "search", description: "Search Gmail", parameters: { type: "object", properties: { query: { type: "string" } } } }] },
      { type: "custom", name: "apply_patch", description: "Apply a patch" },
      { type: "tool_search", name: "tool_search" },
    ];
    const route = routeForRequest(configured, "relay-third-party-1");
    const result = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "use tools", tools, stream: false }, headers: {}, history: createChatHistory() });
    assert.deepEqual(received[0].tools.map((tool) => tool.function.name), ["mcp__gmail__search", "apply_patch", "tool_search"]);
    assert.equal(result.output[0].type, "function_call");
    assert.equal(result.output[0].namespace, "mcp__gmail");
    assert.equal(result.output[0].name, "search");
    assert.equal(result.output[1].type, "custom_tool_call");
    assert.equal(result.output[1].input, "*** Begin Patch\n*** End Patch");
    assert.equal(result.output[2].type, "tool_search_call");
    assert.deepEqual(result.output[2].arguments, { query: "calendar", limit: 3 });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("a 190 KB Responses request is converted once without amplification", async () => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = Buffer.concat(chunks);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("large-fixture", "large-fixture-key");
    const configured = settings({
      providers: [{ id: "large-fixture", name: "Large fixture", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Large fixture", providerId: "large-fixture", upstreamModel: "large-model", contextWindow: 272000, supportsImages: false, dropParams: [] }],
    });
    const body = { model: "relay-third-party-1", input: "hello", tools: [{ type: "function", name: "large_tool", description: "x".repeat(190_000), parameters: { type: "object", properties: {} } }], stream: false };
    const route = routeForRequest(configured, body.model);
    const result = await forwardResponses({ settings: configured, route, body, headers: {}, history: createChatHistory() });
    const inboundBytes = Buffer.byteLength(JSON.stringify(body));
    assert.ok(received.length <= inboundBytes + 2_000, `upstream ${received.length} amplified inbound ${inboundBytes}`);
    assert.equal(result.codex_relay.diagnostics.attempts, 1);
    assert.equal(result.codex_relay.diagnostics.inboundBytes, inboundBytes);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Compact capability targets isolate endpoints, authentication, keys, providers, and models", () => {
  const provider = {
    id: "compact-profile",
    baseUrl: "https://relay.example/v1/",
    apiType: "responses",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
    extraHeaders: { "x-tenant": "alpha" },
  };
  const base = compactCapabilityTarget({ provider, apiKey: "key-one", upstreamModel: "gpt-profile" });
  const same = compactCapabilityTarget({ provider: { ...provider, baseUrl: "https://relay.example/v1" }, apiKey: "key-one", upstreamModel: "gpt-profile" });
  const changedKey = compactCapabilityTarget({ provider, apiKey: "key-two", upstreamModel: "gpt-profile" });
  const changedModel = compactCapabilityTarget({ provider, apiKey: "key-one", upstreamModel: "gpt-profile-mini" });
  const changedEndpoint = compactCapabilityTarget({ provider, apiKey: "key-one", upstreamModel: "gpt-profile", endpointUrl: "https://relay.example/custom/responses/compact" });
  const changedAuth = compactCapabilityTarget({ provider: { ...provider, authHeaderName: "x-api-key", authHeaderPrefix: "" }, apiKey: "key-one", upstreamModel: "gpt-profile" });
  const changedProvider = compactCapabilityTarget({ provider: { ...provider, id: "compact-profile-2" }, apiKey: "key-one", upstreamModel: "gpt-profile" });

  assert.equal(base.stateDomain, same.stateDomain);
  assert.equal(base.routeSignature, same.routeSignature);
  assert.notEqual(base.stateDomain, changedKey.stateDomain);
  assert.equal(base.stateDomain, changedModel.stateDomain);
  assert.notEqual(base.routeSignature, changedModel.routeSignature);
  assert.notEqual(base.stateDomain, changedEndpoint.stateDomain);
  assert.notEqual(base.stateDomain, changedAuth.stateDomain);
  assert.notEqual(base.stateDomain, changedProvider.stateDomain);
  assert.equal(compactCapabilityTarget({ provider: { ...provider, apiType: "chat_completions" }, apiKey: "key-one", upstreamModel: "gpt-profile" }), null);
  assert.equal(compactCapabilityTarget({ provider, apiKey: "", upstreamModel: "gpt-profile" }), null);
});

test("Compact capability profiles persist without keys or request content and survive reload", () => {
  resetTestState();
  const provider = { id: "compact-persist", name: "Compact persist", baseUrl: "https://persist.example/v1", apiType: "responses", authHeaderName: "x-api-key", authHeaderPrefix: "", extraHeaders: { "x-tenant": "persist" } };
  const secretKey = "secret-compact-key-must-not-be-stored";
  const target = compactCapabilityTarget({ provider, apiKey: secretKey, upstreamModel: "gpt-persist" });
  const compactCapabilities = recordCompactCapability([], target, { status: "supported", reason: "valid_compaction", now: "2026-07-17T00:00:00.000Z" });
  store.replaceSettings(settings({
    providers: [provider],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Persist", providerId: provider.id, upstreamModel: "gpt-persist" }],
    compactCapabilities,
  }));

  const reloaded = store.loadSettings();
  const status = compactCapabilityStatus(reloaded.compactCapabilities, target, { now: "2026-07-18T00:00:00.000Z" });
  assert.equal(status.status, "supported");
  assert.equal(status.reason, "valid_compaction");
  assert.equal(status.profile.version, COMPACT_CAPABILITY_PROFILE_VERSION);
  assert.equal(reloaded.compactCapabilities.length, 1);
  assert.equal(compactCapabilityStatus(reloaded.compactCapabilities, compactCapabilityTarget({ provider, apiKey: "changed-key", upstreamModel: "gpt-persist" }), { now: "2026-07-18T00:00:00.000Z" }).status, "unknown");
  assert.equal(compactCapabilityStatus(reloaded.compactCapabilities, compactCapabilityTarget({ provider, apiKey: secretKey, upstreamModel: "gpt-persist-mini" }), { now: "2026-07-18T00:00:00.000Z" }).status, "unknown");
  assert.equal(compactCapabilityStatus(reloaded.compactCapabilities, compactCapabilityTarget({ provider: { ...provider, id: "compact-persist-other" }, apiKey: secretKey, upstreamModel: "gpt-persist" }), { now: "2026-07-18T00:00:00.000Z" }).status, "unknown");

  const persisted = fs.readFileSync(store.paths().config, "utf8");
  assert.doesNotMatch(persisted, new RegExp(secretKey));
  assert.doesNotMatch(persisted, /prompt|request body|task id/i);
  assert.match(persisted, /"compactCapabilities"/);
  assert.match(persisted, /"status": "supported"/);
});

test("Compact capability runtime persistence coalesces the latest route family off the Router thread", async () => {
  resetTestState();
  const provider = { id: "compact-worker", name: "Compact worker", baseUrl: "https://worker.example/v1", apiType: "responses", authHeaderName: "authorization", authHeaderPrefix: "Bearer ", extraHeaders: {} };
  const oldTarget = compactCapabilityTarget({ provider, apiKey: "old-worker-key", upstreamModel: "gpt-worker" });
  const currentTarget = compactCapabilityTarget({ provider, apiKey: "current-worker-key", upstreamModel: "gpt-worker" });
  const baseProfiles = recordCompactCapability([], oldTarget, { status: "supported", reason: "old_route", now: "2026-07-17T00:00:00.000Z" });

  compactCapabilityPersistence.enqueueCompactCapabilityResult(currentTarget, { outcome: "temporary_failure", reason: "http_502" }, { now: "2026-07-17T01:00:00.000Z" });
  compactCapabilityPersistence.enqueueCompactCapabilityResult(currentTarget, { outcome: "unsupported", reason: "http_404" }, { now: "2026-07-17T01:00:01.000Z" });
  const flush = compactCapabilityPersistence.flushCompactCapabilityWriter();
  const eventLoopStayedResponsive = await Promise.race([
    new Promise((resolve) => setTimeout(() => resolve(true), 0)),
    flush.then(() => false),
  ]);
  assert.equal(eventLoopStayedResponsive, true);
  await flush;

  const merged = compactCapabilityPersistence.compactCapabilityProfiles(baseProfiles);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].routeSignature, currentTarget.routeSignature);
  assert.equal(merged[0].status, "unsupported");
  const persisted = JSON.parse(fs.readFileSync(compactCapabilityPersistence.compactCapabilityPersistencePath(), "utf8"));
  assert.equal(persisted.profiles.length, 1);
  assert.equal(persisted.profiles[0].status, "unsupported");
  assert.equal(compactCapabilityPersistence.compactCapabilityWriterState().pending, false);
  assert.equal(compactCapabilityPersistence.compactCapabilityWriterState().inFlight, false);
  await compactCapabilityPersistence.closeCompactCapabilityWriter();
});

test("management state does not expose Compact capability route fingerprints", async () => {
  resetTestState();
  const provider = { id: "compact-private", name: "Compact private", baseUrl: "https://private.example/v1", apiType: "responses" };
  const target = compactCapabilityTarget({ provider, apiKey: "private-key", upstreamModel: "gpt-private" });
  const compactCapabilities = recordCompactCapability([], target, { status: "unsupported", reason: "http_404", now: "2026-07-17T00:00:00.000Z" });
  store.replaceSettings(settings({ providers: [provider], thirdPartySlots: [], compactCapabilities }));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const state = await fetch(`http://127.0.0.1:${relay.address().port}/api/state`).then((response) => response.json());
    const serialized = JSON.stringify(state);
    assert.doesNotMatch(serialized, new RegExp(target.stateDomain));
    assert.doesNotMatch(serialized, new RegExp(target.routeSignature));
    assert.equal(Object.prototype.hasOwnProperty.call(state, "compactCapabilities"), false);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("management state summarizes current provider Compact capability without exposing keys or fingerprints", async () => {
  resetTestState();
  const checkedAt = new Date().toISOString();
  const providers = [
    { id: "compact-supported-view", name: "Supported", baseUrl: "https://supported.example/v1", apiType: "responses" },
    { id: "compact-unsupported-view", name: "Unsupported", baseUrl: "https://unsupported.example/v1", apiType: "responses" },
    { id: "compact-temporary-view", name: "Temporary", baseUrl: "https://temporary.example/v1", apiType: "responses" },
    { id: "compact-mixed-view", name: "Mixed", baseUrl: "https://mixed.example/v1", apiType: "responses" },
    { id: "compact-automatic-view", name: "Automatic", baseUrl: "https://automatic.example/v1", apiType: "responses" },
    { id: "compact-chat-view", name: "Chat", baseUrl: "https://chat.example/v1", apiType: "chat_completions" },
  ];
  const thirdPartySlots = [
    { id: "relay-third-party-1", displayName: "Supported", providerId: providers[0].id, upstreamModel: "gpt-supported" },
    { id: "relay-third-party-2", displayName: "Unsupported", providerId: providers[1].id, upstreamModel: "gpt-unsupported" },
    { id: "relay-third-party-3", displayName: "Temporary", providerId: providers[2].id, upstreamModel: "gpt-temporary" },
    { id: "relay-third-party-4", displayName: "Mixed A", providerId: providers[3].id, upstreamModel: "gpt-mixed-a" },
    { id: "relay-third-party-5", displayName: "Mixed B", providerId: providers[3].id, upstreamModel: "gpt-mixed-b" },
  ];
  let compactCapabilities = [];
  const capabilityStatuses = ["supported", "unsupported", "temporary_failure", "supported", "unsupported"];
  for (let index = 0; index < capabilityStatuses.length; index += 1) {
    const slot = thirdPartySlots[index];
    const provider = providers.find((item) => item.id === slot.providerId);
    const key = `private-key-${provider.id}`;
    compactCapabilities = recordCompactCapability(compactCapabilities, compactCapabilityTarget({ provider, apiKey: key, upstreamModel: slot.upstreamModel, endpointUrl: providerCompactEndpoint(provider) }), {
      status: capabilityStatuses[index], reason: `view_${capabilityStatuses[index]}`, now: checkedAt,
    });
  }
  store.replaceSettings(settings({ providers, thirdPartySlots, compactCapabilities }));
  for (const provider of providers) store.saveProviderKey(provider.id, `private-key-${provider.id}`);

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const state = await fetch(`http://127.0.0.1:${relay.address().port}/api/state`).then((response) => response.json());
    const byId = new Map(state.providers.map((provider) => [provider.id, provider.compactCapability]));
    assert.deepEqual(byId.get(providers[0].id), { status: "supported", verifiedAt: checkedAt });
    assert.deepEqual(byId.get(providers[1].id), { status: "unsupported", verifiedAt: checkedAt });
    assert.deepEqual(byId.get(providers[2].id), { status: "temporary_failure", verifiedAt: checkedAt });
    assert.deepEqual(byId.get(providers[3].id), { status: "automatic", verifiedAt: checkedAt });
    assert.deepEqual(byId.get(providers[4].id), { status: "automatic", verifiedAt: null });
    assert.deepEqual(byId.get(providers[5].id), { status: "not_applicable", verifiedAt: null });
    const serialized = JSON.stringify(state);
    for (const profile of compactCapabilities) {
      assert.doesNotMatch(serialized, new RegExp(profile.stateDomain));
      assert.doesNotMatch(serialized, new RegExp(profile.routeSignature));
    }
    assert.doesNotMatch(serialized, /private-key-/);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("Compact capability lookup returns unknown after route changes, expiry, version changes, or clearing", () => {
  const provider = { id: "compact-lifecycle", baseUrl: "https://lifecycle.example/v1", apiType: "responses" };
  const target = compactCapabilityTarget({ provider, apiKey: "lifecycle-key", upstreamModel: "gpt-lifecycle" });
  const otherModel = compactCapabilityTarget({ provider, apiKey: "lifecycle-key", upstreamModel: "gpt-lifecycle-mini" });
  const otherKey = compactCapabilityTarget({ provider, apiKey: "lifecycle-key-2", upstreamModel: "gpt-lifecycle" });
  const otherProvider = compactCapabilityTarget({ provider: { ...provider, id: "compact-lifecycle-2" }, apiKey: "lifecycle-key", upstreamModel: "gpt-lifecycle" });
  const startedAt = Date.parse("2026-07-17T01:00:00.000Z");

  let profiles = recordCompactCapability([], target, { status: "temporary_failure", reason: "upstream_timeout", now: startedAt, ttlMs: 1_000 });
  assert.equal(compactCapabilityStatus(profiles, target, { now: startedAt + 999 }).status, "temporary_failure");
  assert.deepEqual(compactCapabilityStatus(profiles, target, { now: startedAt + 1_000 }), { status: "unknown", reason: "expired", profile: null });
  assert.equal(compactCapabilityStatus(profiles, otherModel, { now: startedAt }).status, "unknown");
  assert.equal(compactCapabilityStatus(profiles, otherKey, { now: startedAt }).status, "unknown");
  assert.equal(compactCapabilityStatus(profiles, otherProvider, { now: startedAt }).status, "unknown");

  profiles = recordCompactCapability([], target, { status: "supported", reason: "valid_compaction", now: startedAt });
  const incompatibleVersion = [{ ...profiles[0], version: COMPACT_CAPABILITY_PROFILE_VERSION + 1 }];
  assert.deepEqual(compactCapabilityStatus(incompatibleVersion, target, { now: startedAt }), { status: "unknown", reason: "profile_version_mismatch", profile: null });

  profiles = recordCompactCapability(profiles, otherModel, { status: "unsupported", reason: "http_404", now: startedAt });
  const clearedTarget = clearCompactCapabilityProfiles(profiles, target);
  assert.equal(compactCapabilityStatus(clearedTarget, target, { now: startedAt }).status, "unknown");
  assert.equal(compactCapabilityStatus(clearedTarget, otherModel, { now: startedAt }).status, "unsupported");
  assert.deepEqual(clearCompactCapabilityProfiles(profiles), []);

  const resetToUnknown = recordCompactCapability(profiles, target, { status: "unknown", reason: "configuration_changed", now: startedAt });
  assert.equal(compactCapabilityStatus(resetToUnknown, target, { now: startedAt }).status, "unknown");
});

test("settings discard incompatible Compact capability profile versions", () => {
  resetTestState();
  const provider = { id: "compact-version", name: "Compact version", baseUrl: "https://version.example/v1", apiType: "responses" };
  const target = compactCapabilityTarget({ provider, apiKey: "version-key", upstreamModel: "gpt-version" });
  const [profile] = recordCompactCapability([], target, { status: "supported", reason: "valid_compaction", now: "2026-07-17T02:00:00.000Z" });
  const normalized = store.replaceSettings(settings({ providers: [provider], compactCapabilities: [{ ...profile, version: COMPACT_CAPABILITY_PROFILE_VERSION + 1 }] }));
  assert.deepEqual(normalized.compactCapabilities, []);
  assert.deepEqual(store.loadSettings().compactCapabilities, []);
});

test("unknown third-party Responses Compact uses the native endpoint once through the production route", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/custom/responses/compact") {
      response.end(JSON.stringify({
        id: `resp_native_route_${requests.length}`,
        object: "response.compaction",
        status: "completed",
        model: "gpt-native-route",
        output: [
          { id: "msg_native_route_retained", type: "message", role: "user", content: [{ type: "input_text", text: "Retained compact context" }] },
          { type: "compaction", encrypted_content: "native-route-encrypted" },
        ],
      }));
      return;
    }
    response.end(JSON.stringify({ id: "resp_native_route_continued", object: "response", status: "completed", model: "gpt-native-route", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const provider = { id: "native-route", name: "Native route", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, endpointUrl: `http://127.0.0.1:${upstream.address().port}/custom/responses`, apiType: "responses", note: "", extraHeaders: { "x-tenant": "native-route" } };
  const configured = settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [provider],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Native route", providerId: provider.id, upstreamModel: "gpt-native-route", contextWindow: 128000, supportsImages: true, dropParams: [] }],
  });
  store.replaceSettings(configured);
  store.saveProviderKey(provider.id, "native-route-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const requestBody = { model: "relay-third-party-1", input: [{ role: "user", content: [{ type: "input_text", text: "Compact this task" }] }], stream: false };
    const invoke = () => fetch(`http://127.0.0.1:${relay.address().port}/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await invoke();
    const parsed = await response.json();
    const repeated = await invoke();
    const repeatedBody = await repeated.json();
    assert.equal(response.status, 200);
    assert.equal(repeated.status, 200);
    assert.deepEqual(requests.map((item) => item.url), ["/custom/responses/compact"]);
    assert.equal(requests[0].headers.authorization, "Bearer native-route-key");
    assert.equal(requests[0].headers["x-tenant"], "native-route");
    assert.equal(requests[0].body.model, "gpt-native-route");
    assert.deepEqual(parsed.output[0], { id: "msg_native_route_retained", type: "message", role: "user", content: [{ type: "input_text", text: "Retained compact context" }] });
    assert.match(parsed.output[1].encrypted_content, /^codex-relay:native-compaction:v1:/);
    assert.doesNotMatch(parsed.output[1].encrypted_content, /^native-route-encrypted$/);
    assert.equal(parsed.codex_relay.compaction_strategy, "native_compact");
    assert.equal(repeatedBody.codex_relay.compaction_strategy, "native_compact");

    const continued = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: [...parsed.output, { role: "user", content: [{ type: "input_text", text: "Continue on the same route" }] }], stream: false }),
    });
    assert.equal(continued.status, 200);
    assert.deepEqual(requests.map((item) => item.url), ["/custom/responses/compact", "/custom/responses"]);
    assert.deepEqual(requests[1].body.input[0], parsed.output[0]);
    assert.equal(requests[1].body.input[1].type, "compaction");
    assert.equal(requests[1].body.input[1].encrypted_content, "native-route-encrypted");

    store.saveProviderKey(provider.id, "native-route-key-2");
    const afterKeyChange = await invoke();
    assert.equal(afterKeyChange.status, 200);
    assert.deepEqual(requests.map((item) => item.url), ["/custom/responses/compact", "/custom/responses", "/custom/responses/compact"]);
    assert.equal(requests[2].headers.authorization, "Bearer native-route-key-2");
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("native Compact envelopes stay route-bound across provider, key, model, and endpoint changes", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ url: request.url, headers: request.headers, body });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/a/responses/compact") {
      response.end(JSON.stringify({
        id: "resp_native_envelope_a",
        object: "response.compaction",
        status: "completed",
        model: "gpt-native-envelope-a",
        output: [{ type: "compaction", encrypted_content: "native-secret-from-a" }],
      }));
      return;
    }
    response.end(JSON.stringify({
      id: `resp_native_envelope_continue_${requests.length}`,
      object: "response",
      status: "completed",
      model: body.model,
      output: [],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${upstream.address().port}`;
    const providerA = { id: "native-envelope-a", name: "Native envelope A", baseUrl: `${origin}/a`, endpointUrl: `${origin}/a/responses`, apiType: "responses", note: "", extraHeaders: { "x-provider": "a" } };
    const providerB = { id: "native-envelope-b", name: "Native envelope B", baseUrl: `${origin}/b`, endpointUrl: `${origin}/b/responses`, apiType: "responses", note: "", extraHeaders: { "x-provider": "b" } };
    const slots = [
      { id: "relay-third-party-1", displayName: "Native A", providerId: providerA.id, upstreamModel: "gpt-native-envelope-a", contextWindow: 128000, supportsImages: true, dropParams: [] },
      { id: "relay-third-party-2", displayName: "Native A alt", providerId: providerA.id, upstreamModel: "gpt-native-envelope-a-alt", contextWindow: 128000, supportsImages: true, dropParams: [] },
      { id: "relay-third-party-3", displayName: "Native B", providerId: providerB.id, upstreamModel: "gpt-native-envelope-b", contextWindow: 128000, supportsImages: true, dropParams: [] },
    ];
    const configured = settings({ providers: [providerA, providerB], thirdPartySlots: slots });
    store.saveProviderKey(providerA.id, "native-envelope-key-a");
    store.saveProviderKey(providerB.id, "native-envelope-key-b");

    const routeA = routeForRequest(configured, slots[0].id);
    const compactResponse = await forwardResponsesCompact({
      settings: configured,
      route: routeA,
      body: { model: routeA.id, input: [{ role: "user", content: [{ type: "input_text", text: "Keep this route-bound task" }] }], stream: false },
      headers: {},
    });
    const compacted = await compactResponse.json();
    const envelope = compacted.output[0].encrypted_content;
    assert.match(envelope, /^codex-relay:native-compaction:v1:/);
    const envelopePayload = JSON.parse(Buffer.from(envelope.slice("codex-relay:native-compaction:v1:".length), "base64url").toString("utf8"));
    const continuationBody = (model) => ({
      model,
      input: [compacted.output[0], { role: "user", content: [{ type: "input_text", text: "Continue safely" }] }],
      stream: false,
    });
    const invoke = async (settingsValue, route) => {
      const response = await forwardResponses({ settings: settingsValue, route, body: continuationBody(route.id), headers: {}, history: createChatHistory() });
      await response.text();
    };

    await invoke(configured, routeA);
    await invoke(configured, routeForRequest(configured, slots[2].id));

    store.saveProviderKey(providerA.id, "native-envelope-key-a-rotated");
    await invoke(configured, routeA);
    store.saveProviderKey(providerA.id, "native-envelope-key-a");

    await invoke(configured, routeForRequest(configured, slots[1].id));

    const changedEndpointProvider = { ...providerA, baseUrl: `${origin}/c`, endpointUrl: `${origin}/c/responses` };
    const changedEndpointSettings = settings({ providers: [changedEndpointProvider, providerB], thirdPartySlots: slots });
    await invoke(changedEndpointSettings, routeForRequest(changedEndpointSettings, slots[0].id));

    assert.deepEqual(requests.map((item) => item.url), [
      "/a/responses/compact",
      "/a/responses",
      "/b/responses",
      "/a/responses",
      "/a/responses",
      "/c/responses",
    ]);
    assert.equal(requests[1].body.input[0].encrypted_content, "native-secret-from-a");

    for (const request of requests.slice(2)) {
      const serialized = JSON.stringify(request.body);
      assert.doesNotMatch(serialized, /native-secret-from-a/);
      assert.equal(serialized.includes(envelope), false);
      assert.equal(serialized.includes(envelopePayload.routeSignature), false);
      assert.match(request.body.input[0].content[0].text, /Portable context from a different Codex Relay upstream/);
      assert.match(request.body.input[0].content[0].text, /Keep this route-bound task/);
    }
    assert.equal(requests[2].headers.authorization, "Bearer native-envelope-key-b");
    assert.equal(requests[2].headers.authorization.includes("native-envelope-key-a"), false);
    assert.equal(requests[3].headers.authorization, "Bearer native-envelope-key-a-rotated");
    assert.equal(JSON.stringify(requests[2].body).includes("native-envelope-key-a"), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("failed unknown native Compact falls back once and repeated identical requests reuse the result", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    if (request.url === "/v1/responses/compact") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unknown endpoint /responses/compact" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_compatible_after_native",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Keep the task after the native Compact fallback." }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const provider = { id: "native-fallback-once", name: "Native fallback", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} };
    store.saveProviderKey(provider.id, "native-fallback-key");
    const configured = settings({
      providers: [provider],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Native fallback", providerId: provider.id, upstreamModel: "gpt-native-fallback", contextWindow: 128000, supportsImages: true, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const body = { model: route.id, input: [{ role: "user", content: [{ type: "input_text", text: "Keep this exact task" }] }], stream: false };
    const first = await forwardResponsesCompact({ settings: configured, route, body: structuredClone(body), headers: {} });
    const repeated = await forwardResponsesCompact({ settings: configured, route, body: structuredClone(body), headers: {} });
    assert.deepEqual(requests.map((item) => item.url), ["/v1/responses/compact", "/v1/responses"]);
    assert.equal((await first.json()).codex_relay.compaction_strategy, "model_summary");
    assert.equal((await repeated.json()).codex_relay.compaction_strategy, "model_summary");
    assert.equal(responseDiagnostics(first).upstreamAttempts, 2);
    assert.equal(responseDiagnostics(first).nativeCompact.outcome, "unsupported");
    assert.equal(responseDiagnostics(repeated).upstreamAttempts, 0);
    assert.equal(responseDiagnostics(repeated).cacheHit, true);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("stored unsupported and temporary Compact capabilities skip the native endpoint", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_profile_skip_${requests.length}`,
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Use the compatible summary path." }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    const providers = [
      { id: "compact-unsupported-profile", name: "Unsupported profile", baseUrl, apiType: "responses", note: "", extraHeaders: {} },
      { id: "compact-temporary-profile", name: "Temporary profile", baseUrl, apiType: "responses", note: "", extraHeaders: {} },
    ];
    const slots = providers.map((provider, index) => ({ id: `relay-third-party-${index + 1}`, displayName: provider.name, providerId: provider.id, upstreamModel: `gpt-profile-${index + 1}`, contextWindow: 128000, supportsImages: true, dropParams: [] }));
    let compactCapabilities = [];
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      const key = `profile-key-${index + 1}`;
      store.saveProviderKey(provider.id, key);
      const target = compactCapabilityTarget({ provider, apiKey: key, upstreamModel: slots[index].upstreamModel, endpointUrl: `${baseUrl}/responses/compact` });
      compactCapabilities = recordCompactCapability(compactCapabilities, target, { status: index === 0 ? "unsupported" : "temporary_failure", reason: index === 0 ? "http_404" : "http_502", now: Date.now() });
    }
    const configured = settings({ providers, thirdPartySlots: slots, compactCapabilities });
    for (const slot of slots) {
      const route = routeForRequest(configured, slot.id);
      const response = await forwardResponsesCompact({ settings: configured, route, body: { model: route.id, input: "compact", stream: false }, headers: {} });
      assert.equal(response.status, 200);
      assert.equal(responseDiagnostics(response).nativeCompact.attempted, false);
      assert.match(responseDiagnostics(response).nativeCompact.reason, /^capability_/);
    }
    assert.deepEqual(requests, ["/v1/responses", "/v1/responses"]);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("S2-D persists supported, unsupported, and temporary Compact outcomes across a Router restart", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ url: request.url, body });
    if (request.url.includes("/supported/") && request.url.endsWith("/responses/compact")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: `resp_supported_${requests.length}`,
        object: "response.compaction",
        status: "completed",
        model: body.model,
        output: [{ type: "compaction", encrypted_content: `supported-checkpoint-${requests.length}` }],
      }));
      return;
    }
    if (request.url.includes("/unsupported/") && request.url.endsWith("/responses/compact")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unknown endpoint /responses/compact" } }));
      return;
    }
    if (request.url.includes("/temporary/") && request.url.endsWith("/responses/compact")) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Compact is temporarily rate limited" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_summary_${requests.length}`,
      object: "response",
      status: "completed",
      model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Keep the compatible task checkpoint." }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const scenarios = ["supported", "unsupported", "temporary"];
  const providers = scenarios.map((scenario) => ({ id: `s2d-${scenario}`, name: `S2-D ${scenario}`, baseUrl: `${origin}/${scenario}/v1`, apiType: "responses", note: "", extraHeaders: {} }));
  const slots = scenarios.map((scenario, index) => ({ id: `relay-third-party-${index + 1}`, displayName: `S2-D ${scenario}`, providerId: `s2d-${scenario}`, upstreamModel: `gpt-s2d-${scenario}`, contextWindow: 128000, supportsImages: true, dropParams: [] }));
  for (const provider of providers) store.saveProviderKey(provider.id, `secret-${provider.id}-must-not-persist`);
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port: 15723, running: true }, providers, thirdPartySlots: slots }));

  let relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const send = async (slot, text) => {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: slot.id, input: [{ role: "user", content: [{ type: "input_text", text }] }], stream: false }),
    });
    assert.equal(response.status, 200);
    return await response.json();
  };

  try {
    assert.equal((await send(slots[0], "supported first")).codex_relay.compaction_strategy, "native_compact");
    assert.equal((await send(slots[1], "unsupported first")).codex_relay.compaction_strategy, "model_summary");
    assert.equal((await send(slots[2], "temporary first")).codex_relay.compaction_strategy, "model_summary");
    assert.deepEqual(requests.map((item) => item.url), [
      "/supported/v1/responses/compact",
      "/unsupported/v1/responses/compact",
      "/unsupported/v1/responses",
      "/temporary/v1/responses/compact",
      "/temporary/v1/responses",
    ]);

    await compactCapabilityPersistence.flushCompactCapabilityWriter();
    await new Promise((resolve) => relay.close(resolve));
    const persisted = fs.readFileSync(compactCapabilityPersistence.compactCapabilityPersistencePath(), "utf8");
    assert.doesNotMatch(persisted, /secret-s2d/);
    assert.doesNotMatch(persisted, /supported first|unsupported first|temporary first/);
    const persistedProfiles = JSON.parse(persisted).profiles;
    assert.deepEqual(persistedProfiles.map((profile) => profile.status).sort(), ["supported", "temporary_failure", "unsupported"]);

    compactCapabilityPersistence.reloadCompactCapabilityPersistenceForTests();
    requests.length = 0;
    relay = createRelayServer();
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    assert.equal((await send(slots[0], "supported after restart")).codex_relay.compaction_strategy, "native_compact");
    assert.equal((await send(slots[1], "unsupported after restart")).codex_relay.compaction_strategy, "model_summary");
    assert.equal((await send(slots[2], "temporary after restart")).codex_relay.compaction_strategy, "model_summary");
    assert.deepEqual(requests.map((item) => item.url), [
      "/supported/v1/responses/compact",
      "/unsupported/v1/responses",
      "/temporary/v1/responses",
    ]);
  } finally {
    if (relay?.listening) await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("S2-D keeps authentication, request rejection, and invalid responses out of persistent unsupported memory", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(request.url);
    if (request.url.endsWith("/responses/compact")) {
      if (request.url.includes("/auth/")) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid key for Compact" } }));
        return;
      }
      if (request.url.includes("/rejected/")) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "input must contain at least one message" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_invalid_shape",
        object: "response.compaction",
        status: "completed",
        model: body.model,
        output: [
          { type: "message", role: "assistant", content: [] },
          { type: "compaction_summary", summary: "Blue-style summary without an encrypted compaction item." },
        ],
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_nonpersistent_${requests.length}`,
      object: "response",
      status: "completed",
      model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Fallback once without a permanent capability conclusion." }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${upstream.address().port}`;
    const scenarios = ["auth", "rejected", "invalid"];
    const providers = scenarios.map((scenario) => ({ id: `s2d-${scenario}`, name: scenario, baseUrl: `${origin}/${scenario}/v1`, apiType: "responses", note: "", extraHeaders: {} }));
    const slots = scenarios.map((scenario, index) => ({ id: `relay-third-party-${index + 1}`, displayName: scenario, providerId: `s2d-${scenario}`, upstreamModel: `gpt-s2d-${scenario}`, contextWindow: 128000, supportsImages: true, dropParams: [] }));
    for (const provider of providers) store.saveProviderKey(provider.id, `key-${provider.id}`);
    store.replaceSettings(settings({ router: { host: "127.0.0.1", port: 15723, running: true }, providers, thirdPartySlots: slots }));
    const relay = createRelayServer();
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    try {
      const send = async (slot, text) => {
        const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses/compact`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: slot.id, input: text, stream: false }),
        });
        assert.equal(response.status, 200);
        return await response.json();
      };
      for (const [index, slot] of slots.entries()) {
        assert.equal((await send(slot, `first-${scenarios[index]}`)).codex_relay.compaction_strategy, "model_summary");
      }
      assert.deepEqual(compactCapabilityPersistence.compactCapabilityProfiles([]), []);
      requests.length = 0;
      for (const [index, slot] of slots.entries()) {
        assert.equal((await send(slot, `second-${scenarios[index]}`)).codex_relay.compaction_strategy, "model_summary");
      }
      assert.deepEqual(requests, [
        "/auth/v1/responses",
        "/rejected/v1/responses/compact", "/rejected/v1/responses",
        "/invalid/v1/responses/compact", "/invalid/v1/responses",
      ]);
      assert.equal(fs.existsSync(compactCapabilityPersistence.compactCapabilityPersistencePath()), false);
    } finally {
      await new Promise((resolve) => relay.close(resolve));
    }
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("cancelling a native Compact request does not start the compatible fallback", async () => {
  resetTestState();
  const requests = [];
  let releaseRequest;
  const requestStarted = new Promise((resolve) => { releaseRequest = resolve; });
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    requests.push(request.url);
    releaseRequest();
    response.writeHead(200, { "content-type": "application/json" });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const provider = { id: "native-compact-cancel", name: "Native cancel", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} };
    store.saveProviderKey(provider.id, "native-cancel-key");
    const configured = settings({ providers: [provider], thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Native cancel", providerId: provider.id, upstreamModel: "gpt-native-cancel", contextWindow: 128000, supportsImages: true, dropParams: [] }] });
    const route = routeForRequest(configured, "relay-third-party-1");
    const controller = new AbortController();
    let recorded = 0;
    const pending = forwardResponsesCompact({ settings: configured, route, body: { model: route.id, input: "cancel", stream: false }, headers: {}, signal: controller.signal, compactCapabilityRecorder: () => { recorded += 1; } });
    await requestStarted;
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    assert.deepEqual(requests, ["/v1/responses/compact"]);
    assert.equal(recorded, 0);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official Compact remains an untouched official request when third-party probing is enabled", async () => {
  resetTestState();
  const officialToken = captureOfficialToken("official-compact-token");
  const requests = [];
  const officialOutput = [
    { id: "msg_official_retained", type: "message", role: "user", content: [{ type: "input_text", text: "Official retained context" }] },
    { type: "compaction", encrypted_content: "official-compact-encrypted" },
  ];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_official_compact_route", object: "response.compaction", status: "completed", output: officialOutput }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const configured = settingsForOfficialRoute();
    configured.compactCapabilities = [{ status: "unsupported" }];
    const route = routeForRequest(configured, "gpt-5.6-terra");
    const response = await forwardResponsesCompact({
      settings: configured,
      route,
      body: { model: route.id, input: "official compact", stream: false },
      headers: { authorization: "Bearer third-party-key-must-not-leak", "x-api-key": "third-party-key-must-not-leak" },
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(requests.map((item) => item.url), ["/responses/compact"]);
    assert.equal(requests[0].headers.authorization, `Bearer ${officialToken}`);
    assert.equal(requests[0].headers["x-api-key"], undefined);
    assert.equal(requests[0].body.model, route.upstreamModel);
    assert.deepEqual((await response.json()).output, officialOutput);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("native Compact contract accepts legacy and retained-output windows with exactly one encrypted compaction", () => {
  const payload = {
    id: "resp_native_compact",
    object: "response",
    status: "completed",
    model: "gpt-contract",
    output: [{ type: "compaction", encrypted_content: "encrypted-checkpoint" }],
  };

  const accepted = validateNativeCompactPayload(payload, { expectedModel: "gpt-contract" });
  assert.equal(accepted.valid, true);
  assert.equal(accepted.contractVersion, "single_compaction_v1");
  assert.equal(accepted.compactionIndex, 0);
  assert.deepEqual(accepted.compactionItem, payload.output[0]);

  const retainedOutput = structuredClone(payload);
  retainedOutput.output.unshift({ id: "msg_retained", type: "message", role: "user", content: [{ type: "input_text", text: "Keep this retained item" }] });
  const retainedAccepted = validateNativeCompactPayload(retainedOutput, { expectedModel: "gpt-contract" });
  assert.equal(retainedAccepted.valid, true);
  assert.equal(retainedAccepted.contractVersion, "retained_output_compaction_v2");
  assert.equal(retainedAccepted.compactionIndex, 1);
  assert.deepEqual(retainedAccepted.compactionItem, retainedOutput.output[1]);

  const noCompaction = structuredClone(payload);
  noCompaction.output = [{ type: "message", role: "assistant", content: [] }];
  assert.deepEqual(validateNativeCompactPayload(noCompaction, { expectedModel: "gpt-contract" }), { valid: false, reason: "compaction_item_missing" });

  const multipleCompactions = structuredClone(payload);
  multipleCompactions.output.push({ type: "compaction", encrypted_content: "second-encrypted-checkpoint" });
  assert.deepEqual(validateNativeCompactPayload(multipleCompactions, { expectedModel: "gpt-contract" }), { valid: false, reason: "compaction_item_multiple" });

  const emptyCheckpoint = structuredClone(payload);
  emptyCheckpoint.output[0].encrypted_content = "";
  assert.deepEqual(validateNativeCompactPayload(emptyCheckpoint, { expectedModel: "gpt-contract" }), { valid: false, reason: "encrypted_content_missing" });

  const summaryOnly = structuredClone(payload);
  summaryOnly.output = [
    { type: "message", role: "assistant", content: [] },
    { type: "compaction_summary", summary: "This is not an encrypted compaction checkpoint." },
  ];
  assert.deepEqual(validateNativeCompactPayload(summaryOnly, { expectedModel: "gpt-contract" }), { valid: false, reason: "compaction_item_missing" });

  const malformedOutput = structuredClone(payload);
  malformedOutput.output = { type: "compaction", encrypted_content: "not-an-array" };
  assert.deepEqual(validateNativeCompactPayload(malformedOutput, { expectedModel: "gpt-contract" }), { valid: false, reason: "output_type" });

  const wrongRoute = structuredClone(payload);
  wrongRoute.model = "other-model";
  assert.deepEqual(validateNativeCompactPayload(wrongRoute, { expectedModel: "gpt-contract" }), { valid: false, reason: "model_mismatch" });

  const wrongObject = structuredClone(payload);
  wrongObject.object = "chat.completion";
  assert.deepEqual(validateNativeCompactPayload(wrongObject, { expectedModel: "gpt-contract" }), { valid: false, reason: "object_type" });
});

test("native Compact HTTP contract separates unsupported, rejected, auth, and temporary failures", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    const scenario = request.url?.split("/").at(-1);
    const fixtures = {
      success: [200, { id: "resp_contract_success", object: "response", status: "completed", model: "gpt-contract", output: [{ type: "compaction", encrypted_content: "encrypted-checkpoint" }] }],
      missing: [404, { error: { message: "Unknown endpoint /responses/compact" } }],
      unsupported: [400, { error: { message: "Compact is not supported by this upstream" } }],
      invalid: [400, { error: { message: "input must contain at least one message" } }],
      unauthorized: [401, { error: { message: "invalid key" } }],
      forbidden: [403, { error: { message: "account has no access" } }],
      throttled: [429, { error: { message: "try again later" } }],
      server: [500, { error: { message: "temporary server failure" } }],
      gateway: [502, { error: { message: "bad gateway" } }],
    };
    const [status, body] = fixtures[scenario] || [404, { error: { message: "missing fixture" } }];
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  try {
    const endpoint = `http://127.0.0.1:${upstream.address().port}`;
    const probe = async (scenario) => {
      const response = await fetch(`${endpoint}/${scenario}`, { method: "POST", body: "{}" });
      return classifyNativeCompactHttpResult({
        status: response.status,
        contentType: response.headers.get("content-type"),
        bodyText: await response.text(),
        expectedModel: "gpt-contract",
      });
    };

    const supported = await probe("success");
    assert.equal(supported.outcome, "supported");
    assert.equal(supported.capability, "supported");
    assert.equal(supported.retryable, false);
    assert.equal(supported.compactionItem.encrypted_content, "encrypted-checkpoint");

    const blueStyleSummary = classifyNativeCompactHttpResult({
      status: 200,
      contentType: "application/json",
      bodyText: JSON.stringify({
        id: "resp_blue_style_summary",
        object: "response.compaction",
        status: "completed",
        model: "gpt-contract",
        output: [
          { type: "message", role: "assistant", content: [] },
          { type: "compaction_summary", summary: "Summary without encrypted content" },
        ],
      }),
      expectedModel: "gpt-contract",
    });
    assert.equal(blueStyleSummary.outcome, "invalid_response");
    assert.equal(blueStyleSummary.capability, "unknown");
    assert.equal(blueStyleSummary.reason, "compaction_item_missing");
    assert.equal(blueStyleSummary.payload, undefined);

    for (const scenario of ["missing", "unsupported"]) {
      const result = await probe(scenario);
      assert.equal(result.outcome, "unsupported");
      assert.equal(result.capability, "unsupported");
      assert.equal(result.retryable, false);
    }

    const rejected = await probe("invalid");
    assert.equal(rejected.outcome, "request_rejected");
    assert.equal(rejected.capability, "unknown");
    assert.equal(rejected.retryable, false);

    for (const scenario of ["unauthorized", "forbidden"]) {
      const result = await probe(scenario);
      assert.equal(result.outcome, "authentication_failure");
      assert.equal(result.capability, "unknown");
      assert.equal(result.retryable, false);
    }

    for (const scenario of ["throttled", "server", "gateway"]) {
      const result = await probe(scenario);
      assert.equal(result.outcome, "temporary_failure");
      assert.equal(result.capability, "unknown");
      assert.equal(result.retryable, true);
    }
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("native Compact contract contains HTML, malformed payloads, truncated streams, and timeouts", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    const scenario = request.url?.split("/").at(-1);
    if (scenario === "html") {
      response.writeHead(502, { "content-type": "text/html" });
      response.end(`<html><body><h1>Bad Gateway</h1><p>${"cloudflare detail ".repeat(80)}</p></body></html>`);
      return;
    }
    if (scenario === "wrong-shape") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_wrong", object: "response", status: "completed", model: "gpt-contract", output: [{ type: "message", content: [] }] }));
      return;
    }
    if (scenario === "truncated") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"partial"');
      return;
    }
    if (scenario === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"id":"partial"');
      return;
    }
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }, 250);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  try {
    const endpoint = `http://127.0.0.1:${upstream.address().port}`;
    const probe = async (scenario) => {
      const response = await fetch(`${endpoint}/${scenario}`, { method: "POST", body: "{}" });
      return classifyNativeCompactHttpResult({
        status: response.status,
        contentType: response.headers.get("content-type"),
        bodyText: await response.text(),
        expectedModel: "gpt-contract",
      });
    };

    const html = await probe("html");
    assert.equal(html.outcome, "temporary_failure");
    assert.equal(html.capability, "unknown");
    assert.equal(html.retryable, true);
    assert.ok(html.message.length <= 240);
    assert.doesNotMatch(html.message, /<[^>]+>/);

    const wrongShape = await probe("wrong-shape");
    assert.equal(wrongShape.outcome, "invalid_response");
    assert.equal(wrongShape.reason, "compaction_item_missing");
    assert.equal(wrongShape.capability, "unknown");

    const truncated = await probe("truncated");
    assert.equal(truncated.outcome, "invalid_response");
    assert.equal(truncated.reason, "truncated_stream");
    assert.equal(truncated.capability, "unknown");

    const malformed = await probe("malformed");
    assert.equal(malformed.outcome, "invalid_response");
    assert.equal(malformed.reason, "malformed_json");
    assert.equal(malformed.capability, "unknown");

    let timeout;
    try {
      await fetch(`${endpoint}/timeout`, { method: "POST", body: "{}", signal: AbortSignal.timeout(20) });
      assert.fail("timeout fixture unexpectedly completed");
    } catch (error) {
      timeout = classifyNativeCompactTransportError(error);
    }
    assert.equal(timeout.outcome, "temporary_failure");
    assert.equal(timeout.reason, "upstream_timeout");
    assert.equal(timeout.capability, "unknown");
    assert.equal(timeout.retryable, true);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("responses compact uses compatible model summaries and returns portable Chat compaction", async () => {
  let nativeRequest;
  const nativeUpstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    nativeRequest = { url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_compatible_summary",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Keep the current task, decisions, and latest results." }] }],
      usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
    }));
  });
  await new Promise((resolve) => nativeUpstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("compact-native", "compact-native-key");
    const nativeSettings = settings({
      providers: [{ id: "compact-native", name: "Compact native", baseUrl: `http://127.0.0.1:${nativeUpstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Compact native", providerId: "compact-native", upstreamModel: "native-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const nativeRoute = routeForRequest(nativeSettings, "relay-third-party-1");
    const native = await forwardResponsesCompact({ route: nativeRoute, body: { model: nativeRoute.id, input: "compact me" }, headers: {} });
    assert.equal(native.status, 200);
    assert.equal(nativeRequest.url, "/v1/responses");
    assert.equal(nativeRequest.body.model, "native-model");
    assertCheckpointPrompt(nativeRequest.body.input.at(-1).content[0].text);
    assert.equal(nativeRequest.body.stream, false);
    const nativeBody = await native.json();
    assert.equal(nativeBody.output[0].type, "compaction");
    assert.equal(nativeBody.codex_relay.compaction_strategy, "model_summary");

    store.saveProviderKey("compact-chat", "compact-chat-key");
    const chatSettings = settings({
      providers: [{ id: "compact-chat", name: "Compact chat", baseUrl: "http://127.0.0.1:1/v1", apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Compact chat", providerId: "compact-chat", upstreamModel: "chat-model", contextWindow: 8000, supportsImages: false, dropParams: [] }],
    });
    const chatRoute = routeForRequest(chatSettings, "relay-third-party-1");
    const compacted = await forwardResponsesCompact({ settings: chatSettings, route: chatRoute, body: { model: chatRoute.id, input: [{ role: "user", content: [{ type: "input_text", text: "old ".repeat(20_000) }] }, { role: "assistant", content: [{ type: "output_text", text: "recent result" }] }] }, headers: {} });
    const compactBody = await compacted.json();
    assert.equal(compacted.status, 200);
    assert.equal(compactBody.object, "response.compaction");
    assert.ok(JSON.stringify(compactBody.output).includes("recent result"));
  } finally {
    await new Promise((resolve) => nativeUpstream.close(resolve));
  }
});

test("third-party Responses compact converts an ordinary response into one v2 compaction item", async () => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_plain_compact",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Keep the DeepSeek task state and recent results." }] }],
      usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 },
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("responses-compact-fallback", "responses-key");
    const configured = settings({
      providers: [{ id: "responses-compact-fallback", name: "Responses fallback", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-2", displayName: "GPT fallback", providerId: "responses-compact-fallback", upstreamModel: "gpt-5.6-terra", contextWindow: 128000, supportsImages: true, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-2");
    const response = await forwardResponsesCompact({
      route,
      body: { model: route.id, input: [{ role: "user", content: [{ type: "input_text", text: "Continue the migrated task" }] }] },
      headers: {},
    });
    const parsed = await response.json();
    assert.equal(received.url, "/v1/responses");
    assert.equal(received.body.model, "gpt-5.6-terra");
    assertCheckpointPrompt(received.body.input.at(-1).content[0].text);
    assert.equal(parsed.output.length, 1);
    assert.equal(parsed.output[0].type, "compaction");
    assert.match(parsed.output[0].encrypted_content, /^codex-relay:compaction:v1:/);
    assert.equal(parsed.codex_relay.compaction_fallback, "portable_v1");
    assert.equal(parsed.codex_relay.compaction_strategy, "model_summary");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("failed third-party compaction is billed at most once across concurrent and repeated retries", async () => {
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    await new Promise((resolve) => setTimeout(resolve, 40));
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "compact gateway failed" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("responses-compact-circuit", "responses-circuit-key");
    const configured = settings({
      providers: [{ id: "responses-compact-circuit", name: "Responses circuit", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-3", displayName: "GPT circuit", providerId: "responses-compact-circuit", upstreamModel: "gpt-circuit", contextWindow: 372000, supportsImages: true, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-3");
    const body = {
      model: route.id,
      input: [
        { role: "user", content: [{ type: "input_text", text: "Preserve this long task and its decisions." }] },
        { type: "custom_tool_call_output", call_id: "call_large", output: "tool-result ".repeat(250_000) },
        { type: "additional_tools", tools: [{ name: "computer", description: "control the computer" }] },
        { type: "compaction_trigger" },
      ],
      client_metadata: { compaction: { phase: "mid_turn" } },
      stream: true,
    };
    const invoke = (requestBody = body) => forwardResponses({ settings: configured, route, body: requestBody, headers: {}, history: createChatHistory() });
    const [first, joined] = await Promise.all([invoke(), invoke(structuredClone(body))]);
    const repeatedBody = structuredClone(body);
    repeatedBody.client_metadata.compaction.phase = "pre_turn";
    const repeated = await invoke(repeatedBody);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/responses");
    assert.equal(requests[0].body.input.some((item) => item.type === "compaction_trigger"), false);
    assert.equal(requests[0].body.input.some((item) => item.type === "additional_tools"), false);
    for (const response of [first, joined, repeated]) {
      assert.equal(response.status, 200);
      const text = await response.text();
      const completedLine = text.split(/\r?\n/).find((line) => line.startsWith("data:") && line.includes('"response.completed"'));
      const completed = JSON.parse(completedLine.slice(5).trim()).response;
      assert.equal(completed.output.length, 1);
      assert.equal(completed.output[0].type, "compaction");
      assert.equal(completed.codex_relay.compaction_strategy, "local_emergency");
    }
    assert.equal(responseDiagnostics(first).upstreamAttempts, 1);
    assert.equal(responseDiagnostics(joined).deduplicated, true);
    assert.equal(responseDiagnostics(joined).upstreamAttempts, 0);
    assert.equal(responseDiagnostics(repeated).cacheHit, true);
    assert.equal(responseDiagnostics(repeated).upstreamAttempts, 0);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("an interrupted third-party compaction stream opens the billing circuit", async () => {
  let requestCount = 0;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    requestCount += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"id":"partial"');
    response.flushHeaders();
    response.socket.destroy();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("responses-compact-interrupted", "responses-interrupted-key");
    const configured = settings({
      providers: [{ id: "responses-compact-interrupted", name: "Responses interrupted", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-4", displayName: "GPT interrupted", providerId: "responses-compact-interrupted", upstreamModel: "gpt-interrupted", contextWindow: 128000, supportsImages: true, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-4");
    const body = { model: route.id, input: [{ role: "user", content: [{ type: "input_text", text: "Keep the interrupted task." }] }, { type: "compaction_trigger" }], stream: false };
    const invoke = () => forwardResponses({ settings: configured, route, body: structuredClone(body), headers: {}, history: createChatHistory() });
    const first = await invoke();
    const repeated = await invoke();
    assert.equal(first.status, 200);
    assert.equal(repeated.status, 200);
    assert.equal(requestCount, 1);
    assert.equal((await first.json()).codex_relay.compaction_strategy, "local_emergency");
    assert.equal(responseDiagnostics(repeated).upstreamAttempts, 0);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("cancelling compatible third-party compaction does not create a fallback or open its billing circuit", async () => {
  let requestCount = 0;
  let firstRequestStarted;
  const firstRequestStartedPromise = new Promise((resolve) => { firstRequestStarted = resolve; });
  let firstRequestClosed;
  const firstRequestClosedPromise = new Promise((resolve) => { firstRequestClosed = resolve; });
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the request before deciding its outcome. */ }
    requestCount += 1;
    if (requestCount === 1) {
      response.once("close", firstRequestClosed);
      firstRequestStarted();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_after_cancel",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Compact checkpoint after the cancelled request." }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("responses-compact-cancel", "responses-compact-cancel-key");
    const configured = settings({
      providers: [{ id: "responses-compact-cancel", name: "Responses compact cancel", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-5", displayName: "GPT compact cancel", providerId: "responses-compact-cancel", upstreamModel: "gpt-compact-cancel", contextWindow: 128000, supportsImages: true, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-5");
    const body = {
      model: route.id,
      input: [{ role: "user", content: [{ type: "input_text", text: "Keep the task state if compaction succeeds." }] }, { type: "compaction_trigger" }],
      stream: false,
    };
    const controller = new AbortController();
    const cancelled = forwardResponses({ settings: configured, route, body: structuredClone(body), headers: {}, signal: controller.signal, history: createChatHistory() });
    await firstRequestStartedPromise;
    controller.abort();
    await assert.rejects(cancelled, (error) => error?.name === "AbortError");
    await Promise.race([
      firstRequestClosedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Cancelled compaction upstream connection did not close.")), 1_000)),
    ]);

    // A user cancellation is neutral: the next compact request may make its one normal upstream attempt.
    const retried = await forwardResponses({ settings: configured, route, body: structuredClone(body), headers: {}, history: createChatHistory() });
    const retriedBody = await retried.json();
    assert.equal(retried.status, 200);
    assert.equal(requestCount, 2);
    assert.equal(retriedBody.codex_relay.compaction_strategy, "model_summary");
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("third-party compaction triggers become one portable v2 compaction item", async () => {
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const body = {
      id: `resp_${requests.length}`,
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Retain the current implementation plan and latest tool results." }] }],
      usage: { input_tokens: 120, output_tokens: 12, total_tokens: 132 },
    };
    const payload = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: body })}\n\ndata: [DONE]\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "identity", "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("v2-fallback", "v2-key");
    const configured = settings({
      providers: [{ id: "v2-fallback", name: "Responses relay", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "GPT relay", providerId: "v2-fallback", upstreamModel: "gpt-relay", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const compacted = await forwardResponses({
      settings: configured,
      route,
      body: { model: route.id, input: [{ role: "user", content: [{ type: "input_text", text: "Keep this task" }] }, { type: "compaction_trigger" }], stream: true },
      headers: {},
      history: createChatHistory(),
    });
    const compactedText = await compacted.text();
    const completedLine = compactedText.split(/\r?\n/).find((line) => line.startsWith("data:") && line.includes('"response.completed"'));
    const completed = JSON.parse(completedLine.slice(5).trim()).response;
    assert.equal(completed.output.length, 1);
    assert.equal(completed.output[0].type, "compaction");
    assert.match(completed.output[0].encrypted_content, /^codex-relay:compaction:v1:/);
    assert.equal(completed.codex_relay.compaction_fallback, "portable_v1");
    assert.equal(completed.codex_relay.compaction_strategy, "model_summary");
    assert.equal(compacted.headers.get("content-encoding"), null);
    assert.equal(compacted.headers.get("content-length"), null);
    assert.equal(requests[0].input.some((item) => item.type === "compaction_trigger"), false);
    assertCheckpointPrompt(requests[0].input.at(-1).content[0].text);
    assert.equal(requests[0].stream, false);

    const continued = await forwardResponses({
      settings: configured,
      route,
      body: { model: route.id, input: [completed.output[0], { role: "user", content: [{ type: "input_text", text: "Continue" }] }], stream: false },
      headers: {},
      history: createChatHistory(),
    });
    assert.equal(continued.status, 200);
    assert.equal(requests[1].input.some((item) => item.type === "compaction"), false);
    assert.match(requests[1].input[0].content[0].text, /Retain the current implementation plan/);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official compaction triggers remain native and untouched", async () => {
  captureOfficialToken("official-token");
  let received;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const native = { id: "resp_native_compaction", object: "response", status: "completed", output: [{ type: "compaction", encrypted_content: "official-encrypted" }] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(native));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const configured = settingsForOfficialRoute();
    const route = routeForRequest(configured, "gpt-5.6-terra");
    const response = await forwardResponses({
      settings: configured,
      route,
      body: { model: route.id, input: [{ type: "compaction_trigger" }], stream: false },
      headers: {},
      history: createChatHistory(),
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    const parsed = await response.json();
    assert.equal(received.input[0].type, "compaction_trigger");
    assert.deepEqual(parsed.output, [{ type: "compaction", encrypted_content: "official-encrypted" }]);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("compacted tool output is made portable instead of sending an invalid standalone tool message", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "continued after compacting" } }], usage: {} }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("orphan-tool", "orphan-tool-key");
    const configured = settings({
      providers: [{ id: "orphan-tool", name: "Tool route", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Tool route", providerId: "orphan-tool", upstreamModel: "tool-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    await forwardResponses({
      settings: configured,
      route,
      body: { model: route.id, input: [{ type: "function_call_output", call_id: "call_missing_after_compaction", output: "file list: README.md" }], stream: false },
      headers: {},
      history: createChatHistory(),
    });
    assert.equal(received[0].messages[0].role, "user");
    assert.match(received[0].messages[0].content, /Codex tool output from an earlier compacted step/);
    assert.doesNotMatch(JSON.stringify(received[0].messages), /"role":"tool"/);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("long third-party Chat conversations retain task-critical recent context within the target window", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "continued" } }], usage: {} }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("bounded-chat", "bounded-key");
    const configured = settings({
      providers: [{ id: "bounded-chat", name: "Bounded chat", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Bounded chat", providerId: "bounded-chat", upstreamModel: "bounded-model", contextWindow: 8000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const history = createChatHistory();
    history.record("relay_long", [
      { role: "user", content: "old ".repeat(9_000) },
      { role: "assistant", content: "Recent implementation result." },
      { role: "user", content: "The latest requirement is to preserve the task." },
    ], route.id);
    await forwardResponses({ settings: configured, route, body: { model: route.id, instructions: "Keep the user's coding task active.", previous_response_id: "relay_long", input: "Continue now", stream: false }, headers: {}, history });
    const messages = received[0].messages;
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].content, "Keep the user's coding task active.");
    assert.match(messages[1].content, /Earlier conversation turns were omitted/);
    assert.ok(messages.some((message) => message.content === "The latest requirement is to preserve the task."));
    assert.ok(messages.some((message) => message.content === "Continue now"));
    assert.equal(messages.some((message) => message.content.startsWith("old old old")), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("chat-completions streams the first token before the upstream response completes", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`);
    setTimeout(() => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " token" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    }, 220);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("streaming", "stream-key");
    const configured = settings({
      providers: [{ id: "streaming", name: "Streaming", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Streaming", providerId: "streaming", upstreamModel: "stream-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const history = createChatHistory();
    const started = Date.now();
    const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "stream", stream: true }, headers: {}, history });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let firstTokenAt = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (firstTokenAt === null && text.includes('"delta":"first"')) firstTokenAt = Date.now() - started;
    }

    assert.ok(firstTokenAt !== null && firstTokenAt < 200, `first token arrived after ${firstTokenAt}ms`);
    assert.match(text, /response\.completed/);
    assert.doesNotMatch(text, /__assistantMessage/);
    assert.equal(history.snapshot().length, 1);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("streamed Chat Completions function calls remain available to Codex and local context", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const firstChunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "read_file", arguments: '{"path":' } }] } }] };
    const secondChunk = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }], usage: {} };
    response.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
    response.end(`data: ${JSON.stringify(secondChunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("tool-stream", "tool-key");
    const configured = settings({
      providers: [{ id: "tool-stream", name: "Tool stream", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Tool stream", providerId: "tool-stream", upstreamModel: "tool-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const history = createChatHistory();
    const route = routeForRequest(configured, "relay-third-party-1");
    const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "read", stream: true }, headers: {}, history });
    const text = await response.text();
    assert.match(text, /"type":"function_call"/);
    assert.match(text, /"name":"read_file"/);
    assert.deepEqual(history.snapshot()[0].messages.at(-1).tool_calls[0].function, { name: "read_file", arguments: '{"path":"README.md"}' });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("streamed Chat reasoning survives a final unterminated tool-call frame", async () => {
  resetTestState();
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Inspect first. " } }] })}\n\n`);
    response.end(`data: ${JSON.stringify({
      choices: [{
        finish_reason: "tool_calls",
        delta: {
          reasoning_content: "Then call the tool.",
          content: "Checking now.",
          tool_calls: [{ index: 0, id: "call_stream_reasoning", function: { name: "read_file", arguments: '{"path":"README.md"}' } }],
        },
      }],
      usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14, completion_tokens_details: { reasoning_tokens: 4 } },
    })}`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("reasoning-stream", "reasoning-stream-key");
    const configured = settings({
      providers: [{ id: "reasoning-stream", name: "Reasoning stream", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Reasoning stream", providerId: "reasoning-stream", upstreamModel: "deepseek-stream", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const history = createChatHistory();
    const route = routeForRequest(configured, "relay-third-party-1");
    const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "inspect", stream: true }, headers: {}, history });
    const raw = await response.text();
    const completedLine = raw.split(/\r?\n/).find((line) => line.startsWith("data:") && line.includes('"response.completed"'));
    const completed = JSON.parse(completedLine.slice(5).trim()).response;
    const reasoning = completed.output.find((item) => item.type === "reasoning");
    const call = completed.output.find((item) => item.type === "function_call");
    assert.equal(completed.output_text, "Checking now.");
    assert.equal(reasoning.summary[0].text, "Inspect first. Then call the tool.");
    assert.equal(call.call_id, "call_stream_reasoning");
    assert.equal(call.reasoning_content, "Inspect first. Then call the tool.");
    assert.match(raw, /response\.reasoning_summary_text\.delta/);
    assert.equal(history.snapshot()[0].messages.at(-1).reasoning_content, "Inspect first. Then call the tool.");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("cancelling a streamed Chat Completions request closes the Relay response", async () => {
  let upstreamClosed = false;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.once("close", () => { upstreamClosed = true; });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "working" } }] })}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("cancel-stream", "cancel-key");
    const configured = settings({
      providers: [{ id: "cancel-stream", name: "Cancel stream", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Cancel stream", providerId: "cancel-stream", upstreamModel: "cancel-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const controller = new AbortController();
    const route = routeForRequest(configured, "relay-third-party-1");
    const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "cancel", stream: true }, headers: {}, signal: controller.signal, history: createChatHistory() });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    const completed = await Promise.race([
      (async () => {
        try { while (!(await reader.read()).done) { /* drain */ } }
        catch (error) { if (error?.name !== "AbortError") throw error; }
        return true;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(completed, true);
    const upstreamCancelled = await Promise.race([
      (async () => { while (!upstreamClosed) await new Promise((resolve) => setTimeout(resolve, 10)); return true; })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(upstreamCancelled, true);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("cancelling a streamed third-party Responses request closes the paid upstream response", async () => {
  let upstreamClosed = false;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.once("close", () => { upstreamClosed = true; });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "working" })}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    store.saveProviderKey("responses-cancel", "cancel-key");
    const configured = settings({
      providers: [{ id: "responses-cancel", name: "Responses cancel", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Responses cancel", providerId: "responses-cancel", upstreamModel: "gpt-5.6-sol", contextWindow: 372000, supportsImages: true, dropParams: [] }],
    });
    const controller = new AbortController();
    const route = routeForRequest(configured, "relay-third-party-1");
    const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "cancel", stream: true }, headers: {}, signal: controller.signal, history: createChatHistory() });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    const completed = await Promise.race([
      (async () => {
        try { while (!(await reader.read()).done) { /* drain */ } }
        catch (error) { if (error?.name !== "AbortError") throw error; }
        return true;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(completed, true);
    const upstreamCancelled = await Promise.race([
      (async () => { while (!upstreamClosed) await new Promise((resolve) => setTimeout(resolve, 10)); return true; })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(upstreamCancelled, true);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("one Chat provider switches from GLM 5.2 to DeepSeek using visible history and model-specific reasoning", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: received.length === 1 ? "glm reply" : "deepseek reply" } }],
      usage: {},
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const provider = { id: "shared-chat", name: "Shared Chat", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} };
    store.saveProviderKey(provider.id, "shared-chat-key");
    const configured = store.replaceSettings(settings({
      providers: [provider],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "GLM 5.2", providerId: provider.id, upstreamModel: "glm-5.2", contextWindow: 128_000, supportsImages: false, reasoningPreset: "auto", dropParams: [] },
        { id: "relay-third-party-2", displayName: "DeepSeek V4 Pro", providerId: provider.id, upstreamModel: "deepseek-v4-pro", contextWindow: 128_000, supportsImages: false, reasoningPreset: "auto", dropParams: [] },
      ],
    }));
    const history = createChatHistory();
    const glmRoute = routeForRequest(configured, "relay-third-party-1");
    const first = await forwardResponses({
      settings: configured,
      route: glmRoute,
      body: { model: glmRoute.id, input: "first user message", stream: false, reasoning: { effort: "medium" } },
      headers: {},
      history,
    });
    const deepSeekRoute = routeForRequest(configured, "relay-third-party-2");
    const second = await forwardResponses({
      settings: configured,
      route: deepSeekRoute,
      body: { model: deepSeekRoute.id, previous_response_id: first.id, input: "continue with DeepSeek", stream: false, reasoning: { effort: "high" } },
      headers: {},
      history,
    });

    assert.equal(second.status, "completed");
    assert.equal(glmRoute.contextWindow, 1_000_000);
    assert.equal(deepSeekRoute.contextWindow, 1_000_000);
    assert.deepEqual(received.map((item) => item.headers.authorization), ["Bearer shared-chat-key", "Bearer shared-chat-key"]);
    assert.equal(received[0].body.model, "glm-5.2");
    assert.deepEqual(received[0].body.thinking, { type: "enabled" });
    assert.equal(received[0].body.reasoning_effort, undefined);
    assert.equal(received[1].body.model, "deepseek-v4-pro");
    assert.deepEqual(received[1].body.messages.map((message) => message.content), ["first user message", "glm reply", "continue with DeepSeek"]);
    assert.equal(received[1].body.previous_response_id, undefined);
    assert.deepEqual(received[1].body.thinking, { type: "enabled" });
    assert.equal(received[1].body.reasoning_effort, "high");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("switching routes replays visible history instead of leaking a foreign response id", async () => {
  const chatUpstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "first model reply" } }], usage: {} }));
  });
  const responsesRequests = [];
  const responsesUpstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    responsesRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_second_provider", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "second model reply" }] }] }));
  });
  await Promise.all([
    new Promise((resolve) => chatUpstream.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => responsesUpstream.listen(0, "127.0.0.1", resolve)),
  ]);
  const chatPort = chatUpstream.address().port;
  const responsesPort = responsesUpstream.address().port;
  store.saveProviderKey("chat", "chat-key");
  store.saveProviderKey("responses", "responses-key");
  const configured = settings({
    providers: [
      { id: "chat", name: "Chat Provider", baseUrl: `http://127.0.0.1:${chatPort}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} },
      { id: "responses", name: "Responses Provider", baseUrl: `http://127.0.0.1:${responsesPort}/v1`, apiType: "responses", note: "", extraHeaders: {} },
    ],
    thirdPartySlots: [
      { id: "relay-third-party-1", displayName: "First", providerId: "chat", upstreamModel: "first-model", contextWindow: 128000, supportsImages: false, dropParams: [] },
      { id: "relay-third-party-2", displayName: "Second", providerId: "responses", upstreamModel: "second-model", contextWindow: 128000, supportsImages: false, dropParams: [] },
    ],
  });
  const history = createChatHistory();
  const firstRoute = routeForRequest(configured, "relay-third-party-1");
  const first = await forwardResponses({ settings: configured, route: firstRoute, body: { model: firstRoute.id, input: "first user message", stream: false }, headers: {}, history });
  const secondRoute = routeForRequest(configured, "relay-third-party-2");
  const second = await forwardResponses({ settings: configured, route: secondRoute, body: { model: secondRoute.id, previous_response_id: first.id, input: "second user message", stream: false }, headers: {}, history });

  assert.equal(second.status, 200);
  assert.equal(responsesRequests[0].previous_response_id, undefined);
  assert.deepEqual(responsesRequests[0].input.map((item) => item.content[0].text), ["first user message", "first model reply", "second user message"]);
  assert.equal(responsesRequests[0].model, "second-model");
  await Promise.all([new Promise((resolve) => chatUpstream.close(resolve)), new Promise((resolve) => responsesUpstream.close(resolve))]);
});

test("S2-F H5 Responses to Chat and back preserves tool results and portable context", async () => {
  resetTestState();
  const responsesRequests = [];
  const chatRequests = [];
  const responsesUpstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    responsesRequests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responsesRequests.length === 1 ? {
      id: "resp_s2f_h5_tool",
      object: "response",
      output: [{ type: "function_call", id: "fc_s2f_h5", call_id: "call_s2f_h5", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
    } : {
      id: "resp_s2f_h5_return",
      object: "response",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "returned to Responses" }] }],
    }));
  });
  const chatUpstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    chatRequests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "chat route saw the tool result" } }], usage: {} }));
  });
  await Promise.all([
    new Promise((resolve) => responsesUpstream.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => chatUpstream.listen(0, "127.0.0.1", resolve)),
  ]);
  try {
    const responsesKey = "s2f-h5-responses-key";
    const chatKey = "s2f-h5-chat-key";
    store.saveProviderKey("s2f-h5-responses", responsesKey);
    store.saveProviderKey("s2f-h5-chat", chatKey);
    const configured = settings({
      providers: [
        { id: "s2f-h5-responses", name: "Account pool GPT", baseUrl: `http://127.0.0.1:${responsesUpstream.address().port}/v1`, apiType: "responses" },
        { id: "s2f-h5-chat", name: "DeepSeek Chat", baseUrl: `http://127.0.0.1:${chatUpstream.address().port}/v1`, apiType: "chat_completions" },
      ],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "Pool GPT", providerId: "s2f-h5-responses", upstreamModel: "gpt-5.6-sol", contextWindow: 128000, supportsImages: false, dropParams: [] },
        { id: "relay-third-party-2", displayName: "DeepSeek", providerId: "s2f-h5-chat", upstreamModel: "deepseek-v4", contextWindow: 128000, supportsImages: false, dropParams: [] },
      ],
    });
    const history = createChatHistory();
    const responsesRoute = routeForRequest(configured, "relay-third-party-1");
    const chatRoute = routeForRequest(configured, "relay-third-party-2");
    const firstBody = { model: responsesRoute.id, input: "Use the cross-route tool", stream: false };
    const first = await forwardResponses({ settings: configured, route: responsesRoute, body: firstBody, headers: {}, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, responsesRoute, firstRaw);

    const second = await forwardResponses({
      settings: configured,
      route: chatRoute,
      body: { model: chatRoute.id, previous_response_id: JSON.parse(firstRaw).id, input: [{ type: "function_call_output", call_id: "call_s2f_h5", output: "README tool result" }], stream: false },
      headers: { "user-agent": "codex-chat-test/1.0", cookie: "chat-cookie-must-not-leak", "x-codex-turn-state": "chat-state-must-not-leak" },
      history,
    });
    const third = await forwardResponses({
      settings: configured,
      route: responsesRoute,
      body: { model: responsesRoute.id, previous_response_id: second.id, input: "Return to the GPT route", stream: false },
      headers: {},
      history,
    });
    await third.text();

    assert.equal(second.codex_relay.context_mode, "portable_context");
    assert.equal(responseContextMode(third), "portable_context");
    assert.deepEqual(chatRequests[0].body.messages.map((message) => message.role), ["user", "assistant", "tool"]);
    assert.equal(chatRequests[0].body.messages[1].tool_calls[0].id, "call_s2f_h5");
    assert.equal(chatRequests[0].body.messages[2].tool_call_id, "call_s2f_h5");
    assert.equal(chatRequests[0].body.messages[2].content, "README tool result");
    assert.equal(chatRequests[0].headers.authorization, `Bearer ${chatKey}`);
    assert.equal(chatRequests[0].headers["user-agent"], "codex-chat-test/1.0");
    assert.equal(chatRequests[0].headers.cookie, undefined);
    assert.equal(chatRequests[0].headers["x-codex-turn-state"], undefined);
    assert.doesNotMatch(JSON.stringify(chatRequests[0]), /s2f-h5-responses-key/);

    const returnedInput = responsesRequests[1].body.input;
    assert.equal(responsesRequests[1].body.previous_response_id, undefined);
    assert.ok(returnedInput.some((item) => item.type === "function_call" && item.call_id === "call_s2f_h5"));
    assert.ok(returnedInput.some((item) => item.type === "function_call_output" && item.call_id === "call_s2f_h5" && item.output === "README tool result"));
    assert.ok(returnedInput.some((item) => item.role === "assistant" && item.content?.[0]?.text === "chat route saw the tool result"));
    assert.ok(returnedInput.some((item) => item.role === "user" && item.content?.[0]?.text === "Return to the GPT route"));
    assert.equal(responsesRequests[1].headers.authorization, `Bearer ${responsesKey}`);
    assert.doesNotMatch(JSON.stringify(responsesRequests[1]), /s2f-h5-chat-key/);
  } finally {
    await Promise.all([
      new Promise((resolve) => responsesUpstream.close(resolve)),
      new Promise((resolve) => chatUpstream.close(resolve)),
    ]);
    resetTestState();
  }
});

test("S2-F H2 official to account-pool Responses and back keeps credentials and response IDs isolated", async () => {
  resetTestState();
  const officialRequests = [];
  const poolRequests = [];
  const officialUpstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    officialRequests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_s2f_official_${officialRequests.length}`,
      object: "response",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `official-reply-${officialRequests.length}` }] }],
    }));
  });
  const poolUpstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    poolRequests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_s2f_pool_${poolRequests.length}`,
      object: "response",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `pool-reply-${poolRequests.length}` }] }],
    }));
  });
  await Promise.all([
    new Promise((resolve) => officialUpstream.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => poolUpstream.listen(0, "127.0.0.1", resolve)),
  ]);
  try {
    const officialToken = captureOfficialToken("s2f-official-token");
    const poolKey = "s2f-account-pool-key";
    store.saveProviderKey("s2f-account-pool", poolKey);
    const configured = settings({
      official: { verified: true, lastCheckedAt: "2026-07-17T00:00:00.000Z" },
      providers: [{ id: "s2f-account-pool", name: "Account pool", baseUrl: `http://127.0.0.1:${poolUpstream.address().port}/v1`, apiType: "responses" }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Pool GPT", providerId: "s2f-account-pool", upstreamModel: "gpt-5.6-sol", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const officialBaseUrl = `http://127.0.0.1:${officialUpstream.address().port}`;
    const history = createChatHistory();
    const officialRoute = routeForRequest(configured, "gpt-5.6-terra");
    const firstBody = { model: officialRoute.id, input: "start on official", stream: false };
    const first = await forwardResponses({ settings: configured, route: officialRoute, body: firstBody, headers: {}, history, officialBaseUrl });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, officialRoute, firstRaw);
    const firstId = JSON.parse(firstRaw).id;

    const poolRoute = routeForRequest(configured, "relay-third-party-1");
    const secondBody = { model: poolRoute.id, previous_response_id: firstId, input: "continue through the pool", stream: false };
    const second = await forwardResponses({
      settings: configured,
      route: poolRoute,
      body: secondBody,
      headers: {
        authorization: "Bearer official-client-header-must-not-leak",
        "x-api-key": "official-client-key-must-not-leak",
        "user-agent": "codex-client-test/1.0",
        "x-openai-client-user-agent": "codex-test-runtime",
        cookie: "session=must-not-leak",
        "x-codex-turn-metadata": "must-not-leak",
      },
      history,
    });
    const secondRaw = await second.text();
    recordPassthroughResponse(history, secondBody, poolRoute, secondRaw);
    const secondId = JSON.parse(secondRaw).id;

    const thirdBody = { model: officialRoute.id, previous_response_id: secondId, input: "return to official", stream: false };
    const third = await forwardResponses({
      settings: configured,
      route: officialRoute,
      body: thirdBody,
      headers: { authorization: `Bearer ${poolKey}`, "x-api-key": poolKey },
      history,
      officialBaseUrl,
    });
    await third.text();

    assert.equal(responseContextMode(second), "portable_context");
    assert.equal(responseContextMode(third), "portable_context");
    assert.equal(poolRequests[0].body.previous_response_id, undefined);
    assert.equal(poolRequests[0].body.model, "gpt-5.6-sol");
    assert.deepEqual(poolRequests[0].body.input.map((item) => item.content[0].text), ["start on official", "official-reply-1", "continue through the pool"]);
    assert.equal(poolRequests[0].headers.authorization, `Bearer ${poolKey}`);
    assert.equal(poolRequests[0].headers["user-agent"], "codex-client-test/1.0");
    assert.equal(poolRequests[0].headers["x-openai-client-user-agent"], "codex-test-runtime");
    assert.equal(poolRequests[0].headers.cookie, undefined);
    assert.equal(poolRequests[0].headers["x-codex-turn-metadata"], undefined);
    assert.doesNotMatch(JSON.stringify(poolRequests[0]), /s2f-official-token|official-client-header|official-client-key/);

    assert.equal(officialRequests.length, 2);
    assert.equal(officialRequests[1].body.previous_response_id, undefined);
    assert.equal(officialRequests[1].body.model, "gpt-5.6-terra");
    assert.deepEqual(officialRequests[1].body.input.map((item) => item.content[0].text), ["start on official", "official-reply-1", "continue through the pool", "pool-reply-1", "return to official"]);
    assert.equal(officialRequests[1].headers.authorization, `Bearer ${officialToken}`);
    assert.equal(officialRequests[1].headers["x-api-key"], undefined);
    assert.doesNotMatch(JSON.stringify(officialRequests), /s2f-account-pool-key/);
  } finally {
    await Promise.all([
      new Promise((resolve) => officialUpstream.close(resolve)),
      new Promise((resolve) => poolUpstream.close(resolve)),
    ]);
    resetTestState();
  }
});

test("S2-F H6 account-pool GPT and domestic Responses keep independent state domains", async () => {
  resetTestState();
  const poolRequests = [];
  const domesticRequests = [];
  const createResponsesUpstream = (requests, prefix) => http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_${prefix}_${requests.length}`,
      object: "response",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `${prefix}-reply-${requests.length}` }] }],
    }));
  });
  const poolUpstream = createResponsesUpstream(poolRequests, "pool");
  const domesticUpstream = createResponsesUpstream(domesticRequests, "domestic");
  await Promise.all([
    new Promise((resolve) => poolUpstream.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => domesticUpstream.listen(0, "127.0.0.1", resolve)),
  ]);
  try {
    const poolKey = "s2f-pool-key";
    const domesticKey = "s2f-domestic-key";
    store.saveProviderKey("s2f-pool", poolKey);
    store.saveProviderKey("s2f-domestic", domesticKey);
    const configured = settings({
      providers: [
        { id: "s2f-pool", name: "Account pool", baseUrl: `http://127.0.0.1:${poolUpstream.address().port}/v1`, apiType: "responses" },
        { id: "s2f-domestic", name: "Domestic Responses", baseUrl: `http://127.0.0.1:${domesticUpstream.address().port}/v1`, apiType: "responses" },
      ],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "Pool GPT", providerId: "s2f-pool", upstreamModel: "shared-model-name", contextWindow: 128000, supportsImages: false, dropParams: [] },
        { id: "relay-third-party-2", displayName: "Domestic", providerId: "s2f-domestic", upstreamModel: "shared-model-name", contextWindow: 128000, supportsImages: false, dropParams: [] },
      ],
    });
    const history = createChatHistory();
    const poolRoute = routeForRequest(configured, "relay-third-party-1");
    const domesticRoute = routeForRequest(configured, "relay-third-party-2");
    const firstBody = { model: poolRoute.id, input: "start on the account pool", stream: false };
    const first = await forwardResponses({ settings: configured, route: poolRoute, body: firstBody, headers: {}, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, poolRoute, firstRaw);

    const secondBody = { model: domesticRoute.id, previous_response_id: JSON.parse(firstRaw).id, input: "continue on domestic Responses", stream: false };
    const second = await forwardResponses({ settings: configured, route: domesticRoute, body: secondBody, headers: {}, history });
    const secondRaw = await second.text();
    recordPassthroughResponse(history, secondBody, domesticRoute, secondRaw);

    const thirdBody = { model: poolRoute.id, previous_response_id: JSON.parse(secondRaw).id, input: "return to the account pool", stream: false };
    const third = await forwardResponses({ settings: configured, route: poolRoute, body: thirdBody, headers: {}, history });
    await third.text();

    assert.equal(responseContextMode(second), "portable_context");
    assert.equal(responseContextMode(third), "portable_context");
    assert.equal(domesticRequests[0].body.previous_response_id, undefined);
    assert.deepEqual(domesticRequests[0].body.input.map((item) => item.content[0].text), ["start on the account pool", "pool-reply-1", "continue on domestic Responses"]);
    assert.equal(domesticRequests[0].headers.authorization, `Bearer ${domesticKey}`);
    assert.doesNotMatch(JSON.stringify(domesticRequests[0]), /s2f-pool-key/);

    assert.equal(poolRequests[1].body.previous_response_id, undefined);
    assert.deepEqual(poolRequests[1].body.input.map((item) => item.content[0].text), ["start on the account pool", "pool-reply-1", "continue on domestic Responses", "domestic-reply-1", "return to the account pool"]);
    assert.equal(poolRequests[1].headers.authorization, `Bearer ${poolKey}`);
    assert.doesNotMatch(JSON.stringify(poolRequests[1]), /s2f-domestic-key/);
    assert.equal(store.loadSettings().providers.every((provider) => provider.nativeResponseContinuation === false), true);
  } finally {
    await Promise.all([
      new Promise((resolve) => poolUpstream.close(resolve)),
      new Promise((resolve) => domesticUpstream.close(resolve)),
    ]);
    resetTestState();
  }
});

test("S2-F H7 rapid switching keeps one Router listener and leaves Codex config and auth untouched", async () => {
  resetTestState();
  const requestsByProvider = new Map();
  const createUpstream = (providerId, apiType) => http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const records = requestsByProvider.get(providerId) || [];
    records.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    requestsByProvider.set(providerId, records);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(apiType === "responses"
      ? JSON.stringify({ id: `resp_${providerId}_${records.length}`, object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `${providerId}-ok` }] }] })
      : JSON.stringify({ choices: [{ message: { content: `${providerId}-ok` } }], usage: {} }));
  });
  const definitions = [
    { id: "rapid-pool", apiType: "responses", model: "gpt-5.6-sol" },
    { id: "rapid-chat", apiType: "chat_completions", model: "deepseek-v4" },
    { id: "rapid-domestic", apiType: "responses", model: "domestic-responses" },
  ];
  const upstreams = definitions.map((definition) => createUpstream(definition.id, definition.apiType));
  await Promise.all(upstreams.map((upstream) => new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))));
  let relay;
  try {
    const providers = definitions.map((definition, index) => ({
      id: definition.id,
      name: definition.id,
      baseUrl: `http://127.0.0.1:${upstreams[index].address().port}/v1`,
      apiType: definition.apiType,
    }));
    const thirdPartySlots = definitions.map((definition, index) => ({
      id: `relay-third-party-${index + 1}`,
      displayName: definition.id,
      providerId: definition.id,
      upstreamModel: definition.model,
      contextWindow: 128000,
      supportsImages: false,
      dropParams: [],
    }));
    for (const definition of definitions) store.saveProviderKey(definition.id, `key-${definition.id}`);
    store.replaceSettings(settings({ router: { host: "127.0.0.1", port: 15723, running: true }, providers, thirdPartySlots }));

    fs.mkdirSync(path.dirname(store.paths().codexConfig), { recursive: true });
    const configBefore = Buffer.from('model_provider = "s2f-sentinel"\nmodel = "unchanged"\n');
    const authBefore = Buffer.from(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "s2f-auth-sentinel", account_id: "s2f-account" } }));
    fs.writeFileSync(store.paths().codexConfig, configBefore);
    fs.writeFileSync(store.paths().codexAuth, authBefore);

    relay = createRelayServer();
    let closeEvents = 0;
    relay.on("close", () => { closeEvents += 1; });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const port = relay.address().port;
    const requestListeners = relay.listenerCount("request");
    const sequence = Array.from({ length: 24 }, (_, index) => `relay-third-party-${(index % thirdPartySlots.length) + 1}`);
    const responses = await Promise.all(sequence.map((model, index) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: `rapid-${index}`, stream: false }),
      signal: AbortSignal.timeout(5_000),
    })));
    await Promise.all(responses.map(async (response) => {
      assert.equal(response.status, 200);
      await response.text();
    }));

    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.json());
    assert.equal(health.listening, true);
    assert.equal(relay.listening, true);
    assert.equal(relay.address().port, port);
    assert.equal(relay.listenerCount("request"), requestListeners);
    assert.equal(closeEvents, 0);
    assert.deepEqual(fs.readFileSync(store.paths().codexConfig), configBefore);
    assert.deepEqual(fs.readFileSync(store.paths().codexAuth), authBefore);
    assert.equal(store.loadSettings().providers.every((provider) => provider.nativeResponseContinuation === false), true);
    assert.deepEqual(definitions.map((definition) => requestsByProvider.get(definition.id)?.length || 0), [8, 8, 8]);
    for (const definition of definitions) {
      const records = requestsByProvider.get(definition.id) || [];
      assert.equal(records.every((record) => record.headers.authorization === `Bearer key-${definition.id}`), true);
      assert.equal(records.every((record) => !JSON.stringify(record).includes("s2f-auth-sentinel")), true);
    }
  } finally {
    if (relay?.listening) await new Promise((resolve) => relay.close(resolve));
    await Promise.all(upstreams.map((upstream) => new Promise((resolve) => upstream.close(resolve))));
    resetTestState();
  }
});

test("Chat compatibility preserves reasoning, safe request parameters, and unique tool-call recovery", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(received.length === 1 ? {
      id: "chatcmpl_reasoning_tool",
      model: "deepseek-v4-pro",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          reasoning_content: "Need to inspect the file before answering.",
          content: "I will inspect it.",
          tool_calls: [{ id: "call_read_unique", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, completion_tokens_details: { reasoning_tokens: 5 } },
    } : {
      id: "chatcmpl_after_tool",
      model: "deepseek-v4-pro",
      choices: [{ finish_reason: "stop", message: { content: "The file was inspected." } }],
      usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const configured = settings({
    providers: [{ id: "reasoning-chat", name: "Reasoning Chat", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Reasoning Chat", providerId: "reasoning-chat", upstreamModel: "deepseek-v4-pro", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  });
  store.replaceSettings(configured);
  store.saveProviderKey("reasoning-chat", "reasoning-chat-key");
  const history = createChatHistory();
  try {
    const route = routeForRequest(configured, "relay-third-party-1");
    const first = await forwardResponses({
      settings: configured,
      route,
      body: {
        model: route.id,
        input: [{ role: "user", content: [{ type: "input_text", text: "Inspect README.md" }] }],
        tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
        tool_choice: "auto",
        parallel_tool_calls: true,
        max_output_tokens: 321,
        top_p: 0.8,
        presence_penalty: 0.2,
        stop: ["END"],
        response_format: { type: "json_object" },
        metadata: { test: "compatibility" },
        reasoning: { effort: "high" },
      },
      headers: {},
      history,
    });
    assert.equal(received[0].max_tokens, 321);
    assert.equal(received[0].top_p, 0.8);
    assert.equal(received[0].presence_penalty, 0.2);
    assert.deepEqual(received[0].stop, ["END"]);
    assert.equal(received[0].parallel_tool_calls, true);
    assert.deepEqual(received[0].response_format, { type: "json_object" });
    assert.deepEqual(received[0].metadata, { test: "compatibility" });
    assert.equal(first.output[0].type, "reasoning");
    assert.equal(first.output[0].summary[0].text, "Need to inspect the file before answering.");
    assert.equal(first.output[1].content[0].text, "I will inspect it.");
    assert.equal(first.output[2].call_id, "call_read_unique");
    assert.equal(first.output[2].reasoning_content, "Need to inspect the file before answering.");

    await forwardResponses({
      settings: configured,
      route,
      body: { model: route.id, input: [{ type: "function_call_output", call_id: "call_read_unique", output: "README contents" }] },
      headers: {},
      history,
    });
    const restoredAssistant = received[1].messages.find((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call_read_unique");
    assert.ok(restoredAssistant);
    assert.equal(restoredAssistant.reasoning_content, "Need to inspect the file before answering.");
    assert.ok(received[1].messages.some((message) => message.role === "tool" && message.tool_call_id === "call_read_unique"));
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Chat compatibility separates a leading think block from the visible answer", async () => {
  resetTestState();
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain request. */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "<think>Check the constraints first.</think>\n\nVisible answer" } }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const configured = settings({
    providers: [{ id: "think-chat", name: "Think Chat", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Think Chat", providerId: "think-chat", upstreamModel: "thinking-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  });
  store.replaceSettings(configured);
  store.saveProviderKey("think-chat", "think-chat-key");
  try {
    const result = await forwardResponses({ settings: configured, route: routeForRequest(configured, "relay-third-party-1"), body: { model: "relay-third-party-1", input: "hello" }, headers: {}, history: createChatHistory() });
    assert.equal(result.output[0].type, "reasoning");
    assert.equal(result.output[0].summary[0].text, "Check the constraints first.");
    assert.equal(result.output_text, "Visible answer");
    assert.doesNotMatch(result.output_text, /<think>/);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Chat compatibility accepts wrong content types, multiline SSE, and a final unterminated frame", async () => {
  resetTestState();
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain request. */ }
    response.writeHead(200, { "content-type": "text/plain" });
    response.write('data: {"choices":[{"delta":{"reasoning_content":"Need context. "}}]}\n\n');
    response.end('data: {"choices":[\n' +
      'data: {"delta":{"reasoning_content":"Then answer. ","content":"Visible stream"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const configured = settings({
    providers: [{ id: "odd-stream", name: "Odd Stream", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Odd Stream", providerId: "odd-stream", upstreamModel: "deepseek-stream", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  });
  store.replaceSettings(configured);
  store.saveProviderKey("odd-stream", "odd-stream-key");
  try {
    const result = await forwardResponses({ settings: configured, route: routeForRequest(configured, "relay-third-party-1"), body: { model: "relay-third-party-1", input: "hello", stream: true }, headers: {}, history: createChatHistory() });
    const raw = await result.text();
    const completedLine = raw.split(/\r?\n/).find((line) => line.startsWith("data:") && line.includes('"response.completed"'));
    const completed = JSON.parse(completedLine.slice(5).trim()).response;
    assert.equal(completed.output_text, "Visible stream");
    assert.equal(completed.output.find((item) => item.type === "reasoning").summary[0].text, "Need context. Then answer.");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("third-party HTML failures become concise Responses errors", async () => {
  resetTestState();
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain request. */ }
    response.writeHead(502, { "content-type": "text/html; charset=UTF-8", "cf-ray": "test-ray" });
    response.end('<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>' + "gateway detail ".repeat(1000) + "</body></html>");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "html-provider", name: "HTML Provider", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "HTML Model", providerId: "html-provider", upstreamModel: "gpt-html", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("html-provider", "html-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "hello", stream: true }),
    });
    const raw = await response.text();
    const body = JSON.parse(raw);
    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(body.error.code, "upstream_http_502");
    assert.match(body.error.message, /HTML Provider/);
    assert.match(body.error.message, /HTTP 502/);
    assert.doesNotMatch(raw, /<!DOCTYPE|<html|gateway detail/i);
    assert.ok(raw.length < 1200);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("S4-C3 classifies successful third-party error payloads and incomplete SSE without retries", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body.input);
    if (body.input === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end('{"id":');
    }
    if (body.input === "envelope") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { code: "provider_overloaded", message: "Try again later" } }));
    }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_s4c3"}}\n\n');
    if (body.input === "stream-error") {
      return response.end('event: error\ndata: {"type":"error","error":{"code":"provider_stream_failure"}}\n\n');
    }
    response.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "s4c3-errors", name: "S4-C3 errors", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "S4-C3 errors", providerId: "s4c3-errors", upstreamModel: "s4c3-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("s4c3-errors", "s4c3-errors-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${relay.address().port}/v1/responses`;
  const send = (input) => fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "relay-third-party-1", input, stream: true }),
  });
  try {
    const malformed = await send("malformed");
    assert.equal(malformed.status, 502);
    assert.equal((await malformed.json()).error.code, "upstream_success_invalid_json");

    const envelope = await send("envelope");
    assert.equal(envelope.status, 502);
    assert.equal((await envelope.json()).error.code, "provider_overloaded");

    const truncated = await send("truncated");
    assert.equal(truncated.status, 200);
    assert.match(await truncated.text(), /response\.created/);

    const streamError = await send("stream-error");
    assert.equal(streamError.status, 200);
    assert.match(await streamError.text(), /event: error/);

    assert.deepEqual(requests, ["malformed", "envelope", "truncated", "stream-error"]);
    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    const records = state.events.filter((event) => event.route.providerId === "s4c3-errors");
    assert.equal(records.length, 4);
    assert.ok(records.every((event) => event.status === 502 && event.ok === false));
    for (const code of ["upstream_success_invalid_json", "provider_overloaded", "upstream_stream_truncated", "upstream_stream_error_envelope"]) {
      assert.ok(records.some((event) => event.error?.code === code), `Missing ${code}: ${JSON.stringify(records, null, 2)}`);
    }
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("third-party streaming Responses use identity encoding and expose safe upstream diagnostics", async () => {
  resetTestState();
  let requestHeaders;
  const upstream = http.createServer(async (request, response) => {
    requestHeaders = request.headers;
    for await (const _chunk of request) { /* Drain request. */ }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "x-request-id": "request-stream-123",
      "openai-processing-ms": "42",
      "x-ratelimit-remaining-requests": "19",
    });
    response.end('data: {"type":"response.completed","response":{"id":"resp_stream_headers","status":"completed","output":[]}}\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "stream-headers", name: "Stream headers", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Stream headers", providerId: "stream-headers", upstreamModel: "gpt-stream", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("stream-headers", "stream-headers-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "hello", stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(requestHeaders["accept-encoding"], "identity");
    assert.equal(response.headers.get("x-request-id"), "request-stream-123");
    assert.equal(response.headers.get("openai-processing-ms"), "42");
    assert.equal(response.headers.get("x-ratelimit-remaining-requests"), "19");
    assert.match(await response.text(), /resp_stream_headers/);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("third-party HTTP streaming first-byte timeout aborts the upstream before local headers are committed", async () => {
  resetTestState();
  let upstreamClosed = false;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain request. */ }
    response.once("close", () => { upstreamClosed = true; });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "first-byte-timeout", name: "First byte timeout", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "First byte timeout", providerId: "first-byte-timeout", upstreamModel: "gpt-timeout", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("first-byte-timeout", "timeout-key");
  const relay = createRelayServer({ thirdPartyHttp: { firstByteTimeoutMs: 35, streamIdleTimeoutMs: 100 } });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "wait", stream: true }),
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "upstream_first_byte_timeout");
    const deadline = Date.now() + 1_000;
    while (!upstreamClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(upstreamClosed, true);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("third-party compaction first-byte timeout returns one local fallback and opens the billing circuit", async () => {
  resetTestState();
  let upstreamRequests = 0;
  let upstreamClosed = false;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain request. */ }
    upstreamRequests += 1;
    response.once("close", () => { upstreamClosed = true; });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "compaction-first-byte-timeout", name: "Compaction first byte timeout", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Compaction first byte timeout", providerId: "compaction-first-byte-timeout", upstreamModel: "gpt-compact-timeout", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("compaction-first-byte-timeout", "compaction-timeout-key");
  const relay = createRelayServer({ thirdPartyHttp: { firstByteTimeoutMs: 35, streamIdleTimeoutMs: 100 } });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const body = {
    model: "relay-third-party-1",
    input: [{ role: "user", content: [{ type: "input_text", text: "Keep this long-running task." }] }, { type: "compaction_trigger" }],
    stream: true,
  };
  try {
    const first = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 200);
    assert.match(await first.text(), /local_emergency/);
    const deadline = Date.now() + 1_000;
    while (!upstreamClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(upstreamClosed, true);

    const repeated = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(repeated.status, 200);
    assert.match(await repeated.text(), /local_emergency/);
    assert.equal(upstreamRequests, 1);

    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    assert.ok(state.events.some((event) => event.diagnostics.failureReason === "upstream_first_byte_timeout"));
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("third-party HTTP streaming idle timeout closes a stalled upstream after forwarding its first event", async () => {
  resetTestState();
  let upstreamClosed = false;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain request. */ }
    response.once("close", () => { upstreamClosed = true; });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"response.created","response":{"id":"resp_idle"}}\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "idle-timeout", name: "Idle timeout", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Idle timeout", providerId: "idle-timeout", upstreamModel: "gpt-idle", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("idle-timeout", "idle-timeout-key");
  const relay = createRelayServer({ thirdPartyHttp: { firstByteTimeoutMs: 100, streamIdleTimeoutMs: 35 } });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "wait", stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /resp_idle/);
    const deadline = Date.now() + 1_000;
    while (!upstreamClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(upstreamClosed, true);
    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    assert.equal(state.events[0].status, 504);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("HTTP third-party forward proxies reuse a keep-alive connection", async () => {
  const remotePorts = [];
  const proxy = http.createServer(async (request, response) => {
    remotePorts.push(request.socket.remotePort);
    for await (const _chunk of request) { /* Drain request. */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const provider = { networkMode: "custom", proxyUrl: `http://127.0.0.1:${proxy.address().port}` };
    for (let index = 0; index < 2; index += 1) {
      const response = await fetchProvider(provider, "http://unreachable.invalid/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await response.text();
    }
    assert.equal(remotePorts.length, 2);
    assert.equal(remotePorts[0], remotePorts[1]);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("DeepSeek Responses stays stateless without changing standard Responses routes", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_deepseek_${received.length}`,
      object: "response",
      status: "completed",
      model: "deepseek-v4-flash",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    const configured = settings({
      providers: [
        { id: "deepseek-responses", name: "DeepSeek Responses", baseUrl, apiType: "responses", responsesCompatibility: "deepseek", nativeResponseContinuation: true },
        { id: "standard-responses", name: "Standard", baseUrl, apiType: "responses" },
      ],
      thirdPartySlots: [
        { id: "relay-third-party-1", displayName: "DeepSeek V4 Flash", providerId: "deepseek-responses", upstreamModel: "deepseek-v4-flash", contextWindow: 1_000_000, supportsImages: false, dropParams: [] },
        { id: "relay-third-party-2", displayName: "Standard", providerId: "standard-responses", upstreamModel: "standard-model", contextWindow: 128_000, supportsImages: false, dropParams: [] },
      ],
    });
    store.replaceSettings(configured);
    store.saveProviderKey("deepseek-responses", "deepseek-key");
    store.saveProviderKey("standard-responses", "standard-key");

    const deepSeekRoute = routeForRequest(configured, "relay-third-party-1");
    const history = createChatHistory();
    const firstBody = { model: deepSeekRoute.id, input: "first message", stream: false, store: true, conversation: "ignored" };
    const first = await forwardResponses({ settings: configured, route: deepSeekRoute, body: firstBody, headers: {}, history });
    const firstRaw = await first.text();
    recordPassthroughResponse(history, firstBody, deepSeekRoute, firstRaw);
    const firstId = JSON.parse(firstRaw).id;

    const second = await forwardResponses({
      settings: configured,
      route: deepSeekRoute,
      body: { model: deepSeekRoute.id, previous_response_id: firstId, input: "second message", stream: false, store: true, conversation: "ignored" },
      headers: {},
      history,
    });
    await second.text();

    assert.equal(received[0].body.store, undefined);
    assert.equal(received[0].body.conversation, undefined);
    assert.equal(received[0].body.previous_response_id, undefined);
    assert.equal(received[1].body.store, undefined);
    assert.equal(received[1].body.conversation, undefined);
    assert.equal(received[1].body.previous_response_id, undefined);
    assert.match(JSON.stringify(received[1].body.input), /first message/);
    assert.match(JSON.stringify(received[1].body.input), /second message/);

    const compact = await forwardResponsesCompact({
      settings: configured,
      route: deepSeekRoute,
      body: { model: deepSeekRoute.id, input: [{ role: "user", content: [{ type: "input_text", text: "compact this" }] }], stream: false },
      headers: {},
    });
    assert.equal(compact.status, 200);
    await compact.text();
    assert.deepEqual(received.map((item) => item.path), ["/v1/responses", "/v1/responses", "/v1/responses"]);

    const standardRoute = routeForRequest(configured, "relay-third-party-2");
    const standard = await forwardResponses({
      settings: configured,
      route: standardRoute,
      body: { model: standardRoute.id, previous_response_id: "resp_standard", input: "keep this field", stream: false, store: false },
      headers: {},
      history: createChatHistory(),
    });
    await standard.text();
    assert.equal(received.at(-1).body.previous_response_id, undefined, "unknown standard IDs retain the existing portable fallback");
    assert.equal(received.at(-1).body.store, false, "DeepSeek field filtering does not alter standard providers");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("DeepSeek Responses provider profile only publishes the supported Flash model", async () => {
  resetTestState();
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${relay.address().port}`;
    const saved = await fetch(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "DeepSeek Responses",
        baseUrl: "https://api.deepseek.com",
        apiType: "responses",
        responsesCompatibility: "deepseek",
        nativeResponseContinuation: true,
      }),
    });
    assert.equal(saved.status, 200);
    const provider = (await saved.json()).provider;
    assert.equal(provider.responsesCompatibility, "deepseek");
    assert.equal(provider.nativeResponseContinuation, false);

    const pro = await fetch(`${baseUrl}/api/slots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "relay-third-party-1", displayName: "DeepSeek V4 Pro", providerId: provider.id, upstreamModel: "deepseek-v4-pro" }),
    });
    assert.equal(pro.status, 400);
    assert.equal((await pro.json()).error.code, "deepseek_responses_model_unsupported");

    const flash = await fetch(`${baseUrl}/api/slots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "relay-third-party-1", displayName: "DeepSeek V4 Flash", providerId: provider.id, upstreamModel: "deepseek-v4-flash" }),
    });
    assert.equal(flash.status, 200);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});
