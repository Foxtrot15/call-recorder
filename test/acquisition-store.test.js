// LOCKSMITH ACQUISITION M8C — the store contract, and the safety ratchets.
//
// Two jobs.
//
// First: both implementations must satisfy the same contract. The restart proof
// runs against the in-memory store, so if the Supabase adapter behaved
// differently the proof would be about the wrong thing. The adapter is driven
// here with an injected fake client that records the calls it receives, which
// checks the translation without contacting anything.
//
// Second: the ratchets. These are the assertions whose job is to fail if
// somebody later adds a network call, a scheduler, a way to delete a
// suppression, or a runtime path that applies a migration.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const store = require("../src/services/acquisition-store");
const { createInMemoryAcquisitionStore, createSupabaseAcquisitionStore, assertStoreContract, STORE_METHODS, TABLES } = store;

const AT = "2026-08-07T03:00:00.000Z";
const ROOT = path.join(__dirname, "..");

const SUPPRESSION = Object.freeze({
  reason: "opt_out",
  scope: "business",
  fingerprint: "preston-key-and-safe#preston|vic",
  e164: "+61355502287",
  actor: "Peter Dang",
  actorKind: "human",
  note: "Asked never to be contacted again.",
  suppressedAt: AT,
});

const LEASE = Object.freeze({
  prospectId: "pr_abc",
  e164: "+61355502287",
  workerId: "worker-a",
  leaseToken: "lease_1",
  grantedAt: AT,
  expiresAt: "2026-08-07T03:05:00.000Z",
  requestId: "req-1",
  qualificationScore: 97,
  eligibilitySnapshot: { code: "eligible" },
});

// ── The contract ────────────────────────────────────────────────────

describe("both stores satisfy one contract", () => {
  it("the in-memory store does", () => {
    assert.doesNotThrow(() => assertStoreContract(createInMemoryAcquisitionStore(), "memory"));
  });

  it("the supabase store does — built without ever loading the client", () => {
    // Construction must not require @supabase/supabase-js, or `npm test` stops
    // working on a bare checkout. This test passing IS that guarantee.
    assert.doesNotThrow(() => assertStoreContract(createSupabaseAcquisitionStore({ client: {} }), "supabase"));
  });

  it("a store missing a method is refused at construction, not at 3am", () => {
    const partial = Object.fromEntries(STORE_METHODS.slice(1).map((m) => [m, async () => null]));
    assert.throws(() => assertStoreContract(partial, "partial"), /is missing: listSuppressions/);
  });

  it("a store that can delete a suppression is refused outright", () => {
    // The ratchet that matters most in this file. A store gaining a delete
    // method is a one-line change that reads like housekeeping.
    for (const forbidden of ["deleteSuppression", "removeSuppression", "unsuppress", "clearSuppressions", "purge"]) {
      const bad = { ...createInMemoryAcquisitionStore(), [forbidden]: async () => true };
      assert.throws(() => assertStoreContract(bad, "bad"), /suppression is permanent/, `${forbidden} should have been refused`);
    }
  });

  it("the contract names no delete, drop or truncate operation at all", () => {
    for (const m of STORE_METHODS) {
      assert.ok(!/delete|remove|drop|truncate|clear|purge/i.test(m), `"${m}" is in the contract and should not be`);
    }
  });
});

// ── In-memory behaviour the adapter must match ──────────────────────

