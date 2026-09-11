const slotIds = Array.from({ length: 10 }, (_, index) => `relay-third-party-${index + 1}`);
const MODEL_HEALTH_INTERVAL_KEY = "codex-relay-model-health-interval";
const MODEL_HEALTH_INTERVALS = new Set([0, 15, 30, 60]);
const state = { data: null, view: "home", editingSlot: null, editingProvider: null, desktop: null, applyMode: "apply", applyPreview: null, restorePreview: null, officialDirectPreview: null, selectedThemeId: null, themePollToken: 0, providerModels: new Map(), batchSelectedModels: new Set(), officialUsageLoading: false, modelHealth: { intervalMinutes: 0, timer: null, pollToken: 0, refreshing: false }, thirdPartyInFlight: { timer: null }, requestHistory: { loaded: false, items: [], total: 0, hasMore: false, nextBeforeId: null, retainedLimit: 10_000 }, usageStatistics: { loaded: false, data: null, modelPeriod: "total", trendDays: 7, syncError: null } };
const buttonLoadingStates = new WeakMap();
const controlLoadingStates = new WeakMap();
const $ = (selector) => document.querySelector(selector);
const commonModels = [
  "deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini", "gpt-4.1", "gpt-4.1-mini",
  "kimi-k2.5", "kimi-k2-thinking", "kimi-k2-thinking-turbo",
  "qwen3-coder-plus", "qwen3-max", "qwen-plus", "qwen-turbo",
  "glm-4.7", "glm-4.7-flash", "glm-4.5-air",
  "MiniMax-M2.1", "MiniMax-M2.1-lightning",
];
const computerUseRepairPrompt = String.raw`请在这台 Windows 电脑上诊断并修复 Codex Desktop 的 Computer Use（电脑控制）。症状通常是插件已经显示并能选择，但任务提示“电脑操作连接不可用”，无法继续控制应用。

工作要求：
1. 先做只读诊断，再决定是否修改。动态识别当前 Codex 安装版本、Appx 包路径和本机数据目录，不要照抄固定版本号或旧目录。
2. 不读取或输出 API Key、access token、refresh token、聊天正文或隐藏推理；不修改 Codex auth.json、config.toml、Relay 路由、模型配置和会话正文。
3. 区分三层状态：Computer Use 插件是否安装并启用；当前 Appx 是否包含 cua_node 控制运行时；Codex Desktop 是否真正启动了电脑控制通道。插件入口可见不等于控制通道可用。

请按以下流程执行：

一、确认现场
- 获取当前 OpenAI.Codex Appx 版本与安装目录，确认 Codex 主进程、codex.exe 和 codex-code-mode-host.exe 的实际路径。
- 检查当前版本内置的 openai-bundled/computer-use 插件与 scripts/computer-use-client.mjs 是否存在。
- 检查 Appx resources/cua_node 中以下文件是否存在：
  - manifest.json
  - bin/node.exe
  - bin/node_repl.exe
  - bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe
  - bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/helper_transport.js

二、读取真正的桌面日志
- 找到 Codex Desktop 当次进程的日志目录。Microsoft Store 应用目录可能通过 Junction 指向其他磁盘，必须解析真实目标后读取。
- 只筛选诊断字段和错误，不读取聊天正文。重点搜索：
  - computer-use native pipe
  - computer_use_native_pipe_thread_config_skipped
  - browser_use_setup_failed
  - bundled_executable_relocation_failed
  - missingHelperPath
  - missingTransportModulePath
  - node-repl-missing
- 如果日志显示从 WindowsApps 复制 cua_node 失败，要记录失败文件、目标 staging 目录和错误码。常见表现是某个普通文件复制失败后，整个控制运行时被判定为不可用。

三、计算当前客户端真正查找的稳定运行时目录
- 不要把 manifest 中的 runtime ID 直接当作稳定目录名。
- 对 manifest.json、bin/node.exe、bin/node_repl.exe 分别计算 SHA-256。
- 按上述相对路径顺序，把“相对路径 + NUL + 该文件 SHA-256 十六进制字符串 + NUL”依次写入一个新的 SHA-256；取最终摘要前 16 个十六进制字符作为当前 Codex 实际查找的目录名。
- 目标根目录通常是 %LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node，但仍要从当前客户端日志和源码行为验证，不能盲猜。

四、仅在证据明确后修复
- 优先使用本机已经完整复制、且与当前 Appx 文件清单、总大小和核心文件哈希一致的 cua_node 副本，避免再次触发 WindowsApps 复制权限问题。
- 在目标根目录创建临时 staging 目录，完整复制运行时；核对文件数量、总字节数和上面五个必需文件的 SHA-256。
- 校验全部通过后，原子重命名为第三步计算出的 16 位目录。目标已存在时先验证，禁止直接覆盖未知内容。
- 不要为了“看起来干净”删除其他缓存、插件、会话或备份。失败时只清理本次创建的临时目录。

五、验收
- 完全退出 Codex（包括托盘进程）后重新打开，新建一个任务并选择 Computer Use。
- 日志必须出现电脑控制通道启动就绪，不再出现 helper paths unavailable 或 node-repl-missing。
- 最终验收不是“插件已显示”，而是通过官方 Computer Use 客户端列出当前可控应用，并完成一次真实操作，例如打开计算器计算 123 + 456。
- Chrome 控制还依赖 ChatGPT Chrome Extension、native host 与浏览器配置，这是另一条链路；不要把 Chrome 扩展问题误判成 Computer Use 运行时问题。

请在执行前说明诊断证据和计划，执行后报告：根因、修改的目录、校验结果、重启后的日志状态和真实操作结果。`;
const browserUseRepairPrompt = String.raw`请在这台 Windows 电脑上诊断并修复 Codex Desktop 的浏览器操控。症状可能包括：@ 菜单找不到浏览器插件、在设置中启用后仍无法使用、Chrome 无法连接，或者新任务提示 rollout 文件不存在。

工作要求：
1. 先只读诊断，再决定是否修改。动态识别当前 Codex Appx 版本、resources 目录、插件缓存和本机稳定目录，禁止照抄其他机器的版本号、哈希目录或用户路径。
2. 不读取或输出 API Key、access token、refresh token、Chrome 浏览历史、网页内容、聊天正文或隐藏推理；不修改 auth.json、config.toml、Relay 路由和模型配置。
3. 区分两条链路：Browser 插件控制 Codex 内置浏览器；Chrome 插件通过 ChatGPT Chrome Extension 和 native host 控制用户的 Chrome。两者共享部分运行时，但不能混为同一个故障。

请按以下流程执行：

一、确认插件和当前版本
- 获取当前 OpenAI.Codex Appx 安装位置，确认 resources/plugins/openai-bundled 中 browser、chrome 两个插件及各自 scripts/browser-client.mjs 是否存在。
- 检查当前 openai-bundled marketplace、browser@openai-bundled 和 chrome@openai-bundled 的启用状态。
- 对比 Appx 源插件与本机 marketplace/cache 的版本、plugin.json 哈希和关键客户端脚本，不把“旧目录存在”误判为当前版本可用。

二、检查任务为什么中断
- 读取当次 Codex Desktop 日志的诊断行，重点搜索：
  - browser_use_iab_backend_startup_ready
  - browser_use_codex_cli_missing_for_node_repl_sandbox
  - bundled_executable_relocation_failed
  - failed to resolve rollout path
  - thread not found / thread not loaded
- 如果浏览器后端已经 ready，但紧接着 app-server 重启并出现 rollout 文件不存在，说明任务在会话文件落盘前被中断。不要创建假的 JSONL 或伪造历史；修复环境后必须新建任务。

三、校验 Codex 稳定执行文件
- 当前客户端会为两组文件计算稳定目录：
  - codex.exe、codex-code-mode-host.exe、codex-windows-sandbox-setup.exe、codex-command-runner.exe
  - rg.exe
- 对每组文件按固定顺序计算：把“文件名 + NUL + 文件 SHA-256 十六进制字符串 + NUL”依次写入新的 SHA-256，取最终摘要前 16 个十六进制字符作为 %LOCALAPPDATA%\OpenAI\Codex\bin 下的目录名。
- 逐个核对目标文件的大小和 SHA-256。目标缺失时，在证据明确后创建本次专用 staging 目录，以可校验的流式复制写入，全部通过后原子重命名；目标已存在但不匹配时停止，不直接覆盖未知内容。
- 失败时只清理本次创建的 staging，不删除其他缓存、会话或备份。

四、检查 Chrome 链路
- 使用当前 chrome 插件自带的诊断脚本检查 Chrome 是否安装/运行、当前选中的 Profile、ChatGPT Chrome Extension 是否安装并启用、native host 清单和可执行文件是否存在。
- 扩展 ID 和 native host 名称必须从当前插件的 scripts/extension-id.json 读取，不能硬编码。
- Windows 中文系统的 reg.exe 默认值标签可能不是英文；判断 native host 时应按 REG_SZ/REG_EXPAND_SZ 的数据列解析，并再次直接核对注册表默认值、manifest name、allowed_origins 和 manifest.path。
- Chrome 未运行时先征得用户同意再打开当前选中的 Profile；不要自行安装扩展或静默重装 native host。

五、验收
- 完全退出并重开 Codex 后新建任务，不再使用缺少 rollout 文件的坏任务。
- Browser 链路应出现后端 ready，并能创建浏览器标签页；Chrome 链路应完成扩展握手、列出当前标签页，并完成一次只读操作，例如搜索指定关键词。
- 报告：根因、修改目录、每个文件的校验结果、Chrome Profile/扩展/native host 状态，以及新任务的真实操作结果。

执行前先说明证据和计划；任何可能覆盖未知文件、启动 Chrome、重装扩展或修改注册表的动作，都必须先获得用户明确同意。`;

bindStaticEvents();
lucide.createIcons();
initialize();

async function initialize() {
  state.modelHealth.intervalMinutes = storedModelHealthInterval();
  $("#model-health-interval").value = String(state.modelHealth.intervalMinutes);
  if (window.codexRelayDesktop?.isDesktop) {
    document.querySelectorAll(".desktop-only").forEach((element) => { element.hidden = false; });
    try {
      state.desktop = await window.codexRelayDesktop.getInfo();
      $("#app-version").textContent = `Codex Relay ${state.desktop.version}`;
      $("#launch-at-login").checked = Boolean(state.desktop.launchAtLogin);
    } catch { /* Browser mode remains fully usable. */ }
  }
  await refresh();
  scheduleModelHealthRefresh({ fromNow: !Number.isFinite(Date.parse(state.data?.modelHealth?.completedAt || "")) });
  startThirdPartyInFlightPolling();
}

function bindStaticEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll('[data-action="show-models"]').forEach((button) => button.addEventListener("click", () => showView("models")));
  document.querySelectorAll('[data-action="show-providers"]').forEach((button) => button.addEventListener("click", () => showView("providers")));
  document.querySelectorAll('[data-action="show-activity"]').forEach((button) => button.addEventListener("click", () => showView("activity")));
  document.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.dialogClose}`).close()));
  document.querySelectorAll('[data-action="restore"]').forEach((button) => button.addEventListener("click", openRestoreDialog));
  $("#official-direct-button").addEventListener("click", openOfficialDirectDialog);
  $("#apply-button").addEventListener("click", openApplyDialog);
  $("#refresh-official-usage").addEventListener("click", () => refreshOfficialUsage());
  $("#refresh-official-models").addEventListener("click", refreshOfficialModels);
  $("#refresh-model-health").addEventListener("click", () => refreshModelHealth({ silent: false }));
  $("#model-health-interval").addEventListener("change", updateModelHealthInterval);
  $("#refresh-request-history").addEventListener("click", refreshRequestHistory);
  $("#refresh-usage-statistics").addEventListener("click", refreshUsageStatistics);
  document.querySelectorAll("[data-monitor-period]").forEach((button) => button.addEventListener("click", selectMonitorPeriod));
  document.querySelectorAll("[data-trend-days]").forEach((button) => button.addEventListener("click", selectTrendDays));
  $("#delete-request-history").addEventListener("click", openDeleteRequestHistoryDialog);
  $("#load-older-request-history").addEventListener("click", loadOlderRequestHistory);
  $("#delete-request-history-confirm").addEventListener("change", (event) => { $("#confirm-delete-request-history").disabled = !event.target.checked; });
  $("#delete-request-history-form").addEventListener("submit", deleteRequestHistory);
  $("#check-sessions").addEventListener("click", checkSessions);
  $("#check-sessions-secondary").addEventListener("click", checkSessions);
  $("#add-provider").addEventListener("click", () => openProvider());
  $("#provider-api").addEventListener("change", syncProviderContinuationFields);
  $("#provider-responses-compatibility").addEventListener("change", syncProviderContinuationFields);
  $("#provider-network").addEventListener("change", syncProviderNetworkFields);
  $("#provider-select").addEventListener("change", () => { updateModelSuggestions(); updateModelCapability(); });
  $("#slot-reasoning-preset").addEventListener("change", updateModelCapability);
  $("#slot-model").addEventListener("input", scheduleModelCapabilityUpdate);
  $("#slot-model").addEventListener("change", () => { fillDisplayNameFromModel(); updateModelCapability(); });
  $("#choose-model").addEventListener("click", openModelPicker);
  $("#load-models").addEventListener("click", loadProviderModels);
  $("#test-model").addEventListener("click", testProviderModel);
  $("#batch-add-models").addEventListener("click", openBatchModelDialog);
  $("#batch-provider-select").addEventListener("change", () => { state.batchSelectedModels.clear(); renderBatchModelOptions(); });
  $("#batch-load-models").addEventListener("click", loadBatchProviderModels);
  $("#batch-model-filter").addEventListener("input", renderBatchModelOptions);
  $("#batch-model-form").addEventListener("submit", saveBatchModels);
  $("#model-filter").addEventListener("input", renderModelOptions);
  $("#use-typed-model").addEventListener("click", useTypedModel);
  $("#model-form").addEventListener("submit", saveSlot);
  $("#official-model-form").addEventListener("submit", saveOfficialModels);
  $("#provider-form").addEventListener("submit", saveProvider);
  $("#delete-model").addEventListener("click", deleteSlot);
  $("#delete-provider").addEventListener("click", deleteProvider);
  $("#persist-context").addEventListener("change", saveContextCachePreference);
  $("#deepseek-savings").addEventListener("change", saveDeepSeekSavingsPreference);
  $("#launch-at-login").addEventListener("change", setLaunchAtLogin);
  $("#copy-computer-use-prompt").addEventListener("click", copyComputerUseRepairPrompt);
  $("#download-computer-use-guide").addEventListener("click", downloadComputerUseRepairGuide);
  $("#check-browser-use").addEventListener("click", checkBrowserUse);
  $("#copy-browser-use-prompt").addEventListener("click", copyBrowserUseRepairPrompt);
  $("#download-browser-use-guide").addEventListener("click", downloadBrowserUseRepairGuide);
  $("#open-data-folder").addEventListener("click", openDataFolder);
  $("#restore-confirm").addEventListener("change", (event) => { $("#confirm-restore").disabled = !event.target.checked || Boolean(state.restorePreview?.codexRunning); });
  $("#official-direct-confirm").addEventListener("change", (event) => { $("#confirm-official-direct").disabled = !event.target.checked || Boolean(state.officialDirectPreview?.codexRunning); });
  $("#history-visibility-confirm").addEventListener("change", updateApplyConfirmationLabel);
  $("#apply-form").addEventListener("submit", applyRelay);
  $("#restore-form").addEventListener("submit", restoreOfficial);
  $("#official-direct-form").addEventListener("submit", switchOfficialDirect);
  $("#apply-theme-button").addEventListener("click", openThemeApplyDialog);
  $("#restore-theme-button").addEventListener("click", openThemeRestoreDialog);
  $("#theme-apply-confirm").addEventListener("change", (event) => { $("#confirm-theme-apply").disabled = !event.target.checked; });
  $("#theme-restore-confirm").addEventListener("change", (event) => { $("#confirm-theme-restore").disabled = !event.target.checked; });
  $("#theme-apply-form").addEventListener("submit", applySelectedTheme);
  $("#theme-restore-form").addEventListener("submit", restoreTheme);
}

async function refresh() {
  const initialLoad = !state.data;
  try {
    state.data = await api("/api/state");
    render();
    if (state.data.official?.usage?.status === "not_loaded" && !state.officialUsageLoading) void refreshOfficialUsage({ silent: true });
  } catch (error) {
    setSidebarStatus("Router 不可用", "error");
    if (initialLoad) renderInitialLoadFailure(error);
    toast(error.message, true);
  }
}

function render() {
  const data = state.data;
  renderConnection(data);
  renderOfficialUsage(data.official.login.signedIn, data.official.usage || { status: "not_loaded" });
  renderSlots(data);
  renderModels(data);
  renderProviders(data.providers);
  renderOverviewEvents(data.events);
  renderEvents(state.requestHistory.loaded ? state.requestHistory.items : data.events);
  renderRequestHistorySummary();
  renderSafety(data);
  renderThemes(data.themes);
  lucide.createIcons();
}

function renderThemes(themeData) {
  const themes = themeData?.themes || [];
  if (!themes.length) return;
  if (!themes.some((theme) => theme.id === state.selectedThemeId)) state.selectedThemeId = themeData.selectedThemeId || themes[0].id;
  const selected = themes.find((theme) => theme.id === state.selectedThemeId) || themes[0];
  const applied = themeData.runtime?.appliedThemeId;
  $("#theme-choices").innerHTML = themes.map((theme) => `
    <button class="theme-choice ${theme.id === selected.id ? "selected" : ""}" type="button" data-theme-id="${escapeHtml(theme.id)}" style="--theme-accent:${escapeHtml(theme.accent)}">
      <img src="${escapeHtml(theme.preview)}" alt="${escapeHtml(theme.name)}效果预览">
      <span><strong>${escapeHtml(theme.name)}</strong><small>${escapeHtml(theme.description)}</small></span>
      <i data-lucide="${theme.id === applied ? "circle-check-big" : "chevron-right"}"></i>
    </button>`).join("");
  document.querySelectorAll("[data-theme-id]").forEach((button) => button.addEventListener("click", () => selectTheme(button.dataset.themeId)));
  $("#theme-preview-image").src = selected.preview;
  $("#theme-preview-image").alt = `${selected.name}完整效果预览`;
  $("#theme-preview-title").textContent = selected.name;
  $("#theme-preview-description").textContent = selected.description;
  $("#theme-preview-kicker").textContent = "ENFP · 灵感发动机已启动";
  $("#theme-action-title").textContent = applied === selected.id ? `${selected.name}正在使用` : `应用${selected.name}`;
  $("#theme-action-copy").textContent = themeRuntimeCopy(themeData.runtime, selected, applied);
  $("#apply-theme-button span").textContent = applied === selected.id ? "重新应用" : "重启 Codex 并应用";
  $("#restore-theme-button").disabled = !themeData.enabled && !applied;
  const status = themeData.runtime?.status || "idle";
  $("#theme-runtime-status").textContent = themeRuntimeLabel(status);
  $("#theme-runtime-status").className = `state-chip ${status === "applied" ? "safe" : status === "error" ? "danger" : ""}`;
}

function themeRuntimeCopy(runtime, selected, applied) {
  if (runtime?.status === "error") return runtime.message || "主题应用失败，Codex 保持原有外观。";
  if (runtime?.status === "queued") return runtime.message || "主题已保存，正在等待 Codex 启动。";
  if (runtime?.status === "starting" || runtime?.status === "restoring") return runtime.message || "正在处理 Codex 外观。";
  if (applied === selected.id) return runtime?.message || "当前 Codex 已使用这套主题。";
  return "预览不会修改 Codex；确认应用后才会重启并切换外观。";
}

function themeRuntimeLabel(status) {
  return ({ idle: "默认外观", queued: "等待启动", starting: "正在应用", applied: "已应用", restoring: "正在恢复", error: "需要处理" })[status] || "未应用";
}

async function selectTheme(themeId) {
  state.selectedThemeId = themeId;
  renderThemes({ ...state.data.themes, selectedThemeId: themeId });
  try {
    state.data.themes = await api("/api/themes/select", "POST", { themeId });
    renderThemes(state.data.themes);
    lucide.createIcons();
  } catch (error) { toast(error.message, true); }
}

function openThemeApplyDialog() {
  const theme = state.data?.themes?.themes?.find((item) => item.id === state.selectedThemeId);
  if (!theme) return toast("请先选择一个主题。", true);
  $("#theme-apply-copy").textContent = `将关闭当前 Codex，并以“${theme.name}”重新打开。模型、项目、对话和插件不会改变。`;
  $("#theme-apply-confirm").checked = false;
  $("#confirm-theme-apply").disabled = true;
  $("#theme-apply-dialog").showModal();
}

function openThemeRestoreDialog() {
  $("#theme-restore-confirm").checked = false;
  $("#confirm-theme-restore").disabled = true;
  $("#theme-restore-dialog").showModal();
}

async function applySelectedTheme(event) {
  event.preventDefault();
  const button = $("#confirm-theme-apply");
  setButtonLoading(button, true);
  try {
    state.data.themes = await api("/api/themes/apply", "POST", { themeId: state.selectedThemeId });
    $("#theme-apply-dialog").close();
    renderThemes(state.data.themes);
    toast("主题助手已启动，正在重启并应用 Codex 外观。", false, 7000);
    void monitorThemeRuntime("apply");
  } catch (error) { toast(error.message, true, 8000); }
  finally { setButtonLoading(button, false); }
}

async function restoreTheme(event) {
  event.preventDefault();
  const button = $("#confirm-theme-restore");
  setButtonLoading(button, true);
  try {
    state.data.themes = await api("/api/themes/restore", "POST");
    $("#theme-restore-dialog").close();
    renderThemes(state.data.themes);
    toast("正在恢复 Codex 默认外观。", false, 7000);
    void monitorThemeRuntime("restore");
  } catch (error) { toast(error.message, true, 8000); }
  finally { setButtonLoading(button, false); }
}

async function monitorThemeRuntime(operation) {
  const token = ++state.themePollToken;
  const deadline = Date.now() + 40_000;
  while (token === state.themePollToken && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      const themes = await api("/api/themes");
      if (token !== state.themePollToken) return;
      state.data.themes = themes;
      renderThemes(themes);
      lucide.createIcons();
      const status = themes.runtime?.status;
      if (status === "error") {
        toast(themes.runtime?.message || "主题应用失败，Codex 保持原有外观。", true, 10000);
        return;
      }
      if (operation === "apply" && status === "applied") {
        toast(themes.runtime?.message || "主题已应用。", false, 7000);
        return;
      }
      if (operation === "restore" && status === "idle") {
        toast(themes.runtime?.message || "已恢复 Codex 默认外观。", false, 7000);
        return;
      }
    } catch (error) {
      if (token === state.themePollToken) toast(error.message, true, 8000);
      return;
    }
  }
  if (token === state.themePollToken) toast("主题处理仍未完成，请查看当前状态后重试。", true, 9000);
}

function renderConnection(data) {
  const modeIcon = $("#mode-icon");
  modeIcon.classList.remove("loading");
  modeIcon.innerHTML = '<i data-lucide="route"></i>';
  const active = data.router.active;
  const external = data.connection.externalTakeover;
  const repairEligible = data.connection.repairEligible;
  const signedIn = data.official.login.signedIn;
  const configuredThirdParty = data.thirdPartySlots.length;
  const publishedCount = data.publication?.verified ? data.publication.modelCount : 0;
  const title = active
    ? "Relay 模式正在服务 Codex"
    : repairEligible
      ? "Relay 连接需要修复"
      : external
        ? "Codex 已由其他配置接管"
        : "Relay 已就绪，尚未应用到 Codex";
  const copy = active
    ? `已向 Codex 发布 ${publishedCount} 个模型。官方请求直通官方服务，第三方请求按各自供应商配置转发。`
    : repairEligible
      ? "Relay 管理标记仍在，但连接配置发生了变化。确认后可只修复 Relay 管理的设置。"
    : external
      ? "当前配置可能来自 CC Switch、官方直连或手动设置。Codex Relay 不会自动覆盖它。"
      : configuredThirdParty
        ? `已保存 ${configuredThirdParty} 个第三方模型，但尚未发布到 Codex。点击“启用 Relay”，完成后重新打开 Codex。`
        : "先配置第三方模型，再启用 Relay。程序会备份当前 Codex 状态并完成安全检查。";

  $("#relay-control-title").textContent = title;
  $("#relay-control-copy").textContent = copy;
  $("#mode-badge").textContent = active ? "已启用" : repairEligible ? "需要修复" : external ? "外部接管" : "未启用";
  $("#mode-badge").className = `mode-badge ${active ? "ready" : repairEligible ? "warning" : external ? "external" : ""}`;
  $("#apply-button span").textContent = active ? "更新 Relay" : repairEligible ? "修复 Relay" : external ? "重新启用 Relay" : "启用 Relay";
  $("#apply-button").disabled = false;
  $("#restore-top-button").disabled = !data.restorePreview?.available;
  $("#restore-button").disabled = !data.restorePreview?.available;
  $("#official-direct-button").disabled = !data.restorePreview?.available;

  $("#login-state").textContent = signedIn ? "已登录" : data.official.login.authType === "api_key" ? "API Key 模式" : "未登录";
  $("#login-state").className = `state-chip ${signedIn ? "safe" : ""}`;
  const officialRoutes = data.routes.filter((route) => route.kind === "official");
  $("#login-summary").textContent = signedIn
    ? `${officialRoutes.length} 个已选官方模型已加入模型栏。官方额度与插件状态请在 Codex 官方账号页面查看。`
    : `当前可使用 ${configuredThirdParty} 个第三方模型；稍后登录官方账号后会自动补上两个官方槽位。`;
  $("#official-capacity").textContent = `${officialRoutes.length} / 2`;
  $("#refresh-official-models").disabled = !signedIn;
  $("#official-models-summary").textContent = data.official.modelsFetchedAt
    ? `已读取 ${data.official.availableModels.length} 个当前账号可用模型，${new Date(data.official.modelsFetchedAt).toLocaleString("zh-CN")}`
    : signedIn ? "当前使用兼容默认选择；刷新后可从账号真实可用模型中选择两个" : "登录后可读取当前账号真实可用模型";
  $("#third-party-capacity").textContent = `${configuredThirdParty} / ${slotIds.length}`;
  $("#batch-add-models").disabled = configuredThirdParty >= slotIds.length;
  setSidebarStatus(active ? "Relay 正在运行" : "尚未接管 Codex", active ? "ready" : "");

  $("#official-usage").hidden = !signedIn;
  $("#official-plan").textContent = signedIn ? "官方账号" : "未登录";
  $("#official-five-hour").textContent = "由官方管理";
  $("#official-weekly").textContent = "由官方管理";
}

function renderOfficialUsage(signedIn, usage) {
  $("#official-usage").hidden = !signedIn;
  $("#refresh-official-usage").disabled = !signedIn;
  if (!signedIn) return;

  const available = usage.status === "available";
  $("#login-summary").textContent = available ? "官方账号套餐与额度已读取。" : "正在读取当前官方账号的套餐与额度。";
  $("#official-plan").textContent = available ? officialPlanLabel(usage.planType) : officialUsageStatusLabel(usage.status);
  $("#official-usage-updated").textContent = available && usage.fetchedAt ? `更新 ${formatOfficialTime(usage.fetchedAt)}` : officialUsageDetailLabel(usage.status);
  renderOfficialUsageWindow("official-five-hour", usage.fiveHour, available, usage.status);
  renderOfficialUsageWindow("official-weekly", usage.weekly, available, usage.status);
}

function renderOfficialUsageWindow(id, window, available, status) {
  const value = Number.isFinite(window?.usedPercent) ? window.usedPercent : null;
  const meter = $(`#${id}-meter`);
  const label = $(`#${id}`);
  const reset = $(`#${id}-reset`);
  label.textContent = value === null ? available ? "官方未返回" : officialUsageStatusLabel(status) : `已用 ${value}%`;
  meter.style.setProperty("--usage-percent", `${value ?? 0}%`);
  if (value === null) {
    meter.removeAttribute("aria-valuenow");
    meter.setAttribute("aria-valuetext", label.textContent);
  } else {
    meter.setAttribute("aria-valuenow", String(value));
    meter.setAttribute("aria-valuetext", `已用 ${value}%`);
  }
  reset.textContent = value === null ? available ? "" : officialUsageDetailLabel(status) : window.resetsAt ? `重置 ${formatOfficialTime(window.resetsAt)}` : "重置时间未返回";
}

function officialPlanLabel(planType) {
  return ({ free: "Free", plus: "Plus", pro: "Pro", pro5x: "Pro (5x)", pro20x: "Pro (20x)" })[planType] || "套餐未返回";
}

function officialUsageStatusLabel(status) {
  return ({ not_loaded: "读取中", login_expired: "登录已失效", rate_limited: "刷新受限", unavailable: "暂不可读取" })[status] || "读取中";
}

function officialUsageDetailLabel(status) {
  return ({ not_loaded: "正在读取官方额度", login_expired: "请在 Codex 重新登录", rate_limited: "请稍后刷新", unavailable: "可稍后再次刷新" })[status] || "";
}

function formatOfficialTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderSlots(data) {
  const officialRoutes = data.routes.filter((route) => route.kind === "official");
  const thirdPartyById = new Map(data.thirdPartySlots.map((slot) => [slot.id, slot]));
  const tiles = [0, 1].map((index) => {
    const route = officialRoutes[index];
    return route
      ? slotTile("官方", route.displayName, "shield-check", "official")
      : slotTile("官方", data.official.login.signedIn ? "未选择" : "未登录", data.official.login.signedIn ? "plus" : "lock-keyhole", "empty");
  });
  for (const [index, id] of slotIds.entries()) {
    const slot = thirdPartyById.get(id);
    if (slot) tiles.push(slotTile(`第三方 ${index + 1}`, slot.displayName, "route", ""));
  }
  const remaining = slotIds.length - thirdPartyById.size;
  if (remaining > 0) tiles.push(slotTile("第三方", `还可添加 ${remaining} 个`, "plus", "empty"));
  $("#slot-rail").innerHTML = tiles.join("");
  $("#slot-summary").textContent = `${officialRoutes.length} 个官方模型，${data.thirdPartySlots.length} 个第三方模型`;
}

