// ============================================================================
// M8D REAL-DATABASE RESTART PROOF - shared harness.
//
// Loaded by m8d_restart_phase1.js, m8d_restart_phase2.js and
// m8d_restart_cleanup.js. Contains no assertions of its own.
//
// SAFETY, IN ORDER OF IMPORTANCE
//   1. Refuses to run against anything but the dev project ref. The check is
//      on the URL and it throws before a client is constructed.
//   2. Reads credentials from ../call-recorder/.env itself, so the service key
//      never appears on a command line, in a shell history, or in output.
//   3. Contacts nothing but Postgres. No Twilio, no Retell, no HTTP fetch, no
//      dialler. There is no code path here that places or prepares a call.
//   4. Every identifier is m8d-restart-probe. The businesses are invented.
//
// DEPENDENCIES: run with NODE_PATH pointing at the runtime worktree's
// node_modules so @supabase/supabase-js resolves. Nothing is installed into
// this worktree and package.json is untouched.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DEV_REF = "wvwemitmmsdytyutaqbm";

const { createSupabaseAcquisitionStore } = require("../../../src/services/acquisition-store");
const {
  createDurableSuppression,
  createDurableQueue,
  createDurableOutcomes,
  createLeaseReaper,
} = require("../../../src/services/acquisition-durable");
const { createAuditLog } = require("../../../src/services/acquisition-audit");
const { createProspect, identityFingerprint } = require("../../../src/services/acquisition-prospect");
const { qualifyProspect } = require("../../../src/services/acquisition-qualification");

// -- Credentials -----------------------------------------------------

/**
 * Dev credentials.
 *
 * ACQUISITION_ENV_FILE overrides the location. The default is a sibling
 * worktree, which is only true of one machine, so it is a default and not an
 * assumption -- anybody re-running this proof elsewhere points the variable at
 * their own dev .env rather than editing this file.
 */
function loadEnv() {
  const envPath = process.env.ACQUISITION_ENV_FILE
    ? path.resolve(process.env.ACQUISITION_ENV_FILE)
    : path.resolve(__dirname, "..", "..", "..", "..", "call-recorder", ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `Cannot find ${envPath}. Set ACQUISITION_ENV_FILE to a dev .env holding SUPABASE_URL and SUPABASE_SERVICE_KEY.`
    );
  }
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  if (!out.SUPABASE_URL || !out.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not found in ../call-recorder/.env");
  }
  // THE GUARD. Throws before any client exists.
  if (!out.SUPABASE_URL.includes(DEV_REF)) {
    throw new Error(
      `REFUSING TO RUN. Expected the dev project ref ${DEV_REF}; SUPABASE_URL points somewhere else. ` +
      `The restart proof writes permanent rows and must never touch production.`
    );
  }
  return out;
}

