// AIDA PLATFORM P14–P18 — the ratchets for the durable subsystem.
//
// Each one protects a property that would be easy to break and hard to notice,
// and each is paired with a bad fixture proving it still bites. A ratchet
// nobody has watched fail is a ratchet nobody should trust.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MIGRATION = "supabase/sql/acp1_create_client_configuration.sql";

// ════════════════════════════════════════════════════════════════════
// THE MIGRATION IS NOT APPLIED, AND NOTHING CAN APPLY IT
// ════════════════════════════════════════════════════════════════════

describe("ratchet — the ACP1 migration remains unapplied", () => {
  const sql = read(MIGRATION);

  it("says so, unambiguously, in the file itself", () => {
    assert.match(sql, /NOT APPLIED TO DEV/);
    assert.match(sql, /NOT APPLIED TO PRODUCTION/);
    assert.match(sql, /NOT APPLIED ANYWHERE/);
  });

  it("no source file reads, imports or executes the migration", () => {
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith(".js")) out.push(full);
      }
      return out;
    };
    const offenders = [];
    for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))]) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (code.includes("acp1_create_client_configuration")) offenders.push(path.relative(ROOT, file));
    }
    assert.deepEqual(offenders, [], `these files reference the migration: ${offenders.join(", ")}`);
  });

  it("nothing in src or scripts can execute arbitrary SQL", () => {
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith(".js")) out.push(full);
      }
      return out;
    };
    const EXECUTORS = [/\bpg\.Client\b/, /new Client\(\s*\{[^}]*connectionString/, /\.query\(\s*`?\s*(create|alter|drop)\s+table/i];
    const offenders = [];
    for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))]) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (EXECUTORS.some((p) => p.test(code))) offenders.push(path.relative(ROOT, file));
    }
    assert.deepEqual(offenders, [], `these files could run DDL: ${offenders.join(", ")}`);
  });

  it("would CATCH a file that started running the migration", () => {
    const bad = `const sql = fs.readFileSync("supabase/sql/acp1_create_client_configuration.sql");`;
    assert.ok(stripComments(bad).includes("acp1_create_client_configuration"), "the ratchet would not bite");
  });

  it("declares RLS on and zero policies — the service-role posture", () => {
    assert.match(sql, /alter table public\.platform_config_versions enable row level security/);
    assert.match(sql, /alter table public\.platform_config_events\s+enable row level security/);
    // No CREATE POLICY anywhere: a policy is how a browser reaches a table.
    assert.ok(!/create policy/i.test(stripComments(sql)), "ACP1 must declare no policy at all");
  });

  it("has no column that could hold a credential", () => {
    const columns = [...sql.matchAll(/^\s{2}([a-z_]+)\s+(text|uuid|jsonb|integer|boolean|timestamptz)/gm)].map((m) => m[1]);
    assert.ok(columns.length > 20, `expected the column list, found ${columns.length}`);
    for (const c of columns) {
      assert.ok(!/(api_key|secret|token|password|credential|bearer)/i.test(c), `column "${c}" looks like a credential`);
    }
  });

  it("carries the one-active authority as a DATABASE index, not a comment", () => {
    assert.match(sql, /create unique index if not exists pcv_one_active_per_client[\s\S]{0,200}where status = 'active'/);
  });
});

// ════════════════════════════════════════════════════════════════════
// THE VERIFIERS CANNOT EXPLODE ON AN ABSENT TABLE (P36)
// ════════════════════════════════════════════════════════════════════
//
// Both of these were learned the expensive way, on the same milestone.
//
// 'public.x'::regclass RAISES 42P01 when x does not exist. A verifier that
// dies rather than reporting ABSENT tells you nothing about the state you ran
// it to discover — which is exactly what happened the first time verifier 20
// was pasted into the SQL editor.
//
// And the obvious repair is worse than the problem: conrelid IN
// (coalesce(to_regclass(...), 0::oid)) matches every DOMAIN constraint in the
// database, because a domain constraint has conrelid = 0. A census written that
// way returned information_schema's cardinal_number_domain_check as though it
// belonged to platform_config_versions.
//
// `conrelid = to_regclass(...)` is the correct form: NULL equals nothing.

describe("ratchet — committed verifiers degrade rather than erroring", () => {
  const VERIFIERS = [
    "supabase/sql/verification/19_acp1_preflight_readonly.sql",
    "supabase/sql/verification/20_acp1_verify_readonly.sql",
  ];
  // Comments explain WHY these forms are wrong, so they must be stripped or the
  // sweep catches the explanation rather than any executable SQL.
  const sqlCode = (src) => src.replace(/^\s*--[^\n]*$/gm, "");
  const CAST_FORM = /::regclass/;
  // NOT [^)]* — to_regclass('public.x') carries its own parentheses, so a
  // character class excluding ")" stops inside the call it is trying to span
  // and the sweep matches nothing. Bounded any-character is the shape that
  // actually catches the trap.
  const COALESCE_TRAP = /coalesce\([\s\S]{0,80}to_regclass[\s\S]{0,80}0::oid/i;

  it("uses to_regclass(), never a ::regclass cast", () => {
    for (const f of VERIFIERS) {
      assert.ok(!CAST_FORM.test(sqlCode(read(f))),
        `${f} casts to regclass — that raises 42P01 when the relation is absent`);
    }
    // Non-vacuity: they DO look relations up, so the rule is about something.
    assert.match(read(VERIFIERS[1]), /to_regclass\('public\.platform_config_events'\)/);
  });

  it("never matches domain constraints by coalescing a missing oid to zero", () => {
    for (const f of VERIFIERS) {
      const code = sqlCode(read(f));
      if (COALESCE_TRAP.test(code)) {
        assert.match(code, /conrelid <> 0/,
          `${f} coalesces a missing oid to 0 without excluding conrelid = 0 — that matches every DOMAIN constraint`);
      }
      assert.ok(!COALESCE_TRAP.test(code),
        `${f} uses the coalesce-to-zero shape; prefer conrelid = to_regclass(...)`);
    }
  });

  it("would CATCH either mistake", () => {
    const castForm = "where conrelid = 'public.platform_config_events'::regclass";
    const coalesceForm = "where conrelid in (coalesce(to_regclass('public.x')::oid, 0::oid))";
    assert.ok(CAST_FORM.test(castForm), "the cast sweep catches nothing");
    assert.ok(COALESCE_TRAP.test(coalesceForm), "the coalesce sweep catches nothing");
    assert.ok(!/conrelid <> 0/.test(coalesceForm), "the fixture is already guarded and proves nothing");
  });

  it("stays read-only", () => {
    for (const f of VERIFIERS) {
      assert.ok(!/^\s*(insert|update|delete|drop|alter|create|truncate|grant|begin|commit)\b/im.test(read(f)),
        `${f} is not read-only`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// THE MIGRATION'S VOCABULARIES AGREE WITH THE APPLICATION'S (P36)
// ════════════════════════════════════════════════════════════════════
//
// Written after a pre-apply audit found two of them stale. `operator_executor`
// arrived in P24-P28 and reached neither the migration's actor_role CHECK nor
// the fake's copy of it; the fake's event_type list was still the P17 thirteen
// rather than the P24-P28 twenty-nine.
//
// Neither showed up, and the reason is worth stating: the fake AGREED with the
// migration, so the contract suite was green while both disagreed with the
// code. And config-service wraps its audit append in a try/catch, so on a real
// database the effect would not have been a loud failure — it would have been
// silently dropped audit rows, describing the most dangerous actor in the
// system.
//
// So the fake now parses its rules out of the .sql, and this compares that one
// source against the application. Agreeing with the migration is only half of
// being right.

describe("ratchet — ACP1's vocabularies match the code that writes them", () => {
  const fake = require("./helpers/fake-postgres");
  const { BLUEPRINT_STATUSES } = require("../src/platform/client-blueprint");
  const { EVENT_TYPES } = require("../src/platform/config-audit");
  const { ROLES } = require("../src/platform/config-access");
  const sql = read(MIGRATION);

  const same = (label, fromSql, fromCode) =>
    assert.deepEqual([...fromSql].sort(), [...fromCode].sort(),
      `${label}: the migration and the application disagree`);

  it("status matches BLUEPRINT_STATUSES", () => {
    same("status", fake.STATUSES, BLUEPRINT_STATUSES);
  });

  it("event_type matches config-audit's EVENT_TYPES", () => {
    same("event_type", fake.EVENT_TYPES, EVENT_TYPES);
    assert.equal(fake.EVENT_TYPES.length, 29, "the vocabulary changed size — read the diff before changing this number");
  });

  it("actor_role matches every role config-access declares", () => {
    // The audit sink writes principal.role verbatim, so a role the CHECK does
    // not list is a row Postgres refuses.
    same("actor_role", fake.ACTOR_ROLES, Object.keys(ROLES));
    assert.ok(fake.ACTOR_ROLES.includes("operator_executor"),
      "operator_executor holds provisioning:execute — its audit rows are the ones that matter most");
  });

  it("source matches what the services actually record", () => {
    same("source", fake.SOURCES, ["ui", "voice", "api", "import", "operator"]);
  });

  it("would CATCH a role the migration does not know about", () => {
    // The bad fixture: the exact failure this ratchet was written for.
    const stale = ["operator", "client_owner", "client_editor", "client_viewer", "voice_agent", "system", "import"];
    assert.throws(
      () => assert.deepEqual([...stale].sort(), [...Object.keys(ROLES)].sort()),
      /operator_executor|Expected values/,
      "the comparison would not have caught the drift it exists for",
    );
  });

  it("the fake derives its rules from the migration rather than copying them", () => {
    const helper = read("test/helpers/fake-postgres.js");
    assert.match(helper, /vocabularyFor\("status"\)/);
    assert.match(helper, /vocabularyFor\("actor_role"\)/);
    // A hardcoded list beside the parser would be a fifth copy.
    assert.ok(!/const ACTOR_ROLES = \[/.test(helper), "the fake holds its own copy of actor_role again");
    assert.ok(!/const EVENT_TYPES = \[/.test(helper), "the fake holds its own copy of event_type again");
    // And it fails loudly rather than silently returning [] if the SQL moves.
    assert.match(helper, /throw new Error\(`fake-postgres: no CHECK vocabulary found/);
  });
});

