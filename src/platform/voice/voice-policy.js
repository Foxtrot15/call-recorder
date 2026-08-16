// AIDA VOICE CONFIGURATION — what a telephone call may never do (P43).
//
//   assessRequest({ intent, payload, transcript, session })
//     -> { allowed, refusal, spoken }
//   FORBIDDEN_AUTHORITIES / REFUSAL_REASONS
//   AI_DISCLOSURE
//
// ── THE POSITION ────────────────────────────────────────────────────
// A voice configuration session is a person describing how their assistant
// should ANSWER THE TELEPHONE. It is not an administrative console with a
// microphone attached.
//
// So there is a list of authorities a transcript cannot reach, and reaching for
// one is refused with a sentence rather than silently ignored — because a
// caller who is ignored says it again, louder, and eventually finds a phrasing
// that works. A caller who is told "that is not something I can do on this
// call, and here is who can" stops.
//
// ── WHY THE REFUSAL IS NOT MERELY "NO INTENT FOR IT" ────────────────
// It would be tempting to rely on the closed intent vocabulary: there is no
// APPROVE intent, so approval is unreachable. That is true and it is not
// enough. An interpreter — especially a future language model — will map
// "approve it for me" onto SOMETHING, and the something it picks will be
// whatever is nearest. This module makes the nearest thing a refusal.
//
// It also runs on the RAW TRANSCRIPT as well as the interpreted intent, so a
// request that an interpreter mislabels as harmless is still caught. Two
// independent checks, because one of them is a model.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────
// It imports the blueprint's mandatory vocabulary and nothing else. It cannot
// approve, activate, provision, dial or change calling state, and a ratchet
// asserts it imports no module that can.

const { MANDATORY_PROHIBITED_CLAIMS } = require("../client-blueprint");

/**
 * The authorities a configuration conversation may not reach. Each names the
 * authority that DOES own it, because "no" without "who can" is a caller
 * phoning back.
 */
const FORBIDDEN_AUTHORITIES = Object.freeze({
  approval: {
    owner: "a named person reviewing the draft",
    spoken: "I can't approve changes. Everything from this call is saved as a draft, and somebody at your business reviews and approves it.",
  },
  activation: {
    owner: "an operator",
    spoken: "I can't make changes live. Once they're approved, an operator activates them.",
  },
  provisioning: {
    owner: "a separately authorised provisioning operation",
    spoken: "I can't set up or change anything on the telephone system. That's a separate, separately authorised step.",
  },
  calling: {
    owner: "the calling authority, which no conversation can reach",
    spoken: "I can't start calling anybody. That isn't something a configuration call can turn on.",
  },
  dncr: {
    owner: "the Do Not Call authority",
    spoken: "I can't change anything about the Do Not Call rules. Those aren't configuration.",
  },
  suppression: {
    owner: "the append-only suppression list",
    spoken: "I can't remove anybody from the do-not-contact list.",
  },
  dial: {
    owner: "the pre-dial authorisation gate",
    spoken: "I can't place calls or authorise them.",
  },
  webhook: { owner: "signature verification", spoken: "I can't change how incoming events are verified." },
  ai_disclosure: {
    owner: "platform policy",
    spoken: "On outbound calls AIDA always says it's an AI assistant, and that isn't something I can switch off — it's a platform requirement. I can change the wording with you.",
  },
  mandatory_prohibitions: {
    owner: "platform policy",
    spoken: "There are a few things AIDA never claims for any business — guaranteed prices, guaranteed arrival times, and saying it's a person. I can't remove those.",
  },
  other_tenant: {
    owner: "the session's own client",
    spoken: "This call is about your own configuration. I can't change another business's settings.",
  },
  compliance_wording: {
    owner: "the review screen, where a person can read it before it is said to anybody",
    spoken: "I can't change the recording message over the phone — what callers are told about recording is a legal position, not a setting. It's on the configuration screen, and somebody reviews it before it goes out.",
  },
  authority_bypass: {
    owner: "the application's own authority model",
    spoken: "I can't skip the review step, whoever asks. It's the same for everybody, including the owner.",
  },
});

const REFUSAL_REASONS = Object.freeze(Object.keys(FORBIDDEN_AUTHORITIES));

/**
 * Transcript patterns that reach for an authority, whatever the interpreter
 * decided. Deliberately generous — a false refusal costs a sentence of
 * explanation, and a false permit costs a stranger being telephoned.
 *
 * These are matched against the caller's words, not used to decide meaning.
 */
