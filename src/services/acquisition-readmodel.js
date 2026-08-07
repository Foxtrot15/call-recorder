// AIDA Locksmith Acquisition — the founder/operator read model (M8B).
//
//   summarisePipeline({ prospects, evaluate, qualifyFor, evidenceFor, ... })
//   describePipeline(summary)      the same thing as text, for the dry run
//
// Answers the questions a founder actually opens a dashboard to ask:
//
//     How many locksmiths do we have? How many are worth calling? How many
//     could be called right now? Of the rest — why not? Who has opted out?
//     What happened to the ones we did call?
//
// ── IT COMPUTES NOTHING ITSELF ──────────────────────────────────────
// Every number here comes from the module that owns the decision behind it.
// Categorisation of a blocked prospect is `acquisition-batch.categoriseDecision`
// — the same function the founder batch screen uses — because two screens that
// categorise the same refusal differently is a support conversation nobody can
// resolve. Qualification comes from acquisition-qualification, permission from
// the injected eligibility engine, suppression counts from the suppression
// list. This file is arithmetic over other people's answers.
//
// ── IT RE-EVALUATES, LIKE THE QUEUE DOES ────────────────────────────
// "Callable now" is a claim about this instant, so it is computed at this
// instant. A read model that cached eligibility would eventually show a
// suppressed business under "can be called now", and a founder would believe
// it. The cost is that a summary over a large list is a large number of
// evaluations; that is the correct trade for a number nobody should doubt.
//
// ── NO DASHBOARD HERE ───────────────────────────────────────────────
// This returns data. There is deliberately no HTML, no route and no client
// bundle in this milestone: the backend contract is the thing that has to be
// right, and a screen built before it settles gets rebuilt. `describePipeline`
// renders text for the dry run, which is the only consumer that exists.
//
// Pure + dep-free. See test/acquisition-readmodel.test.js.

const S = require("./acquisition-schema");
const { categoriseDecision, CATEGORIES } = require("./acquisition-batch");
const { qualifyProspect } = require("./acquisition-qualification");
const { duplicateStatusFor } = require("./acquisition-dedupe");

/**
 * Summarise the whole acquisition pipeline.
 *
 * @param {Array}    prospects
 * @param {function} evaluate      (prospect, context) => eligibility decision.
 *                                 Optional: without it, permission is reported
 *                                 as unknown rather than assumed — see below.
 * @param {function} [qualifyFor]  (prospect) => qualification assessment
 * @param {function} [evidenceFor] (prospectId) => evidence rows
 * @param {object}   [suppression] the suppression list, for its own count
 * @param {object}   [queue]       a call queue, for its live leases
 * @param {object}   [duplicateResolution]
 * @param {Date}     [at]
 */
