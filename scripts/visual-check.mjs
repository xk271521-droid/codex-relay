import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const endpoint = process.argv[2] || "http://127.0.0.1:9223";
const output = path.resolve(process.argv[3] || path.join(os.homedir(), "AppData", "Local", "Codex Relay", "checks", "visual"));
fs.mkdirSync(output, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();
const results = [];

for (const [name, width, height] of [["desktop", 1180, 780], ["minimum", 920, 640], ["narrow", 390, 760]]) {
  await page.setViewportSize({ width, height });
  await page.goto("http://127.0.0.1:15723/", { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  const layout = await page.evaluate(() => ({
    title: document.title,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    bodyHeight: document.body.scrollHeight,
    iconWidth: document.querySelector(".brand img")?.naturalWidth || 0,
    icons: document.querySelectorAll("svg.lucide").length,
    visibleDialogs: [...document.querySelectorAll("dialog")].filter((item) => item.open).length,
  }));
  results.push({ name, ...layout });
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