function slotTile(kind, name, icon, className) {
  return `<div class="slot-tile ${className}"><span class="slot-kind">${escapeHtml(kind)}<i data-lucide="${icon}"></i></span><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong></div>`;
}

function renderModels(data) {
  const official = data.routes.filter((route) => route.kind === "official");
  $("#official-list").innerHTML = [0, 1].map((index) => {
    const route = official[index];
    const name = route?.displayName || (index === 0 ? "官方模型 1" : "官方模型 2");
    const signedIn = data.official.login.signedIn;
    const status = route ? "已选择" : signedIn ? "未选择" : "未登录";
    return `<div class="model-row"><span class="row-icon official"><i data-lucide="shield-check"></i></span><span class="row-title"><strong>${escapeHtml(name)}</strong><span>官方位置 ${index + 1} · 官方账号额度</span></span><span class="row-detail"><strong>${escapeHtml(route?.upstreamModel || (signedIn ? "请选择模型" : "登录后可选"))}</strong><span>Official Codex</span></span><span class="row-state ${route ? "ready" : "missing"}">${status}</span><span class="model-health-state" title="官方模型由 Codex 官方通道管理">官方管理</span><button class="button quiet" data-edit-official="${index}"><i data-lucide="list-restart"></i><span>选择</span></button></div>`;
  }).join("");
  document.querySelectorAll("[data-edit-official]").forEach((button) => button.addEventListener("click", openOfficialModelDialog));

  const byId = new Map(data.thirdPartySlots.map((slot) => [slot.id, slot]));
  const configuredRows = slotIds.filter((id) => byId.has(id)).map((id) => {
    const index = slotIds.indexOf(id);
    const slot = byId.get(id);
    const provider = data.providers.find((item) => item.id === slot.providerId);
    const ready = Boolean(provider?.hasApiKey);
    const health = modelHealthPresentation(data.modelHealth?.entries?.[id], data.modelHealth?.goodThresholdMs);
    return `<div class="model-row"><span class="row-icon"><i data-lucide="route"></i></span><span class="row-title"><strong>${escapeHtml(slot.displayName)}</strong><span>槽位 ${index + 1}</span></span><span class="row-detail"><strong>${escapeHtml(slot.upstreamModel)}</strong><span>${escapeHtml(provider?.name || "未选择供应商")}</span></span><span class="row-state ${ready ? "ready" : "missing"}">${ready ? "已配置" : "缺少 Key"}</span><span class="model-health-state ${health.tone}" title="${escapeHtml(health.title)}">${escapeHtml(health.label)}</span><button class="button quiet" data-edit-slot="${id}"><i data-lucide="pencil"></i><span>编辑</span></button></div>`;
  });
  const nextId = slotIds.find((id) => !byId.has(id));
  if (nextId) {
    const index = slotIds.indexOf(nextId);
    configuredRows.push(`<div class="model-row add-model-row"><span class="row-icon"><i data-lucide="plus"></i></span><span class="row-title"><strong>添加第三方模型</strong><span>还有 ${slotIds.length - byId.size} 个空闲槽位</span></span><span class="row-detail"><strong>单独添加或批量添加</strong><span>供应商资料和 Key 可重复使用</span></span><span class="row-state missing">空闲</span><span class="model-health-state">--</span><button class="button quiet" data-edit-slot="${nextId}"><i data-lucide="plus"></i><span>添加</span></button></div>`);
  }
  $("#third-party-list").innerHTML = configuredRows.join("");
  document.querySelectorAll("[data-edit-slot]").forEach((button) => button.addEventListener("click", () => openSlot(button.dataset.editSlot)));
  $("#refresh-model-health").disabled = !data.thirdPartySlots.length || Boolean(data.modelHealth?.running);
}

function modelHealthPresentation(entry, threshold = 3_000) {
  if (!entry || entry.status === "unknown") return { label: "待检测", tone: "", title: "尚未检测连接" };
  if (entry.status === "checking") return { label: "检测中", tone: "checking", title: "正在检测连接" };
  const source = ({ recent_request: "最近真实请求", minimal_probe: "轻量请求", manual_probe: "手动测试", configuration: "配置检查" })[entry.source] || "连接检测";
  const details = [source];
  if (entry.checkedAt) details.push(formatTime(entry.checkedAt));
  if (entry.httpStatus) details.push(`HTTP ${entry.httpStatus}`);
  if (entry.tokenTotal !== null && entry.tokenTotal !== undefined) details.push(`Token ${formatNumber(entry.tokenTotal)}`);
  if (entry.message) details.push(entry.message);
  if (entry.status !== "available") return { label: "不可用", tone: "bad", title: details.join(" · ") };
  const duration = Number(entry.durationMs);
  if (!Number.isFinite(duration)) return { label: "可用", tone: "good", title: details.join(" · ") };
  return { label: `${formatNumber(duration)} ms`, tone: duration <= Number(threshold || 3_000) ? "good" : "slow", title: details.join(" · ") };
}

function renderProviders(providers) {
  $("#provider-list").innerHTML = providers.length ? providers.map((provider) => {
    const used = state.data.thirdPartySlots.filter((slot) => slot.providerId === provider.id).length;
    const balance = provider.balanceSnapshot;
    const compact = providerCompactPresentation(provider);
    const amount = balance ? formatBalance(balance) : provider.balanceProbe?.status === "unsupported" ? "无法自动探测" : "尚未探测";
    const balanceDetail = balance?.checkedAt
      ? `更新于 ${formatTime(balance.checkedAt)}`
      : provider.balanceProbe?.checkedAt
        ? `已尝试 ${formatTime(provider.balanceProbe.checkedAt)}`
        : "余额";
    const compactDetail = provider.apiType === "responses"
      ? compact.verifiedAt ? `最近验证 ${formatTime(compact.verifiedAt)}` : "尚未验证"
      : "使用便携压缩";
    const inFlight = provider.inFlight || { current: 0, cancelling: 0 };
    return `<div class="provider-row"><span class="row-icon"><i data-lucide="server"></i></span><span class="row-title"><strong>${escapeHtml(provider.name)}</strong><span class="provider-protocol">${provider.apiType === "responses" ? "Responses" : "Chat Completions"}<span class="compact-chip ${compact.tone}">${escapeHtml(compact.label)}</span></span></span><span class="row-detail"><strong title="${escapeHtml(provider.baseUrl)}">${escapeHtml(provider.baseUrl)}</strong><span>${used} 个模型使用 · ${escapeHtml(providerNetworkLabel(provider))} · ${escapeHtml(compactDetail)} · <span data-provider-inflight="${escapeHtml(provider.id)}" title="${escapeHtml(thirdPartyInFlightTitle(inFlight))}">${escapeHtml(thirdPartyInFlightLabel(inFlight))}</span></span></span><span class="row-state provider-key ${provider.hasApiKey ? "ready" : "missing"}">${provider.hasApiKey ? "Key 已保存" : "缺少 Key"}</span><span class="provider-balance-cell"><span class="provider-balance-copy"><strong class="${balance ? "ready" : ""}">${escapeHtml(amount)}</strong><small>${escapeHtml(balanceDetail)}</small></span><button class="icon-button balance-refresh" type="button" data-refresh-balance="${escapeHtml(provider.id)}" data-loading-label="正在刷新余额" aria-label="刷新 ${escapeHtml(provider.name)} 的余额" title="刷新余额" ${provider.hasApiKey ? "" : "disabled"}><i data-lucide="refresh-cw"></i></button></span><button class="button quiet provider-edit" data-edit-provider="${escapeHtml(provider.id)}"><i data-lucide="pencil"></i><span>编辑</span></button></div>`;
  }).join("") : '<div class="empty-state">尚未添加供应商。先添加供应商，再配置第三方模型。</div>';
  document.querySelectorAll("[data-edit-provider]").forEach((button) => button.addEventListener("click", () => openProvider(providers.find((provider) => provider.id === button.dataset.editProvider))));
  document.querySelectorAll("[data-refresh-balance]").forEach((button) => button.addEventListener("click", () => refreshProviderBalance(button)));
}

function providerNetworkLabel(provider) {
  if (provider.networkMode === "windows") return "Windows 代理";
  if (provider.networkMode === "custom") return "自定义代理";
  return "直连";
}

function providerCompactPresentation(provider) {
  const status = provider.compactCapability?.status || (provider.apiType === "responses" ? "automatic" : "not_applicable");
  const presentations = {
    automatic: { label: "自动检测", tone: "neutral" },
    supported: { label: "已支持", tone: "ready" },
    unsupported: { label: "不支持", tone: "warning" },
    temporary_failure: { label: "临时不可用", tone: "danger" },
    not_applicable: { label: "便携压缩", tone: "portable" },
  };
  return { ...(presentations[status] || presentations.automatic), verifiedAt: provider.compactCapability?.verifiedAt || null };
}

function formatBalance(balance) {
  const value = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(balance.amount);
  return `${value}${balance.currency ? ` ${balance.currency}` : ""}`;
}

