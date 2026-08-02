// AIDA — Retell webhook signature verification boundary (M3).
//
// ─────────────────────────────────────────────────────────────────────
// WHY THIS FILE DOES NOT IMPLEMENT THE HMAC ITSELF
// ─────────────────────────────────────────────────────────────────────
// Retell's official documentation (docs.retellai.com/features/secure-webhook,
// reviewed 2026-08-01) expresses verification ONLY through the official SDK:
//
//     await Retell.verify(rawBody, process.env.RETELL_API_KEY, signature)
//
// The prose describes the ingredients — header `X-Retell-Signature` shaped
// `v={timestamp},d={hex_digest}`, HMAC-SHA256 keyed with the API key, over
// "the raw request body concatenated with the timestamp", a 5-minute replay
// window — but it does NOT publish the exact byte-level construction. The
// concatenation ORDER and any separator are not stated unambiguously.
//
// Reimplementing from that description would mean guessing. A verifier that
// guesses wrong either rejects every genuine event (an outage) or, far worse,
// accepts a forged one. The brief is explicit: do not invent or guess the
// signature algorithm, and do not ship a production verifier not derived from
// the official contract or SDK.
//
// So: this module DELEGATES to the official SDK and FAILS CLOSED when the SDK
// is absent. The SDK is declared as an optionalDependency and required lazily,
// so the dependency-light test suite still loads this file, and a deploy
// without the SDK simply cannot process webhooks — which is the safe outcome,
// since the webhook is dormant by default anyway.
//
// The verdict shape and every surrounding rule (size limit, content type,
// timestamp window, header shape) ARE implemented and tested here, because
// those are ours, not the provider's.
//
// NEVER LOGGED: the API key, the raw signature header, the raw body.

const { getRetellConfig, canVerifyWebhook, canVerifyInboundWebhook } = require("../config/retell");

const SIGNATURE_HEADER = "x-retell-signature";

// Retell documents a 5-minute replay window. We apply it ourselves as well as
// relying on the SDK, because a stale-but-validly-signed replay is a real
// attack and we would rather refuse it twice than zero times.
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

const VERIFY_RESULTS = Object.freeze({
  verified: "verified",
  missingSignature: "missing_signature",
  malformedSignature: "malformed_signature",
  staleSignature: "stale_signature",
  invalidSignature: "invalid_signature",
  disabled: "verification_disabled",
  unavailable: "verifier_unavailable",
  oversize: "payload_too_large",
  badContentType: "unsupported_content_type",
});

function verdict(result, { detail = null } = {}) {
  return Object.freeze({
    verified: result === VERIFY_RESULTS.verified,
    result,
    // Detail is for OUR logs and is always a short constant-ish string. It
    // never contains the signature, the key or any body content.
    detail,
  });
}

/**
 * Parse the documented `v={timestamp},d={hex}` header shape. Returns null when
 * it does not match — we refuse rather than attempt a lenient read, because a
 * header we cannot parse is a header we cannot verify.
 */
function parseSignatureHeader(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  // EXACTLY 64 hex characters. The digest is HMAC-SHA256, so it is always 32
  // bytes; the SDK's own parser (lib/webhook_auth.js, read 2026-08-02) enforces
  // SHA_256_HEX_LENGTH = 64 and returns undefined otherwise.
  //
  // This was 16–256, which was not a security hole — the SDK is authoritative
  // and rejects a wrong-length digest anyway — but it meant a malformed header
  // was reported as `invalid_signature` (a failed cryptographic check) rather
  // than `malformed_signature` (a header that was never well-formed). Those are
  // different operational problems and should not look identical in a log.
  const match = raw.match(/^v=(\d{1,20}),d=([a-f0-9]{64})$/i);
  if (!match) return null;
  const timestampMs = Number(match[1]);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  return { timestampMs, digest: match[2] };
}

/** Our own replay check, applied before we spend any CPU on the HMAC. */
function isWithinReplayWindow(timestampMs, nowMs, maxAgeMs = MAX_SIGNATURE_AGE_MS) {
  const age = nowMs - timestampMs;
  // A little clock skew forward is tolerated; a lot is not.
  return age <= maxAgeMs && age >= -maxAgeMs;
}

/**
 * Load the official verifier. Isolated so tests can inject a fake and so the
 * absence of the SDK is a clean, reportable state rather than a module-load
 * crash. Returns null when unavailable.
 */
