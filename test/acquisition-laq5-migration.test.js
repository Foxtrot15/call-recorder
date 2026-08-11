// LOCKSMITH ACQUISITION E-7B1 — static proofs about the LAQ5 migration.
//
// Nothing here connects to a database. These are assertions about the TEXT of
// supabase/sql/laq5_create_dispatch_authority.sql, and they exist because the
// two partial unique indexes in that file are load-bearing safety constraints:
// if either one is deleted, weakened, or has its predicate changed, the durable
// guarantee is gone and the application's claim becomes a lie that no unit test
// touching JavaScript would notice.
//
// The same pattern as test/acquisition-laq2-migration.test.js.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SQL_PATH = path.join(__dirname, "..", "supabase", "sql", "laq5_create_dispatch_authority.sql");
const VERIFY_PATH = path.join(__dirname, "..", "supabase", "sql", "verification", "12_laq5_verify.sql");
const sql = fs.readFileSync(SQL_PATH, "utf8");
const verify = fs.readFileSync(VERIFY_PATH, "utf8");

/** Statements only — the migration explains itself at length in comments. */
const statements = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("LAQ5 is shaped like every other acquisition migration", () => {
  it("is one transaction", () => {
    assert.match(statements, /^\s*begin;/m);
    assert.match(statements, /^commit;/m);
    assert.strictEqual((statements.match(/^\s*begin;/gm) || []).length, 1);
    assert.strictEqual((statements.match(/^commit;/gm) || []).length, 1);
  });

  it("declares it has not been applied anywhere", () => {
    assert.match(sql, /NOT APPLIED TO DEV/);
    assert.match(sql, /NOT APPLIED TO PRODUCTION/);
  });

  it("is ASCII only, so no editor can mangle it", () => {
    const offenders = sql.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /[^\x00-\x7F]/.test(l));
    assert.deepStrictEqual(offenders, [], `non-ASCII on lines: ${offenders.map(([n]) => n).join(", ")}`);
  });

  it("carries a rollback section and verification pointers", () => {
    assert.match(sql, /ROLLBACK/);
    assert.match(sql, /12_laq5_verify\.sql/);
    assert.match(sql, /drop table\s+if exists public\.acquisition_dial_executions/);
    assert.match(sql, /drop table\s+if exists public\.acquisition_calling_state/);
  });

  it("does not drop the shared mutation guard four other tables depend on", () => {
    assert.ok(!/drop function[^\n]*acquisition_refuse_mutation/.test(statements));
    assert.match(sql, /Do NOT drop public\.acquisition_refuse_mutation/);
  });

  it("alters no existing table and rewrites no data", () => {
    const alters = statements.match(/alter table[^\n;]*/gi) || [];
    for (const a of alters) {
      assert.match(a, /acquisition_(dial_executions|calling_state)/, `LAQ5 must not alter: ${a}`);
      assert.match(a, /enable row level security/i, `the only ALTER permitted is RLS: ${a}`);
    }
    assert.ok(!/\bupdate\s+public\./i.test(statements), "no data rewrite");
    assert.ok(!/\bdelete\s+from\b/i.test(statements), "no deletion");
    assert.ok(!/\bdrop table\b/i.test(statements), "no drop inside the transaction");
  });
});

describe("LAQ5 creates the dispatch ledger the design specifies", () => {
  it("dispatch_id is the primary key, and it is a uuid", () => {
    assert.match(statements, /dispatch_id\s+uuid\s+primary key/);
  });

  it("authorisation_id is NOT unique — it legitimately collides", () => {
    assert.match(statements, /authorisation_id\s+text\s+not null/);
    assert.ok(!/authorisation_id[^\n]*unique/i.test(statements), "a unique authorisation_id would refuse a valid second authorisation");
    assert.ok(!/unique[^\n]*\(\s*authorisation_id\s*\)/i.test(statements));
  });

  it("batch_key is NOT NULL", () => {
    assert.match(statements, /batch_key\s+text\s+not null/);
  });

  it("the prospect foreign key RESTRICTS rather than cascades", () => {
    assert.match(statements, /references public\.acquisition_prospects \(prospect_id\)\s*\n?\s*on delete restrict/);
    assert.ok(!/acquisition_dial_executions[\s\S]*?on delete cascade/i.test(statements.slice(statements.indexOf("acquisition_dial_executions"), statements.indexOf("acquisition_calling_state"))));
  });

  it("the destination is a normalised Australian E.164", () => {
    assert.match(statements, /destination_e164\s+text\s+not null\s*\n?\s*check \(destination_e164 ~ '\^\\\+61\[0-9\]\{6,12\}\$'\)/);
  });

  it("provider status and resolution are closed enumerations", () => {
    assert.match(statements, /provider_status[\s\S]{0,120}check \(provider_status in \('pending','submitted','refused','unknown'\)\)/);
    assert.match(statements, /resolution[\s\S]{0,120}check \(resolution in \('outcome_recorded','operator_closed'\)\)/);
  });

  it("a resolution is all of its parts or none of them", () => {
    assert.match(statements, /constraint acq_dial_exec_resolution_complete/);
    assert.match(statements, /resolved_at is null\s+and resolution is null\s+and resolved_by is null/);
  });

  it("a submitted or refused dispatch must say when it reached the provider", () => {
    assert.match(statements, /constraint acq_dial_exec_submission_consistent/);
    assert.match(statements, /provider_status in \('submitted','refused'\) and submitted_at is not null/);
  });
});

