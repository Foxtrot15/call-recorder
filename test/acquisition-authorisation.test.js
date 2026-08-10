// LOCKSMITH ACQUISITION M8E — the final pre-dial authorisation gate.
//
// M8E succeeds only if a process holding STALE suppression memory still cannot
// authorise a business that another process has just recorded an opt-out for.
// This file decides that against the in-memory store; the same sequence runs
// across two real processes against dev Postgres in
// scripts/dev/acquisition-crossprocess-proof/.
//
// ── WHAT "STALE" MEANS HERE, AND WHY IT IS NOT CONTRIVED ────────────
// The durable suppression service hydrates once, at construction, and
// `rehydrate()` had no callers anywhere in this repository. So a second service
// built BEFORE a suppression exists holds a view that never learns about it —
// which is not a simulation of the bug, it is the bug, reproduced by doing
// exactly what the pilot does.
//
// The collaborators below are the REAL modules, not stubs. A test that faked
// the eligibility engine would prove nothing about what the gate enforces.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createInMemoryAcquisitionStore, assertStoreContract } = require("../src/services/acquisition-store");
const { createDurableSuppression } = require("../src/services/acquisition-durable");
const { createDialAuthoriser, isAuthorisedDial, AUTHORISATION_CODES } = require("../src/services/acquisition-authorisation");
const { ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { resolveDuplicates } = require("../src/services/acquisition-dedupe");
const { createProspect, transitionProspect, identityFingerprint } = require("../src/services/acquisition-prospect");
const { canonicalBatchIdentity, recordBatchApproval } = require("../src/services/acquisition-batch-approval");
const { FOUNDER_CALLING_POLICY, createCallingPolicyApproval } = require("../src/services/acquisition-calling-approval");

const MELBOURNE = "Australia/Melbourne";
const WEDNESDAY_2PM = "2026-08-05T04:00:00Z"; // inside the permitted window
const NUMBER = "+61355501042";
const OTHER_NUMBER = "+61355509911";

const now = (iso = WEDNESDAY_2PM) => () => new Date(iso);

function goodProspect({ name = "Northside Lock & Key", phone = "(03) 5550 1042", suburb = "Brunswick" } = {}) {
  const built = createProspect({
    businessName: name,
    tradeCategory: "Locksmith",
    suburb,
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: MELBOURNE,
    phones: [{ raw: phone }],
    sourceRefs: [{ url: "https://northsidelockandkey.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
  });
  let p = built.prospect;
  for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, to, { actor: "Peter", reason: "test", now: now() }).prospect;
  }
  return p;
}

function evidenceFor(prospect, clock = now()) {
  const ledger = createEvidenceLedger({ now: clock });
  const source = { url: "https://northsidelockandkey.example.com.au/contact" };
  for (const [kind, value] of [
    ["business_name", prospect.businessName],
    ["trade_category", "Locksmith"],
    ["phone", prospect.phones[0] ? prospect.phones[0].raw : "n/a"],
  ]) {
    ledger.record({ prospectId: prospect.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "test", source });
  }
  return ledger.forProspect(prospect.prospectId);
}

/**
 * The baseline the tests perturb: everything wired, everything permitted.
 *
 * `suppression` is deliberately NOT supplied — the gate binds that itself. And
 * since E-5, neither is the batch approval: `context.batch` is discarded by the
 * gate, so a test that wants the batch check to pass has to write a real
 * approval into the store with `approveBatchIn(store, prospect, clock)`. That is
 * a deliberate cost of the milestone — clearing that gate now requires the same
 * durable artifact production would.
 */
function harness({ iso = WEDNESDAY_2PM, prospect = null, holidays = null, washed = true, callingPolicyApproval = FOUNDER_CALLING_POLICY } = {}) {
  const clock = now(iso);
  const p = prospect || goodProspect();
  const evidenceRows = evidenceFor(p, clock);

  const washStore = createWashStore({ now: clock, mode: "fixture" });
  if (washed) washStore.wash(NUMBER);

  const duplicateResolution = resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], evidenceCount: evidenceRows.length, hasOfficialSource: true }]);

  const engineOptions = {
    washStore,
    holidays: holidays || createFixtureHolidayProvider(),
    attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
    callingPolicyApproval,
  };

  const context = { evidenceRows, duplicateResolution };

  return { clock, prospect: p, engineOptions, context, washStore };
}

