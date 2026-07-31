// AIDA — call-forwarding setup experience (M5).
//
// The last step of onboarding and the only one AIDA cannot do for the client:
// pointing their existing business number at AIDA. This module models that
// journey. It does not dial anything, does not activate a diversion, and does
// not talk to a carrier — a diversion is set by the client, on their own
// handset, from their own SIM. There is no API for it.
//
// ─── THE CODES COME FROM divert-codes.js, ALWAYS ────────────────────
// services/divert-codes.js is verified, carries a template version, and knows
// the AU carrier and handset matrix. This module NEVER writes a GSM code,
// never guesses a carrier prefix, and never edits the strings it gets back.
// Inventing a diversion code would send a locksmith's emergency calls into a
// dead number, so the rule is absolute: if divert-codes cannot produce it, the
// portal shows the manual-help path instead.
//
// ─── NO PLACEHOLDER NUMBER, EVER ────────────────────────────────────
// Instructions cannot be generated until a real provisioned AIDA number
// exists. A sample or placeholder number in a set of dialling instructions is
// worse than no instructions: it looks authoritative and it is wrong. The
// journey therefore starts in `not_ready` and stays there until provisioning
// supplies a number.
//
// Pure core + a thin adapter, dep-free.

const {
  buildDivertCodes,
  validateTargetNumber,
  CARRIERS,
  PLATFORMS,
  LOOP_KEYS,
  NO_ANSWER_DELAY_OPTIONS,
  DEFAULT_NO_ANSWER_DELAY_SECONDS,
  RECOMMENDED_DISCLAIMER,
  MANUAL_HELP_NOTE,
  TEMPLATE_VERSION,
} = require("./divert-codes");

const FORWARDING_VERSION = "call-forwarding-journey-2026-08-01";

// ── The eight states ────────────────────────────────────────────────
// Ordered as the client experiences them. `clientFacing` is what the portal
// says; the key is what the database stores.
const FORWARDING_STATES = Object.freeze({
  not_ready: {
    order: 0,
    label: "Not ready yet",
    detail: "Your AIDA number is still being set up. There is nothing for you to do.",
    owner: "aida",
    terminal: false,
  },
  ready_to_set_up: {
    order: 1,
    label: "Ready to set up",
    detail: "Your AIDA number is ready. Tell us your carrier and handset and we will give you the exact codes.",
    owner: "client",
    terminal: false,
  },
  instructions_generated: {
    order: 2,
    label: "Your codes are ready",
    detail: "Dial each code on the phone that has your business number in it.",
    owner: "client",
    terminal: false,
  },
  client_reports_done: {
    order: 3,
    label: "You have dialled the codes",
    detail: "Now let us check it actually worked.",
    owner: "client",
    terminal: false,
  },
  verification_pending: {
    order: 4,
    label: "Checking it works",
    detail: "Ring your business number from another phone and let it go unanswered.",
    owner: "client",
    terminal: false,
  },
  confirmed_working: {
    order: 5,
    label: "Working",
    detail: "Calls you do not answer now reach AIDA.",
    owner: "none",
    terminal: true,
  },
  needs_help: {
    order: 6,
    label: "Needs a hand",
    detail: "Something did not work. We will contact you.",
    owner: "aida",
    terminal: false,
  },
  turned_off: {
    order: 7,
    label: "Turned off",
    detail: "Forwarding to AIDA is cancelled. Your phone behaves as it did before.",
    owner: "client",
    terminal: true,
  },
});

const FORWARDING_STATE_KEYS = Object.freeze(Object.keys(FORWARDING_STATES));

const FORWARDING_TRANSITIONS = Object.freeze({
  not_ready: ["ready_to_set_up"],
  ready_to_set_up: ["instructions_generated", "not_ready", "needs_help"],
  instructions_generated: ["client_reports_done", "ready_to_set_up", "needs_help"],
  client_reports_done: ["verification_pending", "instructions_generated", "needs_help"],
  verification_pending: ["confirmed_working", "needs_help", "instructions_generated"],
  // Not terminal in practice: a client can change carrier, or turn it off.
  confirmed_working: ["needs_help", "turned_off", "ready_to_set_up"],
  needs_help: ["instructions_generated", "ready_to_set_up", "confirmed_working"],
  turned_off: ["ready_to_set_up"],
});

function canTransition(from, to) {
  return Boolean(FORWARDING_TRANSITIONS[from]) && FORWARDING_TRANSITIONS[from].includes(to);
}

/**
 * The state a client should be in, given the facts. Computed rather than
 * trusted, so a stored state that no longer matches reality (the AIDA number
 * was released, say) cannot leave someone looking at dialling instructions for
 * a number that is gone.
 */
