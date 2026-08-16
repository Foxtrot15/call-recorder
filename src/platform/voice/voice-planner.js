// AIDA VOICE CONFIGURATION — what AIDA should ask next (P40, P40A, P40B).
//
//   assessCoverage(blueprint)          -> what is missing, by topic
//   planNextQuestion({ ... })          -> the one question, or null
//   detectSessionMode({ ... })         -> "setup" | "edit"
//   TOPICS
//
// ── WHY A PLANNER RATHER THAN A SCRIPT ──────────────────────────────
// A questionnaire that marches every caller through thirteen topics is a
// questionnaire people hang up on. A business owner who telephones to say "we
// close at four on Saturdays now" wants to be finished in twenty seconds, and
// asking them about booking integrations is how a useful tool becomes an
// annoying one.
//
// So the planner asks what is MISSING, in the order that matters, and stops
// when nothing is. For an existing client with a complete configuration that
// is immediately — which is why a targeted edit costs one turn.
//
// ── IT READS CONFIGURATION, NOT VERTICALS ───────────────────────────
// There is no `if (vertical === "plumber")` anywhere, and a ratchet asserts it.
// The planner inspects the CLIENT'S OWN services, area and hours. A plumber and
// a locksmith differ to it only by what their blueprint already contains — the
// same property the whole platform is built on.
//
// ── DETERMINISTIC ───────────────────────────────────────────────────
// Same blueprint and same covered set, same question, every time. That is what
// makes the golden transcripts meaningful: a question changing is a change
// somebody made, not a model having a different day.

const B = require("../client-blueprint");

/**
 * The topics, in the order the founder listed them — which is also roughly the
 * order a business owner can answer them in. `required` marks the ones without
 * which the configuration cannot pass validation at all.
 */
const TOPICS = Object.freeze([
  {
    key: "identity", required: true,
    question: "What's the business called, and what should the assistant call itself when it answers?",
    isCovered: (bp) => Boolean(bp.identity && bp.identity.legalName && bp.identity.assistantName),
    missingBecause: "the assistant has no business name or no name of its own",
  },
  {
    key: "services", required: true,
    question: "What are the main types of jobs customers call about?",
    isCovered: (bp) => Array.isArray(bp.services) && bp.services.length > 0,
    missingBecause: "an assistant with no services cannot help anybody",
  },
  {
    key: "urgency", required: false,
    // Asked only once there ARE services, and phrased with the client's own
    // words back at them.
    question: (bp) => {
      const names = (bp.services || []).filter((s) => s && s.name).map((s) => s.name);
      return names.length
        ? `Which of those should be treated as urgent after hours — ${names.slice(0, 4).join(", ")}?`
        : "Which jobs should be treated as urgent after hours?";
    },
    isCovered: (bp) => Array.isArray(bp.services) && bp.services.length > 0 &&
      bp.services.some((s) => s && ["emergency", "urgent", "priority"].includes(s.urgencyCategory)),
    dependsOn: "services",
    missingBecause: "nothing is marked urgent, so every call is treated the same way",
  },
  {
    key: "serviceArea", required: true,
    question: "Which suburbs or areas do you cover?",
    isCovered: (bp) => {
      const a = bp.serviceArea || {};
      return Boolean((a.regions || []).length || (a.suburbs || []).length || (a.postcodes || []).length || Number.isFinite(a.radiusKm));
    },
    missingBecause: "the assistant cannot tell a caller whether you travel to them",
  },
  {
    key: "hours", required: true,
    question: "What are your opening hours through the week?",
    isCovered: (bp) => {
      const weekly = (bp.hours && bp.hours.weekly) || {};
      return B.DAYS.every((d) => weekly[d] !== undefined);
    },
    missingBecause: "a day nobody stated is a day nobody notices until somebody rings on it",
  },
  {
    key: "afterHours", required: true,
    question: "Do you want calls answered outside those hours?",
    isCovered: (bp) => typeof (bp.hours && bp.hours.afterHours && bp.hours.afterHours.available) === "boolean",
    missingBecause: "after-hours handling has not been decided either way",
  },
  {
    key: "callerInformation", required: true,
    question: "What should the assistant always take down from a caller?",
    isCovered: (bp) => Array.isArray(bp.callHandling && bp.callHandling.collectAlways) && bp.callHandling.collectAlways.length > 0,
    missingBecause: "without a callback number nobody can be rung back",
  },
  {
    key: "transfer", required: false,
    question: "When something's urgent, should the assistant put the caller through? What number?",
    isCovered: (bp) => Boolean(bp.callHandling && bp.callHandling.escalation && bp.callHandling.escalation.primaryNumber),
    missingBecause: "there is no number to transfer an urgent call to",
  },
  {
    key: "pricing", required: true,
    question: "If someone asks what it costs, what should the assistant say?",
    isCovered: (bp) => Boolean(bp.knowledge && bp.knowledge.pricingDisclosure),
    missingBecause: "the assistant has no pricing position and will have to decline every question about money",
  },
  {
    key: "knowledge", required: false,
    question: "Is there anything you'd like the assistant to be able to tell people about the business?",
    isCovered: (bp) => Array.isArray(bp.knowledge && bp.knowledge.approvedFacts) && bp.knowledge.approvedFacts.length > 0,
    missingBecause: "the assistant can only describe the business in general terms",
  },
  {
    key: "booking", required: true,
    question: "Should the assistant book appointments, or just take details?",
    isCovered: (bp) => typeof (bp.booking && bp.booking.enabled) === "boolean",
    missingBecause: "booking has not been decided either way",
  },
  {
    key: "integrations", required: false,
    question: "Is there a calendar or job system you'd want this connected to later?",
    isCovered: (bp) => Array.isArray(bp.integrations) && bp.integrations.length > 0,
    missingBecause: "no capability has been requested",
  },
  {
    key: "voice", required: false,
    question: "How would you like the assistant to sound — brisk, warm, formal?",
    isCovered: (bp) => Boolean(bp.voice && (bp.voice.tone || bp.voice.profileRef)),
    missingBecause: "no tone has been chosen",
  },
  {
    key: "compliance", required: true,
    question: "Are calls recorded? If so, what should callers be told?",
    isCovered: (bp) => typeof (bp.compliance && bp.compliance.callsMayBeRecorded) === "boolean" &&
      (bp.compliance.callsMayBeRecorded !== true || Boolean(bp.compliance.recordingDisclosure)),
    missingBecause: "recording is not a question to leave unanswered",
  },
]);

