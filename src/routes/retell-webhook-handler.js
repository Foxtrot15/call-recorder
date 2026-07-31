// AIDA — Retell webhook handler (M3). Express-free and injectable, so the whole
// security boundary is testable on a bare checkout with fake req/res objects.
//
// See routes/retell-webhook.js for the order-of-operations rationale.
//
// RESPONSE POLICY — chosen so a provider retry does the right thing:
//   204  accepted (including duplicates and deliberately-ignored events)
//   400  malformed body / bad content type — retrying will not help
//   401  missing, malformed, stale or invalid signature
//   413  payload over the configured limit
//   503  webhook disabled or verifier unavailable
// A 5xx is reserved for genuine transient failure, because Retell retries on
// non-2xx and we only want retries when a retry could succeed.

const { getRetellConfig, redactSecrets } = require("../config/retell");
const { verifyRetellWebhook, VERIFY_RESULTS } = require("../services/retell-webhook-verify");
const events = require("../services/provider-webhook-events");

// Map a verification verdict to an HTTP status. Anything not verified is
// refused; the differences are only so operators can tell causes apart.
const VERIFY_STATUS = Object.freeze({
  [VERIFY_RESULTS.missingSignature]: 401,
  [VERIFY_RESULTS.malformedSignature]: 401,
  [VERIFY_RESULTS.staleSignature]: 401,
  [VERIFY_RESULTS.invalidSignature]: 401,
  [VERIFY_RESULTS.badContentType]: 400,
  [VERIFY_RESULTS.oversize]: 413,
  [VERIFY_RESULTS.disabled]: 503,
  [VERIFY_RESULTS.unavailable]: 503,
});

function createRetellWebhookHandler(deps = {}) {
  const verify = deps.verify || verifyRetellWebhook;
  const eventsApi = deps.events || events;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  // Processing is delegated. In M3 nothing is wired to it; M4 injects the
  // lifecycle service. It is invoked AFTER the response, so acknowledgement is
  // never delayed by our own work.
  const processor = deps.processor || null;
  const resolveBinding = deps.resolveBinding || (async () => null);

  return async function handleRetellWebhook(req, res) {
    const config = getRetellConfig(env);
    const rawBody = req.body; // Buffer, thanks to express.raw
    const headers = normaliseHeaders(req.headers);

    // ── 1–4: verify before parsing ──
    let verdict;
    try {
      verdict = await verify({ rawBody, headers, contentType: headers["content-type"], deps: { env, verifier: deps.verifier, now: deps.now } });
    } catch (err) {
      logger.error("retell.webhook.verify_threw");
      return res.status(500).json({ error: "verification_error" });
    }

    if (!verdict.verified) {
      const status = VERIFY_STATUS[verdict.result] || 401;
      // The detail is a short constant; it never contains the signature or body.
      logger.error(`retell.webhook.rejected result=${verdict.result}`);
      return res.status(status).json({ error: verdict.result });
    }

    // ── 5: only now is the body trusted enough to parse ──
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    } catch {
      logger.error("retell.webhook.unparseable");
      return res.status(400).json({ error: "malformed_json" });
    }

    // ── 6: envelope validation ──
    const envelope = eventsApi.validateEventEnvelope(parsed);
    if (!envelope.ok) {
      logger.error(`retell.webhook.invalid code=${envelope.code}`);
      return res.status(400).json({ error: envelope.code });
    }

    // ── 7: fingerprint + idempotency ──
    const fingerprint = eventsApi.eventFingerprint({
      eventType: envelope.eventType,
      providerCallId: envelope.providerCallId,
      call: envelope.call,
    });

    let existing = null;
    try {
      existing = await eventsApi.findEventByFingerprint(fingerprint);
    } catch (err) {
      // The tables are not provisioned yet, or the DB is unreachable. Refuse
      // with a 5xx so the provider retries later rather than dropping the event.
      logger.error(`retell.webhook.lookup_failed code=${/not provisioned/i.test(err.message) ? "not_provisioned" : "db_error"}`);
      return res.status(503).json({ error: "temporarily_unavailable" });
    }

    let binding = null;
    if (envelope.providerCallId) {
      try {
        binding = await resolveBinding(envelope.providerCallId);
      } catch {
        binding = null;
      }
    }

    const decision = eventsApi.decideEventHandling({ envelope, existingEvent: existing, binding });

    if (decision.action === "reject") {
      // Cross-client mismatch. Recorded, refused, and NOT retried — a retry
      // would be refused identically.
      logger.error(`retell.webhook.rejected code=${decision.code}`);
      await safely(() =>
        eventsApi.recordEvent(
          eventsApi.buildEventFields({
            eventType: envelope.eventType,
            providerCallId: envelope.providerCallId,
            fingerprint,
            verificationResult: verdict.result,
            processingStatus: "failed",
            errorCode: decision.code,
            metadata: eventsApi.boundEventMetadata(envelope.call),
          })
        )
      );
      return res.status(400).json({ error: decision.code });
    }

    if (decision.action === "duplicate") {
      // Idempotent: acknowledged, nothing re-run.
      logger.log(`retell.webhook.duplicate event=${envelope.eventType}`);
      return res.status(204).end();
    }

    const processingStatus =
      decision.action === "process" ? "received" : decision.action === "ignore" ? "ignored" : "received";

    const recorded = await safely(() =>
      eventsApi.recordEvent(
        eventsApi.buildEventFields({
          eventType: envelope.eventType,
          providerCallId: envelope.providerCallId,
          fingerprint,
          verificationResult: verdict.result,
          processingStatus,
          clientId: binding ? binding.clientId : null,
          sessionId: binding ? binding.sessionId : null,
          metadata: eventsApi.boundEventMetadata(envelope.call),
        })
      )
    );

    if (recorded && recorded.error) {
      logger.error("retell.webhook.record_failed");
      return res.status(503).json({ error: "temporarily_unavailable" });
    }
    if (recorded && recorded.value && recorded.value.duplicate) {
      // Lost a race with a concurrent identical delivery — still idempotent.
      return res.status(204).end();
    }

    // ── 8: acknowledge FAST ──
    res.status(204).end();

    // ── 9: processing happens after the response ──
    if (decision.action === "process" && processor) {
      // Never awaited before responding, and never allowed to throw into the
      // request path.
      Promise.resolve()
        .then(() =>
          processor({
            internalEvent: decision.internalEvent,
            providerEventType: envelope.eventType,
            providerCallId: envelope.providerCallId,
            call: envelope.call,
            binding,
            fingerprint,
          })
        )
        .then(() => eventsApi.markEventProcessed(fingerprint, { status: "processed" }))
        .catch(async (err) => {
          logger.error(`retell.webhook.processing_failed event=${envelope.eventType}`);
          await safely(() => eventsApi.markEventProcessed(fingerprint, { status: "failed", errorCode: "processing_error" }));
        });
    }

    return undefined;
  };
}

function normaliseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value;
  return out;
}

/** Run an async fn, capturing failure instead of throwing into the request path. */
async function safely(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: err };
  }
}

module.exports = { createRetellWebhookHandler, VERIFY_STATUS, normaliseHeaders };
