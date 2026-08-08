// LOCKSMITH ACQUISITION M8G — persisting imported prospects.
//
// M8F could turn a CSV into clean prospects; they evaporated when the process
// exited. These tests pin what happens when they do not: that a re-import
// reuses the canonical business rather than minting a second one, that evidence
// stays append-only and does not multiply, that a partial write is repaired by
// re-running rather than by a reconciliation job, and that none of it makes a
// business callable.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createInMemoryAcquisitionStore, assertStoreContract, STORE_METHODS } = require("../src/services/acquisition-store");
const { persistImportedProspect, persistImportResult, loadExistingForImport, PERSIST_OUTCOMES } = require("../src/services/acquisition-persist");
const { importBusinessCsv, IMPORT_OUTCOMES } = require("../src/services/acquisition-import");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const { createDialAuthoriser } = require("../src/services/acquisition-authorisation");
const { identityFingerprint } = require("../src/services/acquisition-prospect");

const AT = new Date("2026-08-08T03:00:00.000Z");
const now = () => AT;

const HEADER = "name,category,phone,phone_2,site,full_address,city,state,postal_code,country,place_id,location_link,query_date,business_status,about";
const ROW = (over = {}) => {
  const f = {
    name: "M8G Persist Probe Locksmiths",
    category: "Locksmith",
    phone: "(03) 5550 4101",
    phone_2: "",
    site: "https://m8g-persist-probe.example.com.au",
    address: "8 Bell St Coburg VIC 3058",
    city: "Coburg",
    state: "VIC",
    postcode: "3058",
    place_id: "PLACE-M8G-0001",
    ...over,
  };
  return `${f.name},${f.category},${f.phone},${f.phone_2},${f.site},${f.address},${f.city},${f.state},${f.postcode},Australia,${f.place_id},https://maps.example.com/?cid=m8g1,2026-08-01,OPERATIONAL,Locksmith`;
};
const csv = (...rows) => [HEADER, ...rows].join("\n");

/**
 * Import one CSV into a fresh ledger, then persist it into `store`.
 *
 * Asks the store first which businesses this file might already be about — the
 * cross-run dedupe M8F could not do, because in-run it only ever compared a row
 * against the rows above it.
 */
async function importAndPersist(store, text, { clock = now } = {}) {
  const ledger = createEvidenceLedger({ now: clock });
  const existing = await loadExistingForImport({ store, text, profileName: "outscraper-google-maps" });
  const result = importBusinessCsv({ text, profileName: "outscraper-google-maps", now: clock, ledger, existing });
  assert.strictEqual(result.ok, true, JSON.stringify(result.problems));
  const written = await persistImportResult({ result, ledger, store, now: clock });
  return { result, ledger, written, existing };
}

// ---------------------------------------------------------------------------

describe("the store contract covers imported prospects", () => {
  it("names every method both adapters must provide", () => {
    for (const m of ["upsertProspect", "loadProspect", "findProspects", "upsertProspectPhone", "listProspectPhones", "appendEvidence", "listEvidence"]) {
      assert.ok(STORE_METHODS.includes(m), `${m} should be part of the contract`);
    }
    assert.doesNotThrow(() => assertStoreContract(createInMemoryAcquisitionStore(), "memory"));
  });

  it("still forbids any way to delete a suppression", () => {
    const bad = { ...createInMemoryAcquisitionStore(), deleteSuppression: async () => null };
    assert.throws(() => assertStoreContract(bad, "bad"), /suppression is permanent/);
  });
});

// ---------------------------------------------------------------------------

