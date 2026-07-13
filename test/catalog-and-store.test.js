import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-test-"));
process.env.CODEX_RELAY_HOME = path.join(sandbox, "relay-data");
process.env.CODEX_HOME = path.join(sandbox, "codex-home");

const { activeRoutes, buildModelCatalog } = await import("../src/catalog.js");
const store = await import("../src/store.js");
const { proxyForHttps } = await import("../src/official-fetch.js");
const { createChatHistory, forwardResponses, responseContextMode, routeForRequest } = await import("../src/router.js");
const { createRelayServer, officialUpstreamFailure, onboardingState, pipeEventStream } = await import("../src/server.js");
const { readJsonRequest } = await import("../src/request-body.js");

function settings(overrides = {}) {
  return {
    version: 1,
    router: { host: "127.0.0.1", port: 15723, running: false },
    official: { verified: false, lastCheckedAt: null },
    providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: "http://127.0.0.1:19999/v1", apiType: "chat_completions", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "DeepSeek V4", providerId: "deepseek", upstreamModel: "deepseek-v4", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    ...overrides,
  };
}

function settingsForOfficialRoute() {
  return settings({
    official: { verified: true, lastCheckedAt: "2026-07-12T00:00:00.000Z" },
    providers: [],
    thirdPartySlots: [],
  });
}

function resetTestState() {
  fs.rmSync(store.paths().appDir, { recursive: true, force: true });
  if (fs.existsSync(store.paths().codexConfig)) fs.rmSync(store.paths().codexConfig, { force: true });
  if (fs.existsSync(store.paths().codexAuth)) fs.rmSync(store.paths().codexAuth, { force: true });
  fs.rmSync(path.join(path.dirname(store.paths().codexConfig), "sessions"), { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(store.paths().codexConfig), "archived_sessions"), { recursive: true, force: true });
}

test("Windows proxy parsing follows the current HTTPS or HTTP system endpoint", () => {
  assert.equal(proxyForHttps("127.0.0.1:7897"), "http://127.0.0.1:7897/");
  assert.equal(proxyForHttps("http=127.0.0.1:7897;https=127.0.0.1:7898"), "http://127.0.0.1:7898/");
  assert.equal(proxyForHttps("socks=127.0.0.1:7897"), "");
});

function captureOfficialToken(token = "stored-official-access-token") {
  fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
  fs.writeFileSync(store.paths().codexAuth, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "test-id-token", access_token: token, refresh_token: "test-refresh-token", account_id: "test-account" },
  }), "utf8");
  assert.equal(store.captureOfficialAuth().captured, true);
  return token;
}

test("unverified users only receive configured third-party routes", () => {
  const routes = activeRoutes(settings());
  assert.equal(routes.length, 1);
  assert.equal(routes[0].displayName, "DeepSeek V4");
  assert.equal(buildModelCatalog(settings()).models[0].display_name, "DeepSeek V4");
});

test("compressed Codex requests are decoded before routing", async () => {
  const payload = Buffer.from(JSON.stringify({ model: "relay-third-party-1", input: "compressed" }));
  const request = Readable.from([zlib.gzipSync(payload)]);
  request.headers = { "content-encoding": "gzip" };
  assert.deepEqual(await readJsonRequest(request), { model: "relay-third-party-1", input: "compressed" });
});

test("dialog cancel controls bypass required-field validation", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal((html.match(/data-dialog-close=/g) || []).length, 10);
  assert.doesNotMatch(html, /<button[^>]+value="cancel"/);
  assert.match(html, /id="apply-button"[^>]*>[\s\S]*?<span>启用 Relay<\/span>/);
  assert.match(html, /id="restore-top-button" data-action="restore" disabled/);
  assert.match(html, /id="apply-dialog"/);
});

test("verified users receive two official routes plus configured third-party routes", () => {
  const configured = settings({ official: { verified: true, lastCheckedAt: "2026-07-12T00:00:00.000Z" } });
  const catalog = buildModelCatalog(configured);
  assert.equal(catalog.models.length, 3);
  assert.deepEqual(catalog.models.map((model) => model.display_name), ["5.6 Terra", "5.5", "DeepSeek V4"]);
});

