// LOCKSMITH ACQUISITION M8F — real-source lead intake.
//
// The pipeline that turns a directory export into canonical prospects. These
// tests pin the four things that decide whether a real file can be trusted:
// the parser survives real-world CSV, unknown stays unknown, a landline is a
// callable business number, and nothing in the import path can contact anybody.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { parseCsv } = require("../src/services/acquisition-csv");
const { getImportProfile, validateMapping, mapRow, normaliseUrl, normaliseState } = require("../src/services/acquisition-import-profiles");
const { classifyBusiness } = require("../src/services/acquisition-classify");
const { importBusinessCsv, IMPORT_OUTCOMES } = require("../src/services/acquisition-import");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const { qualifyProspect } = require("../src/services/acquisition-qualification");
const { identityFingerprint } = require("../src/services/acquisition-prospect");
const S = require("../src/services/acquisition-schema");

const AT = new Date("2026-08-08T03:00:00.000Z");
const now = () => AT;
const FIXTURE = path.join(__dirname, "fixtures", "locksmiths-outscraper-sample.csv");
const fixtureText = () => fs.readFileSync(FIXTURE, "utf8");

const runImport = (over = {}) =>
  importBusinessCsv({
    text: fixtureText(),
    profileName: "outscraper-google-maps",
    now,
    ledger: createEvidenceLedger({ now }),
    ...over,
  });

const byLine = (result, line) => result.outcomes.find((o) => o.line === line);
const named = (result, name) => result.outcomes.find((o) => (o.businessName || "").startsWith(name));

// ---------------------------------------------------------------------------

describe("CSV parsing survives what export tools actually produce", () => {
  it("keeps commas inside quoted fields", () => {
    const r = parseCsv('a,b\n"Smith, John",2');
    assert.strictEqual(r.rows[0].values.a, "Smith, John");
    assert.strictEqual(r.rows[0].values.b, "2");
  });

  it("keeps newlines inside quoted fields", () => {
    const r = parseCsv('a,b\n"line one\nline two",2');
    assert.strictEqual(r.rows[0].values.a, "line one\nline two");
    assert.strictEqual(r.rows.length, 1, "an embedded newline must not split the row");
  });

  it("unescapes a doubled quote", () => {
    const r = parseCsv('a\n"He said ""hello"""');
    assert.strictEqual(r.rows[0].values.a, 'He said "hello"');
  });

  it("strips the BOM Excel adds, so the first column name still matches", () => {
    const r = parseCsv("﻿name,phone\nAcme,123");
    assert.deepStrictEqual([...r.headers], ["name", "phone"]);
  });

  it("handles CRLF, LF and a lone CR in one file", () => {
    const r = parseCsv("a\r\n1\n2\r3");
    assert.deepStrictEqual(r.rows.map((x) => x.values.a), ["1", "2", "3"]);
  });

  it("reports a row with too many cells instead of misaligning it", () => {
    const r = parseCsv("a,b\n1,2,3");
    assert.strictEqual(r.rows.length, 0, "a misaligned row must not be imported");
    assert.ok(r.problems.some((p) => p.code === "too_many_cells"));
  });

  it("refuses a file whose quote is never closed, rather than half-reading it", () => {
    const r = parseCsv('a,b\n"never closed,2');
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => p.code === "unterminated_quote"));
  });

  it("refuses an empty file by name", () => {
    assert.strictEqual(parseCsv("").ok, false);
    assert.strictEqual(parseCsv("   \n  ").ok, false);
  });

  it("does not throw on non-text input", () => {
    assert.strictEqual(parseCsv(null).ok, false);
    assert.strictEqual(parseCsv(42).ok, false);
  });
});

// ---------------------------------------------------------------------------