describe("persisting one imported business", () => {
  it("stores the prospect, its number and its evidence", async () => {
    const store = createInMemoryAcquisitionStore();
    const { written } = await importAndPersist(store, csv(ROW()));

    assert.strictEqual(written.summary.created, 1);
    assert.strictEqual(written.summary.phonesAdded, 1);
    assert.ok(written.summary.evidenceAdded >= 3, "business name, category and phone at minimum");

    const id = written.persisted[0].prospectId;
    assert.ok(await store.loadProspect(id));
    assert.strictEqual((await store.listProspectPhones(id)).length, 1);
    assert.ok((await store.listEvidence(id)).length >= 3);
  });

  it("survives a restart: a fresh service reads it back from the store", async () => {
    const store = createInMemoryAcquisitionStore();
    const { written } = await importAndPersist(store, csv(ROW()));
    const id = written.persisted[0].prospectId;

    // Everything in-process is discarded; only the store survives, which is
    // exactly what a restart does.
    const reloaded = await store.loadProspect(id);
    assert.strictEqual(reloaded.businessName, "M8G Persist Probe Locksmiths");
    assert.strictEqual(reloaded.timezone, "Australia/Melbourne");
    assert.strictEqual(reloaded.origin, "operator_import");
  });

  /** A stored business is `discovered`. Storage is not approval. */
  it("lands as discovered, not as anything a human decided", async () => {
    const store = createInMemoryAcquisitionStore();
    const { written } = await importAndPersist(store, csv(ROW()));
    const reloaded = await store.loadProspect(written.persisted[0].prospectId);
    assert.ok(reloaded.lifecycle === undefined || reloaded.lifecycle === "discovered");
  });
});

// ---------------------------------------------------------------------------

