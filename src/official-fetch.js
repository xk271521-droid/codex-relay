import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFile, execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const LOCAL_PROXY_TIMEOUT_MS = 2_500;
const WINDOWS_PROXY_CACHE_MS = 5_000;
const execFileAsync = promisify(execFile);
const connectAgents = new Map();
const forwardProxyAgents = new Map();
let windowsProxyCache = { value: "", expiresAt: 0, pending: null };

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

export async function currentWindowsHttpsProxyAsync() {
  if (process.platform !== "win32") return "";
  const now = Date.now();
  if (windowsProxyCache.expiresAt > now) return windowsProxyCache.value;
  if (windowsProxyCache.pending) return windowsProxyCache.pending;
  windowsProxyCache.pending = (async () => {
    let value = "";
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", INTERNET_SETTINGS_KEY], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2_000,
      });
      const values = registryValues(stdout);
      if (!/^0x0+$/i.test(values.get("proxyenable") || "")) value = proxyForHttps(values.get("proxyserver"));
    } catch {
      value = "";
    }
    windowsProxyCache = { value, expiresAt: Date.now() + WINDOWS_PROXY_CACHE_MS, pending: null };
    return value;
  })();
  return windowsProxyCache.pending;
}

export function officialWebSocketAgent(proxyUrl = currentWindowsHttpsProxy()) {
  const proxy = normalizeHttpProxy(proxyUrl);
  return proxy ? pooledConnectAgent(proxy) : undefined;
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

export function fetchViaHttpProxy(url, options = {}, proxyUrl) {
  const proxy = normalizeHttpProxy(proxyUrl);
  if (!proxy) {
    const error = new Error("A valid HTTP or HTTPS proxy URL is required.");
    error.code = "PROXY_URL_INVALID";
    throw error;
  }
  const target = new URL(url);
  const proxyOptions = withIdentityEncoding(options);
  if (target.protocol === "https:") return requestResponse(url, proxyOptions, pooledConnectAgent(proxy));
  if (target.protocol === "http:") return requestResponseViaForwardProxy(url, proxyOptions, proxy);
  const error = new Error(`Unsupported upstream protocol: ${target.protocol}`);
  error.code = "UPSTREAM_PROTOCOL_UNSUPPORTED";
  throw error;
}

class HttpConnectAgent extends https.Agent {
  constructor(proxyUrl, keepAlive = false) {
    super({ keepAlive, maxSockets: 32, maxFreeSockets: 8 });
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
    const headers = { host: `${targetHost}:${targetPort}` };
    const authorization = proxyAuthorization(this.proxy);
    if (authorization) headers["proxy-authorization"] = authorization;
    const connect = transport.request({
      hostname: this.proxy.hostname,
      port: Number(this.proxy.port) || (this.proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers,
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

function pooledConnectAgent(proxyUrl) {
  let agent = connectAgents.get(proxyUrl);
  if (agent) return agent;
  agent = new HttpConnectAgent(proxyUrl, true);
  connectAgents.set(proxyUrl, agent);
  while (connectAgents.size > 8) {
    const [oldestUrl, oldestAgent] = connectAgents.entries().next().value;
    connectAgents.delete(oldestUrl);
    oldestAgent.destroy();
  }
  return agent;
}

function requestResponse(rawUrl, options, agent) {
  const target = new URL(rawUrl);
  const body = options.body === undefined || options.body === null ? "" : String(options.body);
  const headers = { ...(options.headers || {}) };
  if (body && !headerValue(headers, "content-length")) headers["content-length"] = String(Buffer.byteLength(body));
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let incoming;
    let request;
    let abortListening = false;
    const cleanupAbort = () => {
      if (!abortListening) return;
      abortListening = false;
      options.signal?.removeEventListener("abort", abort);
    };
    const rejectRequest = (error) => {
      cleanupAbort();
      reject(error);
    };
    const abort = () => {
      cleanupAbort();
      const error = abortError();
      if (!request || request.destroyed) return reject(error);
      request.destroy(error);
    };
    request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: Number(target.port) || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers,
      agent,
    }, (response) => {
      incoming = response;
      incoming.once("end", cleanupAbort);
      incoming.once("close", cleanupAbort);
      incoming.once("error", cleanupAbort);
      resolve(toResponse(incoming));
    });
    request.once("error", rejectRequest);
    if (options.signal?.aborted) return abort();
    if (options.signal) {
      abortListening = true;
      options.signal.addEventListener("abort", abort, { once: true });
    }
    request.end(body);
  });
}

function requestResponseViaForwardProxy(rawUrl, options, proxyUrl) {
  const target = new URL(rawUrl);
  const proxy = new URL(proxyUrl);
  const body = options.body === undefined || options.body === null ? "" : String(options.body);
  const headers = { ...(options.headers || {}) };
  if (body && !headerValue(headers, "content-length")) headers["content-length"] = String(Buffer.byteLength(body));
  if (!headerValue(headers, "host")) headers.host = target.host;
  const authorization = proxyAuthorization(proxy);
  if (authorization && !headerValue(headers, "proxy-authorization")) headers["proxy-authorization"] = authorization;
  const transport = proxy.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let request;
    let abortListening = false;
    const cleanupAbort = () => {
      if (!abortListening) return;
      abortListening = false;
      options.signal?.removeEventListener("abort", abort);
    };
    const rejectRequest = (error) => {
      cleanupAbort();
      reject(error);
    };
    const abort = () => {
      cleanupAbort();
      const error = abortError();
      if (!request || request.destroyed) return reject(error);
      request.destroy(error);
    };
    request = transport.request({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
      path: target.toString(),
      method: options.method || "GET",
      headers,
      agent: pooledForwardProxyAgent(proxyUrl),
      servername: proxy.hostname,
    }, (response) => {
      response.once("end", cleanupAbort);
      response.once("close", cleanupAbort);
      response.once("error", cleanupAbort);
      resolve(toResponse(response));
    });
    request.once("error", rejectRequest);
    if (options.signal?.aborted) return abort();
    if (options.signal) {
      abortListening = true;
      options.signal.addEventListener("abort", abort, { once: true });
    }
    request.end(body);
  });
}

function pooledForwardProxyAgent(proxyUrl) {
  const proxy = new URL(proxyUrl);
  const key = proxy.toString();
  let agent = forwardProxyAgents.get(key);
  if (agent) return agent;
  const Agent = proxy.protocol === "https:" ? https.Agent : http.Agent;
  agent = new Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
  forwardProxyAgents.set(key, agent);
  while (forwardProxyAgents.size > 8) {
    const [oldestUrl, oldestAgent] = forwardProxyAgents.entries().next().value;
    forwardProxyAgents.delete(oldestUrl);
    oldestAgent.destroy();
  }
  return agent;
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

function registryValues(output) {
  const values = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([^\s]+)\s+REG_\w+\s+(.+)$/i);
    if (match) values.set(match[1].toLowerCase(), match[2].trim());
  }
  return values;
}

export function normalizeHttpProxy(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function withIdentityEncoding(options) {
  const headers = { ...(options.headers || {}) };
  if (!headerValue(headers, "accept-encoding")) headers["accept-encoding"] = "identity";
  return { ...options, headers };
}

function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return "";
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
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