const TRANSCRIPT_TRIPWIRES = Object.freeze([
  { reason: "approval", patterns: [/\bapprove\b/i, /\bsign\s*off\b/i, /\bskip (the )?(approval|review)\b/i, /\bno need for (a )?review\b/i] },
  { reason: "activation", patterns: [/\bactivate\b/i, /\bmake (it|this|these|that) live\b/i, /\bgo live\b/i, /\bpublish (it|this|these)\b/i, /\bdeploy\b/i, /\bpush (it|this|these) live\b/i] },
  // Deliberately provider-NEUTRAL. An earlier version named a vendor here and
  // the domain ratchet caught it, correctly: the voice layer must not know what
  // the telephony provider is called, and "push it to <vendor>" is covered by
  // the phrasings below without teaching this module a vendor's name.
  { reason: "provisioning", patterns: [/\bprovision\b/i, /\bcreate the agent\b/i, /\bset up the (phone )?number\b/i, /\bbuy (a|the) number\b/i, /\bpush (it|this|these) ?(up|out|live|to the provider)\b/i] },
  // Calling is the hardest one to pattern, because a business legitimately
  // talks about calls all day: "we call customers back within the hour" is a
  // callback POLICY and must pass, while "just call everyone once" must not.
  //
  // The discriminator is an IMPERATIVE to place calls, so the patterns look for
  // a command to start, or an instruction to call a GROUP — and the "back"
  // exclusion keeps every callback policy on the allowed side.
  {
    reason: "calling",
    patterns: [
      /\b(start|begin|kick off|fire off)\s+(the\s+)?(calling|dialling|dialing|ringing|outbound|campaign|calls)\b/i,
      /\b(turn|switch)\s+(outbound|calling|the campaign)\s+(on|live)\b/i,
      /\benable\s+(calling|outbound|the campaign)\b/i,
      /\bcall\s+(all|every|each)\b/i,
      /\b(call|ring|phone)\s+(them\s+)?(everyone|everybody)\b(?![^.?!]*\bback\b)/i,
      /\b(call|ring|phone)\s+(the\s+)?(list|leads?|prospects?)\b/i,
      /\bgo\s+(and\s+)?(call|ring|phone)\b/i,
    ],
  },
  { reason: "dncr", patterns: [/\bdo.?not.?call\b/i, /\bdncr\b/i, /\bignore the do not call\b/i] },
  { reason: "suppression", patterns: [/\bsuppress(ion)?\b/i, /\bremove .* from the (do.?not.?contact|opt.?out) list\b/i, /\bunsubscribe (them|him|her) back\b/i] },
  { reason: "dial", patterns: [/\bdial\b/i, /\bplace a call to\b/i] },
  { reason: "ai_disclosure", patterns: [/\bdon'?t (say|tell|mention).{0,30}\b(ai|robot|bot|artificial|automated|machine)\b/i, /\b(hide|stop|remove|disable|turn off).{0,30}\b(ai|disclosure)\b/i, /\bpretend (to be|you'?re) (a )?(human|person|real)\b/i, /\bsay (you'?re|you are) (a )?(human|person|real)\b/i] },
  { reason: "authority_bypass", patterns: [/\bbypass\b/i, /\badmin mode\b/i, /\bignore (the )?(previous|prior|earlier|all) (rules?|instructions?)\b/i, /\boverride\b/i, /\bi'?m the owner,? (just|so)\b/i, /\bdeveloper mode\b/i] },
]);

/** The founder ruling, restated where the guard can enforce it. */
const AI_DISCLOSURE = Object.freeze({
  outbound: Object.freeze({
    inOpening: true,
    clientDisableable: false,
    spoken: "Outbound calls must identify AIDA as an AI assistant.",
  }),
  inbound: Object.freeze({
    inOpening: false,
    clientDisableable: false,
    spoken: "Your inbound greeting is yours to choose, and it doesn't have to mention AI.",
  }),
  whenAsked: Object.freeze({
    answersTruthfully: true,
    clientDisableable: false,
    spoken: "If a caller asks whether they're speaking to a person, AIDA always says it's an AI assistant. That can't be switched off.",
  }),
});

const isStr = (v) => typeof v === "string" && v.trim().length > 0;

const refuse = (reason, detail = null) =>
  Object.freeze({
    allowed: false,
    refusal: Object.freeze({
      reason,
      owner: FORBIDDEN_AUTHORITIES[reason].owner,
      detail,
    }),
    spoken: FORBIDDEN_AUTHORITIES[reason].spoken,
  });

const allow = () => Object.freeze({ allowed: true, refusal: null, spoken: null });

/** A refused intent maps straight onto the authority it reached for. */
const REFUSED_INTENT_REASON = Object.freeze({
  REQUEST_APPROVAL: "approval",
  REQUEST_ACTIVATION: "activation",
  REQUEST_PROVISIONING: "provisioning",
  REQUEST_CALLING: "calling",
  REQUEST_DISABLE_AI_DISCLOSURE: "ai_disclosure",
  REQUEST_BYPASS_AUTHORITY: "authority_bypass",
  REQUEST_OTHER_TENANT: "other_tenant",
});

/**
 * The guard. Runs on BOTH the interpreted intent and the raw words.
 *
 * @param intent      what the interpreter decided
 * @param payload     its payload, if any
 * @param transcript  what the caller actually said
 * @param session     for the tenant check
 */
function assessRequest({ intent, payload = {}, transcript = "", session = null } = {}) {
  // 1. An explicitly refused intent.
  if (REFUSED_INTENT_REASON[intent]) return refuse(REFUSED_INTENT_REASON[intent], intent);

  // 2. The words themselves, whatever the interpreter concluded. This is the
  //    check that survives an interpreter mislabelling a request as harmless.
  if (isStr(transcript)) {
    for (const { reason, patterns } of TRANSCRIPT_TRIPWIRES) {
      if (patterns.some((p) => p.test(transcript))) return refuse(reason, "transcript");
    }
  }

  // 3. Another tenant, by name or by slug. The session's client is fixed at
  //    creation and a transcript cannot move it.
  if (session && isStr(transcript)) {
    const named = otherTenantMentioned(transcript, session);
    if (named) return refuse("other_tenant", named);
  }

  // 4. Payload-level attacks on platform policy that a valid-looking intent
  //    could otherwise carry.
  const payloadRefusal = assessPayload(intent, payload);
  if (payloadRefusal) return payloadRefusal;

  return allow();
}

/**
 * A transcript naming a different client. Only refuses on a request to CHANGE
 * it — a caller may perfectly well mention a competitor, and refusing that
 * would make the assistant unusable.
 */
function otherTenantMentioned(transcript, session) {
  const wantsChange = /\b(change|edit|update|set|switch to|do it for|instead for|also for|and for)\b/i.test(transcript);
  if (!wantsChange) return null;
  const other = /\b(?:the )?other (?:business|client|company|account)\b|\bclient\s+[a-z0-9_-]{2,}\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/i.exec(transcript);
  if (!other) return null;
  // A slug-shaped token that is NOT this session's own client.
  const token = other[0].toLowerCase();
  if (session.clientId && token.includes(String(session.clientId).toLowerCase())) return null;
  return other[0];
}

/**
 * Payload contents that would breach platform policy even under a legitimate
 * intent — the mandatory prohibited claims being the clearest case.
 */
function assessPayload(intent, payload) {
  if (!payload || typeof payload !== "object") return null;

  // config-patch.js does not permit the `compliance` prefix, deliberately. An
  // intent that can never be applied must say so out loud rather than being
  // accepted, proposed, summarised and then quietly compiling to nothing.
  if (intent === "SET_COMPLIANCE_WORDING") return refuse("compliance_wording", "compliance is not patchable by voice");

  // Removing one of the six mandatory prohibitions, under any framing.
  if (intent === "REMOVE_APPROVED_FACT" || intent === "ADD_APPROVED_FACT") {
    const text = String(payload.factRef || payload.statement || "").toLowerCase();
    for (const claim of MANDATORY_PROHIBITED_CLAIMS) {
      const words = claim.replace(/_or_/g, " or ").replace(/_/g, " ");
      if (text.includes(words)) return refuse("mandatory_prohibitions", claim);
    }
    // "you can say you're a person" as an approved fact.
    if (/\b(you'?re|you are|i'?m|i am) (a )?(human|person|real person)\b/i.test(text)) {
      return refuse("ai_disclosure", "approved fact claiming to be human");
    }
  }

  // A greeting that claims to be human. The inbound greeting is the client's
  // to choose, but not to lie in.
  if (intent === "SET_GREETING") {
    const g = String(payload.greeting || "");
    if (/\b(you'?re speaking (to|with) a (human|person)|this is a real person|not a (robot|bot|machine|computer))\b/i.test(g)) {
      return refuse("ai_disclosure", "greeting claims to be human");
    }
  }

  // Outbound: the disclosure is not a field a caller can empty.
  if (intent === "PROPOSE_OUTBOUND_SETTING") {
    for (const key of ["disclosureWording", "aiDisclosure", "discloseAi", "disclosure"]) {
      if (key in payload) return refuse("ai_disclosure", `outbound.${key}`);
    }
  }

  return null;
}

/**
 * A spoken answer for a caller who asked whether AIDA discloses being AI.
 * Not a refusal — a truthful explanation, which is itself the policy.
 */
function explainDisclosure(direction = "outbound") {
  return direction === "inbound" ? AI_DISCLOSURE.inbound.spoken : AI_DISCLOSURE.outbound.spoken;
}

module.exports = {
  assessRequest, assessPayload, otherTenantMentioned, explainDisclosure,
  FORBIDDEN_AUTHORITIES, REFUSAL_REASONS, TRANSCRIPT_TRIPWIRES,
  REFUSED_INTENT_REASON, AI_DISCLOSURE,
};