function deriveState({ storedState = "not_ready", aidaNumber = null, verification = null }) {
  const hasNumber = Boolean(aidaNumber && validateTargetNumber(aidaNumber).ok);

  // No number means no instructions, whatever the stored state claims.
  if (!hasNumber) return { state: "not_ready", corrected: storedState !== "not_ready", reason: "No AIDA number is allocated yet." };

  if (storedState === "not_ready") return { state: "ready_to_set_up", corrected: true, reason: "An AIDA number is now allocated." };

  if (!FORWARDING_STATE_KEYS.includes(storedState)) {
    return { state: "ready_to_set_up", corrected: true, reason: "Unrecognised saved state." };
  }

  // A passed verification is conclusive; a failed one sends the client back to
  // the instructions rather than leaving them believing it works.
  if (verification && verification.outcome === "passed" && storedState !== "turned_off") {
    return { state: "confirmed_working", corrected: storedState !== "confirmed_working", reason: "A test call reached AIDA." };
  }
  if (verification && verification.outcome === "failed" && storedState === "confirmed_working") {
    return { state: "needs_help", corrected: true, reason: "A test call did not reach AIDA." };
  }

  return { state: storedState, corrected: false, reason: null };
}

// ── Instruction generation ──────────────────────────────────────────

/**
 * Produce the client's dialling instructions.
 *
 * Refuses without a real AIDA number. Delegates every code to divert-codes and
 * passes its output through untouched.
 */
function buildForwardingInstructions({ aidaNumber, carrier, phonePlatform, loops, noAnswerDelaySeconds, businessNumber = null }) {
  if (!aidaNumber) {
    return {
      ok: false,
      code: "no_aida_number",
      message: "Your AIDA number has not been set up yet. We will let you know the moment it is ready.",
    };
  }
  const numberCheck = validateTargetNumber(aidaNumber);
  if (!numberCheck.ok) {
    // A malformed provisioned number is our fault, not the client's, and it
    // must never be rendered into instructions.
    return {
      ok: false,
      code: "invalid_aida_number",
      message: "There is a problem with your AIDA number. We are on it — please do not change anything yet.",
      internal: numberCheck.error,
    };
  }

  // Diverting a number to itself would loop the call. Cheap to check, and the
  // failure mode is a customer hearing an engaged tone forever.
  if (businessNumber) {
    const business = validateTargetNumber(businessNumber);
    if (business.ok && business.e164 === numberCheck.e164) {
      return {
        ok: false,
        code: "self_divert",
        message: "That would divert your number to itself. Check the number and try again.",
      };
    }
  }

  const built = buildDivertCodes({
    carrier,
    phonePlatform,
    loops: normaliseLoops(loops),
    targetNumber: numberCheck.e164,
    noAnswerDelaySeconds: NO_ANSWER_DELAY_OPTIONS.includes(noAnswerDelaySeconds) ? noAnswerDelaySeconds : DEFAULT_NO_ANSWER_DELAY_SECONDS,
  });

  if (!built.ok) return { ok: false, code: "invalid_setup", message: "Check your answers below.", errors: built.errors };

  return {
    ok: true,
    instructions: built.result,
    // The client is told plainly what this does and does not change, because
    // the commonest support call is "has AIDA taken over my phone?".
    reassurance: [
      "Your number does not change. Customers keep ringing the same number.",
      "Calls you answer yourself are unaffected — AIDA only picks up the ones you don't.",
      "You can undo this at any time with the cancel codes below.",
    ],
    verification: buildVerificationSteps(),
    templateVersion: TEMPLATE_VERSION,
  };
}

/** Only the three loops divert-codes knows about, coerced to booleans. */
function normaliseLoops(raw) {
  const loops = {};
  for (const key of LOOP_KEYS) loops[key] = raw ? raw[key] === true : false;
  return loops;
}

/**
 * How the client proves it worked. Deliberately a real call rather than a
 * checkbox: "I dialled the codes" and "diversion is active" are different
 * claims, and only one of them is worth going live on.
 */
function buildVerificationSteps() {
  return {
    method: "client_places_test_call",
    steps: [
      "Use a different phone from the one you set the codes on.",
      "Ring your business number.",
      "Let it ring out without answering.",
      "AIDA should pick up and answer as your business.",
    ],
    ifItWorks: "Tell us it worked and you are live.",
    ifItDoesNot: "Tell us it did not, and we will work out which code your carrier wants. Nothing is broken — your phone still rings as normal.",
    // No billable call is placed by AIDA here. The client rings their own
    // number; AIDA answers an inbound call it was going to answer anyway.
    placesOutboundCall: false,
  };
}