test("a user who signs in after Relay starts automatically receives the two official slots", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const before = await (await fetch(`http://127.0.0.1:${port}/model-catalog.json`)).json();
    assert.deepEqual(before.models.map((model) => model.display_name), ["DeepSeek V4"]);

    captureOfficialToken("signed-in-after-start");
    const after = await (await fetch(`http://127.0.0.1:${port}/model-catalog.json`)).json();
    assert.deepEqual(after.models.map((model) => model.display_name), ["5.6 Terra", "5.5", "DeepSeek V4"]);
    assert.equal(store.loadSettings().official.verified, true);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("conversation protection allows append and archive moves but detects loss or truncation", () => {
  resetTestState();
  const active = path.join(store.paths().codexConfig, "..", "sessions", "2026", "07", "12");
  const archived = path.join(store.paths().codexConfig, "..", "archived_sessions");
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  const first = path.join(active, "rollout-first.jsonl");
  const second = path.join(active, "rollout-second.jsonl");
  fs.writeFileSync(first, '{"id":"first"}\n', "utf8");
  fs.writeFileSync(second, '{"id":"second"}\n', "utf8");
  const baseline = store.currentSessionInventory();

  fs.appendFileSync(first, '{"new":"message"}\n', "utf8");
  fs.renameSync(second, path.join(archived, path.basename(second)));
  assert.equal(store.verifySessionProtection(baseline).safe, true);

  fs.writeFileSync(first, "x", "utf8");
  const truncated = store.verifySessionProtection(baseline);
  assert.equal(truncated.safe, false);
  assert.deepEqual(truncated.truncated, ["rollout-first.jsonl"]);

  fs.rmSync(path.join(archived, path.basename(second)));
  const missing = store.verifySessionProtection(baseline);
  assert.equal(missing.safe, false);
  assert.deepEqual(missing.missing, ["rollout-second.jsonl"]);
});

test("Relay onboarding is independent from other switchers", () => {
  const config = { providerIdentity: "custom" };
  assert.equal(onboardingState(settings(), config, { signedIn: false }, { configMatches: false }).stage, "ready_third_party");
  assert.equal(onboardingState(settings({ official: { verified: true } }), config, { signedIn: false }, { configMatches: false }).stage, "ready_with_official");
  assert.equal(onboardingState(settings(), config, { signedIn: true }, { configMatches: false }).stage, "verify_official");
  assert.equal(onboardingState(settings(), config, { signedIn: false }, { configMatches: true }).stage, "relay_active");
});

test("apply replaces only managed root settings and restore returns the original file", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = [
    'model_provider = "custom"',
    'model = "old-model"',
    'openai_base_url = "https://example.invalid"',
    "",
    "[model_providers.custom]",
    'name = "Existing CC Switch provider"',
    'base_url = "https://old-provider.example/v1"',
    'wire_api = "responses"',
    "",
    "[desktop]",
    'localeOverride = "zh-CN"',
    "",
  ].join("\n");
  fs.writeFileSync(target, original, "utf8");

  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const applied = fs.readFileSync(target, "utf8");
  assert.match(applied, /^# BEGIN CODEX RELAY/m);
  assert.match(applied, /model_provider = "openai"/);
  assert.doesNotMatch(applied, /^model_provider = "custom"$/m);
  assert.match(applied, /openai_base_url = "http:\/\/127\.0\.0\.1:15723\/v1"/);
  assert.match(applied, /\[model_providers\.custom\][\s\S]*base_url = "https:\/\/old-provider\.example\/v1"/);
  assert.match(applied, /\[desktop\]/);
  assert.equal(store.relayHandoffSnapshot().providerIdentity, "custom");
  assert.equal(store.relayHandoffSnapshot().defaultModel, "old-model");

  const restored = store.restoreRelayHandoff();
  assert.equal(restored.verified, true);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("preflight reports the existing Codex provider and config writability", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'model_provider = "custom"\n', "utf8");
  const preflight = store.codexConfigPreflight();
  assert.equal(preflight.writable, true);
  assert.equal(preflight.configExists, true);
  assert.equal(preflight.providerIdentity, "custom");
});

test("Relay preserves the current handoff while it remains applied", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");
  const first = store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const snapshot = store.relayHandoffSnapshot();
  const second = store.applyRelayConfig({ model: "relay-third-party-2", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });

  assert.equal(first.handoff.created, true);
  assert.equal(second.handoff.created, false);
  assert.deepEqual(store.relayHandoffSnapshot(), snapshot);
  store.restorePreRelayState();
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("each new Relay session restores the exact state that existed before that session", () => {
  resetTestState();
  const config = store.paths().codexConfig;
  const auth = store.paths().codexAuth;
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const officialConfig = 'model_provider = "openai"\nmodel = "official-model"\n';
  const officialAuth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "official-token", refresh_token: "official-refresh" } });
  fs.writeFileSync(config, officialConfig, "utf8");
  fs.writeFileSync(auth, officialAuth, "utf8");
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const firstExit = store.restoreRelayHandoff();
  assert.equal(firstExit.verified, true);
  assert.equal(firstExit.authVerified, true);
  assert.equal(fs.readFileSync(config, "utf8"), officialConfig);
  assert.equal(fs.readFileSync(auth, "utf8"), officialAuth);
  assert.equal(store.restorePreview().available, false);

  const thirdPartyConfig = 'model_provider = "custom"\nmodel = "third-party-model"\n\n[model_providers.custom]\nbase_url = "https://relay.example/v1"\n';
  const thirdPartyAuth = JSON.stringify({ OPENAI_API_KEY: "third-party-api-key" });
  fs.writeFileSync(config, thirdPartyConfig, "utf8");
  fs.writeFileSync(auth, thirdPartyAuth, "utf8");
  store.applyRelayConfig({ model: "relay-third-party-2", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const secondExit = store.restoreRelayHandoff();
  assert.equal(secondExit.verified, true);
  assert.equal(secondExit.authVerified, true);
  assert.equal(fs.readFileSync(config, "utf8"), thirdPartyConfig);
  assert.equal(fs.readFileSync(auth, "utf8"), thirdPartyAuth);
});

test("a failed apply transaction restores the exact configuration that existed immediately before it", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n', "utf8");
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const workingRelayConfig = fs.readFileSync(target, "utf8");

  const pending = store.applyRelayConfig({ model: "relay-third-party-2", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1", deferCommit: true });
  assert.notEqual(fs.readFileSync(target, "utf8"), workingRelayConfig);
  const rollback = store.rollbackRelayConfig(pending.transaction);

  assert.equal(rollback.restored, true);
  assert.equal(fs.readFileSync(target, "utf8"), workingRelayConfig);
  assert.equal(store.relayApplicationStatus().configMatches, true);
});

test("a failed first apply leaves no false Relay applied marker", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "keep-me"\n\n[model_providers.custom]\nbase_url = "https://provider.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const pending = store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1", deferCommit: true });
  store.rollbackRelayConfig(pending.transaction);

  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(store.relayApplicationStatus().applied, false);
});