/**
 * Persist the prospect, so durable duplicate resolution can clear it (M8L).
 *
 * A prospect object that exists only in this test's memory has never been
 * compared against anything, and the gate now refuses it as
 * `duplicate_never_assessed`. Storing it is what an import does, and it is the
 * durable evidence that dedupe ran and did not hold this business.
 */
async function persist(store, prospect) {
  await store.upsertProspect(prospect);
  return prospect;
}

/** Durably approve a one-business batch, so the E-5 gate has something to read. */
async function approveBatchIn(store, prospect, clock = now(), e164 = NUMBER) {
  await persist(store, prospect);
  const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164 }], label: "m8e test batch" });
  const result = await recordBatchApproval({ store, now: clock, identity, approvedBy: "Peter Dang", reason: "Approved for the M8E tests." });
  assert.strictEqual(result.ok, true, result.message);
  return identity;
}

const FINGERPRINT = identityFingerprint({ businessName: "Northside Lock & Key", suburb: "Brunswick", state: "VIC" });

const suppressionRow = (over = {}) => ({
  reason: "opt_out",
  scope: "business",
  fingerprint: FINGERPRINT,
  e164: NUMBER,
  actor: "founder",
  actorKind: "human",
  note: "Asked never to be contacted again.",
  suppressedAt: new Date(WEDNESDAY_2PM).toISOString(),
  ...over,
});

// ---------------------------------------------------------------------------

describe("the store's authoritative suppression lookup (M8E)", () => {
  it("is part of the store contract, so no adapter can quietly omit it", () => {
    const store = createInMemoryAcquisitionStore();
    assert.strictEqual(typeof store.lookupSuppression, "function");
    assert.doesNotThrow(() => assertStoreContract(store, "memory"));
  });

  it("finds a business-scoped row by identity fingerprint", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.appendSuppression(suppressionRow());
    assert.strictEqual((await store.lookupSuppression({ fingerprint: FINGERPRINT, e164: null })).length, 1);
  });

  it("finds a number-scoped row by number", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.appendSuppression(suppressionRow({ scope: "number", fingerprint: null, reason: "wrong_number" }));
    assert.strictEqual((await store.lookupSuppression({ fingerprint: null, e164: NUMBER })).length, 1);
  });

  it("returns nothing when asked about nothing, rather than everything", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.appendSuppression(suppressionRow());
    assert.deepStrictEqual(await store.lookupSuppression({}), []);
  });

  /**
   * THE EQUIVALENCE THAT LETS THE DATABASE NARROW AND THE DOMAIN DECIDE.
   *
   * The lookup selects `fingerprint = X or e164 = Y`, which must be a superset
   * of every row the matching rule could match. If it were not, the gate would
   * check a smaller list than the hydrated index and could clear somebody the
   * full table would have blocked — a fast wrong answer.
   */
  it("gives the same verdict as checking the whole table", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.appendSuppression(suppressionRow());
    await store.appendSuppression(suppressionRow({ scope: "number", fingerprint: null, e164: OTHER_NUMBER, reason: "wrong_number" }));
    await store.appendSuppression(suppressionRow({ fingerprint: "someone-else#carlton|vic", e164: "+61355500000" }));

    const query = { fingerprint: FINGERPRINT, e164: NUMBER };
    const whole = createSuppressionList({ now: now(), initialEntries: await store.listSuppressions() }).check(query);
    const narrowed = createSuppressionList({ now: now(), initialEntries: await store.lookupSuppression(query) }).check(query);

    assert.strictEqual(whole.suppressed, true);
    assert.strictEqual(narrowed.suppressed, whole.suppressed);
    assert.strictEqual(narrowed.matches.length, whole.matches.length);
  });

  it("does not report one opt-out twice when both predicates match it", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.appendSuppression(suppressionRow());
    assert.strictEqual((await store.lookupSuppression({ fingerprint: FINGERPRINT, e164: NUMBER })).length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("M-7 reproduced: a hydrated index goes stale and stays stale", () => {
  it("a service built before the opt-out never learns about it", async () => {
    const store = createInMemoryAcquisitionStore();

    // Process B hydrates first, and sees a clear list.
    const b = await createDurableSuppression({ now: now(), store });
    assert.strictEqual(b.check({ e164: NUMBER }).suppressed, false);

    // Process A records the opt-out durably.
    const a = await createDurableSuppression({ now: now(), store });
    const written = await a.suppress({
      reason: "opt_out",
      scope: "business",
      fingerprint: FINGERPRINT,
      e164: NUMBER,
      actor: "founder",
      actorKind: "human",
      note: "Asked never to be contacted again.",
    });
    assert.strictEqual(written.ok, true, JSON.stringify(written));

    assert.strictEqual(a.check({ e164: NUMBER }).suppressed, true, "the writing process must see its own write");
    assert.strictEqual(b.check({ e164: NUMBER }).suppressed, false, "THIS IS M-7: B's memory is stale");

    // The database is unambiguous about which of them is right.
    assert.strictEqual((await store.lookupSuppression({ e164: NUMBER })).length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("the final gate decides from durable state, not from memory", () => {
  /** THE MILESTONE. B is stale; the gate still refuses. */
  it("blocks a stale-memory process from authorising a suppressed business", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = harness();

    const b = await createDurableSuppression({ now: clock, store });
    assert.strictEqual(b.check({ e164: NUMBER }).suppressed, false);

    const a = await createDurableSuppression({ now: clock, store });
    await a.suppress({ reason: "opt_out", scope: "business", fingerprint: FINGERPRINT, e164: NUMBER, actor: "founder", actorKind: "human", note: "Never again." });

    assert.strictEqual(b.check({ e164: NUMBER }).suppressed, false, "B is still stale at the moment of authorisation");

    const gate = createDialAuthoriser({ now: clock, store, engineOptions });
    const decision = await gate.authorise(prospect, context);

    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.SUPPRESSED);
    assert.strictEqual(decision.suppressionSource, "durable");
    assert.strictEqual(decision.dial, null);
  });

  it("blocks on a number-scoped suppression", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.appendSuppression(suppressionRow({ scope: "number", fingerprint: null, reason: "wrong_number" }));

    const { clock, prospect, engineOptions, context } = harness();
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);

    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.SUPPRESSED);
  });

  it("blocks on a business-scoped suppression recorded without a number", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.appendSuppression(suppressionRow({ e164: null }));

    const { clock, prospect, engineOptions, context } = harness();
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);

    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.SUPPRESSED);
  });

  /**
   * The M8C drift case, now at the durable boundary. Re-imported with a
   * differently-spelled suburb, so the identity fingerprint differs — and the
   * number is the same.
   */
  it("blocks a re-imported business whose identity has drifted", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.appendSuppression(suppressionRow());

    const drifted = goodProspect({ suburb: "Brunswick East" });
    assert.notStrictEqual(identityFingerprint({ businessName: drifted.businessName, suburb: drifted.suburb, state: drifted.state }), FINGERPRINT);

    const { clock, engineOptions, context } = harness({ prospect: drifted });
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(drifted, context);

    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.SUPPRESSED);
  });

  it("authorises a clean business, and only then mints a dial permission", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = harness();
    await approveBatchIn(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);

    assert.strictEqual(decision.authorised, true, JSON.stringify(decision.failedChecks));
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.ELIGIBLE);
    assert.strictEqual(decision.suppressionSource, "durable");
    assert.strictEqual(decision.e164, NUMBER);
    assert.ok(isAuthorisedDial(decision.dial));
  });
});