describe("re-import is idempotent", () => {
  it("the exact same file twice changes nothing the second time", async () => {
    const store = createInMemoryAcquisitionStore();
    const first = await importAndPersist(store, csv(ROW()));
    const second = await importAndPersist(store, csv(ROW()));

    assert.strictEqual(first.written.summary.created, 1);
    assert.strictEqual(second.written.summary.created, 0, "no second prospect");
    assert.strictEqual(second.written.summary.phonesAdded, 0, "the same number must not be stored twice");
    assert.strictEqual(second.written.summary.evidenceAdded, 0, "identical evidence must not multiply");

    // The import itself now recognises the business from the store and MERGES
    // it, so nothing reaches persistence at all. Asserted on the database
    // rather than on the counter, because the database is the claim.
    const id = first.written.persisted[0].prospectId;
    assert.strictEqual((await store.listProspectPhones(id)).length, 1);
    assert.strictEqual((await store.listEvidence(id)).length, (await store.listEvidence(id)).length);
  });

  it("running it ten times leaves exactly one prospect, one phone and one set of evidence", async () => {
    const store = createInMemoryAcquisitionStore();
    let id = null;
    let evidenceCount = null;
    for (let i = 0; i < 10; i += 1) {
      const { written } = await importAndPersist(store, csv(ROW()));
      id = written.persisted[0].prospectId;
      if (evidenceCount === null) evidenceCount = (await store.listEvidence(id)).length;
    }
    assert.strictEqual((await store.findProspects({ fingerprint: id })).length, 1);
    assert.strictEqual((await store.listProspectPhones(id)).length, 1);
    assert.strictEqual((await store.listEvidence(id)).length, evidenceCount, "evidence must not grow on repeat imports");
  });

  /**
   * DEDUPLICATION IS BY CONTENT, NOT BY ID. The ledger's evidenceId folds in a
   * sequence number and a timestamp, so the same fact re-imported carries a NEW
   * id and the SAME contentHash. Deduplicating on the id would append a row per
   * import forever.
   */
  it("recognises identical evidence even though its id changed", async () => {
    const store = createInMemoryAcquisitionStore();
    // A MOVING CLOCK, because that is the situation this defends against. The
    // evidenceId folds in recordedAt, so two imports minutes apart carry
    // different ids for identical claims. With a frozen clock the ids happen to
    // match and the test would pass without proving anything.
    const a = await importAndPersist(store, csv(ROW()), { clock: () => new Date("2026-08-08T03:00:00.000Z") });
    const b = await importAndPersist(store, csv(ROW()), { clock: () => new Date("2026-08-09T11:22:33.000Z") });

    const idsA = a.ledger.forProspect(a.written.persisted[0].prospectId).map((e) => e.evidenceId);
    const idsB = b.ledger.forProspect(b.written.persisted[0].prospectId).map((e) => e.evidenceId);
    assert.notDeepStrictEqual(idsA, idsB, "the ids genuinely differ between imports");
    assert.strictEqual(b.written.summary.evidenceAdded, 0, "yet nothing was appended");
  });

  /**
   * A KNOWN LIMITATION, PINNED SO IT CANNOT DRIFT INTO A SURPRISE.
   *
   * When the importer MERGES a listing into a business already stored, nothing
   * from that listing is persisted -- including a genuinely new number it
   * published. The merged row is reported in the import outcome, with the
   * signals that produced the merge, and a human attaches the number.
   *
   * This is the conservative direction: attaching a phone to a business on the
   * strength of a merge decision writes a callable number nobody confirmed, and
   * a wrong one cannot be unwritten cheaply. Automatic attachment on a
   * CONCLUSIVE merge is the obvious M8H improvement.
   */
  it("reports a merged listing rather than silently attaching its new number", async () => {
    const store = createInMemoryAcquisitionStore();
    const first = await importAndPersist(store, csv(ROW()));
    const id = first.written.persisted[0].prospectId;

    const second = await importAndPersist(store, csv(ROW({ phone_2: "0455 010 404" })));

    const status = second.result.outcomes[0].status;
    assert.ok([IMPORT_OUTCOMES.MERGED, IMPORT_OUTCOMES.REVIEW_REQUIRED].includes(status), `the business is recognised, not re-created; got ${status}`);
    assert.ok(second.result.outcomes[0].mergedInto || second.result.outcomes[0].possibleDuplicateOf, "and it names the business it matched");
    assert.strictEqual((await store.listProspectPhones(id)).length, 1, "the new number is not attached without a human");
    assert.strictEqual(second.written.summary.created, 0, "and no second prospect is created");
  });

  it("does not append evidence for a listing it merged", async () => {
    const store = createInMemoryAcquisitionStore();
    const first = await importAndPersist(store, csv(ROW()));
    const id = first.written.persisted[0].prospectId;
    const before = (await store.listEvidence(id)).length;

    await importAndPersist(store, csv(ROW({ category: "Emergency locksmith" })));
    assert.strictEqual((await store.listEvidence(id)).length, before, "a merged listing contributes nothing until a human accepts it");
  });

  /**
   * A prospect's lifecycle belongs to the humans who moved it. Re-running a CSV
   * is not a decision, and an upsert carrying `discovered` would quietly undo a
   * review every time the file was imported again.
   */
  it("never drags a reviewed prospect back to discovered", async () => {
    const store = createInMemoryAcquisitionStore();
    const { written } = await importAndPersist(store, csv(ROW()));
    const id = written.persisted[0].prospectId;

    await store.upsertProspect({ prospectId: id, lifecycle: "review_approved" });
    const approved = await store.loadProspect(id);
    approved.lifecycle = "review_approved";

    await importAndPersist(store, csv(ROW()));
    const after = await store.loadProspect(id);
    assert.notStrictEqual(after.lifecycle, "discovered", "a re-import must not undo a review");
  });
});

// ---------------------------------------------------------------------------

describe("drifted re-import merges rather than multiplying", () => {
  it("keeps one prospect when the same business arrives with a Pty Ltd name", async () => {
    const store = createInMemoryAcquisitionStore();
    await importAndPersist(store, csv(ROW()));

    const drifted = csv(ROW({ name: "M8G Persist Probe Locksmiths Pty Ltd", place_id: "PLACE-M8G-0002" }));
    const { result } = await importAndPersist(store, drifted);

    // M8F's dedupe decides this at import time; persistence must not undo it.
    const outcome = result.outcomes[0];
    assert.ok([IMPORT_OUTCOMES.MERGED, IMPORT_OUTCOMES.REVIEW_REQUIRED].includes(outcome.status), `expected a merge or a review, got ${outcome.status}`);
  });

  it("keeps a genuine branch distinct", async () => {
    const store = createInMemoryAcquisitionStore();
    const two = csv(
      ROW(),
      ROW({ name: "M8G Persist Probe Locksmiths — Epping", city: "Epping", postcode: "3076", phone: "(03) 5550 4202", place_id: "PLACE-M8G-0003" })
    );
    const { written } = await importAndPersist(store, two);
    assert.strictEqual(written.summary.created, 2, "two shopfronts are two businesses to call");
  });
});

