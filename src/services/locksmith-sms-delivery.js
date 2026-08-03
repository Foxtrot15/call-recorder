// AIDA — SMS delivery adapter for enquiry notifications (M7K).
//
// ─── WHY SMS AND NOT EMAIL ──────────────────────────────────────────
// Decided on what this repository already supports, not on preference:
//
//   Twilio SMS   services/twilio-client.js already provides a lazy, memoised
//                client that REPORTS a refusal ({ok:false, reason}) instead of
//                throwing on missing credentials — exactly the shape a delivery
//                adapter needs. The canonical profile already carries a
//                validated `notifications.sms` list, and the sandbox profile
//                already has an ACMA fictitious recipient in it.
//
//   Gmail        services/notify.js sends through the Gmail API using a
//                PER-CLIENT Google OAuth token (getToken(clientId,"google")).
//                The sandbox client has no such token, and creating one means
//                connecting a real mailbox to a founder test. `notifications.
//                email` exists on the profile but nothing populates it.
//
// One channel, no fallback — a fallback that has never delivered anything is a
// second untested path, and this milestone is about being able to say one true
// sentence.
//
// ─── DRY RUN IS THE DEFAULT ─────────────────────────────────────────
// `live` must be asked for explicitly. Anything else — unset, misspelt,
// "true", "yes" — is a dry run that contacts nobody and returns a simulated
// acceptance. The founder can therefore prove the whole pipeline, including the
// state transition and the agent's wording, without a message reaching a
// handset.
//
// ─── AND LIVE MODE STILL CANNOT TEXT WHOEVER IT LIKES (M7L) ─────────
// In any non-production environment, live sending IGNORES the approved profile
// and delivers only to an explicitly configured sandbox recipient. See
// resolveLiveRecipient — that gate is why enabling live mode in the sandbox
// cannot message a real locksmith even if a real profile is loaded.

const DELIVERY_VERSION = "locksmith-sms-delivery-2026-08-03";

const MODES = Object.freeze({ dryRun: "dry_run", live: "live" });

/**
 * Only the exact string "live" selects real sending. House strict-parse rule:
 * an unrecognised value is not a warning, it is off.
 */
function resolveMode(env = process.env) {
  return env.LOCKSMITH_NOTIFY_MODE === MODES.live ? MODES.live : MODES.dryRun;
}

/** Australian E.164 only — the same shape the enquiry table stores. */
function isSendableNumber(value) {
  return typeof value === "string" && /^\+[1-9][0-9]{7,14}$/.test(value);
}

// ── THE SANDBOX RECIPIENT GATE (M7L) ────────────────────────────────
//
// Until now the recipient came from the client's approved profile, and in a dry
// run that was harmless because nothing was sent. Live mode changes what that
// means entirely:
//
//   * the sandbox profile holds an ACMA FICTITIOUS number. Twilio cannot
//     deliver to it, so a "live" send there proves nothing and still costs.
//   * worse, nothing stopped a DEV deployment texting whatever a profile
//     happened to contain. Load a real client's profile into this sandbox and
//     the first live enquiry messages a real locksmith about a fictional job.
//
// So in any non-production environment, live sending ignores the profile
// entirely and delivers ONLY to an explicitly configured sandbox recipient —
// a number the founder controls and enters themselves. Unset, live sending
// fails closed and nothing leaves.
//
// The ACMA range is refused OUTRIGHT in live mode. It exists to be unreachable;
// asking a carrier to deliver to it is not a test, it is a billed no-op.
const ACMA_FICTITIOUS = /^\+61491570(0(0[6-9]|[1-9]\d)|1[0-5]\d)$/;

/**
 * Who this deployment is allowed to text, and why not.
 *
 * Returns { ok, to, reason }. `to` is null whenever ok is false — there is no
 * partial success and no fallback recipient.
 */
function resolveLiveRecipient({ env = process.env, requested = null } = {}) {
  const environment = env.RETELL_ALLOWED_TAG || "dev";

  // Production behaves as designed: the business's own configured recipients.
  if (environment === "prod") {
    if (!isSendableNumber(requested)) return { ok: false, to: null, reason: "no usable recipient on the approved profile" };
    return { ok: true, to: requested, reason: null };
  }

  // Everything else is a sandbox, and a sandbox may only ever text one number.
  const raw = env.LOCKSMITH_NOTIFY_SANDBOX_RECIPIENT;
  if (!raw) {
    return {
      ok: false,
      to: null,
      reason: "LOCKSMITH_NOTIFY_SANDBOX_RECIPIENT is not set — a non-production deployment may only send to an explicitly configured sandbox recipient",
    };
  }

  // Normalised through the ONE canonical gate, not a second idea of dialable.
  const { normaliseAuNumber } = require("./locksmith-profile");
  const canonical = normaliseAuNumber(String(raw).trim());
  if (!canonical) return { ok: false, to: null, reason: "LOCKSMITH_NOTIFY_SANDBOX_RECIPIENT is not a dialable Australian number" };

  if (ACMA_FICTITIOUS.test(canonical)) {
    return { ok: false, to: null, reason: "the configured sandbox recipient is in the ACMA fictitious range and can never receive a message" };
  }

  return { ok: true, to: canonical, reason: null };
}

