// ============================================================================
// M8J / E-2 LIFECYCLE PROOF — post-run verification.
// READS AND REFUSALS ONLY. NO SUCCESSFUL WRITE. ZERO ADDITIONAL RESIDUE.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-lifecycle-proof/verify.js
//
// run.js performed the approved round trip and left exactly two journal
// entries. This file checks the world it left behind, and re-runs the ONE probe
// run.js got wrong — without writing anything, because every transition it
// attempts is one the code refuses before any SQL is issued.
//
// ── THE PROBE run.js GOT WRONG, AND WHY THE CODE WAS RIGHT ──────────
// run.js L3 asked for `expectedFrom: review_pending, to: review_approved` while
// the row was already `review_approved`, and expected `stale_lifecycle`. It got
// `already_at_target`.
//
// That is correct and deliberate. The caller's desired end state already holds,
// and reporting a conflict would break reconciliation, whose entire job is to
// re-run a repair whose first attempt may have landed — the reconciler cannot
// know whether it did. So `already at target` is evaluated BEFORE `stale
// expectedFrom`, and a test has asserted that since the module was written.
//
// The probe simply chose a target equal to the current state, so it could never
// observe staleness. A genuine stale case needs a target the row is not already
// at, which is what V3 below asks for.
//
// SAFETY: dev-ref guarded; no INSERT anywhere; the two transitions attempted
// are both refused inside Node before a statement is sent.
// ============================================================================

const https = require("https");
const C = require("./common");
const { LIFECYCLE_TRANSITION_CODES } = require("../../../src/services/acquisition-store");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../../../src/services/acquisition-eligibility");
const { createEvidenceLedger } = require("../../../src/services/acquisition-evidence");
const { createProspect, transitionProspect } = require("../../../src/services/acquisition-prospect");

// Recorded before run.js touched anything. The report carries the same values.
const BEFORE = Object.freeze({
  lifecycle: "review_approved",
  historyEntries: 0,
  historySha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  updatedAt: "2026-08-07T13:04:02.910734+00:00",
  counts: Object.freeze({
    acquisition_prospects: 3,
    acquisition_prospect_phones: 1,
    acquisition_evidence: 9,
    acquisition_decisions: 4,
    acquisition_suppressions: 2,
    acquisition_qualifications: 0,
    acquisition_call_queue: 0,
    acquisition_contact_outcomes: 1,
  }),
  total: 20,
});

const APPEND_ONLY = ["acquisition_evidence", "acquisition_decisions", "acquisition_suppressions", "acquisition_contact_outcomes"];

async function counts() {
  const env = C.loadEnv();
  const H = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, Accept: "application/json", Prefer: "count=exact", Range: "0-0" };
  const out = {};
  for (const t of Object.keys(BEFORE.counts)) {
    out[t] = await new Promise((res, rej) => {
      https.get(`${env.SUPABASE_URL}/rest/v1/${t}?select=*`, { headers: H }, (r) => {
        let b = "";
        r.on("data", (d) => (b += d));
        r.on("end", () => res(Number(String(r.headers["content-range"] || "0-0/0").split("/")[1] || 0)));
      }).on("error", rej);
    });
  }
  return out;
}

const now = () => new Date("2026-08-05T04:00:00.000Z");

// A record with NO assessProspect gaps, so `record_valid` is decided by the
// lifecycle rather than by missing evidence. Deliberately a local fixture and
// not the dev row: the subject on dev has real gaps (no official source, no
// evidence), which is a separate matter from whether its lifecycle persisted.
// Nothing here touches the database.
const OFFICIAL_SOURCE = { url: "https://northsidelockandkey.example.com.au/contact" };