async function refreshProviderBalance(button) {
  const providerId = button.dataset.refreshBalance;
  setButtonLoading(button, true);
  try {
    const result = await api(`/api/providers/${encodeURIComponent(providerId)}/balance`, "POST");
    await refresh();
    toast(result.detected ? `余额已更新：${formatBalance(result.balance)}。` : "该供应商暂时无法自动探测余额。", !result.detected);
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

function renderEvents(events) {
  renderContextAdvisory(events);
  $("#event-list").innerHTML = events.length ? events.map((event) => `<div class="activity-row"><time>${formatTime(event.at)}</time><span class="event-name"><span class="event-heading"><strong>${escapeHtml(event.route.displayName)}</strong>${compactEventBadge(event)}</span><span>${escapeHtml(event.route.providerName || "Official Codex")} / ${escapeHtml(event.route.upstreamModel)}</span><small class="request-meta ${contextPressureClass(event)}" title="${escapeHtml(requestDetail(event))}">${escapeHtml(`${streamLabel(event.stream)}${cachePrefixLabel(event.diagnostics?.cache)}${deepSeekSavingsLabel(event.diagnostics?.savings)}${contextPressureLabel(event)}`)}</small></span><span class="channel-badge ${event.route.kind === "official" ? "official" : ""}">${event.route.kind === "official" ? "官方" : "第三方"}</span><span class="status-code ${event.ok ? "ok" : "failed"}">${event.status}</span><span class="duration">${event.durationMs} ms</span><span class="reasoning-usage" title="${escapeHtml(reasoningDetail(event.reasoning))}">${escapeHtml(reasoningLabel(event.reasoning))}</span><span class="token-usage ${contextPressureClass(event)}" title="${escapeHtml(usageDetail(event))}">${detailedUsageLabel(event.usage)}</span></div>`).join("") : '<div class="empty-state">暂无请求记录。Token 只有在上游返回 usage 时才会显示。</div>';
}

function compactEventBadge(event) {
  const diagnostics = event.diagnostics || {};
  if (event.contextMode !== "compact" && !diagnostics.isCompaction) return "";
  let presentation;
  if (event.route.kind === "official" || diagnostics.compactionStrategy === "native_compact") presentation = { label: "原生 Compact", tone: "ready" };
  else if (diagnostics.circuitOpen) presentation = { label: "临时熔断", tone: "danger" };
  else if (diagnostics.compactionStrategy === "model_summary") presentation = { label: "兼容摘要", tone: "warning" };
  else presentation = { label: "便携压缩", tone: "portable" };
  return `<span class="compact-chip ${presentation.tone}">${presentation.label}</span>`;
}

function renderRequestHistorySummary() {
  const history = state.requestHistory;
  const total = history.loaded ? history.total : state.data?.requestHistory?.total || 0;
  const retainedLimit = history.retainedLimit || state.data?.requestHistory?.retainedLimit || 10_000;
  const visible = history.loaded ? history.items.length : Math.min(total, state.data?.events?.length || 0);
  $("#request-history-summary").textContent = total ? `已显示 ${formatNumber(visible)} 条，共保存 ${formatNumber(total)} 条` : "尚无请求记录";
  $("#delete-request-history").disabled = total === 0;
  const more = $("#load-older-request-history");
  more.hidden = !history.loaded || !history.hasMore;
  more.setAttribute("aria-label", `加载更早记录，最多保留最近 ${formatNumber(retainedLimit)} 条`);
}

async function refreshUsageStatistics(event) {
  const button = event?.currentTarget || $("#refresh-usage-statistics");
  setButtonLoading(button, true);
  try {
    state.usageStatistics.data = await api("/api/usage-statistics");
    state.usageStatistics.loaded = true;
    state.usageStatistics.syncError = null;
    renderUsageStatistics();
    lucide.createIcons();
  } catch (error) {
    state.usageStatistics.syncError = error.message;
    if (state.usageStatistics.data) renderUsageStatistics();
    else renderUsageStatisticsError(error.message);
    lucide.createIcons();
    toast(error.message, true);
  }
  finally { setButtonLoading(button, false); }
}

function renderUsageStatistics() {
  const data = state.usageStatistics.data;
  if (!data) return;
  const today = data.overall?.today || emptyUsageView();
  const total = data.overall?.total || emptyUsageView();
  $("#monitoring-period").textContent = data.trackingStartedAt
    ? `长期账本自 ${formatMonitorDate(data.trackingStartedAt)} 累计${data.updatedAt ? ` · 更新于 ${formatMonitorDate(data.updatedAt)}` : ""}`
    : "长期账本将在首次请求后开始累计";
  $("#monitoring-timezone").textContent = `${data.timezone || "本机时区"} ${formatUtcOffset(data.utcOffsetMinutes)} · 今日 ${data.dayKey || ""}`.trim();
  $("#monitor-today-requests").textContent = formatNumber(today.requestCount);
  $("#monitor-today-request-detail").textContent = today.requestCount
    ? `成功 ${formatNumber(today.successCount)} / 失败 ${formatNumber(today.failureCount)}`
    : "今日尚无请求";
  $("#monitor-today-token").textContent = usageTokenLabel(today);
  $("#monitor-today-token").title = usageTokenTitle(today);
  $("#monitor-today-token-detail").textContent = usageTokenDetail(today);
  $("#monitor-total-token").textContent = usageTokenLabel(total);
  $("#monitor-total-token").title = usageTokenTitle(total);
  $("#monitor-total-token-detail").textContent = usageTokenDetail(total);
  $("#monitor-cache-hit").textContent = percentageLabel(total.cacheHitRate);
  $("#monitor-cache-hit-detail").textContent = cacheSummaryDetail(today, total);
  renderUsageQuality(total, data.synchronization || {});
  renderUsageTrend(data.trend?.items || []);
  renderProviderUsage(data.providers || []);
  renderModelDistribution(data.models || []);
}

function renderUsageStatisticsError(message) {
  $("#monitoring-period").textContent = "监控数据暂未读取";
  $("#monitoring-timezone").textContent = "请使用标题栏的刷新按钮重试";
  $("#monitor-quality").classList.add("error");
  $("#monitor-sync-status").innerHTML = `<i data-lucide="triangle-alert"></i><span>统计暂未同步：${escapeHtml(message)}</span>`;
  lucide.createIcons();
}

function renderUsageQuality(total, synchronization) {
  const usageText = total.requestCount
    ? `Token 回传 ${formatNumber(total.usageCount)} / ${formatNumber(total.requestCount)}，完整率 ${coverageLabel(total.usageCount, total.requestCount)}`
    : "Token 回传将在首个请求后显示";
  const cacheText = total.requestCount
    ? `缓存明细 ${formatNumber(total.cacheReportedCount)} / ${formatNumber(total.requestCount)}，覆盖率 ${coverageLabel(total.cacheReportedCount, total.requestCount)}`
    : "缓存明细将在上游返回后显示";
  const hasError = Boolean(state.usageStatistics.syncError || synchronization.status === "error");
  const error = state.usageStatistics.syncError || synchronization.lastError;
  $("#monitor-quality").classList.toggle("error", hasError);
  $("#monitor-usage-coverage").textContent = usageText;
  $("#monitor-cache-coverage").textContent = cacheText;
  $("#monitor-sync-status").innerHTML = hasError
    ? `<i data-lucide="triangle-alert"></i><span>统计暂未同步${error ? `：${escapeHtml(error)}` : ""}</span>`
    : `<i data-lucide="circle-check"></i><span>账本已同步${synchronization.checkedAt ? ` · ${formatMonitorTime(synchronization.checkedAt)}` : ""}</span>`;
}

function renderUsageTrend(items) {
  const days = state.usageStatistics.trendDays;
  document.querySelectorAll("[data-trend-days]").forEach((button) => {
    const active = Number(button.dataset.trendDays) === days;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const rows = items.slice(-days);
  const tokenTotal = rows.reduce((sum, row) => sum + (row.usageCount ? row.totalTokens : 0), 0);
  const requestTotal = rows.reduce((sum, row) => sum + row.requestCount, 0);
  const maxTokens = Math.max(1, ...rows.map((row) => row.usageCount ? row.totalTokens : 0));
  $("#monitor-trend-summary").textContent = `${days} 天内 ${formatNumber(requestTotal)} 次请求 · ${tokenTotal ? `${formatTokenNumber(tokenTotal)} Token` : requestTotal ? "Token 未返回" : "暂无请求"}`;
  const chart = $("#monitor-trend-chart");
  chart.setAttribute("aria-label", `近 ${days} 天使用趋势，共 ${formatNumber(requestTotal)} 次请求，${tokenTotal ? `${formatNumber(tokenTotal)} Token` : "暂无可统计 Token"}`);
  chart.style.gridTemplateColumns = `repeat(${Math.max(1, rows.length)}, minmax(0, 1fr))`;
  chart.innerHTML = rows.map((row) => {
    const hasUsage = row.usageCount > 0;
    const height = hasUsage ? Math.max(5, Math.round(row.totalTokens / maxTokens * 122)) : 2;
    const label = `${formatTrendDate(row.dayKey)}：${formatNumber(row.requestCount)} 次请求，${hasUsage ? `${formatNumber(row.totalTokens)} Token` : row.requestCount ? "Token 未返回" : "无请求"}`;
    return `<div class="monitor-trend-day" title="${escapeHtml(label)}"><div class="monitor-trend-bar ${hasUsage ? "" : "unknown"}" data-height="${height}"></div><small>${escapeHtml(formatTrendDate(row.dayKey))}</small></div>`;
  }).join("");
  chart.querySelectorAll(".monitor-trend-bar").forEach((bar) => { bar.style.height = `${Number(bar.dataset.height) || 2}px`; });
}

function renderProviderUsage(providers) {
  const sorted = [...providers].sort((left, right) => {
    if (left.routeKind === "official" && right.routeKind !== "official") return -1;
    if (right.routeKind === "official" && left.routeKind !== "official") return 1;
    return (right.total?.totalTokens || 0) - (left.total?.totalTokens || 0)
      || (right.total?.requestCount || 0) - (left.total?.requestCount || 0)
      || String(left.providerName || "").localeCompare(String(right.providerName || ""), "zh-CN");
  });
  $("#monitor-provider-list").innerHTML = sorted.length ? sorted.map((provider) => {
    const today = provider.today || emptyUsageView();
    const total = provider.total || emptyUsageView();
    const providerMeta = provider.routeKind === "official"
      ? "官方认证"
      : `${apiTypeLabel(provider.apiType)}${provider.deleted ? " · 已删除，保留历史" : ""}`;
    return `<div class="monitor-provider-row">
      <div class="monitor-provider-identity ${provider.routeKind === "official" ? "official" : ""}">
        <span><i data-lucide="${provider.routeKind === "official" ? "badge-check" : "server"}"></i></span>
        <div><strong title="${escapeHtml(provider.providerName)}">${escapeHtml(provider.providerName)}</strong><small>${escapeHtml(providerMeta)}</small></div>
      </div>
      <div class="monitor-stat-cell" data-label="今日请求"><strong>${formatNumber(today.requestCount)}</strong><small>成功 ${formatNumber(today.successCount)} / 失败 ${formatNumber(today.failureCount)}</small></div>
      ${providerTokenCell(today, "今日")}
      ${providerTokenCell(total, "累计")}
      <div class="monitor-stat-cell cache ${total.cacheHitRate === null ? "unknown" : ""}" data-label="缓存命中率"><strong>${percentageLabel(today.cacheHitRate)}</strong><small>累计 ${percentageLabel(total.cacheHitRate)} · 覆盖 ${coverageLabel(total.cacheReportedCount, total.requestCount)}</small></div>
    </div>`;
  }).join("") : '<div class="monitor-model-empty">暂无供应商统计。</div>';
}

function renderModelDistribution(models) {
  const period = state.usageStatistics.modelPeriod;
  document.querySelectorAll("[data-monitor-period]").forEach((button) => {
    const active = button.dataset.monitorPeriod === period;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const colors = ["oklch(0.58 0.18 255)", "oklch(0.62 0.15 151)", "oklch(0.68 0.16 76)", "oklch(0.58 0.16 24)", "oklch(0.56 0.13 195)", "oklch(0.55 0.14 325)", "oklch(0.62 0.13 110)", "oklch(0.52 0.11 285)"];
  const rows = models
    .map((model) => ({ ...model, statistics: model[period] || emptyUsageView() }))
    .filter((model) => model.statistics.requestCount > 0)
    .sort((left, right) => right.statistics.totalTokens - left.statistics.totalTokens
      || right.statistics.requestCount - left.statistics.requestCount
      || String(left.upstreamModel || "").localeCompare(String(right.upstreamModel || "")))
    .map((model, index) => ({ ...model, color: colors[index % colors.length] }));
  const tokenTotal = rows.reduce((sum, row) => sum + (row.statistics.usageCount ? row.statistics.totalTokens : 0), 0);
  const donut = $("#monitor-token-donut");
  const tokenRows = rows.filter((row) => row.statistics.usageCount > 0 && row.statistics.totalTokens > 0);
  let cursor = 0;
  const segments = tokenRows.map((row) => {
    const start = cursor;
    cursor += row.statistics.totalTokens / tokenTotal * 100;
    return `${row.color} ${start.toFixed(3)}% ${cursor.toFixed(3)}%`;
  });
  donut.classList.toggle("empty", tokenTotal === 0);
  if (segments.length) donut.style.setProperty("--donut-fill", `conic-gradient(${segments.join(", ")})`);
  else donut.style.removeProperty("--donut-fill");
  donut.setAttribute("aria-label", tokenTotal ? `${period === "today" ? "今日" : "累计"}模型 Token 分布，总计 ${formatNumber(tokenTotal)}` : "暂无模型 Token 数据");
  $("#monitor-donut-total").textContent = tokenTotal ? formatTokenNumber(tokenTotal) : "0";
  $("#monitor-donut-total").title = tokenTotal ? `${formatNumber(tokenTotal)} Token` : "";
  $("#monitor-donut-label").textContent = `${period === "today" ? "今日" : "累计"} Token`;
  $("#monitor-model-list").innerHTML = rows.length ? rows.map((model) => {
    const statistics = model.statistics;
    const hasUsage = statistics.usageCount > 0;
    const share = hasUsage && tokenTotal ? statistics.totalTokens / tokenTotal * 100 : null;
    return `<div class="monitor-model-row">
      <div class="monitor-model-name"><span class="monitor-swatch" style="--swatch:${model.color}"></span><span title="${escapeHtml(model.upstreamModel)}">${escapeHtml(model.upstreamModel)}</span></div>
      <span class="monitor-model-value" data-label="请求">${formatNumber(statistics.requestCount)}</span>
      <span class="monitor-model-value" data-label="Token" title="${hasUsage ? `${formatNumber(statistics.totalTokens)} Token` : "上游未返回 usage"}">${hasUsage ? formatTokenNumber(statistics.totalTokens) : "未返回"}</span>
      <span class="monitor-model-value" data-label="占比">${share === null ? "—" : `${formatPercentage(share)}%`}</span>
    </div>`;
  }).join("") : '<div class="monitor-model-empty">该时间范围内暂无模型请求。</div>';
}

function selectMonitorPeriod(event) {
  const period = event.currentTarget.dataset.monitorPeriod;
  if (period !== "today" && period !== "total") return;
  state.usageStatistics.modelPeriod = period;
  if (state.usageStatistics.data) renderModelDistribution(state.usageStatistics.data.models || []);
}

function selectTrendDays(event) {
  const days = Number(event.currentTarget.dataset.trendDays);
  if (days !== 7 && days !== 30) return;
  state.usageStatistics.trendDays = days;
  if (state.usageStatistics.data) renderUsageTrend(state.usageStatistics.data.trend?.items || []);
}

function providerTokenCell(statistics, label) {
  const unknown = statistics.requestCount > 0 && statistics.usageCount === 0;
  return `<div class="monitor-stat-cell ${unknown ? "unknown" : ""}" data-label="${label} Token"><strong title="${escapeHtml(usageTokenTitle(statistics))}">${usageTokenLabel(statistics)}</strong><small>${escapeHtml(usageTokenCellDetail(statistics, label))}</small></div>`;
}

function usageTokenLabel(statistics) {
  if (!statistics.requestCount) return "0";
  if (!statistics.usageCount) return "未返回";
  return formatTokenNumber(statistics.totalTokens);
}

function usageTokenTitle(statistics) {
  if (!statistics.requestCount) return "暂无请求";
  if (!statistics.usageCount) return "上游未返回 usage，无法统计 Token";
  return `${formatNumber(statistics.totalTokens)} Token；输入 ${formatNumber(statistics.inputTokens)}；输出 ${formatNumber(statistics.outputTokens)}`;
}

function usageTokenDetail(statistics) {
  if (!statistics.requestCount) return "暂无上游用量";
  if (!statistics.usageCount) return "上游未返回 usage";
  const coverage = coverageLabel(statistics.usageCount, statistics.requestCount);
  return `输入 ${formatTokenNumber(statistics.inputTokens)} / 输出 ${formatTokenNumber(statistics.outputTokens)} · 覆盖 ${coverage}`;
}

function usageTokenCellDetail(statistics, label) {
  if (!statistics.requestCount) return `${label}无请求`;
  if (!statistics.usageCount) return "Token 无法统计";
  return `输入 ${formatTokenNumber(statistics.inputTokens)} / 输出 ${formatTokenNumber(statistics.outputTokens)} · ${coverageLabel(statistics.usageCount, statistics.requestCount)}`;
}

function cacheSummaryDetail(today, total) {
  if (!total.requestCount) return "尚无可统计请求";
  if (total.cacheHitRate === null) return "上游未返回缓存明细";
  return `累计加权 · 今日 ${percentageLabel(today.cacheHitRate)} · 覆盖 ${coverageLabel(total.cacheReportedCount, total.requestCount)}`;
}

function percentageLabel(value) { return value === null || value === undefined ? "未返回" : `${formatPercentage(value)}%`; }
function formatPercentage(value) { return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(Number(value) || 0); }
function coverageLabel(part, total) { return total ? `${formatPercentage(part / total * 100)}%` : "—"; }
function formatTokenNumber(value) {
  const number = Number(value) || 0;
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  const unit = units.find(([threshold]) => Math.abs(number) >= threshold);
  if (!unit) return formatNumber(number);
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(number / unit[0])}${unit[1]}`;
}
function apiTypeLabel(value) { return ({ responses: "Responses", chat_completions: "Chat Completions" })[value] || "历史供应商"; }
function emptyUsageView() { return { requestCount: 0, successCount: 0, failureCount: 0, usageCount: 0, cacheReportedCount: 0, cacheHitRate: null, inputTokens: 0, outputTokens: 0, totalTokens: 0 }; }
function formatMonitorDate(value) { return new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); }
function formatMonitorTime(value) { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }); }
function formatTrendDate(value) { const [, month, day] = String(value || "").match(/^\d{4}-(\d{2})-(\d{2})$/) || []; return month && day ? `${Number(month)}/${Number(day)}` : "—"; }
function formatUtcOffset(value) { const minutes = Number(value); if (!Number.isFinite(minutes)) return ""; const sign = minutes >= 0 ? "+" : "-"; const absolute = Math.abs(minutes); return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`; }

async function refreshRequestHistory(event) {
  const button = event?.currentTarget || $("#refresh-request-history");
  setButtonLoading(button, true);
  try {
    const result = await api("/api/request-history?limit=100");
    state.requestHistory = { loaded: true, items: result.items || [], total: result.total || 0, hasMore: Boolean(result.hasMore), nextBeforeId: result.nextBeforeId || null, retainedLimit: result.retainedLimit || 10_000 };
    if (state.data) {
      state.data.events = state.requestHistory.items.slice(0, 12);
      state.data.requestHistory = { total: state.requestHistory.total, retainedLimit: state.requestHistory.retainedLimit };
    }
    renderOverviewEvents(state.data?.events || []);
    renderEvents(state.requestHistory.items);
    renderRequestHistorySummary();
    lucide.createIcons();
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function loadOlderRequestHistory(event) {
  if (!state.requestHistory.hasMore || !state.requestHistory.nextBeforeId) return;
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    const result = await api(`/api/request-history?limit=100&before=${encodeURIComponent(state.requestHistory.nextBeforeId)}`);
    const existing = new Set(state.requestHistory.items.map((item) => item.historyId));
    state.requestHistory.items.push(...(result.items || []).filter((item) => !existing.has(item.historyId)));
    state.requestHistory.total = result.total || state.requestHistory.total;
    state.requestHistory.hasMore = Boolean(result.hasMore);
    state.requestHistory.nextBeforeId = result.nextBeforeId || null;
    renderEvents(state.requestHistory.items);
    renderRequestHistorySummary();
    lucide.createIcons();
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

function openDeleteRequestHistoryDialog() {
  $("#delete-request-history-confirm").checked = false;
  $("#confirm-delete-request-history").disabled = true;
  $("#delete-request-history-dialog").showModal();
}

async function deleteRequestHistory(event) {
  event.preventDefault();
  const button = $("#confirm-delete-request-history");
  setButtonLoading(button, true);
  try {
    const result = await api("/api/request-history", "DELETE");
    state.requestHistory = { loaded: true, items: [], total: 0, hasMore: false, nextBeforeId: null, retainedLimit: result.retainedLimit || 10_000 };
    if (state.data) {
      state.data.events = [];
      state.data.requestHistory = { total: 0, retainedLimit: state.requestHistory.retainedLimit };
    }
    $("#delete-request-history-dialog").close();
    renderOverviewEvents([]);
    renderEvents([]);
    renderRequestHistorySummary();
    toast(`已删除 ${formatNumber(result.deleted || 0)} 条请求记录。供应商、模型、Key 和聊天均未改变。`);
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

function renderOverviewEvents(events) {
  const recent = events.slice(0, 3);
  $("#overview-event-list").innerHTML = recent.length ? recent.map((event) => `<div class="overview-event-row"><span class="overview-event-model"><strong>${escapeHtml(event.route.displayName)}</strong><small title="${escapeHtml(event.route.upstreamModel)}">${escapeHtml(formatTime(event.at))} · ${escapeHtml(event.route.upstreamModel)}</small></span><span class="channel-badge ${event.route.kind === "official" ? "official" : ""}">${event.route.kind === "official" ? "官方" : "第三方"}</span><span class="status-code ${event.ok ? "ok" : "failed"}">${event.status}</span><span class="duration">${event.durationMs} ms</span><span class="token-usage ${contextPressureClass(event)}" title="${escapeHtml(usageDetail(event))}">${detailedUsageLabel(event.usage)}</span></div>`).join("") : '<div class="empty-state">暂无请求记录。发起请求后会在这里显示最近三条。</div>';
}

function renderContextAdvisory(events) {
  const target = $("#context-advisory");
  const event = events.find((item) => item.contextPressure?.level === "high" || item.contextPressure?.cancelled)
    || events.find((item) => item.contextPressure?.level === "elevated");
  if (!event) {
    target.hidden = true;
    target.textContent = "";
    target.className = "context-advisory";
    return;
  }
  const input = event.usage?.input === null || event.usage?.input === undefined ? "请求体较大" : `本轮输入 ${formatNumber(event.usage.input)} Token`;
  const continuation = event.contextPressure?.fullContext ? "，未使用响应 ID 原生续接" : "";
  const cancelled = event.contextPressure?.cancelled ? "；请求已取消，但上游仍可能按已处理 Token 计费" : "";
  target.textContent = `${input}${continuation}${cancelled}。Relay 本轮上游请求 ${diagnosticUpstreamAttempts(event.diagnostics)} 次；长任务建议阶段性总结后新建任务。`;
  target.className = `context-advisory ${event.contextPressure?.cancelled ? "high" : event.contextPressure?.level || "elevated"}`;
  target.hidden = false;
}

function contextPressureClass(event) {
  return event?.contextPressure?.level === "high" ? "context-high" : event?.contextPressure?.level === "elevated" ? "context-elevated" : "";
}

function contextPressureLabel(event) {
  if (event?.contextPressure?.cancelled) return " · 已取消，可能仍计费";
  if (event?.contextPressure?.level === "high") return event.contextPressure.fullContext ? " · 超长完整上下文" : " · 超长上下文";
  if (event?.contextPressure?.level === "elevated") return event.contextPressure.fullContext ? " · 较长完整上下文" : " · 较长上下文";
  return "";
}

function streamLabel(stream) {
  if (!stream) return "传输方式未记录";
  if (!stream.requested) return `非流式 · 响应头 ${metricLabel(stream.headersMs)}`;
  if (!stream.streaming) return `请求流式，上游整包返回 · 响应头 ${metricLabel(stream.headersMs)}`;
  const source = stream.detectedBy === "body_sniff" ? "兼容识别 SSE" : "SSE";
  return `${source} · 首包 ${metricLabel(stream.firstChunkMs)} · ${stream.chunks ?? 0} 块`;
}

function metricLabel(value) { return Number.isFinite(Number(value)) ? `${Number(value)} ms` : "未记录"; }

function renderSafety(data) {
  $("#persist-context").checked = Boolean(data.contextCache?.persist);
  $("#deepseek-savings").checked = Boolean(data.deepSeekSavings?.enabled);
  $("#data-directory").textContent = data.paths.appDir;
  const sessions = data.snapshot?.sessions;
  $("#session-guard").textContent = sessions?.filesAvailable
    ? `启用前已记录 ${sessions.files.length} 个会话文件；已有正文受前缀校验保护。`
    : "Relay 不迁移、不覆盖 Codex 会话正文。启用时会建立文件基线。";
  $("#session-detail").textContent = sessions?.filesAvailable
    ? `当前恢复基线包含 ${sessions.files.length} 个会话文件。新增对话和归档移动不会被误报。`
    : "已有会话允许增长和归档，但不允许丢失、截断或覆盖旧正文。";
}

function showView(view) {
  state.view = view;
  const labels = {
    home: ["概览", "检查当前连接并控制 Relay 模式。"],
    providers: ["供应商", "管理第三方 API 地址、接口类型和本地加密 Key。"],
    models: ["模型", "管理两个官方位置和十个第三方模型槽位。"],
    activity: ["请求记录", "确认显示名称、实际上游、状态、耗时与 Token。"],
    safety: ["安全与恢复", "管理聊天保护、上下文缓存和完整恢复。"],
    monitoring: ["监控台", "查看所有经 Relay 转发路线的长期 Token 与缓存使用。"],
    themes: ["主题", ""],
  };
  document.querySelectorAll(".view").forEach((element) => { element.hidden = element.id !== `${view}-view`; });
  document.querySelectorAll(".nav-item").forEach((element) => element.classList.toggle("active", element.dataset.view === view));
  $("#view-title").textContent = labels[view][0];
  $("#view-description").textContent = labels[view][1];
  $("#view-description").hidden = !labels[view][1];
  $("#activity-title-actions").hidden = view !== "activity";
  $("#monitoring-title-actions").hidden = view !== "monitoring";
  $(".top-actions").hidden = view === "themes";
  if (view === "activity" && !state.requestHistory.loaded) void refreshRequestHistory();
  if (view === "monitoring" && !state.usageStatistics.loaded) void refreshUsageStatistics();
}

function storedModelHealthInterval() {
  try {
    const value = Number(localStorage.getItem(MODEL_HEALTH_INTERVAL_KEY));
    // Earlier builds treated a missing value as 30 minutes. Upgrade that
    // legacy default to off so probes stay opt-in after the next restart.
    if (value === 30) {
      localStorage.setItem(MODEL_HEALTH_INTERVAL_KEY, "0");
      return 0;
    }
    return MODEL_HEALTH_INTERVALS.has(value) ? value : 0;
  } catch { return 0; }
}

function updateModelHealthInterval(event) {
  const value = Number(event.target.value);
  state.modelHealth.intervalMinutes = MODEL_HEALTH_INTERVALS.has(value) ? value : 0;
  try { localStorage.setItem(MODEL_HEALTH_INTERVAL_KEY, String(state.modelHealth.intervalMinutes)); } catch { /* The default remains active for this session. */ }
  stopModelHealthSchedule();
  if (state.modelHealth.intervalMinutes) {
    scheduleModelHealthRefresh({ fromNow: true });
    toast(`第三方模型将每 ${state.modelHealth.intervalMinutes} 分钟自动检测一次。`);
  } else toast("已关闭第三方模型自动检测。");
}

function stopModelHealthSchedule() {
  clearTimeout(state.modelHealth.timer);
  state.modelHealth.timer = null;
  state.modelHealth.pollToken += 1;
}

function scheduleModelHealthRefresh({ fromNow = false } = {}) {
  clearTimeout(state.modelHealth.timer);
  state.modelHealth.timer = null;
  if (!state.data?.thirdPartySlots?.length || !state.modelHealth.intervalMinutes) return;
  const delay = fromNow ? state.modelHealth.intervalMinutes * 60_000 : modelHealthRefreshDelay();
  state.modelHealth.timer = setTimeout(() => void refreshModelHealth({ silent: true }), delay);
}

function startThirdPartyInFlightPolling() {
  clearInterval(state.thirdPartyInFlight.timer);
  // This is a local diagnostic read only. It never performs a provider probe.
  state.thirdPartyInFlight.timer = setInterval(() => void refreshThirdPartyInFlight(), 1_500);
}

async function refreshThirdPartyInFlight() {
  try {
    const snapshot = await api("/api/third-party-inflight");
    const byProvider = new Map((snapshot.providers || []).map((entry) => [entry.providerId, entry]));
    document.querySelectorAll("[data-provider-inflight]").forEach((element) => {
      const entry = byProvider.get(element.dataset.providerInflight);
      element.textContent = thirdPartyInFlightLabel(entry);
      element.title = thirdPartyInFlightTitle(entry);
    });
  } catch { /* The normal Router refresh remains the source of visible errors. */ }
}

function thirdPartyInFlightLabel(entry) {
  const current = Math.max(0, Number(entry?.current || 0));
  const cancelling = Math.max(0, Number(entry?.cancelling || 0));
  return cancelling ? `Relay 在途 ${current}（取消中 ${cancelling}）` : `Relay 在途 ${current}`;
}

function thirdPartyInFlightTitle(entry) {
  const current = Math.max(0, Number(entry?.current || 0));
  if (!current) return "Relay 当前没有向该供应商转发中的对话或压缩请求。";
  const parts = [`Relay 当前向该供应商转发 ${current} 个对话或压缩请求`];
  if (entry?.oldestStartedAt) parts.push(`最早开始于 ${formatTime(entry.oldestStartedAt)}`);
  if (Number(entry?.cancelling || 0)) parts.push(`${entry.cancelling} 个已收到客户端取消，正等待上游连接释放`);
  return `${parts.join("；")}。`;
}

function modelHealthRefreshDelay() {
  const intervalMs = state.modelHealth.intervalMinutes * 60_000;
  const completedAt = Date.parse(state.data.modelHealth?.completedAt || "");
  if (!Number.isFinite(completedAt)) return intervalMs;
  return Math.max(0, completedAt + intervalMs - Date.now());
}

async function refreshModelHealth({ silent = true } = {}) {
  if (state.modelHealth.refreshing || !state.data?.thirdPartySlots?.length) return;
  clearTimeout(state.modelHealth.timer);
  state.modelHealth.timer = null;
  state.modelHealth.refreshing = true;
  const button = $("#refresh-model-health");
  setButtonLoading(button, true);
  try {
    state.data.modelHealth = await api("/api/model-health/refresh", "POST");
    renderModels(state.data);
    lucide.createIcons();
    await pollModelHealth();
    if (!silent) {
      const entries = Object.values(state.data.modelHealth?.entries || {});
      const unavailable = entries.filter((entry) => entry.status === "unavailable").length;
      toast(unavailable ? `检测完成，${unavailable} 个模型当前不可用。` : "检测完成，第三方模型连接正常。", unavailable > 0);
    }
  } catch (error) {
    if (!silent) toast(error.message, true);
  } finally {
    state.modelHealth.refreshing = false;
    setButtonLoading(button, false);
    scheduleModelHealthRefresh();
  }
}

async function pollModelHealth() {
  const token = ++state.modelHealth.pollToken;
  const deadline = Date.now() + 4 * 60_000;
  while (token === state.modelHealth.pollToken && state.data.modelHealth?.running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (token !== state.modelHealth.pollToken) return;
    state.data.modelHealth = await api("/api/model-health");
    if (state.view === "models") {
      renderModels(state.data);
      lucide.createIcons();
    }
  }
}

function openSlot(id) {
  state.editingSlot = id;
  const existing = state.data.thirdPartySlots.find((slot) => slot.id === id);
  if (!state.data.providers.length) {
    toast("先添加供应商，再配置模型。", true);
    showView("providers");
    openProvider();
    return;
  }
  $("#model-dialog-title").textContent = existing ? "编辑模型" : "添加模型";
  $("#slot-id").value = id;
  $("#slot-name").value = existing?.displayName || "";
  $("#slot-model").value = existing?.upstreamModel || "";
  $("#slot-reasoning-preset").value = existing?.reasoningPreset || "auto";
  $("#provider-select").innerHTML = state.data.providers.map((provider) => `<option value="${escapeHtml(provider.id)}" ${provider.id === existing?.providerId ? "selected" : ""}>${escapeHtml(provider.name)}${provider.hasApiKey ? "" : "（缺少 Key）"}</option>`).join("");
  updateModelSuggestions();
  updateModelCapability();
  setModelStatus("");
  $("#delete-model").hidden = !existing;
  $("#model-dialog").showModal();
}

function updateModelSuggestions(remoteModels = state.providerModels.get($("#provider-select").value) || []) {
  const provider = selectedProvider();
  const presets = presetModelsFor(provider);
  $("#model-source").textContent = remoteModels.length
    ? `供应商返回 ${remoteModels.length} 个模型；仍可手动填写`
    : `已提供 ${presets.length || commonModels.length} 个常用建议；也可手动填写`;
}

function selectedProvider() {
  return state.data?.providers.find((provider) => provider.id === $("#provider-select").value) || null;
}

function presetModelsFor(provider) {
  const value = `${provider?.id || ""} ${provider?.name || ""} ${provider?.baseUrl || ""}`.toLowerCase();
  if (value.includes("deepseek")) return ["deepseek-chat", "deepseek-reasoner"];
  if (value.includes("moonshot") || value.includes("kimi")) return ["kimi-k2.5", "kimi-k2-thinking", "kimi-k2-thinking-turbo"];
  if (value.includes("dashscope") || value.includes("qwen") || value.includes("aliyun")) return ["qwen3-coder-plus", "qwen3-max", "qwen-plus", "qwen-turbo"];
  if (value.includes("bigmodel") || value.includes("zhipu") || value.includes("glm")) return ["glm-4.7", "glm-4.7-flash", "glm-4.5-air"];
  if (value.includes("minimax")) return ["MiniMax-M2.1", "MiniMax-M2.1-lightning"];
  if (value.includes("openai")) return ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini", "gpt-4.1", "gpt-4.1-mini"];
  return commonModels;
}

async function loadProviderModels() {
  const provider = selectedProvider();
  if (!provider) return setModelStatus("请先选择供应商。", true);
  const button = $("#load-models");
  setButtonLoading(button, true);
  setModelStatus("正在读取供应商模型列表...");
  try {
    const result = await api(`/api/providers/${encodeURIComponent(provider.id)}/models`);
    state.providerModels.set(provider.id, result.models || []);
    updateModelSuggestions(result.models || []);
    setModelStatus(result.models?.length ? `已读取 ${result.models.length} 个模型。点击“选择模型”使用，或继续手动填写。` : "供应商返回了空列表，已保留常用建议和手动输入。", false, true);
  } catch (error) {
    updateModelSuggestions();
    setModelStatus(`${error.message} 已保留常用建议和手动输入。`, true);
  } finally { setButtonLoading(button, false); }
}

function openModelPicker() {
  $("#model-filter").value = "";
  renderModelOptions();
  $("#model-picker-dialog").showModal();
  setTimeout(() => $("#model-filter").focus(), 0);
}

function renderModelOptions() {
  const provider = selectedProvider();
  const remote = state.providerModels.get(provider?.id) || [];
  const models = [...new Set([...remote, ...presetModelsFor(provider), ...commonModels])];
  const filter = $("#model-filter").value.trim().toLowerCase();
  const visible = models.filter((model) => !filter || model.toLowerCase().includes(filter));
  $("#model-picker-copy").textContent = remote.length
    ? `${provider?.name || "当前供应商"} 返回的 ${remote.length} 个模型排在前面；也可选择常用建议。`
    : `未读取到 ${provider?.name || "当前供应商"} 的模型目录。显示常用建议；可以直接手填任意 ID。`;
  $("#model-options").innerHTML = visible.length
    ? visible.map((model) => `<button class="model-option" type="button" role="option" data-model-option="${escapeHtml(model)}"><span title="${escapeHtml(model)}">${escapeHtml(model)}</span></button>`).join("")
    : '<div class="empty-state">没有匹配的模型。可以关闭此窗口，直接手动输入模型 ID。</div>';
  document.querySelectorAll("[data-model-option]").forEach((button) => button.addEventListener("click", () => selectModelOption(button.dataset.modelOption)));
}

function selectModelOption(model) {
  $("#slot-model").value = model;
  fillDisplayNameFromModel();
  $("#model-picker-dialog").close();
  updateModelCapability();
  setModelStatus(`已选择 ${model}。可点击“测试模型”确认可用性。`);
}

function useTypedModel() {
  const model = $("#slot-model").value.trim();
  if (!model) return setModelStatus("请先输入上游模型 ID。", true);
  fillDisplayNameFromModel();
  $("#model-picker-dialog").close();
  updateModelCapability();
  setModelStatus(`将使用手动输入的 ${model}。建议先测试模型。`);
}

function openBatchModelDialog() {
  if (!state.data.providers.length) {
    toast("先添加供应商，再批量配置模型。", true);
    showView("providers");
    openProvider();
    return;
  }
  const remaining = slotIds.length - state.data.thirdPartySlots.length;
  if (remaining <= 0) return toast("十个第三方模型槽位已经全部使用。", true);
  state.batchSelectedModels.clear();
  $("#batch-provider-select").innerHTML = state.data.providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}${provider.hasApiKey ? "" : "（缺少 Key）"}</option>`).join("");
  $("#batch-model-filter").value = "";
  renderBatchModelOptions();
  $("#batch-model-dialog").showModal();
}

function selectedBatchProvider() {
  return state.data?.providers.find((provider) => provider.id === $("#batch-provider-select").value) || null;
}

function renderBatchModelOptions() {
  const provider = selectedBatchProvider();
  const remote = state.providerModels.get(provider?.id) || [];
  const models = [...new Set([...remote, ...presetModelsFor(provider), ...commonModels])];
  const filter = $("#batch-model-filter").value.trim().toLowerCase();
  const visible = models.filter((model) => !filter || model.toLowerCase().includes(filter));
  const existing = new Set(state.data.thirdPartySlots.filter((slot) => slot.providerId === provider?.id).map((slot) => slot.upstreamModel));
  $("#batch-model-copy").textContent = remote.length
    ? `${provider?.name || "当前供应商"} 返回 ${remote.length} 个模型；勾选后会按空槽位顺序添加。`
    : `当前显示常用建议。可先点击“读取模型”获取 ${provider?.name || "供应商"} 的实际目录。`;
  $("#batch-model-options").innerHTML = visible.length
    ? visible.map((model) => {
      const configured = existing.has(model);
      const selected = state.batchSelectedModels.has(model);
      return `<label class="batch-model-option ${configured ? "configured" : ""}"><input type="checkbox" data-batch-model="${escapeHtml(model)}" ${selected ? "checked" : ""} ${configured ? "disabled" : ""}><span><strong title="${escapeHtml(model)}">${escapeHtml(model)}</strong><small>${configured ? "已添加" : "可添加"}</small></span></label>`;
    }).join("")
    : '<div class="empty-state">没有匹配的模型。可调整筛选，或使用单独添加手动填写模型 ID。</div>';
  document.querySelectorAll("[data-batch-model]").forEach((input) => input.addEventListener("change", () => {
    if (input.checked) state.batchSelectedModels.add(input.dataset.batchModel); else state.batchSelectedModels.delete(input.dataset.batchModel);
    updateBatchModelStatus();
  }));
  updateBatchModelStatus();
}

function updateBatchModelStatus(message = "", error = false) {
  const remaining = Math.max(0, slotIds.length - state.data.thirdPartySlots.length);
  const selected = state.batchSelectedModels.size;
  const target = $("#batch-model-status");
  target.textContent = message || `已选择 ${selected} 个模型，剩余 ${remaining} 个槽位。`;
  target.className = `field-status ${error || selected > remaining ? "error" : ""}`;
  $("#save-batch-models").disabled = selected === 0 || selected > remaining;
}

async function loadBatchProviderModels() {
  const provider = selectedBatchProvider();
  if (!provider) return updateBatchModelStatus("请先选择供应商。", true);
  const button = $("#batch-load-models");
  setButtonLoading(button, true);
  updateBatchModelStatus("正在读取供应商模型列表...");
  try {
    const result = await api(`/api/providers/${encodeURIComponent(provider.id)}/models`);
    state.providerModels.set(provider.id, result.models || []);
    renderBatchModelOptions();
  } catch (error) { updateBatchModelStatus(`${error.message} 已保留常用建议。`, true); }
  finally { setButtonLoading(button, false); }
}

async function saveBatchModels(event) {
  event.preventDefault();
  const button = $("#save-batch-models");
  setButtonLoading(button, true);
  try {
    const result = await api("/api/slots/batch", "POST", { providerId: $("#batch-provider-select").value, models: [...state.batchSelectedModels] });
    $("#batch-model-dialog").close();
    await refresh();
    toast(`已添加 ${result.slots.length} 个模型。启用或更新 Relay 后才会写入 Codex。`);
  } catch (error) { updateBatchModelStatus(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function testProviderModel() {
  const provider = selectedProvider();
  const model = $("#slot-model").value.trim();
  if (!provider) return setModelStatus("请先选择供应商。", true);
  if (!model) return setModelStatus("请先选择或输入上游模型 ID。", true);
  const button = $("#test-model");
  setButtonLoading(button, true);
  setModelStatus("正在发送最小测试请求，可能消耗少量 Token...");
  try {
    const result = await api(`/api/providers/${encodeURIComponent(provider.id)}/test-model`, "POST", { model, reasoningPreset: $("#slot-reasoning-preset").value });
    const usage = result.usage?.total === null || result.usage?.total === undefined ? "上游未返回 Token" : `Token ${result.usage.total}`;
    const reasoning = result.reasoning?.sent ? `，推理 ${reasoningLabel(result.reasoning)}` : "";
    setModelStatus(`模型可用，HTTP ${result.status}，${result.durationMs} ms，${usage}${reasoning}。`, false, true);
    try {
      state.data.modelHealth = await api("/api/model-health");
      renderModels(state.data);
      lucide.createIcons();
    } catch { /* The dialog result remains authoritative if the status refresh is unavailable. */ }
    fillDisplayNameFromModel();
  } catch (error) { setModelStatus(error.message, true); }
  finally { setButtonLoading(button, false); }
}

function fillDisplayNameFromModel() {
  if (!$("#slot-name").value.trim() && $("#slot-model").value.trim()) $("#slot-name").value = friendlyModelName($("#slot-model").value);
}

function friendlyModelName(value) {
  return String(value).trim().split(/[-_/]+/).filter(Boolean).map((part) => /^(gpt|glm|qwen|kimi|mimo)$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)).join(" ").slice(0, 48);
}

function setModelStatus(message, error = false, success = false) {
  const target = $("#model-test-status");
  target.textContent = message;
  target.className = `field-status ${error ? "error" : success ? "success" : ""}`;
}

function scheduleModelCapabilityUpdate() {
  clearTimeout(scheduleModelCapabilityUpdate.timer);
  scheduleModelCapabilityUpdate.timer = setTimeout(updateModelCapability, 250);
}

async function updateModelCapability() {
  const providerId = $("#provider-select").value;
  const model = $("#slot-model").value.trim();
  const target = $("#model-capability-text");
  if (!providerId || !model) {
    target.textContent = "填写上游模型 ID 后自动识别";
    return;
  }
  target.textContent = "正在识别...";
  try {
    const reasoningPreset = $("#slot-reasoning-preset").value;
    const capability = await api(`/api/model-capability?providerId=${encodeURIComponent(providerId)}&model=${encodeURIComponent(model)}&reasoningPreset=${encodeURIComponent(reasoningPreset)}`);
    const context = new Intl.NumberFormat("zh-CN").format(capability.contextWindow);
    const modality = capability.supportsImages ? "支持图片" : "仅文本";
    const efforts = capability.reasoning?.levels?.map((level) => level.effort).join(" / ") || "不发布推理强度";
    target.textContent = `${context} Token 上下文 · ${modality} · ${efforts} · ${reasoningTransportLabel(capability.reasoning?.transport)}`;
  } catch {
    target.textContent = "将按兼容配置自动运行";
  }
}

function openProvider(provider = null) {
  state.editingProvider = provider?.id || null;
  $("#provider-dialog-title").textContent = provider ? "编辑供应商" : "添加供应商";
  $("#provider-id").value = provider?.id || "";
  $("#provider-name").value = provider?.name || "";
  $("#provider-url").value = provider?.baseUrl || "";
  $("#provider-api").value = provider?.apiType || "chat_completions";
  $("#provider-responses-compatibility").value = provider?.responsesCompatibility || "standard";
  $("#provider-network").value = provider?.networkMode || "direct";
  $("#provider-proxy-url").value = provider?.proxyUrl || "";
  $("#provider-native-continuation").checked = provider?.nativeResponseContinuation === true;
  syncProviderNetworkFields();
  syncProviderContinuationFields();
  $("#provider-key").value = "";
  $("#provider-key").required = !provider;
  $("#provider-key").placeholder = provider?.hasApiKey ? "留空保留现有 Key" : "仅加密保存在本机";
  $("#delete-provider").hidden = !provider;
  $("#provider-dialog").showModal();
}

function syncProviderNetworkFields() {
  const mode = $("#provider-network").value;
  const custom = mode === "custom";
  $("#provider-proxy-row").hidden = !custom;
  $("#provider-proxy-url").required = custom;
  $("#provider-network-hint").textContent = mode === "windows"
    ? "每次请求前读取当前 Windows HTTP(S) 代理；不会先直连失败后再重复发送。"
    : custom
      ? "只通过这个 HTTP(S) 代理连接当前供应商；地址中不要填写账号或密码。"
      : "直连只影响当前供应商，不改变官方或其他第三方。";
}

function syncProviderContinuationFields() {
  const visible = $("#provider-api").value === "responses";
  const deepSeekResponses = visible && $("#provider-responses-compatibility").value === "deepseek";
  $("#provider-responses-compatibility-row").hidden = !visible;
  $("#provider-native-continuation-row").hidden = !visible || deepSeekResponses;
  $("#provider-native-continuation-hint").hidden = !visible;
  if (!visible) $("#provider-responses-compatibility").value = "standard";
  if (!visible || deepSeekResponses) $("#provider-native-continuation").checked = false;
  $("#provider-native-continuation").disabled = deepSeekResponses;
  if (deepSeekResponses) $("#provider-native-continuation-hint").textContent = "DeepSeek 官方 Responses 为无状态接口，Relay 固定使用可见上下文，不启用原生续接。";
  else $("#provider-native-continuation-hint").textContent = "仅在该上游支持保存 response ID 时开启。Relay 会严格校验完整输入前缀；不同上游不传递响应 ID，拒绝后只回退一次完整上下文。";
}

async function saveProvider(event) {
  event.preventDefault();
  const button = $("#save-provider");
  setButtonLoading(button, true);
  try {
    const provider = await api("/api/providers", "POST", {
      id: $("#provider-id").value || undefined,
      name: $("#provider-name").value,
      baseUrl: $("#provider-url").value,
      apiType: $("#provider-api").value,
      responsesCompatibility: $("#provider-api").value === "responses" ? $("#provider-responses-compatibility").value : "standard",
      networkMode: $("#provider-network").value,
      proxyUrl: $("#provider-network").value === "custom" ? $("#provider-proxy-url").value : "",
      nativeResponseContinuation: $("#provider-api").value === "responses" && $("#provider-native-continuation").checked,
    });
    if ($("#provider-key").value) await api(`/api/providers/${encodeURIComponent(provider.provider.id)}/key`, "POST", { apiKey: $("#provider-key").value });
    const [models, balance] = await Promise.allSettled([
      api(`/api/providers/${encodeURIComponent(provider.provider.id)}/models`),
      api(`/api/providers/${encodeURIComponent(provider.provider.id)}/balance`, "POST"),
    ]);
    if (models.status === "fulfilled") state.providerModels.set(provider.provider.id, models.value.models || []);
    $("#provider-dialog").close();
    await refresh();
    const modelText = models.status === "fulfilled" ? `读取到 ${models.value.models.length} 个模型` : "模型目录无法自动探测";
    const balanceText = balance.status === "fulfilled" && balance.value.detected ? `余额 ${formatBalance(balance.value.balance)}` : "余额无法自动探测";
    toast(`供应商已保存；${modelText}，${balanceText}。`, models.status !== "fulfilled" && !(balance.status === "fulfilled" && balance.value.detected), 8000);
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function saveSlot(event) {
  event.preventDefault();
  const button = $("#save-model");
  setButtonLoading(button, true);
  try {
    await api("/api/slots", "POST", { id: $("#slot-id").value, displayName: $("#slot-name").value, upstreamModel: $("#slot-model").value, providerId: $("#provider-select").value, reasoningPreset: $("#slot-reasoning-preset").value });
    $("#model-dialog").close();
    await refresh();
    toast("模型已保存。启用或更新 Relay 后才会写入 Codex。");
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function deleteSlot(event) {
  if (!state.editingSlot || !confirm("清空这个第三方模型槽位？Relay 供应商和 Key 不会被删除。")) return;
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    await api(`/api/slots/${encodeURIComponent(state.editingSlot)}`, "DELETE");
    $("#model-dialog").close();
    await refresh();
    toast("模型槽位已清空。更新 Relay 后会从 Codex 模型栏移除。");
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function deleteProvider(event) {
  if (!state.editingProvider || !confirm("删除这个供应商及其本地加密 Key？")) return;
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    await api(`/api/providers/${encodeURIComponent(state.editingProvider)}`, "DELETE");
    $("#provider-dialog").close();
    await refresh();
    toast("供应商已删除。");
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function refreshOfficialUsage({ silent = false } = {}) {
  if (state.officialUsageLoading) return;
  const button = $("#refresh-official-usage");
  state.officialUsageLoading = true;
  if (!silent) setButtonLoading(button, true);
  try {
    const usage = await api("/api/official/usage/refresh", "POST");
    await refresh();
    if (!silent) toast(usage.fiveHour || usage.weekly ? "官方账号额度已更新。" : "官方账号套餐已更新，额度窗口暂未返回。", false);
  } catch (error) {
    await refresh();
    if (!silent) toast(error.message, true);
  } finally {
    state.officialUsageLoading = false;
    if (!silent) setButtonLoading(button, false);
    button.disabled = !state.data?.official?.login?.signedIn;
  }
}

async function verifyOfficial() {
  const button = $("#verify-official");
  setButtonLoading(button, true);
  try {
    const result = await api("/api/official/verify", "POST");
    toast(result.verified ? "官方登录已同步，两个官方模型已加入。" : result.summary, !result.verified);
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); await refresh(); }
}

async function refreshOfficialModels() {
  const button = $("#refresh-official-models");
  setButtonLoading(button, true);
  try {
    const result = await api("/api/official/models/refresh", "POST");
    await refresh();
    toast(`已读取当前官方账号的 ${result.models.length} 个可用模型。现有两个位置没有自动改变。`);
    openOfficialModelDialog();
  } catch (error) { toast(error.message, true, 8000); }
  finally { setButtonLoading(button, false); }
}

function openOfficialModelDialog() {
  const official = state.data?.official;
  if (!official?.login?.signedIn) return toast("请先在 Codex 中登录官方账号并同步登录状态。", true);
  if (!official.modelsFetchedAt || !official.availableModels?.length) return toast("请先点击“刷新可用模型”，读取当前账号的官方模型。", true);
  const selected = official.slots || [];
  for (const [index, select] of [$("#official-slot-1"), $("#official-slot-2")].entries()) {
    select.innerHTML = '<option value="">不使用此位置</option>' + official.availableModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.displayName)} · ${escapeHtml(model.id)}</option>`).join("");
    select.value = selected[index]?.id || "";
  }
  $("#official-model-status").textContent = `候选列表读取于 ${new Date(official.modelsFetchedAt).toLocaleString("zh-CN")}。`;
  $("#official-model-status").className = "field-status";
  $("#official-model-dialog").showModal();
}

async function saveOfficialModels(event) {
  event.preventDefault();
  const ids = [$("#official-slot-1").value, $("#official-slot-2").value].filter(Boolean);
  if (new Set(ids).size !== ids.length) return setOfficialModelStatus("两个官方位置不能选择同一个模型。", true);
  const button = $("#save-official-models");
  setButtonLoading(button, true);
  try {
    await api("/api/official/slots", "POST", { modelIds: ids });
    $("#official-model-dialog").close();
    await refresh();
    toast(`已保存 ${ids.length} 个官方模型。它们会继续与第三方模型同时热切换。`);
  } catch (error) { setOfficialModelStatus(error.message, true); }
  finally { setButtonLoading(button, false); }
}

function setOfficialModelStatus(message, error = false) {
  const target = $("#official-model-status");
  target.textContent = message;
  target.className = `field-status${error ? " error" : ""}`;
}

async function openApplyDialog(event) {
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    const repairEligible = Boolean(state.data?.connection?.repairEligible);
    const externalTakeover = Boolean(state.data?.connection?.externalTakeover);
    state.applyMode = repairEligible ? "repair" : "apply";
    const preview = await api("/api/apply-preview");
    state.applyPreview = preview;
    if (!preview.ready) return toast(preview.problems.join(" "), true);
    if (repairEligible) {
      $("#apply-copy").textContent = "检测到 Relay 管理的连接设置发生变化。修复只重写 Relay 管理块，不会替换最初的恢复快照。";
      $("#apply-preflight").innerHTML = [
        "确认当前配置仍带 Codex Relay 管理标记",
        "重新写入本地 Router 地址和当前可用模型",
        preview.officialAuthHandoff?.action === "preserve_current" ? "保留当前 Codex 官方登录，不重写 auth.json" : "按预检结果处理官方登录，不在 Codex 运行时替换认证",
        "核对已有会话文件，不改写聊天正文",
        "保留使用 Relay 前的原始恢复快照",
      ].map((item) => `<li>${escapeHtml(item)}</li>`).join("");
      $("#confirm-apply").textContent = "确认修复";
    } else {
      const thirdPartyCount = preview.routes.filter((route) => route.kind === "third_party").length;
      const officialCount = preview.routes.filter((route) => route.kind === "official").length;
      $("#apply-copy").textContent = externalTakeover
        ? "Codex 当前由其他配置接管。确认后会重新指向 Relay；已有恢复快照不会被覆盖。"
        : preview.createsHandoff
          ? "启用前会原样保存当前 Codex 配置和认证。只有主动恢复时才会退出 Relay。"
          : "Relay 已启用，本次更新不会覆盖最初的恢复快照。";
      $("#apply-preflight").innerHTML = [
        `先生成并验证模型目录：${thirdPartyCount} 个第三方${officialCount ? ` + ${officialCount} 个官方` : ""}`,
        officialCount
          ? preview.officialAuthHandoff?.action === "preserve_current"
            ? "保留当前 Codex 官方登录，不重写 auth.json；官方与第三方模型会同时发布"
            : "Codex 已关闭后恢复 Relay 加密保存的官方登录；官方与第三方模型会同时发布"
          : "当前未登录官方账号，不影响第三方模型发布",
        "检查 Router、模型目录、API Key 与 config.toml 可写性",
        "记录并核对已有会话文件，不改写聊天正文",
        `配置 Codex 使用 openai + ${preview.config.writes.includes("openai_base_url") ? "本地 Router" : "Relay"}`,
        preview.createsHandoff ? "创建本次使用 Relay 前的唯一恢复快照" : "保留现有恢复快照",
        "任一步失败都会自动回滚",
      ].map((item) => `<li>${escapeHtml(item)}</li>`).join("");
      if (preview.externalProcesses?.ccSwitchRunning) {
        $("#apply-preflight").insertAdjacentHTML("beforeend", "<li>" + escapeHtml("检测到 CC Switch 正在运行；确认后会自动关闭其进程，不删除 CC Switch 的任何配置") + "</li>");
      }
      if (preview.externalProcesses?.codexRunning) {
        $("#apply-preflight").insertAdjacentHTML("beforeend", "<li>" + escapeHtml("检测到 Codex 正在运行；启用完成后需要重新打开 Codex，当前聊天文件不会被删除") + "</li>");
      }
      $("#confirm-apply").textContent = externalTakeover ? "确认重新启用" : "确认启用";
    }
    const history = preview.historyVisibility;
    const historyOption = $("#history-visibility-option");
    const historyCheckbox = $("#history-visibility-confirm");
    historyCheckbox.checked = false;
    historyCheckbox.disabled = !history?.canMigrate;
    historyOption.hidden = repairEligible || !history || !["available", "blocked"].includes(history.status);
    if (!historyOption.hidden) {
      $("#history-visibility-title").textContent = `同时让 ${history.eligibleCount} 条 custom 旧会话在 Relay 历史中可见`;
      $("#history-visibility-copy").textContent = history.canMigrate
        ? "通常来自 CC Switch。只调整会话归类与索引，正文、工具结果和加密内容不改写；操作前创建可验证备份。可见不等于当前模型能原生续接。"
        : "需要完全退出 Codex 后才能选择；不选择仍可正常启用 Relay。";
    }
    updateApplyConfirmationLabel();
    if (!preview.computerUse?.environmentReady) {
      $("#apply-preflight").insertAdjacentHTML("beforeend", `<li>${escapeHtml("Computer Use 插件环境需要单独修复；模型路由仍可启用")}</li>`);
    }
    $("#apply-dialog").showModal();
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function applyRelay(event) {
  event.preventDefault();
  const button = $("#confirm-apply");
  setButtonLoading(button, true, state.applyMode === "repair" ? "正在修复 Relay" : "正在启用 Relay");
  try {
    const repairing = state.applyMode === "repair";
    const historySelected = !repairing && Boolean($("#history-visibility-confirm").checked);
    const requestBody = historySelected ? {
      historyVisibilityAction: "show_custom_in_openai",
      historyVisibilityPlanSha256: state.applyPreview?.historyVisibility?.planHash,
    } : undefined;
    const result = await api(repairing ? "/api/connection/repair" : "/api/apply", "POST", requestBody);
    $("#apply-dialog").close();
    const published = result.publication?.modelCount || state.data?.routes?.length || 0;
    toast(repairing
      ? `Relay 连接已修复并发布 ${published} 个模型。请重新打开 Codex。`
      : result.historyVisibility?.status === "migrated"
        ? `Relay 已启用并发布 ${published} 个模型；${result.historyVisibility.sessions || Math.max(result.historyVisibility.files, result.historyVisibility.rows)} 条旧会话现在可见。请重新打开 Codex。`
      : result.handoffCreated
        ? `Relay 已启用，已验证发布 ${published} 个模型并保存使用前状态。请重新打开 Codex。`
        : `Relay 配置已更新，已验证发布 ${published} 个模型。请重新打开 Codex。`, false, 7000);
    await refresh();
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function openRestoreDialog(event) {
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    const preview = await api("/api/restore-preview");
    if (!preview.available) return toast("Relay 当前未启用，没有可恢复的活动快照。", true);
    state.restorePreview = preview;
    const deletedCount = preview.sessionProtection?.deleted?.length || 0;
    const codexRunning = Boolean(preview.codexRunning);
    $("#restore-warning").hidden = !preview.configurationChanged;
    const restoreCopy = preview.historyVisibility?.restoreRequired
      ? `Codex 将恢复使用 Relay 前的配置和认证，并把本次调整的 ${preview.historyVisibility.sessions || Math.max(preview.historyVisibility.files, preview.historyVisibility.rows)} 条旧会话按备份账本恢复为 custom 归类。请求记录、对话、插件和 Relay 设置都会保留。`
      : "Codex 将恢复到本次使用 Relay 之前的配置和认证。请求记录、对话、插件、Relay 供应商、模型名称和加密 Key 都会保留。";
    $("#restore-form .dialog-copy").textContent = `${restoreCopy} 恢复前必须完全退出 Codex，避免运行中的桌面端保留旧配置或登录状态。${deletedCount ? ` 检测到 ${deletedCount} 个旧对话此前已删除，恢复时会跳过且不会从备份复活。` : ""}`;
    $("#restore-confirm").parentElement.lastChild.textContent = preview.historyVisibility?.restoreRequired
      ? "我已完全退出 Codex，确认退出 Relay，并恢复配置、认证和旧会话归类"
      : "我已完全退出 Codex，确认退出 Relay 并恢复原状态";
    $("#restore-confirm").checked = false;
    $("#confirm-restore").disabled = true;
    if (codexRunning) toast("请先完全退出 Codex，再执行恢复；当前没有修改任何文件。", true, 8000);
    $("#restore-dialog").showModal();
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

function updateApplyConfirmationLabel() {
  if (state.applyMode === "repair") return;
  $("#confirm-apply").textContent = $("#history-visibility-confirm").checked
    ? "确认启用并显示旧会话"
    : state.data?.connection?.externalTakeover ? "确认重新启用" : "确认启用";
}

async function restoreOfficial(event) {
  event.preventDefault();
  const button = $("#confirm-restore");
  setButtonLoading(button, true);
  try {
    const result = await api("/api/restore", "POST");
    $("#restore-dialog").close();
    toast(`${result.message} 请重新打开 Codex。`, !result.verified, 8000);
    await refresh();
    showView("home");
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function openOfficialDirectDialog(event) {
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    const preview = await api("/api/restore-preview");
    if (!preview.available) return toast("Relay 当前没有可用的使用前快照，无法安全切回官方直连。", true);
    state.officialDirectPreview = preview;
    $("#official-direct-confirm").checked = false;
    $("#confirm-official-direct").disabled = true;
    $("#official-direct-dialog").showModal();
    if (preview.codexRunning) toast("请先完全退出 Codex，再切回官方直连；当前没有修改任何文件。", true, 8000);
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function switchOfficialDirect(event) {
  event.preventDefault();
  const button = $("#confirm-official-direct");
  setButtonLoading(button, true);
  try {
    const result = await api("/api/official-direct", "POST");
    $("#official-direct-dialog").close();
    toast(`${result.message} 现在可以直接打开 Codex 正常登录和使用。`, !result.verified, 9000);
    await refresh();
    showView("home");
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function checkSessions(event) {
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    const result = await api("/api/session-inventory");
    if (!result.baseline) return toast("Relay 尚未启用，目前没有使用前会话基线。", true);
    if (!result.comparable) return toast("暂时无法核对会话文件；没有修改任何 Codex 数据。", true);
    if (result.same) return toast(`会话保护正常：${result.current.files.length} 个已有或新增会话文件可见${result.protection.deleted.length ? `；${result.protection.deleted.length} 个已删除旧对话将被跳过` : ""}。`);
    const issue = result.protection;
    toast(`会话保护异常：缺失文件 ${issue.missing.length}，缺失索引 ${issue.missingIndex.length}，截断 ${issue.truncated.length}，旧正文变化 ${issue.changedPrefix.length}。`, true, 9000);
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function saveContextCachePreference(event) {
  setControlLoading(event.target, true);
  try {
    const result = await api("/api/context-cache", "POST", { persist: event.target.checked });
    toast(result.persist ? "跨模型上下文已启用本机加密持久化。" : "跨模型上下文改为仅保留在本次运行中。");
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, true);
  } finally { setControlLoading(event.target, false); }
}

async function saveDeepSeekSavingsPreference(event) {
  setControlLoading(event.target, true);
  try {
    const result = await api("/api/deepseek-savings", "POST", { enabled: event.target.checked });
    event.target.checked = Boolean(result.enabled);
    toast(result.enabled ? "DeepSeek 省钱模式已启用，只影响 DeepSeek Chat 请求。" : "DeepSeek 省钱模式已关闭。" );
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, true);
  } finally { setControlLoading(event.target, false); }
}

async function setLaunchAtLogin(event) {
  setControlLoading(event.target, true);
  try {
    const result = await window.codexRelayDesktop.setLaunchAtLogin(event.target.checked);
    event.target.checked = result.enabled;
    toast(result.enabled ? "已启用开机启动。" : "已关闭开机启动。");
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, true);
  } finally { setControlLoading(event.target, false); }
}

async function copyComputerUseRepairPrompt(event) {
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    await copyText(computerUseRepairPrompt);
    setComputerUseRepairStatus("修复提示词已复制，可以直接发送给能操作本机的 AI。");
    toast("电脑控制修复提示词已复制。");
  } catch (error) {
    setComputerUseRepairStatus(error.message || "复制失败，请下载说明文件。", true);
    toast(error.message || "复制失败，请下载说明文件。", true);
  } finally { setButtonLoading(button, false); }
}

function downloadComputerUseRepairGuide() {
  try {
    const blob = new Blob([computerUseRepairPrompt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "Codex-Computer-Use-Repair-Prompt.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setComputerUseRepairStatus("修复说明已下载。");
    toast("电脑控制修复说明已下载。");
  } catch (error) {
    setComputerUseRepairStatus(error.message || "下载失败，请改用复制提示词。", true);
    toast(error.message || "下载失败，请改用复制提示词。", true);
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch { /* Fall back for restricted Electron clipboard contexts. */ }
  }

  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  activeElement?.focus?.();
  if (!copied) throw new Error("系统未允许写入剪贴板，请下载说明文件。");
}

function setComputerUseRepairStatus(message, error = false) {
  const target = $("#computer-use-repair-status");
  target.textContent = message;
  target.className = `repair-status${error ? " error" : ""}`;
}

async function checkBrowserUse(event) {
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    const result = await api("/api/browser-use-status");
    renderBrowserDiagnostic(result);
    toast(result.chromeReady ? "浏览器操控环境检查通过。" : "浏览器操控检查完成，请查看未通过项。", !result.browserReady);
  } catch (error) {
    setBrowserUseRepairStatus(error.message || "浏览器操控检测失败。", true);
    toast(error.message || "浏览器操控检测失败。", true);
  } finally { setButtonLoading(button, false); }
}

function renderBrowserDiagnostic(result) {
  const list = $("#browser-diagnostic-result");
  const checks = {
    plugin: { ok: result.pluginReady, label: "浏览器插件" },
    executables: { ok: result.stableExecutablesReady, label: "稳定执行文件" },
    extension: { ok: result.extensionEnabled, label: result.selectedProfile ? `Chrome 扩展 · ${result.selectedProfile}` : "Chrome 扩展" },
    "native-host": { ok: result.nativeHostReady, label: "Native Host" },
    chrome: { ok: result.chromeRunning, warn: !result.chromeRunning && result.chromeInstalled, label: result.chromeRunning ? "Chrome 已运行" : result.chromeInstalled ? "Chrome 未运行" : "未安装 Chrome" },
  };
  for (const [name, check] of Object.entries(checks)) {
    const item = list.querySelector(`[data-browser-check="${name}"]`);
    item.className = check.ok ? "ok" : check.warn ? "warn" : "failed";
    item.querySelector("b").textContent = check.label;
  }
  list.hidden = false;
  const messages = {
    ready: "环境完整，Chrome 已运行；请用新任务验收浏览器操控。",
    chrome_not_running: "环境完整，但 Chrome 尚未运行。打开 Chrome 后再新建任务测试。",
    stable_executables_missing: "Codex 稳定执行文件不完整，可能导致新任务被重启并丢失 rollout 文件。",
    plugin_cache_missing: "当前版本的浏览器插件缓存不完整。",
    plugin_cache_outdated: "浏览器插件缓存与当前 Codex 版本不一致。",
    extension_missing: "当前 Chrome Profile 未安装 ChatGPT Chrome Extension。",
    extension_disabled: "当前 Chrome Profile 的 ChatGPT Chrome Extension 未启用。",
    native_host_missing: "Chrome native host 未注册或清单不存在。",
    native_host_invalid: "Chrome native host 清单与当前扩展不匹配。",
    native_host_unknown: "无法读取当前 Chrome native host 配置。",
    chrome_missing: "本机未检测到 Google Chrome。",
    resources_unknown: "无法定位当前 Codex Appx 资源，请完全退出并重开 Relay 后再检测。",
  };
  setBrowserUseRepairStatus(messages[result.status] || "检测完成，请复制提示词继续诊断。", !result.browserReady);
}

async function copyBrowserUseRepairPrompt(event) {
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    await copyText(browserUseRepairPrompt);
    setBrowserUseRepairStatus("修复提示词已复制，可以直接发送给能操作本机的 AI。");
    toast("浏览器操控修复提示词已复制。");
  } catch (error) {
    setBrowserUseRepairStatus(error.message || "复制失败，请下载说明文件。", true);
    toast(error.message || "复制失败，请下载说明文件。", true);
  } finally { setButtonLoading(button, false); }
}

function downloadBrowserUseRepairGuide() {
  try {
    const blob = new Blob([browserUseRepairPrompt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "Codex-Browser-Control-Repair-Prompt.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setBrowserUseRepairStatus("修复说明已下载。");
    toast("浏览器操控修复说明已下载。");
  } catch (error) {
    setBrowserUseRepairStatus(error.message || "下载失败，请改用复制提示词。", true);
    toast(error.message || "下载失败，请改用复制提示词。", true);
  }
}

function setBrowserUseRepairStatus(message, error = false) {
  const target = $("#browser-use-repair-status");
  target.textContent = message;
  target.className = `repair-status${error ? " error" : ""}`;
}

async function openDataFolder(event) {
  const button = event.currentTarget;
  setButtonLoading(button, true);
  try {
    const result = await window.codexRelayDesktop.openDataFolder();
    if (!result.opened) toast(result.error || "无法打开数据目录。", true);
  } catch (error) { toast(error.message || "无法打开数据目录。", true); }
  finally { setButtonLoading(button, false); }
}

function connectionLabel(connection) {
  const url = connection.providerBaseUrl || connection.openaiBaseUrl;
  if (connection.providerIdentity === "openai" && !url) return "OpenAI 官方";
  if (url) return `${connection.providerIdentity} · ${friendlyHost(url)}`;
  return connection.providerIdentity || "未知";
}

function friendlyHost(value) {
  try { return new URL(value).host; } catch { return value; }
}

function setSidebarStatus(label, status) {
  $("#sidebar-status").textContent = label;
  $("#sidebar-dot").className = `status-dot ${status}`;
}

function renderInitialLoadFailure(error) {
  const modeIcon = $("#mode-icon");
  modeIcon.classList.remove("loading");
  modeIcon.innerHTML = '<i data-lucide="triangle-alert"></i>';
  $("#relay-control-title").textContent = "暂时无法读取 Relay 状态";
  $("#relay-control-copy").textContent = error.message;
  $("#mode-badge").textContent = "读取失败";
  $("#mode-badge").className = "mode-badge warning";
  lucide.createIcons();
}

function setButtonLoading(button, loading, loadingLabel = "") {
  if (!button) return;
  if (loading) {
    if (buttonLoadingStates.has(button)) return;
    const snapshot = {
      disabled: button.disabled,
      html: button.innerHTML,
      ariaBusy: button.getAttribute("aria-busy"),
      ariaLabel: button.getAttribute("aria-label"),
    };
    buttonLoadingStates.set(button, snapshot);
    const iconOnly = button.classList.contains("icon-button");
    const label = loadingLabel || button.dataset.loadingLabel || button.querySelector("span")?.textContent.trim() || button.textContent.trim() || button.getAttribute("aria-label") || "正在处理";
    const icon = document.createElement("i");
    icon.dataset.lucide = "loader-circle";
    icon.className = "loading-spinner";
    icon.setAttribute("aria-hidden", "true");
    button.replaceChildren(icon);
    if (!iconOnly) {
      const text = document.createElement("span");
      text.textContent = label;
      button.append(text);
    } else {
      button.setAttribute("aria-label", label);
    }
    button.disabled = true;
    button.classList.add("loading");
    button.setAttribute("aria-busy", "true");
    lucide.createIcons();
    return;
  }

  const snapshot = buttonLoadingStates.get(button);
  if (!snapshot) return;
  button.innerHTML = snapshot.html;
  button.disabled = snapshot.disabled;
  button.classList.remove("loading");
  restoreAttribute(button, "aria-busy", snapshot.ariaBusy);
  restoreAttribute(button, "aria-label", snapshot.ariaLabel);
  buttonLoadingStates.delete(button);
}

function setControlLoading(input, loading) {
  if (!input) return;
  const control = input.closest(".switch-control");
  if (loading) {
    if (controlLoadingStates.has(input)) return;
    controlLoadingStates.set(input, { disabled: input.disabled, ariaBusy: input.getAttribute("aria-busy") });
    input.disabled = true;
    input.setAttribute("aria-busy", "true");
    control?.classList.add("is-loading");
    return;
  }
  const snapshot = controlLoadingStates.get(input);
  if (!snapshot) return;
  input.disabled = snapshot.disabled;
  restoreAttribute(input, "aria-busy", snapshot.ariaBusy);
  control?.classList.remove("is-loading");
  controlLoadingStates.delete(input);
}

function restoreAttribute(element, name, value) {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

async function api(url, method = "GET", body) {
  let response;
  try {
    response = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("无法连接到本地 Router。请保持 Codex Relay 运行后重试。");
  }
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error("本地 Router 返回了无法识别的响应。"); }
  if (!response.ok) throw new Error(data.error?.message || data.error || "本地请求失败。");
  return data;
}

function toast(message, error = false, duration = 5000) {
  const target = $("#toast");
  target.textContent = message;
  target.hidden = false;
  target.classList.toggle("error", error);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { target.hidden = true; }, duration);
}

function parseHeaders(value) {
  if (!value.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("附加请求头必须是有效的 JSON 对象。"); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("附加请求头必须是 JSON 对象。");
  return parsed;
}

function contextLabel(mode) {
  return ({
    new: "新上下文",
    official_native_continuation: "官方原生续接",
    official_fallback_replayed: "官方降级续接",
    third_party_native_continuation: "第三方原生续接",
    third_party_continued: "第三方持续对话",
    portable_context: "跨模型上下文",
    unknown: "历史未导入",
  })[mode] || "上下文未知";
}

function usageLabel(usage) {
  if (!usage || usage.total === null || usage.total === undefined) return "未返回";
  return `${formatNumber(usage.input)} / ${formatNumber(usage.output)} / ${formatNumber(usage.total)}`;
}

function detailedUsageLabel(usage) {
  if (!usage || usage.total === null || usage.total === undefined) return "未返回";
  if (usage.input === null || usage.input === undefined) return `总 ${formatNumber(usage.total)}`;
  if (usage.cacheReported && usage.cacheHitRate !== null && usage.cacheHitRate !== undefined) return `命中 ${usage.cacheHitRate}% · 新 ${formatCompactNumber(usage.uncachedInput)}`;
  return `输入 ${formatCompactNumber(usage.input)}`;
}

function usageDetail(event) {
  const usage = event?.usage;
  if (!usage) return "上游未返回 Token 用量";
  const cacheRate = usage.cacheHitRate === null || usage.cacheHitRate === undefined ? "未返回" : `${usage.cacheHitRate}%`;
  const cache = usage.cacheReported
    ? `缓存命中 ${formatNumber(usage.cachedInput)}，未命中 ${formatNumber(usage.uncachedInput)}，命中率 ${cacheRate}`
    : "上游未返回缓存命中明细";
  return `输入 ${formatNumber(usage.input)}；${cache}；输出 ${formatNumber(usage.output)}；推理输出 ${formatNumber(usage.reasoningOutput)}；总计 ${formatNumber(usage.total)}${cachePrefixDetail(event?.diagnostics?.cache)}${deepSeekSavingsDetail(event?.diagnostics?.savings)}`;
}

function cachePrefixLabel(cache) {
  if (!cache?.tracked) return "";
  if (cache.prefixChanged === false) return " · DeepSeek 前缀稳定";
  if (cache.changeReasons?.includes("new_session")) return " · DeepSeek 新任务";
  if (cache.changeReasons?.includes("baseline_unavailable")) return " · DeepSeek 基线待建立";
  return " · DeepSeek 前缀变化";
}

function cachePrefixDetail(cache) {
  if (!cache?.tracked) return "";
  const reasons = (cache.changeReasons || []).map(cacheReasonLabel).filter(Boolean);
  const state = cache.prefixChanged === false ? "稳定" : reasons.length ? reasons.join("、") : "正在建立基线";
  return `；DeepSeek 缓存前缀 ${state}（指纹 ${cache.prefixHash || "-"}；工具约 ${formatNumber(cache.toolSchemaTokens)} Token）`;
}

function cacheReasonLabel(reason) {
  return ({ new_session: "新任务", baseline_unavailable: "重启后暂无上轮基线", system: "系统指令变化", tools: "工具定义变化", history_rewrite: "历史上下文被重写" })[reason] || "";
}

function deepSeekSavingsLabel(savings) {
  if (!savings?.enabled || !savings.applied) return "";
  return ` · 省钱模式节省约 ${formatCompactNumber(savings.estimatedTokensSaved)} Token`;
}

function deepSeekSavingsDetail(savings) {
  if (!savings?.enabled) return "";
  if (!savings.applied) {
    return savings.level === "below_threshold" ? "；DeepSeek 省钱模式未触发（上下文未达到 60%）" : "；DeepSeek 省钱模式未找到可安全缩短的旧工具输出";
  }
  return `；DeepSeek 省钱模式缩短 ${formatNumber(savings.prunedToolOutputs)} 条旧工具输出，估算减少 ${formatNumber(savings.estimatedTokensSaved)} Token；最近 ${formatNumber(savings.protectedRecentToolOutputs)} 条工具结果保持完整`;
}

function requestDetail(event) {
  const request = event.request || {};
  const diagnostics = event.diagnostics || {};
  const upstreamAttempts = diagnosticUpstreamAttempts(diagnostics);
  const retry = upstreamAttempts > 1 ? `；上游请求 ${upstreamAttempts} 次，原因 ${diagnostics.retryReason || "兼容重试"}` : `；上游请求 ${upstreamAttempts} 次`;
  const removed = diagnostics.removedTools?.length ? `；自动移除 ${diagnostics.removedTools.join(", ")}` : "";
  const cacheKey = diagnostics.cacheKey?.inboundPresent
    ? diagnostics.cacheKey.preserved ? "；缓存键原样保留" : "；缓存键未被上游保留"
    : "；客户端未提供缓存键";
  const identity = request.identityHash ? `；任务标识 ${request.identitySource} / ${request.identityHash}` : "；未检测到稳定任务标识";
  return `${contextLabel(event.contextMode)}${retry}${removed}；入口 ${formatNumber(request.inboundBytes)} 字节；工具 ${formatNumber(request.toolCount)} 个 / ${formatNumber(request.toolsBytes)} 字节${cacheKey}${identity}${cachePrefixDetail(diagnostics.cache)}${deepSeekSavingsDetail(diagnostics.savings)}`;
}

function diagnosticUpstreamAttempts(diagnostics) {
  if (diagnostics?.upstreamAttempts !== null && diagnostics?.upstreamAttempts !== undefined) return Number(diagnostics.upstreamAttempts) || 0;
  if (diagnostics?.attempts !== null && diagnostics?.attempts !== undefined) return Number(diagnostics.attempts) || 0;
  return 1;
}

function reasoningLabel(reasoning) {
  if (!reasoning?.selected && !reasoning?.sent) return "未设置";
  if (reasoning.selected && reasoning.sent && reasoning.selected !== reasoning.sent) return `${reasoning.selected} → ${reasoning.sent}`;
  return reasoning.sent || reasoning.selected || "未设置";
}

function reasoningDetail(reasoning) {
  if (!reasoning) return "本次请求没有推理强度信息";
  return `选择 ${reasoning.selected || "未设置"}；实际发送 ${reasoning.sent || "未发送"}；参数 ${reasoning.parameter || "none"}`;
}

function reasoningTransportLabel(transport) {
  return ({ responses: "Responses 原样传递", reasoning_effort: "Chat reasoning_effort", "reasoning.effort": "OpenRouter reasoning.effort", thinking_toggle: "思考开关", none: "不发送推理参数" })[transport] || "自动兼容";
}

function formatNumber(value) { return value === null || value === undefined ? "-" : new Intl.NumberFormat("zh-CN").format(value); }
function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${formatNumber(Math.round(bytes))} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function formatCompactNumber(value) { return value === null || value === undefined ? "-" : new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatTime(value) { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
