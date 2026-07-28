import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-s4c1-"));
process.env.CODEX_RELAY_HOME = path.join(sandbox, "relay-data");
process.env.CODEX_HOME = path.join(sandbox, "codex-home");
process.env.CODEX_RELAY_DISABLE_EXTERNAL_PROCESS_CONTROL = "1";

const store = await import("../src/store.js");
const { createRelayServer, resetModelHealthForTests } = await import("../src/server.js");
const { shortCanonicalHash, thirdPartyResponsesCacheTrace } = await import("../src/cache-trace.js");
const { createChatHistory, forwardResponses, responseDiagnostics, routeForRequest } = await import("../src/router.js");

function settings(overrides = {}) {
  return {
    version: 1,
    router: { host: "127.0.0.1", port: 15723, running: false },
    official: { verified: false, lastCheckedAt: null },
    contextCache: { persist: false },
    deepSeekSavings: { enabled: false },
    providers: [{ id: "reference", name: "Reference", baseUrl: "http://127.0.0.1:19999/v1", apiType: "responses", note: "", extraHeaders: {} }],
    thirdPartySlots: [{ id: "relay-third-party-1", displayName: "Reference", providerId: "reference", upstreamModel: "reference-model", contextWindow: 128000, supportsImages: false, dropParams: [] }],
    ...overrides,
  };
}

function resetTestState() {
  resetModelHealthForTests();
  fs.rmSync(store.paths().appDir, { recursive: true, force: true });
  fs.rmSync(store.paths().codexConfig, { force: true });
  fs.rmSync(store.paths().codexAuth, { force: true });
}

function event(type, response) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
}

test("S4-C2 cache trace is canonical and does not retain request content", () => {
  const first = {
    instructions: "private instructions",
    tools: [{ name: "inspect", parameters: { type: "object", properties: { path: { type: "string" }, depth: { type: "number" } } } }],
    input: [{ role: "user", content: [{ type: "input_text", text: "private input" }] }],
    include: ["reasoning.encrypted_content"],
    model: "reference-model",
  };
  const reordered = {
    model: "reference-model",
    include: ["reasoning.encrypted_content"],
    input: [{ content: [{ text: "private input", type: "input_text" }], role: "user" }],
    tools: [{ parameters: { properties: { depth: { type: "number" }, path: { type: "string" } }, type: "object" }, name: "inspect" }],
    instructions: "private instructions",
  };
  const firstTrace = thirdPartyResponsesCacheTrace(first);
  const secondTrace = thirdPartyResponsesCacheTrace(reordered);
  assert.deepEqual(firstTrace, secondTrace);
  assert.match(firstTrace.bodyHash, /^[a-f0-9]{16}$/);
  assert.equal(firstTrace.bodyHash, shortCanonicalHash(first));
  assert.equal(firstTrace.instructionsHash.length, 16);
  assert.equal(firstTrace.toolsHash.length, 16);
  assert.equal(firstTrace.inputHash.length, 16);
  assert.equal(firstTrace.includeHash.length, 16);
  assert.equal(JSON.stringify(firstTrace).includes("private"), false);
});

