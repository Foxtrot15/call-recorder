// AIDA — enquiry notification (M7K).
//
// ─── FOUR STATES, PERMANENTLY SEPARATE ──────────────────────────────
// The M7J live call collapsed two of these and told a caller the locksmith
// would be notified when nothing sends anything. They are named here once, and
// nothing in this module is allowed to blur them:
//
//   1. SAVED         the enquiry row exists.                    (M7J)
//   2. ATTEMPTED     a delivery was tried. Says nothing about arrival.
//   3. DELIVERED     the provider accepted the message.         ← the only
//                    thing that permits "the locksmith has been notified"
//   4. ACKNOWLEDGED  a human read it and responded. NOT IMPLEMENTED, and
//                    deliberately unrepresentable: there is no read receipt,
//                    no reply handling, and no field that could hold one. A
//                    provider "delivered" is not a person knowing.
//
// `agentMessage` is written per outcome so the agent never composes wording for
// a delivery it does not understand — the same discipline M7J-LV had to install
// after the tool's own success message promised something nothing performed.
//
// ─── NO RETRIES, ON PURPOSE ─────────────────────────────────────────
// One attempt. A failure is recorded and reported honestly, and the caller is
// told to ring the locksmith directly. Retrying inside a live phone call spends
// the caller's patience on our plumbing, and a retry loop behind a 10-second
// tool timeout is a retry storm with an audience. The row keeps its attempt
// count and failure code so a later milestone can sweep unsent enquiries
// out-of-band, which is where retries belong.
//
// Pure + dep-free: every store and delivery adapter is injected.

const NOTIFICATION_VERSION = "locksmith-notification-2026-08-03";

/** The states the row may hold. Mirrors the SQL check constraint exactly. */
const STATES = Object.freeze({
  pending: "pending",
  sending: "sending",
  notRequired: "not_required",
  sent: "sent",
  // ── A DRY RUN IS NOT A SEND (M7K-A) ───────────────────────────────
  // The first M7K cut stored `sent` for a dry run, returned notified:true and
  // let the agent say the locksmith had been notified — while nothing had left
  // the building. That is the same class of untruth M7J-LV existed to remove,
  // reintroduced one layer down.
  //
  // `simulated` is its own terminal state so the three things stay impossible
  // rather than merely discouraged:
  //   * the row can never read `sent` for a message that does not exist
  //   * `delivered` is false, so `notified` is false
  //   * the agent's permission keys on `notified`, so it cannot claim one
  //
  // It is a DISTINCT state rather than a flag on `sent` because every read path
  // — an operator query, a future retry sweep, a billing count — asks "did this
  // reach anyone?", and the answer must be wrong-proof at a glance.
  simulated: "simulated",
  failed: "failed",
});

/** Providers this milestone can name. `dry_run` contacts nothing. */
const PROVIDERS = Object.freeze({ twilioSms: "twilio_sms", dryRun: "dry_run" });

/**
 * Every notification outcome, exhaustive.
 *
 * `delivered` is the hard boolean the agent's permission keys on. `attempted`
 * records whether we tried, which is a different fact and is what an operator
 * needs when asking why a locksmith heard nothing.
 */
const OUTCOMES = Object.freeze({
  sent: {
    code: "sent",
    state: STATES.sent,
    attempted: true,
    delivered: true,
    agentMessage: "The locksmith has been notified.",
  },
  simulated: {
    code: "simulated",
    state: STATES.simulated,
    // The pipeline DID run — claim, adapter, state write. That is worth knowing
    // and is exactly what a dry run is for.
    attempted: true,
    // Nothing reached anyone, so this is false and stays false. `notified` on
    // the tool response is derived from it, and the agent's permission from
    // that, so one word here governs the whole chain.
    delivered: false,
    agentMessage:
      "Their details are recorded. This is a test line and no message was actually sent to a locksmith — do not say the locksmith has been notified.",
  },
  failed: {
    code: "failed",
    state: STATES.failed,
    attempted: true,
    delivered: false,
    agentMessage:
      "Their details are recorded, but I could not get a message through to the locksmith. Tell the caller that plainly, and that ringing the locksmith directly is the surer option.",
  },
  noRecipient: {
    code: "no_recipient",
    state: STATES.notRequired,
    attempted: false,
    delivered: false,
    agentMessage:
      "Their details are recorded. Do not say the locksmith has been notified — no contact details are configured for this business.",
  },
  disabled: {
    code: "disabled",
    state: STATES.pending,
    attempted: false,
    delivered: false,
    // Stays PENDING, not not_required: this enquiry still deserves delivery,
    // the capability is merely switched off. not_required would tell a future
    // sweep to skip it forever.
    agentMessage:
      "Their details are recorded. Do not say the locksmith has been notified — nothing has been sent.",
  },
  alreadyHandled: {
    code: "already_handled",
    state: null, // whatever the row already holds; this outcome changes nothing
    attempted: false,
    delivered: false,
    agentMessage: "That is already recorded — no need to repeat it.",
  },
  unavailable: {
    code: "unavailable",
    state: STATES.pending,
    attempted: false,
    delivered: false,
    agentMessage:
      "Their details are recorded. Do not say the locksmith has been notified — nothing has been sent.",
  },
});