describe("mapping: unknown stays unknown", () => {
  const profile = getImportProfile("outscraper-google-maps").profile;

  it("produces null for a column the file does not have", () => {
    const r = mapRow(profile, { name: "Acme Locks" });
    assert.strictEqual(r.website, null);
    assert.strictEqual(r.postcode, null);
    assert.strictEqual(r.sourceId, null);
    assert.strictEqual(r.operatingStatus, null);
  });

  /**
   * THE ONE THAT MATTERS MOST. Timezone is a compliance input — calling hours
   * are checked in the business's local time — so a guessed timezone guesses
   * whether a call is lawful.
   */
  it("derives timezone from an explicit state and NEVER invents one", () => {
    assert.strictEqual(mapRow(profile, { name: "A", state: "VIC" }).timezone, "Australia/Melbourne");
    assert.strictEqual(mapRow(profile, { name: "A", state: "QLD" }).timezone, "Australia/Brisbane");
    assert.strictEqual(mapRow(profile, { name: "A", postal_code: "3000" }).timezone, null, "a postcode must not produce a timezone");
    assert.strictEqual(mapRow(profile, { name: "A" }).timezone, null);
  });

  it("reads long-form state names but refuses nonsense", () => {
    assert.strictEqual(normaliseState("Victoria"), "VIC");
    assert.strictEqual(normaliseState("New South Wales"), "NSW");
    assert.strictEqual(normaliseState("Wakanda"), null);
  });

  it("records a state/postcode contradiction without resolving it", () => {
    const r = mapRow(profile, { name: "A", state: "NSW", postal_code: "3020" });
    assert.strictEqual(r.state, "NSW", "neither value may be silently corrected");
    assert.strictEqual(r.postcode, "3020");
    assert.ok(r.notes.some((n) => n.code === "state_postcode_mismatch"));
  });

  it("flags a non-Australian country", () => {
    const r = mapRow(profile, { name: "A", country: "New Zealand" });
    assert.ok(r.notes.some((n) => n.code === "unsupported_country"));
  });

  it("normalises a URL for comparison without changing where it points", () => {
    assert.strictEqual(normaliseUrl("www.Example.com.au/"), "https://example.com.au");
    assert.strictEqual(normaliseUrl("https://example.com.au/page?utm_source=x&id=7"), "https://example.com.au/page?id=7");
    assert.strictEqual(normaliseUrl("not a url"), null);
  });

  it("splits several numbers out of one cell and keeps them all", () => {
    const r = mapRow(profile, { name: "A", phone: "(03) 5550 1000; 0455 010 111" });
    assert.strictEqual(r.phones.length, 2);
  });

  it("validates the mapping before any row is read", () => {
    const bad = validateMapping(profile, ["business", "telephone"]);
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.problems.some((p) => p.code === "missing_required_column"));
    assert.ok(bad.problems.some((p) => p.code === "no_phone_column"));

    const good = validateMapping(profile, ["name", "phone", "site"]);
    assert.strictEqual(good.ok, true);
    assert.ok(good.recognised.includes("name"));
  });

  it("refuses an unknown profile by name", () => {
    const r = getImportProfile("scrape-everything");
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /no import profile/i);
  });
});

// ---------------------------------------------------------------------------

