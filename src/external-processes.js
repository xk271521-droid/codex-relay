import { execFileSync, spawn } from "node:child_process";

const PROCESS_CONTROL_DISABLED = process.env.CODEX_RELAY_DISABLE_EXTERNAL_PROCESS_CONTROL === "1";

export function parseTaskListCsv(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^"((?:[^"]|"")*)","(\d+)"/))
    .filter(Boolean)
    .map((match) => ({ name: match[1].replace(/""/g, '"'), pid: Number(match[2]) }))
    .filter((item) => item.name && Number.isInteger(item.pid) && item.pid > 0);
}

export function classifyIntegrationProcesses(processes = []) {
  const normalized = Array.isArray(processes) ? processes : [];
  return {
    ccSwitch: normalized.filter((item) => /^cc[-_ ]?switch(?:\.exe)?$/i.test(String(item?.name || ""))),
    codex: normalized.filter((item) => /^(?:codex|chatgpt)(?:\.exe)?$/i.test(String(item?.name || ""))),
  };
}

export function externalProcessStatus({ listProcesses = listWindowsProcesses } = {}) {
  if (PROCESS_CONTROL_DISABLED) return emptyStatus();
  const classified = classifyIntegrationProcesses(listProcesses());
  return {
    ccSwitchRunning: classified.ccSwitch.length > 0,
    ccSwitchCount: classified.ccSwitch.length,
    ccSwitchPids: classified.ccSwitch.map((item) => item.pid),
    codexRunning: classified.codex.length > 0,
    codexCount: classified.codex.length,
  };
}

export async function closeCcSwitchForHandoff({
  listProcesses = listWindowsProcesses,
  terminate = terminateWindowsProcess,
  wait = delay,
  timeoutMs = 3_000,
  disabled = PROCESS_CONTROL_DISABLED,
} = {}) {
  if (disabled) return { detected: 0, closed: 0, forced: false, remaining: 0 };
  const initial = classifyIntegrationProcesses(listProcesses()).ccSwitch;
  if (!initial.length) return { detected: 0, closed: 0, forced: false, remaining: 0 };

  for (const process of initial) terminate(process.pid, false);
  let remaining = await waitForCcSwitchExit({ listProcesses, wait, timeoutMs });
  let forced = false;
  if (remaining.length) {
    forced = true;
    for (const process of remaining) terminate(process.pid, true);
    remaining = await waitForCcSwitchExit({ listProcesses, wait, timeoutMs: 2_000 });
  }
  if (remaining.length) {
    const error = new Error("CC Switch could not be closed before Relay took control of Codex.");
    error.code = "cc_switch_close_failed";
    throw error;
  }
  return {
    detected: initial.length,
    closed: initial.length,
    forced,
    remaining: 0,
    executablePaths: [...new Set(initial.map((item) => String(item.executablePath || "")).filter(Boolean))],
  };
}

export function listWindowsProcesses() {
  if (process.platform !== "win32") return [];
  try {
    const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ExecutablePath) | ConvertTo-Json -Compress';
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 7_000,
    });
    const parsed = JSON.parse(output || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      name: String(item?.Name || ""),
      pid: Number(item?.ProcessId),
      executablePath: String(item?.ExecutablePath || ""),
    })).filter((item) => item.name && Number.isInteger(item.pid) && item.pid > 0);
  } catch {
    return listWindowsProcessesFallback();
  }
}

export function reopenCcSwitchAfterRollback(handoff, { launch = launchDetached } = {}) {
  const paths = Array.isArray(handoff?.executablePaths) ? handoff.executablePaths : [];
  let reopened = 0;
  for (const executablePath of paths) {
    try {
      launch(executablePath);
      reopened += 1;
    } catch {
      // The Codex files are already restored. A relaunch failure is reported
      // through the returned count without masking the original apply error.
    }
  }
  return { attempted: paths.length, reopened };
}

function listWindowsProcessesFallback() {
  try {
    const output = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    return parseTaskListCsv(output);
  } catch {
    return [];
  }
}

function launchDetached(executablePath) {
  const child = spawn(executablePath, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function terminateWindowsProcess(pid, force) {
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  try {
    execFileSync("taskkill.exe", args, { windowsHide: true, timeout: 5_000, stdio: "ignore" });
  } catch {
    // A graceful close can fail for a tray-only process. The caller verifies
    // whether it exited and retries with /F only when required.
  }
}

async function waitForCcSwitchExit({ listProcesses, wait, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let remaining = classifyIntegrationProcesses(listProcesses()).ccSwitch;
  while (remaining.length && Date.now() < deadline) {
    await wait(120);
    remaining = classifyIntegrationProcesses(listProcesses()).ccSwitch;
  }
  return remaining;
}

function emptyStatus() {
  return { ccSwitchRunning: false, ccSwitchCount: 0, ccSwitchPids: [], codexRunning: false, codexCount: 0 };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
