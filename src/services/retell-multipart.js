// AIDA — Retell multipart request construction (M7B).
//
// Retell's knowledge-base endpoints are multipart/form-data, not JSON:
//
//   POST /create-knowledge-base            multipart/form-data
//   POST /add-knowledge-base-sources/{id}  multipart/form-data
//
// (verified against docs.retellai.com on 2026-08-01)
//
// Everything else in the API is ordinary JSON. The adapter previously sent the
// knowledge base as JSON, which the provider rejects — a mismatch that fixture
// tests could never have caught, because a fixture happily accepts whatever
// shape it is handed.
//
// ─── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────
// So the encoding is testable WITHOUT a transport. A test can assert the exact
// bytes and boundary structure without a network stack, an HTTP client, or a
// provider. That is the only way to gain confidence in a wire format we cannot
// currently exercise against the real endpoint.
//
// Dep-free: builds the body with Buffer, which is core Node. No form-data
// package, no undici FormData — both would work, but neither is needed and the
// house rule is that modules load on a bare checkout.

const crypto = require("crypto");

const MULTIPART_VERSION = "retell-multipart-2026-08-01";

// Provider limit: the name must be under 40 characters.
const MAX_KB_NAME = 39;

/**
 * A boundary that cannot appear in the payload.
 *
 * Derived from the content rather than random, so building the same request
 * twice produces identical bytes — which is what makes the output hashable and
 * the tests deterministic. The collision check is not paranoia: a boundary that
 * appears inside a body silently truncates the request, and business prose is
 * exactly the kind of content that could contain anything.
 */
function boundaryFor(parts) {
  const material = JSON.stringify(parts);
  let attempt = 0;
  for (;;) {
    const boundary = `----AidaFormBoundary${crypto.createHash("sha256").update(`${material}:${attempt}`).digest("hex").slice(0, 24)}`;
    if (!material.includes(boundary)) return boundary;
    attempt += 1;
  }
}

/**
 * Encode field/value pairs as multipart/form-data.
 *
 * `parts` is an ordered list of { name, value, filename?, contentType? }.
 * Ordering is preserved because a provider may care, and because deterministic
 * output is worth more than a marginal convenience.
 */
function encodeMultipart(parts) {
  const boundary = boundaryFor(parts);
  const chunks = [];

  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;

    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(Buffer.from(`Content-Disposition: ${disposition}\r\n`, "utf8"));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value), "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  const body = Buffer.concat(chunks);
  return {
    multipartVersion: MULTIPART_VERSION,
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
    body,
    byteLength: body.length,
  };
}

/**
 * Build the create-knowledge-base request.
 *
 * `knowledge_base_texts` is an ARRAY OF OBJECTS ({title, text}). Multipart has
 * no native notion of a nested array, so each item is sent as its own indexed
 * field — the conventional encoding, and the one that keeps each item's title
 * bound to its own text.
 *
 * @returns {{ok:true, request:object}|{ok:false, code:string, message:string}}
 */
function buildCreateKnowledgeBaseRequest({ knowledgeBaseName, texts = [], urls = [], enableAutoRefresh = false }) {
  const name = typeof knowledgeBaseName === "string" ? knowledgeBaseName.trim() : "";
  if (!name) {
    return { ok: false, code: "kb_name_required", message: "A knowledge base needs a name." };
  }
  if (name.length > MAX_KB_NAME) {
    // Refused rather than silently truncated: two clients whose names both
    // truncate to the same 39 characters would collide, and the failure would
    // surface much later as the wrong business's knowledge.
    return { ok: false, code: "kb_name_too_long", message: `The knowledge base name must be ${MAX_KB_NAME} characters or fewer (got ${name.length}).` };
  }

  const cleanTexts = [];
  for (const item of texts) {
    if (!item || typeof item !== "object") {
      return { ok: false, code: "kb_text_invalid", message: "Each knowledge base text must be an object with a title and text." };
    }
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const text = typeof item.text === "string" ? item.text : "";
    if (!title || !text.trim()) {
      return { ok: false, code: "kb_text_incomplete", message: "Each knowledge base text needs both a title and body text." };
    }
    cleanTexts.push({ title, text });
  }

  if (!cleanTexts.length && !urls.length) {
    return { ok: false, code: "kb_empty", message: "A knowledge base needs at least one text or URL." };
  }

  // ── VERIFIED AGAINST THE LIVE PROVIDER, 2026-08-02 ────────────────
  //
  // `knowledge_base_texts` is ONE field containing a JSON-encoded array — not
  // indexed sub-fields.
  //
  // M7B derived `knowledge_base_texts[0][title]` from the documented shape,
  // which is the conventional way to express an array of objects in multipart.
  // The live API rejects it (400/500). Sending one item per repeated field
  // returns the decisive error:
  //
  //     {"status":"error","message":"not an array"}
  //
  // — so the server JSON-parses this field and requires an array. Encoding the
  // whole array as a single JSON value returns 201.
  //
  // This is exactly the mismatch that fixture tests could never have found: a
  // fake accepts whatever shape it is handed, and only the real endpoint knows
  // it wants JSON here.
  const parts = [{ name: "knowledge_base_name", value: name }];
  if (cleanTexts.length) {
    parts.push({ name: "knowledge_base_texts", value: JSON.stringify(cleanTexts), contentType: "application/json" });
  }
  if (urls.length) {
    parts.push({ name: "knowledge_base_urls", value: JSON.stringify(urls.map(String)), contentType: "application/json" });
  }
  if (enableAutoRefresh) parts.push({ name: "enable_auto_refresh", value: "true" });

  const encoded = encodeMultipart(parts);
  return {
    ok: true,
    request: {
      method: "POST",
      path: "/create-knowledge-base",
      contentType: encoded.contentType,
      boundary: encoded.boundary,
      body: encoded.body,
      byteLength: encoded.byteLength,
      // The field names actually sent, so a test can assert the wire shape
      // without parsing the body back out.
      fieldNames: parts.map((p) => p.name),
    },
  };
}

// ── Asynchronous processing ─────────────────────────────────────────
//
// Creation returns immediately with status "in_progress". The knowledge base is
// NOT usable until it reaches "complete".

const KB_STATUSES = Object.freeze(["in_progress", "complete", "error", "refreshing_in_progress"]);

const KB_TERMINAL = Object.freeze(["complete", "error"]);

/**
 * Is this knowledge base ready to attach to a response engine?
 *
 * Attaching an incomplete knowledge base gives an agent that answers callers
 * from a partially-indexed corpus — worse than no knowledge base, because it
 * looks like it is working.
 */
function assessKnowledgeBase(status) {
  if (!KB_STATUSES.includes(status)) {
    return { usable: false, terminal: false, code: "unknown_status", message: `"${String(status).slice(0, 40)}" is not a knowledge base status we recognise.` };
  }
  if (status === "complete") return { usable: true, terminal: true, code: null, message: null };
  if (status === "error") return { usable: false, terminal: true, code: "kb_failed", message: "The provider could not process this knowledge base." };
  return { usable: false, terminal: false, code: "kb_processing", message: "The knowledge base is still being processed." };
}

module.exports = {
  MULTIPART_VERSION,
  MAX_KB_NAME,
  KB_STATUSES,
  KB_TERMINAL,
  encodeMultipart,
  buildCreateKnowledgeBaseRequest,
  assessKnowledgeBase,
  boundaryFor,
};
