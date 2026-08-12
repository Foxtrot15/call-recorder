// E-7B1 — the read-only LAQ5 verification file must STAY read-only.
//
// 12_laq5_verify_readonly.sql exists so that "is the schema right?" can be
// answered against dev or production by anybody, at any time, without a
// decision. That property is only worth having if it is enforced: a single
// helpful INSERT added later to "just fix the bootstrap row" would turn a safe
// file into one that writes to a database, and nothing else would notice.
//
// So this scans the file as SQL rather than trusting its header.
//
// THE SCAN STRIPS COMMENTS AND STRING LITERALS FIRST, and that is not a
// loophole — it is what makes the scan mean anything. The file legitimately
// contains the word DELETE inside the literal '%BEFORE UPDATE OR DELETE%',
// because asserting the guard triggers fire on DELETE requires naming it. A
// scanner that matched raw text would have to be switched off to accept a
// correct file, and a switched-off ratchet protects nothing.
//
// Sections 6 and 7 of the full verification file are absent by construction:
// every statement here must begin with SELECT or WITH, and those sections are
// INSERTs, UPDATEs, a DELETE and two transactions.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "supabase", "sql", "verification", "12_laq5_verify_readonly.sql");

const RAW = fs.readFileSync(FILE, "utf8");

/**
 * A single left-to-right pass, NOT a chain of regexes.
 *
 * The first version of this was three .replace() calls: strip line comments,
 * strip block comments, strip literals. It was wrong, and wrong in the
 * direction that matters — it stripped `--` to end of line even when the `--`
 * was INSIDE a string literal, which truncated the literal, orphaned its
 * closing quote, and left every subsequent literal paired against the wrong
 * partner. The scan then reported forbidden verbs that were only present in
 * blanked-out literal text, and would equally have MISSED a real one.
 *
 * A comment and a literal cannot be recognised independently, because each can
 * contain the other's opener. So this walks the file once and is in exactly one
 * state at a time, which is the only way to get the answer right.
 */
function lexSql(sql) {
  let out = "";
  let cur = "";
  const statements = [];
  const n = sql.length;
  let i = 0;
  let unterminated = false;

  const emit = (s) => { out += s; cur += s; };

  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];

    if (c === "-" && d === "-") {                       // line comment
      while (i < n && sql[i] !== "\n") i += 1;
      emit(" ");
      continue;
    }
    if (c === "/" && d === "*") {                       // block comment
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      emit(" ");
      continue;
    }
    if (c === "'") {                                    // literal, '' escapes
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; closed = true; break; }
        i += 1;
      }
      if (!closed) unterminated = true;
      emit(" <literal> ");
      continue;
    }
    if (c === '"') {                                    // quoted identifier
      i += 1;
      while (i < n && sql[i] !== '"') i += 1;
      i += 1;
      emit(" <ident> ");
      continue;
    }
    if (c === ";") {                                    // statement boundary
      i += 1;
      statements.push(cur.trim());
      cur = "";
      out += ";";
      continue;
    }
    emit(c);
    i += 1;
  }
  if (cur.trim()) statements.push(cur.trim());
  return { sql: out, statements: statements.filter((s) => s.length > 0), unterminated };
}

const { sql: SQL, statements, unterminated } = lexSql(RAW);

// Every verb that writes, changes structure, changes session state, takes a
// lock, or runs something this file cannot see the body of.
const FORBIDDEN = [
  "insert", "update", "delete", "upsert", "merge", "truncate",
  "create", "alter", "drop", "rename", "grant", "revoke",
  "begin", "start", "commit", "rollback", "savepoint",
  "copy", "call", "do", "execute", "prepare",
  "vacuum", "analyze", "reindex", "cluster", "refresh",
  "lock", "notify", "listen", "unlisten",
  "set", "reset", "discard", "comment",
];