const TOPIC_KEYS = Object.freeze(TOPICS.map((t) => t.key));

const questionFor = (topic, bp) => (typeof topic.question === "function" ? topic.question(bp) : topic.question);

/** Which topics a blueprint already answers, and which it does not. */
function assessCoverage(blueprint) {
  const bp = blueprint || {};
  const covered = [];
  const missing = [];

  for (const topic of TOPICS) {
    let isCovered = false;
    try { isCovered = Boolean(topic.isCovered(bp)); } catch { isCovered = false; }
    (isCovered ? covered : missing).push(topic.key);
  }

  const missingRequired = missing.filter((k) => TOPICS.find((t) => t.key === k).required);

  return Object.freeze({
    covered: Object.freeze(covered),
    missing: Object.freeze(missing),
    missingRequired: Object.freeze(missingRequired),
    complete: missingRequired.length === 0,
    coverage: `${covered.length}/${TOPICS.length}`,
  });
}

/**
 * A session that starts from a complete configuration is somebody ringing to
 * change one thing. A session that starts from a sparse one is onboarding. The
 * difference decides whether AIDA opens by asking, or by listening.
 */
function detectSessionMode({ blueprint, hasActiveVersion = false } = {}) {
  const coverage = assessCoverage(blueprint);
  return hasActiveVersion && coverage.complete ? "edit" : "setup";
}

/**
 * The next question, or null when there is nothing worth asking.
 *
 * Order of precedence, and the reason for each:
 *   1. an unresolved ambiguity — AIDA already asked and needs the answer
 *   2. a pending high-risk confirmation — nothing else matters until it is settled
 *   3. in EDIT mode, nothing. The caller rang with a purpose; let them get to it
 *   4. in SETUP mode, the first uncovered topic in order, skipping any the
 *      session has already been through
 */
function planNextQuestion({
  blueprint, mode = "setup", coveredTopics = [], unresolved = [], pendingConfirmation = null,
} = {}) {
  if (unresolved.length > 0) {
    const first = unresolved[0];
    return Object.freeze({
      kind: "clarification",
      topic: first.topic || null,
      question: first.question,
      because: "AIDA asked about this and does not have an answer yet",
      options: Object.freeze(first.options || []),
    });
  }

  if (pendingConfirmation) {
    return Object.freeze({
      kind: "confirmation",
      topic: pendingConfirmation.topic || null,
      question: pendingConfirmation.question,
      because: "this change is high-risk and needs to be confirmed out loud",
      options: Object.freeze(["yes", "no"]),
    });
  }

  if (mode === "edit") return null;

  const coverage = assessCoverage(blueprint);
  const already = new Set(coveredTopics);

  for (const topic of TOPICS) {
    if (already.has(topic.key)) continue;
    if (!coverage.missing.includes(topic.key)) continue;
    if (topic.dependsOn && coverage.missing.includes(topic.dependsOn)) continue;
    return Object.freeze({
      kind: "interview",
      topic: topic.key,
      question: questionFor(topic, blueprint || {}),
      because: topic.missingBecause,
      required: topic.required,
      options: Object.freeze([]),
    });
  }

  return null;
}

/** Everything still missing, for the "before this can be reviewed" summary. */
function outstandingRequirements(blueprint) {
  const coverage = assessCoverage(blueprint);
  return Object.freeze(
    coverage.missingRequired.map((key) => {
      const topic = TOPICS.find((t) => t.key === key);
      return Object.freeze({ topic: key, because: topic.missingBecause, question: questionFor(topic, blueprint || {}) });
    }),
  );
}

module.exports = {
  TOPICS, TOPIC_KEYS,
  assessCoverage, planNextQuestion, detectSessionMode, outstandingRequirements, questionFor,
};
