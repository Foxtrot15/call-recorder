// AIDA Locksmith Acquisition — the agent contract and its analysis schema (E-7B2B1).
//
//   ACQUISITION_AGENT_CONTRACT        what the agent must and must not do
//   ACQUISITION_ANALYSIS_SCHEMA       the closed structured result it must return
//   validateAcquisitionAnalysis(raw)  the only door prose may come through
//   classifyAnalysedOutcome(analysis) analysis -> a durable CALL_OUTCOMES value
//   EXPLICIT_OPT_OUT_RULE             what counts, and what deliberately does not
//
// ── LOCAL ONLY. NOTHING HERE CREATES OR CONTACTS AN AGENT ───────────
// This is a specification and a validator. It builds no Retell agent, reads no
// credential, names no endpoint and reaches no network. Provisioning the agent
// is E-7B2B and is a founder-authorised network write.
//
// ── WHY THE ACQUISITION AGENT CANNOT BE ONE OF THE EXISTING TWO ─────
// The receptionist serves a locksmith's own inbound callers. The onboarding
// agent interviews a client who ASKED to be interviewed. This one telephones a
// business that did not ask, has never heard of us, and owes us nothing. It is
// the only one of the three that must identify itself unprompted, take a no,
// and record a request never to be called again. Reusing either of the others
// would be a compliance problem wearing the costume of code reuse.
//
// ── THE DURABLE OUTCOME IS NEVER THE MODEL'S PROSE ──────────────────
// An acquisition outcome can suppress a business permanently. That consequence
// may not rest on a sentence a language model wrote. So the agent returns a
// STRUCTURED result, it is validated against a closed schema here, and anything
// that does not fit becomes "needs a human" rather than a guess.

/** Analysis outcomes the agent may report. Closed, and smaller than it could be. */
const ANALYSED_OUTCOMES = Object.freeze([
  "interested",
  "not_interested",
  "declined",
  "callback_requested",
  "wrong_person",
  "no_meaningful_conversation",
]);

const CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low"]);

/**
 * THE AGENT CONTRACT.
 *
 * Prose deliberately: this is the specification a prompt is written against and
 * a human reviews, not a template with holes. Every clause is a rule somebody
 * could otherwise argue was implied.
 */
const ACQUISITION_AGENT_CONTRACT = Object.freeze({
  purpose: "cold_acquisition",
  version: "acq-agent-contract-2026-08-13",
  appliesTo: "Outbound acquisition calls to locksmith businesses that have not asked to be contacted.",

  identity: Object.freeze([
    "Identify the calling business by name at the start, unprompted.",
    "State the commercial purpose in plain language within the first few sentences.",
    "Never present as an inbound customer, a caller with a lock problem, or anyone seeking a quote.",
    "Never misrepresent why the call is happening, and never imply a prior relationship, referral or enquiry that does not exist.",
  ]),

  // DELIBERATELY NOT DECIDED HERE. M8M's calling policy is a founder operating
  // policy and explicitly left AI disclosure wording out of scope. Inventing a
  // form of words here would manufacture a compliance position nobody adopted.
  aiDisclosure: Object.freeze({
    decided: false,
    wording: null,
    note:
      "AI disclosure wording is an OPEN founder/compliance decision, not an engineering one. " +
      "No wording is invented here, and none is implied. It must be supplied and approved before any live call.",
  }),

  behaviour: Object.freeze([
    "Open concisely. No monologue.",
    "Stop speaking when interrupted, and let the person finish.",
    "Answer ordinary objections once, plainly, without pressure.",
    "Never argue with, question, or attempt to talk somebody out of a refusal.",
    "Honour an explicit request not to be contacted immediately, acknowledge it, and end the call politely.",
    "Recognise and confirm a request to be called back at another time.",
    "Do not repeat the pitch after a clear decline.",
    "Make no claim about AIDA's capabilities that is not true, and promise no feature that does not exist.",
    "Quote no price, term or guarantee that has not been approved.",
    "Do not collect payment details, and do not ask for them.",
  ]),

  prohibitions: Object.freeze([
    "No second pitch after a decline.",
    "No pressure, urgency tactics or invented scarcity.",
    "No claim of an existing relationship, referral, or previous conversation.",
    "No unsupported capability or outcome claims.",
    "No negotiation with an opt-out.",
  ]),

  mustReturn: "A structured post-call analysis conforming to ACQUISITION_ANALYSIS_SCHEMA.",
});