// ---------------------------------------------------------------------------

describe("fail closed", () => {
  const exploding = () => ({
    ...createInMemoryAcquisitionStore(),
    async lookupSuppression() {
      throw new Error("connection terminated unexpectedly");
    },
  });

  it("refuses when the suppression store cannot be read", async () => {
    const { clock, prospect, engineOptions, context } = harness();
    const decision = await createDialAuthoriser({ now: clock, store: exploding(), engineOptions }).authorise(prospect, context);

    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, AUTHORISATION_CODES.SUPPRESSION_STORE_UNAVAILABLE);
    assert.strictEqual(decision.dial, null);
  });

  /**
   * The failure is reported as OURS, never as a finding about the business. A
   * founder reading "not suppressed" would be reading something nobody
   * established.
   */
  it("does not describe an unreadable store as a clear business", async () => {
    const { clock, prospect, engineOptions, context } = harness();
    const decision = await createDialAuthoriser({ now: clock, store: exploding(), engineOptions }).authorise(prospect, context);

    assert.strictEqual(decision.suppressionSource, "unavailable");
    assert.notStrictEqual(decision.code, ELIGIBILITY_CODES.ELIGIBLE);
    assert.match(decision.message, /could not be established/i);
  });

  it("refuses a record with neither a usable number nor an identity", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, engineOptions } = harness();
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise({ businessName: "No Number Locks", phones: [] }, {});

    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.NO_USABLE_NUMBER);
  });

  it("refuses a store that cannot answer authoritatively at all", () => {
    const crippled = { ...createInMemoryAcquisitionStore() };
    delete crippled.lookupSuppression;
    assert.throws(() => createDialAuthoriser({ now: now(), store: crippled }), /lookupSuppression|is missing/);
  });
});