/**
 * Build the delivery function the notification service injects.
 *
 * Returns async ({to, body, enquiryId}) => {ok, provider, reference, code}.
 * Never throws: a thrown adapter would turn a recorded enquiry into a failed
 * tool call, and the enquiry is the thing that matters most.
 */
function createSmsDelivery(deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  const mode = deps.mode || resolveMode(env);
  const getClient = deps.getTwilioClient || require("./twilio-client").getTwilioClient;

  return async function deliverSms({ to, body, enquiryId }) {
    if (!isSendableNumber(to)) {
      return { ok: false, provider: mode === MODES.live ? "twilio_sms" : "dry_run", reference: null, code: "unsendable_recipient" };
    }
    if (typeof body !== "string" || !body.trim()) {
      return { ok: false, provider: mode === MODES.live ? "twilio_sms" : "dry_run", reference: null, code: "empty_body" };
    }

    // ── DRY RUN: the whole pipeline, none of the sending ──────────────
    if (mode !== MODES.live) {
      // Length and recipient SHAPE are logged; the body never is. It carries a
      // caller's name, number and address.
      logger.log(
        `locksmith.sms.dry_run enquiry=${enquiryId || "-"} to=•••${String(to).slice(-3)} ` +
          `chars=${body.length} segments=${Math.ceil(body.length / 160)}`
      );
      return {
        // `ok` means the pipeline ran, NOT that a message exists. The two were
        // conflated in the first M7K cut: a dry run reported ok:true and the
        // service read that as delivered, stored `sent`, and let the agent say
        // the locksmith had been notified. Nothing had been sent to anybody.
        ok: true,
        // THE DISCRIMINATOR. Carried on the RESULT rather than inferred from
        // configuration, so a mis-set flag cannot turn a simulation into a
        // claimed delivery — the thing that actually sent the message is the
        // only thing that gets to say whether one exists.
        simulated: true,
        provider: "dry_run",
        // Marked unmistakably. Nobody reading a row later can take this for a
        // Twilio message id.
        reference: `dryrun_${enquiryId || "unknown"}`,
        code: null,
      };
    }

    // ── LIVE ──────────────────────────────────────────────────────────
    //
    // The recipient gate runs FIRST, before credentials or the client, so a
    // misconfigured destination can never reach the point of being sent.
    const recipient = resolveLiveRecipient({ env, requested: to });
    if (!recipient.ok) {
      logger.error(`locksmith.sms.recipient_refused reason=${recipient.reason}`);
      return { ok: false, provider: "twilio_sms", reference: null, code: "recipient_not_permitted" };
    }
    // In a sandbox this is the configured founder number, NOT what the profile
    // asked for. Logged as a shape only; the value never appears.
    const destination = recipient.to;

    const from = env.TWILIO_NUMBER || env.TWILIO_PHONE_NUMBER || null;
    if (!from) {
      logger.error("locksmith.sms.no_sender");
      return { ok: false, provider: "twilio_sms", reference: null, code: "no_sender_configured" };
    }

    const twilio = getClient({ env });
    if (!twilio.ok) {
      // A reported refusal, not a throw — twilio-client's whole contract.
      logger.error(`locksmith.sms.client_unavailable reason=${twilio.reason}`);
      return { ok: false, provider: "twilio_sms", reference: null, code: "client_unavailable" };
    }

    try {
      const message = await twilio.client.messages.create({ from, to: destination, body });
      logger.log(`locksmith.sms.sent enquiry=${enquiryId || "-"} to=•••${String(destination).slice(-3)} sid=${message && message.sid ? "present" : "missing"}`);
      // simulated:false stated explicitly rather than omitted. This is the ONLY
      // place in the codebase that may assert a real message exists, and it
      // should be greppable as such.
      return { ok: true, simulated: false, provider: "twilio_sms", reference: (message && message.sid) || null, code: null };
    } catch (err) {
      // Twilio error messages can echo the destination number, so the CODE is
      // recorded and the message is not.
      const code = (err && (err.code || err.status)) || "send_failed";
      logger.error(`locksmith.sms.send_failed enquiry=${enquiryId || "-"} code=${code}`);
      return { ok: false, provider: "twilio_sms", reference: null, code: String(code).slice(0, 100) };
    }
  };
}

module.exports = { DELIVERY_VERSION, MODES, ACMA_FICTITIOUS, resolveMode, isSendableNumber, resolveLiveRecipient, createSmsDelivery };
