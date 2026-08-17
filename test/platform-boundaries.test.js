// AIDA PLATFORM P8 — the ratchets.
//
// Everything else in this batch can be argued about. These cannot: they are
// the properties that make the architecture true rather than merely intended,
// and each one would be easy to break and hard to notice.
//
//   1. No vertical branching. A plumber differs from a locksmith by its
//      CONFIGURATION. The moment `if (vertical === "plumber")` appears, the
//      platform has a second locksmith hardcoded in it.
//
//   2. No provider inside the domain. Only the Retell compiler may know what
//      Retell is, and only it may import from it.
//
//   3. No compliance authority in configuration. DNCR, suppression, dial
//      authorisation, the calling stop, dispatch uniqueness, webhook
//      authenticity, lifecycle truth and provider-resource uniqueness are
//      platform-owned. Nothing in src/platform may import them, and no client
//      may configure them.
//
//   4. No transport anywhere in src/platform. Not http, not a Supabase client,
//      not the dial executor. Configuration cannot make a call.
//
// These read source text on purpose. An import that cannot be seen in the file
// is an import that got past review.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PLATFORM_DIR = path.join(__dirname, "..", "src", "platform");

/** Every .js file under src/platform, recursively. */
function platformFiles(dir = PLATFORM_DIR, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) platformFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const FILES = platformFiles();
const rel = (f) => path.relative(path.join(__dirname, ".."), f).replace(/\\/g, "/");
const read = (f) => fs.readFileSync(f, "utf8");

