// LOCKSMITH ACQUISITION M8B — the LAQ2 migration, as a reviewed artifact.
//
// This does NOT run SQL. Nothing in this repo runs SQL; schema files are
// applied by a human. It reads the file and holds down the properties that a
// later edit could quietly remove — a policy added to an RLS-only table, a
// foreign key added to suppression, a DROP that turns an additive migration
// into a destructive one.
//
// The reason suppression is worth a test at this level: the difference between
// "no foreign key" and "foreign key on delete cascade" is one line, reads like
// an improvement, and turns permanent suppression into suppression that lasts
// until somebody tidies up the prospect table.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SQL_DIR = path.join(__dirname, "..", "supabase", "sql");
const LAQ1 = fs.readFileSync(path.join(SQL_DIR, "laq1_create_acquisition_prospects.sql"), "utf8");
const LAQ2 = fs.readFileSync(path.join(SQL_DIR, "laq2_create_acquisition_queue.sql"), "utf8");

const NEW_TABLES = ["acquisition_suppressions", "acquisition_qualifications", "acquisition_call_queue", "acquisition_contact_outcomes"];

// Strip SQL comments so a rule cannot be "satisfied" by prose describing it.
const statements = LAQ2.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("the migration is additive", () => {
  it("creates its tables idempotently", () => {
    for (const table of NEW_TABLES) {
      assert.ok(statements.includes(`create table if not exists public.${table}`), `${table} is not created idempotently`);
    }
  });

  it("drops no table, column or index", () => {
    for (const destructive of [/\bdrop\s+table\b/i, /\bdrop\s+column\b/i, /\bdrop\s+index\b/i, /\bdrop\s+schema\b/i, /\btruncate\b/i, /\bdelete\s+from\b/i]) {
      assert.ok(!destructive.test(statements), `the migration contains ${destructive}`);
    }
  });

  it("rewrites no existing data", () => {
    assert.ok(!/\bupdate\s+public\./i.test(statements), "an additive migration must not rewrite rows");
    assert.ok(!/\binsert\s+into\s+public\./i.test(statements), "an additive migration must not seed rows");
  });

  it("the only thing it changes on an existing table is widening a CHECK", () => {
    const alters = statements.match(/alter table[\s\S]*?;/gi) || [];
    for (const alter of alters) {
      const touchesExisting = alter.includes("acquisition_prospects");
      if (!touchesExisting) continue;
      assert.ok(/constraint/i.test(alter), `an ALTER on an existing table must only touch a constraint:\n${alter}`);
      assert.ok(/lifecycle/i.test(alter), `the only existing-table change should be the lifecycle CHECK:\n${alter}`);
    }
  });

  it("runs as one transaction", () => {
    assert.ok(/^begin;$/m.test(statements));
    assert.ok(/^commit;$/m.test(statements));
    assert.ok(!/\brollback\b/i.test(statements));
  });

  it("refuses to run if laq1 has not been applied, rather than failing part-way", () => {
    assert.ok(statements.includes("to_regclass('public.acquisition_prospects')"));
    assert.ok(/raise exception/i.test(statements));
  });
});

