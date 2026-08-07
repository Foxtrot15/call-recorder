// ============================================================================
// M8E CROSS-PROCESS PROOF - PROCESS A (the writer).
//
// A SEPARATE OS PROCESS with its own heap, its own Supabase client and its own
// suppression service. It waits until process B has hydrated, commits one
// permanent fictional opt-out, and exits. It never speaks to B.
//
// THE ONE APPROVED PERMANENT ROW:
//   acquisition_suppressions, actor m8e-crossprocess-probe, one opt_out.
// No prospect row and no outcome row, because suppressions carry no foreign
// key. The append-only trigger is not touched.
//
// ONE-SHOT BY DESIGN. If a row for this actor already exists, A refuses to
// write a second one: the approval was for exactly one, and a re-run must not
// quietly add more permanent residue.
//
// RUN (after process-b.js is waiting):
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-crossprocess-proof/process-a.js
// ============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("./common");

const HYDRATED = path.join(os.tmpdir(), "m8e-b-hydrated");
const WRITTEN = path.join(os.tmpdir(), "m8e-a-written");
const clock = () => new Date();

const waitFor = async (file, timeoutMs = 120000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

async function main() {
  console.log("=".repeat(74));
  console.log("M8E CROSS-PROCESS PROOF - PROCESS A (the writer)");
  console.log("=".repeat(74));

  const client = C.makeClient(); // throws unless dev
  const store = C.makeStore(client);

  console.log(`\nProject guard : dev ref ${C.DEV_REF} confirmed`);

  if (!(await waitFor(HYDRATED))) {
    console.log("Process B has not hydrated. Start process-b.js first. Nothing was written.");
    process.exit(1);
  }
  console.log("Process B is hydrated. Writing the opt-out.\n");

  // -- THE ONE-SHOT GUARD ---------------------------------------------------
  const existing = await store.lookupSuppression({ fingerprint: C.FINGERPRINT, e164: C.NUMBER });
  const mine = existing.filter((r) => r.actor === C.ACTOR);
  if (mine.length > 0) {
    C.check("A0", "REFUSING to add a second permanent row", false, `${mine.length} row(s) for ${C.ACTOR} already exist. The approval was for exactly one. Nothing was written.`);
    process.exit(1);
  }

  // -- THE WRITE ------------------------------------------------------------
  // Through the durable service, so this is the same path the outcome recorder
  // uses: validated by the domain, then persisted, then admitted to A's own
  // index. Durable before visible.
  const suppression = await C.createDurableSuppression({ now: clock, store });
  const written = await suppression.suppress({
    reason: "opt_out",
    scope: "business",
    fingerprint: C.FINGERPRINT,
    e164: C.NUMBER,
    actor: C.ACTOR,
    actorKind: "human",
    note: "M8E cross-process proof. Invented business, invented number, never contacted.",
  });

  C.check("A1", "process A committed the opt-out durably", written.ok === true && written.durable === true, written.ok ? `scope=business fingerprint+number recorded` : written.message);
  C.check("A2", "A sees its own write immediately", suppression.check({ e164: C.NUMBER }).suppressed === true);

  const readBack = await store.lookupSuppression({ fingerprint: C.FINGERPRINT, e164: C.NUMBER });
  C.check("A3", "the row is readable from Postgres by an authoritative lookup", readBack.length === 1, `${readBack.length} row(s)`);

  fs.writeFileSync(WRITTEN, new Date().toISOString(), "utf8");

  const ok = C.summary("PROCESS A");
  console.log("\nPermanent residue created: exactly ONE suppression row (approved).");
  console.log("Process B may now continue. A is exiting; its heap goes with it.");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\nPROCESS A FAILED:", err.message);
  process.exit(1);
});