// ---------------------------------------------------------------------------

describe("the rules the gate must not have weakened", () => {
  it("still refuses an unchecked DNCR wash", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = harness({ washed: false });
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.ok([ELIGIBILITY_CODES.DNCR_UNKNOWN, ELIGIBILITY_CODES.DNCR_STALE].includes(decision.code), decision.code);
  });

  it("still refuses outside the calling window", async () => {
    const store = createInMemoryAcquisitionStore();
    const midnight = "2026-08-05T16:00:00Z"; // 02:00 Melbourne
    const { clock, prospect, engineOptions, context } = harness({ iso: midnight });
    await approveBatchIn(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
  });

  it("still refuses on a public holiday", async () => {
    const store = createInMemoryAcquisitionStore();
    const holidays = { isHoliday: () => true, describe: () => "A public holiday." };
    const { clock, prospect, engineOptions, context } = harness({ holidays });
    await approveBatchIn(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
  });

  it("still refuses without founder batch approval", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = harness();
    await persist(store, prospect);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED);
  });

  /**
   * E-5. The gate used to accept this object as the approval. It no longer
   * reaches the engine at all — see the destructure at the top of authorise().
   */
  it("refuses a caller who asserts an approval the store has never heard of", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = harness();
    await persist(store, prospect);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, {
      ...context,
      batch: { approved: true, stale: false, batchHash: "abc123def456", approvedBy: "Peter", source: "durable" },
    });
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED);
  });

  it("still refuses without an adopted calling policy", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = harness({ callingPolicyApproval: createCallingPolicyApproval() });
    await approveBatchIn(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.CALLING_POLICY_UNAPPROVED);
  });
});

// ---------------------------------------------------------------------------

describe("the gate cannot be talked out of reading the database", () => {
  /**
   * THE BYPASS THAT WOULD HAVE DEFEATED EVERYTHING ELSE.
   *
   * An eligibility engine binds suppression at construction and `evaluate()`
   * cannot override it. So if this gate accepted a pre-built engine, a caller
   * could hand it one carrying the stale hydrated list; the gate would read the
   * database, discard the answer, and authorise from memory while reporting
   * that it had not. The factory takes collaborators and builds the engine
   * itself for exactly this reason.
   */
  it("ignores a suppression list supplied by the caller", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.appendSuppression(suppressionRow());

    const liar = { check: () => ({ suppressed: false, matches: [], reasons: [] }), all: () => [], count: () => 0 };
    const { clock, prospect, engineOptions, context } = harness();

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions: { ...engineOptions, suppression: liar } }).authorise(prospect, context);

    assert.strictEqual(decision.authorised, false, "a caller-supplied suppression list must not clear a suppressed business");
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.SUPPRESSED);
  });

  it("has no parameter that substitutes the eligibility engine", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-authorisation.js"), "utf8");
    const start = src.indexOf("function createDialAuthoriser");
    const signature = src.slice(start, src.indexOf(")", start));
    assert.ok(!/\bengine\b\s*=/.test(signature), "accepting a pre-built engine would let a caller supply stale suppression");
  });

  it("never consults a stored eligibility snapshot", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-authorisation.js"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    assert.ok(!/eligibilitySnapshot/.test(code), "a stored snapshot is audit-only and must never be read as authority");
  });
});

// ---------------------------------------------------------------------------