// ════════════════════════════════════════════════════════════════════
// A CLIENT CANNOT CHANGE THE PLATFORM'S COMPLIANCE VOCABULARY
// ════════════════════════════════════════════════════════════════════

describe("ratchet — platform vocabularies are not client-configurable", () => {
  const {
    URGENCY_LEVELS, URGENCY_ACTIONS, PRICING_DISCLOSURE, UNCERTAINTY_POLICIES,
    INTEGRATION_CAPABILITIES, CALLER_INFO_FIELDS, MANDATORY_PROHIBITED_CLAIMS,
    RETENTION_PERIODS, BLUEPRINT_STATUSES, validateBlueprint,
  } = require("../src/platform/client-blueprint");
  const { plumberC } = require("../src/platform/fixtures/clients");
  const { PATCHABLE_PREFIXES, FORBIDDEN_PATHS, pathAllowed } = require("../src/platform/config-patch");

  const VOCABULARIES = {
    URGENCY_LEVELS, URGENCY_ACTIONS, PRICING_DISCLOSURE, UNCERTAINTY_POLICIES,
    INTEGRATION_CAPABILITIES, CALLER_INFO_FIELDS, MANDATORY_PROHIBITED_CLAIMS,
    RETENTION_PERIODS, BLUEPRINT_STATUSES,
  };

  it("every vocabulary is frozen, so no caller can extend one at runtime", () => {
    for (const [name, list] of Object.entries(VOCABULARIES)) {
      assert.ok(Object.isFrozen(list), `${name} must be frozen`);
      const before = [...list];
      try { list.push("smuggled_in"); } catch { /* strict hosts throw */ }
      assert.deepEqual([...list], before, `${name} was extended at runtime`);
    }
  });

  it("a blueprint using a value outside a vocabulary is refused, every time", () => {
    const attempts = [
      ["services[0].urgencyCategory", (bp) => { bp.services[0].urgencyCategory = "apocalyptic"; }],
      ["callHandling.urgencyRules[0].action", (bp) => { bp.callHandling.urgencyRules[0].action = "wake_everyone"; }],
      ["knowledge.pricingDisclosure", (bp) => { bp.knowledge.pricingDisclosure = "haggle"; }],
      ["knowledge.uncertaintyPolicy", (bp) => { bp.knowledge.uncertaintyPolicy = "improvise"; }],
      ["compliance.transcriptRetention", (bp) => { bp.compliance.transcriptRetention = "forever_probably"; }],
      ["callHandling.collectAlways[0]", (bp) => { bp.callHandling.collectAlways = ["medicare_number"]; }],
      ["serviceArea.outsideAreaAction", (bp) => { bp.serviceArea.outsideAreaAction = "go_anyway"; }],
    ];
    for (const [pathName, mutate] of attempts) {
      const bp = plumberC();
      mutate(bp);
      const result = validateBlueprint(bp);
      assert.equal(result.ok, false, `${pathName} must be refused`);
    }
  });

  it("no patch path can reach a vocabulary definition", () => {
    for (const attempt of [
      "URGENCY_LEVELS", "MANDATORY_PROHIBITED_CLAIMS", "schemaVersion",
      "metadata", "metadata.status", "identity.clientId", "identity.vertical",
    ]) {
      assert.equal(pathAllowed(attempt), false, `"${attempt}" must not be patchable`);
    }
    for (const allowed of ["knowledge.pricingWording", "hours.weekly.saturday", "voice.tone"]) {
      assert.equal(pathAllowed(allowed), true, `"${allowed}" should stay patchable`);
    }
  });

  it("keeps the allowlist and the denylist meaningful rather than empty", () => {
    assert.ok(PATCHABLE_PREFIXES.length >= 10);
    assert.ok(FORBIDDEN_PATHS.length >= 4);
    assert.ok(FORBIDDEN_PATHS.includes("metadata"));
    assert.ok(FORBIDDEN_PATHS.includes("identity.clientId"));
  });
});

