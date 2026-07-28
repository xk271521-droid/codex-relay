export function themeRuntimeBootstrap(config, css, artDataUrl) {
  const stateKey = "__CODEX_RELAY_THEME_STATE__";
  const styleId = "codex-relay-theme-style";
  const chromeId = "codex-relay-theme-chrome";
  const fallbackId = "codex-relay-theme-fallback-actions";
  const homeUtilityClass = "cr-theme-home-utility";
  const rootClasses = [
    "codex-relay-skin",
    "cr-theme-light",
    "cr-theme-dark",
    "cr-theme-art-wide",
    "cr-theme-art-standard",
    "cr-theme-focus-left",
    "cr-theme-focus-center",
    "cr-theme-focus-right",
    "cr-theme-safe-left",
    "cr-theme-safe-center",
    "cr-theme-safe-right",
    "cr-theme-safe-none",
    "cr-theme-task-ambient",
    "cr-theme-task-banner",
    "cr-theme-task-off",
  ];
  const rootProperties = [
    "--cr-theme-art",
    "--cr-theme-art-position",
    "--cr-theme-focus-x",
    "--cr-theme-focus-y",
    "--cr-theme-accent",
    "--cr-theme-accent-ink",
    "--cr-theme-image-luma",
  ];
  const themeVersion = `${config.id}:12`;
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

  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value)));
  const luminance = (red, green, blue) => {
    const linear = [red, green, blue].map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const defaultProfile = {
    appearance: "light",
    accent: [16, 155, 144],
    focusX: 0.78,
    focusY: 0.44,
    aspect: 16 / 9,
    luma: 0.87,
    safeArea: "left",
  };
  const normalizeConfig = (value) => {
    const raw = value && typeof value === "object" ? value : {};
    const art = raw.art && typeof raw.art === "object" ? raw.art : {};
    const hasNumber = (candidate) =>
      (typeof candidate === "number" || (typeof candidate === "string" && candidate.trim() !== ""))
      && Number.isFinite(Number(candidate));
    const requestedAccent = typeof raw?.palette?.accent === "string" ? raw.palette.accent.trim() : "";
    const accent = /^(?:#[\da-f]{3,8}|(?:rgb|hsl|oklch|oklab)\([^;{}]{1,96}\))$/i.test(requestedAccent)
      ? requestedAccent
      : null;
    const appearance = ["auto", "light", "dark"].includes(raw.appearance) ? raw.appearance : "auto";
    const safeArea = ["auto", "left", "right", "center", "none"].includes(art.safeArea) ? art.safeArea : "auto";
    const taskMode = ["auto", "ambient", "banner", "off"].includes(art.taskMode) ? art.taskMode : "auto";
    const metadataRatio = Number(raw?.artMetadata?.ratio);
    return {
      appearance,
      safeArea,
      taskMode,
      focusX: hasNumber(art.focusX) ? clamp(art.focusX) : null,
      focusY: hasNumber(art.focusY) ? clamp(art.focusY) : null,
      accent,
      initialAspect: Number.isFinite(metadataRatio) && metadataRatio > 0 ? metadataRatio : null,
    };
  };

  const comma = artDataUrl.indexOf(",");
  const mime = /^data:([^;,]+)/.exec(artDataUrl)?.[1] || "image/png";
  const binary = atob(artDataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const artUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const normalizedConfig = normalizeConfig(config);
  let profile = { ...defaultProfile, aspect: normalizedConfig.initialAspect ?? defaultProfile.aspect };
  let samplingNativeShell = false;
  let observer = null;
  let timer = null;
  const scheduler = { timeout: null, refreshHome: false, refreshChrome: false };
  const metrics = { ensureRuns: 0, domRefreshes: 0, healthChecks: 0, imageAnalyses: 0 };
  const structure = { mainSurface: null, sidebar: null, home: null };

  const analyzeArt = () => new Promise((resolve) => {
    if (typeof Image !== "function") {
      resolve(defaultProfile);
      return;
    }
    const image = new Image();
    image.onload = () => {
      try {
        const width = 48;
        const height = Math.max(12, Math.round(width * image.naturalHeight / image.naturalWidth));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext?.("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas is unavailable");
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        const samples = [];
        const sampleMap = new Array(width * height);
        let count = 0;
        let totalRed = 0;
        let totalGreen = 0;
        let totalBlue = 0;
        let totalBrightness = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset + 3] < 96) continue;
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          const light = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
          const sample = { red, green, blue, light, index: offset / 4 };
          samples.push(sample);
          sampleMap[sample.index] = sample;
          totalRed += red;
          totalGreen += green;
          totalBlue += blue;
          totalBrightness += light;
          count += 1;
        }
        if (!count) throw new Error("Image contains no opaque pixels");
        const average = [totalRed / count, totalGreen / count, totalBlue / count];
        const averageBrightness = totalBrightness / count;
        const information = (start, end) => {
          let total = 0;
          let totalSquared = 0;
          let edges = 0;
          let edgeCount = 0;
          let sampleCount = 0;
          for (let y = 0; y < height; y += 1) {
            for (let x = start; x < end; x += 1) {
              const sample = sampleMap[y * width + x];
              if (!sample) continue;
              total += sample.light;
              totalSquared += sample.light * sample.light;
              sampleCount += 1;
              const left = x > start ? sampleMap[y * width + x - 1] : null;
              const above = y > 0 ? sampleMap[(y - 1) * width + x] : null;
              if (left) { edges += Math.abs(sample.light - left.light); edgeCount += 1; }
              if (above) { edges += Math.abs(sample.light - above.light); edgeCount += 1; }
            }
          }
          const mean = sampleCount ? total / sampleCount : 0;
          const variance = sampleCount ? Math.max(0, totalSquared / sampleCount - mean * mean) : 1;
          return Math.sqrt(variance) * 0.58 + (edgeCount ? edges / edgeCount : 1) * 0.42;
        };
        const zoneWidth = Math.max(1, Math.floor(width * 0.38));
        const leftInformation = information(0, zoneWidth);
        const rightInformation = information(width - zoneWidth, width);
        let safeArea = "center";
        if (leftInformation < rightInformation * 0.86) safeArea = "left";
        else if (rightInformation < leftInformation * 0.86) safeArea = "right";
        let focusWeight = 0;
        let focusX = 0;
        let focusY = 0;
        let accentWeight = 0;
        const accent = [0, 0, 0];
        for (const sample of samples) {
          const x = sample.index % width;
          const y = Math.floor(sample.index / width);
          const difference = Math.sqrt(
            (sample.red - average[0]) ** 2
            + (sample.green - average[1]) ** 2
            + (sample.blue - average[2]) ** 2,
          ) / 441.7;
          const saliency = 0.03 + difference ** 1.35;
          focusX += (x / Math.max(1, width - 1)) * saliency;
          focusY += (y / Math.max(1, height - 1)) * saliency;
          focusWeight += saliency;
          const maximum = Math.max(sample.red, sample.green, sample.blue);
          const minimum = Math.min(sample.red, sample.green, sample.blue);
          const saturation = maximum ? (maximum - minimum) / maximum : 0;
          const usableLight = 1 - Math.min(1, Math.abs(sample.light - 0.46) / 0.54);
          const weight = saturation ** 2 * (0.15 + usableLight);
          accent[0] += sample.red * weight;
          accent[1] += sample.green * weight;
          accent[2] += sample.blue * weight;
          accentWeight += weight;
        }
        const resolvedAccent = accentWeight > 1
          ? accent.map((channel) => Math.round(channel / accentWeight))
          : average.map((channel) => Math.round(channel));
        let resolvedFocusX = clamp(focusX / Math.max(0.01, focusWeight));
        if (safeArea === "left") resolvedFocusX = Math.max(0.64, resolvedFocusX);
        if (safeArea === "right") resolvedFocusX = Math.min(0.36, resolvedFocusX);
        resolve({
          appearance: averageBrightness >= 0.58 ? "light" : "dark",
          accent: resolvedAccent,
          focusX: resolvedFocusX,
          focusY: clamp(focusY / Math.max(0.01, focusWeight)),
          aspect: image.naturalWidth / Math.max(1, image.naturalHeight),
          luma: clamp(averageBrightness),
          safeArea,
        });
      } catch {
        resolve(defaultProfile);
      }
    };
    image.onerror = () => resolve(defaultProfile);
    image.src = artUrl;
  });

  const detectShellAppearance = () => {
    const root = document.documentElement;
    const body = document.body;
    const classes = `${root?.className || ""} ${body?.className || ""}`
      .toLowerCase()
      .replace(/\bcr-theme-(?:dark|light)\b/g, "");
    if (/\b(dark|electron-dark|theme-dark|appearance-dark)\b/.test(classes)) return "dark";
    if (/\b(light|electron-light|theme-light|appearance-light)\b/.test(classes)) return "light";
    const dataTheme = (
      root?.getAttribute?.("data-theme")
      || root?.getAttribute?.("data-appearance")
      || root?.getAttribute?.("data-color-mode")
      || body?.getAttribute?.("data-theme")
      || body?.getAttribute?.("data-appearance")
      || ""
    ).toLowerCase();
    if (dataTheme.includes("dark")) return "dark";
    if (dataTheme.includes("light")) return "light";
    try {
      const hadSkin = root?.classList?.contains?.("codex-relay-skin");
      const saved = hadSkin ? rootClasses.filter((className) => root.classList.contains(className)) : [];
      samplingNativeShell = true;
      if (hadSkin) root.classList.remove(...rootClasses);
      try {
        const colorScheme = getComputedStyle(root).colorScheme || "";
        if (colorScheme.includes("dark") && !colorScheme.includes("light")) return "dark";
        if (colorScheme.includes("light") && !colorScheme.includes("dark")) return "light";
      } finally {
        if (hadSkin) root.classList.add(...saved);
        observer?.takeRecords?.();
        samplingNativeShell = false;
      }
    } catch {
      samplingNativeShell = false;
    }
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
    catch { return "light"; }
  };

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

  const applyProfile = (root) => {
    const focusX = normalizedConfig.focusX ?? profile.focusX;
    const focusY = normalizedConfig.focusY ?? profile.focusY;
    const appearance = normalizedConfig.appearance === "auto" ? detectShellAppearance() : normalizedConfig.appearance;
    const focus = focusX < 0.4 ? "left" : focusX > 0.6 ? "right" : "center";
    const safeArea = normalizedConfig.safeArea === "auto"
      ? (profile.safeArea || (focus === "left" ? "right" : focus === "right" ? "left" : "center"))
      : normalizedConfig.safeArea;
    const taskMode = normalizedConfig.taskMode === "auto"
      ? (profile.aspect >= 2.25 ? "banner" : "ambient")
      : normalizedConfig.taskMode;
    const accent = normalizedConfig.accent || `rgb(${profile.accent.join(" ")})`;
    const accentInk = luminance(...profile.accent) > 0.42 ? "rgb(31 42 42)" : "rgb(250 252 250)";
    root.classList.toggle("cr-theme-light", appearance === "light");
    root.classList.toggle("cr-theme-dark", appearance === "dark");
    root.classList.toggle("cr-theme-art-wide", profile.aspect >= 1.75);
    root.classList.toggle("cr-theme-art-standard", profile.aspect < 1.75);
    for (const value of ["left", "center", "right"]) root.classList.toggle(`cr-theme-focus-${value}`, focus === value);
    for (const value of ["left", "center", "right", "none"]) root.classList.toggle(`cr-theme-safe-${value}`, safeArea === value);
    for (const value of ["ambient", "banner", "off"]) root.classList.toggle(`cr-theme-task-${value}`, taskMode === value);
    root.style.setProperty("--cr-theme-art", `url("${artUrl}")`);
    root.style.setProperty("--cr-theme-art-position", `${Math.round(focusX * 100)}% ${Math.round(focusY * 100)}%`);
    root.style.setProperty("--cr-theme-focus-x", String(focusX));
    root.style.setProperty("--cr-theme-focus-y", String(focusY));
    root.style.setProperty("--cr-theme-accent", accent);
    root.style.setProperty("--cr-theme-accent-ink", accentInk);
    root.style.setProperty("--cr-theme-image-luma", profile.luma.toFixed(3));
    return { appearance, focus, safeArea, taskMode };
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

  const iconPaths = [
    ["M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3z", "M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"],
    ["M7 7.5L12 5l5 2.5v6L12 16l-5-2.5z", "M12 10v6", "M7 7.5l5 2.5 5-2.5"],
    ["M6 18L18 6", "M8 6h10v10", "M6 11v7h7"],
    ["M8 9h8", "M9 5l1 2", "M15 5l-1 2", "M7 13h10", "M8 17h8", "M7 10v5a5 5 0 0010 0v-5"],
  ];
  const createIcon = (index) => {
    const wrapper = document.createElement("span");
    wrapper.className = "cr-theme-fallback-action-icon";
    wrapper.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const data of iconPaths[index] || iconPaths[0]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", data);
      svg.appendChild(path);
    }
    wrapper.appendChild(svg);
    return wrapper;
  };

  const ensureFallbackActions = (home) => {
    const native = home?.querySelector('.group\\/home-suggestions, [class*="home-suggestions"]');
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
      config.cards.forEach(([titleText, description, prompt], index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cr-theme-fallback-action";
        const text = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = titleText;
        const small = document.createElement("small");
        small.textContent = description;
        text.append(strong, small);
        button.append(createIcon(index), text);
        button.addEventListener("click", () => fillComposer(prompt));
        actions.appendChild(button);
      });
      stage.appendChild(actions);
    }
    return "fallback";
  };

  const findHome = () => document.querySelector('[role="main"]:has([data-feature="game-source"]), [role="main"]:has([data-testid="home-icon"])');

  const ensureChrome = (home) => {
    let chrome = document.getElementById(chromeId);
    if (!chrome || chrome.parentElement !== document.body) {
      chrome?.remove();
      chrome = document.createElement("div");
      chrome.id = chromeId;
      chrome.setAttribute("aria-hidden", "true");
      document.body.appendChild(chrome);
    }
    chrome.classList.toggle("cr-theme-home-shell", Boolean(home));
  };

  const reconcileHome = (home, mainSurface) => {
    const roleMains = [...document.querySelectorAll('[role="main"]')];
    for (const candidate of roleMains) {
      candidate.classList.toggle("cr-theme-home", candidate === home);
      candidate.classList.toggle("cr-theme-task", candidate !== home);
    }
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
    if (home) ensureFallbackActions(home);
    else document.getElementById(fallbackId)?.remove();
  };

  const clearThemeDom = () => {
    const root = document.documentElement;
    root?.classList.remove(...rootClasses);
    for (const property of rootProperties) root?.style.removeProperty(property);
    document.querySelectorAll(".cr-theme-home").forEach((element) => element.classList.remove("cr-theme-home"));
    document.querySelectorAll(".cr-theme-task").forEach((element) => element.classList.remove("cr-theme-task"));
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
    const resolved = applyProfile(root);
    const home = findHome();
    const structureChanged = structure.mainSurface !== mainSurface || structure.sidebar !== sidebar || structure.home !== home;
    if (structureChanged || refreshHome) {
      metrics.domRefreshes += 1;
      reconcileHome(home, mainSurface);
      structure.mainSurface = mainSurface;
      structure.sidebar = sidebar;
      structure.home = home;
    }
    if (structureChanged || refreshChrome || !document.getElementById(chromeId)) ensureChrome(home);
    structure.resolved = resolved;
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
    }, 120);
  };

  const relevantMutationSelector = '[role="main"], [data-feature="game-source"], [data-testid="home-icon"], [class*="home-suggestions"], [class*="_homeUtilityBar_"], .composer-surface-chrome';
  const containsRelevantNode = (node) => node?.nodeType === 1
    && (node.matches?.(relevantMutationSelector) || node.querySelector?.(relevantMutationSelector));
  const mutationNeedsRefresh = (records) => records.some((record) => {
    if (samplingNativeShell) return false;
    if (record.type === "attributes") return record.target === document.documentElement || record.target === document.body;
    const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
    if (!target?.closest) return false;
    if (target.closest(`#${chromeId}, #${fallbackId}`)) return false;
    if (target.closest('.composer-surface-chrome, [data-message-author-role], article')) return false;
    if (target.matches?.('[class*="home-suggestions"], [class*="_homeUtilityBar_"]')) return true;
    return [...record.addedNodes, ...record.removedNodes].some(containsRelevantNode);
  });

  const onResize = () => scheduleEnsure("resize");
  const snapshot = () => {
    const home = findHome();
    return {
      applied: true,
      themeId: config.id,
      engine: "codex-dream-skin-1.2.0-adapted",
      adaptive: true,
      profile: {
        appearance: structure.resolved?.appearance || normalizedConfig.appearance,
        focus: structure.resolved?.focus || "right",
        safeArea: structure.resolved?.safeArea || "left",
        taskMode: structure.resolved?.taskMode || "ambient",
        aspect: Number(profile.aspect.toFixed(3)),
        luma: Number(profile.luma.toFixed(3)),
      },
      markers: {
        shell: Boolean(document.querySelector("main.main-surface")),
        sidebar: Boolean(document.querySelector("aside.app-shell-left-panel")),
        composer: Boolean(document.querySelector(".composer-surface-chrome")),
        home: Boolean(home),
        hero: Boolean(home?.querySelector('[data-feature="game-source"]')),
        actions: home
          ? (document.getElementById(fallbackId) ? "fallback" : home.querySelector('.group\\/home-suggestions button, [class*="home-suggestions"] button') ? "native" : "missing")
          : "deferred",
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
    const root = document.documentElement;
    delete root?.dataset.codexRelayTheme;
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
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-theme", "data-appearance", "data-color-mode"],
  });
  timer = setInterval(() => ensure(), 5000);
  addEventListener("resize", onResize);
  window[stateKey] = { themeVersion, observer, timer, scheduler, artUrl, ensure, cleanup, snapshot, metrics, profile };
  window.__CODEX_RELAY_THEME_ID__ = config.id;
  window.__CODEX_RELAY_THEME_CLEANUP__ = cleanup;
  analyzeArt().then((result) => {
    const state = window[stateKey];
    if (state?.themeVersion !== themeVersion || window.__CODEX_RELAY_THEME_ID__ !== config.id) return;
    metrics.imageAnalyses += 1;
    profile = result;
    state.profile = result;
    ensure({ refreshHome: true });
  });
  return snapshot();
}
