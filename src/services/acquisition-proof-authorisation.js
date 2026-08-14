// AIDA Locksmith Acquisition — permission for ONE proof call (E-12H).
//
//   createProofAuthorisation({ ... })   → a scoped, single-use authorisation
//   bindProofAuthorisation(auth, {...}) → consume it for one exact dispatch
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────
// The first controlled acquisition call. Not a campaign, not a pilot batch —
// one call, to one number, from one number, through one agent, inside one
// window, authorised by one named person.
//
// ── WHY NOT ALLOW_TEST_CALL=true ────────────────────────────────────
// Because an environment variable authorises a state, not an act. It cannot
// name who decided, what they decided about, when it expires, or whether it has
// already been used — and it stays true afterwards. Every one of those is a way
// "one proof call" quietly becomes "calling is on".
//
// This repository already had the better pattern twice over, and this follows
// both rather than inventing a third:
//
//   acquisition-calling-approval  a named HUMAN approver, rejected if the name
//                                 looks automated, with a version and a date
//   acquisition-batch-approval    a canonical identity hash over exactly the
//                                 members approved, so approving one thing
//                                 cannot approve a different thing
//
// ── IT AUTHORISES NOTHING BY ITSELF ─────────────────────────────────
// This is a permission slip, not a gate. The authoritative pre-dial gate
// (M8E / acquisition-authorisation.js) still runs immediately before execution
// and still owns DNCR, suppression, hours, holidays, attempt policy, duplicate
// resolution and the calling state. A proof authorisation is one MORE thing
// that must be true — never a way around anything that already had to be.

const crypto = require("crypto");

const PROOF_AUTHORISATION_VERSION = "acq-proof-authorisation-2026-08-14";

/** The same rejection list the calling-policy approval uses. */
const NON_HUMAN_APPROVERS = /^(system|automation|automated|auto|aida|bot|robot|ai|agent|assistant|claude|gpt|llm|service|cron|scheduler|worker|daemon)$/i;

const E164 = /^\+[1-9][0-9]{6,14}$/;

/** A proof window is short on purpose: permission should expire, not linger. */
const MAX_WINDOW_MINUTES = 120;
const DEFAULT_WINDOW_MINUTES = 60;

const PROOF_CODES = Object.freeze({
  OK: "proof_authorised",
  NO_APPROVER: "proof_no_named_approver",
  NON_HUMAN: "proof_approver_not_a_person",
  NO_PROSPECT: "proof_no_prospect",
  BAD_DESTINATION: "proof_destination_not_e164",
  BAD_FROM: "proof_from_number_not_e164",
  SAME_NUMBER: "proof_from_equals_destination",
  NO_AGENT: "proof_no_agent",
  BAD_WINDOW: "proof_window_invalid",
  EXPIRED: "proof_expired",
  ALREADY_USED: "proof_already_used",
  SCOPE_MISMATCH: "proof_scope_mismatch",
});

