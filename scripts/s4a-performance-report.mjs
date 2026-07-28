import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { buildPerformanceBaseline } from "../src/performance-baseline.js";

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

const databasePath = options.database || path.join(os.homedir(), ".codex-relay", "request-history.sqlite");
if (!fs.existsSync(databasePath)) throw new Error(`Request history database does not exist: ${databasePath}`);

const database = new DatabaseSync(databasePath, { readOnly: true });
let rows;
try {
  rows = database.prepare("SELECT event_json FROM request_history ORDER BY id DESC LIMIT ?").all(options.limit);
} finally {
  database.close();
}

const events = rows.map((row) => {
  try { return JSON.parse(row.event_json); }
  catch { return null; }
}).filter(Boolean);
const report = buildPerformanceBaseline(events, options);
const output = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) fs.writeFileSync(path.resolve(options.output), output, "utf8");
else process.stdout.write(output);

function parseArguments(argumentsList) {
  const result = { limit: 1_000, help: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") { result.help = true; continue; }
    if (argument === "--third-party") { result.routeKind = "third_party"; continue; }
    const name = argument.replace(/^--/, "");
    if (!argument.startsWith("--") || !["database", "output", "from", "to", "route-kind", "route", "provider", "model", "limit"].includes(name)) throw new Error(`Unknown argument: ${argument}`);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    index += 1;
    if (name === "limit") result.limit = Math.min(10_000, Math.max(1, Number.parseInt(value, 10) || 1_000));
    else if (name === "route-kind") result.routeKind = value;
    else if (name === "route") result.routeId = value;
    else if (name === "provider") result.providerId = value;
    else result[name] = value;
  }
  for (const field of ["from", "to"]) {
    if (result[field] && !Number.isFinite(Date.parse(result[field]))) throw new Error(`Invalid ISO timestamp for --${field}: ${result[field]}`);
  }
  if (result.routeKind && !["official", "third_party"].includes(result.routeKind)) throw new Error(`Invalid route kind: ${result.routeKind}`);
  return result;
}

function helpText() {
  return [
    "Usage: npm run report:s4a -- [filters]",
    "",
    "Reads the local sanitized request history and prints JSON. It does not contact any upstream.",
    "",
    "  --third-party          Include only third-party routes",
    "  --route-kind KIND     Filter by official or third_party",
    "  --route ID            Filter by Relay route ID",
    "  --provider ID         Filter by provider ID",
    "  --model ID            Filter by upstream model ID",
    "  --from ISO            Earliest event timestamp",
    "  --to ISO              Latest event timestamp",
    "  --limit N             Read at most N recent records (default 1000, max 10000)",
    "  --database PATH       Use another request-history SQLite database",
    "  --output PATH         Write JSON to a file instead of stdout",
    "",
  ].join("\n");
}