/**
 * ── THE TWO ASSERTIONS THAT MATTER MOST IN THIS FILE ─────────────────
 *
 * These indexes ARE the durable guarantee. Everything the application says
 * about cross-process safety is true only because Postgres refuses the second
 * insert. If somebody removes one, or changes its predicate to something a
 * provider result can flip, the application keeps reporting CONFLICT-free
 * success and two workers ring the same phone.
 */
describe("LAQ5's load-bearing safety constraints", () => {
  it("ONE PROSPECT -> AT MOST ONE UNRESOLVED DISPATCH", () => {
    assert.match(
      statements,
      /create unique index if not exists idx_acq_dial_exec_unresolved_prospect\s*\n\s*on public\.acquisition_dial_executions \(prospect_id\)\s*\n\s*where resolved_at is null;/
    );
  });

  it("ONE DESTINATION -> AT MOST ONE UNRESOLVED DISPATCH", () => {
    assert.match(
      statements,
      /create unique index if not exists idx_acq_dial_exec_unresolved_destination\s*\n\s*on public\.acquisition_dial_executions \(destination_e164\)\s*\n\s*where resolved_at is null;/
    );
  });

  it("both predicates are resolved_at, and NOT anything a provider can set", () => {
    const unresolvedIndexes = (statements.match(/create unique index[^;]*idx_acq_dial_exec_unresolved[^;]*;/g) || []);
    assert.strictEqual(unresolvedIndexes.length, 2);
    for (const idx of unresolvedIndexes) {
      assert.match(idx, /where resolved_at is null/, "the predicate must be the business resolution");
      for (const forbidden of ["completed_at", "provider_status", "submitted_at", "released_at", "error_code"]) {
        assert.ok(!idx.includes(forbidden), `a lock predicated on ${forbidden} would be released by the provider`);
      }
    }
  });

  it("the design's reason for both is recorded in the migration itself", () => {
    assert.match(sql, /WHY TWO LOCKS AND NOT ONE/);
    assert.match(sql, /WHY resolved_at AND NOT completed_at/);
    assert.match(sql, /PROVIDER COMPLETION IS NOT RESOLUTION/);
  });
});

describe("LAQ5's mutation guards", () => {
  it("identity is immutable after insert", () => {
    const guard = statements.slice(statements.indexOf("acquisition_dial_exec_guard()"));
    for (const col of ["dispatch_id", "authorisation_id", "prospect_id", "destination_e164", "batch_key", "authorised_at", "claimed_at", "claimed_by"]) {
      assert.match(guard, new RegExp(`new\\.${col}\\s+is distinct from old\\.${col}`), `${col} must be immutable`);
    }
    assert.match(guard, /identity is immutable/);
  });

  it("dispatch rows cannot be deleted", () => {
    assert.match(statements, /tg_op = 'DELETE'[\s\S]{0,200}acquisition_dial_executions is not deletable/);
  });

  it("a resolved dispatch cannot be reopened, and provider status is forward-only", () => {
    assert.match(statements, /old\.resolved_at is not null[\s\S]{0,160}cannot be reopened/);
    assert.match(statements, /old\.provider_status <> 'pending'[\s\S]{0,200}already terminal/);
  });

  it("both guards are BEFORE UPDATE OR DELETE, for each row", () => {
    for (const t of ["acq_dial_exec_guard", "acq_calling_state_guard"]) {
      assert.match(statements, new RegExp(`create trigger ${t}\\s*\\n\\s*before update or delete on public\\.acquisition_\\w+\\s*\\n\\s*for each row execute function`));
    }
  });
});