function loadOfficialVerifier() {
  try {
    // eslint-disable-next-line global-require
    const mod = require("retell-sdk");
    const Retell = mod && (mod.Retell || mod.default || mod);
    if (Retell && typeof Retell.verify === "function") return Retell.verify.bind(Retell);
    return null;
  } catch {
    return null; // not installed — fail closed, do not improvise
  }
}

/**
 * The full pre-flight: everything we can refuse without the provider's help.
 * Runs BEFORE parsing the body as JSON, so a hostile payload is never parsed.
 */
function preflight({ rawBody, headers = {}, contentType = null, config, nowMs, capability = canVerifyWebhook }) {
  // Which surface is asking. Defaults to the event webhook's capability so the
  // existing path is byte-identical; the inbound route passes its own, because
  // it has its own flag and must not need the event one. See
  // config/retell.js canVerifyInboundWebhook.
  const gate = capability(config.env || process.env);
  if (!gate.allowed) return verdict(VERIFY_RESULTS.disabled, { detail: gate.reasons.join("; ") });

  const type = String(contentType || headers["content-type"] || "").toLowerCase();
  if (!type.includes("application/json")) {
    return verdict(VERIFY_RESULTS.badContentType, { detail: "expected application/json" });
  }

  const size = Buffer.isBuffer(rawBody) ? rawBody.length : Buffer.byteLength(String(rawBody || ""), "utf8");
  if (size === 0) return verdict(VERIFY_RESULTS.malformedSignature, { detail: "empty body" });
  if (size > config.webhookMaxBytes) {
    return verdict(VERIFY_RESULTS.oversize, { detail: `${size} bytes exceeds the ${config.webhookMaxBytes} byte limit` });
  }

  const header = headers[SIGNATURE_HEADER] || headers[SIGNATURE_HEADER.toUpperCase()];
  if (!header) return verdict(VERIFY_RESULTS.missingSignature);

  const parsed = parseSignatureHeader(header);
  if (!parsed) return verdict(VERIFY_RESULTS.malformedSignature);

  if (!isWithinReplayWindow(parsed.timestampMs, nowMs)) {
    return verdict(VERIFY_RESULTS.staleSignature, { detail: "outside the 5 minute window" });
  }

  return null; // nothing to refuse yet
}

/**
 * Verify a Retell webhook.
 *
 * @param {Buffer|string} rawBody  the EXACT bytes received. Not a re-serialised
 *                                 object — re-serialising changes the bytes and
 *                                 the signature will never match.
 * @param {object} headers         lower-cased header map
 * @param {object} deps            { verifier, now, env } for tests
 */
async function verifyRetellWebhook({ rawBody, headers = {}, contentType = null, deps = {} } = {}) {
  const env = deps.env || process.env;
  const config = { ...getRetellConfig(env), env };
  const nowMs = deps.now ? deps.now() : Date.now();

  const refusal = preflight({ rawBody, headers, contentType, config, nowMs, capability: deps.capability || canVerifyWebhook });
  if (refusal) return refusal;

  const verifier = deps.verifier !== undefined ? deps.verifier : loadOfficialVerifier();
  if (typeof verifier !== "function") {
    // The SDK is not installed. We do NOT fall back to a hand-rolled HMAC:
    // an unverifiable webhook is refused.
    return verdict(VERIFY_RESULTS.unavailable, {
      detail: "official retell-sdk verifier is not installed; webhook processing is refused",
    });
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  const signature = headers[SIGNATURE_HEADER] || headers[SIGNATURE_HEADER.toUpperCase()];

  let valid = false;
  try {
    valid = await verifier(body, config.apiKey, signature);
  } catch (err) {
    // A verifier that throws is treated as a failed verification, never as a
    // pass. The message is not propagated — it could echo the signature.
    return verdict(VERIFY_RESULTS.invalidSignature, { detail: "verifier threw" });
  }

  return valid === true ? verdict(VERIFY_RESULTS.verified) : verdict(VERIFY_RESULTS.invalidSignature);
}

module.exports = {
  SIGNATURE_HEADER,
  MAX_SIGNATURE_AGE_MS,
  VERIFY_RESULTS,
  canVerifyInboundWebhook,
  parseSignatureHeader,
  isWithinReplayWindow,
  loadOfficialVerifier,
  preflight,
  verifyRetellWebhook,
  verdict,
};
