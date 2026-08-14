// AIDA Locksmith Acquisition — the Retell webhook handler (E-11A).
//
//   createAcquisitionWebhookHandler({ ... })   express-free, fully injectable
//
// The return path from E-7B2B1 given a real ingress. Same order, same refusals,
// now with a signature in front of it and a durable fingerprint beside it.
//
// ── WHAT IS REUSED, AND WHAT DELIBERATELY IS NOT ────────────────────
// REUSED: `verifyRetellWebhook` — the one signature implementation. A second
// would be a second thing to get wrong, and this file verifies nothing itself.
// REUSED: `provider-webhook-events` for envelope validation, the deterministic
// fingerprint, and the durable LPM3 record. That table's UNIQUE(fingerprint) is
// the idempotency mechanism, and it is a database constraint rather than
// anything this process remembers.
//
// NOT REUSED: `decideEventHandling`. It is onboarding-shaped — it asks whether
// an onboarding SESSION is bound to the call and answers "no onboarding session
// is bound" when there is none, and it maps events to `onboarding_call.*`. An
// acquisition event is bound by `metadata.aida_dispatch_id` and by nothing
// else. Running acquisition through that decision would either drop every
// acquisition event or file it against the wrong domain.
//
// NOT REUSED: the onboarding handler's processor contract. Acquisition events
// must never reach receptionist or onboarding business handling.
//
// ── THE ORDER IS THE SECURITY MODEL ─────────────────────────────────
//   1. signature verification        ← before the body is parsed at all
//   2. parse
//   3. envelope validation
//   4. acquisition? -> if not, ignore without touching acquisition state
//   5. durable fingerprint            ← LPM3, database-enforced
//   6. correlate by aida_dispatch_id  ← never by number, name or transcript
//   7. acknowledge FAST
//   8. business processing, after the response
//
// Steps 1-3 mutate nothing. An unverified, malformed or non-acquisition
// delivery cannot reach an acquisition table.

const { verifyRetellWebhook, VERIFY_RESULTS } = require("../services/retell-webhook-verify");
const events = require("../services/provider-webhook-events");
const { handleAcquisitionCallEvent, EVENT_CODES } = require("../services/acquisition-call-events");

/** Verification verdict → HTTP. Anything not verified is refused. */
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

/** The marker E-7B2A puts on every acquisition call it submits. */
const ACQUISITION_PURPOSE = "locksmith_acquisition";

/**
 * Is this delivery ours?
 *
 * An ordinary receptionist or onboarding call carries neither marker and must
 * not enter this path — not to be rejected, but to be ignored, because it is
 * somebody else's event arriving on a shared provider account.
 */
function isAcquisitionEvent(call) {
  const m = call && typeof call.metadata === "object" && call.metadata ? call.metadata : null;
  if (!m) return false;
  return m.aida_purpose === ACQUISITION_PURPOSE || typeof m.aida_dispatch_id === "string";
}

/**
 * ── HTTP SEMANTICS, CHOSEN SO A PROVIDER RETRY DOES THE RIGHT THING ──
 *
 * Retell retries on non-2xx. So a 5xx must mean "try again and it might work",
 * and nothing else may use one.
 *
 *   204  verified and handled — including duplicates, ignored events, and
 *        PERMANENT acquisition conflicts. A call-id conflict will be refused
 *        identically for ever; asking Retell to redeliver it would turn one
 *        operator's problem into a stream of them.
 *   400  malformed body or envelope — retrying cannot help
 *   401  missing, stale or invalid signature
 *   413  oversize
 *   503  webhook disabled, verifier unavailable, or OUR storage is down —
 *        the only genuinely transient cases
 *
 * The body carries a short code and never internal detail, a prospect, a
 * number, or transcript content.
 */