describe("classification separates locksmiths from the rest of the export", () => {
  const verdictOf = (over) => classifyBusiness({ businessName: "X", tradeCategory: "", ...over }).verdict;

  it("accepts what the source's own category column says", () => {
    // Category alone is strong; category corroborated by the NAME is as good
    // as it gets offline. "Preston Key & Safe" never says locksmith, so it is
    // `likely` rather than certain — which is the honest answer.
    assert.strictEqual(verdictOf({ businessName: "Werribee Auto Locksmiths", tradeCategory: "Locksmith" }), "locksmith");
    assert.strictEqual(verdictOf({ businessName: "Preston Key & Safe", tradeCategory: "Locksmith" }), "likely_locksmith");
    assert.strictEqual(verdictOf({ businessName: "Acme Services", tradeCategory: "Locksmith" }), "likely_locksmith");
  });

  /**
   * THE BUG THIS PINS. A lead-generation funnel's category column says
   * "Locksmith" — that is the entire point of it — so category can never be
   * what rules one out. An earlier version let this through as a clean import
   * and was saved only by the directory hostname, which meant a funnel on its
   * OWN domain would have been imported and queued.
   */
  it("treats a lead-generation page as an aggregator even when its category says locksmith", () => {
    const onOwnDomain = classifyBusiness({
      businessName: "Locksmith Near Me 24/7",
      tradeCategory: "Locksmith",
      website: "https://locksmithnearme247.example.com.au",
      serviceArea: "compare quotes from local pros nationwide",
    });
    assert.strictEqual(onOwnDomain.verdict, "aggregator", "the NAME gives it away even without a directory host");
    assert.strictEqual(onOwnDomain.isLocksmith, false);
  });

  it("sends a real-sounding business with promotional language to review, not to the bin", () => {
    const r = classifyBusiness({ businessName: "Preston Key & Safe", tradeCategory: "Locksmith", serviceArea: "servicing Melbourne, australia wide support" });
    assert.strictEqual(r.verdict, "needs_review", "description language is weaker evidence than a name");
  });

  it("treats a directory-hosted website as an aggregator", () => {
    const r = classifyBusiness({ businessName: "Some Locks", tradeCategory: "Locksmith", website: "https://www.cylex.com.au/company/x" });
    assert.strictEqual(r.verdict, "aggregator");
  });

  it("rejects an unrelated trade", () => {
    assert.strictEqual(verdictOf({ businessName: "Cheltenham Plumbing", tradeCategory: "Plumber" }), "not_locksmith");
  });

  it("sends a lock-adjacent business to review rather than guessing", () => {
    const r = classifyBusiness({ businessName: "Ballarat Security Systems", tradeCategory: "Security system installer" });
    assert.strictEqual(r.verdict, "needs_review");
    assert.strictEqual(r.isLocksmith, false);
    assert.ok(r.signals.some((s) => s.id === "lock_adjacent"));
  });

  it("sends a hardware store that also cuts keys to review, not to the queue", () => {
    const r = classifyBusiness({ businessName: "Bayside Hardware & Timber", tradeCategory: "Hardware store" });
    assert.strictEqual(r.isLocksmith, false);
  });

  it("separates facts from inferences and returns its reasoning", () => {
    const r = classifyBusiness({ businessName: "Preston Key & Safe", tradeCategory: "Locksmith", website: "https://prestonkeyandsafe.example.com.au" });
    assert.ok(r.signals.some((s) => s.id === "category_says_locksmith" && s.kind === "fact"));
    assert.ok(r.signals.some((s) => s.id === "own_domain" && s.kind === "inference"));
  });

  it("uses the existing review vocabulary rather than inventing one", () => {
    const r = classifyBusiness({ businessName: "Cheltenham Plumbing", tradeCategory: "Plumber" });
    assert.ok(S.REVIEW_REJECTION_REASONS.includes(r.reviewReason));
  });
});

// ---------------------------------------------------------------------------

describe("the fixture export, end to end", () => {
  it("processes every row and loses none", () => {
    const r = runImport();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcomes.length, r.summary.sourceRows, "every source row must produce exactly one outcome");
    assert.strictEqual(r.summary.failed, 0);
  });

  it("imports the clean locksmiths", () => {
    const r = runImport();
    assert.strictEqual(named(r, "Preston Key & Safe").status, IMPORT_OUTCOMES.IMPORTED);
    assert.strictEqual(named(r, "Brunswick Mobile").status, IMPORT_OUTCOMES.IMPORTED);
    assert.strictEqual(named(r, "Werribee Auto").status, IMPORT_OUTCOMES.IMPORTED);
  });

  it("merges the Pty Ltd variant with formatting drift instead of creating a second prospect", () => {
    const r = runImport();
    const merged = named(r, "Preston Key and Safe Pty Ltd");
    assert.strictEqual(merged.status, IMPORT_OUTCOMES.MERGED);
    assert.ok(merged.mergedInto, "a merge must name what it merged into");
    assert.ok(merged.message.length > 0, "and must explain why");
  });

  it("catches the same listing id twice in one file", () => {
    const r = runImport();
    const dupes = r.outcomes.filter((o) => o.status === IMPORT_OUTCOMES.DUPLICATE);
    assert.strictEqual(dupes.length, 1);
    assert.ok(dupes[0].duplicateOfLine, "a duplicate must say which line it repeats");
  });

  /**
   * TWO BRANCHES ARE TWO BUSINESSES. Different suburbs, different numbers, same
   * owner and website — a second shopfront is a second business to call, and
   * merging them would silently halve the pipeline.
   */
  it("keeps legitimate branches as separate prospects", () => {
    const r = runImport();
    assert.strictEqual(named(r, "Northside Lock & Key — Reservoir").status, IMPORT_OUTCOMES.IMPORTED);
    assert.strictEqual(named(r, "Northside Lock & Key — Epping").status, IMPORT_OUTCOMES.IMPORTED);
  });

  it("excludes the aggregator, the hardware store and the plumber", () => {
    const r = runImport();
    for (const name of ["Locksmith Near Me", "Bayside Hardware", "Cheltenham Plumbing"]) {
      assert.strictEqual(named(r, name).status, IMPORT_OUTCOMES.NOT_LOCKSMITH, name);
    }
  });

  it("separates an invalid number from a missing one", () => {
    const r = runImport();
    assert.strictEqual(named(r, "Footscray Locks").status, IMPORT_OUTCOMES.INVALID_PHONE);
    assert.strictEqual(named(r, "Geelong Safe").status, IMPORT_OUTCOMES.MISSING_PHONE);
  });

  it("refuses a premium-rate number as uncallable", () => {
    const r = runImport();
    assert.strictEqual(named(r, "Frankston Locksmiths").status, IMPORT_OUTCOMES.INVALID_PHONE);
  });

  it("refuses a row with no business name", () => {
    const r = runImport();
    assert.ok(r.outcomes.some((o) => o.status === IMPORT_OUTCOMES.INSUFFICIENT_DATA));
  });

  it("sends the state/postcode contradiction to review rather than importing it silently", () => {
    const r = runImport();
    const sunshine = named(r, "Sunshine Locksmiths");
    assert.strictEqual(sunshine.status, IMPORT_OUTCOMES.REVIEW_REQUIRED);
    assert.match(sunshine.message, /NSW|3020/);
  });

  it("parses the row whose About field contains a newline", () => {
    const r = runImport();
    assert.strictEqual(named(r, "Dandenong Emergency").status, IMPORT_OUTCOMES.IMPORTED);
  });

  it("parses the row whose name contains a quoted comma", () => {
    const r = runImport();
    assert.strictEqual(named(r, "Richmond Lock Specialists").status, IMPORT_OUTCOMES.IMPORTED);
  });
});

