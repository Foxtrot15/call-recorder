// WCS-1b-i regression tests — routing-profile adapter PURE CORE
// (src/services/routing-profile.js). The DB functions are thin wrappers over
// what's proven here (house precedent: devices.js); no DB, no Supabase, no
// network — the lazy-require pattern is enforced by the hygiene test below.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  STATUS_TIMESTAMP_FIELDS,
  buildProfileUpsertFields,
  buildGeneratedCodesFields,
  buildStatusUpdateFields,
  toPublicProfile,
  tableMissing,
  provisioningError,
} = require("../src/services/routing-profile");

const { buildDivertCodes, TEMPLATE_VERSION } = require("../src/services/divert-codes");

const NOW = "2026-07-23T10:00:00.000Z";
const INPUTS = {
  businessNumber: "+61400111222",
  phonePlatform: "iphone",
  carrier: "telstra",
  loops: { no_answer: true, busy: false, unreachable: true },
  noAnswerDelaySeconds: 20,
};

describe("buildProfileUpsertFields (the PUT payload)", () => {
  it("maps inputs to snake_case columns with the tenant id", () => {
    const f = buildProfileUpsertFields("tenant-a", INPUTS, NOW);
    assert.strictEqual(f.client_id, "tenant-a");
    assert.strictEqual(f.business_number, "+61400111222");
    assert.strictEqual(f.phone_platform, "iphone");
    assert.strictEqual(f.carrier, "telstra");
    assert.strictEqual(f.divert_no_answer, true);
    assert.strictEqual(f.divert_busy, false);
    assert.strictEqual(f.divert_unreachable, true);
    assert.strictEqual(f.no_answer_delay_seconds, 20);
    assert.strictEqual(f.updated_at, NOW);
  });

  it("EVERY save resets the snapshot and status (stale codes must not survive an edit)", () => {
    const f = buildProfileUpsertFields("tenant-a", INPUTS, NOW);
    assert.strictEqual(f.setup_status, "not_started");
    assert.strictEqual(f.generated_codes, null);
    assert.strictEqual(f.target_number, null);
    assert.strictEqual(f.needs_help_note, null);
    assert.strictEqual(f.instructions_generated_at, null);
    assert.strictEqual(f.claimed_done_at, null);
    assert.strictEqual(f.test_passed_at, null);
    assert.strictEqual(f.status_updated_at, NOW);
  });

  it("never sets created_at (DB default on insert, preserved on update) and never touches clients columns", () => {
    const f = buildProfileUpsertFields("tenant-a", INPUTS, NOW);
    assert.ok(!("created_at" in f));
    assert.ok(!("real_number" in f) && !("twilio_number" in f), "no clients-shaped fields can leak into this payload");
  });

  it("optional fields default to null", () => {
    const f = buildProfileUpsertFields("tenant-a", { ...INPUTS, businessNumber: null, noAnswerDelaySeconds: null }, NOW);
    assert.strictEqual(f.business_number, null);
    assert.strictEqual(f.no_answer_delay_seconds, null);
  });
});

describe("buildGeneratedCodesFields (the generate snapshot)", () => {
  const result = buildDivertCodes({
    targetNumber: "+61400000099",
    carrier: "telstra",
    phonePlatform: "iphone",
    loops: { no_answer: true, busy: true, unreachable: true },
    noAnswerDelaySeconds: 20,
  }).result;

  it("stores the buildDivertCodes result VERBATIM, with templateVersion inside", () => {
    const f = buildGeneratedCodesFields(result, NOW);
    assert.strictEqual(f.generated_codes, result, "snapshot is the exact result object, not a re-shaping");
    assert.strictEqual(f.generated_codes.templateVersion, TEMPLATE_VERSION);
    assert.strictEqual(f.target_number, "+61400000099", "target echoed from the server-derived result");
  });

  it("moves status to instructions_generated, stamps times, closes any needs_help episode", () => {
    const f = buildGeneratedCodesFields(result, NOW);
    assert.strictEqual(f.setup_status, "instructions_generated");
    assert.strictEqual(f.instructions_generated_at, NOW);
    assert.strictEqual(f.status_updated_at, NOW);
    assert.strictEqual(f.needs_help_note, null);
    assert.ok(!("claimed_done_at" in f) && !("test_passed_at" in f), "regenerating never fabricates claim stamps");
  });
});

