// AIDA Locksmith Acquisition — negative probes for the public webhook (E-12J).
//
//   validateSmokeTarget(baseUrl, { env })   → { ok, url } | { ok:false, code }
//   NEGATIVE_PROBES                          → the only requests that may be sent
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────
// Once staging has a public domain, somebody has to confirm that the exposed
// acquisition webhook rejects everything it should. That confirmation is worth
// having as data — a fixed list of requests and expected answers — rather than
// as a person trying things with curl and remembering what happened.
//
// ── WHAT IT DELIBERATELY CANNOT DO ──────────────────────────────────
// It cannot prove the POSITIVE case, and that is on purpose. A valid Retell
// signature is an HMAC over the exact body using the API key, and this harness
// is not given the key and does not compute one. Fabricating a signature would
// mean writing a second implementation of the thing the verifier exists to
// check — and a passing test against our own forgery would prove only that we
// can forge consistently.
//
// So the authenticated-event proof stays reserved for a real Retell delivery
// after the agent exists. Everything here is a REJECTION path.
//
// ── EVERY PROBE MUST BE UNMISTAKABLY NOT ACQUISITION TRAFFIC ────────
// No probe body carries `aida_purpose`, a dispatch id, or anything the handler
// could read as ours. If a probe ever got past the signature check — it cannot,
// but if — it must still be discarded before reaching a dispatch.

/**
 * Local and private hosts a public probe must refuse to treat as staging.
 *
 * IPv6 note: `new URL("https://[::1]").hostname` is "[::1]" — WITH the
 * brackets. An earlier version of this pattern matched a bare "::1" and
 * therefore accepted the IPv6 loopback as a valid public target. The brackets
 * are stripped before matching rather than added to the pattern, so any
 * bracketed IPv6 form is normalised the same way.
 */
const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|::1|0:0:0:0:0:0:0:1|0\.0\.0\.0|::)$|\.local$|\.localhost$/i;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
/** IPv6 unique-local (fc00::/7) and link-local (fe80::/10). */
const PRIVATE_V6 = /^(f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

const unbracket = (host) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);

const SMOKE_CODES = Object.freeze({
  OK: "smoke_target_ok",
  MISSING: "smoke_target_missing",
  NOT_URL: "smoke_target_not_a_url",
  NOT_HTTPS: "smoke_target_not_https",
  LOCAL: "smoke_target_local",
  PRODUCTION: "smoke_target_looks_like_production",
  HAS_CREDENTIALS: "smoke_target_carries_credentials",
});

const ACQUISITION_WEBHOOK_PATH = "/webhooks/retell/acquisition";

/**
 * Is this a URL we are willing to send negative probes at?
 *
 * The production check is the one that matters. Pointing a probe suite at the
 * runtime that answers real customer calls would be a self-inflicted incident,
 * so a host matching the configured production base URL is refused outright
 * rather than warned about.
 */
function validateSmokeTarget(baseUrl, { env = process.env } = {}) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return refuse(SMOKE_CODES.MISSING, "A staging base URL is required. This harness has no default.");
  }

  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return refuse(SMOKE_CODES.NOT_URL, `"${baseUrl}" is not a URL.`);
  }

  if (url.protocol !== "https:") {
    return refuse(SMOKE_CODES.NOT_HTTPS, "Only https targets are probed — a public webhook is https or it is not public.");
  }
  if (url.username || url.password) {
    return refuse(SMOKE_CODES.HAS_CREDENTIALS, "The target carries credentials. Probes are sent unauthenticated, always.");
  }
  const host = unbracket(url.hostname);
  if (LOCAL_HOSTS.test(host) || PRIVATE_V4.test(host) || PRIVATE_V6.test(host)) {
    return refuse(SMOKE_CODES.LOCAL, `${url.hostname} is local or private. There is nothing public to prove there.`);
  }

  // Refuse anything that looks like the production deployment.
  const prod = [env.PRODUCTION_BASE_URL, env.BASE_URL].filter((v) => typeof v === "string" && v.trim());
  for (const candidate of prod) {
    let host = null;
    try { host = new URL(candidate.trim()).hostname; } catch { host = null; }
    if (host && host.toLowerCase() === url.hostname.toLowerCase()) {
      return refuse(SMOKE_CODES.PRODUCTION, `${url.hostname} matches a configured production host. Refusing to probe production.`);
    }
  }

  return Object.freeze({
    ok: true,
    code: SMOKE_CODES.OK,
    origin: url.origin,
    webhookUrl: `${url.origin}${ACQUISITION_WEBHOOK_PATH}`,
  });
}