const clip = (v, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/**
 * The canonical identity of exactly what is being authorised.
 *
 * Hashed the same way batch identity is: if any bound fact differs at use time,
 * the hash differs and the authorisation does not apply. This is what stops a
 * slip issued for one business being spent on another.
 */
function proofIdentity({ prospectId, destinationE164, fromNumber, agentId }) {
  const canonical = [
    `prospect:${prospectId}`,
    `to:${destinationE164}`,
    `from:${fromNumber}`,
    `agent:${agentId}`,
  ].join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Build a single-use, scoped authorisation for ONE proof call.
 *
 * Returns `{ ok: false, code, message }` rather than throwing, so a preflight
 * can report why permission does not exist without handling exceptions.
 */
function createProofAuthorisation({
  approvedBy,
  prospectId,
  destinationE164,
  fromNumber,
  agentId,
  reason = null,
  now,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
} = {}) {
  if (typeof now !== "function") throw new Error("createProofAuthorisation requires an injected now().");

  const who = clip(approvedBy, 120);
  if (!who) return refuse(PROOF_CODES.NO_APPROVER, "A proof call must be authorised by a named person.");
  if (NON_HUMAN_APPROVERS.test(who)) {
    return refuse(PROOF_CODES.NON_HUMAN, `"${who}" is not a person. A proof call cannot be authorised by the system that places it.`);
  }

  const prospect = clip(prospectId, 100);
  if (!prospect) return refuse(PROOF_CODES.NO_PROSPECT, "A proof call is bound to exactly one prospect.");

  if (!E164.test(String(destinationE164 || ""))) {
    return refuse(PROOF_CODES.BAD_DESTINATION, "A proof call names exactly one destination, in E.164.");
  }
  if (!E164.test(String(fromNumber || ""))) {
    return refuse(PROOF_CODES.BAD_FROM, "A proof call names exactly one acquisition number to dial from, in E.164.");
  }
  if (destinationE164 === fromNumber) {
    return refuse(PROOF_CODES.SAME_NUMBER, "The destination and the acquisition number are the same number.");
  }

  const agent = clip(agentId, 120);
  if (!agent) return refuse(PROOF_CODES.NO_AGENT, "A proof call is bound to exactly one agent.");

  if (!Number.isInteger(windowMinutes) || windowMinutes <= 0 || windowMinutes > MAX_WINDOW_MINUTES) {
    return refuse(PROOF_CODES.BAD_WINDOW, `A proof window must be between 1 and ${MAX_WINDOW_MINUTES} minutes.`);
  }

  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + windowMinutes * 60_000);

  return Object.freeze({
    ok: true,
    code: PROOF_CODES.OK,
    version: PROOF_AUTHORISATION_VERSION,
    approvedBy: who,
    reason: clip(reason, 600),
    // Exactly one of each. Named individually AND hashed together.
    prospectId: prospect,
    destinationE164,
    fromNumber,
    agentId: agent,
    identity: proofIdentity({ prospectId: prospect, destinationE164, fromNumber, agentId: agent }),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    // Single use. `bindProofAuthorisation` is the only thing that spends it.
    consumed: false,
    scope: "one_call",
  });
}

function refuse(code, message) {
  return Object.freeze({ ok: false, code, message });
}

/**
 * Spend the authorisation on one exact dispatch.
 *
 * Everything bound at creation must match, the window must still be open, and
 * it must not already have been used. Returns a CONSUMED copy — the original is
 * frozen, so a caller cannot un-spend it by mutating the object.
 */
function bindProofAuthorisation(auth, { prospectId, destinationE164, fromNumber, agentId, dispatchId, now } = {}) {
  if (typeof now !== "function") throw new Error("bindProofAuthorisation requires an injected now().");
  if (!auth || auth.ok !== true) return refuse(PROOF_CODES.SCOPE_MISMATCH, "There is no valid proof authorisation to bind.");
  if (auth.consumed) return refuse(PROOF_CODES.ALREADY_USED, "This proof authorisation has already been used. It authorises one call.");

  if (now() > new Date(auth.expiresAt)) {
    return refuse(PROOF_CODES.EXPIRED, `This proof authorisation expired at ${auth.expiresAt}.`);
  }

  const presented = proofIdentity({ prospectId, destinationE164, fromNumber, agentId });
  if (presented !== auth.identity) {
    return refuse(
      PROOF_CODES.SCOPE_MISMATCH,
      "This proof authorisation was issued for a different business, number or agent. It does not apply."
    );
  }

  const dispatch = clip(dispatchId, 100);
  if (!dispatch) return refuse(PROOF_CODES.SCOPE_MISMATCH, "Binding a proof authorisation requires the dispatch it is spent on.");

  return Object.freeze({
    ...auth,
    consumed: true,
    consumedAt: now().toISOString(),
    dispatchId: dispatch,
  });
}

/** Is this object a live, unspent, in-window proof authorisation? */
function isLiveProofAuthorisation(auth, now) {
  if (typeof now !== "function") throw new Error("isLiveProofAuthorisation requires an injected now().");
  return Boolean(auth && auth.ok === true && auth.consumed === false && now() <= new Date(auth.expiresAt));
}

module.exports = {
  createProofAuthorisation,
  bindProofAuthorisation,
  isLiveProofAuthorisation,
  proofIdentity,
  PROOF_CODES,
  PROOF_AUTHORISATION_VERSION,
  MAX_WINDOW_MINUTES,
  DEFAULT_WINDOW_MINUTES,
  NON_HUMAN_APPROVERS,
};