/**
 * THE EXPLICIT OPT-OUT RULE.
 *
 * Conservative on purpose, and asymmetric on purpose: an opt-out written in
 * error is permanent and append-only, and an opt-out missed is corrected by the
 * next conversation. Those costs are not equal, so the rule leans towards
 * refusing to record one.
 */
const EXPLICIT_OPT_OUT_RULE = Object.freeze({
  version: "acq-optout-rule-2026-08-13",
  counts: Object.freeze([
    "don't call me again",
    "remove me from your list",
    "stop calling",
    "do not contact me",
    "take me off your list",
  ]),
  // These are refusals of THIS CALL, not of all future contact. Under the
  // founder policy a decline is already permanent for cold acquisition
  // (A-L8) — so nothing is lost by refusing to inflate one into an opt-out,
  // and a request nobody made is not recorded on their behalf.
  doesNotCount: Object.freeze([
    "busy",
    "not now",
    "already have someone",
    "we're sorted",
    "maybe later",
    "call back another time",
    "not interested",
  ]),
  note:
    "not_interested and declined remain DISTINCT permanent acquisition outcomes. An opt-out is a " +
    "stronger, business-wide, cross-campaign suppression and requires the person to have asked for it.",
});

/** The closed schema. Anything outside it is not an analysis. */
const ACQUISITION_ANALYSIS_SCHEMA = Object.freeze({
  version: "acq-analysis-1",
  fields: Object.freeze({
    reached_human: "boolean — did a person actually speak with the agent",
    outcome: `one of ${ANALYSED_OUTCOMES.join(", ")}`,
    explicit_opt_out: "boolean — did they ask not to be contacted again, per EXPLICIT_OPT_OUT_RULE",
    callback_requested: "boolean",
    requested_callback_at: "ISO 8601 instant, or null when no time was stated",
    confidence: `one of ${CONFIDENCE_LEVELS.join(", ")}`,
    reason: "one short sentence, for a human reading the record",
    evidence_ref: "a locator into the transcript. NOT the transcript itself",
  }),
});

const ANALYSIS_CODES = Object.freeze({
  OK: "analysis_valid",
  MALFORMED: "analysis_malformed",
  UNKNOWN_OUTCOME: "analysis_unknown_outcome",
  UNSUPPORTED_OPT_OUT: "analysis_opt_out_unsupported",
  INCOHERENT: "analysis_incoherent",
});

const isBool = (v) => typeof v === "boolean";
const isText = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Validate a structured analysis. Never throws; returns a verdict.
 *
 * ── THE OPT-OUT IS HELD TO A HIGHER STANDARD THAN ANYTHING ELSE ─────
 * `explicit_opt_out: true` is accepted only with HIGH confidence and a piece of
 * evidence pointing at where it was said. A low-confidence opt-out is not
 * downgraded to a decline and is not quietly dropped — the whole analysis is
 * returned as UNSUPPORTED so a human looks at it. Guessing in either direction
 * would be worse than admitting we do not know.
 */