// ---------------------------------------------------------------------------

describe("partial failure is reported and repaired by re-running", () => {
  const failingAt = (method) => {
    const store = createInMemoryAcquisitionStore();
    let armed = true;
    return {
      store: {
        ...store,
        async [method](row) {
          if (armed) {
            armed = false;
            throw new Error(`simulated ${method} failure`);
          }
          return store[method](row);
        },
      },
      disarm: () => {
        armed = false;
      },
      inner: store,
    };
  };

  it("stops at the phone stage and says so, rather than swallowing it", async () => {
    const { store } = failingAt("upsertProspectPhone");
    const ledger = createEvidenceLedger({ now });
    const result = importBusinessCsv({ text: csv(ROW()), profileName: "outscraper-google-maps", now, ledger });
    const written = await persistImportResult({ result, ledger, store, now });

    assert.strictEqual(written.summary.partial, 1);
    assert.strictEqual(written.persisted[0].stage, "phones");
    assert.match(written.persisted[0].message, /Re-running/);
  });

  it("a retry adds exactly what was missing", async () => {
    const harness = failingAt("upsertProspectPhone");
    const ledger = createEvidenceLedger({ now });
    const result = importBusinessCsv({ text: csv(ROW()), profileName: "outscraper-google-maps", now, ledger });

    const first = await persistImportResult({ result, ledger, store: harness.store, now });
    assert.strictEqual(first.summary.partial, 1);

    // The prospect landed; the phone and evidence did not.
    const id = first.persisted[0].prospectId;
    assert.ok(await harness.inner.loadProspect(id));
    assert.strictEqual((await harness.inner.listProspectPhones(id)).length, 0);

    const second = await persistImportResult({ result, ledger, store: harness.store, now });
    assert.strictEqual(second.summary.partial, 0);
    assert.strictEqual((await harness.inner.listProspectPhones(id)).length, 1);
    assert.ok((await harness.inner.listEvidence(id)).length >= 3, "the evidence that never landed is appended on retry");
  });

  it("a prospect that cannot be stored at all attempts nothing else", async () => {
    const store = createInMemoryAcquisitionStore();
    const broken = {
      ...store,
      async upsertProspect() {
        throw new Error("simulated prospect failure");
      },
    };
    const ledger = createEvidenceLedger({ now });
    const result = importBusinessCsv({ text: csv(ROW()), profileName: "outscraper-google-maps", now, ledger });
    const written = await persistImportResult({ result, ledger, store: broken, now });

    assert.strictEqual(written.summary.failed, 1);
    assert.strictEqual(written.persisted[0].stage, "prospect");
    assert.strictEqual((await store.listEvidence(written.persisted[0].prospectId)).length, 0, "nothing may be written for a prospect that does not exist");
  });

  it("one failing business does not stop the others", async () => {
    const store = createInMemoryAcquisitionStore();
    let failed = false;
    const flaky = {
      ...store,
      async upsertProspect(row) {
        if (!failed && String(row.businessName).includes("Epping")) {
          failed = true;
          throw new Error("simulated");
        }
        return store.upsertProspect(row);
      },
    };
    const ledger = createEvidenceLedger({ now });
    const text = csv(ROW(), ROW({ name: "M8G Persist Probe Locksmiths — Epping", city: "Epping", postcode: "3076", phone: "(03) 5550 4202", place_id: "PLACE-M8G-0003" }));
    const result = importBusinessCsv({ text, profileName: "outscraper-google-maps", now, ledger });
    const written = await persistImportResult({ result, ledger, store: flaky, now });

    assert.strictEqual(written.summary.attempted, 2);
    assert.ok(written.summary.created >= 1, "the healthy business is still stored");
    assert.strictEqual(written.summary.failed, 1);
  });
});

// ---------------------------------------------------------------------------