// Bounds for the message body. An SMS segment is 160 GSM-7 characters; three
// segments is a generous ceiling for "who, where, what, how urgent" and stops a
// pathological free-text field turning one job into a twenty-part message.
const MAX_BODY_CHARS = 480;

/**
 * Who should be told, from the APPROVED PROFILE.
 *
 * Recipients are a client configuration fact, never anything the model supplied
 * and never anything in the tool arguments. A model-chosen recipient is a
 * model-chosen disclosure of a caller's details.
 */
function resolveRecipients(profile, { urgency = null } = {}) {
  const notifications = (profile && profile.notifications) || {};
  const list = Array.isArray(notifications.sms) ? notifications.sms : [];
  const urgentOnly = Array.isArray(notifications.urgentOnly) ? notifications.urgentOnly : [];

  // urgentOnly numbers join in only for an urgent job; everything else gets the
  // standard list. Kept simple deliberately — routing rules are a later concern
  // and guessing at them now would be inventing product.
  const combined = urgency === "urgent" ? [...list, ...urgentOnly] : list;

  const seen = new Set();
  const out = [];
  for (const raw of combined) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * The message the locksmith receives.
 *
 * Carries what is needed to act: who, where, what, how urgent, and the callback
 * number. That IS the product — a notification without the caller's number is a
 * notification the locksmith cannot answer.
 *
 * It is never logged and never returned to the model.
 */
function buildNotificationBody({ enquiry, businessName = null, environment = "dev" }) {
  const line = (label, value) => (value ? `${label}: ${value}` : null);
  const parts = [
    // A sandbox message says so in its first characters, so a founder test can
    // never be mistaken for a real job by whoever reads it.
    environment === "prod" ? null : `[${String(environment).toUpperCase()} TEST — not a real job]`,
    businessName ? `New enquiry for ${businessName}` : "New enquiry",
    line("Name", enquiry.caller_name),
    line("Phone", enquiry.callback_number),
    line("Suburb", enquiry.suburb),
    line("Address", enquiry.street_address),
    line("Job", enquiry.problem_description),
    enquiry.urgency ? `Urgency: ${enquiry.urgency}` : null,
    enquiry.property_secure === false ? "Property NOT secure" : null,
    line("When", enquiry.desired_timing),
  ].filter(Boolean);

  const body = parts.join("\n");
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS - 1)}…` : body;
}

/**
 * Notify the locksmith about one persisted enquiry.
 *
 * @param {object}   enquiry          the row as written (already validated)
 * @param {object}   profile          the client's APPROVED profile
 * @param {object}   config           { enabled, provider, environment }
 * @param {Function} deps.claim       async ({enquiryId}) => {ok, claimed}
 *                                    the pending->sending transition. `claimed`
 *                                    false means somebody else has it.
 * @param {Function} deps.deliver     async ({to, body}) => {ok, reference, code}
 * @param {Function} deps.markSent    async ({enquiryId, provider, reference})
 * @param {Function} deps.markFailed  async ({enquiryId, provider, code})
 *
 * Returns { outcome, attempted, delivered, state, agentMessage, provider,
 *           reference } and NEVER throws. A notification that throws would take
 *           a successful enquiry capture down with it.
 */
async function notifyLocksmith({ enquiry, profile, config = {}, deps = {} } = {}) {
  const logger = deps.logger || console;
  const environment = config.environment || "dev";

  const result = (outcome, extra = {}) =>
    Object.freeze({
      version: NOTIFICATION_VERSION,
      outcome: outcome.code,
      attempted: outcome.attempted,
      delivered: outcome.delivered,
      state: outcome.state,
      agentMessage: outcome.agentMessage,
      provider: null,
      reference: null,
      // Never claimable by this milestone, stated so nothing later assumes it.
      acknowledged: false,
      ...extra,
    });

  if (!config.enabled) return result(OUTCOMES.disabled);
  if (!enquiry || !enquiry.id) return result(OUTCOMES.unavailable);

  const recipients = resolveRecipients(profile, { urgency: enquiry.urgency });
  if (!recipients.length) {
    // Nobody to tell. Recorded as not_required so a sweep does not chase it
    // forever, and the agent is told not to claim a notification.
    if (typeof deps.markNotRequired === "function") {
      try { await deps.markNotRequired({ enquiryId: enquiry.id }); } catch { /* bookkeeping only */ }
    }
    logger.log(`locksmith.notify.no_recipient enquiry=${enquiry.id} env=${environment}`);
    return result(OUTCOMES.noRecipient);
  }

  if (typeof deps.claim !== "function" || typeof deps.deliver !== "function") {
    return result(OUTCOMES.unavailable);
  }

  // ── THE DOUBLE-SEND GUARD ─────────────────────────────────────────
  // One statement moves pending -> sending and reports whether it won. A second
  // tool call for the same enquiry loses and sends nothing. Checking first and
  // then sending would leave exactly the gap this closes.
  let claim;
  try {
    claim = await deps.claim({ enquiryId: enquiry.id });
  } catch (err) {
    logger.error(`locksmith.notify.claim_failed enquiry=${enquiry.id} err=${err && err.message}`);
    return result(OUTCOMES.unavailable);
  }
  if (!claim || claim.ok !== true) return result(OUTCOMES.unavailable);
  if (claim.claimed !== true) {
    // Already sending, sent, or deliberately not required. Not our job, and
    // emphatically not a second message.
    logger.log(`locksmith.notify.already_handled enquiry=${enquiry.id} state=${claim.state || "-"}`);
    return result(OUTCOMES.alreadyHandled, { state: claim.state || null });
  }

  const body = buildNotificationBody({
    enquiry,
    businessName: ((profile || {}).identity || {}).spokenName || null,
    environment,
  });

  // ONE attempt. See the header for why there is no retry here.
  let delivery;
  try {
    delivery = await deps.deliver({ to: recipients[0], body, enquiryId: enquiry.id });
  } catch (err) {
    delivery = { ok: false, code: "delivery_threw", reference: null };
    logger.error(`locksmith.notify.deliver_threw enquiry=${enquiry.id}`);
  }

  const provider = (delivery && delivery.provider) || config.provider || PROVIDERS.dryRun;

  if (delivery && delivery.ok === true) {
    // ── SIMULATED OR REAL? (M7K-A) ──────────────────────────────────
    // Two independent signals, either of which forces `simulated`:
    //
    //   delivery.simulated === true   what the adapter says it did
    //   provider === PROVIDERS.dryRun what it says it is
    //
    // Belt and braces on purpose. A future adapter that forgets the flag, or a
    // config that mislabels the provider, must still fail CLOSED — towards "no
    // message exists" — because the failure mode in the other direction is
    // telling somebody locked out that help has been called when it has not.
    const isSimulated = delivery.simulated === true || provider === PROVIDERS.dryRun;

    if (isSimulated) {
      if (typeof deps.markSimulated === "function") {
        try {
          await deps.markSimulated({ enquiryId: enquiry.id, provider, reference: delivery.reference || null });
        } catch (err) {
          logger.error(`locksmith.notify.mark_simulated_failed enquiry=${enquiry.id} err=${err && err.message}`);
        }
      }
      logger.log(`locksmith.notify.simulated enquiry=${enquiry.id} provider=${provider} env=${environment} — NO MESSAGE SENT`);
      return result(OUTCOMES.simulated, { provider, reference: delivery.reference || null });
    }

    try {
      await deps.markSent({ enquiryId: enquiry.id, provider, reference: delivery.reference || null });
    } catch (err) {
      // The message WENT. Failing to write that down does not un-send it, and
      // telling the caller it failed would be the opposite lie to M7J-LV's.
      // Reported as sent, with the bookkeeping failure logged loudly.
      logger.error(`locksmith.notify.mark_sent_failed enquiry=${enquiry.id} err=${err && err.message}`);
    }
    logger.log(`locksmith.notify.sent enquiry=${enquiry.id} provider=${provider} env=${environment} recipients=${recipients.length}`);
    return result(OUTCOMES.sent, { provider, reference: delivery.reference || null });
  }

  const code = (delivery && delivery.code) || "delivery_failed";
  try {
    await deps.markFailed({ enquiryId: enquiry.id, provider, code });
  } catch (err) {
    logger.error(`locksmith.notify.mark_failed_failed enquiry=${enquiry.id} err=${err && err.message}`);
  }
  logger.error(`locksmith.notify.failed enquiry=${enquiry.id} provider=${provider} code=${code}`);
  return result(OUTCOMES.failed, { provider });
}

module.exports = {
  NOTIFICATION_VERSION,
  STATES,
  PROVIDERS,
  OUTCOMES,
  MAX_BODY_CHARS,
  resolveRecipients,
  buildNotificationBody,
  notifyLocksmith,
};