// ---------------------------------------------------------------------------

describe("landlines are business numbers, and are kept", () => {
  /**
   * The outreach method that filtered landlines out was SMS. AIDA is
   * voice-first, and a published business landline is the number a locksmith
   * answers. The engine's own CALLABLE_PHONE_KINDS has always said so; this
   * pins it so an import can never quietly narrow it.
   */
  it("treats landline, mobile and 1300/1800 as callable", () => {
    assert.deepStrictEqual([...S.CALLABLE_PHONE_KINDS].sort(), ["landline", "mobile", "service"]);
  });

  it("imports far more landlines than mobiles from a real-shaped export", () => {
    const r = runImport();
    assert.ok(r.summary.phoneKinds.landline >= 8, `expected landlines to survive, got ${JSON.stringify(r.summary.phoneKinds)}`);
    assert.ok(r.summary.phoneKinds.mobile >= 1);
  });

  it("keeps every number when a listing publishes more than one", () => {
    const r = runImport();
    const coburg = named(r, "Coburg Lock & Key");
    assert.strictEqual(coburg.phones.length, 2, "a second published number must not be dropped");
    assert.ok(coburg.phones.some((p) => p.kind === "landline"));
    assert.ok(coburg.phones.some((p) => p.kind === "mobile"));
  });
});

// ---------------------------------------------------------------------------