describe("persisting never weakens suppression", () => {
  const suppressed = () => {
    const list = createSuppressionList({ now });
    list.suppress({
      reason: "opt_out",
      scope: "business",
      fingerprint: identityFingerprint({ businessName: "M8G Persist Probe Locksmiths", suburb: "Coburg", state: "VIC" }),
      e164: "+61355504101",
      actor: "founder",
      actorKind: "human",
      note: "Asked never to be contacted again.",
    });
    return list;
  };

  it("a persisted, re-imported, drifted business is still blocked", async () => {
    const store = createInMemoryAcquisitionStore();
    await importAndPersist(store, csv(ROW()));

    const suppression = suppressed();

    // Re-import with drift, exactly as a second export would arrive.
    const { result } = await importAndPersist(store, csv(ROW({ name: "M8G Persist Probe Locksmiths Pty Ltd", city: "Coburg North", place_id: "PLACE-M8G-0009" })));
    const prospect = result.prospects[0] || (await store.loadProspect((await store.findProspects({ fingerprint: null, e164: "+61355504101" }))[0]?.prospectId));

    const engine = createEligibilityEngine({ now, suppression });
    const decision = engine.evaluate(prospect, { evidenceRows: [] });
    assert.strictEqual(decision.eligible, false);
    assert.ok(decision.failedChecks.some((f) => f.check === "suppression" && f.code === ELIGIBILITY_CODES.SUPPRESSED), "suppression must fire on the re-imported record");
  });

  it("the final authorisation gate still refuses from durable state", async () => {
    const store = createInMemoryAcquisitionStore();
    const { written } = await importAndPersist(store, csv(ROW()));
    const prospect = await store.loadProspect(written.persisted[0].prospectId);

    await store.appendSuppression({
      reason: "opt_out",
      scope: "business",
      fingerprint: identityFingerprint({ businessName: prospect.businessName, suburb: prospect.suburb, state: prospect.state }),
      e164: "+61355504101",
      actor: "founder",
      actorKind: "human",
      note: "Asked never to be contacted again.",
      suppressedAt: AT.toISOString(),
    });

    const gate = createDialAuthoriser({ now, store });
    const decision = await gate.authorise({ ...prospect, phones: [{ raw: "(03) 5550 4101" }] }, {});
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.dial, null);
  });

  it("storing a business does not make it callable", async () => {
    const store = createInMemoryAcquisitionStore();
    const { written, ledger } = await importAndPersist(store, csv(ROW()));
    const prospect = await store.loadProspect(written.persisted[0].prospectId);

    const engine = createEligibilityEngine({ now, suppression: createSuppressionList({ now }) });
    const decision = engine.evaluate({ ...prospect, phones: [{ raw: "(03) 5550 4101" }] }, { evidenceRows: ledger.forProspect(prospect.prospectId) });
    assert.strictEqual(decision.eligible, false, "a stored prospect is unreviewed and unwashed");
  });
});

// ---------------------------------------------------------------------------

