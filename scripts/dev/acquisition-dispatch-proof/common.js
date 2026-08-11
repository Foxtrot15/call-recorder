// ============================================================================
// E-7B1 DISPATCH PROOF — shared setup.
//
// Proves the durable dispatch arbitration against REAL dev Postgres, using the
// same acquisition-dispatch-store code the executor uses. Nothing here applies
// SQL: laq5 must already have been applied by hand (see the runbook).
//
// SAFETY
//   1. Refuses any project ref but dev, before a client is constructed.
//   2. Writes AT MOST the one fictional dispatch row the founder approved.
//      Every other probe is expected to be REFUSED BY THE DATABASE, which by
//      definition writes nothing.
//   3. Contacts nothing but Postgres. No provider, no dialler, no prospect.
//   4. NEVER enables calling. It reads the calling state and asserts it is
//      paused; there is no code path here that writes 'enabled'.
//   5. NEVER resolves the proof dispatch. The row is meant to stay unresolved.
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");

const DEV_REF = "wvwemitmmsdytyutaqbm";

/** The fictional business the proof claims against. Already on dev since M8D. */
const PROOF_PROSPECT = "pr_3740207ebbc0a379910f";
/** A second fictional business, for the destination-collision probe. */
const OTHER_PROSPECT = "pr_0b9f51cfe79018067bf1";
/** Fictional throughout. The 03 5550 range is reserved for fiction. */
const PROOF_DESTINATION = "+61355509999";
const OTHER_DESTINATION = "+61355509998";

const PROOF_BATCH_KEY = "ba_e7b1verify";
const PROOF_AUTHORISATION_ID = "ad_e7b1verify0000000";

function loadEnv() {
  const envPath = process.env.ACQUISITION_ENV_FILE
    ? path.resolve(process.env.ACQUISITION_ENV_FILE)
    : path.resolve(__dirname, "..", "..", "..", "..", "call-recorder", ".env");
  if (!fs.existsSync(envPath)) throw new Error(`Cannot find ${envPath}. Set ACQUISITION_ENV_FILE.`);
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  if (!out.SUPABASE_URL || !out.SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not found.");
  if (!out.SUPABASE_URL.includes(DEV_REF)) throw new Error(`REFUSING TO RUN. Expected dev ref ${DEV_REF}, got ${out.SUPABASE_URL}.`);
  return out;
}

function makeClient() {
  const env = loadEnv();
  const { createClient } = require("@supabase/supabase-js");
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * A store shaped like the acquisition store contract, backed by real dev
 * Postgres, carrying ONLY the methods the dispatch path needs.
 *
 * The insert deliberately does not wrap its error: acquisition-dispatch-store
 * reads `code` and `constraint` off it to tell a replay from a lost race, and
 * wrapping would throw that away.
 */
function makeDispatchStore(db) {
  const CONTRACT_STUBS = [
    "listSuppressions", "appendSuppression", "lookupSuppression", "listLiveLeases",
    "recordRequest", "listExpiredLeases", "listOutcomes", "appendOutcome",
    "listWashes", "appendWash", "upsertProspect", "upsertProspectPhone",
    "listProspectPhones", "appendEvidence", "listEvidence", "appendDecision",
    "listDecisions", "readChainHead", "transitionProspectLifecycle", "latestWashFor",
    "acquireLease", "releaseLease", "listProspects", "getProspect",
  ];

  const store = {
    async appendDialExecution(row) {
      const { data, error } = await db
        .from("acquisition_dial_executions")
        .insert({
          dispatch_id: row.dispatchId,
          authorisation_id: row.authorisationId,
          prospect_id: row.prospectId,
          destination_e164: row.destinationE164,
          batch_key: row.batchKey,
          authorised_at: row.authorisedAt,
          claimed_at: row.claimedAt,
          claimed_by: row.claimedBy,
          provider: row.provider,
          provider_live: row.providerLive,
          provider_status: row.providerStatus || "pending",
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async listDialExecutions({ prospectId = null, unresolvedOnly = false } = {}) {
      let q = db.from("acquisition_dial_executions").select("*");
      if (prospectId) q = q.eq("prospect_id", prospectId);
      if (unresolvedOnly) q = q.is("resolved_at", null);
      const { data, error } = await q.order("claimed_at", { ascending: true });
      if (error) throw error;
      return (data || []).map((r) => ({
        dispatchId: r.dispatch_id,
        authorisationId: r.authorisation_id,
        prospectId: r.prospect_id,
        destinationE164: r.destination_e164,
        batchKey: r.batch_key,
        providerStatus: r.provider_status,
        provider: r.provider,
        claimedAt: r.claimed_at,
        resolvedAt: r.resolved_at,
        resolution: r.resolution,
      }));
    },

    async readCallingState() {
      const { data, error } = await db.from("acquisition_calling_state").select("*").eq("scope", "global").maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        scope: data.scope,
        state: data.state,
        revision: data.revision,
        changedBy: data.changed_by,
        changedAt: data.changed_at,
        reason: data.reason,
      };
    },
  };

  // The store contract asserts a full method list. These are never called on
  // this path; they exist so assertStoreContract passes without pretending the
  // proof has a whole store behind it.
  for (const name of CONTRACT_STUBS) {
    if (!store[name]) {
      store[name] = async () => {
        throw new Error(`${name} is not part of the E-7B1 dispatch proof`);
      };
    }
  }
  return store;
}

/** A genuine-shaped slip. NOT minted by M8E — the proof exercises the STORE. */
function proofDial({ dispatchId, prospectId = PROOF_PROSPECT, destination = PROOF_DESTINATION, at }) {
  return Object.freeze({
    dispatchId,
    authorisationId: PROOF_AUTHORISATION_ID,
    prospectId,
    businessName: "E-7B1 verification (fictional)",
    e164: destination,
    batchKey: PROOF_BATCH_KEY,
    authorisedAt: at,
    decision: "eligible",
  });
}

module.exports = {
  DEV_REF,
  PROOF_PROSPECT,
  OTHER_PROSPECT,
  PROOF_DESTINATION,
  OTHER_DESTINATION,
  PROOF_BATCH_KEY,
  PROOF_AUTHORISATION_ID,
  loadEnv,
  makeClient,
  makeDispatchStore,
  proofDial,
};
