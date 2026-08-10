// AIDA Locksmith Acquisition — the founder-approved calling policy (M8M).
//
//   createCallingPolicyApproval({ ... })   build one; unapproved unless told
//   FOUNDER_CALLING_POLICY                 the approval actually in force
//   CALLING_POLICY_APPROVAL_VERSION
//
// ── WHAT THIS REPLACES, AND WHY ─────────────────────────────────────
// Until M8M the eligibility engine refused everything with
// `counsel_approval_missing`: "the permitted calling hours have not been signed
// off by a lawyer". That was the honest state of the world in A2, and it was
// written as a blocker only an external lawyer could clear.
//
// The founder has decided not to acquire an external legal opinion for the
// pilot, and to operate instead under a written, versioned policy of their own:
// AIDA follows the published Australian telemarketing calling rules, applies
// them to AI voice acquisition calls, and takes the conservative option wherever
// the published rules leave room.
//
// So the gate does not disappear and it is not hardcoded open. It changes
// AUTHORITY: from "a lawyer has signed this off" to "a named human has adopted
// this policy, in this version, on this basis". That is a weaker claim, and the
// artifact says so in every direction it can.
//
// ── THIS IS NOT LEGAL ADVICE, AND CANNOT BE MADE TO SAY IT IS ───────
// `kind` is fixed to "founder_operating_policy" and `isLegalAdvice` to false.
// Neither is a parameter. There is no way to construct an approval from this
// module that claims a lawyer reviewed anything, and a test asserts it — because
// the failure mode being defended against is not a bug, it is a future reader
// finding `approved: true` and concluding the calling window was legally
// cleared. It was not. It was adopted.
//
// A real legal review, if one is ever obtained, is a DIFFERENT artifact and
// should be added as one rather than by relabelling this.
//
// ── DEFAULT-DENY IS PRESERVED EXACTLY ───────────────────────────────
// `createCallingPolicyApproval()` with no arguments is NOT approved, exactly as
// `counselApproved` defaulted to false and as `createAttemptPolicy()` defaults
// to unapproved. An engine built without an approval refuses every prospect.
// Forgetting to wire the policy stops calls; it does not skip the check.
//
// And `approved: true` alone is not an approval. It needs a named human, a
// version and a basis — the same rule the attempt policy already enforces, for
// the same reason: an approval nobody can be named for, or dated, or traced to
// what it was based on, is indistinguishable from one nobody made.
//
// Pure + dep-free. See test/acquisition-calling-approval.test.js.

const { CALLING_WINDOWS } = require("../config/acquisition");

/**
 * The version string of the policy in force.
 *
 * Dated, because the whole point of versioning it is that a decision recorded
 * last month can be read against the policy that was actually in force then.
 * Changing the windows, the holiday rule or the basis means a NEW version.
 */
const CALLING_POLICY_APPROVAL_VERSION = "acq-calling-policy-2026-08-10";

/**
 * The only kind of approval this module can produce.
 *
 * Not an enum a caller picks from. It is a single value, stated as a constant so
 * the ratchet has something to assert against and so the word "founder" appears
 * wherever this is printed.
 */
const APPROVAL_KIND = "founder_operating_policy";

const MAX_TEXT = 600;