test("the read-only LAQ5 verification file", async (t) => {
  await t.test("exists", () => {
    assert.ok(RAW.length > 0);
  });

  await t.test("contains at least one statement", () => {
    assert.ok(statements.length > 0, "no statements found — the file cannot verify anything");
  });

  await t.test("every string literal is terminated", () => {
    assert.equal(unterminated, false, "an unterminated literal means the file does not parse as written");
  });

  await t.test("EVERY statement begins with SELECT or WITH", () => {
    const offenders = statements
      .map((s, i) => ({ i, head: s.slice(0, 60).replace(/\s+/g, " ") }))
      .filter(({ i }) => !/^(select|with)\b/i.test(statements[i]));
    assert.deepEqual(offenders, [], `non-read statements found: ${JSON.stringify(offenders)}`);
  });

  await t.test("contains NO write, DDL or session-changing verb", () => {
    const found = [];
    for (const word of FORBIDDEN) {
      const re = new RegExp(`\\b${word}\\b`, "gi");
      const hits = SQL.match(re);
      if (hits) found.push(`${word} x${hits.length}`);
    }
    assert.deepEqual(found, [], `forbidden SQL verbs present: ${found.join(", ")}`);
  });

  await t.test("opens no transaction", () => {
    assert.equal(/\bbegin\b/i.test(SQL), false);
    assert.equal(/\bcommit\b/i.test(SQL), false);
    assert.equal(/\brollback\b/i.test(SQL), false);
  });

  // The only functions it may call are catalogue readers. Named explicitly:
  // an allowlist that has to be edited is a decision somebody makes on purpose.
  await t.test("calls only read-only catalogue functions", () => {
    const CALLED = RAW.match(/\b(pg_[a-z_]+)\s*\(/g) || [];
    const ALLOWED = new Set([
      "pg_get_constraintdef", "pg_get_indexdef", "pg_get_triggerdef",
      "pg_get_expr", "pg_get_function_result",
    ]);
    const bad = [...new Set(CALLED.map((c) => c.replace(/\s*\($/, "")))]
      .filter((fn) => !ALLOWED.has(fn));
    assert.deepEqual(bad, [], `unexpected pg_ function calls: ${bad.join(", ")}`);
  });

  // The two properties the whole migration rests on. If a later edit drops
  // either assertion, the file still runs, still says PASS, and stops proving
  // the thing worth proving.
  await t.test("still asserts both partial unique index predicates", () => {
    const predicate = /\(resolved_at IS NULL\)/g;
    const hits = RAW.match(predicate) || [];
    assert.ok(hits.length >= 2, `expected the resolved_at predicate asserted at least twice, found ${hits.length}`);
    assert.match(RAW, /idx_acq_dial_exec_unresolved_prospect/);
    assert.match(RAW, /idx_acq_dial_exec_unresolved_destination/);
  });

  await t.test("still asserts the FK restricts deletes", () => {
    assert.match(RAW, /confdeltype/);
    assert.match(RAW, /'r'/);
  });

  // Sections 6 and 7 are identified by the fictional identifiers only they use.
  // Their absence is asserted by name as well as by shape, so that a future
  // paste of one is caught even if it arrives commented out and is later
  // uncommented by somebody who did not read the header.
  await t.test("carries no artefact of sections 6 or 7", () => {
    for (const artefact of [
      "ad_laq5verify", "ba_laq5verify", "ad_bad", "laq5-verify",
      "gen_random_uuid", "must fail", "campaign-x",
    ]) {
      assert.equal(RAW.includes(artefact), false, `section 6/7 artefact present: ${artefact}`);
    }
  });

  // ── NEGATIVE CONTROLS ──────────────────────────────────────────────
  // A scan that passes everything proves nothing. These run the same lexer
  // over deliberately doctored input and assert it reacts — and, just as
  // importantly, that it does NOT react to a write that is only mentioned.
  await t.test("the scan CATCHES an added write", () => {
    const doctored = `${RAW}\ninsert into public.acquisition_calling_state (scope) values ('global');\n`;
    const { sql, statements: st } = lexSql(doctored);
    assert.equal(/\binsert\b/i.test(sql), true, "an appended INSERT was not detected");
    assert.equal(st.some((s) => /^insert\b/i.test(s)), true, "an appended INSERT passed the statement-head check");
  });

  await t.test("the scan CATCHES a write hidden after a literal containing --", () => {
    // The exact shape that defeated the first version of this scanner.
    const doctored = `${RAW}\nselect 'note -- not a comment' as x;\ndelete from public.acquisition_dial_executions;\n`;
    const { sql } = lexSql(doctored);
    assert.equal(/\bdelete\b/i.test(sql), true, "a DELETE after a literal containing -- was not detected");
  });

  await t.test("the scan does NOT flag a write that is only mentioned", () => {
    const commented = `${RAW}\n-- insert into x values (1);\nselect 'update y set z = 1' as prose;\n`;
    const { sql } = lexSql(commented);
    assert.equal(/\binsert\b/i.test(sql), false, "a commented-out INSERT was miscounted as real");
    assert.equal(/\bupdate\b/i.test(sql), false, "an INSERT inside a literal was miscounted as real");
  });

  await t.test("never writes the word that turns calling on", () => {
    // With literals blanked, 'enabled' must not appear as SQL CODE anywhere.
    // In the file it occurs only inside literals (the state CHECK being looked
    // for) and inside the identifier rls_enabled, which carries no word
    // boundary before "enabled" and so cannot match.
    assert.equal(/\benabled\b/i.test(SQL), false, "the word enabled appears outside a literal");
  });
});
