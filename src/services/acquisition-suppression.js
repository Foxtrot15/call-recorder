// AIDA Locksmith Acquisition — internal suppression (A2).
//
//   createSuppressionList({ now, audit })
//   list.suppress(entry)        add a permanent exclusion
//   list.check({ e164, fingerprint })  is this business or number excluded?
//
// The pipeline's eighth step is "internal suppression checked". This is G5 from
// docs/OUTBOUND_BDM_ARCHITECTURE.md: the permanent, cross-campaign record of
// everyone we must not contact.
//
// THERE IS NO UNSUPPRESS.
// The module exposes no way to remove an entry, and the underlying table has no
// delete path. This is the point. "Do not call me again" is not a preference
// that expires, and the one bug you cannot recover from is the one that
// un-suppresses somebody who opted out — they do not get to opt out twice, and
// the second call is the one that becomes a complaint. An entry added in error
// is superseded by a `manual_exclusion` note explaining it; the original stays.
//
// SUPPRESSION APPLIES TO THE BUSINESS, NOT THE HANDSET.
// An opt-out is a statement about the relationship, not about a phone. So an
// opt-out, complaint, regulator mention, manual exclusion, competitor flag or
// existing-client flag suppresses the BUSINESS — every number it has now and
// every number it publishes later. Only `wrong_number` and `dncr_listed` are
// number-scoped, because those genuinely are facts about a number.
//
// That asymmetry is the whole reason entries carry both a number and an
// identity fingerprint: suppressing only what we happened to dial would let the
// same business be called back on its other line the following week.
//
// Pure + dep-free. See test/acquisition-suppression.test.js.

const S = require("./acquisition-schema");

const MAX_TEXT = 500;

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Create a suppression list.
 *
 * @param {function} now
 * @param {object}   [audit]  the append-only decision log
 * @param {function} [sink]   durable store; if it throws, the write is refused
 */
