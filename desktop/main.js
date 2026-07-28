import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayServer } from "../src/server.js";
import { ROUTER_HOST, ROUTER_PORT } from "../src/constants.js";
import { paths, relayApplicationStatus } from "../src/store.js";
import { closeCcSwitchForHandoff } from "../src/external-processes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_URL = `http://${ROUTER_HOST}:${ROUTER_PORT}`;
const WINDOW_ICON = path.join(ROOT, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");
const gotLock = app.requestSingleInstanceLock();

let mainWindow;
let tray;
let ownedServer;
let quitting = false;
let closeNoticeShown = false;

if (!gotLock) app.quit();

app.setName("Codex Relay");
if (app.isPackaged) app.setAppUserModelId("io.codexrelay.desktop");

app.on("second-instance", async () => {
  await enforceRelayOwnership();
  showWindow();
});

app.whenReady().then(async () => {
  registerDesktopBridge();
  await ensureRouter();
  await enforceRelayOwnership();
  createTray();
  createWindow();
}).catch((error) => {
  dialog.showErrorBox("Codex Relay 无法启动", error.message || String(error));
  app.quit();
});

app.on("activate", () => showWindow());

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  requestQuit();
});

app.on("window-all-closed", (event) => event?.preventDefault?.());

async function ensureRouter() {
  const existing = await currentHealth();
  if (existing?.ok) {
    if (existing.app !== "codex-relay") throw new Error(`端口 ${ROUTER_PORT} 已被旧版 Router 或其他程序占用。请先关闭旧程序，再启动 Codex Relay。`);
    return;
  }

  ownedServer = createRelayServer();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(new Error(`本地 Router 启动失败：${error.message}`));
    ownedServer.once("error", onError);
    ownedServer.listen(ROUTER_PORT, ROUTER_HOST, () => {
      ownedServer.off("error", onError);
      resolve();
    });
  });
}

async function currentHealth() {
  try {
    const response = await fetch(`${APP_URL}/health`, { signal: AbortSignal.timeout(900) });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function enforceRelayOwnership() {
  if (!relayApplicationStatus().configMatches) return { active: false, closed: 0 };
  try {
    const handoff = await closeCcSwitchForHandoff();
    return { active: true, closed: handoff.closed || 0 };
  } catch (error) {
    console.error("Codex Relay could not close CC Switch while Relay is active: " + (error.message || error));
    return { active: true, closed: 0, error: error.message || String(error) };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Codex Relay",
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f7f7f5",
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(ROOT, "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(APP_URL);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (!closeNoticeShown && Notification.isSupported()) {
      closeNoticeShown = true;
      new Notification({ title: "Codex Relay 仍在运行", body: "窗口已隐藏到系统托盘，本地 Router 会继续服务 Codex。" }).show();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, "assets", "tray.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Codex Relay");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Codex Relay", click: showWindow },
    { type: "separator" },
    { label: "打开本地管理地址", click: () => shell.openExternal(APP_URL) },
    { label: "打开数据目录", click: () => shell.openPath(paths().appDir) },
    { type: "separator" },
    { label: "退出 Codex Relay", click: requestQuit },
  ]));
  tray.on("double-click", showWindow);
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function requestQuit() {
  if (quitting) return;
  const relayApplied = relayApplicationStatus().configMatches;
  if (relayApplied) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Relay 模式仍在生效",
      message: "退出后，本地 Router 将停止，Codex 中的 Relay 模型会暂时无法请求。",
      detail: "建议先在“安全与恢复”中退出 Relay 模式；也可以继续退出，稍后重新打开 Codex Relay 即可恢复 Router。",
      buttons: ["返回 Codex Relay", "仍然退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return;
  }

  quitting = true;
  tray?.destroy();
  if (ownedServer?.listening) await new Promise((resolve) => ownedServer.close(resolve));
  app.quit();
}

function registerDesktopBridge() {
  ipcMain.handle("desktop:get-info", () => ({
    version: app.getVersion(),
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    dataDirectory: paths().appDir,
  }));
  ipcMain.handle("desktop:set-launch-at-login", (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
    return { enabled: app.getLoginItemSettings().openAtLogin };
  });
  ipcMain.handle("desktop:open-data-folder", async () => {
    const error = await shell.openPath(paths().appDir);
    return { opened: !error, error: error || null };
  });
}
