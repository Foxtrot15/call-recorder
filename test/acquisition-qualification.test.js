// LOCKSMITH ACQUISITION M8B — deterministic locksmith qualification.
//
// The load-bearing properties here are not "does it score things". They are:
// that a score can always be explained, that unknown never helps a prospect,
// that facts and conclusions stay separated, that being a bigger locksmith is
// never a penalty, and that qualification cannot be mistaken for permission.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { qualifyProspect, rankQualified, compareQualifications, describeQualification, SIGNALS, TIE_BREAKERS, INFERENCE_WEIGHT, NEVER_OBSERVABLE, QUALIFICATION_MINIMUM } = require("../src/services/acquisition-qualification");
const { createProspect } = require("../src/services/acquisition-prospect");
const S = require("../src/services/acquisition-schema");

const AT = new Date("2026-08-07T03:00:00.000Z");

function prospect(overrides = {}) {
  const result = createProspect({
    businessName: "Northside Lock & Key",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 1042" }],
    sourceRefs: [{ url: "https://northsidelockandkey.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
    ...overrides,
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  return result.prospect;
}

function evidence(rows) {
  return rows.map((r, i) => ({ evidenceId: `ev_${i}`, capture_mode: "fixture", ...r }));
}

const TRADE_EVIDENCE = evidence([{ kind: "trade_category", value: "Locksmith — emergency lockouts, rekeying, deadlocks" }]);

const qualify = (p, opts = {}) => qualifyProspect(p, { at: AT, ...opts });

// ── The signal table itself ─────────────────────────────────────────

describe("the signal table", () => {
  it("every signal has a unique key, a label, a kind and an explanation", () => {
    const keys = new Set();
    for (const s of SIGNALS) {
      assert.ok(!keys.has(s.key), `duplicate signal key "${s.key}"`);
      keys.add(s.key);
      assert.ok(S.SIGNAL_KINDS.includes(s.kind), `${s.key}: "${s.kind}" is not a signal kind`);
      assert.ok(s.label && s.label.length > 0, `${s.key} has no label`);
      assert.strictEqual(typeof s.describe, "function", `${s.key} cannot explain itself`);
    }
  });

  it("no signal awards negative points — a bigger locksmith is not a worse one", () => {
    // The commercial direction is explicit: a business with more calls may be a
    // BETTER AIDA customer. What we exclude is aggregators and switchboards,
    // which is a separate concept (disqualifiers) and not a size penalty.
    for (const s of SIGNALS) {
      assert.ok(s.points > 0, `${s.key} awards ${s.points} — the table must not contain penalties`);
    }
  });

  it("every inference names the facts it was drawn from, and they all exist", () => {
    const factKeys = new Set(SIGNALS.filter((s) => s.kind === "fact").map((s) => s.key));
    for (const s of SIGNALS.filter((x) => x.kind === "inference")) {
      assert.ok(Array.isArray(s.basis) && s.basis.length > 0, `${s.key} is an inference with no stated basis`);
      for (const b of s.basis) {
        assert.ok(factKeys.has(b), `${s.key} cites "${b}", which is not a fact this table produces`);
      }
    }
  });

  it("an inference is worth less than the same claim observed", () => {
    assert.ok(INFERENCE_WEIGHT < 1, "conclusions must not outweigh observations");
  });

  it("the size-related signals are all positive or absent, never penalties", () => {
    for (const key of ["multiple_published_numbers", "team_size_stated", "broad_service_area", "service_number_published", "likely_multi_technician"]) {
      const s = SIGNALS.find((x) => x.key === key);
      assert.ok(s, `${key} is missing from the table`);
      assert.ok(s.points > 0, `${key} must reward size, not punish it`);
    }
  });
});

// ── Facts vs inferences ─────────────────────────────────────────────

describe("facts and inferences stay separated", () => {
  const a = qualify(prospect(), { evidenceRows: TRADE_EVIDENCE });

  it("reports them in separate lists that together are the whole table", () => {
    assert.strictEqual(a.facts.length + a.inferences.length, a.signals.length);
    assert.ok(a.facts.every((s) => s.kind === "fact"));
    assert.ok(a.inferences.every((s) => s.kind === "inference"));
  });

  it("every inference carries its basis through to the result", () => {
    for (const inf of a.inferences) {
      assert.ok(Array.isArray(inf.basis) && inf.basis.length > 0, `${inf.key} lost its basis`);
    }
  });

  it("no fact claims a basis — a fact is observed, not derived", () => {
    for (const f of a.facts) assert.strictEqual(f.basis, null, `${f.key} is a fact but cites a basis`);
  });

  it("an inference never reads another inference, so the reasoning is one layer deep", () => {
    const inferenceKeys = new Set(SIGNALS.filter((s) => s.kind === "inference").map((s) => s.key));
    for (const s of SIGNALS.filter((x) => x.kind === "inference")) {
      for (const b of s.basis) assert.ok(!inferenceKeys.has(b), `${s.key} is drawn from another inference (${b})`);
    }
  });
});

// ── Unknown is never a positive ─────────────────────────────────────

describe("unknown never helps", () => {
  it("an unknown signal contributes nothing", () => {
    const a = qualify(prospect(), { evidenceRows: TRADE_EVIDENCE });
    for (const s of a.signals.filter((x) => x.status === "unknown")) {
      assert.strictEqual(s.points, 0, `${s.key} is unknown but scored ${s.points}`);
    }
  });

  it("a bare record scores below one we know things about", () => {
    const bare = qualify(prospect({ abn: null, sourceRefs: [{ url: "https://www.yellowpages.com.au/vic/brunswick/x" }] }), { evidenceRows: [] });
    const known = qualify(prospect({ abn: "51 824 753 556" }), { evidenceRows: TRADE_EVIDENCE });
    assert.ok(known.score > bare.score, `${known.score} should beat ${bare.score}`);
  });

  it("names every unknown, so silence is never mistaken for a checked negative", () => {
    const a = qualify(prospect(), { evidenceRows: TRADE_EVIDENCE });
    for (const s of a.signals.filter((x) => x.status === "unknown")) {
      assert.ok(a.unknowns.some((u) => u.key === s.key), `${s.key} is unknown but was not reported as such`);
    }
  });

  it("we never claim to know call volume, however complete the record", () => {
    // The most tempting number to invent, and the one we genuinely cannot see.
    const a = qualify(
      prospect({ abn: "51 824 753 556", phones: [{ raw: "(03) 5550 1042" }, { raw: "1300 555 010" }, { raw: "0491 570 156" }] }),
      { evidenceRows: TRADE_EVIDENCE, declared: { technicianCount: 12, serviceAreaSuburbCount: 30, servicesText: "24/7 emergency lockouts" } }
    );
    assert.strictEqual(a.tier, "priority", "this record should be as strong as they get");
    for (const u of NEVER_OBSERVABLE) {
      assert.ok(a.unknowns.some((x) => x.key === u.key && x.observable === false), `${u.key} must still be reported as never observable`);
    }
    assert.ok(!a.signals.some((s) => /volume|missed_call_rate/.test(s.key)), "there must be no call-volume signal to score");
  });

  it("no service text at all is 'unknown', not 'does not do emergency work'", () => {
    const silent = qualify(prospect({ tradeCategory: null }), { evidenceRows: evidence([{ kind: "business_name", value: "Northside Lock & Key" }]) });
    const emergency = silent.signals.find((s) => s.key === "emergency_service_advertised");
    assert.strictEqual(emergency.status, "unknown");
  });
});

// ── Explainability ──────────────────────────────────────────────────

describe("every score can be explained", () => {
  const a = qualify(prospect({ abn: "51 824 753 556" }), { evidenceRows: TRADE_EVIDENCE });

  it("the score is exactly the sum of the named signals — nothing hidden", () => {
    const sum = a.signals.reduce((t, s) => t + s.points, 0);
    assert.strictEqual(a.score, sum);
  });

  it("every contributing signal says why it fired", () => {
    assert.ok(a.contributing.length > 0);
    for (const s of a.contributing) {
      assert.ok(s.points > 0);
      assert.ok(s.why && s.why.length > 10, `${s.key} does not explain itself`);
    }
  });

  it("answers 'why is this one above that one?' with the signals that differ", () => {
    const strong = qualify(prospect({ abn: "51 824 753 556", tradeCategory: "Locksmith — 24 hour emergency lockouts" }), { evidenceRows: TRADE_EVIDENCE });
    const weak = qualify(prospect({ businessName: "Bayside Locksmiths", suburb: "Brighton", abn: null, sourceRefs: [{ url: "https://www.hotfrog.com.au/company/bayside" }] }), { evidenceRows: [] });

    const why = compareQualifications(strong, weak);
    assert.ok(why, "two visibly different prospects must be separable");
    assert.strictEqual(why.decidedBy, "score");
    assert.match(why.reason, /ranks above/);
    assert.ok(why.differingSignals.length > 0, "it must name which signals differ");
    for (const d of why.differingSignals) {
      assert.notStrictEqual(d.winner, d.loser);
      assert.ok(d.label, `${d.key} has no label`);
    }
  });

  it("the founder-facing description leads with the ruling-out reason when there is one", () => {
    const text = describeQualification(qualify(prospect({ businessName: "Lockyer Valley Plumbing", tradeCategory: "Plumbing" })));
    assert.match(text, /Ruled out/);
    assert.match(text, /plumbing/i);
  });

  it("the description always says what is never visible from outside", () => {
    const text = describeQualification(a);
    assert.match(text, /Never visible from outside/);
  });
});

// ── Disqualifiers ───────────────────────────────────────────────────

describe("hard exclusions", () => {
  it("a business that is not a locksmith is ruled out, not merely scored low", () => {
    const a = qualify(prospect({ businessName: "Keystone Real Estate", tradeCategory: "Real estate" }));
    assert.strictEqual(a.verdict, "disqualified");
    assert.strictEqual(a.tier, "excluded");
    assert.ok(a.disqualifiers.some((d) => d.code === "not_a_locksmith"));
  });

  it("a trade word inside a longer word does not count as a locksmith", () => {
    // "blockbuster" contains "lock". Whole-word matching or this whole gate is
    // decorative.
    const a = qualify(prospect({ businessName: "Blockbuster Video Brunswick", tradeCategory: "Video rental" }));
    assert.ok(a.disqualifiers.some((d) => d.code === "not_a_locksmith"), "substring matching would have let this through");
  });

  it("a lead-resale funnel is ruled out even though it advertises locksmith work convincingly", () => {
    const a = qualify(prospect({ businessName: "Find A Locksmith Melbourne", tradeCategory: "Locksmith", sourceRefs: [{ url: "https://www.find-a-locksmith.example.com/melbourne" }] }), { evidenceRows: TRADE_EVIDENCE });
    assert.strictEqual(a.verdict, "disqualified");
    assert.ok(a.disqualifiers.some((d) => d.code === "lead_generation_page"));
  });

  it("a national switchboard is ruled out, but a large local business is not", () => {
    const switchboard = qualify(
      prospect({ businessName: "National Locksmith Network", suburb: null, phones: [{ raw: "1300 555 020" }], sourceRefs: [{ url: "https://nationallocksmithnetwork.example.com.au" }] }),
      { evidenceRows: evidence([{ kind: "service_area", value: "Australia wide, every state" }, { kind: "trade_category", value: "Locksmith" }]) }
    );
    assert.ok(switchboard.disqualifiers.some((d) => d.code === "national_call_centre"));

    // Same national claim, but there IS a local operation behind it.
    const bigLocal = qualify(
      prospect({ businessName: "Melbourne Metro Locksmiths", suburb: "Richmond", phones: [{ raw: "(03) 5550 8080" }, { raw: "1300 555 021" }] }),
      { evidenceRows: evidence([{ kind: "service_area", value: "Australia wide via partners, Melbourne metro direct" }, { kind: "trade_category", value: "Locksmith" }]) }
    );
    assert.ok(!bigLocal.disqualifiers.some((d) => d.code === "national_call_centre"), "size alone must never be a disqualifier");
  });

  it("a premium-rate-only business is ruled out — dialling it would cost the recipient", () => {
    const a = qualify(prospect({ phones: [{ raw: "1902 555 010" }] }), { evidenceRows: TRADE_EVIDENCE });
    assert.ok(a.disqualifiers.some((d) => d.code === "no_callable_number_kind"));
  });

  it("a prospect outside the served market is excluded with a neutral reason", () => {
    const a = qualify(prospect({ state: "XX" }), { evidenceRows: TRADE_EVIDENCE, market: { states: ["VIC"] } });
    assert.ok(a.disqualifiers.some((d) => d.code === "outside_target_market"));
  });

  it("a disqualified record scores zero tier regardless of how good the rest looks", () => {
    // Everything else about this record is strong: registered, own website, in
    // market, several numbers. None of it overturns the exclusion.
    const a = qualify(
      prospect({
        businessName: "Keystone Real Estate",
        tradeCategory: "Real estate",
        abn: "51 824 753 556",
        phones: [{ raw: "(03) 5550 7777" }, { raw: "1300 555 077" }],
      }),
      { evidenceRows: evidence([{ kind: "operating_status", value: "Trading" }]) }
    );
    assert.strictEqual(a.tier, "excluded");
    assert.strictEqual(a.qualified, false);
    assert.ok(a.score > 0, "it should still have scored — the exclusion is not a zero, it is an override");
  });

  it("trade evidence outranks a misleading trading name", () => {
    // "Keystone" is a name; a captured trade_category row is an observation.
    // The observation wins, and the record is not ruled out.
    const a = qualify(prospect({ businessName: "Keystone Security", tradeCategory: null }), { evidenceRows: TRADE_EVIDENCE });
    assert.ok(!a.disqualifiers.some((d) => d.code === "not_a_locksmith"));
  });

  it("every disqualifier code is one the vocabulary knows, and explains itself", () => {
    const cases = [
      prospect({ businessName: "Keystone Real Estate", tradeCategory: "Real estate" }),
      prospect({ phones: [{ raw: "1902 555 010" }] }),
      prospect({ state: "XX" }),
    ];
    for (const p of cases) {
      for (const d of qualify(p, { market: { states: ["VIC"] } }).disqualifiers) {
        assert.ok(S.DISQUALIFIER_CODES.includes(d.code), `"${d.code}" is not a known disqualifier`);
        assert.strictEqual(d.label, S.DISQUALIFIER_LABELS[d.code]);
        assert.ok(d.why && d.why.length > 10, `${d.code} does not explain itself`);
      }
    }
  });
});

// ── Verdicts ────────────────────────────────────────────────────────

describe("the verdict distinguishes three different failures", () => {
  it("'we cannot tell' is not the same as 'not good enough'", () => {
    const cannotTell = qualify(prospect({ businessName: "Brunswick Trade Services", tradeCategory: null, phones: [] }), { evidenceRows: [] });
    assert.strictEqual(cannotTell.verdict, "disqualified", "no trade evidence at all is a ruling-out");

    // Locksmith, callable, but thin.
    const thin = qualify(prospect({ abn: null, sourceRefs: [{ url: "https://www.yellowpages.com.au/vic/brunswick/x" }] }), { evidenceRows: [] });
    assert.ok(["not_qualified", "qualified"].includes(thin.verdict));
    assert.ok(thin.score < QUALIFICATION_MINIMUM || thin.qualified);
  });

  it("a strong record qualifies and lands in a named tier", () => {
    const a = qualify(prospect({ abn: "51 824 753 556", phones: [{ raw: "(03) 5550 1042" }, { raw: "0491 570 156" }] }), {
      evidenceRows: evidence([
        { kind: "trade_category", value: "Locksmith — 24 hour emergency lockouts and rekeying" },
        { kind: "operating_status", value: "Trading" },
        { kind: "service_area", value: "Brunswick, Coburg, Preston, Northcote, Fitzroy, Carlton" },
      ]),
    });
    assert.strictEqual(a.verdict, "qualified");
    assert.ok(S.QUALIFICATION_TIERS.includes(a.tier));
    assert.ok(["priority", "standard"].includes(a.tier), `expected a strong tier, got ${a.tier}`);
  });

  it("every verdict and tier is one the vocabulary knows", () => {
    for (const p of [prospect(), prospect({ tradeCategory: "Plumbing", businessName: "Ace Plumbing" }), prospect({ phones: [] })]) {
      const a = qualify(p);
      assert.ok(S.QUALIFICATION_VERDICTS.includes(a.verdict));
      assert.ok(S.QUALIFICATION_TIERS.includes(a.tier));
      assert.strictEqual(a.verdictLabel, S.QUALIFICATION_VERDICT_LABELS[a.verdict]);
    }
  });
});

// ── Attestation ─────────────────────────────────────────────────────

describe("operator attestations are marked as such", () => {
  it("a declared technician count is reported as attested, not observed", () => {
    const a = qualify(prospect(), { evidenceRows: TRADE_EVIDENCE, declared: { technicianCount: 12 } });
    const attested = a.attested.find((x) => x.key === "technicianCount");
    assert.ok(attested, "the attestation must be visible in the result");
    assert.strictEqual(attested.value, 12);
    assert.match(attested.source, /attestation/);
  });

  it("no attestation means an unknown, not a zero", () => {
    const a = qualify(prospect(), { evidenceRows: TRADE_EVIDENCE });
    assert.strictEqual(a.signals.find((s) => s.key === "team_size_stated").status, "unknown");
    assert.deepStrictEqual([...a.attested], []);
  });

  it("a sole operator is 'no', not 'unknown' — one technician is a real answer", () => {
    const a = qualify(prospect(), { evidenceRows: TRADE_EVIDENCE, declared: { technicianCount: 1 } });
    assert.strictEqual(a.signals.find((s) => s.key === "team_size_stated").status, "no");
  });

  it("a sole operator still qualifies — AIDA is for them too", () => {
    const sole = qualify(prospect({ abn: "51 824 753 556", phones: [{ raw: "0491 570 156" }] }), {
      evidenceRows: evidence([{ kind: "trade_category", value: "Locksmith — 24 hour emergency lockouts" }, { kind: "operating_status", value: "Trading" }]),
      declared: { technicianCount: 1 },
    });
    assert.strictEqual(sole.verdict, "qualified", describeQualification(sole));
  });
});

// ── Ranking ─────────────────────────────────────────────────────────

describe("ranking is deterministic and explainable", () => {
  const makeSet = () => [
    qualify(prospect({ businessName: "Alpha Locksmiths", suburb: "Carlton", abn: "11 111 111 111" }), { evidenceRows: TRADE_EVIDENCE }),
    qualify(prospect({ businessName: "Bravo Lock & Key", suburb: "Fitzroy" }), { evidenceRows: TRADE_EVIDENCE }),
    qualify(prospect({ businessName: "Charlie Locksmiths", suburb: "Carlton", abn: "33 333 333 333", phones: [{ raw: "(03) 5550 3333" }, { raw: "1300 555 033" }] }), {
      evidenceRows: evidence([{ kind: "trade_category", value: "Locksmith 24/7 emergency" }, { kind: "operating_status", value: "Trading" }]),
    }),
    qualify(prospect({ businessName: "Delta Plumbing", suburb: "Kew", tradeCategory: "Plumbing" })),
  ];

  it("produces the same order regardless of input order", () => {
    const set = makeSet();
    const forward = rankQualified(set).map((a) => a.businessName);
    const backward = rankQualified([...set].reverse()).map((a) => a.businessName);
    const shuffled = rankQualified([set[2], set[0], set[3], set[1]]).map((a) => a.businessName);
    assert.deepStrictEqual(backward, forward);
    assert.deepStrictEqual(shuffled, forward);
  });

  it("puts ruled-out businesses last, whatever they scored", () => {
    const ranked = rankQualified(makeSet());
    assert.strictEqual(ranked[ranked.length - 1].businessName, "Delta Plumbing");
  });

  it("every adjacent pair can say why one is above the other", () => {
    const ranked = rankQualified(makeSet().filter((a) => a.disqualifiers.length === 0));
    for (let i = 0; i + 1 < ranked.length; i += 1) {
      const why = compareQualifications(ranked[i], ranked[i + 1]);
      assert.ok(why, `${ranked[i].businessName} vs ${ranked[i + 1].businessName} is unexplained`);
      assert.strictEqual(why.order, -1, "the ranking and the comparison must agree on direction");
      assert.ok(TIE_BREAKERS.some((t) => t.key === why.decidedBy));
    }
  });

  it("the tie-break chain ends in a key that always separates two records", () => {
    const last = TIE_BREAKERS[TIE_BREAKERS.length - 1];
    assert.strictEqual(last.key, "prospectId", "without a unique final key the sort is not a total order");
  });

  it("two identical assessments are reported as genuinely indistinguishable, not silently ordered", () => {
    const a = qualify(prospect(), { evidenceRows: TRADE_EVIDENCE });
    assert.strictEqual(compareQualifications(a, a), null);
  });

  it("ignores anything that is not a completed assessment", () => {
    assert.deepStrictEqual([...rankQualified(null)], []);
    assert.deepStrictEqual([...rankQualified([null, undefined, { ok: false }])], []);
  });
});

// ── Determinism and safety ──────────────────────────────────────────

describe("the module is deterministic, frozen and offline", () => {
  it("the same input twice produces an identical result", () => {
    const p = prospect({ abn: "51 824 753 556" });
    const a = qualify(p, { evidenceRows: TRADE_EVIDENCE });
    const b = qualify(p, { evidenceRows: TRADE_EVIDENCE });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });

  it("returns a frozen result a caller cannot patch", () => {
    const a = qualify(prospect(), { evidenceRows: TRADE_EVIDENCE });
    assert.ok(Object.isFrozen(a));
    assert.ok(Object.isFrozen(a.signals));
    assert.throws(() => {
      "use strict";
      a.score = 100;
    });
  });

  it("survives malformed input rather than throwing — one bad record must not kill a batch", () => {
    for (const bad of [null, undefined, "a string", 42, []]) {
      const a = qualifyProspect(bad, { at: AT });
      assert.strictEqual(a.ok, false);
      assert.strictEqual(a.qualified, undefined);
      assert.ok(a.disqualifiers.length > 0);
    }
    assert.strictEqual(qualifyProspect(prospect(), { evidenceRows: [null, "x", 7] }).ok, true);
  });

  it("knows nothing about permission — no compliance concept appears in the result", () => {
    // If qualification ever grew a suppression or DNCR field, a future reader
    // would eventually treat a high score as a green light.
    const a = qualify(prospect({ abn: "51 824 753 556" }), { evidenceRows: TRADE_EVIDENCE });
    const json = JSON.stringify(a).toLowerCase();
    for (const forbidden of ["suppress", "dncr", "do not call", "calling window", "holiday", "eligible", "callable now"]) {
      assert.ok(!json.includes(forbidden), `qualification must not mention "${forbidden}" — permission is a different question`);
    }
  });

  it("reaches no network and no provider", () => {
    const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-qualification"), "utf8");
    for (const forbidden of ["require(\"http", "require('http", "fetch(", "axios", "twilio", "retell", "XMLHttpRequest", "https://api."]) {
      assert.ok(!src.includes(forbidden), `the qualification engine must not reference ${forbidden}`);
    }
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      assert.ok(/require\(["']\.\//.test(m) || /node:/.test(m), `${m} is not a local or core require`);
    }
  });
});

// ── Band calibration ────────────────────────────────────────────────

describe("the tier bands divide the population", () => {
  const { TIER_BANDS, SIGNALS: TABLE } = require("../src/services/acquisition-qualification");

  it("the qualification bar is the standard band, not a second number that can drift", () => {
    assert.strictEqual(QUALIFICATION_MINIMUM, TIER_BANDS.find((b) => b.tier === "standard").min);
  });

  it("bands are ordered strongest first and cover every score", () => {
    for (let i = 0; i + 1 < TIER_BANDS.length; i += 1) {
      assert.ok(TIER_BANDS[i].min > TIER_BANDS[i + 1].min, `${TIER_BANDS[i].tier} must sit above ${TIER_BANDS[i + 1].tier}`);
    }
    assert.strictEqual(TIER_BANDS[TIER_BANDS.length - 1].min, -Infinity, "some band must catch every remaining score");
    assert.deepStrictEqual(TIER_BANDS.map((b) => b.tier), [...S.QUALIFICATION_TIERS]);
  });

  it("priority is reachable but not automatic", () => {
    // A band nothing can reach is decoration; a band everything reaches ranks
    // nothing. Both were true of the first draft.
    const max = TABLE.reduce((t, s) => t + Math.round(s.points * (s.kind === "inference" ? INFERENCE_WEIGHT : 1)), 0);
    const priority = TIER_BANDS.find((b) => b.tier === "priority").min;
    assert.ok(priority < max, `priority (${priority}) must be reachable within the table's maximum (${max})`);

    // A solid, ordinary locksmith — website, ABN, register, one landline — must
    // NOT be priority. If it is, priority means nothing.
    const ordinary = qualify(prospect({ abn: "51 824 753 556", tradeCategory: "Locksmith" }), { evidenceRows: evidence([{ kind: "trade_category", value: "Locksmith" }]) });
    assert.ok(ordinary.score < priority, `an ordinary locksmith scored ${ordinary.score}, at or above the priority bar`);
    assert.strictEqual(ordinary.verdict, "qualified", "…but it must still qualify");
  });
});