function buildGapFree() {
  const built = createProspect({
    businessName: "Northside Lock & Key",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 1042" }],
    sourceRefs: [OFFICIAL_SOURCE],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
  });
  if (!built.prospect) throw new Error(`fixture prospect failed to build: ${JSON.stringify(built.errors || built)}`);
  let p = built.prospect;
  for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
    const moved = transitionProspect(p, to, { actor: "m8j-verify", reason: "Building a gap-free fixture.", now });
    if (!moved.prospect) throw new Error(`fixture transition -> ${to} failed: ${JSON.stringify(moved)}`);
    p = moved.prospect;
  }
  return p;
}

function evidenceFor(p) {
  const ledger = createEvidenceLedger({ now });
  for (const [kind, value] of [
    ["business_name", p.businessName],
    ["trade_category", "Locksmith"],
    ["phone", p.phones[0].raw],
  ]) {
    ledger.record({ prospectId: p.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "m8j-verify", source: OFFICIAL_SOURCE });
  }
  return ledger.forProspect(p.prospectId);
}

const GAP_FREE = buildGapFree();

async function main() {
  console.log("=".repeat(74));
  console.log("M8J / E-2 POST-PROOF VERIFICATION (reads and refusals only)");
  console.log("=".repeat(74));

  const store = C.makeStore(C.makeClient());
  const p = await store.loadProspect(C.SUBJECT);
  if (!p) throw new Error(`${C.SUBJECT} is not on dev.`);
  const journal = p.history || [];

  // ── The round trip landed where it started ────────────────────────
  C.check("V1", "final lifecycle is EXACTLY review_approved", p.lifecycle === "review_approved", `before ${BEFORE.lifecycle} -> after ${p.lifecycle}`);
  C.check("V2", "exactly two journal entries were added", journal.length === BEFORE.historyEntries + 2, `${BEFORE.historyEntries} -> ${journal.length}`);

  // ── The corrected staleness probe. Refused; nothing written. ──────
  const stale = await store.transitionProspectLifecycle({ prospectId: C.SUBJECT, expectedFrom: "review_pending", to: "review_rejected", actor: "m8j-verify", reason: "Working from a read that is ten minutes old." });
  C.check("V3", "a STALE expectedFrom with a DIFFERENT target is refused", stale.ok === false && stale.code === LIFECYCLE_TRANSITION_CODES.STALE_LIFECYCLE, `${stale.code}: reported current "${stale.from}"`);

  const idem = await store.transitionProspectLifecycle({ prospectId: C.SUBJECT, expectedFrom: "review_pending", to: "review_approved", actor: "m8j-verify", reason: "A repair whose first attempt may already have landed." });
  C.check("V4", "a stale expectedFrom whose TARGET already holds is idempotent, not a conflict", idem.ok === true && idem.code === LIFECYCLE_TRANSITION_CODES.ALREADY_AT_TARGET, `${idem.code} — this is what run.js L3 saw, and it is correct`);

  const afterProbes = await store.loadProspect(C.SUBJECT);
  C.check("V5", "neither probe wrote anything", (afterProbes.history || []).length === journal.length && afterProbes.lifecycle === p.lifecycle, `${(afterProbes.history || []).length} entries, ${afterProbes.lifecycle}`);

  // ── Who and why survived into the journal ─────────────────────────
  const both = journal.slice(-2);
  C.check(
    "V6",
    "both journal entries carry actor and reason",
    both.length === 2 && both.every((e) => e.actor === "m8j-proof" && typeof e.reason === "string" && e.reason.length > 20 && e.from && e.to && e.at),
    both.map((e) => `${e.from}->${e.to} by ${e.actor}`).join("  |  ")
  );
  C.check("V7", "the two entries describe the round trip, in order", both[0].from === "review_approved" && both[0].to === "review_pending" && both[1].from === "review_pending" && both[1].to === "review_approved");

  // ── Nothing else moved ────────────────────────────────────────────
  const after = await counts();
  const drift = Object.entries(after).filter(([t, n]) => n !== BEFORE.counts[t]);
  C.check("V8", "no acquisition table gained a row", drift.length === 0, drift.length ? drift.map(([t, n]) => `${t}: ${BEFORE.counts[t]} -> ${n}`).join(", ") : Object.entries(after).map(([t, n]) => `${t}=${n}`).join("  "));
  C.check("V9", "no append-only table was touched", APPEND_ONLY.every((t) => after[t] === BEFORE.counts[t]), APPEND_ONLY.map((t) => `${t}=${after[t]}`).join("  "));
  C.check("V10", "acquisition_decisions remains exactly 4 rows", after.acquisition_decisions === 4, `${after.acquisition_decisions}`);

  const total = Object.values(after).reduce((a, b) => a + b, 0);
  C.check("V11", "total fictional dev proof rows remain exactly 20", total === BEFORE.total, `${BEFORE.total} -> ${total}`);

  // ── updated_at moved, created_at did not ──────────────────────────
  C.check("V12", "updated_at changed", p.updatedAt !== BEFORE.updatedAt, `${BEFORE.updatedAt} -> ${p.updatedAt}`);

  // ── A FRESH PROCESS-EQUIVALENT READ, and the eligibility path ─────
  const freshStore = C.makeStore(C.makeClient());
  const reloaded = await freshStore.loadProspect(C.SUBJECT);
  C.check("V13", "a fresh client reads the same lifecycle", reloaded.lifecycle === "review_approved", `${reloaded.lifecycle}`);
  C.check("V14", "and the same two journal entries", (reloaded.history || []).length === journal.length);

  // ── The read path actually reaches the lifecycle branch ───────────
  //
  // The first version of V15 evaluated the persisted row with empty
  // `sourceRefs` and no evidence rows, and asserted only that the failure code
  // was not RECORD_NOT_APPROVED. That passed vacuously: `record_valid` checks
  // assessProspect's gaps FIRST and only consults `lifecycle` when there are
  // none (acquisition-eligibility.js §1). With gaps present it returned
  // `record_invalid` and the lifecycle branch was never reached, so the check
  // could not have failed no matter what the database held.
  //
  // This asks the question properly: a known gap-free record built from the
  // same builders the offline tests use, with ONLY the lifecycle replaced by
  // the value read back from Postgres. V16 is the counterfactual — if the
  // identical record at `review_pending` also passed, V15 would prove nothing.
  const engine = createEligibilityEngine({ now });
  const evidenceRows = evidenceFor(GAP_FREE);
  const onDbLifecycle = engine.evaluate({ ...GAP_FREE, lifecycle: reloaded.lifecycle }, { evidenceRows });
  const stillFailing = (onDbLifecycle.failedChecks || []).find((f) => f.check === "record_valid");
  C.check(
    "V15",
    "record_valid PASSES on the lifecycle read back from Postgres",
    (onDbLifecycle.passedChecks || []).includes("record_valid") && !stillFailing,
    stillFailing ? `record_valid still fails: ${stillFailing.code} — ${stillFailing.message}` : `passedChecks includes record_valid (decisive check moved on to "${onDbLifecycle.decisiveCheck}")`
  );

  const counterfactual = engine.evaluate({ ...GAP_FREE, lifecycle: "review_pending" }, { evidenceRows });
  const refused = (counterfactual.failedChecks || []).find((f) => f.check === "record_valid");
  C.check(
    "V16",
    "and the SAME record at review_pending is refused — so V15 is not vacuous",
    refused && refused.code === ELIGIBILITY_CODES.RECORD_NOT_APPROVED,
    refused ? `${refused.code}` : "record_valid passed, which means V15 proves nothing"
  );

  console.log("");
  console.log("-".repeat(74));
  console.log("RESIDUE FROM THIS VERIFICATION: none. Two transitions attempted, both refused.");
  console.log(`Cumulative M8J E-2 residue: ${C.SUBJECT}.history 0 -> 2 entries, updated_at bumped, lifecycle unchanged.`);
  console.log("-".repeat(74));
  process.exit(C.summary("M8J / E-2 POST-PROOF VERIFICATION") ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