function refuse(code, message) {
  return Object.freeze({ ok: false, code, message });
}

/**
 * The complete set of requests this harness may send. Nothing else.
 *
 * `expect` lists the acceptable answers rather than one, because two are
 * genuinely correct depending on deployment state, and a harness that demanded
 * a single number would report a false failure:
 *
 *   404  the route is dormant — flags off, or not deployed. Correct.
 *   401  the route is live and rejected the request. Also correct.
 *
 * Distinguishing those two is the FIRST thing the runner reports, because
 * "everything returned 404" means the feature is off, not that it is secure.
 */
const NEGATIVE_PROBES = Object.freeze([
  Object.freeze({
    name: "GET (unsupported method)",
    method: "GET",
    body: null,
    contentType: null,
    expect: [404, 405],
    proves: "a browser cannot reach a webhook processor",
  }),
  Object.freeze({
    name: "HEAD (unsupported method)",
    method: "HEAD",
    body: null,
    contentType: null,
    expect: [404, 405],
    proves: "nor can a link preview",
  }),
  Object.freeze({
    name: "POST, no signature",
    method: "POST",
    // Deliberately inert: no aida_purpose, no dispatch id, nothing ours.
    body: '{"probe":"e12j-no-signature"}',
    contentType: "application/json",
    expect: [401, 404],
    proves: "an unsigned delivery is rejected before any processing",
  }),
  Object.freeze({
    name: "POST, malformed signature header",
    method: "POST",
    body: '{"probe":"e12j-bad-signature"}',
    contentType: "application/json",
    headers: Object.freeze({ "x-retell-signature": "not-a-real-signature" }),
    expect: [401, 404],
    proves: "a signature that is not one is rejected — this is NOT a forged valid signature",
  }),
  Object.freeze({
    name: "POST, malformed body",
    method: "POST",
    body: "{not json",
    contentType: "application/json",
    expect: [400, 401, 404],
    proves: "unparseable input is refused; 401 is also correct because signature is checked FIRST",
  }),
  Object.freeze({
    name: "POST, wrong content type",
    method: "POST",
    body: "probe=e12j",
    contentType: "text/plain",
    expect: [400, 401, 404, 415],
    proves: "the raw-body parser is content-type scoped",
  }),
]);

/** The oversize probe is separate: it is opt-in because it sends a large body. */
function oversizeProbe(bytes = 600 * 1024) {
  return Object.freeze({
    name: `POST, oversize (${Math.round(bytes / 1024)}KB)`,
    method: "POST",
    body: `{"probe":"e12j-oversize","pad":"${"x".repeat(Math.max(0, bytes - 40))}"}`,
    contentType: "application/json",
    expect: [401, 404, 413],
    proves: "a body beyond the configured cap is refused",
  });
}

/**
 * Read a probe's answer.
 *
 * A 2xx is ALWAYS a failure here. Every one of these requests should have been
 * rejected, so success means something processed an unauthenticated request.
 */
function judgeProbeResult(probe, status) {
  if (status >= 200 && status < 300) {
    return Object.freeze({ pass: false, severity: "critical", detail: `${status} — an unauthenticated request was ACCEPTED` });
  }
  if (probe.expect.includes(status)) {
    return Object.freeze({ pass: true, severity: "ok", detail: `${status} as expected` });
  }
  if (status >= 500) {
    return Object.freeze({ pass: false, severity: "attention", detail: `${status} — a rejection should not be a server error` });
  }
  return Object.freeze({ pass: false, severity: "attention", detail: `${status} — expected one of ${probe.expect.join(", ")}` });
}

/** 404 everywhere means the feature is dormant, which is not the same as secure. */
function describeRouteState(statuses) {
  const all404 = statuses.length > 0 && statuses.every((s) => s === 404);
  return Object.freeze({
    dormant: all404,
    detail: all404
      ? "Every probe answered 404. The route is DORMANT — not deployed, or its flags are off. Nothing about rejection has been proven."
      : "The route answered something other than 404, so it is exposed and actively rejecting.",
  });
}

module.exports = {
  validateSmokeTarget,
  judgeProbeResult,
  describeRouteState,
  oversizeProbe,
  NEGATIVE_PROBES,
  SMOKE_CODES,
  ACQUISITION_WEBHOOK_PATH,
};
