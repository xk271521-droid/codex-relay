import crypto from "node:crypto";

const VALID_CHAT_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function buildChatToolContext(tools = [], input = []) {
  const context = {
    chatTools: [],
    chatNames: new Set(),
    responseToChat: new Map(),
    chatToResponse: new Map(),
  };
  for (const tool of [...tools, ...discoveredTools(input)]) appendTool(context, tool);
  return context;
}

export function chatToolCallFromResponse(item, context) {
  const responseName = responseToolName(item);
  const metadata = context?.responseToChat?.get(responseName) || inferredMetadata(item, responseName);
  const chatName = metadata.chatName || safeChatName(responseName);
  const callId = item.call_id || item.id || `call_${crypto.randomUUID()}`;
  const reasoningContent = reasoningText(item);
  if (item.type === "custom_tool_call") {
    return { id: callId, type: "function", function: { name: chatName, arguments: JSON.stringify({ input: item.input || "" }) }, ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) };
  }
  return {
    id: callId,
    type: "function",
    function: { name: chatName, arguments: jsonString(item.arguments ?? item.action ?? item.input ?? {}) },
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };
}

export function responseToolCallFromChat(call, context) {
  const chatName = String(call?.function?.name || call?.name || "");
  const metadata = context.chatToResponse.get(chatName) || { type: "function", name: chatName, responseName: chatName };
  const callId = call?.id || `call_${crypto.randomUUID()}`;
  const args = call?.function?.arguments ?? call?.arguments ?? "{}";
  if (metadata.type === "custom") {
    return {
      id: `ctc_${crypto.randomUUID()}`,
      type: "custom_tool_call",
      call_id: callId,
      name: metadata.name,
      input: customInput(args),
      status: "completed",
      ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
    };
  }
  if (metadata.type === "tool_search") {
    return {
      id: `ts_${crypto.randomUUID()}`,
      type: "tool_search_call",
      call_id: callId,
      arguments: jsonObject(args),
      execution: "client",
      status: "completed",
    };
  }
  return {
    id: `fc_${crypto.randomUUID()}`,
    type: "function_call",
    call_id: callId,
    name: metadata.name,
    arguments: jsonString(args),
    status: "completed",
    ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
  };
}

export function responseInputToChatMessages(input, context = buildChatToolContext([], input)) {
  const messages = [];
  let pendingReasoning = "";
  for (const item of Array.isArray(input) ? input : typeof input === "string" ? [{ role: "user", content: input }] : []) {
    if (!item || item.type === "additional_tools") continue;
    if (item.type === "reasoning") {
      pendingReasoning = joinReasoning(pendingReasoning, reasoningText(item));
      continue;
    }
    if (isToolCall(item)) {
      const call = chatToolCallFromResponse(item, context);
      const previous = messages.at(-1);
      const reasoningContent = joinReasoning(pendingReasoning, reasoningText(item), call.reasoning_content);
      delete call.reasoning_content;
      if (previous?.role === "assistant") {
        if (!Array.isArray(previous.tool_calls)) previous.tool_calls = [];
        previous.tool_calls.push(call);
        attachReasoning(previous, reasoningContent);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
      }
      pendingReasoning = "";
      continue;
    }
    if (isToolOutput(item)) {
      messages.push({ role: "tool", tool_call_id: item.call_id || item.id, content: textValue(item.output ?? item.result ?? "") });
      continue;
    }
    const role = item.role === "developer" ? "system" : item.role || "user";
    const content = textValue(item.content);
    if (content) {
      const message = { role, content };
      if (role === "assistant") {
        attachReasoning(message, joinReasoning(pendingReasoning, reasoningText(item)));
        pendingReasoning = "";
      }
      messages.push(message);
    }
  }
  if (pendingReasoning && messages.at(-1)?.role === "assistant") attachReasoning(messages.at(-1), pendingReasoning);
  return messages;
}

