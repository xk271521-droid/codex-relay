import zlib from "node:zlib";

// Image-heavy Codex tasks can legitimately exceed the older 25 MiB HTTP
// ceiling. Keep the Responses route aligned with the 64 MiB WebSocket frame
// limit while management endpoints retain their smaller explicit limits.
export const RESPONSES_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
// Image edits carry the reference image as multipart bytes, so use the same
// ceiling as image-heavy Responses requests without trying to decode the file.
export const IMAGE_EDIT_BODY_LIMIT_BYTES = RESPONSES_BODY_LIMIT_BYTES;

// Adapted from CodexBridge's MIT-licensed request decoding approach.
// See THIRD_PARTY_NOTICES.md for attribution and license text.
export async function readJsonRequest(req, limitBytes = 25 * 1024 * 1024) {
  const raw = await readRawRequest(req, limitBytes);
  const decoded = decodeBody(raw, req.headers?.["content-encoding"]);
  if (decoded.length > limitBytes) throw requestError(413, `Decoded request body exceeds ${limitBytes} bytes.`, "request_too_large");
  try {
    return decoded.length ? JSON.parse(decoded.toString("utf8")) : {};
  } catch {
    throw requestError(400, "Request body must be valid JSON.", "invalid_json");
  }
}

export async function readRawRequest(req, limitBytes = 25 * 1024 * 1024) {
  let received = 0;
  const chunks = [];
  for await (const chunk of req) {
    received += chunk.length;
    if (received > limitBytes) throw requestError(413, `Request body exceeds ${limitBytes} bytes.`, "request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function decodeBody(body, contentEncoding = "") {
  const encodings = String(contentEncoding || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  let decoded = body;
  for (const encoding of encodings.reverse()) {
    if (encoding === "identity") continue;
    if (encoding === "gzip" || encoding === "x-gzip") { decoded = zlib.gunzipSync(decoded); continue; }
    if (encoding === "deflate") { decoded = zlib.inflateSync(decoded); continue; }
    if (encoding === "br") { decoded = zlib.brotliDecompressSync(decoded); continue; }
    if (encoding === "zstd") {
      if (typeof zlib.zstdDecompressSync !== "function") throw requestError(415, "This Node runtime cannot decode zstd request bodies.", "zstd_unsupported");
      decoded = zlib.zstdDecompressSync(decoded);
      continue;
    }
    throw requestError(415, `Unsupported request content-encoding: ${contentEncoding}.`, "encoding_unsupported");
  }
  return decoded;
}

function requestError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