test("restore warns about configuration drift but still verifies the original snapshot", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  fs.appendFileSync(target, "\n# Changed by another tool while Relay was applied\n", "utf8");
  assert.equal(store.restorePreview().configurationChanged, true);
  const restored = store.restorePreRelayState();
  assert.equal(restored.configurationChanged, true);
  assert.equal(restored.verified, true);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("restore keeps configured providers, encrypted keys, context, and the original backup", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");
  const configured = settings();
  store.replaceSettings(configured);
  store.saveProviderKey("deepseek", "restore-preserved-key");
  const context = [{ id: "relay_restore", routeId: "relay-third-party-1", messages: [{ role: "user", content: "keep this context" }] }];
  store.saveContextCache(context);
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  const snapshot = store.relayHandoffSnapshot();

  const restored = store.restorePreRelayState();
  assert.equal(restored.verified, true);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.deepEqual(store.loadSettings().thirdPartySlots, configured.thirdPartySlots);
  assert.equal(store.providerKey("deepseek"), "restore-preserved-key");
  assert.deepEqual(store.loadContextCache(), context);
  assert.equal(store.relayHandoffSnapshot(), null);
  assert.equal(store.relayApplicationStatus().applied, false);
});

test("official credentials are encrypted separately from the active Relay handoff", () => {
  resetTestState();
  fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
  const apiKeyAuth = JSON.stringify({ OPENAI_API_KEY: "pre-relay-api-key" });
  const officialAuth = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "test-id-token", access_token: "test-access-token", refresh_token: "test-refresh-token", account_id: "test-account" },
  });
  fs.writeFileSync(store.paths().codexAuth, apiKeyAuth, "utf8");
  const config = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(store.paths().codexConfig, config, "utf8");
  store.captureRelayHandoff();

  fs.writeFileSync(store.paths().codexAuth, officialAuth, "utf8");
  assert.deepEqual(store.captureOfficialAuth(), { captured: true });
  assert.equal(store.hasOfficialAuthSnapshot(), true);
  assert.doesNotMatch(fs.readFileSync(store.paths().officialAuth, "utf8"), /test-access-token/);

  fs.writeFileSync(store.paths().codexAuth, apiKeyAuth, "utf8");
  const recovered = store.restoreSavedOfficialAuth();
  assert.equal(recovered.restored, true);
  assert.equal(store.codexLoginStatus().authType, "official");
  assert.equal(fs.readFileSync(store.paths().codexAuth, "utf8"), officialAuth);

  const restored = store.restorePreRelayState();
  assert.equal(restored.authRestored, true);
  assert.equal(restored.authVerified, true);
  assert.equal(fs.readFileSync(store.paths().codexAuth, "utf8"), apiKeyAuth);
});

test("official routing prefers a fresh Codex login and falls back to the encrypted snapshot", () => {
  resetTestState();
  const saved = captureOfficialToken("saved-official-access-token");
  fs.writeFileSync(store.paths().codexAuth, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "fresh-official-access-token", refresh_token: "fresh-refresh-token" },
  }), "utf8");
  assert.equal(store.officialAccessToken(), "fresh-official-access-token");

  fs.writeFileSync(store.paths().codexAuth, JSON.stringify({ OPENAI_API_KEY: "third-party-key" }), "utf8");
  assert.equal(store.officialAccessToken(), saved);
  assert.equal(store.officialAccountId(), "test-account");
});

test("restore before any apply does not modify Codex configuration", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  const untouched = 'model_provider = "custom"\nmodel = "keep-me"\n';
  fs.writeFileSync(target, untouched, "utf8");
  const result = store.restoreRelayHandoff();
  assert.equal(result.restored, false);
  assert.equal(fs.readFileSync(target, "utf8"), untouched);
});