function createAcquisitionWebhookHandler(deps = {}) {
  const verify = deps.verify || verifyRetellWebhook;
  const eventsApi = deps.events || events;
  const handle = deps.handleAcquisitionCallEvent || handleAcquisitionCallEvent;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  const store = deps.store || null;
  const recorder = deps.recorder || null;
  // An async builder used ONLY when no store was injected, and only after a
  // delivery has verified. Tests inject `store` directly and never reach it.
  const resolveDeps = deps.resolveDeps || null;
  const now = deps.now || (() => new Date());

  return async function handleAcquisitionWebhook(req, res) {
    const headers = normaliseHeaders(req.headers);
    const rawBody = req.body;

    // ── 1. VERIFY BEFORE PARSING ─────────────────────────────────
    let verdict;
    try {
      verdict = await verify({ rawBody, headers, contentType: headers["content-type"], deps: { env, verifier: deps.verifier, now: deps.now } });
    } catch {
      logger.error("acquisition.webhook.verify_threw");
      return res.status(500).json({ error: "verification_error" });
    }
    if (!verdict.verified) {
      logger.error(`acquisition.webhook.rejected result=${verdict.result}`);
      return res.status(VERIFY_STATUS[verdict.result] || 401).json({ error: verdict.result });
    }

    // ── 2-3. PARSE, THEN VALIDATE THE ENVELOPE ───────────────────
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    } catch {
      logger.error("acquisition.webhook.unparseable");
      return res.status(400).json({ error: "malformed_json" });
    }

    const envelope = eventsApi.validateEventEnvelope(parsed);
    if (!envelope.ok) {
      logger.error(`acquisition.webhook.invalid code=${envelope.code}`);
      return res.status(400).json({ error: envelope.code });
    }

    // ── 4. IS IT OURS? ───────────────────────────────────────────
    //
    // Checked BEFORE the fingerprint is written, so somebody else's traffic
    // does not fill our event log, and long before anything acquisition-shaped
    // is touched.
    if (!envelope.known || !isAcquisitionEvent(envelope.call)) {
      logger.log(`acquisition.webhook.not_ours event=${envelope.eventType}`);
      return res.status(204).end();
    }

    // ── 5. DURABLE IDEMPOTENCY (LPM3) ────────────────────────────
    const fingerprint = eventsApi.eventFingerprint({
      eventType: envelope.eventType,
      providerCallId: envelope.providerCallId,
      call: envelope.call,
    });

    let existing = null;
    try {
      existing = await eventsApi.findEventByFingerprint(fingerprint);
    } catch (err) {
      // The table is not provisioned, or the database is unreachable. A 5xx so
      // Retell redelivers later rather than the event being lost — this is the
      // one genuinely transient case in this handler.
      logger.error(`acquisition.webhook.lookup_failed code=${/not provisioned/i.test(err.message) ? "not_provisioned" : "db_error"}`);
      return res.status(503).json({ error: "temporarily_unavailable" });
    }

    if (existing) {
      logger.log(`acquisition.webhook.duplicate event=${envelope.eventType}`);
      return res.status(204).end();
    }

    const recorded = await safely(() =>
      eventsApi.recordEvent(
        eventsApi.buildEventFields({
          eventType: envelope.eventType,
          providerCallId: envelope.providerCallId,
          fingerprint,
          verificationResult: verdict.result,
          processingStatus: "received",
          metadata: eventsApi.boundEventMetadata(envelope.call),
        })
      )
    );
    if (recorded && recorded.error) {
      logger.error("acquisition.webhook.record_failed");
      return res.status(503).json({ error: "temporarily_unavailable" });
    }
    if (recorded && recorded.value && recorded.value.duplicate) {
      // Lost a race with a concurrent identical delivery. The DATABASE decided
      // it, not this process — still idempotent.
      return res.status(204).end();
    }

    // ── 6. THE DURABLE LAYER, AFTER AUTH AND BEFORE THE ACK (E-12L) ──
    //
    // Two constraints meet here, and the placement is the only point that
    // satisfies both.
    //
    // NOT EARLIER, because E-12D resolved it in the route entry — so an
    // UNSIGNED request opened a database connection and, if the acquisition
    // schema was absent, answered 503 where 401 was the truth. Nothing
    // unauthenticated may reach storage, including to ask it a question.
    //
    // NOT LATER, because after `res.status(204)` there is no way left to ask
    // for a redelivery. A first draft of this moved it into the background work
    // and turned a storage outage into a silently-failed event that Retell
    // would never send again. A verified delivery we cannot process must be
    // refused while a refusal still means something.
    let resolved = { store, recorder };
    if (!store && resolveDeps) {
      const built = await safely(() => resolveDeps());
      if (built && built.error) {
        logger.error("acquisition.webhook.deps_unavailable");
        return res.status(503).json({ error: "storage_unavailable" });
      }
      resolved = built.value;
    }

    // ── 7. ACKNOWLEDGE FAST, THEN DO THE WORK ──────────────────────
    res.status(204).end();

    Promise.resolve()
      .then(() =>
        handle({
          verified: true,
          eventType: envelope.eventType,
          providerCallId: envelope.providerCallId,
          call: envelope.call,
          store: resolved.store,
          recorder: resolved.recorder,
          now,
        })
      )
      .then(async (result) => {
        const status = statusFor(result);
        if (result && !result.ok) {
          logger.error(`acquisition.webhook.unresolved code=${result.code}`);
        }
        await safely(() => eventsApi.markEventProcessed(fingerprint, { status, errorCode: result && !result.ok ? result.code : null }));
      })
      .catch(async () => {
        logger.error("acquisition.webhook.processing_failed");
        await safely(() => eventsApi.markEventProcessed(fingerprint, { status: "failed", errorCode: "processing_error" }));
      });

    return undefined;
  };
}

/**
 * How the durable event log records what happened.
 *
 * A permanent conflict is `failed` rather than `processed` — it needs a human —
 * but the HTTP answer was still 204, because redelivering it would produce the
 * same conflict for ever.
 */
function statusFor(result) {
  if (!result) return "failed";
  if (result.ok) return "processed";
  if ([EVENT_CODES.IGNORED, EVENT_CODES.ALREADY_RESOLVED].includes(result.code)) return "ignored";
  return "failed";
}

function normaliseHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v;
  return out;
}

async function safely(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: err };
  }
}

module.exports = {
  createAcquisitionWebhookHandler,
  isAcquisitionEvent,
  statusFor,
  VERIFY_STATUS,
  ACQUISITION_PURPOSE,
};
