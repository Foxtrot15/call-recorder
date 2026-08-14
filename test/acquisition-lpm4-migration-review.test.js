// LOCKSMITH ACQUISITION E-12I — an independent review of our own migration.
//
// ── WHY REVIEW SOMETHING WE WROTE ───────────────────────────────────
// Because E-12F wrote LPM4 in the same breath as the code that needs it, and a
// migration reviewed only by its author is a migration reviewed by somebody who
// already believes it. The founder asked specifically not to rubber-stamp it.
//
// ── WHAT THE REVIEW FOUND ───────────────────────────────────────────
// One thing worth changing, and one thing worth writing down.
//
// Worth changing: the original DO block matched the purpose constraint with
// `limit 1`. provider_resources carries a dozen CHECK constraints, and a query
// that silently takes the first of several matches is one schema change away
// from dropping the wrong one. It now COUNTS and refuses unless there is
// exactly one, and it no-ops cleanly if already widened.
//
// Worth writing down: LPM3 does not merely omit a foreign key on client_id —
// it DEFERS one, records the exact statement that would add it, and that
// statement carries ON DELETE CASCADE. So the reserved sentinel has a future
// dependency, and the shape of the risk is specific: a real client whose slug
// is 'aida-acquisition', later deleted, would cascade our provisioning record
// away. The preflight checks for that collision; this suite pins that it does.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const LPM4 = "supabase/sql/lpm4_acquisition_provider_resources.sql";
const PREFLIGHT = "supabase/sql/verification/15_lpm4_preflight_readonly.sql";
const VERIFIER = "supabase/sql/verification/16_lpm4_verify_readonly.sql";
const LPM3 = "supabase/sql/lpm3_create_retell_provisioning.sql";

/**
 * Strip SQL comments with a single left-to-right lexer.
 *
 * Deliberately NOT chained regexes: an earlier verifier in this repository
 * stripped `--` inside string literals, orphaned the quotes, and reported
 * phantom writes in later statements. One pass, one state at a time.
 */
