import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";

const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const LOCAL_PROXY_TIMEOUT_MS = 2_500;

// Windows proxy selection can change while Relay is running. Resolve it for
// each official request so changing SakuraCat's node never requires a Codex
// or Router restart. Third-party provider requests do not use this module.
export function currentWindowsHttpsProxy() {
  if (process.platform !== "win32") return "";
  try {
    const enabled = registryValue("ProxyEnable");
    if (!/^0x0+$/i.test(enabled || "")) return proxyForHttps(registryValue("ProxyServer"));
  } catch {
    // Direct networking remains the fallback if registry access is unavailable.
  }
  return "";
}

export function proxyForHttps(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!raw.includes("=")) return normalizeHttpProxy(raw);
  const entries = new Map();
  for (const item of raw.split(";")) {
    const [scheme, address] = item.split("=", 2);
    if (scheme && address) entries.set(scheme.trim().toLowerCase(), address.trim());
  }
  return normalizeHttpProxy(entries.get("https") || entries.get("http") || "");
}

export async function fetchOfficial(url, options = {}) {
  const proxy = options.proxyUrl === undefined ? currentWindowsHttpsProxy() : String(options.proxyUrl || "");
  if (!proxy || !String(url).startsWith("https://")) return requestResponse(url, options);
  try {
    return await requestResponse(url, options, new HttpConnectAgent(proxy));
  } catch (error) {
    // A closed local proxy should not permanently disable an account that can
    // reach the official service directly. Never retry after an HTTP response.
    if (!isLocalProxyConnectionError(error)) throw error;
    return requestResponse(url, options);
  }
}

class HttpConnectAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false });
    this.proxy = new URL(proxyUrl);
  }

  createConnection(options, callback) {
    let settled = false;
    const done = (error, socket) => {
      if (settled) return;
      settled = true;
      callback(error, socket);
    };
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    const transport = this.proxy.protocol === "https:" ? https : http;
    const connect = transport.request({
      hostname: this.proxy.hostname,
      port: Number(this.proxy.port) || (this.proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: { host: `${targetHost}:${targetPort}` },
      agent: false,
      servername: this.proxy.hostname,
    });
    connect.setTimeout(LOCAL_PROXY_TIMEOUT_MS, () => {
      const error = new Error("Local proxy connection timed out.");
      error.code = "ETIMEDOUT";
      connect.destroy(error);
    });
    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        const error = new Error(`Local proxy CONNECT returned ${response.statusCode}.`);
        error.code = "PROXY_CONNECT_FAILED";
        done(error);
        return;
      }
      if (head?.length) socket.unshift(head);
      const secureSocket = tls.connect({ socket, servername: options.servername || targetHost });
      secureSocket.once("secureConnect", () => done(null, secureSocket));
      secureSocket.once("error", (error) => done(error));
    });
    connect.once("error", (error) => done(error));
    connect.end();
  }
}

function requestResponse(rawUrl, options, agent) {
  const target = new URL(rawUrl);
  const body = options.body === undefined || options.body === null ? "" : String(options.body);
  const headers = { ...(options.headers || {}) };
  if (body && !headerValue(headers, "content-length")) headers["content-length"] = String(Buffer.byteLength(body));
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: Number(target.port) || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers,
      agent,
    }, (incoming) => resolve(toResponse(incoming)));
    const abort = () => request.destroy(abortError());
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    request.once("error", (error) => reject(error));
    request.end(body);
  });
}

function toResponse(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers || {})) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, String(value));
  }
  return new Response(Readable.toWeb(incoming), { status: incoming.statusCode || 502, statusText: incoming.statusMessage || "", headers });
}

function registryValue(name) {
  const output = execFileSync("reg.exe", ["query", INTERNET_SETTINGS_KEY, "/v", name], { encoding: "utf8", windowsHide: true, timeout: 2_000 });
  const line = output.split(/\r?\n/).find((item) => new RegExp(`^\\s*${name}\\s+`, "i").test(item));
  if (!line) return "";
  const parts = line.trim().split(/\s{2,}/);
  return parts.at(-1)?.trim() || "";
}

function normalizeHttpProxy(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function headerValue(headers, expected) {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === expected)?.[1];
}

function isLocalProxyConnectionError(error) {
  return ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "PROXY_CONNECT_FAILED"].includes(error?.code);
}

function abortError() {
  const error = new Error("The request was cancelled.");
  error.name = "AbortError";
  return error;
}