describe("RLS is on, in the same transaction, with no policies (D8)", () => {
  it("enables row level security on every new table", () => {
    for (const table of NEW_TABLES) {
      assert.ok(new RegExp(`alter table public\\.${table}\\s+enable row level security`).test(statements), `${table} does not enable RLS`);
    }
  });

  it("enables it before the commit, not in a follow-up", () => {
    const commitAt = statements.search(/^commit;$/m);
    for (const table of NEW_TABLES) {
      const rlsAt = statements.search(new RegExp(`alter table public\\.${table}\\s+enable row level security`));
      assert.ok(rlsAt > 0 && rlsAt < commitAt, `${table} enables RLS outside the transaction`);
    }
  });

  it("creates no policy — service_role only, forever", () => {
    assert.ok(!/create\s+policy/i.test(statements), "a policy would open a client-facing read path that must not exist");
  });

  it("adds no client_id column, for the reason laq1 gives", () => {
    // These are Niche Drops' own prospecting records about businesses that are
    // not clients. A client_id would imply a tenant relationship that does not
    // exist and invite a feature that must never exist.
    assert.ok(!/client_id/i.test(statements));
    assert.ok(!/client_id/i.test(LAQ1.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n")));
  });
});

describe("suppression outlives the prospect record", () => {
  const suppressionBlock = statements.slice(
    statements.indexOf("create table if not exists public.acquisition_suppressions"),
    statements.indexOf("create index if not exists idx_acq_suppressions_reason")
  );

  it("has no foreign key to acquisition_prospects", () => {
    // The one-line change that would turn permanent suppression into
    // suppression that lasts until somebody tidies the prospect table.
    assert.ok(suppressionBlock.length > 100, "the suppression block was not found — this test is not checking anything");
    assert.ok(!/references\s+public\.acquisition_prospects/i.test(suppressionBlock), "a foreign key here would let a deleted prospect erase its own opt-out");
    assert.ok(!/on delete cascade/i.test(suppressionBlock));
  });

  it("is keyed on values a re-import reproduces", () => {
    assert.ok(/fingerprint\s+text/.test(suppressionBlock), "the identity fingerprint is what survives a re-import");
    assert.ok(/e164\s+text/.test(suppressionBlock));
  });

  it("refuses a number that was not normalised before storage", () => {
    // Comparing published forms means "(03) 5550 2287" and "03-5550-2287" are
    // different numbers, and the second one gets called.
    assert.ok(/e164\s*~\s*'\^\\\+61\[0-9\]\{6,12\}\$'/.test(suppressionBlock), "the e164 column must constrain to normalised +61 form");
  });

  it("refuses a business-scoped entry with no business identity", () => {
    assert.ok(/acq_suppression_scope_key/.test(suppressionBlock));
    assert.ok(/scope = 'business' and fingerprint is not null/.test(suppressionBlock));
  });

  it("is append-only, enforced by a trigger rather than by withheld grants", () => {
    assert.ok(/create trigger acq_suppressions_no_update/.test(statements));
    assert.ok(/before update or delete on public\.acquisition_suppressions/.test(statements));
  });
});

describe("the queue cannot hand one business to two workers", () => {
  it("enforces one live lease per prospect with a partial unique index", () => {
    // The rule an in-memory Map cannot guarantee: two processes racing both
    // read "no lease", both write one, and two workers call the same locksmith.
    assert.ok(/create unique index if not exists idx_acq_queue_one_live_lease/.test(statements));
    assert.ok(/on public\.acquisition_call_queue \(prospect_id\)\s*\n?\s*where released_at is null/.test(statements));
  });

  it("makes the idempotency key unique, so a retry cannot reserve twice", () => {
    assert.ok(/request_id\s+text unique/.test(statements));
    assert.ok(/lease_token\s+text not null unique/.test(statements));
  });

  it("constrains the reserved number to normalised form", () => {
    const queueBlock = statements.slice(statements.indexOf("create table if not exists public.acquisition_call_queue"));
    assert.ok(/e164\s+text not null check \(e164 ~/.test(queueBlock));
  });

  it("is NOT append-only — a lease is released, and that is derived state", () => {
    assert.ok(!/create trigger acq_queue_no_update/.test(statements));
    assert.ok(!/create trigger acq_qualifications_no_update/.test(statements));
  });
});

describe("outcomes record what happened, permanently", () => {
  it("is append-only", () => {
    assert.ok(/create trigger acq_outcomes_no_update/.test(statements));
  });

  it("records whether we reached the business, not merely whether a phone was answered", () => {
    assert.ok(/reached_the_business boolean not null/.test(statements));
  });

  it("records whether the consequence was actually approved policy", () => {
    // Most cooldown durations are unapproved (A-L6, A-L8). A row that stored
    // only the effect would imply a rule that is not in force.
    assert.ok(/effect_approved\s+boolean not null default false/.test(statements));
  });
});

describe("the vocabulary in SQL matches the vocabulary in code", () => {
  const S = require("../src/services/acquisition-schema");

  // LAQ1 statements, comments stripped, so the two files can be cross-checked
  // against the same code the application runs.
  const laq1 = LAQ1.split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  it("the audit entity types in LAQ1 match AUDIT_ENTITY_TYPES", () => {
    // This is the check that was missing, and D1 walked straight through the
    // gap: M8B added `queue` to the code and nothing compared it to the CHECK
    // constraint, so every queue audit row would have been rejected the moment
    // the decision log was persisted.
    const { AUDIT_ENTITY_TYPES } = require("../src/services/acquisition-audit");
    const from = laq1.indexOf("entity_type         text not null");
    const to = laq1.indexOf("entity_id", from);
    assert.ok(from > 0 && to > from, "the entity_type CHECK was not found — this test is not checking anything");
    const inSql = [...laq1.slice(from, to).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual([...inSql].sort(), [...AUDIT_ENTITY_TYPES].sort(), "the decision log and the database disagree about what a decision can be about");
  });

  it("the audit decisions in LAQ1 match AUDIT_DECISIONS", () => {
    const { AUDIT_DECISIONS } = require("../src/services/acquisition-audit");
    const from = laq1.indexOf("decision            text not null");
    const to = laq1.indexOf("actor               text not null", from);
    assert.ok(from > 0 && to > from);
    const inSql = [...laq1.slice(from, to).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual([...inSql].sort(), [...AUDIT_DECISIONS].sort());
  });

  it("the evidence kinds and capture modes in LAQ1 match the vocabulary", () => {
    const kindFrom = laq1.indexOf("kind                text not null");
    const kindTo = laq1.indexOf("capture_mode", kindFrom);
    const kinds = [...laq1.slice(kindFrom, kindTo).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual([...kinds].sort(), [...S.EVIDENCE_KINDS].sort());

    // capture_mode deliberately OMITS 'live_fetch' — the offline boundary
    // reaching into the schema. That asymmetry is intentional and asserted.
    const modeFrom = laq1.indexOf("capture_mode        text not null");
    const modeTo = laq1.indexOf("value               text not null", modeFrom);
    const modes = [...laq1.slice(modeFrom, modeTo).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(!modes.includes("live_fetch"), "the database must refuse evidence claiming a live fetch");
    assert.deepStrictEqual([...modes].sort(), [...S.CAPTURE_MODES].filter((m) => m !== "live_fetch").sort());
  });

  it("the lifecycle CHECK lists exactly the states the application knows", () => {
    // Boundaries must be SQL, not comment text — comments are stripped above,
    // so slicing to a `-- ──` header silently runs to the end of the file.
    const from = statements.indexOf("acquisition_prospects_lifecycle_check\n  check");
    const to = statements.indexOf("create table if not exists public.acquisition_suppressions");
    assert.ok(from > 0 && to > from, "the lifecycle CHECK block was not found — this test is not checking anything");
    const inSql = [...statements.slice(from, to).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual([...inSql].sort(), [...S.PROSPECT_STATES].sort(), "the database and the state machine disagree about what states exist");
  });

  it("the suppression reasons match", () => {
    const block = statements.slice(statements.indexOf("reason              text not null"), statements.indexOf("scope               text not null"));
    const inSql = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual([...inSql].sort(), [...S.SUPPRESSION_REASONS].sort());
  });

  it("the outcome list matches CALL_OUTCOMES", () => {
    const { CALL_OUTCOMES } = require("../src/services/acquisition-attempt-policy");
    const block = statements.slice(statements.indexOf("outcome             text not null"), statements.indexOf("reached_the_business"));
    const inSql = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual([...inSql].sort(), [...CALL_OUTCOMES].sort());
  });

  it("the qualification tiers and verdicts match", () => {
    const block = statements.slice(statements.indexOf("verdict             text not null"), statements.indexOf("score               integer not null"));
    const inSql = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const verdicts = inSql.filter((v) => S.QUALIFICATION_VERDICTS.includes(v));
    const tiers = inSql.filter((v) => S.QUALIFICATION_TIERS.includes(v));
    assert.deepStrictEqual([...verdicts].sort(), [...S.QUALIFICATION_VERDICTS].sort());
    assert.deepStrictEqual([...tiers].sort(), [...S.QUALIFICATION_TIERS].sort());
  });
});

describe("the file says what it is", () => {
  // M8D applied both migrations to DEV. The invariant this guards is not "no
  // database has ever seen this file" — it is that PRODUCTION has not, and that
  // the file says which is which. A file whose status line has gone stale is
  // how somebody applies a migration twice, or assumes production is done.
  it("states where it has and has not been applied", () => {
    assert.match(LAQ2, /STATUS: APPLIED TO DEV/);
    assert.match(LAQ2, /NOT APPLIED TO PRODUCTION/);
  });

  it("states that it must be applied after laq1", () => {
    assert.match(LAQ2, /laq1_create_acquisition_prospects\.sql has been\s*--\s*applied first/);
  });

  it("carries manual verification steps, since nothing here runs SQL", () => {
    assert.match(LAQ2, /VERIFICATION \(run manually after applying/);
    assert.ok(LAQ2.includes("idx_acq_queue_one_live_lease"), "the verification should prove the lease constraint");
  });

  it("no script in the repo executes it", () => {
    const scripts = fs.readdirSync(path.join(__dirname, "..", "scripts")).filter((f) => f.endsWith(".js"));
    for (const file of scripts) {
      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", file), "utf8");
      assert.ok(!src.includes("laq2_create_acquisition_queue"), `scripts/${file} references the migration file`);
    }
  });
});

// ── M8C: what a delete may and may not take with it ─────────────────

describe("deleting a prospect cannot erase what happened (M8C)", () => {
  it("contact outcomes are RESTRICT, not CASCADE", () => {
    // D2 from the M8C audit. A cascade on an append-only table fires the
    // refuse-mutation trigger and aborts with a baffling error; worse, it makes
    // "they asked us not to call again" deletable by deleting the prospect.
    const block = statements.slice(
      statements.indexOf("create table if not exists public.acquisition_contact_outcomes"),
      statements.indexOf("create index if not exists idx_acq_outcomes_prospect")
    );
    assert.ok(block.length > 100, "the outcomes block was not found");
    assert.ok(/references public\.acquisition_prospects \(prospect_id\) on delete restrict/.test(block), "outcomes must not cascade");
    assert.ok(!/on delete cascade/.test(block));
  });

  it("only genuinely derived state cascades", () => {
    // A lease and a qualification score can be rebuilt from the append-only
    // tables. An outcome and a suppression cannot.
    const cascading = [];
    for (const m of statements.matchAll(/create table if not exists public\.(\w+)([\s\S]*?)\n\);/g)) {
      if (/on delete cascade/.test(m[2])) cascading.push(m[1]);
    }
    assert.deepStrictEqual(cascading.sort(), ["acquisition_call_queue", "acquisition_qualifications"]);
  });

  it("suppression still has no foreign key at all", () => {
    const block = statements.slice(
      statements.indexOf("create table if not exists public.acquisition_suppressions"),
      statements.indexOf("create index if not exists idx_acq_suppressions_fingerprint")
    );
    assert.ok(!/references/.test(block), "a foreign key here would let a deleted prospect erase its own opt-out");
  });
});
