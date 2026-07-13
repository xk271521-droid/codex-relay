import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDist = path.join(root, "node_modules", "electron", "dist");
const electronExecutable = path.join(electronDist, "electron.exe");

if (!fs.existsSync(electronExecutable)) {
  const install = spawnSync(process.execPath, [path.join(root, "node_modules", "electron", "install.js")], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (install.status !== 0 || !fs.existsSync(electronExecutable)) process.exit(install.status || 1);
}

const builder = path.join(root, "node_modules", "electron-builder", "cli.js");
const result = spawnSync(process.execPath, [builder, "--win", "portable", "nsis"], {
  cwd: root,
  env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: electronDist },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