function summarisePipeline({
  prospects = [],
  evaluate = null,
  qualifyFor = null,
  evidenceFor = () => [],
  suppression = null,
  queue = null,
  duplicateResolution = null,
  context = {},
  market = null,
  at = null,
  now = null,
} = {}) {
  const instant = at instanceof Date && Number.isFinite(at.getTime()) ? at : typeof now === "function" ? now() : null;
  const list = (Array.isArray(prospects) ? prospects : []).filter((p) => p && typeof p === "object" && !Array.isArray(p));

  const lifecycle = countBy(S.PROSPECT_STATES);
  const tiers = countBy(S.QUALIFICATION_TIERS);
  const verdicts = countBy(S.QUALIFICATION_VERDICTS);
  const blocked = countBy(CATEGORIES.map((c) => c.key));

  const rows = [];
  let qualifiedCount = 0;
  let callableNow = 0;
  let permissionUnknown = 0;
  // RECORDS ARE NOT BUSINESSES.
  //
  // A1 derives prospectId from the identity fingerprint, so two rows for the
  // same locksmith share one id. Both are genuinely callable records, so
  // counting them as two is not wrong — but the queue offers that business
  // once, and a founder comparing "callable now: 6" against a queue of 5 is
  // owed the reason rather than left to find it. Both numbers are reported.
  const callableBusinessIds = new Set();

  for (const prospect of list) {
    lifecycle[prospect.lifecycle] = (lifecycle[prospect.lifecycle] || 0) + 1;

    const qualification = (qualifyFor && qualifyFor(prospect)) || qualifyProspect(prospect, { evidenceRows: evidenceFor(prospect.prospectId) || [], market, at: instant || undefined });

    if (qualification.ok) {
      tiers[qualification.tier] += 1;
      verdicts[qualification.verdict] += 1;
      if (qualification.qualified) qualifiedCount += 1;
    }

    // Permission. Without an engine we report UNKNOWN, never "callable" and
    // never "blocked" — a read model that guessed either way would be lying in
    // one direction or the other, and the optimistic lie is the dangerous one.
    let decision = null;
    let category = null;
    if (!evaluate) {
      permissionUnknown += 1;
    } else {
      decision = evaluate(prospect, { ...context, evidenceRows: evidenceFor(prospect.prospectId) || [], duplicateResolution, at: instant || undefined });
      if (!decision) {
        permissionUnknown += 1;
      } else if (decision.eligible) {
        callableNow += 1;
        callableBusinessIds.add(prospect.prospectId);
      } else {
        category = categoriseDecision(decision, duplicateStatusFor(prospect.prospectId, duplicateResolution));
        blocked[category] = (blocked[category] || 0) + 1;
      }
    }

    rows.push(
      Object.freeze({
        prospectId: prospect.prospectId,
        businessName: prospect.businessName,
        lifecycle: prospect.lifecycle,
        lifecycleLabel: S.PROSPECT_STATE_LABELS[prospect.lifecycle] || prospect.lifecycle,
        tier: qualification.ok ? qualification.tier : null,
        score: qualification.ok ? qualification.score : null,
        qualified: qualification.ok ? qualification.qualified : false,
        eligible: decision ? decision.eligible : null,
        blockedBy: decision && !decision.eligible ? decision.code : null,
        blockedCategory: category,
        blockedMessage: decision && !decision.eligible ? decision.message : null,
      })
    );
  }

  // Outcomes. Derived from the lifecycle rather than from a separate outcome
  // store, because the lifecycle IS the record of what happened — a second
  // tally kept alongside it would drift, and the drifted one would be believed.
  const outcomes = Object.freeze(
    Object.fromEntries(S.ENGAGEMENT_STATES.map((state) => [state, lifecycle[state] || 0]))
  );

  const engaged = S.ENGAGEMENT_STATES.reduce((t, s) => t + (lifecycle[s] || 0), 0);

  // Blocked categories, ordered by how many are in them, so the biggest problem
  // is first. A founder reading this wants the one worth fixing.
  const blockedBreakdown = Object.freeze(
    CATEGORIES.filter((c) => blocked[c.key] > 0)
      .map((c) => Object.freeze({ key: c.key, label: c.label, count: blocked[c.key] }))
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
  );

  return Object.freeze({
    generatedAt: instant ? instant.toISOString() : null,

    totals: Object.freeze({
      prospects: list.length,
      qualified: qualifiedCount,
      callableNow,
      // Distinct businesses behind those records — what the queue will offer.
      callableBusinesses: callableBusinessIds.size,
      blocked: CATEGORIES.reduce((t, c) => t + blocked[c.key], 0),
      permissionUnknown,
      engaged,
      // The suppression list is not a count of prospects — it is a count of
      // entries, and it deliberately includes businesses that are not in this
      // list at all. Naming it `suppressionEntries` rather than `suppressed`
      // stops it being summed with the prospect counts.
      suppressionEntries: suppression ? suppression.count() : null,
      leased: queue ? queue.activeLeases({ at: instant || undefined }).length : null,
    }),

    lifecycle: Object.freeze(lifecycle),
    lifecycleLabels: S.PROSPECT_STATE_LABELS,
    qualification: Object.freeze({ tiers: Object.freeze(tiers), verdicts: Object.freeze(verdicts) }),
    blocked: Object.freeze(blocked),
    blockedBreakdown,
    outcomes,

    rows: Object.freeze(rows),

    // Said explicitly, because "callable now" is the number most likely to be
    // misread as "we are calling these people".
    note: evaluate
      ? "\"Callable now\" means permitted at the instant this was generated. Nothing has been called: there is no dialler in this build."
      : "No eligibility engine was supplied, so permission is UNKNOWN for every prospect. Nothing here may be read as callable.",
  });
}

function countBy(keys) {
  return Object.fromEntries(keys.map((k) => [k, 0]));
}

/** The same summary as text, for the dry run and the walkthrough. */
function describePipeline(summary) {
  if (!summary) return "No summary.";
  const t = summary.totals;
  const lines = [];

  lines.push(`Prospects:        ${t.prospects}`);
  lines.push(`  qualified:      ${t.qualified}`);
  lines.push(`  callable now:   ${t.callableNow}${t.callableBusinesses !== t.callableNow ? `  (${t.callableBusinesses} distinct businesses — the rest are second records for one of them)` : ""}`);
  if (t.permissionUnknown > 0) lines.push(`  permission unknown: ${t.permissionUnknown}`);
  if (t.suppressionEntries !== null) lines.push(`Suppression list: ${t.suppressionEntries} entr${t.suppressionEntries === 1 ? "y" : "ies"} (includes businesses not in this list)`);
  if (t.leased !== null) lines.push(`Leased to workers: ${t.leased}`);

  if (summary.blockedBreakdown.length) {
    lines.push("");
    lines.push(`Blocked (${t.blocked}), most common first:`);
    for (const b of summary.blockedBreakdown) lines.push(`  ${String(b.count).padStart(4)}  ${b.label}`);
  }

  const engagement = Object.entries(summary.outcomes).filter(([, n]) => n > 0);
  if (engagement.length) {
    lines.push("");
    lines.push("Engagement:");
    for (const [state, n] of engagement) lines.push(`  ${String(n).padStart(4)}  ${summary.lifecycleLabels[state]}`);
  }

  lines.push("");
  lines.push(summary.note);
  return lines.join("\n");
}

module.exports = {
  summarisePipeline,
  describePipeline,
};