describe("nothing here can place a call", () => {
  it("exposes a decision and no way to act on it", () => {
    const gate = createDialAuthoriser({ now: now(), store: createInMemoryAcquisitionStore() });
    assert.deepStrictEqual(Object.keys(gate).sort(), ["authorise", "kind"]);
    for (const forbidden of ["dial", "call", "place", "dispatch", "ring", "send", "execute", "start"]) {
      assert.strictEqual(typeof gate[forbidden], "undefined", `the gate must not expose ${forbidden}()`);
    }
  });

  it("mints an inert permission slip with no methods", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = harness();
    await approveBatchIn(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);

    assert.strictEqual(decision.authorised, true, JSON.stringify(decision.failedChecks));
    for (const [key, value] of Object.entries(decision.dial)) {
      assert.notStrictEqual(typeof value, "function", `${key} on an authorised dial must not be callable`);
    }
    assert.ok(Object.isFrozen(decision.dial));
  });

  it("contains no provider client, transport or execution call", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-authorisation.js"), "utf8");
    for (const pattern of [
      /require\(["'](twilio|axios|node-fetch|nodemailer|retell-sdk|@retell)/,
      /\bfetch\s*\(/,
      /https?\.request\s*\(/,
      /messages\.create\s*\(/,
      /calls\.create\s*\(/,
      /\bplaceCall\s*\(/,
      /\bsendSms\s*\(/,
    ]) {
      assert.ok(!pattern.test(src), `the authorisation gate must not contain ${pattern}`);
    }
  });

  it("rejects anything that is not a slip it minted", () => {
    assert.strictEqual(isAuthorisedDial({ kind: "authorised-dial", e164: NUMBER }), false, "a hand-made lookalike must not pass");
    assert.strictEqual(isAuthorisedDial(null), false);
    assert.strictEqual(isAuthorisedDial(true), false);
  });
});

// ---------------------------------------------------------------------------

/**
 * THE RATCHET (M8E Step 7).
 *
 * A safety boundary that a future author can walk around is decoration. There
 * is no dialler today, so these assertions are aimed at the one that will
 * exist: they fail the moment something appears that could place a call and
 * has not gone through the gate.
 *
 * Deliberately NOT a framework. Three greps over `src/`, each pinned to a
 * property that only matters if somebody builds the thing this milestone
 * exists to make safe.
 */
describe("a future dialler cannot quietly skip the gate", () => {
  const SERVICES = path.join(__dirname, "..", "src", "services");
  const read = (f) => fs.readFileSync(path.join(SERVICES, f), "utf8");
  const files = fs.readdirSync(SERVICES).filter((f) => f.endsWith(".js"));

  /**
   * The permission slip is minted in exactly one place. If a second module
   * learns to construct one, the type stops being evidence that the gate ran.
   */
  it("only the authorisation gate can mint a dial permission", () => {
    const minters = files.filter((f) => f !== "acquisition-authorisation.js" && /AUTHORISED_DIAL|mintAuthorisedDial/.test(read(f)));
    assert.deepStrictEqual(minters, [], `these modules can forge a dial permission: ${minters.join(", ")}`);
  });

  /**
   * Nothing in the acquisition tree may reach a telephony or messaging client.
   * The eligibility engine, the queue and the read model all handle numbers;
   * none of them may be able to use one.
   */
  it("no acquisition module can reach a provider", () => {
    const offenders = [];
    for (const f of files.filter((f) => f.startsWith("acquisition-"))) {
      const src = read(f);
      for (const pattern of [/require\(["'](twilio|retell-sdk|@retell|nodemailer|node-fetch)/, /messages\.create\s*\(/, /calls\.create\s*\(/, /\bplaceCall\s*\(/]) {
        if (pattern.test(src)) offenders.push(`${f}: ${pattern}`);
      }
    }
    assert.deepStrictEqual(offenders, [], offenders.join("; "));
  });

  /**
   * THE ONE THAT MATTERS WHEN THE DIALLER ARRIVES.
   *
   * Any acquisition module that grows an execution verb must import the
   * authoriser. It is not proof that the gate is honoured — only that its
   * author had to look at it. Combined with the slip being unforgeable, the
   * cheap way to write a dialler becomes the safe way.
   */
  it("any acquisition module with an execution verb must import the authoriser", () => {
    const offenders = [];
    for (const f of files.filter((f) => f.startsWith("acquisition-") && f !== "acquisition-authorisation.js")) {
      const src = read(f);
      const code = src
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
        .join("\n");
      const executes = /\bfunction\s+(dial|placeCall|dispatchCall|startCall|ringProspect)\s*\(/.test(code) || /\b(dial|placeCall|dispatchCall|startCall)\s*[:=]\s*(async\s*)?\(/.test(code);
      if (executes && !/acquisition-authorisation/.test(src)) offenders.push(f);
    }
    assert.deepStrictEqual(offenders, [], `these can execute a call without importing the authoriser: ${offenders.join(", ")}`);
  });

  /** And today, plainly: nothing can execute a call at all. */
  it("no execution verb exists anywhere in the acquisition tree yet", () => {
    const offenders = files
      .filter((f) => f.startsWith("acquisition-"))
      .filter((f) => /\bfunction\s+(dial|placeCall|dispatchCall|startCall|ringProspect)\s*\(/.test(read(f)));
    assert.deepStrictEqual(offenders, [], `M8E does not build a dialler: ${offenders.join(", ")}`);
  });
});