test("S4-C2 traces only third-party Responses and never injects a request field", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url.endsWith("/chat/completions")) {
      response.end(JSON.stringify({ id: "chat_s4c2", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    response.end(JSON.stringify({ id: "resp_s4c2", object: "response", status: "completed", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    const configured = settings({
      official: { verified: true, lastCheckedAt: "2026-07-23T00:00:00.000Z" },
      providers: [
        { id: "responses", name: "Responses", baseUrl, apiType: "responses", note: "", extraHeaders: {} },
        { id: "chat", name: "Chat", baseUrl, apiType: "chat_completions", note: "", extraHeaders: {} },
      ],
      thirdPartySlots: [
        { id: "responses-slot", displayName: "Responses", providerId: "responses", upstreamModel: "responses-model", contextWindow: 128000, supportsImages: false, dropParams: [] },
        { id: "chat-slot", displayName: "Chat", providerId: "chat", upstreamModel: "chat-model", contextWindow: 128000, supportsImages: false, dropParams: [] },
      ],
    });
    store.saveProviderKey("responses", "responses-key");
    store.saveProviderKey("chat", "chat-key");
    fs.mkdirSync(path.dirname(store.paths().codexAuth), { recursive: true });
    fs.writeFileSync(store.paths().codexAuth, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "official-s4c2-key", refresh_token: "official-refresh", account_id: "official-account" } }), "utf8");
    assert.equal(store.captureOfficialAuth().captured, true);

    const responsesRoute = routeForRequest(configured, "responses-slot");
    const responses = await forwardResponses({
      settings: configured,
      route: responsesRoute,
      body: { model: responsesRoute.id, instructions: "private Responses instruction", input: "private Responses input", stream: false },
      headers: {},
      history: createChatHistory(),
    });
    await responses.text();
    assert.ok(responseDiagnostics(responses).cacheTrace);

    const chatRoute = routeForRequest(configured, "chat-slot");
    const chat = await forwardResponses({
      settings: configured,
      route: chatRoute,
      body: { model: chatRoute.id, instructions: "private Chat instruction", input: "private Chat input", stream: false },
      headers: {},
      history: createChatHistory(),
    });
    assert.equal(responseDiagnostics(chat).cacheTrace, undefined);

    const official = await forwardResponses({
      settings: configured,
      route: { id: "official-s4c2", kind: "official", upstreamModel: "official-model", contextWindow: 128000 },
      body: { model: "official-s4c2", instructions: "private Official instruction", input: "private Official input", stream: false },
      headers: {},
      history: createChatHistory(),
      officialBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    });
    await official.text();
    assert.equal(responseDiagnostics(official).cacheTrace, undefined);
    assert.equal(received.length, 3);
    assert.ok(received.every((request) => request.body.cache_trace === undefined));
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});

test("S4-C1 CC-derived Responses contract preserves request shape, SSE, headers, and diagnostics", async () => {
  resetTestState();
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });

    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      connection: "x-upstream-hop",
      "x-upstream-hop": "must-not-reach-client",
      "x-request-id": "cc-diff-request-1",
      "openai-processing-ms": "17",
      "x-ratelimit-remaining-requests": "42",
    });
    response.write(event("response.created", { id: "resp_s4c1", status: "in_progress" }).slice(0, 31));
    setTimeout(() => {
      response.write(event("response.created", { id: "resp_s4c1", status: "in_progress" }).slice(31));
      response.end(`${event("response.completed", {
        id: "resp_s4c1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
        usage: { input_tokens: 21, input_tokens_details: { cached_tokens: 13 }, output_tokens: 3, total_tokens: 24 },
      })}data: [DONE]\n\n`);
    }, 15);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    store.replaceSettings(settings({
      router: { host: "127.0.0.1", port: relay.address().port, running: true },
      providers: [{ id: "reference", name: "Reference", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiType: "responses", note: "", extraHeaders: {} }],
    }));
    store.saveProviderKey("reference", "provider-reference-key");

    const response = await fetch(`http://127.0.0.1:${relay.address().port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer client-placeholder",
        "x-client-trace": "s4c1-fixed-case",
        "x-codex-turn-state": "must-not-reach-upstream",
      },
      body: JSON.stringify({
        model: "relay-third-party-1",
        instructions: "Use the tool when needed.",
        input: [
          { role: "developer", content: [{ type: "input_text", text: "Keep answers grounded." }] },
          { role: "user", content: [{ type: "input_text", text: "Inspect the target." }] },
        ],
        tools: [{ type: "function", name: "inspect_target", description: "Inspect one target", parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } }],
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "s4c1-stable-cache-key",
        reasoning: { effort: "high" },
        stream: true,
        store: false,
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^text\/event-stream/i);
    assert.equal(response.headers.get("x-request-id"), "cc-diff-request-1");
    assert.equal(response.headers.get("openai-processing-ms"), "17");
    assert.equal(response.headers.get("x-ratelimit-remaining-requests"), "42");
    assert.equal(response.headers.get("x-upstream-hop"), null);
    assert.match(text, /response\.created/);
    assert.match(text, /response\.completed/);
    assert.match(text, /data: \[DONE\]/);

    assert.equal(received.length, 1);
    const upstreamRequest = received[0];
    assert.equal(upstreamRequest.headers.authorization, "Bearer provider-reference-key");
    assert.equal(upstreamRequest.headers.accept, "text/event-stream");
    assert.equal(upstreamRequest.headers["accept-encoding"], "identity");
    assert.equal(upstreamRequest.headers["x-client-trace"], "s4c1-fixed-case");
    assert.equal(upstreamRequest.headers["x-codex-turn-state"], undefined);
    assert.equal(upstreamRequest.body.model, "reference-model");
    assert.equal(upstreamRequest.body.prompt_cache_key, "s4c1-stable-cache-key");
    assert.equal(upstreamRequest.body.cache_trace, undefined);
    assert.deepEqual(upstreamRequest.body.tools.map((tool) => tool.name), ["inspect_target"]);
    assert.deepEqual(upstreamRequest.body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(upstreamRequest.body.input.map((item) => item.role), ["developer", "user"]);

    const state = await (await fetch(`http://127.0.0.1:${relay.address().port}/api/state`)).json();
    const recorded = state.events[0];
    assert.equal(recorded.status, 200);
    assert.equal(recorded.contextMode, "new");
    assert.equal(recorded.request.toolCount, 1);
    assert.equal(recorded.request.promptCacheKeyPresent, true);
    assert.equal(recorded.diagnostics.attempts, 1);
    assert.equal(recorded.diagnostics.cacheKey.preserved, true);
    assert.deepEqual(recorded.diagnostics.cacheTrace, thirdPartyResponsesCacheTrace(upstreamRequest.body));
    assert.equal(recorded.stream.detectedBy, "body_sniff");
    assert.ok(recorded.stream.headersMs >= 0);
    assert.ok(recorded.stream.firstChunkMs >= recorded.stream.headersMs);
    assert.ok(recorded.stream.chunks >= 2);
    assert.deepEqual(recorded.usage, { input: 21, cachedInput: 13, uncachedInput: 8, cacheReported: true, cacheHitRate: 61.9, output: 3, reasoningOutput: 0, total: 24 });
  } finally {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    resetTestState();
  }
});