describe("LAQ5's emergency stop cannot be on by accident", () => {
  it("the singleton key is explicit", () => {
    assert.match(statements, /scope\s+text\s+primary key check \(scope = 'global'\)/);
  });

  it("state is a closed enumeration with NO default", () => {
    assert.match(statements, /state\s+text\s+not null check \(state in \('enabled','paused'\)\)/);
    const stateLine = statements.split("\n").find((l) => /^\s*state\s+text/.test(l));
    assert.ok(!/default/i.test(stateLine), "a defaulted state is how a migration enables calling by accident");
  });

  it("the bootstrap row is PAUSED, and paused is the only state the migration writes", () => {
    assert.match(statements, /insert into public\.acquisition_calling_state[\s\S]{0,200}values \('global', 'paused', 1, 'laq5-migration'/);
    const inserts = statements.match(/insert into public\.acquisition_calling_state[\s\S]*?;/g) || [];
    assert.strictEqual(inserts.length, 1, "exactly one bootstrap insert");
    assert.ok(!/'enabled'/.test(inserts[0]), "THE MIGRATION MUST NEVER WRITE 'enabled'");
  });

  it("the migration as a whole never enables calling", () => {
    assert.ok(!/state\s*=\s*'enabled'/.test(statements), "no statement may set state to enabled");
  });

  it("the state row is attributed and cannot be anonymised or backdated", () => {
    assert.match(statements, /revision\s+integer\s+not null default 1 check \(revision > 0\)/);
    assert.match(statements, /changed_by\s+text\s+not null/);
    assert.match(statements, /reason\s+text\s+not null/);
    assert.match(statements, /new\.revision <> old\.revision \+ 1/);
    assert.match(statements, /must name who made it and why/);
    assert.match(statements, /new\.changed_at := now\(\);/);
  });

  it("the state row cannot be deleted", () => {
    assert.match(statements, /the acquisition calling state row may not be deleted/);
  });
});

describe("LAQ5's security posture matches every other acquisition table", () => {
  it("RLS is enabled for both tables inside the transaction", () => {
    const body = statements.slice(statements.indexOf("begin;"), statements.indexOf("commit;"));
    assert.match(body, /alter table public\.acquisition_dial_executions enable row level security;/);
    assert.match(body, /alter table public\.acquisition_calling_state\s+enable row level security;/);
  });

  it("creates ZERO policies — RLS with no policy denies every non-superuser role", () => {
    assert.ok(!/create policy/i.test(statements), "no policy may be created");
    assert.ok(!/\bto (anon|authenticated|public)\b/i.test(statements), "no client role may be granted anything");
    assert.ok(!/\bgrant\b/i.test(statements), "no grants");
  });
});

describe("LAQ5 reaches nothing and enables nothing", () => {
  it("contains no provider, endpoint, credential or extension", () => {
    for (const forbidden of ["http://", "https://", "twilio", "retell", "api_key", "token", "create extension", "pg_net", "dblink"]) {
      assert.ok(!statements.toLowerCase().includes(forbidden), `LAQ5 must not reference ${forbidden}`);
    }
  });
});

describe("the LAQ5 verification script", () => {
  it("exists and reads both tables", () => {
    assert.match(verify, /acquisition_dial_executions/);
    assert.match(verify, /acquisition_calling_state/);
  });

  it("checks RLS, zero policies, and the two partial unique indexes", () => {
    assert.match(verify, /relrowsecurity/);
    assert.match(verify, /pg_policies/);
    assert.match(verify, /pg_indexes/);
    assert.match(verify, /idx_acq_dial_exec_unresolved_prospect/);
    assert.match(verify, /idx_acq_dial_exec_unresolved_destination/);
  });

  it("proves the point of the migration — provider completion does not release the lock", () => {
    assert.match(verify, /provider_status\s*=\s*'submitted'/);
    assert.match(verify, /STILL 23505|still 23505/);
  });

  it("its writing sections are commented out", () => {
    const live = verify.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    assert.ok(!/\binsert\b/i.test(live), "every insert must be commented out until a human runs it deliberately");
    assert.ok(!/\bupdate\b/i.test(live), "every update must be commented out");
    assert.ok(!/\bdelete\b/i.test(live), "every delete must be commented out");
  });

  /**
   * Checked against every SQL LINE, commented or not — because a commented
   * probe is a line somebody will uncomment and run. Prose about the invariant
   * is fine; a runnable statement carrying the string is not.
   */
  it("not one statement in it can turn calling on, even the commented probes", () => {
    const offenders = verify
      .split("\n")
      .map((l, i) => [i + 1, l.replace(/^\s*--\s?/, "").trim()])
      .filter(([, l]) => /^(insert|update)\b/i.test(l) || /^values\b/i.test(l) || /^\s*set\b/i.test(l))
      .filter(([, l]) => /'enabled'/.test(l));

    assert.deepStrictEqual(offenders, [], `these lines could enable calling if run: ${offenders.map(([n]) => n).join(", ")}`);
  });

  it("states the residue it would create before anybody runs it", () => {
    assert.match(verify, /21/);
    assert.match(verify, /23/);
    assert.match(verify, /acquisition_decisions is UNCHANGED at 4/);
  });
});