describe("the in-memory store", () => {
  it("appends and reads back suppressions", async () => {
    const s = createInMemoryAcquisitionStore();
    assert.deepStrictEqual(await s.listSuppressions(), []);
    await s.appendSuppression(SUPPRESSION);
    const rows = await s.listSuppressions();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].fingerprint, SUPPRESSION.fingerprint);
    assert.strictEqual(rows[0].e164, SUPPRESSION.e164);
  });

  it("acquires a lease once and refuses the second", async () => {
    const s = createInMemoryAcquisitionStore();
    assert.ok(await s.acquireLease(LEASE));
    assert.strictEqual(await s.acquireLease({ ...LEASE, leaseToken: "lease_2", workerId: "worker-b" }), null, "two live leases for one prospect");
  });

  it("allows a fresh lease once the first is released", async () => {
    const s = createInMemoryAcquisitionStore();
    await s.acquireLease(LEASE);
    assert.ok(await s.releaseLease("lease_1", { at: AT }));
    assert.ok(await s.acquireLease({ ...LEASE, leaseToken: "lease_2" }));
  });

  it("releasing an unknown or already-released lease returns null rather than throwing", async () => {
    const s = createInMemoryAcquisitionStore();
    assert.strictEqual(await s.releaseLease("nope", { at: AT }), null);
    await s.acquireLease(LEASE);
    assert.ok(await s.releaseLease("lease_1", { at: AT }));
    assert.strictEqual(await s.releaseLease("lease_1", { at: AT }), null);
  });

  it("lists only genuinely expired leases", async () => {
    const s = createInMemoryAcquisitionStore();
    await s.acquireLease(LEASE);
    assert.strictEqual((await s.listExpiredLeases({ at: "2026-08-07T03:01:00.000Z" })).length, 0);
    assert.strictEqual((await s.listExpiredLeases({ at: "2026-08-07T03:06:00.000Z" })).length, 1);
  });

  it("a snapshot round-trips, which is what the restart proof rests on", async () => {
    const s = createInMemoryAcquisitionStore();
    await s.appendSuppression(SUPPRESSION);
    await s.acquireLease(LEASE);
    await s.appendOutcome({ prospectId: "pr_abc", outcome: "opt_out", reachedTheBusiness: true, recordedAt: AT });

    const rebuilt = createInMemoryAcquisitionStore({ seed: s.snapshot() });
    assert.strictEqual((await rebuilt.listSuppressions()).length, 1);
    assert.strictEqual((await rebuilt.listLiveLeases()).length, 1);
    assert.strictEqual((await rebuilt.listOutcomes({})).length, 1);
  });

  it("returns frozen rows a caller cannot edit under the store", async () => {
    const s = createInMemoryAcquisitionStore();
    await s.appendSuppression(SUPPRESSION);
    const row = (await s.listSuppressions())[0];
    assert.ok(Object.isFrozen(row));
    assert.throws(() => {
      "use strict";
      row.reason = "changed";
    });
  });
});

// ── The Supabase adapter, driven with a fake client ─────────────────

/** Records what was asked of it and returns whatever the test scripted. */
function fakeClient(script = {}) {
  const calls = [];
  const chain = (table) => {
    const state = { table, filters: [], payload: null, op: null };
    const self = {
      select: () => self,
      insert: (payload) => {
        state.op = "insert";
        state.payload = payload;
        return self;
      },
      update: (payload) => {
        state.op = "update";
        state.payload = payload;
        return self;
      },
      eq: (col, val) => {
        state.filters.push(["eq", col, val]);
        return self;
      },
      is: (col, val) => {
        state.filters.push(["is", col, val]);
        return self;
      },
      lte: (col, val) => {
        state.filters.push(["lte", col, val]);
        return self;
      },
      limit: () => self,
      order: () => {
        calls.push(state);
        return Promise.resolve(script[state.table] || { data: [], error: null });
      },
      single: () => {
        calls.push(state);
        return Promise.resolve(script[state.table] || { data: state.payload, error: null });
      },
      maybeSingle: () => {
        calls.push(state);
        return Promise.resolve(script[state.table] || { data: state.payload, error: null });
      },
      then: (resolve) => {
        calls.push(state);
        return Promise.resolve(script[state.table] || { data: [], error: null }).then(resolve);
      },
    };
    return self;
  };
  return { calls, from: (table) => chain(table) };
}

