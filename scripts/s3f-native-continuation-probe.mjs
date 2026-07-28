import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadSettings } from "../src/store.js";
import {
  createChatHistory,
  forwardResponses,
  recordPassthroughResponse,
  responseContextMode,
  responseDiagnostics,
  responseHistoryInfo,
  routeForRequest,
} from "../src/router.js";

const PHASES = [
  { group: "off", round: 1 },
  { group: "off", round: 2 },
  { group: "on", round: 1 },
  { group: "on", round: 2 },
];

const FIRST_INPUT = { role: "user", content: [{ type: "input_text", text: "Reply with exactly RELAY_PROBE_A." }] };
const SECOND_INPUT = { role: "user", content: [{ type: "input_text", text: "Now reply with exactly RELAY_PROBE_B." }] };

export function writeProbeReportAtomic(reportPath, report) {
  const target = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
  return target;
}

export function sanitizeProbeRecord(value = {}) {
  return {
    status: finiteNumber(value.status),
    ok: value.ok === true,
    elapsedMs: finiteNumber(value.elapsedMs),
    responseBytes: finiteNumber(value.responseBytes),
    idHash: /^[a-f0-9]{16}$/.test(String(value.idHash || "")) ? String(value.idHash) : null,
    object: shortText(value.object, 40),
    responseStatus: shortText(value.responseStatus, 40),
    model: shortText(value.model, 120),
    usage: sanitizeUsage(value.usage),
    mode: shortText(value.mode, 80),
    diagnostics: sanitizeDiagnostics(value.diagnostics),
    outputTextMatched: value.outputTextMatched === true,
    toolCallCount: finiteNumber(value.toolCallCount) || 0,
    error: sanitizeError(value.error || value.transportError),
  };
}

export async function runProbePlan({ slotId, reportPath, executePhase, now = () => new Date().toISOString() }) {
  if (typeof executePhase !== "function") throw new TypeError("executePhase must be a function.");
  const report = {
    version: 1,
    kind: "s3f_native_continuation_probe",
    slotId: shortText(slotId, 120),
    startedAt: now(),
    updatedAt: null,
    status: "running",
    plannedLogicalRequests: PHASES.length,
    completedLogicalRequests: 0,
    observedUpstreamAttempts: 0,
    events: [],
  };

  const persist = () => {
    report.updatedAt = now();
    writeProbeReportAtomic(reportPath, report);
  };
  persist();

  let carry = null;
  for (const phase of PHASES) {
    report.events.push({ event: "request_started", group: phase.group, round: phase.round, at: now() });
    persist();
    try {
      const result = await executePhase({ ...phase, carry });
      const record = sanitizeProbeRecord(result?.record || result);
      report.events.push({ event: "request_finished", group: phase.group, round: phase.round, at: now(), record });
      report.completedLogicalRequests += 1;
      report.observedUpstreamAttempts += Math.max(1, record.diagnostics?.attempts || 1);
      carry = result?.carry ?? null;
      if (!record.ok || (phase.round === 1 && !standardCompleted(record))) {
        report.status = "stopped";
        report.stopReason = !record.ok ? "request_failed" : "standard_response_missing";
        persist();
        return report;
      }
      persist();
    } catch (error) {
      report.events.push({ event: "request_failed", group: phase.group, round: phase.round, at: now(), error: sanitizeError(error) });
      report.status = "inconclusive";
      report.stopReason = "execution_error";
      persist();
      return report;
    }
  }

  report.status = "completed";
  persist();
  return report;
}

export function defaultProbeReportPath(slotId, root = path.join(os.homedir(), "AppData", "Local", "Codex Relay", "probes")) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeSlot = String(slotId || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "unknown";
  return path.join(root, "s3f-native-continuation", `${stamp}-${safeSlot}.json`);
}