function clip(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Names that are not a person adopting a policy.
 *
 * The same list the batch approval uses, for the same reason: this is a human
 * decision, and a system actor adopting a calling policy would be the pipeline
 * granting itself permission to call.
 */
const NON_HUMAN_APPROVERS = /^(system|automation|automated|auto|aida|bot|robot|ai|agent|assistant|claude|gpt|llm|service|cron|scheduler|worker|daemon)$/i;

/**
 * Build a calling-policy approval.
 *
 * @param {boolean}  [approved]
 * @param {string}   [approvedBy]  a named person. Required to be approved.
 * @param {string}   [approvedAt]  ISO date. Required to be approved.
 * @param {string}   [version]     required to be approved.
 * @param {string}   [basis]       what the policy is derived from. Required.
 * @param {object}   [windows]     the permitted windows this approval covers.
 * @param {string}   [holidayRule]
 * @param {string}   [appliesTo]
 * @param {string}   [source]      where the encoded values live in this repo.
 */
function createCallingPolicyApproval({
  approved = false,
  approvedBy = null,
  approvedAt = null,
  version = null,
  basis = null,
  windows = CALLING_WINDOWS,
  holidayRule = null,
  appliesTo = null,
  source = null,
} = {}) {
  const who = clip(approvedBy, 120);
  const when = clip(approvedAt, 40);
  const ver = clip(version, 80);
  const why = clip(basis);

  // Every reason this is not an approval, collected rather than short-circuited,
  // so describeGap() can say all of them at once instead of one per fix.
  const gaps = [];
  if (approved !== true) gaps.push("it has not been approved");
  if (!who) gaps.push("nobody is named as having approved it");
  else if (NON_HUMAN_APPROVERS.test(who)) gaps.push(`"${who}" is not a person`);
  if (!when) gaps.push("it carries no approval date");
  if (!ver) gaps.push("it carries no policy version, so a past decision could not be read against the policy that was in force");
  if (!why) gaps.push("it does not say what the policy is based on");

  const isApproved = gaps.length === 0;

  return Object.freeze({
    approved: isApproved,
    approvedBy: who,
    approvedAt: when,
    version: ver,
    basis: why,
    windows,
    holidayRule: clip(holidayRule, 200),
    appliesTo: clip(appliesTo, 200),
    source: clip(source, 200),

    // ── The two fields that are not parameters ──────────────────────
    /** Always a founder operating policy. Never a legal opinion. */
    kind: APPROVAL_KIND,
    /** Always false. There is no argument that changes it. */
    isLegalAdvice: false,
    /**
     * Stated on the artifact so it travels with any decision that carries it.
     * A reader who finds `approved: true` must not be able to conclude a lawyer
     * cleared the window.
     */
    disclaimer:
      "Adopted by the founder as AIDA's operating policy. It is NOT legal advice, " +
      "has NOT been reviewed by a lawyer, and does not represent a professional " +
      "opinion that the calling rules encoded here are correct or complete.",

    /** Why this is not an approval, in a sentence somebody can act on. */
    describeGap() {
      if (isApproved) return "";
      return `The calling policy is not approved: ${gaps.join("; ")}.`;
    },

    /** What it IS, for a founder screen or an audit trail. */
    describe() {
      if (!isApproved) return this.describeGap();
      return (
        `Calling policy "${ver}" adopted by ${who} on ${when} as AIDA's operating policy — not legal advice. ` +
        `Basis: ${why}`
      );
    },
  });
}

/**
 * THE APPROVAL IN FORCE (M8M).
 *
 * ── WHAT THE FOUNDER DECIDED ────────────────────────────────────────
 *   1. AI voice acquisition calls are operated as telemarketing calls. There is
 *      no separate, looser AI window and no separate AI attempt rule.
 *   2. Mon–Fri 09:00–20:00 and Sat 09:00–17:00 recipient-local; no Sundays.
 *      Open inclusive, close exclusive. Unchanged from what was already encoded
 *      and tested — M8M adopted the window, it did not move it.
 *   3. No cold acquisition call on a public holiday applicable to the recipient.
 *      This is the CONSERVATIVE choice: the published rules leave a holiday
 *      window technically available and AIDA declines to use it.
 *   4. Unknown holiday coverage fails closed.
 *   5. Unknown or unusable recipient timezone fails closed.
 *
 * ── WHAT IT DOES NOT DECIDE ─────────────────────────────────────────
 * Nothing about whether the holiday DATA is any good — see A-L2, still open, and
 * the fixture provider's own header. Choosing not to call on holidays does not
 * mean we reliably know which days those are.
 *
 * Nothing about AI disclosure wording, which is deliberately out of scope here.
 *
 * And nothing about DNCR: every callable number is still washed, a fresh
 * authoritative `not_listed` is still required, and listed / unknown / stale /
 * unavailable all still block. DNCR-1 is untouched and still open.
 */
const FOUNDER_CALLING_POLICY = createCallingPolicyApproval({
  approved: true,
  approvedBy: "Peter Dang",
  approvedAt: "2026-08-10",
  version: CALLING_POLICY_APPROVAL_VERSION,
  basis:
    "The published Australian telemarketing calling-hours framework (Do Not Call Register Act 2006 and the Telecommunications (Do Not Call Register) (Telemarketing and Research Calls) Industry Standard), " +
    "adopted as AIDA's operating policy and applied to AI voice acquisition calls on the same terms as any other telemarketing call. " +
    "Where the published rules permit more than AIDA wants to use — notably calling on public holidays — the narrower option is taken.",
  windows: CALLING_WINDOWS,
  holidayRule: "No cold acquisition call on a public holiday applicable to the recipient, and no call when holiday coverage is unknown.",
  appliesTo: "AI voice acquisition calls to Australian businesses, recipient-local time.",
  source: "src/config/acquisition.js CALLING_WINDOWS; docs/ACQUISITION_BLOCKER_REGISTER.md §1; docs/LOCKSMITH_ACQUISITION_SPEC.md §46",
});

module.exports = {
  createCallingPolicyApproval,
  FOUNDER_CALLING_POLICY,
  CALLING_POLICY_APPROVAL_VERSION,
  APPROVAL_KIND,
  NON_HUMAN_APPROVERS,
};