/** Comments carry explanations that legitimately name the things below. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Data is not code. Strings carry prose that legitimately names what code may not do. */
function stripStrings(source) {
  return source
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

const requiresIn = (source) => [...stripComments(source).matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

describe("platform ratchets — the files are actually being checked", () => {
  it("finds every platform module", () => {
    assert.ok(FILES.length >= 8, `expected the platform modules, found ${FILES.length}`);
    for (const expected of [
      "client-blueprint.js",
      "blueprint-authority.js",
      "blueprint-diff.js",
      "config-patch.js",
      "behaviour-spec.js",
      "provider-compiler-retell.js",
      "migrate-locksmith-profile.js",
    ]) {
      assert.ok(FILES.some((f) => f.endsWith(expected)), `${expected} is not being checked`);
    }
  });

  it("strips comments without stripping code", () => {
    const stripped = stripComments('const a = 1; // if (vertical === "plumber")\n/* vertical === "x" */\nconst b = 2;');
    assert.ok(!stripped.includes("plumber"));
    assert.ok(stripped.includes("const a = 1;"));
    assert.ok(stripped.includes("const b = 2;"));
    assert.ok(stripComments('const u = "https://example.invalid/x";').includes("https://example.invalid/x"),
      "a URL in a string must survive, or the transport check below proves nothing");
  });
});

describe("platform ratchets — no vertical branching", () => {
  it("never selects behaviour from a vertical", () => {
    // Scoped to the three ways a vertical could actually STEER something.
    // Reading the field is fine — validating it is exactly what a schema does.
    for (const file of FILES) {
      const code = stripComments(read(file));
      assert.ok(!/vertical\s*[=!]==/.test(code), `${rel(file)} compares vertical to a value`);
      assert.ok(!/switch\s*\(\s*[\w.]*vertical/.test(code), `${rel(file)} switches on vertical`);
      assert.ok(!/\[\s*[\w.]*vertical\s*\]/.test(code), `${rel(file)} looks something up by vertical`);
    }
  });

  it("would catch a vertical branch if one were added", () => {
    // The check above is narrow on purpose, so prove it is not vacuous.
    for (const branch of [
      'if (vertical === "plumber") { x(); }',
      'if (bp.identity.vertical !== "locksmith") return;',
      "switch (vertical) { case 'x': break; }",
      "const rules = BY_TRADE[vertical];",
      "const rules = BY_TRADE[bp.identity.vertical];",
    ]) {
      const caught =
        /vertical\s*[=!]==/.test(branch) ||
        /switch\s*\(\s*[\w.]*vertical/.test(branch) ||
        /\[\s*[\w.]*vertical\s*\]/.test(branch);
      assert.ok(caught, `the ratchet would not catch: ${branch}`);
    }
  });

  it("names no trade in any code literal", () => {
    // Fixtures are configuration DATA — that is the whole point, so they are
    // the one exemption, named rather than pattern-matched.
    const TRADE_WORDS = ["locksmith", "lockout", "plumber", "plumbing", "garage", "electrician", "drain", "rekey"];
    for (const file of FILES) {
      if (rel(file).includes("/fixtures/")) continue;
      // The locksmith migration is BY NAME a legacy adapter for one vertical;
      // it exists precisely so no other module has to know that word.
      if (rel(file).endsWith("migrate-locksmith-profile.js")) continue;

      const code = stripComments(read(file));
      const literals = [...code.matchAll(/["'`]([^"'`\n]*)["'`]/g)].map((m) => m[1]);
      for (const literal of literals) {
        for (const trade of TRADE_WORDS) {
          assert.ok(
            !literal.toLowerCase().includes(trade),
            `${rel(file)} has "${trade}" in the literal ${JSON.stringify(literal)}`,
          );
        }
      }
    }
  });

  it("keeps the one legacy adapter honest about being one", () => {
    // It may name the vertical it converts FROM, but it must not branch on one
    // and must not be imported by any other platform module.
    const file = FILES.find((f) => f.endsWith("migrate-locksmith-profile.js"));
    const code = stripComments(read(file));
    assert.ok(!/vertical\s*[=!]==/.test(code), "even the legacy adapter must not branch on vertical");
    assert.match(code, /vertical = "locksmith"/, "and it must let the caller name the vertical");

    for (const other of FILES) {
      if (other === file) continue;
      assert.ok(
        !requiresIn(read(other)).some((r) => r.includes("migrate-locksmith")),
        `${rel(other)} imports the locksmith adapter — nothing else may depend on one vertical`,
      );
    }
  });
});

/**
 * The layers, declared once and used by every check below.
 *
 *   0  the model            what a business told us
 *   1  authority over it    versions, approval, patches, legacy import
 *   2  behaviour            what the assistant should do — still no vendor
 *   3  the provider         the ONE module allowed to know what Retell is
 *   4  tooling              composes the layers below to show a person the
 *                           result; not domain, and legitimately allowed to
 *                           import the compiler because displaying its output
 *                           is its entire job
 *
 * "The domain" means layers 0-2. Those are the ones a provider must never
 * reach. Adding a file without a layer fails the first test in this block, so
 * a new module cannot quietly escape the rules by not being listed.
 */
const LAYER = Object.freeze({
  "client-blueprint.js": 0,
  "blueprint-diff.js": 0,
  "stable-json.js": 0,
  "config-access.js": 0,
  "config-audit.js": 1,
  "config-service.js": 4,
  "provisioning-model.js": 0,
  "provisioning-execution-contract.js": 0,
  "provisioning-diff.js": 1,
  "provisioning-plan-authority.js": 1,
  "provisioning-readiness.js": 1,
  "store-binding.js": 1,
  "provisioning-desired-state.js": 3,
  "provisioning-service.js": 4,
  "execution-model.js": 0,
  "execution-preflight.js": 1,
  "execution-claim.js": 1,
  "provider-mutation-port.js": 1,
  "resource-registry-writer.js": 1,
  "provisioning-executor.js": 1,
  "reconciliation-engine.js": 1,
  "provision-cli.js": 4,
  "blueprint-authority.js": 1,
  "config-patch.js": 1,
  "migrate-locksmith-profile.js": 1,
  "integrations.js": 1,
  "blueprint-store-postgres.js": 1,
  "behaviour-spec.js": 2,
  "provider-compiler-retell.js": 3,
  "client-cli.js": 4,
  "clients.js": 0, // fixtures: configuration data

  // ── the UI presentation layer (P29-P35) ──
  // Layer 4 for the same reason the CLIs are: it composes the layers below to
  // show a person the result. It is not domain, it decides nothing about a
  // business, and it is legitimately allowed to read the compiler's output
  // because displaying it is the entire job. Nothing at layer 0-2 may import
  // any of these, which the downward rule already enforces.
  "ui-vocabulary.js": 4,
  "ui-diff.js": 4,
  "ui-fields.js": 4,
  "ui-view-models.js": 4,
  // Layer 4 like its neighbours: it is the semantics of a list on a screen —
  // add, remove, reorder, and the identifiers those operations rewrite. It
  // knows nothing about a business and nothing about the DOM.
  "ui-repeatable.js": 4,
});

const DOMAIN_MAX_LAYER = 2;
const layerOf = (file) => LAYER[path.basename(file)];
const isDomain = (file) => layerOf(file) <= DOMAIN_MAX_LAYER;

describe("platform ratchets — every module is placed in a layer", () => {
  it("leaves no file unlayered, so nothing escapes the rules by omission", () => {
    for (const file of FILES) {
      assert.notEqual(layerOf(file), undefined, `${rel(file)} has no declared layer — add one, and mean it`);
    }
  });

  it("points every dependency downward", () => {
    for (const file of FILES) {
      for (const imported of requiresIn(read(file))) {
        if (!imported.startsWith(".")) continue;
        const target = `${path.basename(imported).replace(/\.js$/, "")}.js`;
        if (!(target in LAYER)) continue;
        assert.ok(
          LAYER[target] <= layerOf(file),
          `${path.basename(file)} (layer ${layerOf(file)}) imports ${target} (layer ${LAYER[target]}) — that is upward`,
        );
      }
    }
  });
});

describe("platform ratchets — only one module knows what Retell is", () => {
  const RETELL_COMPILER = "provider-compiler-retell.js";

  /**
   * One declaration in the domain legitimately names vendors, and it names
   * them only to REFUSE them: the blueprint rejects a provider voice id
   * outright. Exempted by its exact declaration rather than by pattern, so any
   * OTHER mention of a provider anywhere still fails.
   */
  const REJECTION_DECLARATION = /const PROVIDER_VOICE_ID_PREFIXES = \/[^\n]*\/i;/;

  /**
   * The second exemption, and the last. `provisioning-model.js` mirrors the
   * `provider` CHECK that provider_resources already declares, so the domain
   * can refuse early what the database would refuse late. It is a vocabulary
   * the schema owns, not a dependency: nothing imports, calls or knows
   * anything about a vendor beyond the string being permitted.
   *
   * Exempted by its exact declaration, like the rejection above, so a provider
   * named on any OTHER line in the domain still fails.
   */
  const SCHEMA_VOCABULARY_DECLARATION =
    /const PROVIDERS = Object\.freeze\(\[[^\]]*\]\);\s*\/\/ mirrors provider_resources CHECK/;

  it("names no provider anywhere in the domain", () => {
    const PROVIDERS = ["retell", "twilio", "11labs", "elevenlabs", "cartesia", "vapi", "bland"];
    for (const file of FILES) {
      if (!isDomain(file)) continue;
      // Exemptions are applied to the RAW source, before comments are
      // stripped: the schema-vocabulary declaration is anchored on its own
      // trailing comment, which stripComments would remove first.
      const code = stripComments(
        read(file).replace(SCHEMA_VOCABULARY_DECLARATION, ""),
      ).replace(REJECTION_DECLARATION, "").toLowerCase();
      for (const provider of PROVIDERS) {
        assert.ok(!code.includes(provider), `${rel(file)} mentions ${provider} in code`);
      }
    }
  });

  it("keeps the schema-vocabulary exemption real, narrow and non-blinding", () => {
    const model = read(FILES.find((f) => f.endsWith("provisioning-model.js")));
    assert.match(model, SCHEMA_VOCABULARY_DECLARATION, "the exempted declaration must exist as written");
    assert.equal(
      model.split("\n").filter((l) => /\/\/ mirrors provider_resources CHECK/.test(l)).length,
      1,
      "the exemption must cover one line, not become a licence",
    );
    // It must mirror what the database ACTUALLY declares, or it is not a mirror.
    const lpm3 = fs.readFileSync(
      path.join(__dirname, "..", "supabase", "sql", "lpm3_create_retell_provisioning.sql"), "utf8",
    );
    assert.match(lpm3, /check \(provider in \('retell','mock','dry_run'\)\)/,
      "the database CHECK this claims to mirror must still say exactly that");
    const { PROVIDERS: mirrored } = require("../src/platform/provisioning-model");
    assert.deepEqual([...mirrored], ["retell", "mock", "dry_run"], "the mirror must match the CHECK");

    // And exempting it must not swallow a second mention.
    const smuggled = `${model}\nconst client = makeRetellClient();`;
    assert.ok(
      stripComments(smuggled.replace(SCHEMA_VOCABULARY_DECLARATION, "")).toLowerCase().includes("retell"),
      "a second mention must survive the exemption",
    );
  });

  it("keeps that one exemption real, and narrow", () => {
    const blueprint = FILES.find((f) => f.endsWith("client-blueprint.js"));
    const code = read(blueprint);
    assert.match(code, REJECTION_DECLARATION, "the exempted declaration must still exist as written");

    // It is a rejection, and it still rejects.
    const { validateBlueprint } = require("../src/platform/client-blueprint");
    const { locksmithA } = require("../src/platform/fixtures/clients");
    const bp = locksmithA();
    bp.voice.profileRef = "retell-sunny";
    assert.ok(validateBlueprint(bp).errors.some((e) => e.path === "voice.profileRef"));

    // And exempting it does not blind the check to a second mention.
    const smuggled = `${code}\nconst client = makeRetellClient();`;
    assert.ok(
      stripComments(smuggled).replace(REJECTION_DECLARATION, "").toLowerCase().includes("retell"),
      "the exemption must not swallow other mentions",
    );
  });

  it("keeps the domain from importing the provider compiler", () => {
    for (const file of FILES) {
      if (!isDomain(file)) continue;
      for (const imported of requiresIn(read(file))) {
        assert.ok(
          !imported.includes("provider-compiler"),
          `${rel(file)} imports a provider compiler — the domain must not depend on one`,
        );
      }
    }
  });

});

describe("platform ratchets — configuration cannot become permission", () => {
  /**
   * The eight authorities the founder named as never client-configurable.
   * Each entry is the module that owns it in the existing codebase.
   */
  const COMPLIANCE_AUTHORITIES = Object.freeze([
    "acquisition-dncr",
    "acquisition-suppression",
    "acquisition-authorisation",
    "acquisition-calling-state",
    "acquisition-calling-approval",
    "acquisition-calling-policy",
    "acquisition-dispatch-store",
    "acquisition-dispatch-resolution",
    "acquisition-dial-execution",
    "acquisition-dial-provider",
    "acquisition-attempt-policy",
    "acquisition-resource-authority",
    "acquisition-agent-provisioning",
    "provider-resource-registry",
  ]);

  it("imports none of them, anywhere in src/platform", () => {
    for (const file of FILES) {
      for (const imported of requiresIn(read(file))) {
        for (const authority of COMPLIANCE_AUTHORITIES) {
          assert.ok(
            !imported.includes(authority),
            `${rel(file)} imports ${authority} — a compliance authority must not be reachable from configuration`,
          );
        }
      }
    }
  });

  it("imports nothing at all from src/services", () => {
    for (const file of FILES) {
      for (const imported of requiresIn(read(file))) {
        assert.ok(
          !imported.includes("services/") && !imported.includes("../services"),
          `${rel(file)} reaches into src/services (${imported}) — the platform domain stands alone`,
        );
      }
    }
  });

  it("has no field, anywhere, that could express permission to call", () => {
    const { emptyBlueprint } = require("../src/platform/client-blueprint");
    const { compileBehaviourSpec } = require("../src/platform/behaviour-spec");
    const { FIXTURE_CLIENTS } = require("../src/platform/fixtures/clients");

    const FORBIDDEN_FIELDS = [
      "callingEnabled", "callingState", "dialAuthorised", "dialAuthorized",
      "authorisation", "authorization", "approvedToCall", "canDial",
      "dncrWashed", "dncrStatus", "suppressed", "suppressionOverride",
      "dispatchId", "webhookVerified", "signatureValid", "providerResourceId",
    ];

    const blueprints = [emptyBlueprint(), ...Object.values(FIXTURE_CLIENTS).map((m) => m())];
    const specs = blueprints.map((bp) => compileBehaviourSpec(bp).spec);

    for (const obj of [...blueprints, ...specs]) {
      const json = JSON.stringify(obj);
      for (const field of FORBIDDEN_FIELDS) {
        assert.ok(!json.includes(`"${field}"`), `"${field}" must not exist in a blueprint or spec`);
      }
    }
  });

  it("exposes no function whose name suggests it could act", () => {
    const MODULES = [
      "client-blueprint", "blueprint-authority", "blueprint-diff",
      "config-patch", "behaviour-spec", "provider-compiler-retell",
      "migrate-locksmith-profile",
    ];
    // Verb forms only: `callTheProvider` is an action, `CALLER_INFO_FIELDS` is
    // a vocabulary. Matching the bare prefix caught the second, which is the
    // ratchet failing on the code it exists to protect.
    const ACTING = /^(dial|call|send|post|provision|deploy|publish|enable|disable|suppress|wash|authorise|authorize|authorisation|authorization)([A-Z]|$)/;
    for (const name of MODULES) {
      const module = require(`../src/platform/${name}`);
      for (const [exported, value] of Object.entries(module)) {
        if (typeof value !== "function") continue; // only a function can act
        assert.ok(!ACTING.test(exported), `${name} exports a function called "${exported}"`);
      }
    }
  });

  it("would catch an acting export if one were added", () => {
    const ACTING = /^(dial|call|send|post|provision|deploy|publish|enable|disable|suppress|wash|authorise|authorize|authorisation|authorization)([A-Z]|$)/;
    for (const bad of ["dialProspect", "sendSms", "provisionAgent", "enableCalling", "authoriseDial", "call", "washDncrList", "suppressClient"]) {
      assert.ok(ACTING.test(bad), `the ratchet would not catch "${bad}"`);
    }
    for (const fine of ["CALLER_INFO_FIELDS", "compileBehaviourSpec", "postcodeOf", "intakeDefaults"]) {
      assert.ok(!ACTING.test(fine), `the ratchet would wrongly reject "${fine}"`);
    }
  });
});

describe("platform ratchets — nothing in src/platform can reach the world", () => {
  it("imports no transport, database or process facility", () => {
    const ALLOWED_NODE_BUILTINS = new Set(["crypto"]);
    const FORBIDDEN = ["http", "https", "net", "tls", "dns", "child_process", "fs", "node-fetch", "axios", "undici", "@supabase/supabase-js", "twilio", "ws"];
    for (const file of FILES) {
      for (const imported of requiresIn(read(file))) {
        if (imported.startsWith(".")) continue;
        const bare = imported.replace(/^node:/, "");
        assert.ok(
          ALLOWED_NODE_BUILTINS.has(bare),
          `${rel(file)} imports "${imported}" — only ${[...ALLOWED_NODE_BUILTINS].join(", ")} is permitted`,
        );
        assert.ok(!FORBIDDEN.includes(bare), `${rel(file)} imports ${imported}`);
      }
    }
  });

  it("calls no global that reaches the network", () => {
    for (const file of FILES) {
      const code = stripComments(read(file));
      for (const global of ["fetch(", "XMLHttpRequest", "WebSocket(", "navigator."]) {
        assert.ok(!code.includes(global), `${rel(file)} calls ${global}`);
      }
    }
  });

  it("reads no environment variable", () => {
    // Configuration that reads env is configuration that behaves differently
    // in production than in a test, which is how a live call happens by
    // accident. Deployment facts are injected.
    //
    // String literals are stripped as well as comments: the execution contract
    // EXPLAINS the acquisition process.env lesson in its data, and a raw sweep
    // matched the explanation rather than any read.
    for (const file of FILES) {
      const code = stripStrings(stripComments(read(file)));
      assert.ok(!/process\.env/.test(code), `${rel(file)} reads process.env`);
    }
  });

  it("takes its clock by injection rather than reading one", () => {
    for (const file of FILES) {
      const code = stripComments(read(file));
      assert.ok(!/Date\.now\(\)/.test(code), `${rel(file)} calls Date.now()`);
      assert.ok(!/new Date\(\s*\)/.test(code), `${rel(file)} calls new Date() with no argument`);
    }
  });

  it("holds no credential-shaped literal", () => {
    const SECRET = /(sk_live|sk_test|key_[0-9a-f]{16}|Bearer\s+[A-Za-z0-9._-]{16}|eyJ[A-Za-z0-9_-]{20})/;
    // ONE declaration in the domain names credential shapes, and it names them
    // only in order to REFUSE them. Exempted by its exact text, so a credential
    // appearing anywhere else still fails — the same treatment
    // PROVIDER_VOICE_ID_PREFIXES gets.
    const DETECTION_DECLARATION = /const CREDENTIAL_SHAPED = \/[^\n]*\/i;/;
    for (const file of FILES) {
      assert.ok(!SECRET.test(read(file).replace(DETECTION_DECLARATION, "")),
        `${rel(file)} contains something credential-shaped`);
    }
    // The exemption must be real, exactly one line, and must not blind the check.
    const model = read(FILES.find((f) => f.endsWith("provisioning-model.js")));
    assert.match(model, DETECTION_DECLARATION, "the exempted declaration must exist as written");
    assert.equal(model.split("\n").filter((l) => DETECTION_DECLARATION.test(l)).length, 1);
    assert.ok(SECRET.test('const k = "sk_live_abc";'.replace(DETECTION_DECLARATION, "")),
      "a genuine secret elsewhere must still fail");
  });
});