test("restore removes Relay config when no config existed before apply", () => {
  resetTestState();
  const target = store.paths().codexConfig;
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  store.applyRelayConfig({ model: "relay-third-party-1", catalogPath: store.paths().catalog, routerUrl: "http://127.0.0.1:15723/v1" });
  assert.equal(fs.existsSync(target), true);
  store.restorePreRelayState();
  assert.equal(fs.existsSync(target), false);
});

test("provider secrets use an encrypted on-disk payload", () => {
  store.saveProviderKey("deepseek", "test-secret-value");
  assert.equal(store.providerKey("deepseek"), "test-secret-value");
  const raw = fs.readFileSync(store.paths().secrets, "utf8");
  assert.doesNotMatch(raw, /test-secret-value/);
});

test("history snapshots preserve route ownership for a restarted Relay", () => {
  const firstRelay = createChatHistory();
  firstRelay.record("relay_response_1", [{ role: "user", content: "keep this context" }], "relay-third-party-1");
  const restartedRelay = createChatHistory(firstRelay.snapshot());
  assert.equal(restartedRelay.routeFor("relay_response_1"), "relay-third-party-1");
  assert.deepEqual(restartedRelay.get("relay_response_1"), [{ role: "user", content: "keep this context" }]);
});

test("optional context cache is DPAPI-encrypted and can be removed", () => {
  const entries = [{ id: "relay_response_2", routeId: "relay-third-party-1", messages: [{ role: "user", content: "private cached context" }] }];
  store.saveContextCache(entries);
  assert.deepEqual(store.loadContextCache(), entries);
  assert.doesNotMatch(fs.readFileSync(store.paths().context, "utf8"), /private cached context/);
  store.clearContextCache();
  assert.equal(fs.existsSync(store.paths().context), false);
});

test("providers can use a full endpoint and a non-Bearer key header", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    received.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "provider_response", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  store.saveProviderKey("custom-auth", "provider-secret");
  const configured = settings({
    providers: [{ id: "custom-auth", name: "Custom", baseUrl: `http://127.0.0.1:${port}/v1`, endpointUrl: `http://127.0.0.1:${port}/custom/responses`, apiType: "responses", authHeaderName: "x-api-key", authHeaderPrefix: "", note: "", extraHeaders: { "x-tenant": "relay-test" } }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Custom", providerId: "custom-auth", upstreamModel: "custom-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  });
  const route = routeForRequest(configured, "relay-third-party-1");
  const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "hello" }, headers: {}, history: createChatHistory() });
  assert.equal(response.status, 200);
  assert.equal(received[0].url, "/custom/responses");
  assert.equal(received[0].headers["x-api-key"], "provider-secret");
  assert.equal(received[0].headers["x-tenant"], "relay-test");
  await new Promise((resolve) => upstream.close(resolve));
});