function makeClient() {
  const env = loadEnv();
  const { createClient } = require("@supabase/supabase-js");
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const makeStore = (client) => createSupabaseAcquisitionStore({ client });

// -- Fixtures: invented businesses, invented numbers -----------------

/** Strip formatting and render an Australian landline as E.164. */
function toE164(raw) {
  const digits = String(raw).replace(/[^0-9]/g, "");
  return digits.startsWith("0") ? `+61${digits.slice(1)}` : `+${digits}`;
}

const MAIN_E164 = "+61355502287"; // the opted-out business
const LIVE_E164 = "+61355502288"; // the business holding a lease across the restart

function build(fields) {
  const built = createProspect({
    timezone: "Australia/Melbourne",
    state: "VIC",
    region: "Melbourne",
    origin: "fixture",
    discoveredAt: "2026-08-01T02:00:00.000Z",
    ...fields,
  });
  if (!built.ok) throw new Error(`fixture invalid: ${JSON.stringify(built.errors)}`);
  return Object.freeze({ ...built.prospect, lifecycle: fields.lifecycle || "review_approved" });
}

/** The business that opts out. Its rows are the permanent residue. */
const mainProspect = () =>
  build({
    businessName: "M8D Restart Probe Locksmiths",
    tradeCategory: "Locksmith - emergency lockouts, rekeying, safes",
    suburb: "Preston",
    postcode: "3072",
    phones: [{ raw: "(03) 5550 2287" }],
    sourceRefs: [{ url: "https://m8d-restart-probe.example.com.au/contact" }],
  });

/**
 * THE RE-IMPORT. The same business, arriving months later from a different
 * source, spelled differently, in a differently-named suburb, with the number
 * formatted differently. A fresh prospect identity is generated - which is
 * exactly the accident the suppression design exists to survive.
 */
const reimportedProspect = () =>
  build({
    businessName: "M8D Restart Probe Locksmiths Pty Ltd",
    tradeCategory: "Locksmith and security services",
    suburb: "Preston South",
    postcode: "3072",
    phones: [{ raw: "03-5550-2287" }],
    sourceRefs: [{ url: "https://directory.example.com.au/listing/m8d-restart-probe" }],
    origin: "operator_import",
    discoveredAt: "2026-08-06T02:00:00.000Z",
  });

/** Holds a long lease that must survive the restart untouched. */
const liveLeaseProspect = () =>
  build({
    businessName: "M8D Restart Live Lease Locksmiths",
    tradeCategory: "Locksmith - commercial rekeying",
    suburb: "Reservoir",
    postcode: "3073",
    phones: [{ raw: "(03) 5550 2288" }],
    sourceRefs: [{ url: "https://m8d-restart-live.example.com.au/contact" }],
  });

const TRADE_EVIDENCE = [
  { evidenceId: "m8d_restart_ev_1", kind: "trade_category", value: "Locksmith - 24 hour emergency lockouts and rekeying" },
];
const evidenceFor = () => TRADE_EVIDENCE;

// -- Prospect rows ---------------------------------------------------
// The durable store covers suppressions, leases and outcomes only. Prospect
// rows are inserted directly because acquisition_call_queue and
// acquisition_contact_outcomes both carry a foreign key to them - a lease
// cannot exist for a business the database has never heard of.

async function upsertProspectRow(client, p) {
  const { error } = await client.from("acquisition_prospects").upsert(
    {
      prospect_id: p.prospectId,
      business_name: p.businessName,
      trade_category: p.tradeCategory || null,
      suburb: p.suburb || null,
      state: p.state || null,
      postcode: p.postcode || null,
      region: p.region || null,
      timezone: p.timezone,
      origin: "fixture",
      discovered_at: p.discoveredAt,
      discovered_by: "m8d-restart-probe",
      notes: "M8D restart proof fixture. Invented business. Never contacted.",
      lifecycle: "review_approved",
    },
    { onConflict: "prospect_id" }
  );
  if (error) throw new Error(`prospect row insert failed for ${p.prospectId}: ${error.message}`);
  return p.prospectId;
}

// -- Services --------------------------------------------------------

/**
 * A complete, independent set of services around a store.
 *
 * Phase 2 calls this in a brand-new process. Nothing is shared with phase 1
 * except the database itself - which is the entire point.
 */
async function freshServices(store, now) {
  const audit = createAuditLog({ now });
  const suppression = await createDurableSuppression({ now, store, audit });

  // Consults the DURABLE suppression service, exactly as the real eligibility
  // engine composes it. Kept to suppression only so this proof is about
  // persistence rather than about compliance precedence, which
  // acquisition-eligibility.test.js already covers.
  const evaluate = (prospect) => {
    const e164 = toE164((prospect.phones && prospect.phones[0] && prospect.phones[0].raw) || "");
    const hit = suppression.check({ e164, fingerprint: identityFingerprint(prospect) });
    if (hit.suppressed) {
      return Object.freeze({
        eligible: false,
        code: "suppressed_permanently",
        message: `This business must never be called. ${hit.message}`,
        prospectId: prospect.prospectId,
        businessName: prospect.businessName,
        failedChecks: [],
      });
    }
    return Object.freeze({
      eligible: true,
      code: "eligible",
      message: "This business can be called now.",
      canonicalNumber: e164,
      localTime: "13:00",
      prospectId: prospect.prospectId,
      businessName: prospect.businessName,
      evaluatedAt: now().toISOString(),
      failedChecks: [],
    });
  };

  const queue = await createDurableQueue({ now, evaluate, store, audit, leaseTtlMs: 5 * 60 * 1000 });
  const outcomes = createDurableOutcomes({ now, suppression, store, audit });
  const reaper = createLeaseReaper({ now, store, audit, enabled: true });
  return { audit, suppression, evaluate, queue, outcomes, reaper };
}

const qualificationFor = (p, at) => qualifyProspect(p, { evidenceRows: TRADE_EVIDENCE, at });

// -- Reporting -------------------------------------------------------

let passes = 0;
let failures = 0;

function check(id, claim, condition, detail) {
  const ok = condition === true;
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${id} ${ok ? "PASS" : "FAIL"}  ${claim}${detail ? `\n         ${detail}` : ""}`);
  return ok;
}

function summary(label) {
  console.log("");
  console.log("=".repeat(74));
  console.log(`${label}: ${passes} passed, ${failures} failed.`);
  console.log("=".repeat(74));
  return failures === 0;
}

module.exports = {
  DEV_REF,
  MAIN_E164,
  LIVE_E164,
  loadEnv,
  makeClient,
  makeStore,
  toE164,
  mainProspect,
  reimportedProspect,
  liveLeaseProspect,
  evidenceFor,
  TRADE_EVIDENCE,
  upsertProspectRow,
  freshServices,
  qualificationFor,
  identityFingerprint,
  check,
  summary,
};