function validateAcquisitionAnalysis(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return Object.freeze({ ok: false, code: ANALYSIS_CODES.MALFORMED, message: "The post-call analysis was not an object." });
  }

  const missing = [];
  if (!isBool(raw.reached_human)) missing.push("reached_human");
  if (!isBool(raw.explicit_opt_out)) missing.push("explicit_opt_out");
  if (!isBool(raw.callback_requested)) missing.push("callback_requested");
  if (!CONFIDENCE_LEVELS.includes(raw.confidence)) missing.push("confidence");
  if (!isText(raw.reason)) missing.push("reason");
  if (missing.length) {
    return Object.freeze({
      ok: false,
      code: ANALYSIS_CODES.MALFORMED,
      message: `The post-call analysis is missing or malformed: ${missing.join(", ")}.`,
    });
  }

  if (!ANALYSED_OUTCOMES.includes(raw.outcome)) {
    return Object.freeze({
      ok: false,
      code: ANALYSIS_CODES.UNKNOWN_OUTCOME,
      message: `"${raw.outcome}" is not an outcome this system understands, so it is not recorded as anything.`,
    });
  }

  // An opt-out must be evidenced and confident, or it is not acted on.
  if (raw.explicit_opt_out === true && (raw.confidence !== "high" || !isText(raw.evidence_ref))) {
    return Object.freeze({
      ok: false,
      code: ANALYSIS_CODES.UNSUPPORTED_OPT_OUT,
      message:
        "An explicit opt-out was reported without high confidence and transcript evidence. It is NOT recorded as an " +
        "opt-out and NOT downgraded to a decline — a human decides. Suppression is permanent and append-only.",
    });
  }

  // Nobody spoke to us, yet a conversational conclusion was drawn.
  if (raw.reached_human === false && ["interested", "not_interested", "declined", "callback_requested"].includes(raw.outcome)) {
    return Object.freeze({
      ok: false,
      code: ANALYSIS_CODES.INCOHERENT,
      message: `The analysis reports "${raw.outcome}" while also reporting that no person was reached.`,
    });
  }

  if (raw.explicit_opt_out === true && raw.reached_human === false) {
    return Object.freeze({
      ok: false,
      code: ANALYSIS_CODES.INCOHERENT,
      message: "An opt-out cannot have been requested by somebody who never spoke to us.",
    });
  }

  return Object.freeze({
    ok: true,
    code: ANALYSIS_CODES.OK,
    analysis: Object.freeze({
      reachedHuman: raw.reached_human,
      outcome: raw.outcome,
      explicitOptOut: raw.explicit_opt_out,
      callbackRequested: raw.callback_requested,
      requestedCallbackAt: isText(raw.requested_callback_at) ? raw.requested_callback_at : null,
      confidence: raw.confidence,
      reason: String(raw.reason).slice(0, 300),
      evidenceRef: isText(raw.evidence_ref) ? String(raw.evidence_ref).slice(0, 200) : null,
    }),
  });
}

/**
 * A validated analysis -> a durable CALL_OUTCOMES value, or nothing.
 *
 * Returns `{ outcome: null }` when the honest answer is that we do not know.
 * That is not a failure: the dispatch stays unresolved, holding both locks, and
 * an operator sees it in the unresolved report. Inventing an outcome to close a
 * row would be trading a durable falsehood for a tidy queue.
 */
function classifyAnalysedOutcome(analysis) {
  if (!analysis || typeof analysis !== "object") return Object.freeze({ outcome: null, reason: "no analysis" });

  // Precedence: the strongest, most consequential statement wins, because it is
  // the one whose omission causes harm.
  if (analysis.explicitOptOut === true) {
    return Object.freeze({ outcome: "opt_out", reason: "They asked not to be contacted again." });
  }
  if (analysis.outcome === "wrong_person") {
    return Object.freeze({ outcome: "wrong_person", reason: "The number does not reach this business." });
  }
  if (analysis.outcome === "callback_requested" || analysis.callbackRequested === true) {
    return Object.freeze({ outcome: "callback", reason: "They asked to be called back.", callbackAt: analysis.requestedCallbackAt || null });
  }
  if (analysis.outcome === "not_interested") {
    return Object.freeze({ outcome: "not_interested", reason: "They are not interested." });
  }
  if (analysis.outcome === "declined") {
    return Object.freeze({ outcome: "declined", reason: "They declined." });
  }
  if (analysis.outcome === "interested") {
    // "qualified", not "booked". A booking is a commitment to a specific time,
    // and nothing here can confirm one was made.
    return Object.freeze({ outcome: "qualified", reason: "They were interested enough to continue." });
  }

  // no_meaningful_conversation, and anything that reached this line.
  return Object.freeze({ outcome: null, reason: "No conclusion the record should carry." });
}

module.exports = {
  ACQUISITION_AGENT_CONTRACT,
  ACQUISITION_ANALYSIS_SCHEMA,
  EXPLICIT_OPT_OUT_RULE,
  ANALYSED_OUTCOMES,
  CONFIDENCE_LEVELS,
  ANALYSIS_CODES,
  validateAcquisitionAnalysis,
  classifyAnalysedOutcome,
};