test("provider model discovery uses the saved provider credentials and returns model IDs", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer((request, response) => {
    received.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({ providers: [{ id: "discover", name: "Discover", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", authHeaderName: "x-api-key", authHeaderPrefix: "", extraHeaders: { "x-tenant": "relay" } }] }));
  store.saveProviderKey("discover", "discover-secret");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/discover/models`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.models, ["model-a", "model-b"]);
    assert.equal(received[0].url, "/v1/models");
    assert.equal(received[0].headers["x-api-key"], "discover-secret");
    assert.equal(received[0].headers["x-tenant"], "relay");
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("provider model discovery falls back to the v1 endpoint when the root address serves a web page", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/models") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>API Gateway</title>");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-sol" }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  store.replaceSettings(settings({ providers: [{ id: "gateway", name: "Gateway", baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiType: "responses", note: "", extraHeaders: {} }] }));
  store.saveProviderKey("gateway", "gateway-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/gateway/models`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(requests, ["/models", "/v1/models"]);
    assert.deepEqual(result.models, ["gpt-5.6-sol", "gpt-5.6-terra"]);
    assert.match(result.endpoint, /\/v1\/models$/);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("provider model discovery accepts a configured endpoint and nested model IDs", async () => {
  resetTestState();
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { available_models: [{ model_id: "vendor/one" }, { slug: "vendor/two" }, { code: "vendor/one" }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${upstream.address().port}/catalogue`;
  store.replaceSettings(settings({ providers: [{ id: "nested", name: "Nested", baseUrl: "http://127.0.0.1:1", modelListUrl: endpoint, apiType: "responses", note: "", extraHeaders: {} }] }));
  store.saveProviderKey("nested", "nested-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/nested/models`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.models, ["vendor/one", "vendor/two"]);
    assert.deepEqual(requests, ["/catalogue"]);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("a configured provider balance is fetched only when requested and retained locally", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer((request, response) => {
    received.push({ url: request.url, key: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { wallet: { remaining: "0.82", currency: "usd" } } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const balanceUrl = `http://127.0.0.1:${upstream.address().port}/wallet`;
  store.replaceSettings(settings({ providers: [{ id: "balance", name: "Balance", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, balanceUrl, balancePath: "data.wallet.remaining", balanceCurrency: "USD", apiType: "chat_completions", note: "", extraHeaders: {} }] }));
  store.saveProviderKey("balance", "balance-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(received.length, 0);
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/balance/balance`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.balance.amount, 0.82);
    assert.equal(result.balance.currency, "USD");
    assert.equal(received[0].url, "/wallet");
    assert.equal(received[0].key, "Bearer balance-key");
    assert.equal(store.loadSettings().providers[0].balanceSnapshot.amount, 0.82);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("provider model test sends the exact model ID without changing the saved slot", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const configured = settings({ providers: [{ id: "testable", name: "Testable", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }] });
  store.replaceSettings(configured);
  store.saveProviderKey("testable", "test-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/api/providers/testable/test-model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vendor/exact-model-2026" }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, { input: 2, output: 1, total: 3 });
    assert.equal(received[0].model, "vendor/exact-model-2026");
    assert.equal(received[0].max_tokens, 8);
    assert.deepEqual(store.loadSettings().thirdPartySlots, configured.thirdPartySlots);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("an unreachable provider returns a 502 while the local Router remains available", async () => {
  const heldPort = await new Promise((resolve) => {
    const holder = http.createServer();
    holder.listen(0, "127.0.0.1", () => {
      const port = holder.address().port;
      holder.close(() => resolve(port));
    });
  });
  store.replaceSettings(settings({
    router: { host: "127.0.0.1", port: 15723, running: true },
    providers: [{ id: "offline", name: "Offline provider", baseUrl: `http://127.0.0.1:${heldPort}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Offline", providerId: "offline", upstreamModel: "offline-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
  }));
  store.saveProviderKey("offline", "offline-test-key");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const failed = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "hello" }),
    });
    const failure = await failed.json();
    assert.equal(failed.status, 502);
    assert.equal(failure.error.code, "upstream_unreachable");

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("management writes reject foreign browser origins", async () => {
  resetTestState();
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/providers`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Must not save", baseUrl: "https://provider.example/v1" }),
    });
    const result = await response.json();
    assert.equal(response.status, 403);
    assert.equal(result.error.code, "origin_not_allowed");
    assert.equal(store.loadSettings().providers.length, 0);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("provider deletion is blocked while a model uses it and removes its key when unused", async () => {
  resetTestState();
  store.replaceSettings(settings());
  store.saveProviderKey("deepseek", "delete-me");
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const port = relay.address().port;
    const blocked = await fetch(`http://127.0.0.1:${port}/api/providers/deepseek`, { method: "DELETE" });
    assert.equal(blocked.status, 409);
    assert.equal(store.hasProviderKey("deepseek"), true);

    const cleared = await fetch(`http://127.0.0.1:${port}/api/slots/relay-third-party-1`, { method: "DELETE" });
    assert.equal(cleared.status, 200);
    const removed = await fetch(`http://127.0.0.1:${port}/api/providers/deepseek`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(store.loadSettings().providers.length, 0);
    assert.equal(store.hasProviderKey("deepseek"), false);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});

test("request records preserve normalized upstream token usage", async () => {
  resetTestState();
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "usage reply" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const upstreamPort = upstream.address().port;
    store.replaceSettings(settings({
      router: { host: "127.0.0.1", port: relay.address().port, running: true },
      providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
    }));
    store.saveProviderKey("deepseek", "usage-key");
    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay-third-party-1", input: "usage", stream: false }),
    });
    assert.equal(response.status, 200);
    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    assert.deepEqual(state.events[0].usage, { input: 3, output: 2, total: 5 });
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("apply commits Relay only after the local health and model catalog checks pass", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  store.saveProviderKey("deepseek", "apply-test-key");
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/apply`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.applied, true);
    assert.equal(result.verified, true);
    assert.match(fs.readFileSync(target, "utf8"), new RegExp(`base_url = "http://127\\.0\\.0\\.1:${port}/v1"`));
    assert.equal(store.relayApplicationStatus().configMatches, true);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("state reads never rewrite an external takeover and explicit repair does not steal it back", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  store.saveProviderKey("deepseek", "repair-test-key");
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const applied = await fetch(`http://127.0.0.1:${port}/api/apply`, { method: "POST" });
    assert.equal(applied.status, 200);
    fs.writeFileSync(target, 'model_provider = "custom"\nmodel = "overridden"\n\n[model_providers.custom]\nbase_url = "https://override.example/v1"\n', "utf8");

    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.connection.repaired, false);
    assert.equal(state.connection.externalTakeover, true);
    assert.match(fs.readFileSync(target, "utf8"), /https:\/\/override\.example\/v1/);

    const repairResponse = await fetch(`http://127.0.0.1:${port}/api/connection/repair`, { method: "POST" });
    const repair = await repairResponse.json();
    assert.equal(repairResponse.status, 409);
    assert.equal(repair.externalTakeover, true);
    assert.match(fs.readFileSync(target, "utf8"), /https:\/\/override\.example\/v1/);

    const restored = store.restorePreRelayState();
    assert.equal(restored.verified, true);
    assert.equal(fs.readFileSync(target, "utf8"), original);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("explicit repair restores a drifted configuration only while the Relay marker is still present", async () => {
  resetTestState();
  const port = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port, running: false } }));
  store.saveProviderKey("deepseek", "repair-test-key");
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "before-relay"\n\n[model_providers.custom]\nbase_url = "https://before.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(port, "127.0.0.1", resolve));
  try {
    const applied = await fetch(`http://127.0.0.1:${port}/api/apply`, { method: "POST" });
    assert.equal(applied.status, 200);
    const drifted = fs.readFileSync(target, "utf8").replace('model = "relay-third-party-1"', 'model = "relay-third-party-2"');
    fs.writeFileSync(target, drifted, "utf8");

    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.connection.repairEligible, true);
    assert.match(fs.readFileSync(target, "utf8"), /relay-third-party-2/);

    const repairedResponse = await fetch(`http://127.0.0.1:${port}/api/connection/repair`, { method: "POST" });
    const repaired = await repairedResponse.json();
    assert.equal(repairedResponse.status, 200);
    assert.equal(repaired.repaired, true);
    assert.match(fs.readFileSync(target, "utf8"), /model_provider = "openai"/);
    assert.match(fs.readFileSync(target, "utf8"), new RegExp(`openai_base_url = "http://127\\.0\\.0\\.1:${port}/v1"`));

    const restored = store.restorePreRelayState();
    assert.equal(restored.verified, true);
    assert.equal(fs.readFileSync(target, "utf8"), original);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("a failed local health check leaves the pre-apply Codex config untouched", async () => {
  resetTestState();
  const routerPort = await reservePort();
  let managerPort = await reservePort();
  while (managerPort === routerPort) managerPort = await reservePort();
  store.replaceSettings(settings({ router: { host: "127.0.0.1", port: routerPort, running: false } }));
  store.saveProviderKey("deepseek", "health-failure-key");
  const target = store.paths().codexConfig;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = 'model_provider = "custom"\nmodel = "stay-direct"\n\n[model_providers.custom]\nbase_url = "https://direct.example/v1"\n';
  fs.writeFileSync(target, original, "utf8");

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(managerPort, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${managerPort}/api/apply`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 503);
    assert.equal(result.error.code, "router_health_failed");
    assert.equal(fs.readFileSync(target, "utf8"), original);
    assert.equal(store.relayApplicationStatus().applied, false);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    resetTestState();
  }
});

test("direct Responses SSE is piped before the upstream stream completes", async () => {
  class FakeResponse extends EventEmitter {
    constructor() {
      super();
      this.writableEnded = false;
      this.chunks = [];
      this.firstWrite = new Promise((resolve) => { this.resolveFirstWrite = resolve; });
    }
    writeHead(status, headers) { this.status = status; this.headers = headers; }
    write(chunk) { this.chunks.push(Buffer.from(chunk)); this.resolveFirstWrite?.(); this.resolveFirstWrite = null; return true; }
    end() { this.writableEnded = true; }
  }
  const upstream = new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => controller.enqueue(new TextEncoder().encode("data: first\n\n")), 10);
      setTimeout(() => { controller.enqueue(new TextEncoder().encode("data: final\n\n")); controller.close(); }, 220);
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const result = new FakeResponse();
  const started = Date.now();
  const piping = pipeEventStream(result, upstream);
  await result.firstWrite;
  assert.ok(Date.now() - started < 150, "first SSE frame was buffered until completion");
  const completed = await piping;
  assert.equal(completed.error, false);
  assert.equal(completed.text, "data: first\n\ndata: final\n\n");
  assert.equal(result.writableEnded, true);
});

async function reservePort() {
  return new Promise((resolve) => {
    const holder = http.createServer();
    holder.listen(0, "127.0.0.1", () => {
      const port = holder.address().port;
      holder.close(() => resolve(port));
    });
  });
}

test("official model switching retains the official response chain", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_next", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken();
    const settings = settingsForOfficialRoute();
    const route = routeForRequest(settings, "gpt-5.5");
    const history = createChatHistory();
    history.record("resp_terra", [{ role: "user", content: "Continue the current task" }], "gpt-5.6-terra");
    const response = await forwardResponses({
      settings,
      route,
      body: { model: route.id, previous_response_id: "resp_terra", input: "Use the second official model" },
      headers: { authorization: "Bearer official-account-token" },
      history,
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    assert.equal(response.status, 200);
    assert.equal(responseContextMode(response), "official_native_continuation");
    assert.equal(received[0].previous_response_id, "resp_terra");
    assert.equal(received[0].input, "Use the second official model");
    assert.equal(received[0].model, "gpt-5.5");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official switching falls back to portable context only after an upstream rejection", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    if (received.length === 1) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "previous response belongs to another model" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_fallback", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    captureOfficialToken();
    const settings = settingsForOfficialRoute();
    const route = routeForRequest(settings, "gpt-5.5");
    const history = createChatHistory();
    history.record("resp_terra", [{ role: "user", content: "Original task" }, { role: "assistant", content: "Existing work" }], "gpt-5.6-terra");
    const response = await forwardResponses({
      settings,
      route,
      body: { model: route.id, previous_response_id: "resp_terra", input: "Continue with the second model" },
      headers: { authorization: "Bearer official-account-token" },
      history,
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    assert.equal(response.status, 200);
    assert.equal(responseContextMode(response), "official_fallback_replayed");
    assert.equal(received.length, 2);
    assert.equal(received[0].previous_response_id, "resp_terra");
    assert.equal(received[1].previous_response_id, undefined);
    assert.deepEqual(received[1].input.map((item) => item.content[0].text), ["Original task", "Existing work", "Continue with the second model"]);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("official routes never forward a third-party Authorization header", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    received.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_official", object: "response", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const officialToken = captureOfficialToken("official-access-token-only");
    const settings = settingsForOfficialRoute();
    const route = routeForRequest(settings, "gpt-5.6-terra");
    const response = await forwardResponses({
      settings,
      route,
      body: { model: route.id, input: "official request", stream: false },
      headers: { authorization: "Bearer third-party-api-key-must-not-leak", "x-api-key": "third-party-x-api-key-must-not-leak" },
      history: createChatHistory(),
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    assert.equal(response.status, 200);
    assert.equal(received[0].authorization, `Bearer ${officialToken}`);
    assert.equal(received[0]["chatgpt-account-id"], "test-account");
    assert.equal(received[0]["x-api-key"], undefined);
    assert.doesNotMatch(JSON.stringify(received[0]), /third-party-api-key/);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("an invalidated official token tells the user to sign in again instead of reporting a network failure", () => {
  const failure = officialUpstreamFailure(
    { kind: "official" },
    401,
    JSON.stringify({ error: { code: "token_invalidated", message: "Your authentication token has been invalidated." } }),
  );
  assert.equal(failure.code, "official_login_invalidated");
  assert.match(failure.message, /Sign in again/);
  assert.equal(officialUpstreamFailure({ kind: "third_party" }, 401, "token_invalidated"), null);
});

test("chat-completions routes isolate the provider key and retain a local response history", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: `reply-${received.length}` } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  store.saveProviderKey("deepseek", "provider-only-key");
  const configured = settings({ providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }] });
  const route = routeForRequest(configured, "relay-third-party-1");
  const history = createChatHistory();
  const first = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "first request", stream: false }, headers: { authorization: "Bearer official-token" }, history });
  const second = await forwardResponses({ settings: configured, route, body: { model: route.id, previous_response_id: first.id, input: "second request", stream: false }, headers: { authorization: "Bearer official-token" }, history });

  assert.equal(first.output_text, "reply-1");
  assert.equal(second.output_text, "reply-2");
  assert.equal(received[0].headers.authorization, "Bearer provider-only-key");
  assert.equal(received[0].headers["chatgpt-account-id"], undefined);
  assert.equal(received[0].body.model, "deepseek-v4");
  assert.doesNotMatch(JSON.stringify(received[0]), /official-token/);
  assert.deepEqual(received[1].body.messages.map((message) => message.content), ["first request", "reply-1", "second request"]);
  await new Promise((resolve) => upstream.close(resolve));
});

test("compacted tool output is made portable instead of sending an invalid standalone tool message", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "continued after compacting" } }], usage: {} }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("orphan-tool", "orphan-tool-key");
    const configured = settings({
      providers: [{ id: "orphan-tool", name: "Tool route", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Tool route", providerId: "orphan-tool", upstreamModel: "tool-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    await forwardResponses({
      settings: configured,
      route,
      body: { model: route.id, input: [{ type: "function_call_output", call_id: "call_missing_after_compaction", output: "file list: README.md" }], stream: false },
      headers: {},
      history: createChatHistory(),
    });
    assert.equal(received[0].messages[0].role, "user");
    assert.match(received[0].messages[0].content, /Codex tool output from an earlier compacted step/);
    assert.doesNotMatch(JSON.stringify(received[0].messages), /"role":"tool"/);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("long third-party Chat conversations retain task-critical recent context within the target window", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "continued" } }], usage: {} }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("bounded-chat", "bounded-key");
    const configured = settings({
      providers: [{ id: "bounded-chat", name: "Bounded chat", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Bounded chat", providerId: "bounded-chat", upstreamModel: "bounded-model", contextWindow: 8000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const history = createChatHistory();
    history.record("relay_long", [
      { role: "system", content: "Keep the user's coding task active." },
      { role: "user", content: "old ".repeat(9_000) },
      { role: "assistant", content: "Recent implementation result." },
      { role: "user", content: "The latest requirement is to preserve the task." },
    ], route.id);
    await forwardResponses({ settings: configured, route, body: { model: route.id, previous_response_id: "relay_long", input: "Continue now", stream: false }, headers: {}, history });
    const messages = received[0].messages;
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /Earlier conversation turns were omitted/);
    assert.ok(messages.some((message) => message.content === "Keep the user's coding task active."));
    assert.ok(messages.some((message) => message.content === "The latest requirement is to preserve the task."));
    assert.ok(messages.some((message) => message.content === "Continue now"));
    assert.equal(messages.some((message) => message.content.startsWith("old old old")), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("chat-completions streams the first token before the upstream response completes", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`);
    setTimeout(() => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " token" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    }, 220);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("streaming", "stream-key");
    const configured = settings({
      providers: [{ id: "streaming", name: "Streaming", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Streaming", providerId: "streaming", upstreamModel: "stream-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const route = routeForRequest(configured, "relay-third-party-1");
    const history = createChatHistory();
    const started = Date.now();
    const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "stream", stream: true }, headers: {}, history });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let firstTokenAt = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (firstTokenAt === null && text.includes('"delta":"first"')) firstTokenAt = Date.now() - started;
    }

    assert.ok(firstTokenAt !== null && firstTokenAt < 200, `first token arrived after ${firstTokenAt}ms`);
    assert.match(text, /response\.completed/);
    assert.doesNotMatch(text, /__assistantMessage/);
    assert.equal(history.snapshot().length, 1);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("streamed Chat Completions function calls remain available to Codex and local context", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const firstChunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "read_file", arguments: '{"path":' } }] } }] };
    const secondChunk = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }], usage: {} };
    response.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
    response.end(`data: ${JSON.stringify(secondChunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("tool-stream", "tool-key");
    const configured = settings({
      providers: [{ id: "tool-stream", name: "Tool stream", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Tool stream", providerId: "tool-stream", upstreamModel: "tool-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const history = createChatHistory();
    const route = routeForRequest(configured, "relay-third-party-1");
    const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "read", stream: true }, headers: {}, history });
    const text = await response.text();
    assert.match(text, /"type":"function_call"/);
    assert.match(text, /"name":"read_file"/);
    assert.deepEqual(history.snapshot()[0].messages.at(-1).tool_calls[0].function, { name: "read_file", arguments: '{"path":"README.md"}' });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("cancelling a streamed Chat Completions request closes the Relay response", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "working" } }] })}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = upstream.address().port;
    store.saveProviderKey("cancel-stream", "cancel-key");
    const configured = settings({
      providers: [{ id: "cancel-stream", name: "Cancel stream", baseUrl: `http://127.0.0.1:${port}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} }],
      thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Cancel stream", providerId: "cancel-stream", upstreamModel: "cancel-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    });
    const controller = new AbortController();
    const route = routeForRequest(configured, "relay-third-party-1");
    const response = await forwardResponses({ settings: configured, route, body: { model: route.id, input: "cancel", stream: true }, headers: {}, signal: controller.signal, history: createChatHistory() });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    const completed = await Promise.race([
      (async () => { while (!(await reader.read()).done) { /* drain */ } return true; })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(completed, true);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("switching routes replays visible history instead of leaking a foreign response id", async () => {
  const chatUpstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "first model reply" } }], usage: {} }));
  });
  const responsesRequests = [];
  const responsesUpstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    responsesRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_second_provider", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "second model reply" }] }] }));
  });
  await Promise.all([
    new Promise((resolve) => chatUpstream.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => responsesUpstream.listen(0, "127.0.0.1", resolve)),
  ]);
  const chatPort = chatUpstream.address().port;
  const responsesPort = responsesUpstream.address().port;
  store.saveProviderKey("chat", "chat-key");
  store.saveProviderKey("responses", "responses-key");
  const configured = settings({
    providers: [
      { id: "chat", name: "Chat Provider", baseUrl: `http://127.0.0.1:${chatPort}/v1`, apiType: "chat_completions", note: "", extraHeaders: {} },
      { id: "responses", name: "Responses Provider", baseUrl: `http://127.0.0.1:${responsesPort}/v1`, apiType: "responses", note: "", extraHeaders: {} },
    ],
    thirdPartySlots: [
      { id: "relay-third-party-1", displayName: "First", providerId: "chat", upstreamModel: "first-model", contextWindow: 128000, supportsImages: false, dropParams: [] },
      { id: "relay-third-party-2", displayName: "Second", providerId: "responses", upstreamModel: "second-model", contextWindow: 128000, supportsImages: false, dropParams: [] },
    ],
  });
  const history = createChatHistory();
  const firstRoute = routeForRequest(configured, "relay-third-party-1");
  const first = await forwardResponses({ settings: configured, route: firstRoute, body: { model: firstRoute.id, input: "first user message", stream: false }, headers: {}, history });
  const secondRoute = routeForRequest(configured, "relay-third-party-2");
  const second = await forwardResponses({ settings: configured, route: secondRoute, body: { model: secondRoute.id, previous_response_id: first.id, input: "second user message", stream: false }, headers: {}, history });

  assert.equal(second.status, 200);
  assert.equal(responsesRequests[0].previous_response_id, undefined);
  assert.deepEqual(responsesRequests[0].input.map((item) => item.content[0].text), ["first user message", "first model reply", "second user message"]);
  assert.equal(responsesRequests[0].model, "second-model");
  await Promise.all([new Promise((resolve) => chatUpstream.close(resolve)), new Promise((resolve) => responsesUpstream.close(resolve))]);
});