describe("the persistence layer cannot contact anybody", () => {
  const SRC = path.join(__dirname, "..", "src", "services", "acquisition-persist.js");
  const src = fs.readFileSync(SRC, "utf8");

  it("imports no network or provider client", () => {
    for (const pattern of [/require\(["'](https?|node:https?|axios|node-fetch|twilio|retell-sdk|@retell|nodemailer)["']\)/, /\bfetch\s*\(/]) {
      assert.ok(!pattern.test(src), `must not contain ${pattern}`);
    }
  });

  it("has no call, SMS or email surface", () => {
    for (const pattern of [/messages\.create\s*\(/, /calls\.create\s*\(/, /\bplaceCall\s*\(/, /\bsendSms\s*\(/, /\bdial\s*\(/]) {
      assert.ok(!pattern.test(src), `must not contain ${pattern}`);
    }
  });

  it("writes only through the store contract", () => {
    assert.ok(!/writeFileSync|appendFileSync|createWriteStream/.test(src));
    assert.ok(!/require\(["']@supabase/.test(src), "the adapter is injected, never constructed here");
  });

  it("cannot approve compliance or move a lifecycle", () => {
    for (const pattern of [/transitionProspect/, /review_approved/, /counselApproved/, /washStore/]) {
      assert.ok(!pattern.test(src), `persistence must not touch ${pattern}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the CLI's write mode is explicit and dev-only", () => {
  const CLI = path.join(__dirname, "..", "scripts", "acquisition-import.js");
  const src = fs.readFileSync(CLI, "utf8");

  it("defaults to a dry run", () => {
    assert.ok(/out\s*=\s*\{[^}]*showRows: true/.test(src) || !/write:\s*true/.test(src.slice(0, src.indexOf("parseArgs") + 400)), "write must not default on");
    assert.ok(/if \(args\.write\)/.test(src), "writing must be gated on the flag");
  });

  it("uses --write and refuses the ambiguous alternatives", () => {
    assert.ok(/"--write"/.test(src));
    for (const flag of ["--live", "--commit", "--apply", "--execute"]) {
      assert.ok(!new RegExp(`"${flag}"`).test(src), `${flag} must not be accepted`);
    }
  });

  it("refuses to write to anything but the dev project", () => {
    assert.ok(/wvwemitmmsdytyutaqbm/.test(src), "the dev ref guard must be present");
    assert.ok(/REFUSING TO WRITE/.test(src));
  });

  it("only reads credentials in write mode", () => {
    const guard = src.slice(src.indexOf("if (args.write)"), src.indexOf("if (args.write)") + 900);
    assert.ok(/SUPABASE_URL/.test(guard) && /SUPABASE_SERVICE_KEY/.test(guard), "credentials belong inside the write branch");
  });

  it("never prints a credential", () => {
    assert.ok(!/console\.log\([^)]*SUPABASE_SERVICE_KEY/.test(src));
    assert.ok(!/console\.log\([^)]*process\.env/.test(src));
  });
});

// ---------------------------------------------------------------------------

/**
 * DOCUMENTATION STATUS (M8G-CLOSE).
 *
 * This project has twice shipped a document that described a state the system
 * had left — "both migrations are unapplied" after they were applied, and "dry
 * run is the only mode" after a write mode existed. Both were caught by reading
 * rather than by a test. These are the cheap assertions that would have caught
 * them, aimed at the claims most likely to rot next.
 */
describe("the docs describe the system that exists", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "docs", f), "utf8");
  const spec = read("LOCKSMITH_ACQUISITION_SPEC.md");
  const runbook = read("ACQUISITION_SQL_RUNBOOK.md");

  it("does not still claim the importer has no write mode", () => {
    const claim = /Dry run is not a flag; it is the only mode/;
    if (claim.test(spec)) {
      assert.ok(/Superseded in part by M8G/.test(spec), "the superseded claim must be marked as superseded, not left standing");
    }
    assert.ok(/`--write`/.test(spec), "the write mode must be documented somewhere");
  });

  it("records the M8G residue truthfully, including what was not planned", () => {
    for (const id of ["pr_0b9f51cfe79018067bf1", "pr_f546eb7194421d554527"]) {
      assert.ok(spec.includes(id), `${id} must appear in the spec's residue table`);
      assert.ok(runbook.includes(id), `${id} must appear in the runbook's residue table`);
    }
    assert.ok(/not planned|unplanned|were not planned/i.test(spec), "the overrun must be named as an overrun");
    assert.ok(/append-only/.test(runbook) && /RESTRICT/.test(runbook), "and the reason it remains must be stated");
  });

  it("does not claim the append-only controls were bypassed", () => {
    assert.ok(/no trigger was disabled/i.test(runbook), "the runbook must state enforcement was never disabled");
    assert.ok(!/disable trigger/i.test(spec), "nothing should read as an instruction to disable enforcement");
  });

  it("keeps merge enrichment open rather than implying it is done", () => {
    assert.ok(/Known limitation/i.test(spec), "the limitation must be labelled");
    assert.ok(/M8H/.test(spec), "and carried forward to the next milestone");
  });

  it("still says production is untouched", () => {
    assert.ok(/[Pp]roduction is untouched|not to production|NOT applied to production/.test(spec));
  });
});