function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  let state = "code";
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (state === "code") {
      if (c === "-" && next === "-") { state = "line"; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (c === "'") { state = "single"; out += c; i += 1; continue; }
      if (c === "$" && sql.slice(i, i + 2) === "$$") { state = "dollar"; out += "$$"; i += 2; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") { if (c === "\n") { state = "code"; out += "\n"; } i += 1; continue; }
    if (state === "block") { if (c === "*" && next === "/") { state = "code"; i += 2; continue; } i += 1; continue; }
    if (state === "single") { out += c; if (c === "'" && next === "'") { out += next; i += 2; continue; } if (c === "'" && out.length > 1) { state = "code"; } i += 1; continue; }
    if (state === "dollar") { if (c === "$" && next === "$") { state = "code"; out += "$$"; i += 2; continue; } out += c; i += 1; continue; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. THE SMALLEST SAFE CHANGE
// ---------------------------------------------------------------------------

describe("E-12I: LPM4 is the smallest change that can work", () => {
  const sql = () => stripSqlComments(read(LPM4));

  it("1. it creates no table, index, column or type", () => {
    const s = sql();
    for (const forbidden of [/create\s+table/i, /create\s+(unique\s+)?index/i, /add\s+column/i, /drop\s+column/i, /alter\s+column/i, /create\s+type/i]) {
      assert.ok(!forbidden.test(s), `LPM4 must not ${forbidden}`);
    }
  });

  it("2. it changes no data", () => {
    const s = sql();
    for (const forbidden of [/\binsert\b/i, /\bupdate\b/i, /\bdelete\b/i, /\btruncate\b/i]) {
      assert.ok(!forbidden.test(s), `LPM4 must not ${forbidden}`);
    }
  });

  it("3. it touches exactly one table and one constraint", () => {
    const s = sql();
    const tables = [...s.matchAll(/alter table (?:only )?public\.(\w+)/gi)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(tables)], ["provider_resources"]);
    assert.strictEqual((s.match(/add constraint/gi) || []).length, 1, "one constraint added");
  });

  it("4. the comment scanner has teeth — negative controls", () => {
    // If stripping were wrong, every assertion above would pass vacuously.
    assert.match(stripSqlComments("select 1; -- insert into x\ninsert into y;"), /insert into y/);
    assert.ok(!/insert into x/.test(stripSqlComments("select 1; -- insert into x\n")));
    assert.ok(!/drop table/.test(stripSqlComments("/* drop table z */ select 1;")));
    assert.match(stripSqlComments("select 'a -- b';"), /a -- b/, "a comment marker inside a literal is not a comment");
  });
});

// ---------------------------------------------------------------------------
// 2. IT REFUSES RATHER THAN GUESSES
// ---------------------------------------------------------------------------

describe("E-12I: it will not drop a constraint it is unsure about", () => {
  const s = () => read(LPM4);

  it("5. it counts candidates and refuses if not exactly one", () => {
    assert.match(s(), /con_count = 0 then\s*\n?\s*raise exception/i);
    assert.match(s(), /con_count > 1 then\s*\n?\s*raise exception/i);
    assert.ok(!/limit 1/i.test(stripSqlComments(s())), "no silent first-match — that was the review finding");
  });

  it("6. it discovers the constraint by DEFINITION, not by a guessed name", () => {
    const body = s();
    assert.match(body, /from pg_constraint/);
    assert.match(body, /pg_get_constraintdef\(c\.oid\) like '%purpose%'/);
    assert.match(body, /pg_get_constraintdef\(c\.oid\) like '%onboarding_agent%'/);
    assert.match(body, /execute format\('alter table public\.provider_resources drop constraint %I'/);
  });

  it("7. it is idempotent — a second run is a no-op", () => {
    const body = s();
    assert.match(body, /already widened|already permits/i);
    assert.match(body, /if already then[\s\S]{0,200}return;/i);
  });

  it("8. every original purpose value survives, named individually", () => {
    const body = read(LPM4);
    for (const kept of ["onboarding_agent", "receptionist_agent", "receptionist_knowledge", "receptionist_analysis", "onboarding_analysis", "inbound_binding"]) {
      assert.ok(body.includes(`'${kept}'`), `${kept} must remain permitted`);
    }
    assert.ok(body.includes("'acquisition_agent'"));
    assert.ok(body.includes("'acquisition_response_engine'"));
  });

  it("9. rollback refuses if acquisition rows exist", () => {
    const body = read(LPM4);
    const rollback = body.slice(body.indexOf("-- ROLLBACK"));
    assert.match(rollback, /raise exception/i);
    assert.match(rollback, /acquisition rows exist/i);
  });
});

// ---------------------------------------------------------------------------
// 3. THE ONE-AGENT GUARD IS LPM3'S, NOT OURS
// ---------------------------------------------------------------------------

describe("E-12I: the guard already existed and LPM4 does not touch it", () => {
  it("10. LPM3 defines the partial unique index", () => {
    const lpm3 = read(LPM3);
    assert.match(lpm3, /create unique index if not exists pr_one_active_per_purpose/);
    assert.match(lpm3, /on public\.provider_resources \(client_id, provider, purpose, resource_type\)/);
    assert.match(lpm3, /where active = true/);
  });

  it("11. the index semantics genuinely allow only ONE active acquisition agent", () => {
    // (client_id, provider, purpose, resource_type) WHERE active — with
    // acquisition pinned to one client sentinel, one provider, one purpose and
    // one resource type, the tuple is constant, so at most one row can be
    // active. That is the whole argument, and it depends on all four being
    // fixed, which the authority module is asserted to do below.
    const authority = require("../src/services/acquisition-resource-authority");
    assert.strictEqual(authority.ACQUISITION_CLIENT_ID, "aida-acquisition");
    assert.strictEqual(authority.ACQUISITION_PROVIDER, "retell");
    assert.strictEqual(authority.AGENT_PURPOSE, "acquisition_agent");
    assert.strictEqual(authority.AGENT_RESOURCE_TYPE, "voice_agent");
  });

  it("12. LPM4 does not create, drop or alter that index", () => {
    const s = stripSqlComments(read(LPM4));
    assert.ok(!/pr_one_active_per_purpose/.test(s), "LPM4 leaves the guard entirely alone");
  });
});

// ---------------------------------------------------------------------------
// 4. THE SENTINEL, AND ITS ONE FUTURE DEPENDENCY
// ---------------------------------------------------------------------------

describe("E-12I: the reserved client_id, reviewed rather than assumed", () => {
  it("13. there is no foreign key on client_id today", () => {
    const lpm3 = stripSqlComments(read(LPM3));
    assert.ok(!/add constraint pr_client_fk/i.test(lpm3), "the FK is commented out, not applied");
  });

  it("14. but LPM3 DEFERS one, with ON DELETE CASCADE — and LPM4 says so", () => {
    // The finding that matters. An omitted FK and a deferred FK are different
    // futures, and the second one has teeth.
    const lpm3 = read(LPM3);
    assert.match(lpm3, /Foreign keys to `clients` \(deliberately deferred\)/);
    assert.match(lpm3, /pr_client_fk foreign key \(client_id\) references public\.clients\(slug\) on delete cascade/);

    const lpm4 = read(LPM4);
    assert.match(lpm4, /IF pr_client_fk is ever\s*\n?-- added/i);
    assert.match(lpm4, /on delete cascade/i, "the cascade risk is stated, not left implicit");
  });

  it("15. nothing in the codebase joins provider_resources.client_id to clients", () => {
    const offenders = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!/\.(js|sql)$/.test(e.name)) continue;
        const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
        if (/provider_resources/.test(body) && /join\s+(public\.)?clients/i.test(body)) offenders.push(rel);
      }
    };
    for (const d of ["src", "scripts"]) walk(d);
    assert.deepStrictEqual(offenders, [], "no dashboard or query depends on the sentinel resolving to a tenant");
  });

  it("16. the sentinel is unmistakably not a locksmith's slug", () => {
    const { ACQUISITION_CLIENT_ID } = require("../src/services/acquisition-resource-authority");
    assert.strictEqual(ACQUISITION_CLIENT_ID, "aida-acquisition");
    // Not the operator tenant, not a demo, not empty.
    for (const real of ["default", "demo-locksmith", "", "client", "test"]) {
      assert.notStrictEqual(ACQUISITION_CLIENT_ID, real);
    }
    assert.match(ACQUISITION_CLIENT_ID, /^aida-/, "namespaced to us, not to a customer");
  });

  it("17. the preflight checks for a colliding real client", () => {
    const pre = read(PREFLIGHT);
    assert.match(pre, /reserved slug collision/);
    assert.match(pre, /from public\.clients[\s\S]{0,80}where slug = 'aida-acquisition'/);
  });

  it("18. and the verifier re-checks it afterwards", () => {
    assert.match(read(VERIFIER), /reserved slug collision/);
  });
});

// ---------------------------------------------------------------------------
// 5. THE PREFLIGHT AND VERIFIER ARE READ-ONLY
// ---------------------------------------------------------------------------

describe("E-12I: the review scripts cannot change anything", () => {
  for (const [name, rel] of [["preflight", PREFLIGHT], ["verifier", VERIFIER]]) {
    it(`19/20. the ${name} contains no write or DDL`, () => {
      const s = stripSqlComments(read(rel));
      for (const forbidden of [/\binsert\b/i, /\bupdate\b/i, /\bdelete\b/i, /\btruncate\b/i, /\bcreate\b/i, /\bdrop\b/i, /\balter\b/i, /\bgrant\b/i, /\brevoke\b/i]) {
        assert.ok(!forbidden.test(s), `${rel} matches ${forbidden}`);
      }
      // And it does something — an empty file would pass the above trivially.
      assert.ok((s.match(/\bselect\b/gi) || []).length >= 5, "it actually checks things");
    });
  }

  it("21. the verifier asserts every original purpose value individually", () => {
    const v = read(VERIFIER);
    for (const kept of ["onboarding_agent", "receptionist_agent", "receptionist_knowledge", "receptionist_analysis", "onboarding_analysis", "inbound_binding"]) {
      assert.ok(v.includes(`('${kept}')`), `${kept} must be verified by name — a lost value breaks another product`);
    }
  });

  it("22. the verifier proves nothing else moved", () => {
    const v = read(VERIFIER);
    assert.match(v, /pr_idempotency_key/);
    assert.match(v, /pr_superseded_consistency/);
    assert.match(v, /pr_one_active_per_purpose/);
    assert.match(v, /rls enabled/i);
    assert.match(v, /policy count/i);
  });

  it("23. and that LPM4 created no row", () => {
    assert.match(read(VERIFIER), /LPM4 creates no row/);
  });
});

// ---------------------------------------------------------------------------
// 6. NOTHING IN THE REPOSITORY CAN APPLY IT
// ---------------------------------------------------------------------------

describe("E-12I: LPM4 stays unapplied because nothing can apply it", () => {
  it("24. no executable code reads or runs a .sql file", () => {
    const offenders = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!e.name.endsWith(".js")) continue;
        const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
        if (/readFileSync\([^)]*\.sql|require\([^)]*\.sql|execSql|exec_sql/.test(body)) offenders.push(rel);
      }
    };
    for (const d of ["src", "scripts"]) walk(d);
    assert.deepStrictEqual(offenders, [], "nothing may apply SQL at runtime");
  });

  it("25. LPM4 is named in an error message and nowhere else", () => {
    const authority = read("src/services/acquisition-resource-authority.js");
    assert.match(authority, /REQUIRED_MIGRATION = "supabase\/sql\/lpm4_acquisition_provider_resources\.sql"/);
    assert.ok(!/readFileSync|require\(/.test(authority.split("REQUIRED_MIGRATION")[1].split("\n")[0]));
  });

  it("26. the runbook tells the founder to run preflight, apply, then verify", () => {
    const lpm4 = read(LPM4);
    assert.match(lpm4, /15_lpm4_preflight_readonly\.sql FIRST/);
    assert.match(lpm4, /16_lpm4_verify_readonly\.sql AFTER/);
    assert.match(lpm4, /NOT APPLIED/);
  });
});