function appendTool(context, tool, namespace = "") {
  if (!tool || typeof tool !== "object") return;
  if (tool.type === "namespace") {
    const nested = namespacePrefix(tool.name || namespace);
    for (const child of tool.tools || []) appendTool(context, child, nested);
    return;
  }
  if (["web_search", "web_search_preview"].includes(tool.type)) return;

  const originalName = String(tool.name || tool.function?.name || (tool.type === "tool_search" ? "tool_search" : ""));
  if (!originalName) return;
  const responseName = namespacedName(originalName, namespace);
  const chatName = uniqueChatName(context, responseName);
  const type = tool.type === "custom" ? "custom" : tool.type === "tool_search" ? "tool_search" : "function";
  const metadata = { type, name: originalName, namespace: namespace.replace(/__$/, ""), responseName, chatName };
  context.responseToChat.set(responseName, metadata);
  context.chatToResponse.set(chatName, metadata);
  if (context.chatNames.has(chatName)) return;
  context.chatNames.add(chatName);

  const description = String(tool.description || tool.function?.description || (type === "tool_search" ? "Search for deferred Codex tools." : ""));
  const parameters = type === "custom"
    ? { type: "object", properties: { input: { type: "string", description: "Free-form input passed verbatim to the Codex tool." } }, required: ["input"] }
    : tool.parameters || tool.function?.parameters || (type === "tool_search"
      ? { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
      : { type: "object", properties: {} });
  context.chatTools.push({ type: "function", function: { name: chatName, description, parameters } });
}

function discoveredTools(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => ["additional_tools", "tool_search_output"].includes(item?.type))
    .flatMap((item) => Array.isArray(item.tools) ? item.tools : []);
}

function responseToolName(item) {
  const name = String(item?.name || (item?.type === "tool_search_call" ? "tool_search" : item?.type || "tool"));
  return namespacedName(name, item?.namespace || "");
}

function inferredMetadata(item, responseName) {
  return {
    type: item?.type === "custom_tool_call" ? "custom" : item?.type === "tool_search_call" ? "tool_search" : "function",
    name: String(item?.name || responseName),
    namespace: String(item?.namespace || ""),
    responseName,
    chatName: safeChatName(responseName),
  };
}

function isToolCall(item) {
  return ["function_call", "custom_tool_call", "tool_search_call", "computer_call"].includes(item?.type)
    || (typeof item?.type === "string" && item.type.endsWith("_call") && !item.type.endsWith("_call_output"));
}

function isToolOutput(item) {
  return ["function_call_output", "custom_tool_call_output", "tool_search_call_output", "tool_search_output", "tool_result"].includes(item?.type)
    || (typeof item?.type === "string" && item.type.endsWith("_call_output"));
}

function uniqueChatName(context, responseName) {
  const existing = context.responseToChat.get(responseName)?.chatName;
  if (existing) return existing;
  let candidate = safeChatName(responseName);
  let index = 2;
  while (context.chatNames.has(candidate) && context.chatToResponse.get(candidate)?.responseName !== responseName) {
    candidate = `${safeChatName(responseName).slice(0, 58)}_${index}`.slice(0, 64);
    index += 1;
  }
  return candidate;
}

function safeChatName(value) {
  const raw = String(value || "tool");
  if (VALID_CHAT_TOOL_NAME.test(raw)) return raw;
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 52) || "tool";
  const suffix = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 10);
  return `${safe}_${suffix}`.slice(0, 64);
}

function namespacePrefix(value) {
  const text = String(value || "").trim();
  return !text || text.endsWith("__") ? text : `${text}__`;
}

function namespacedName(name, namespace) {
  const raw = String(name || "").trim();
  const prefix = namespacePrefix(namespace);
  return prefix && raw && !raw.startsWith(prefix) ? `${prefix}${raw}` : raw;
}

function jsonString(value) {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value)); } catch { return value || "{}"; }
  }
  return JSON.stringify(value ?? {});
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function customInput(value) {
  if (typeof value !== "string") return JSON.stringify(value ?? "");
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.input === "string") return parsed.input;
  } catch { /* A custom tool may already contain raw free-form input. */ }
  return value;
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined || value === null ? "" : JSON.stringify(value);
  return value.map((part) => part?.text || part?.input_text || part?.output_text || "").filter(Boolean).join("\n");
}

function reasoningText(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["reasoning_content", "reasoning"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      for (const nested of ["content", "text", "summary"]) {
        if (typeof candidate[nested] === "string" && candidate[nested].trim()) return candidate[nested].trim();
      }
    }
  }
  const summary = value.summary;
  if (typeof summary === "string" && summary.trim()) return summary.trim();
  if (Array.isArray(summary)) return summary.map((part) => part?.text || part?.content || (typeof part === "string" ? part : "")).filter(Boolean).join("\n\n").trim();
  return "";
}

function joinReasoning(...values) {
  return values.map((value) => String(value || "").trim()).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join("\n\n");
}

function attachReasoning(message, value) {
  const reasoning = joinReasoning(message?.reasoning_content, value);
  if (reasoning) message.reasoning_content = reasoning;
}