export async function runRealProbe({ slotId, reportPath = defaultProbeReportPath(slotId) }) {
  const settingsOff = loadSettings();
  const routeOff = routeForRequest(settingsOff, slotId);
  if (routeOff.kind !== "third_party" || routeOff.provider?.apiType !== "responses") {
    throw new Error("S3-F probe requires a configured third-party Responses slot.");
  }
  const settingsOn = structuredClone(settingsOff);
  const providerOn = settingsOn.providers.find((provider) => provider.id === routeOff.providerId);
  if (!providerOn) throw new Error("S3-F probe provider is missing from settings.");
  providerOn.nativeResponseContinuation = true;
  const routeOn = routeForRequest(settingsOn, slotId);
  const histories = { off: createChatHistory(), on: createChatHistory() };
  const firstResults = new Map();
  const taskHeaders = {
    off: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `s3f-${crypto.randomUUID()}` }) },
    on: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `s3f-${crypto.randomUUID()}` }) },
  };

  return runProbePlan({
    slotId,
    reportPath,
    executePhase: async ({ group, round }) => {
      const enabled = group === "on";
      const settings = enabled ? settingsOn : settingsOff;
      const route = enabled ? routeOn : routeOff;
      const history = histories[group];
      const first = firstResults.get(group);
      const body = round === 1
        ? { model: slotId, input: [FIRST_INPUT], stream: false }
        : { model: slotId, input: [FIRST_INPUT, ...(first?.json?.output || []), SECOND_INPUT], stream: false };
      if (round === 2 && !Array.isArray(first?.json?.output)) throw new Error("First response output is unavailable.");
      const expected = round === 1 ? "RELAY_PROBE_A" : "RELAY_PROBE_B";
      const startedAt = Date.now();
      let response;
      try {
        response = await forwardResponses({ settings, route, body, headers: taskHeaders[group], history });
      } catch (error) {
        return { record: { ok: false, elapsedMs: Date.now() - startedAt, error } };
      }
      const text = await response.text();
      const json = parseJson(text);
      const record = responseRecord(response, text, json, expected, startedAt);
      const carry = { json, text };
      if (round === 1 && record.ok) {
        firstResults.set(group, carry);
        recordPassthroughResponse(history, body, route, text, taskHeaders[group], responseHistoryInfo(response) || {});
      }
      return { record, carry };
    },
  });
}

function responseRecord(response, text, json, expected, startedAt) {
  const outputText = responseOutputText(json);
  return {
    status: response.status,
    ok: response.ok,
    elapsedMs: Date.now() - startedAt,
    responseBytes: Buffer.byteLength(text),
    idHash: typeof json?.id === "string" ? crypto.createHash("sha256").update(json.id).digest("hex").slice(0, 16) : null,
    object: json?.object,
    responseStatus: json?.status,
    model: json?.model,
    usage: json?.usage,
    mode: responseContextMode(response),
    diagnostics: responseDiagnostics(response),
    outputTextMatched: outputText.trim() === expected,
    toolCallCount: Array.isArray(json?.output) ? json.output.filter((item) => /(?:function|custom|tool)_call/.test(String(item?.type || ""))).length : 0,
  };
}

function responseOutputText(json) {
  if (!Array.isArray(json?.output)) return "";
  return json.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function standardCompleted(record) {
  return record.ok && record.object === "response" && record.responseStatus === "completed" && Boolean(record.idHash);
}

function sanitizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    inputTokens: finiteNumber(value.input_tokens),
    cachedInputTokens: finiteNumber(value.input_tokens_details?.cached_tokens),
    outputTokens: finiteNumber(value.output_tokens),
    reasoningTokens: finiteNumber(value.output_tokens_details?.reasoning_tokens),
    totalTokens: finiteNumber(value.total_tokens),
  };
}

function sanitizeDiagnostics(value) {
  if (!value || typeof value !== "object") return null;
  return {
    attempts: finiteNumber(value.attempts),
    retryReason: shortText(value.retryReason, 100),
    inboundBytes: finiteNumber(value.inboundBytes),
    upstreamBytes: finiteNumber(value.upstreamBytes),
    relayAddedBytes: finiteNumber(value.relayAddedBytes),
    replayBytes: finiteNumber(value.replayBytes),
    nativeContinuation: value.nativeContinuation && typeof value.nativeContinuation === "object" ? {
      applied: value.nativeContinuation.applied === true,
      reason: shortText(value.nativeContinuation.reason, 100),
      priorItems: finiteNumber(value.nativeContinuation.priorItems),
      incrementalItems: finiteNumber(value.nativeContinuation.incrementalItems),
    } : null,
  };
}

function sanitizeError(value) {
  const text = value instanceof Error ? value.message : String(value || "");
  if (!text) return null;
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-|sess-|key-)[A-Za-z0-9._-]{12,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .slice(0, 240);
}

function shortText(value, limit) {
  const text = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

function parseArgs(argv) {
  const result = { execute: false, slotId: "", reportPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") result.execute = true;
    else if (value === "--slot") result.slotId = String(argv[++index] || "");
    else if (value === "--report") result.reportPath = String(argv[++index] || "");
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slotId) throw new Error("Usage: node scripts/s3f-native-continuation-probe.mjs --slot <slot-id> [--report <path>] --execute");
  const reportPath = args.reportPath ? path.resolve(args.reportPath) : defaultProbeReportPath(args.slotId);
  if (!args.execute) {
    const report = {
      version: 1,
      kind: "s3f_native_continuation_probe",
      slotId: args.slotId,
      status: "dry_run",
      plannedLogicalRequests: PHASES.length,
      reportPath,
      productionSettingsWritten: false,
    };
    writeProbeReportAtomic(reportPath, report);
    console.log(JSON.stringify(report));
    return;
  }
  const report = await runRealProbe({ slotId: args.slotId, reportPath });
  console.log(JSON.stringify({ status: report.status, reportPath: path.resolve(reportPath) }));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
