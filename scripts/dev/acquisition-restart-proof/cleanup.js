// ============================================================================
// M8D REAL-DATABASE RESTART PROOF - CLEANUP (Step 7).
//
// Deletes every ordinary probe row and leaves EXACTLY THREE behind, on purpose:
//
//   1. acquisition_suppressions      the opt-out          append-only trigger
//   2. acquisition_contact_outcomes  the DO_NOT_CALL      append-only trigger
//   3. acquisition_prospects         the business row     pinned by RESTRICT
//
// THE APPEND-ONLY TRIGGERS ARE NEVER DISABLED. The runbook section 7.4 path is
// deliberately not taken. Those three rows are the price of that decision and
// the decision was made knowingly: an opt-out and the record of the
// conversation that produced it are exactly the things that should be hard to
// erase. All three carry m8d-restart-probe identifiers and describe an
// invented business, so they can never match anything real.
//
// This script attempts the prospect delete anyway and reports the RESTRICT
// refusal, rather than skipping it - the refusal IS the evidence.
//
// RUN:
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-restart-proof/cleanup.js
// ============================================================================

const C = require("./common");

const now = () => new Date();

async function main() {
  console.log("=".repeat(74));
  console.log("M8D RESTART PROOF - CLEANUP (Step 7)");
  console.log("=".repeat(74));

  const client = C.makeClient(); // throws unless the URL is the dev ref
  const main = C.mainProspect();
  const live = C.liveLeaseProspect();

  console.log(`\nProject guard : dev ref ${C.DEV_REF} confirmed`);
  console.log(`Keeping       : ${main.prospectId} (+ its outcome + the opt-out)`);
  console.log(`Removing      : ${live.prospectId} and all probe leases\n`);

  // -- 1. Leases. Derived state, no trigger, freely deletable. ---------------
  const { data: leases, error: leaseErr } = await client
    .from("acquisition_call_queue")
    .delete()
    .in("prospect_id", [main.prospectId, live.prospectId])
    .select();
  if (leaseErr) throw new Error(`lease delete failed: ${leaseErr.message}`);
  C.check("K1", "all probe leases deleted", true, `${(leases || []).length} row(s) removed from acquisition_call_queue`);

  // -- 2. The live-lease prospect. No outcome points at it, so it goes. ------
  const { data: liveDel, error: liveErr } = await client
    .from("acquisition_prospects")
    .delete()
    .eq("prospect_id", live.prospectId)
    .select();
  C.check("K2", "the live-lease prospect deleted (nothing pins it)",
    !liveErr && (liveDel || []).length === 1, liveErr ? liveErr.message : `${(liveDel || []).length} row(s) removed`);

  // -- 3. The main prospect. This MUST be refused. ---------------------------
  // Its outcome row points at it with ON DELETE RESTRICT, and that outcome
  // cannot itself be deleted because the table is append-only. The refusal is
  // the schema doing exactly what M8D set out to prove.
  const { error: mainErr } = await client
    .from("acquisition_prospects")
    .delete()
    .eq("prospect_id", main.prospectId)
    .select();
  C.check("K3", "the opted-out prospect is REFUSED deletion (RESTRICT), as designed",
    mainErr !== null && /violates foreign key|23503/i.test(mainErr.message || ""),
    mainErr ? `refused: ${mainErr.message}` : "NOT REFUSED - investigate, the outcome should have pinned it");

  // -- 4. Confirm the permanent three, and nothing else. --------------------
  const { data: sup } = await client
    .from("acquisition_suppressions")
    .select("id,reason,scope,fingerprint,e164,actor,note,suppressed_at")
    .eq("actor", "m8d-restart-probe");
  C.check("K4", "exactly ONE permanent suppression row remains",
    (sup || []).length === 1,
    (sup || []).length ? `id=${sup[0].id} reason=${sup[0].reason} scope=${sup[0].scope} e164=${sup[0].e164}` : "none found");

  const { data: out } = await client
    .from("acquisition_contact_outcomes")
    .select("id,prospect_id,outcome,suppression_applied,recorded_at")
    .eq("prospect_id", main.prospectId);
  C.check("K5", "exactly ONE permanent outcome row remains",
    (out || []).length === 1,
    (out || []).length ? `id=${out[0].id} outcome=${out[0].outcome} suppressionApplied=${out[0].suppression_applied}` : "none found");

  const { data: pros } = await client
    .from("acquisition_prospects")
    .select("prospect_id,business_name,lifecycle")
    .like("prospect_id", `${main.prospectId}%`);
  C.check("K6", "exactly ONE permanent prospect row remains",
    (pros || []).length === 1,
    (pros || []).length ? `${pros[0].prospect_id} "${pros[0].business_name}" lifecycle=${pros[0].lifecycle}` : "none found");

  const { data: strayQueue } = await client
    .from("acquisition_call_queue")
    .select("id")
    .or(`worker_id.like.m8d-%,lease_token.like.m8d-%`);
  C.check("K7", "no probe lease rows remain", (strayQueue || []).length === 0, `${(strayQueue || []).length} found`);

  const { data: strayQual } = await client
    .from("acquisition_qualifications")
    .select("id")
    .like("prospect_id", "%m8d%");
  C.check("K8", "no probe qualification rows remain", (strayQual || []).length === 0, `${(strayQual || []).length} found`);

  console.log("\nPERMANENT AND INTENTIONAL - do not attempt to remove these:");
  console.log(`  suppression : ${(sup || []).length ? sup[0].id : "?"}`);
  console.log(`  outcome     : ${(out || []).length ? out[0].id : "?"}`);
  console.log(`  prospect    : ${main.prospectId}`);
  console.log("  Removing any of them would require disabling an append-only");
  console.log("  trigger. That path was considered and deliberately rejected.");

  const ok = C.summary("CLEANUP");
  console.log("\nFinally, run supabase/sql/verification/07_restart_proof_verify.sql in the Supabase SQL editor.");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\nCLEANUP FAILED:", err.message);
  process.exit(1);
});