describe("the supabase adapter translates without contacting anything", () => {
  it("writes a suppression to the right table with snake_case columns", async () => {
    const client = fakeClient();
    await createSupabaseAcquisitionStore({ client }).appendSuppression(SUPPRESSION);
    const call = client.calls[0];
    assert.strictEqual(call.table, TABLES.suppressions);
    assert.strictEqual(call.op, "insert");
    assert.strictEqual(call.payload.suppressed_at, AT);
    assert.strictEqual(call.payload.actor_kind, "human");
    assert.strictEqual(call.payload.fingerprint, SUPPRESSION.fingerprint);
  });

  it("defaults actor_kind to system for anything that is not exactly 'human'", async () => {
    const client = fakeClient();
    await createSupabaseAcquisitionStore({ client }).appendSuppression({ ...SUPPRESSION, actorKind: "Human" });
    assert.strictEqual(client.calls[0].payload.actor_kind, "system", "authorisation must not be manufactured by capitalisation");
  });

  it("treats a unique violation on lease acquisition as 'somebody else has it', not an error", async () => {
    const client = fakeClient({ [TABLES.leases]: { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } } });
    assert.strictEqual(await createSupabaseAcquisitionStore({ client }).acquireLease(LEASE), null);
  });

  it("releases only a lease that is still live", async () => {
    const client = fakeClient({ [TABLES.leases]: { data: null, error: null } });
    await createSupabaseAcquisitionStore({ client }).releaseLease("lease_1", { at: AT, reason: "done" });
    const call = client.calls[0];
    assert.strictEqual(call.op, "update");
    assert.ok(call.filters.some(([op, col, val]) => op === "is" && col === "released_at" && val === null), "the release must be conditional on the lease still being live");
  });

  it("asks for expired leases with both conditions, never just one", async () => {
    const client = fakeClient();
    await createSupabaseAcquisitionStore({ client }).listExpiredLeases({ at: AT });
    const call = client.calls[0];
    assert.ok(call.filters.some(([op, col]) => op === "is" && col === "released_at"));
    assert.ok(call.filters.some(([op, col]) => op === "lte" && col === "expires_at"));
  });

  it("a missing table is a provisioning error naming the migration, not a stack trace", async () => {
    const client = fakeClient({ [TABLES.suppressions]: { data: null, error: { code: "42P01", message: 'relation "acquisition_suppressions" does not exist' } } });
    await assert.rejects(() => createSupabaseAcquisitionStore({ client }).listSuppressions(), (err) => {
      assert.strictEqual(err.code, "acquisition_not_provisioned");
      assert.match(err.message, /laq2_create_acquisition_queue\.sql/);
      assert.match(err.message, /will not create it/);
      return true;
    });
  });

  it("recognises the PostgREST phrasing of a missing table too", () => {
    assert.strictEqual(store.tableMissing({ message: "Could not find the table 'public.acquisition_call_queue' in the schema cache" }), true);
    assert.strictEqual(store.tableMissing({ code: "42P01", message: "" }), true);
    assert.strictEqual(store.tableMissing({ code: "23505", message: "duplicate key" }), false);
    assert.strictEqual(store.tableMissing(null), false);
  });

  it("any other error is surfaced rather than swallowed into an empty result", async () => {
    const client = fakeClient({ [TABLES.suppressions]: { data: null, error: { code: "08006", message: "connection failure" } } });
    await assert.rejects(() => createSupabaseAcquisitionStore({ client }).listSuppressions(), /connection failure/);
    // An empty list here would read as "nobody has opted out".
  });
});

// ── Safety ratchets ─────────────────────────────────────────────────

