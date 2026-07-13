const slotIds = ["relay-third-party-1", "relay-third-party-2", "relay-third-party-3", "relay-third-party-4", "relay-third-party-5"];
const state = { data: null, view: "home", editingSlot: null, editingProvider: null, desktop: null, applyMode: "apply", providerModels: new Map() };
const $ = (selector) => document.querySelector(selector);
const commonModels = [
  "deepseek-chat", "deepseek-reasoner",
  "gpt-5.4", "gpt-5.4-mini", "gpt-4.1", "gpt-4.1-mini",
  "kimi-k2.5", "kimi-k2-thinking", "kimi-k2-thinking-turbo",
  "qwen3-coder-plus", "qwen3-max", "qwen-plus", "qwen-turbo",
  "glm-4.7", "glm-4.7-flash", "glm-4.5-air",
  "MiniMax-M2.1", "MiniMax-M2.1-lightning",
];

bindStaticEvents();
lucide.createIcons();
initialize();

async function initialize() {
  if (window.codexRelayDesktop?.isDesktop) {
    document.querySelectorAll(".desktop-only").forEach((element) => { element.hidden = false; });
    try {
      state.desktop = await window.codexRelayDesktop.getInfo();
      $("#app-version").textContent = `Codex Relay ${state.desktop.version}`;
      $("#launch-at-login").checked = Boolean(state.desktop.launchAtLogin);
    } catch { /* Browser mode remains fully usable. */ }
  }
  await refresh();
}

function bindStaticEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll('[data-action="show-models"]').forEach((button) => button.addEventListener("click", () => showView("models")));
  document.querySelectorAll('[data-action="show-activity"]').forEach((button) => button.addEventListener("click", () => showView("activity")));
  document.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.dialogClose}`).close()));
  document.querySelectorAll('[data-action="restore"]').forEach((button) => button.addEventListener("click", openRestoreDialog));
  $("#apply-button").addEventListener("click", openApplyDialog);
  $("#verify-official").addEventListener("click", verifyOfficial);
  $("#check-sessions").addEventListener("click", checkSessions);
  $("#check-sessions-secondary").addEventListener("click", checkSessions);
  $("#add-provider").addEventListener("click", () => openProvider());
  $("#new-provider").addEventListener("click", () => openProvider());
  $("#provider-select").addEventListener("change", () => updateModelSuggestions());
  $("#slot-model").addEventListener("change", fillDisplayNameFromModel);
  $("#choose-model").addEventListener("click", openModelPicker);
  $("#load-models").addEventListener("click", loadProviderModels);
  $("#test-model").addEventListener("click", testProviderModel);
  $("#model-filter").addEventListener("input", renderModelOptions);
  $("#use-typed-model").addEventListener("click", useTypedModel);
  $("#model-form").addEventListener("submit", saveSlot);
  $("#provider-form").addEventListener("submit", saveProvider);
  $("#delete-model").addEventListener("click", deleteSlot);
  $("#delete-provider").addEventListener("click", deleteProvider);
  $("#persist-context").addEventListener("change", saveContextCachePreference);
  $("#launch-at-login").addEventListener("change", setLaunchAtLogin);
  $("#open-data-folder").addEventListener("click", openDataFolder);
  $("#restore-confirm").addEventListener("change", (event) => { $("#confirm-restore").disabled = !event.target.checked; });
  $("#apply-form").addEventListener("submit", applyRelay);
  $("#restore-form").addEventListener("submit", restoreOfficial);
}

async function refresh() {
  try {
    state.data = await api("/api/state");
    render();
  } catch (error) {
    setSidebarStatus("Router 不可用", "error");
    toast(error.message, true);
  }
}

function render() {
  const data = state.data;
  renderConnection(data);
  renderSlots(data);
  renderModels(data);
  renderProviders(data.providers);
  renderEvents(data.events);
  renderBalances(data.providers);
  renderSafety(data);
  lucide.createIcons();
}

function renderConnection(data) {
  const active = data.router.active;
  const external = data.connection.externalTakeover;
  const repairEligible = data.connection.repairEligible;
  const signedIn = data.official.login.signedIn;
  const configuredThirdParty = data.thirdPartySlots.length;
  const title = active
    ? "Relay 模式正在服务 Codex"
    : repairEligible
      ? "Relay 连接需要修复"
      : external
        ? "Codex 已由其他配置接管"
        : "Relay 已就绪，尚未应用到 Codex";
  const copy = active
    ? "官方请求直通官方服务，第三方请求按各自供应商配置转发。"
    : repairEligible
      ? "Relay 管理标记仍在，但连接配置发生了变化。确认后可只修复 Relay 管理的设置。"
    : external
      ? "当前配置可能来自 CC Switch、官方直连或手动设置。Codex Relay 不会自动覆盖它。"
      : "配置模型后启用 Relay，程序会先备份当前 Codex 状态并完成安全检查。";

  $("#relay-control-title").textContent = title;
  $("#relay-control-copy").textContent = copy;
  $("#mode-badge").textContent = active ? "已启用" : repairEligible ? "需要修复" : external ? "外部接管" : "未启用";
  $("#mode-badge").className = `mode-badge ${active ? "ready" : repairEligible ? "warning" : external ? "external" : ""}`;
  $("#connection-target").textContent = active ? "Codex Relay" : connectionLabel(data.connection);
  $("#official-account").textContent = signedIn ? "已登录" : "未登录";
  $("#available-models").textContent = `${data.routes.length} / 7`;
  $("#snapshot-state").textContent = data.snapshot ? "已创建" : "未创建";
  $("#apply-button span").textContent = active ? "更新 Relay" : repairEligible ? "修复 Relay" : external ? "重新启用 Relay" : "启用 Relay";
  $("#apply-button").disabled = false;
  $("#restore-top-button").disabled = !data.restorePreview?.available;
  $("#restore-button").disabled = !data.restorePreview?.available;

  $("#login-state").textContent = signedIn ? "已登录" : data.official.login.authType === "api_key" ? "API Key 模式" : "未登录";
  $("#login-state").className = `state-chip ${signedIn ? "safe" : ""}`;
  $("#login-summary").textContent = signedIn
    ? "两个官方槽位已加入模型栏。官方额度与插件状态请在 Codex 官方账号页面查看。"
    : `当前可使用 ${configuredThirdParty} 个第三方模型；稍后登录官方账号后会自动补上两个官方槽位。`;
  $("#official-capacity").textContent = `${signedIn ? 2 : 0} / 2`;
  $("#third-party-capacity").textContent = `${configuredThirdParty} / 5`;
  setSidebarStatus(active ? "Relay 正在运行" : "Router 已就绪", active ? "ready" : "");

  $("#official-usage").hidden = !signedIn;
  $("#official-plan").textContent = signedIn ? "官方账号" : "未登录";
  $("#official-five-hour").textContent = "由官方管理";
  $("#official-weekly").textContent = "由官方管理";
}

function renderSlots(data) {
  const officialRoutes = data.routes.filter((route) => route.kind === "official");
  const thirdPartyById = new Map(data.thirdPartySlots.map((slot) => [slot.id, slot]));
  const tiles = [0, 1].map((index) => {
    const route = officialRoutes[index];
    return route
      ? slotTile("官方", route.displayName, "shield-check", "official")
      : slotTile("官方", "未登录", "lock-keyhole", "empty");
  });
  for (const [index, id] of slotIds.entries()) {
    const slot = thirdPartyById.get(id);
    tiles.push(slot ? slotTile(`第三方 ${index + 1}`, slot.displayName, "route", "") : slotTile(`第三方 ${index + 1}`, "未配置", "plus", "empty"));
  }
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
    return `<div class="model-row"><span class="row-icon official"><i data-lucide="shield-check"></i></span><span class="row-title"><strong>${escapeHtml(name)}</strong><span>官方账号额度</span></span><span class="row-detail"><strong>${escapeHtml(route?.upstreamModel || "登录后自动显示")}</strong><span>Official Codex</span></span><span class="row-state ${route ? "ready" : "missing"}">${route ? "可用" : "未登录"}</span><span></span></div>`;
  }).join("");

  const byId = new Map(data.thirdPartySlots.map((slot) => [slot.id, slot]));
  $("#third-party-list").innerHTML = slotIds.map((id, index) => {
    const slot = byId.get(id);
    const provider = slot ? data.providers.find((item) => item.id === slot.providerId) : null;
    const ready = Boolean(slot && provider?.hasApiKey);
    return `<div class="model-row"><span class="row-icon"><i data-lucide="${slot ? "route" : "plus"}"></i></span><span class="row-title"><strong>${escapeHtml(slot?.displayName || `第三方槽位 ${index + 1}`)}</strong><span>${slot ? `槽位 ${index + 1}` : "未配置，不会写入 Codex"}</span></span><span class="row-detail"><strong>${escapeHtml(slot?.upstreamModel || "添加模型")}</strong><span>${escapeHtml(provider?.name || "未选择供应商")}</span></span><span class="row-state ${ready ? "ready" : "missing"}">${ready ? "可用" : slot ? "缺少 Key" : "空闲"}</span><button class="button quiet" data-edit-slot="${id}"><i data-lucide="${slot ? "pencil" : "plus"}"></i><span>${slot ? "编辑" : "添加"}</span></button></div>`;
  }).join("");
  document.querySelectorAll("[data-edit-slot]").forEach((button) => button.addEventListener("click", () => openSlot(button.dataset.editSlot)));
}

function renderProviders(providers) {
  $("#provider-list").innerHTML = providers.length ? providers.map((provider) => {
    const used = state.data.thirdPartySlots.filter((slot) => slot.providerId === provider.id).length;
    return `<div class="provider-row"><span class="row-icon"><i data-lucide="server"></i></span><span class="row-title"><strong>${escapeHtml(provider.name)}</strong><span>${provider.apiType === "responses" ? "Responses" : "Chat Completions"}</span></span><span class="row-detail"><strong title="${escapeHtml(provider.baseUrl)}">${escapeHtml(provider.baseUrl)}</strong><span>${used} 个模型使用</span></span><span class="row-state ${provider.hasApiKey ? "ready" : "missing"}">${provider.hasApiKey ? "Key 已保存" : "缺少 Key"}</span><span class="row-state">${escapeHtml(provider.authHeaderName)}</span><button class="button quiet" data-edit-provider="${escapeHtml(provider.id)}"><i data-lucide="pencil"></i><span>编辑</span></button></div>`;
  }).join("") : '<div class="empty-state">尚未添加供应商。先添加供应商，再配置第三方模型。</div>';
  document.querySelectorAll("[data-edit-provider]").forEach((button) => button.addEventListener("click", () => openProvider(providers.find((provider) => provider.id === button.dataset.editProvider))));
}

function renderBalances(providers) {
  const configured = providers.filter((provider) => provider.balanceUrl);
  const visible = configured.slice(0, 3);
  const more = configured.length - visible.length;
  $("#balance-list").innerHTML = configured.length ? `${visible.map((provider) => {
    const balance = provider.balanceSnapshot;
    const amount = balance ? formatBalance(balance) : "尚未查询";
    const detail = balance?.checkedAt ? `上次更新 ${formatTime(balance.checkedAt)}` : "配置余额地址后点击刷新";
    return `<div class="balance-row"><span class="row-icon"><i data-lucide="wallet-cards"></i></span><span class="row-title"><strong>${escapeHtml(provider.name)}</strong><span>${escapeHtml(detail)}</span></span><span class="balance-amount ${balance ? "ready" : ""}">${escapeHtml(amount)}</span><button class="button quiet" data-refresh-balance="${escapeHtml(provider.id)}"><i data-lucide="refresh-cw"></i><span>刷新余额</span></button></div>`;
  }).join("")}${more > 0 ? `<div class="balance-more">另有 ${more} 个供应商余额，可在“模型与供应商”中管理。</div>` : ""}` : '<div class="empty-state">还没有配置余额查询地址。可在供应商的“高级兼容设置”中添加。</div>';
  document.querySelectorAll("[data-refresh-balance]").forEach((button) => button.addEventListener("click", () => refreshProviderBalance(button)));
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
    toast(`余额已更新：${formatBalance(result.balance)}。`);
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

function renderEvents(events) {
  $("#event-list").innerHTML = events.length ? events.map((event) => `<div class="activity-row"><time>${formatTime(event.at)}</time><span class="event-name"><strong>${escapeHtml(event.route.displayName)}</strong><span>${escapeHtml(event.route.providerName || "Official Codex")} / ${escapeHtml(event.route.upstreamModel)}</span></span><span class="channel-badge ${event.route.kind === "official" ? "official" : ""}">${event.route.kind === "official" ? "官方" : "第三方"}</span><span class="status-code ${event.ok ? "ok" : "failed"}">${event.status}</span><span class="duration">${event.durationMs} ms</span><span class="token-usage">${usageLabel(event.usage)}</span></div>`).join("") : '<div class="empty-state">暂无请求记录。Token 只有在上游返回 usage 时才会显示。</div>';
}

function renderSafety(data) {
  $("#persist-context").checked = Boolean(data.contextCache?.persist);
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
    models: ["模型与供应商", "管理两个官方位置和五个第三方模型槽位。"],
    activity: ["请求记录", "确认显示名称、实际上游、状态、耗时与 Token。"],
    safety: ["安全与恢复", "管理聊天保护、上下文缓存和完整恢复。"],
  };
  document.querySelectorAll(".view").forEach((element) => { element.hidden = element.id !== `${view}-view`; });
  document.querySelectorAll(".nav-item").forEach((element) => element.classList.toggle("active", element.dataset.view === view));
  $("#view-title").textContent = labels[view][0];
  $("#view-description").textContent = labels[view][1];
}

function openSlot(id) {
  state.editingSlot = id;
  const existing = state.data.thirdPartySlots.find((slot) => slot.id === id);
  if (!state.data.providers.length) {
    toast("先添加供应商，再配置模型。", true);
    openProvider();
    return;
  }
  $("#model-dialog-title").textContent = existing ? "编辑模型" : "添加模型";
  $("#slot-id").value = id;
  $("#slot-name").value = existing?.displayName || "";
  $("#slot-model").value = existing?.upstreamModel || "";
  $("#slot-context").value = existing?.contextWindow || 128000;
  $("#slot-images").checked = Boolean(existing?.supportsImages);
  $("#provider-select").innerHTML = state.data.providers.map((provider) => `<option value="${escapeHtml(provider.id)}" ${provider.id === existing?.providerId ? "selected" : ""}>${escapeHtml(provider.name)}${provider.hasApiKey ? "" : "（缺少 Key）"}</option>`).join("");
  updateModelSuggestions();
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
  if (value.includes("openai")) return ["gpt-5.4", "gpt-5.4-mini", "gpt-4.1", "gpt-4.1-mini"];
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
  setModelStatus(`已选择 ${model}。可点击“测试模型”确认可用性。`);
}

function useTypedModel() {
  const model = $("#slot-model").value.trim();
  if (!model) return setModelStatus("请先输入上游模型 ID。", true);
  fillDisplayNameFromModel();
  $("#model-picker-dialog").close();
  setModelStatus(`将使用手动输入的 ${model}。建议先测试模型。`);
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
    const result = await api(`/api/providers/${encodeURIComponent(provider.id)}/test-model`, "POST", { model });
    const usage = result.usage?.total === null || result.usage?.total === undefined ? "上游未返回 Token" : `Token ${result.usage.total}`;
    setModelStatus(`模型可用，HTTP ${result.status}，${result.durationMs} ms，${usage}。`, false, true);
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

function openProvider(provider = null) {
  state.editingProvider = provider?.id || null;
  $("#provider-dialog-title").textContent = provider ? "编辑供应商" : "添加供应商";
  $("#provider-id").value = provider?.id || "";
  $("#provider-name").value = provider?.name || "";
  $("#provider-url").value = provider?.baseUrl || "";
  $("#provider-api").value = provider?.apiType || "chat_completions";
  $("#provider-endpoint").value = provider?.endpointUrl || "";
  $("#provider-model-list-url").value = provider?.modelListUrl || "";
  $("#provider-balance-url").value = provider?.balanceUrl || "";
  $("#provider-balance-path").value = provider?.balancePath || "";
  $("#provider-balance-currency").value = provider?.balanceCurrency || "";
  $("#provider-auth-header").value = provider?.authHeaderName || "authorization";
  $("#provider-auth-prefix").value = provider?.authHeaderPrefix ?? "Bearer ";
  $("#provider-extra-headers").value = Object.keys(provider?.extraHeaders || {}).length ? JSON.stringify(provider.extraHeaders, null, 2) : "";
  $("#provider-key").value = "";
  $("#provider-key").required = !provider;
  $("#provider-key").placeholder = provider?.hasApiKey ? "留空保留现有 Key" : "仅加密保存在本机";
  $("#delete-provider").hidden = !provider;
  $("#provider-dialog").showModal();
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
      endpointUrl: $("#provider-endpoint").value,
      modelListUrl: $("#provider-model-list-url").value,
      balanceUrl: $("#provider-balance-url").value,
      balancePath: $("#provider-balance-path").value,
      balanceCurrency: $("#provider-balance-currency").value,
      authHeaderName: $("#provider-auth-header").value,
      authHeaderPrefix: $("#provider-auth-prefix").value,
      extraHeaders: parseHeaders($("#provider-extra-headers").value),
    });
    if ($("#provider-key").value) await api(`/api/providers/${encodeURIComponent(provider.provider.id)}/key`, "POST", { apiKey: $("#provider-key").value });
    $("#provider-dialog").close();
    await refresh();
    toast("供应商已保存。API Key 仅加密保存在本机。");
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function saveSlot(event) {
  event.preventDefault();
  const button = $("#save-model");
  setButtonLoading(button, true);
  try {
    await api("/api/slots", "POST", { id: $("#slot-id").value, displayName: $("#slot-name").value, upstreamModel: $("#slot-model").value, providerId: $("#provider-select").value, contextWindow: Number($("#slot-context").value), supportsImages: $("#slot-images").checked });
    $("#model-dialog").close();
    await refresh();
    toast("模型已保存。启用或更新 Relay 后才会写入 Codex。");
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function deleteSlot() {
  if (!state.editingSlot || !confirm("清空这个第三方模型槽位？Relay 供应商和 Key 不会被删除。")) return;
  try {
    await api(`/api/slots/${encodeURIComponent(state.editingSlot)}`, "DELETE");
    $("#model-dialog").close();
    await refresh();
    toast("模型槽位已清空。更新 Relay 后会从 Codex 模型栏移除。");
  } catch (error) { toast(error.message, true); }
}

async function deleteProvider() {
  if (!state.editingProvider || !confirm("删除这个供应商及其本地加密 Key？")) return;
  try {
    await api(`/api/providers/${encodeURIComponent(state.editingProvider)}`, "DELETE");
    $("#provider-dialog").close();
    await refresh();
    toast("供应商已删除。");
  } catch (error) { toast(error.message, true); }
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

async function openApplyDialog() {
  try {
    const repairEligible = Boolean(state.data?.connection?.repairEligible);
    const externalTakeover = Boolean(state.data?.connection?.externalTakeover);
    state.applyMode = repairEligible ? "repair" : "apply";
    const preview = await api("/api/apply-preview");
    if (!preview.ready) return toast(preview.problems.join(" "), true);
    if (repairEligible) {
      $("#apply-copy").textContent = "检测到 Relay 管理的连接设置发生变化。修复只重写 Relay 管理块，不会替换最初的恢复快照。";
      $("#apply-preflight").innerHTML = [
        "确认当前配置仍带 Codex Relay 管理标记",
        "重新写入本地 Router 地址和当前可用模型",
        "核对已有会话文件，不改写聊天正文",
        "保留使用 Relay 前的原始恢复快照",
      ].map((item) => `<li>${escapeHtml(item)}</li>`).join("");
      $("#confirm-apply").textContent = "确认修复";
    } else {
      $("#apply-copy").textContent = externalTakeover
        ? "Codex 当前由其他配置接管。确认后会重新指向 Relay；已有恢复快照不会被覆盖。"
        : preview.createsHandoff
          ? "启用前会原样保存当前 Codex 配置和认证。只有主动恢复时才会退出 Relay。"
          : "Relay 已启用，本次更新不会覆盖最初的恢复快照。";
      $("#apply-preflight").innerHTML = [
        `写入 ${preview.routes.length} 个可用模型`,
        "检查 Router、模型目录、API Key 与 config.toml 可写性",
        "记录并核对已有会话文件，不改写聊天正文",
        `配置 Codex 使用 openai + ${preview.config.writes.includes("openai_base_url") ? "本地 Router" : "Relay"}`,
        preview.createsHandoff ? "创建本次使用 Relay 前的唯一恢复快照" : "保留现有恢复快照",
        "任一步失败都会自动回滚",
      ].map((item) => `<li>${escapeHtml(item)}</li>`).join("");
      $("#confirm-apply").textContent = externalTakeover ? "确认重新启用" : "确认启用";
    }
    $("#apply-dialog").showModal();
  } catch (error) { toast(error.message, true); }
}

async function applyRelay(event) {
  event.preventDefault();
  const button = $("#confirm-apply");
  setButtonLoading(button, true);
  try {
    const repairing = state.applyMode === "repair";
    const result = await api(repairing ? "/api/connection/repair" : "/api/apply", "POST");
    $("#apply-dialog").close();
    toast(repairing
      ? "Relay 连接已修复。请重新打开 Codex。"
      : result.handoffCreated
        ? "Relay 已启用并保存使用前状态。请重新打开 Codex。"
        : "Relay 配置已更新。请重新打开 Codex。", false, 7000);
    await refresh();
  } catch (error) { toast(error.message, true); }
  finally { setButtonLoading(button, false); }
}

async function openRestoreDialog() {
  try {
    const preview = await api("/api/restore-preview");
    if (!preview.available) return toast("Relay 当前未启用，没有可恢复的活动快照。", true);
    $("#restore-warning").hidden = !preview.configurationChanged;
    $("#restore-confirm").checked = false;
    $("#confirm-restore").disabled = true;
    $("#restore-dialog").showModal();
  } catch (error) { toast(error.message, true); }
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

async function checkSessions() {
  try {
    const result = await api("/api/session-inventory");
    if (!result.baseline) return toast("Relay 尚未启用，目前没有使用前会话基线。", true);
    if (!result.comparable) return toast("暂时无法核对会话文件；没有修改任何 Codex 数据。", true);
    if (result.same) return toast(`会话保护正常：${result.current.files.length} 个已有或新增会话文件可见。`);
    const issue = result.protection;
    toast(`会话保护异常：缺失 ${issue.missing.length}，截断 ${issue.truncated.length}，旧正文变化 ${issue.changedPrefix.length}。`, true, 9000);
  } catch (error) { toast(error.message, true); }
}

async function saveContextCachePreference(event) {
  try {
    const result = await api("/api/context-cache", "POST", { persist: event.target.checked });
    toast(result.persist ? "跨模型上下文已启用本机加密持久化。" : "跨模型上下文改为仅保留在本次运行中。");
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, true);
  }
}

async function setLaunchAtLogin(event) {
  try {
    const result = await window.codexRelayDesktop.setLaunchAtLogin(event.target.checked);
    event.target.checked = result.enabled;
    toast(result.enabled ? "已启用开机启动。" : "已关闭开机启动。");
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, true);
  }
}

async function openDataFolder() {
  const result = await window.codexRelayDesktop.openDataFolder();
  if (!result.opened) toast(result.error || "无法打开数据目录。", true);
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

function setButtonLoading(button, loading) {
  if (!button) return;
  button.disabled = loading;
  button.classList.toggle("loading", loading);
  if (loading) button.dataset.originalIcon = button.querySelector("svg")?.outerHTML || "";
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

function formatNumber(value) { return value === null || value === undefined ? "-" : new Intl.NumberFormat("zh-CN").format(value); }
function formatTime(value) { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
