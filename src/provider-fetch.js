import { currentWindowsHttpsProxyAsync, fetchViaHttpProxy, normalizeHttpProxy } from "./official-fetch.js";

const NETWORK_MODES = new Set(["direct", "windows", "custom"]);

export function providerNetworkMode(provider) {
  const mode = String(provider?.networkMode || "direct").trim().toLowerCase();
  return NETWORK_MODES.has(mode) ? mode : "direct";
}

export function providerNetworkLabel(provider) {
  const mode = providerNetworkMode(provider);
  if (mode === "windows") return "Windows proxy";
  if (mode === "custom") return "custom proxy";
  return "direct connection";
}

export function normalizeProviderProxyUrl(value) {
  const normalized = normalizeHttpProxy(value);
  if (!normalized) return "";
  const parsed = new URL(normalized);
  if (parsed.username || parsed.password) return "";
  return parsed.toString();
}

export async function resolveProviderProxy(provider, windowsProxy) {
  const mode = providerNetworkMode(provider);
  if (mode === "direct") return "";
  if (mode === "custom") {
    const proxy = normalizeProviderProxyUrl(provider?.proxyUrl);
    if (proxy) return proxy;
    const error = new Error("The provider's custom proxy URL is invalid.");
    error.code = "PROVIDER_PROXY_INVALID";
    throw error;
  }
  const detected = windowsProxy === undefined ? await currentWindowsHttpsProxyAsync() : windowsProxy;
  return normalizeHttpProxy(detected);
}

export async function fetchProvider(provider, url, options = {}) {
  const proxy = await resolveProviderProxy(provider);
  if (!proxy) return fetch(url, options);
  return fetchViaHttpProxy(url, options, proxy);
}