describe("safety ratchets", () => {
  const M8C_SOURCES = ["src/services/acquisition-store.js", "src/services/acquisition-durable.js"];
  const ALL_ACQUISITION = fs.readdirSync(path.join(ROOT, "src/services")).filter((f) => f.startsWith("acquisition-")).map((f) => `src/services/${f}`);

  it("no acquisition module reaches the network", () => {
    for (const rel of ALL_ACQUISITION) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const forbidden of ["fetch(", "axios", "XMLHttpRequest", 'require("http")', "require('http')", 'require("https")', "node-fetch", "WebSocket"]) {
        assert.ok(!src.includes(forbidden), `${rel} references ${forbidden}`);
      }
    }
  });

  it("no acquisition module invokes a provider", () => {
    for (const rel of ALL_ACQUISITION) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const forbidden of ['require("twilio")', 'require("retell', "@anthropic-ai", "@retellai"]) {
        assert.ok(!src.includes(forbidden), `${rel} imports ${forbidden}`);
      }
    }
  });

  it("no acquisition module can place a call, send an SMS or send an email", () => {
    // Call SHAPES, not bare words: `createCall` also matches
    // `createCallingPolicy`, which is the compliance gate and the opposite of a
    // dialler. A ratchet that cries wolf gets loosened by the next person.
    const forbidden = [/messages\.create\s*\(/, /calls\.create\s*\(/, /\bsendMail\s*\(/, /\bsendEmail\s*\(/, /\bsendSms\s*\(/, /\.dial\s*\(/, /\bcreateCall\s*\(/, /\bplaceCall\s*\(/];
    for (const rel of ALL_ACQUISITION) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(src), `${rel} matches ${pattern}`);
      }
    }
  });

  it("nothing in the repository applies a migration at runtime", () => {
    // The ratchet against a well-meaning "just auto-migrate on boot".
    //
    // Comments are stripped first. Modules legitimately NAME the migration that
    // creates the table they read — acquisition-store.js does it in its
    // provisioning error, which is the most useful thing that error can say.
    // What must not exist is code that opens or executes one.
    const stripComments = (src) =>
      src
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
        .join("\n");

    const forbidden = [/readFileSync\([^)]*\.sql/i, /readFile\([^)]*\.sql/i, /\bexec(ute)?Sql\b/i, /\.rpc\(\s*["']exec/i, /psql\b/i, /migrat(e|ion)\s*\(/i];

    const walk = (d) => {
      for (const entry of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!entry.name.endsWith(".js")) continue;
        const code = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
        for (const pattern of forbidden) {
          assert.ok(!pattern.test(code), `${rel} matches ${pattern} — nothing may apply SQL at runtime`);
        }
      }
    };
    walk("src");
    walk("scripts");
  });

  it("the only .sql paths in executable code are the ones named in error messages", () => {
    // There ARE two, deliberately, and for the same reason: a provisioning
    // error names the migration to apply, which is the most useful thing that
    // error can say. E-12F adds the second — the acquisition provisioning
    // authority, whose insert is rejected by Postgres until LPM4 is applied by
    // hand, and whose error would otherwise leave the reader guessing why.
    //
    // This pins them to exactly those two files, exactly those two literals,
    // and checks that nothing does anything with either except put it in a
    // string. Nothing here opens or executes a .sql file.
    const found = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!entry.name.endsWith(".js")) continue;
        const code = fs
          .readFileSync(path.join(ROOT, rel), "utf8")
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("//"))
          .join("\n");
        for (const m of code.match(/["'][^"']*\.sql["']/g) || []) found.push({ rel, literal: m });
      }
    };
    walk("src");
    walk("scripts");

    assert.deepStrictEqual(
      found.map((f) => f.rel).sort(),
      ["src/services/acquisition-resource-authority.js", "src/services/acquisition-store.js"],
      `unexpected .sql literal in executable code: ${JSON.stringify(found)}`
    );
    assert.deepStrictEqual(
      found.map((f) => f.literal).sort(),
      ['"supabase/sql/laq2_create_acquisition_queue.sql"', '"supabase/sql/lpm4_acquisition_provider_resources.sql"']
    );

    // And each is only ever put into a message — never opened, never run.
    for (const rel of ["src/services/acquisition-store.js", "src/services/acquisition-resource-authority.js"]) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const line of src.split("\n").filter((l) => l.includes("REQUIRED_MIGRATION") && !l.trimStart().startsWith("//"))) {
        assert.ok(
          /=\s*"supabase|Apply \$\{REQUIRED_MIGRATION\}|REQUIRED_MIGRATION,$|=\s*REQUIRED_MIGRATION;$/.test(line.trim()),
          `${rel}: REQUIRED_MIGRATION is used somewhere other than a message or an export: ${line.trim()}`
        );
      }
      assert.ok(!/readFileSync\([^)]*\.sql|require\([^)]*\.sql/.test(src), `${rel} must never open a .sql file`);
    }
  });

  it("package.json has no migrate script", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    for (const name of Object.keys(pkg.scripts || {})) {
      assert.ok(!/migrat|schema|sql/i.test(name), `npm script "${name}" looks like it applies schema`);
    }
  });

  it("the durable layer starts no timer and registers no scheduler", () => {
    for (const rel of M8C_SOURCES) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const forbidden of ["setInterval", "setTimeout", "setImmediate", "cron", "node-schedule", "process.on("]) {
        assert.ok(!src.includes(forbidden), `${rel} references ${forbidden} — the reaper runs when called and never otherwise`);
      }
    }
  });

  it("the supabase client is required lazily, inside functions, never at module top level", () => {
    // The dep-free test convention: `npm test` runs on a bare checkout, so
    // building a store must not pull in @supabase/supabase-js.
    const src = fs.readFileSync(path.join(ROOT, "src/services/acquisition-store.js"), "utf8");
    const topLevel = src.split("\n").filter((l) => /^const .*= require\(/.test(l));
    for (const line of topLevel) {
      assert.ok(!line.includes("./supabase"), `./supabase is required at module top level: ${line}`);
    }
    assert.ok(src.includes('require("./supabase")'), "it should still be reachable lazily");
  });

  it("requiring every acquisition module works with no node_modules present", () => {
    // Proven by the fact that this suite runs at all, but asserted explicitly so
    // the reason is discoverable rather than folklore.
    for (const rel of ALL_ACQUISITION) {
      assert.doesNotThrow(() => require(path.join(ROOT, rel)), `${rel} cannot be required without dependencies installed`);
    }
  });
});
