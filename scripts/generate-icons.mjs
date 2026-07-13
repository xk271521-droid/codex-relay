import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
const PUBLIC = path.join(ROOT, "public");
const VENDOR = path.join(PUBLIC, "vendor");
fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(VENDOR, { recursive: true });

const source = Buffer.from(`
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="104" fill="#20201f"/>
  <path d="M134 177h142c43 0 78 35 78 78s-35 78-78 78H166" fill="none" stroke="#f06a3c" stroke-width="42" stroke-linecap="round"/>
  <path d="M193 123l-66 54 66 54M319 279l66 54-66 54" fill="none" stroke="#f7f7f5" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const size of sizes) {
  const target = path.join(ASSETS, `icon-${size}.png`);
  await sharp(source).resize(size, size).png().toFile(target);
  pngs.push(target);
}
const appIcon = path.join(ASSETS, "icon.png");
await sharp(source).resize(512, 512).png().toFile(appIcon);
await sharp(source).resize(32, 32).png().toFile(path.join(ASSETS, "tray.png"));
fs.writeFileSync(path.join(ASSETS, "icon.ico"), await pngToIco(pngs));
fs.copyFileSync(appIcon, path.join(PUBLIC, "icon.png"));
fs.copyFileSync(
  path.join(ROOT, "node_modules", "lucide", "dist", "umd", "lucide.min.js"),
  path.join(VENDOR, "lucide.min.js"),
);