/**
 * A client claiming "done" is evidence, not proof. Recorded as a claim, with
 * the verification still outstanding, so the launch-readiness model does not
 * mark someone live on their own optimism.
 */
function recordClientClaim({ state, claimedAt, note = null }) {
  if (!canTransition(state, "client_reports_done")) {
    return { ok: false, code: "invalid_state", message: `Cannot record that from "${state}".` };
  }
  return {
    ok: true,
    next: "client_reports_done",
    claim: {
      claimedAt,
      note: typeof note === "string" ? note.replace(/\s+/g, " ").trim().slice(0, 300) : null,
      verified: false,
    },
  };
}

/**
 * Record the outcome of the client's own test call.
 *
 * `evidence` is the honest part: we did not observe the diversion, we observed
 * an inbound call arriving. If a matching call landed, that is real evidence.
 * If the client simply says it worked, that is a self-report, and it is stored
 * as one.
 */
function recordVerification({ state, outcome, observedCallId = null, at }) {
  if (!["passed", "failed"].includes(outcome)) {
    return { ok: false, code: "invalid_outcome", message: "Outcome must be passed or failed." };
  }
  const target = outcome === "passed" ? "confirmed_working" : "needs_help";
  if (!canTransition(state, target)) {
    return { ok: false, code: "invalid_state", message: `Cannot record a ${outcome} test from "${state}".` };
  }
  return {
    ok: true,
    next: target,
    verification: {
      outcome,
      at,
      observedCallId,
      evidence: observedCallId ? "observed_inbound_call" : "client_self_report",
    },
  };
}

/** What the portal shows for the current state, including what to do next. */
function projectForwardingView({ storedState, aidaNumber, verification, setup = null }) {
  const derived = deriveState({ storedState, aidaNumber, verification });
  const meta = FORWARDING_STATES[derived.state];

  return {
    forwardingVersion: FORWARDING_VERSION,
    state: derived.state,
    label: meta.label,
    detail: meta.detail,
    owner: meta.owner,
    // Never rendered unless it is real and valid.
    aidaNumber: aidaNumber && validateTargetNumber(aidaNumber).ok ? validateTargetNumber(aidaNumber).e164 : null,
    corrected: derived.corrected,
    correctionReason: derived.reason,
    working: derived.state === "confirmed_working",
    setup: setup || null,
    carriers: Object.entries(CARRIERS).map(([key, c]) => ({ key, label: c.label || key })),
    platforms: Object.entries(PLATFORMS).map(([key, p]) => ({ key, label: p.label || key })),
    loops: LOOP_KEYS.slice(),
    delayOptions: NO_ANSWER_DELAY_OPTIONS.slice(),
    disclaimer: RECOMMENDED_DISCLAIMER,
    manualHelpNote: MANUAL_HELP_NOTE,
    canGenerate: ["ready_to_set_up", "instructions_generated", "needs_help", "confirmed_working", "turned_off"].includes(derived.state),
  };
}

// ── Adapter ─────────────────────────────────────────────────────────

const TABLE = "locksmith_call_forwarding";

function tableMissing(err) {
  const msg = err && (err.message || err.details || "");
  return /relation .* does not exist|could not find the table|schema cache/i.test(String(msg));
}

function provisioningError() {
  const e = new Error("Call-forwarding state is not provisioned yet. Apply supabase/sql/lpm5_create_client_portal.sql.");
  e.code = "call_forwarding_unavailable";
  return e;
}

async function loadForwarding(clientId, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const { data, error } = await db.from(TABLE).select("*").eq("client_id", clientId).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw error;
  }
  if (!data) return { clientId, state: "not_ready", setup: null, verification: null, claim: null, updatedAt: null };
  return {
    clientId,
    state: FORWARDING_STATE_KEYS.includes(data.state) ? data.state : "not_ready",
    setup: data.setup || null,
    verification: data.verification || null,
    claim: data.claim || null,
    updatedAt: data.updated_at || null,
  };
}

async function saveForwarding(clientId, patch, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const row = { client_id: clientId, ...patch, forwarding_version: FORWARDING_VERSION, updated_at: new Date().toISOString() };
  const { data, error } = await db.from(TABLE).upsert(row, { onConflict: "client_id" }).select().maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw error;
  }
  return { ok: true, saved: data };
}

module.exports = {
  FORWARDING_VERSION,
  FORWARDING_STATES,
  FORWARDING_STATE_KEYS,
  FORWARDING_TRANSITIONS,
  canTransition,
  deriveState,
  buildForwardingInstructions,
  buildVerificationSteps,
  normaliseLoops,
  recordClientClaim,
  recordVerification,
  projectForwardingView,
  loadForwarding,
  saveForwarding,
  TABLE,
};