function createSuppressionList({ now, audit = null, sink = null } = {}) {
  if (typeof now !== "function") {
    throw new Error("createSuppressionList requires an injected now().");
  }

  const entries = [];

  /**
   * Permanently exclude a business and/or a number.
   *
   * @param {object} entry
   * @param {string} entry.reason         a SUPPRESSION_REASONS code
   * @param {string} [entry.e164]         the number, if the fact is about a number
   * @param {string} [entry.fingerprint]  the business identity, if known
   * @param {string} entry.actor          who recorded it
   * @param {string} entry.note           free text — what actually happened
   */
  function suppress(entry) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, code: "entry_invalid", message: "A suppression entry must be an object." };
    }
    if (!S.SUPPRESSION_REASONS.includes(entry.reason)) {
      return { ok: false, code: "reason_unknown", message: `"${String(entry.reason).slice(0, 40)}" is not a reason this system suppresses on.` };
    }

    const e164 = clip(entry.e164, 20);
    const fingerprint = clip(entry.fingerprint, 200);
    const businessWide = S.BUSINESS_WIDE_SUPPRESSIONS.includes(entry.reason);

    // A business-wide reason with no business identity would suppress a single
    // handset and let the same business be called back on its other line.
    if (businessWide && !fingerprint) {
      return {
        ok: false,
        code: "fingerprint_required",
        message: `"${S.SUPPRESSION_REASON_LABELS[entry.reason]}" is about the business, not one phone, so it needs the business identity — otherwise they could be called back on another number.`,
      };
    }
    if (!businessWide && !e164) {
      return {
        ok: false,
        code: "number_required",
        message: `"${S.SUPPRESSION_REASON_LABELS[entry.reason]}" is about a specific number, so it needs one.`,
      };
    }

    const actor = clip(entry.actor, 120);
    if (!actor) return { ok: false, code: "actor_missing", message: "A suppression must record who added it." };

    const note = clip(entry.note, MAX_TEXT);
    if (!note) return { ok: false, code: "note_missing", message: "A suppression must record what actually happened." };

    const row = Object.freeze({
      sequence: entries.length + 1,
      reason: entry.reason,
      reasonLabel: S.SUPPRESSION_REASON_LABELS[entry.reason],
      scope: businessWide ? "business" : "number",
      e164: e164 || null,
      fingerprint: fingerprint || null,
      actor,
      note,
      suppressedAt: now().toISOString(),
    });

    if (sink) sink(row);

    if (audit) {
      audit.record({
        entityType: "suppression",
        entityId: fingerprint || e164,
        event: "suppressed",
        decision: "record",
        actor,
        actorKind: entry.actorKind === "human" ? "human" : "system",
        reason: `${row.reasonLabel}: ${note}`,
        detail: { reason: entry.reason, scope: row.scope, e164: row.e164 },
      });
    }

    entries.push(row);
    return { ok: true, entry: row };
  }

  /**
   * Is this business or number suppressed?
   *
   * Checks BOTH keys independently, so a business suppressed under one number
   * is still caught when a different number for the same business is checked.
   * Returns every matching entry — a reviewer should see all of them, not just
   * the first, because "opted out AND complained" is a different situation from
   * "opted out".
   */
  function check({ e164 = null, fingerprint = null } = {}) {
    const number = clip(e164, 20);
    const identity = clip(fingerprint, 200);

    const matches = entries.filter((row) => {
      // A NUMBER-SCOPED entry is a fact about a handset. Only the number matches.
      if (row.scope !== "business") return number !== null && row.e164 === number;

      // A BUSINESS-SCOPED entry matches on the identity OR on the number it was
      // recorded against.
      //
      // The identity fingerprint is built from the trading name and the
      // locality, so it drifts: the same locksmith re-imported from a second
      // source as "Preston South" rather than "Preston", or with "Group"
      // appended to its name, produces a DIFFERENT fingerprint. Matching on
      // identity alone meant an opt-out we had recorded against a number was
      // then ignored on that very number, and the business became callable
      // again the moment somebody re-imported it from a source that spelled the
      // suburb differently.
      //
      // Recording the number they opted out on and then refusing to look at it
      // is strictly worse than never recording it, because it reads like a
      // control that is not one. The number is a far more stable key than the
      // name — so both are compared, and either is enough.
      if (identity !== null && row.fingerprint === identity) return true;
      return number !== null && row.e164 !== null && row.e164 === number;
    });

    if (matches.length === 0) {
      return Object.freeze({ suppressed: false, matches: Object.freeze([]), reasons: Object.freeze([]) });
    }

    // Severity order for the message a human reads: a regulator mention is not
    // the same news as "they're already a client". Every entry here must be a
    // real SUPPRESSION_REASONS code — a stray code that never matches would
    // silently sort to the back and mislead whoever maintains this list. A test
    // asserts the two stay in step.
    const severity = ["regulator_mention", "complaint", "opt_out", "manual_exclusion", "competitor", "dncr_listed", "wrong_number", "existing_client"];
    const sorted = [...matches].sort((a, b) => {
      const ai = severity.indexOf(a.reason);
      const bi = severity.indexOf(b.reason);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    return Object.freeze({
      suppressed: true,
      matches: Object.freeze(sorted),
      primary: sorted[0],
      reasons: Object.freeze(sorted.map((m) => m.reason)),
      message: sorted.length === 1
        ? `${sorted[0].reasonLabel} (recorded ${sorted[0].suppressedAt.slice(0, 10)}): ${sorted[0].note}`
        : `${sorted.length} reasons, the most serious being ${sorted[0].reasonLabel.toLowerCase()}: ${sorted[0].note}`,
    });
  }

  return Object.freeze({
    suppress,
    check,
    all: () => Object.freeze([...entries]),
    count: () => entries.length,
    // Deliberately absent: remove, delete, unsuppress, clear.
  });
}

/**
 * The pilot's starting suppression list, as data.
 *
 * Two of the fixture businesses are here so the dry run and the tests exercise
 * both scopes: an existing client (business-wide) and a prior opt-out
 * (business-wide). Both use the invented fixture identities.
 */
const FIXTURE_SUPPRESSIONS = Object.freeze([
  {
    reason: "existing_client",
    fingerprint: "frankston-safe-and-lock#frankston|vic",
    actor: "founder",
    actorKind: "human",
    note: "Already an AIDA client — approaching them as a prospect would be embarrassing and pointless.",
  },
  {
    reason: "opt_out",
    fingerprint: "altona-lock-and-security#altona|vic",
    actor: "founder",
    actorKind: "human",
    note: "Asked not to be contacted again when we spoke in June. Permanent, across every campaign.",
  },
]);

module.exports = {
  createSuppressionList,
  FIXTURE_SUPPRESSIONS,
};