describe("provenance goes to the one ledger that already exists", () => {
  it("writes evidence for every imported prospect", () => {
    const ledger = createEvidenceLedger({ now });
    const r = runImport({ ledger });
    const imported = r.outcomes.find((o) => o.status === IMPORT_OUTCOMES.IMPORTED);
    const rows = ledger.forProspect(imported.prospectId);
    assert.ok(rows.length >= 3, "a business name, a category and a phone at minimum");
    for (const kind of ["business_name", "phone", "trade_category"]) {
      assert.ok(rows.some((e) => e.kind === kind), `missing ${kind} evidence`);
    }
  });

  it("records where each fact came from, including the listing identifier", () => {
    const ledger = createEvidenceLedger({ now });
    const r = runImport({ ledger });
    const imported = r.outcomes.find((o) => o.status === IMPORT_OUTCOMES.IMPORTED);
    const phone = ledger.forProspect(imported.prospectId).find((e) => e.kind === "phone");
    assert.ok(phone.source, "a phone with no source is exactly what review is for");
    assert.strictEqual(phone.captureMode, "operator_import");
  });

  /**
   * A map listing is not an official source, and importing one must not start
   * claiming it is. The whole DNCR/review posture rests on this.
   */
  it("does not promote a directory listing to an official source", () => {
    const ledger = createEvidenceLedger({ now });
    const r = runImport({ ledger });
    const imported = r.outcomes.find((o) => o.status === IMPORT_OUTCOMES.IMPORTED);
    const phone = ledger.forProspect(imported.prospectId).find((e) => e.kind === "phone");

    /**
     * THE DEFECT THIS NOW ACTUALLY CATCHES.
     *
     * The previous version read `phone.source.type`. The field is `sourceType`,
     * so it compared `undefined` against a string, passed, and hid the fact
     * that every imported map-listing phone was being recorded as
     * `official_website` with `official: true` and `authoritative: true` —
     * because an unrecognised hostname falls through to the most authoritative
     * classification there is.
     *
     * `phoneFromOfficialSource` then reported a directory number as officially
     * sourced, removing a review gap that should exist. Asserted on all three
     * fields now, by their real names.
     */
    assert.strictEqual(phone.source.sourceType, "map_listing", "the phone came from the map listing, not the business's site");
    assert.strictEqual(phone.source.official, false, "a map listing is not an official source");

    /**
     * `authoritative` is a different axis and is left alone here. A1 sets it
     * from captureMode: `operator_import` means an operator supplied the file,
     * which is true of a CSV a founder exported.
     *
     * Worth knowing rather than changing under M8G: bulk-importing 900 rows
     * marks all 900 `authoritative`, and `assessEvidence.humanVerified` reads
     * that as "a human verified something". A founder attested to the FILE, not
     * to each row in it. That distinction is an A1 contract question, not an
     * import bug, and the safety-critical axis — whether a directory number
     * counts as officially sourced — is asserted above and below.
     */
    assert.strictEqual(phone.captureMode, "operator_import");
  });

  it("does not let an imported listing satisfy the official-source requirement", () => {
    const { assessEvidence } = require("../src/services/acquisition-evidence");
    const ledger = createEvidenceLedger({ now });
    const r = runImport({ ledger });
    const imported = r.outcomes.find((o) => o.status === IMPORT_OUTCOMES.IMPORTED);
    const assessment = assessEvidence(ledger.forProspect(imported.prospectId));
    assert.strictEqual(assessment.phoneFromOfficialSource, false, "a directory number must never read as officially sourced");
  });

  it("creates no second provenance store", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-import.js"), "utf8");
    assert.ok(/require\(["']\.\/acquisition-discovery["']\)/.test(src), "evidence must be written through the discovery admission path");
    assert.ok(!/writeFile|appendFile|createWriteStream/.test(src), "the importer must not persist provenance of its own");
  });
});

// ---------------------------------------------------------------------------

describe("importing does not make anything callable", () => {
  const importedProspect = () => {
    const ledger = createEvidenceLedger({ now });
    const r = runImport({ ledger });
    const o = r.outcomes.find((x) => x.status === IMPORT_OUTCOMES.IMPORTED);
    return { prospect: r.prospects.find((p) => p.prospectId === o.prospectId), evidence: ledger.forProspect(o.prospectId), outcome: o };
  };

  it("leaves an imported prospect ineligible: unwashed, unreviewed, unapproved", () => {
    const { prospect, evidence } = importedProspect();
    const engine = createEligibilityEngine({ now, suppression: createSuppressionList({ now }) });
    const decision = engine.evaluate(prospect, { evidenceRows: evidence });
    assert.strictEqual(decision.eligible, false, "a freshly imported business must never be callable");
  });

  it("keeps DNCR-unknown blocking", () => {
    const { prospect, evidence } = importedProspect();
    const engine = createEligibilityEngine({ now, suppression: createSuppressionList({ now }), washStore: null });
    const decision = engine.evaluate(prospect, { evidenceRows: evidence });
    assert.ok(decision.failedChecks.some((f) => f.check === "dncr"));
  });

  /**
   * THE RE-IMPORT CASE. A business that opted out must not become callable
   * because somebody re-exported it from a directory next month.
   */
  it("cannot resurrect an opted-out business by re-importing it", () => {
    const { prospect, evidence } = importedProspect();
    const suppression = createSuppressionList({ now });
    suppression.suppress({
      reason: "opt_out",
      scope: "business",
      fingerprint: identityFingerprint(prospect),
      actor: "founder",
      actorKind: "human",
      note: "Asked never to be contacted again.",
    });

    const engine = createEligibilityEngine({ now, suppression });
    const decision = engine.evaluate(prospect, { evidenceRows: evidence });

    assert.strictEqual(decision.eligible, false);
    // The DECISIVE code is whatever outranks suppression for a freshly
    // imported record — it has not been reviewed yet, and record validity sits
    // above suppression in the precedence order. What matters here is that the
    // suppression check itself fired: re-importing did not clear it.
    assert.ok(
      decision.failedChecks.some((f) => f.check === "suppression" && f.code === ELIGIBILITY_CODES.SUPPRESSED),
      `suppression should have fired; failed checks were ${decision.failedChecks.map((f) => f.check).join(", ")}`
    );
  });

  it("re-importing the same file twice produces merges, not a second set of prospects", () => {
    const ledger = createEvidenceLedger({ now });
    const first = runImport({ ledger });
    const second = runImport({ ledger, existing: first.prospects });
    assert.strictEqual(second.summary.imported, 0, "a re-import must import nothing new");
    assert.ok(second.summary.merged > 0, "it should recognise what it already knows");
  });

  it("integrates with qualification without deciding anything itself", () => {
    const ledger = createEvidenceLedger({ now });
    const r = runImport({ ledger, qualify: (p, e) => qualifyProspect(p, { evidenceRows: e, at: AT }) });
    const imported = r.outcomes.find((o) => o.status === IMPORT_OUTCOMES.IMPORTED);
    assert.ok(imported.qualification, "a qualifier, when supplied, should be run");
    assert.ok(S.QUALIFICATION_VERDICTS.includes(imported.qualification.verdict));
  });
});

// ---------------------------------------------------------------------------

describe("a bad row does not take the batch with it", () => {
  it("keeps going when one row throws", () => {
    const text = fixtureText();
    const r = importBusinessCsv({
      text,
      profileName: "outscraper-google-maps",
      now,
      ledger: {
        record(row) {
          if (String(row.value).includes("Brunswick")) throw new Error("simulated ledger failure");
          return { evidenceId: "ev", ...row };
        },
        forProspect: () => [],
      },
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.summary.failed >= 1, "the broken row should be reported");
    assert.ok(r.outcomes.length === r.summary.sourceRows, "and every other row still processed");
  });

  it("refuses the whole file when the mapping cannot work, before reading rows", () => {
    const r = importBusinessCsv({ text: "business,telephone\nAcme,123", profileName: "outscraper-google-maps", now, ledger: createEvidenceLedger({ now }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outcomes.length, 0, "nothing should be imported from an unmappable file");
  });

  it("requires an evidence ledger; provenance is not optional", () => {
    assert.throws(() => importBusinessCsv({ text: "name,phone\nA,1", profileName: "manual-csv", now }), /ledger/i);
  });
});

// ---------------------------------------------------------------------------

describe("the import path cannot contact anybody", () => {
  const MODULES = ["acquisition-import.js", "acquisition-import-profiles.js", "acquisition-csv.js", "acquisition-classify.js"];
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");

  it("imports no network or provider client", () => {
    for (const f of MODULES) {
      const src = read(f);
      for (const pattern of [/require\(["'](https?|node:https?|axios|node-fetch|twilio|retell-sdk|@retell|nodemailer)["']\)/, /\bfetch\s*\(/, /XMLHttpRequest/]) {
        assert.ok(!pattern.test(src), `${f} must not contain ${pattern}`);
      }
    }
  });

  it("has no call, SMS or email surface", () => {
    for (const f of MODULES) {
      const src = read(f);
      for (const pattern of [/messages\.create\s*\(/, /calls\.create\s*\(/, /\bplaceCall\s*\(/, /\bsendSms\s*\(/, /\bsendEmail\s*\(/, /\bdial\s*\(/]) {
        assert.ok(!pattern.test(src), `${f} must not contain ${pattern}`);
      }
    }
  });

  /**
   * A website column is a STRING. It is normalised and compared; it is never
   * visited. This is what keeps "we imported a directory export" from quietly
   * becoming "we crawled the web".
   */
  it("never visits the website column it reads", () => {
    const src = read("acquisition-import.js") + read("acquisition-import-profiles.js");
    // Aimed at HTTP clients specifically. A bare `.get(` would also match
    // `Map.prototype.get`, which is used for in-file duplicate detection and
    // reaches nothing.
    for (const pattern of [/https?\.(get|request)\s*\(/, /axios\./, /\bfetch\s*\(/, /\.open\s*\(\s*["'](GET|POST)/]) {
      assert.ok(!pattern.test(src), `a website is data here, not an endpoint: ${pattern}`);
    }
    assert.ok(/new URL\(/.test(src), "URLs are parsed for comparison, which is the only thing done with them");
  });

  it("writes nothing to disk and reads no file itself", () => {
    for (const f of MODULES) {
      const src = read(f);
      assert.ok(!/require\(["']node:fs["']\)|require\(["']fs["']\)/.test(src), `${f} should be handed text, not open files`);
    }
  });

  it("registers no network-capable discovery adapter", () => {
    const { EXTERNAL_ACCESS_SUPPORTED } = require("../src/config/acquisition");
    assert.strictEqual(EXTERNAL_ACCESS_SUPPORTED, false, "the offline boundary must remain shut");
  });

  it("persists no secret or token into evidence", () => {
    const ledger = createEvidenceLedger({ now });
    const r = runImport({ ledger });
    const imported = r.outcomes.find((o) => o.status === IMPORT_OUTCOMES.IMPORTED);
    const blob = JSON.stringify(ledger.forProspect(imported.prospectId));
    for (const pattern of [/sk-ant-/, /eyJhbGciOi/, /SUPABASE_SERVICE_KEY/i, /api[_-]?key/i, /bearer /i]) {
      assert.ok(!pattern.test(blob), `evidence must not carry ${pattern}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the founder-facing command is dry-run by construction", () => {
  const CLI = path.join(__dirname, "..", "scripts", "acquisition-import.js");
  const WALK = path.join(__dirname, "..", "scripts", "acquisition-m8f-walkthrough.js");
  const cliSrc = fs.readFileSync(CLI, "utf8");
  const walkSrc = fs.readFileSync(WALK, "utf8");

  /**
   * NOT "the write flag defaults to off" — there is no write flag. A default
   * can be overridden by whoever is in a hurry; an absent capability cannot.
   */
  it("has no write, commit or apply mode", () => {
    for (const flag of ["--write", "--commit", "--apply", "--live", "--execute"]) {
      assert.ok(!new RegExp(`["']${flag}["']`).test(cliSrc), `the CLI must not accept ${flag}`);
    }
  });

  it("cannot persist anything", () => {
    for (const pattern of [/writeFileSync|appendFileSync|createWriteStream/, /require\(["']@supabase/, /acquisition-store/, /acquisition-durable/]) {
      assert.ok(!pattern.test(cliSrc), `the CLI must not be able to persist: ${pattern}`);
    }
  });

  it("cannot reach a network or a provider", () => {
    for (const src of [cliSrc, walkSrc]) {
      for (const pattern of [/require\(["'](https?|node:https?|axios|node-fetch|twilio|retell-sdk|nodemailer)["']\)/, /\bfetch\s*\(/, /messages\.create/, /calls\.create/]) {
        assert.ok(!pattern.test(src), `no network or provider: ${pattern}`);
      }
    }
  });

  it("reads a file and nothing else", () => {
    assert.ok(/readFileSync/.test(cliSrc), "reading the CSV is the only I/O it needs");
    assert.ok(!/process\.env\.[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)/.test(cliSrc), "it should never touch a credential");
  });

  it("names the profiles explicitly rather than guessing", () => {
    assert.ok(/--source/.test(cliSrc));
    assert.ok(/listImportProfiles/.test(cliSrc), "the choice must come from the profile registry");
  });

  it("the walkthrough imports no store and writes nothing", () => {
    for (const pattern of [/acquisition-store/, /acquisition-durable/, /writeFileSync|appendFileSync/]) {
      assert.ok(!pattern.test(walkSrc), `the walkthrough must stay in memory: ${pattern}`);
    }
  });
});
