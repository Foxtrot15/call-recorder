// AIDA Locksmith Receptionist — request handlers for the public route (M1).
//
// Split from routes/locksmith.js for the same reason client-auth-handlers.js
// is split from client-auth.js: this file imports NO express, so the whole
// handler surface is testable in the bare-checkout environment with plain fake
// req/res objects (house rule — no supertest, `npm test` runs without
// node_modules).
//
// Every dependency is injectable, so a test can render a stub page, feed a
// fake submitter, or freeze the rate limiter's clock without touching config.

const { getLocksmithConfig } = require("../config/locksmith");
const demoData = require("../services/locksmith-demo");
const {
  FIELDS,
  validateEnquiry,
  createEnquirySubmitter,
  SUBMISSION_MESSAGES,
} = require("../services/locksmith-enquiry");
const { renderLocksmithPage } = require("../views/locksmith-page");
const { createRateLimiter } = require("../services/rate-limit");

// Enquiry submissions per IP. Generous for a human filling in one form, tight
// enough that the endpoint isn't a free relay to whatever sink is wired in
// later (same in-memory limiter as the VoIP endpoints, decision D11).
const ENQUIRY_LIMIT = 5;
const ENQUIRY_WINDOW_MS = 10 * 60 * 1000;
// How often expired rate-limit windows are swept (see enquiry() below).
const PRUNE_EVERY = 100;

// The page is self-contained: own stylesheet and script, no inline script, no
// third-party origin, no framing, no off-site form posts. Set per-route, so no
// existing response anywhere else in the app is affected.
const PAGE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
});

function createLocksmithHandlers(deps = {}) {
  const readConfig = deps.getConfig || (() => getLocksmithConfig());
  const demo = deps.demo || demoData;
  const fields = deps.fields || FIELDS;
  const render = deps.render || renderLocksmithPage;
  const validate = deps.validate || validateEnquiry;
  const submit = deps.submit || createEnquirySubmitter({ sink: deps.sink || null });
  const logger = deps.logger || console;
  const limiter =
    deps.limiter || createRateLimiter({ limit: ENQUIRY_LIMIT, windowMs: ENQUIRY_WINDOW_MS });

  // GET — rendered from config on every request. Cheap (string concat over
  // frozen data) and an env change takes effect on restart with no build step.
  function page(req, res) {
    const config = readConfig();
    const html = render({ config, demo, fields });
    res.set(PAGE_SECURITY_HEADERS);
    res.set("Cache-Control", "public, max-age=60");
    res.type("html");
    return res.status(200).send(html);
  }

  // POST — validated server-side regardless of what the browser checked, then
  // handed to the submission boundary. Values are never echoed back into HTML:
  // the response is JSON and the client writes it with textContent.
  // Unlike the VoIP limiters (which sit behind auth), this endpoint is public,
  // so its key space is whatever IPs turn up. Sweep expired windows
  // periodically rather than on every request — pruning per request would be
  // O(n) work an attacker controls.
  let requestsSincePrune = 0;

  async function enquiry(req, res) {
    const key = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    if ((requestsSincePrune += 1) >= PRUNE_EVERY) {
      requestsSincePrune = 0;
      limiter.prune();
    }
    const verdict = limiter.check(key);
    if (!verdict.allowed) {
      return res.status(429).json({
        ok: false,
        code: "rate_limited",
        message: SUBMISSION_MESSAGES.rateLimited,
      });
    }

    const result = validate(req.body || {});
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        code: "invalid",
        message: SUBMISSION_MESSAGES.invalid,
        errors: result.errorList,
      });
    }

    let outcome;
    try {
      outcome = await submit(result.values, { receivedVia: "web" });
    } catch (err) {
      // A throwing submitter is a bug, not a user error — the internal message
      // never reaches the browser.
      logger.error("locksmith.enquiry.submit_threw", err && err.message);
      return res.status(502).json({
        ok: false,
        code: "error",
        message: SUBMISSION_MESSAGES.error,
      });
    }

    return res.status(outcome.status).json({
      ok: outcome.ok,
      code: outcome.code,
      message: SUBMISSION_MESSAGES[outcome.code] || SUBMISSION_MESSAGES.error,
    });
  }

  return { page, enquiry };
}

module.exports = {
  createLocksmithHandlers,
  PAGE_SECURITY_HEADERS,
  ENQUIRY_LIMIT,
  ENQUIRY_WINDOW_MS,
};