describe("buildStatusUpdateFields (route-validated transitions → columns)", () => {
  it("claim_done stamps claimed_done_at (a self-reported claim, nothing more)", () => {
    const f = buildStatusUpdateFields({ action: "claim_done", nextStatus: "user_claimed_done" }, NOW);
    assert.strictEqual(f.setup_status, "user_claimed_done");
    assert.strictEqual(f.claimed_done_at, NOW);
    assert.ok(!("test_passed_at" in f));
  });

  it("report_test_passed stamps test_passed_at only", () => {
    const f = buildStatusUpdateFields({ action: "report_test_passed", nextStatus: "test_passed" }, NOW);
    assert.strictEqual(f.test_passed_at, NOW);
    assert.ok(!("claimed_done_at" in f));
  });

  it("needs_help stores the note; missing note stored as null", () => {
    assert.strictEqual(
      buildStatusUpdateFields({ action: "needs_help", nextStatus: "needs_help", note: "code did not confirm" }, NOW).needs_help_note,
      "code did not confirm"
    );
    assert.strictEqual(buildStatusUpdateFields({ action: "needs_help", nextStatus: "needs_help" }, NOW).needs_help_note, null);
  });

  it("back_to_instructions clears the note (it belonged to the resolved help episode) and stamps nothing extra", () => {
    const f = buildStatusUpdateFields({ action: "back_to_instructions", nextStatus: "instructions_generated" }, NOW);
    assert.strictEqual(f.needs_help_note, null);
    assert.strictEqual(f.setup_status, "instructions_generated");
    assert.ok(!("claimed_done_at" in f) && !("test_passed_at" in f) && !("instructions_generated_at" in f));
  });

  it("the action→timestamp map covers exactly the four route-facing actions", () => {
    assert.deepStrictEqual(Object.keys(STATUS_TIMESTAMP_FIELDS).sort(), [
      "back_to_instructions",
      "claim_done",
      "needs_help",
      "report_test_passed",
    ]);
  });
});

describe("toPublicProfile", () => {
  const ROW = {
    id: "3f2b8b1c-0000-4000-8000-000000000000",
    client_id: "tenant-a",
    business_number: "+61400111222",
    phone_platform: "iphone",
    carrier: "telstra",
    divert_no_answer: true,
    divert_busy: false,
    divert_unreachable: true,
    no_answer_delay_seconds: 20,
    target_number: "+61400000099",
    generated_codes: { templateVersion: "x", mode: "gsm_codes" },
    setup_status: "instructions_generated",
    needs_help_note: null,
    status_updated_at: NOW,
    instructions_generated_at: NOW,
    claimed_done_at: null,
    test_passed_at: null,
    created_at: NOW,
    updated_at: NOW,
  };

  it("null row → null", () => {
    assert.strictEqual(toPublicProfile(null), null);
  });

  it("shapes camelCase and NEVER exposes the row id (no id-based access exists)", () => {
    const p = toPublicProfile(ROW);
    assert.ok(!("id" in p), "row id must not leak into any public shape");
    assert.strictEqual(p.setupStatus, "instructions_generated");
    assert.deepStrictEqual(p.loops, { no_answer: true, busy: false, unreachable: true });
    assert.strictEqual(p.generatedCodes.templateVersion, "x");
    assert.strictEqual(p.claimedDoneAt, null);
  });
});

describe("provisioning failure shape (devices.js pattern)", () => {
  it("tableMissing detects 42P01 and relation-missing messages, nothing else", () => {
    assert.strictEqual(tableMissing({ code: "42P01" }), true);
    assert.strictEqual(tableMissing({ message: 'relation "public.client_phone_routing_profiles" does not exist' }), true);
    assert.strictEqual(tableMissing({ code: "42703", message: "column x does not exist" }), false);
    assert.strictEqual(tableMissing(null), false);
  });

  it("provisioningError names the exact SQL file to apply", () => {
    assert.match(provisioningError().message, /supabase\/sql\/wcs1b_create_client_phone_routing_profiles\.sql/);
  });
});

describe("dependency hygiene (dep-free house rule)", () => {
  it("loading the adapter's pure core never touches heavy deps (supabase is lazy, inside DB fns only)", () => {
    const heavy = Object.keys(require.cache).filter((p) => /node_modules[\\/](twilio|@supabase)/.test(p));
    assert.deepStrictEqual(heavy, []);
  });
});