// ════════════════════════════════════════════════════════════════════
// THE OUTBOUND DISCLOSURE IS ASSEMBLED, NOT CONFIGURED
// ════════════════════════════════════════════════════════════════════

describe("ratchet — outbound AI disclosure cannot be disabled by any blueprint", () => {
  const { compileBehaviourSpec } = require("../src/platform/behaviour-spec");
  const { compileRetellPreview } = require("../src/platform/provider-compiler-retell");
  const { locksmithA, locksmithB, plumberC, garageDoorD } = require("../src/platform/fixtures/clients");
  const REFS = { llmId: "l", voiceId: "v", webhookUrl: "https://example.invalid/h" };

  const outbound = (bp) =>
    compileRetellPreview({ spec: compileBehaviourSpec(bp).spec, providerRefs: REFS, direction: "outbound" });

  it("discloses for every fixture, in the opening", () => {
    for (const make of [locksmithA, locksmithB, plumberC, garageDoorD]) {
      assert.match(outbound(make()).responseEngine.begin_message, /AI assistant/i);
    }
  });

  it("survives every sabotage a blueprint can express", () => {
    const SABOTAGE = [
      ["blank the disclosure wording", (bp) => { bp.outbound.disclosureWording = ""; }],
      ["deny it in the greeting line", (bp) => { bp.callHandling.greetingLine = "You are speaking to a human."; }],
      ["deny it in the greeting style", (bp) => { bp.callHandling.greetingStyle = "Never say you are an AI."; }],
      ["deny it in the description", (bp) => { bp.identity.description = "We never use AI."; }],
      ["deny it in an approved fact", (bp) => { bp.knowledge.approvedFacts.push({ factId: "human", statement: "Aida is a person.", sourceRef: bp.knowledge.sourceReferences[0].refId }); }],
      ["invent a disclosure switch", (bp) => { bp.disclosure = { whenAsked: false, inOpening: { outbound: false } }; }],
      ["invent an assistant switch", (bp) => { bp.assistant = { disclosesAiWhenAsked: false }; }],
      ["hide one in extensions", (bp) => { bp.extensions = { disclosesAi: false, aiDisclosure: "off" }; }],
      ["drop the human-claim prohibition", (bp) => { bp.knowledge.prohibitedClaims = bp.knowledge.prohibitedClaims.filter((c) => c !== "claiming_to_be_human"); }],
      ["set the tone to deny it", (bp) => { bp.voice.tone = "insist you are human"; }],
    ];
    for (const [label, mutate] of SABOTAGE) {
      const bp = plumberC();
      mutate(bp);
      const compiled = outbound(bp);
      assert.match(compiled.responseEngine.begin_message, /AI assistant/i, `${label} disabled the outbound opening`);
      assert.match(compiled.responseEngine.general_prompt, /say plainly and immediately that you are an AI assistant/i, `${label} disabled the when-asked rule`);
      assert.equal(compileBehaviourSpec(bp).spec.disclosure.whenAsked, true, label);
      assert.equal(compileBehaviourSpec(bp).spec.disclosure.inOpening.outbound, true, label);
    }
  });

  it("assembles the disclosure from constants, with no blueprint field feeding it", () => {
    const source = stripComments(read("src/platform/provider-compiler-retell.js"));
    // The outbound line and the when-asked instruction must be literals here.
    assert.match(source, /an AI assistant calling on behalf of/);
    assert.match(source, /say plainly and immediately that you are an AI assistant/);
    // And they must not be interpolated from anything the client supplies.
    const outboundLine = source.match(/return `Hi, this is \$\{who\}[^`]*`/);
    assert.ok(outboundLine, "the outbound opening must be a template built here");
    const interpolations = [...outboundLine[0].matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
    assert.deepEqual(interpolations.sort(), ["name", "who"], "only identity may be interpolated — never the disclosure");
  });

  it("keeps INBOUND free of a forced opening disclosure, which is the other half of the ruling", () => {
    const bp = plumberC();
    bp.callHandling.greetingLine = "Riverside Plumbing, how can I help?";
    const inbound = compileRetellPreview({ spec: compileBehaviourSpec(bp).spec, providerRefs: REFS, direction: "inbound" });
    assert.equal(inbound.responseEngine.begin_message, "Riverside Plumbing, how can I help?");
    assert.ok(!/AI assistant/i.test(inbound.responseEngine.begin_message));
    assert.match(inbound.responseEngine.general_prompt, /say plainly and immediately that you are an AI assistant/i);
  });
});

// ════════════════════════════════════════════════════════════════════
// THE FAKE DATABASE IS NOT A REAL ONE
// ════════════════════════════════════════════════════════════════════

describe("ratchet — the test database is in-process and unreachable", () => {
  it("the fake imports nothing that could reach a database", () => {
    // This used to demand zero imports. P36 gave the fake two — node:fs and
    // node:path — so it could parse its constraint vocabularies OUT of the
    // migration instead of keeping a copy that went stale.
    //
    // The rule this ratchet actually protects is "the fake cannot open a
    // connection", so it is now scoped to that rather than relaxed to nothing:
    // an exact allowlist of two builtins that read files, and a refusal of
    // everything else — no client, no transport, no relative import that could
    // pull one in transitively.
    const ALLOWED = ["node:fs", "node:path"];
    const source = read("test/helpers/fake-postgres.js");
    const imports = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

    for (const imported of imports) {
      assert.ok(ALLOWED.includes(imported),
        `the fake imports ${imported}. Only ${ALLOWED.join(" and ")} are permitted, and only to read the migration.`);
    }
    // Relative imports are how a builtin-only rule gets bypassed one file over.
    assert.ok(!imports.some((i) => i.startsWith(".")), "the fake imports a local module, which may import anything");

    // Non-vacuity: it DOES import, so the loop above is examining something.
    assert.ok(imports.length > 0, "if the fake imports nothing this check proves nothing — restore the stricter rule");
    assert.deepEqual([...new Set(imports)].sort(), ALLOWED);
  });

  it("would CATCH a database client added to the fake", () => {
    const ALLOWED = ["node:fs", "node:path"];
    for (const bad of ["@supabase/supabase-js", "pg", "postgres", "node:net", "node:https", "./real-db"]) {
      assert.ok(!ALLOWED.includes(bad), `${bad} would slip past the allowlist`);
    }
  });

  it("no test or platform module imports a real database client", () => {
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith(".js")) out.push(full);
      }
      return out;
    };
    const files = [
      ...walk(path.join(ROOT, "src", "platform")),
      ...walk(path.join(ROOT, "test", "helpers")),
      path.join(ROOT, "test", "platform-store-contract.test.js"),
      path.join(ROOT, "test", "platform-config-service.test.js"),
    ];
    for (const file of files) {
      const imports = [...fs.readFileSync(file, "utf8").matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      for (const bad of ["@supabase/supabase-js", "pg", "postgres", "knex", "sequelize"]) {
        assert.ok(!imports.includes(bad), `${path.relative(ROOT, file)} imports ${bad}`);
      }
    }
  });

  it("the durable adapter takes its database by injection and imports none", () => {
    const source = read("src/platform/blueprint-store-postgres.js");
    const imports = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["./stable-json", "crypto"]);
    assert.ok(!stripComments(source).includes("process.env"), "no environment reading");
  });

  it("would CATCH an adapter that imported a real client", () => {
    const bad = `const { createClient } = require("@supabase/supabase-js");`;
    const imports = [...bad.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.ok(imports.includes("@supabase/supabase-js"), "the ratchet would not bite");
  });
});

// ════════════════════════════════════════════════════════════════════
// THE VOICE PATH CANNOT REACH APPROVAL OR ACTIVATION
// ════════════════════════════════════════════════════════════════════

describe("ratchet — a voice proposal cannot call approve or activate", () => {
  const { ROLES } = require("../src/platform/config-access");

  it("the voice role holds one capability, and it is not approve or activate", () => {
    assert.deepEqual([...ROLES.voice_agent], ["config:propose"]);
    assert.ok(!ROLES.voice_agent.includes("config:approve"));
    assert.ok(!ROLES.voice_agent.includes("config:activate"));
    assert.ok(!ROLES.voice_agent.includes("config:draft"));
  });

  it("config-patch itself exposes nothing that approves or activates", () => {
    const module = require("../src/platform/config-patch");
    for (const name of Object.keys(module)) {
      assert.ok(!/^(approve|activate|publish|golive|deploy)/i.test(name), `config-patch exports "${name}"`);
    }
  });

  it("config-patch imports neither the authority nor the compiler", () => {
    const imports = [...read("src/platform/config-patch.js").matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["./blueprint-diff", "./client-blueprint"]);
  });

  it("every path out of proposeConfigPatch ends at a draft", () => {
    const code = stripComments(read("src/platform/config-patch.js"));
    // It may set status only by asking the authority for a DRAFT.
    assert.ok(!/status:\s*["'](approved|active|validated)["']/.test(code), "config-patch must not set a live status");
    assert.match(code, /requiresHumanApproval: true/);
  });
});
