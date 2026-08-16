// AIDA PLATFORM P12 — the end-to-end demonstration, guarded.
//
// The walkthrough is the claim: a business in a trade no module mentions
// becomes a working assistant configuration without a line of code. A
// demonstration nobody runs is a demonstration that has quietly stopped being
// true, so it runs here.
//
// It also asserts its OWN expectations internally and exits non-zero if any
// fail — these tests check that it ran, that it refused what it should, and
// that the documentation describing it has not drifted from the code.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "dev", "platform-new-client-walkthrough.js");

function runWalkthrough() {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

const RESULT = runWalkthrough();

describe("walkthrough — it runs, and every expectation inside it holds", () => {
  it("exits zero", () => {
    assert.equal(RESULT.code, 0, RESULT.out);
  });

  it("fails no internal expectation", () => {
    assert.ok(!RESULT.out.includes("EXPECTATION FAILED"), RESULT.out);
    assert.match(RESULT.out, /No expectation failed/);
  });

  it("walks all twelve steps", () => {
    for (let i = 1; i <= 12; i += 1) {
      assert.match(RESULT.out, new RegExp(`^${i}\\. `, "m"), `step ${i} did not run`);
    }
  });

  it("is deterministic — the same run twice, character for character", () => {
    const second = runWalkthrough();
    assert.equal(second.code, 0);
    assert.equal(second.out, RESULT.out, "the walkthrough must not vary between runs");
  });
});

describe("walkthrough — a fourth trade, configured by nothing but configuration", () => {
  it("uses a trade no platform module mentions", () => {
    assert.match(RESULT.out, /vertical "electrical"/);

    const platformDir = path.join(ROOT, "src", "platform");
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith(".js")) out.push(full);
      }
      return out;
    };
    for (const file of walk(platformDir)) {
      const source = fs.readFileSync(file, "utf8");
      for (const word of ["electric", "switchboard", "powerpoint"]) {
        assert.ok(
          !source.toLowerCase().includes(word),
          `${path.basename(file)} mentions "${word}" — the demonstration trade must be unknown to the platform`,
        );
      }
    }
  });

  it("gets a whole prompt out the other end", () => {
    assert.match(RESULT.out, /# Who you are/);
    assert.match(RESULT.out, /Harbour Electrical/);
    assert.match(RESULT.out, /Burning smell or sparking/);
    assert.match(RESULT.out, /Neutral Bay/);
  });

  it("leaves the disabled service out of the prompt", () => {
    const promptStart = RESULT.out.indexOf("# What this business does");
    const prompt = RESULT.out.slice(promptStart);
    assert.ok(!prompt.includes("Solar installation"), "a disabled service must not be offered");
  });

  it("discloses AI in the first spoken sentence", () => {
    assert.match(RESULT.out, /the first thing a caller hears[\s\S]{0,200}AI assistant/);
  });
});

describe("walkthrough — it demonstrates the refusals, not just the happy path", () => {
  const refuses = (fragment) =>
    assert.ok(
      RESULT.out.split("\n").some((line) => line.includes("REFUSED") && line.includes(fragment)),
      `nothing was refused matching "${fragment}"`,
    );

  it("refuses a transfer rule with nowhere to transfer", () => refuses("no number to transfer to"));
  it("refuses dropping a mandatory prohibition", () => refuses("mandatory prohibition"));
  it("refuses recording without telling anybody", () => refuses("without telling anybody"));
  it("refuses a provider voice id in the blueprint", () => refuses("provider voice id"));
  it("refuses an invented urgency level", () => refuses("invented urgency level"));
  it("refuses activating before approval", () => refuses("activating before approval"));
  it("refuses approval by a machine", () => refuses('approval by "aida"'));
  it("refuses editing an active version", () => refuses("editing the active version"));
  it("refuses a voice change reaching what is live", () => refuses("changing what is live"));
  it("refuses a patch that would activate itself", () => refuses("metadata.status"));
  it("refuses compiling without provider references", () => refuses("compiling without references"));
  it("refuses a capability the client has not enabled", () => refuses("resolving crm"));
  it("refuses a malformed integration request", () => refuses("sms with no recipient"));

  it("shows approval and activation as separate decisions", () => {
    assert.match(RESULT.out, /approval and activation are separate decisions/);
  });

  it("ends by demonstrating that nothing can dial", () => {
    assert.match(RESULT.out, /and none of them dials/);
    assert.match(RESULT.out, /outbound is a capability description/);
  });
});

describe("documentation — it has not drifted from the code", () => {
  const doc = (name) => fs.readFileSync(path.join(ROOT, "docs", name), "utf8");
  const PLATFORM_DOC = doc("AIDA_CLIENT_PLATFORM.md");
  const CHECKLIST = doc("NEW_CLIENT_IMPLEMENTATION_CHECKLIST.md");

  it("names every file that exists, in the layer table", () => {
    const platformDir = path.join(ROOT, "src", "platform");
    const names = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else if (entry.name.endsWith(".js")) names.push(entry.name);
      }
    };
    walk(platformDir);
    for (const name of names) {
      assert.ok(PLATFORM_DOC.includes(name), `the platform doc does not mention ${name}`);
    }
  });

  it("lists the capabilities the code actually has", () => {
    const { INTEGRATION_CAPABILITIES } = require("../src/platform/client-blueprint");
    for (const capability of INTEGRATION_CAPABILITIES) {
      assert.ok(PLATFORM_DOC.includes(`\`${capability}\``), `the doc does not list the "${capability}" capability`);
    }
  });

  it("lists the CLI commands the code actually has", () => {
    const { COMMANDS } = require("../src/platform/client-cli");
    for (const command of COMMANDS) {
      if (command === "help") continue;
      assert.ok(PLATFORM_DOC.includes(`client.js ${command}`), `the doc does not show "${command}"`);
    }
  });

  it("claims no command the CLI does not have", () => {
    const { COMMANDS } = require("../src/platform/client-cli");
    for (const invented of ["activate", "deploy", "publish", "dial", "provision"]) {
      assert.ok(!COMMANDS.includes(invented));
      assert.ok(
        !new RegExp(`client\\.js ${invented}\\b`).test(PLATFORM_DOC),
        `the doc shows "client.js ${invented}", which does not exist`,
      );
      assert.ok(!new RegExp(`client\\.js ${invented}\\b`).test(CHECKLIST));
    }
  });

  it("says plainly that there is no activate command", () => {
    assert.match(PLATFORM_DOC, /no `activate` command, and that is not an omission/i);
    assert.match(CHECKLIST, /not a CLI command/i);
  });

  it("reports the migration counts the migration actually produces", () => {
    require("../src/services/locksmith-extraction-fixture");
    const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
    const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");
    const { migrateLocksmithProfile } = require("../src/platform/migrate-locksmith-profile");

    const legacy = extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo-locksmith" }).profile;
    const { notes, unmapped, defaultsApplied } = migrateLocksmithProfile(legacy);

    // The doc states these as a table. If the migration changes, the doc must.
    const stated = (label) => {
      const row = PLATFORM_DOC.split("\n").find((l) => l.includes(label) && /\|\s*\d+\s*\|/.test(l));
      assert.ok(row, `the doc has no count for ${label}`);
      return Number(row.match(/\|\s*(\d+)\s*\|/)[1]);
    };
    assert.equal(stated("`notes[]`"), notes.length);
    assert.equal(stated("`unmapped[]`"), unmapped.length);
    assert.equal(stated("`defaultsApplied[]`"), defaultsApplied.length);
  });

  it("states the mandatory prohibitions the code actually enforces", () => {
    const { MANDATORY_PROHIBITED_CLAIMS } = require("../src/platform/client-blueprint");
    assert.equal(MANDATORY_PROHIBITED_CLAIMS.length, 6, "the doc says there are six");
    // Prose wraps; the content is what is under test, not where the line broke.
    const flat = PLATFORM_DOC.toLowerCase().replace(/\s+/g, " ");
    for (const claim of MANDATORY_PROHIBITED_CLAIMS) {
      const phrase = claim.replace(/_or_/g, " or ").replace(/_/g, " ");
      assert.ok(flat.includes(phrase), `the doc does not mention "${phrase}"`);
    }
  });

  it("is honest about the two pre-existing failures", () => {
    assert.match(PLATFORM_DOC, /Known pre-existing test failures/);
    assert.match(PLATFORM_DOC, /acquisition-laq2-migration/);
    assert.match(PLATFORM_DOC, /acquisition-batch-approval/);
  });

  it("is honest about what is not built", () => {
    assert.match(PLATFORM_DOC, /What is NOT built/);
    for (const gap of ["No provisioning", "No voice configuration agent", "No real adapters", "No UI"]) {
      assert.ok(PLATFORM_DOC.includes(gap), `the doc does not admit: ${gap}`);
    }
  });

  it("is honest that the durable store exists but its migration is UNAPPLIED", () => {
    // The gap moved rather than closing: P14/P15 built the store, and the SQL
    // has still been applied nowhere. Saying "no durable store" would now be
    // wrong; saying nothing would be worse.
    assert.match(PLATFORM_DOC, /SQL CREATED — NOT APPLIED ANYWHERE/);
    assert.match(PLATFORM_DOC, /NOT APPLIED TO DEV/);
    assert.match(PLATFORM_DOC, /NOT APPLIED TO PRODUCTION/);
    assert.match(PLATFORM_DOC, /durable store is BUILT but UNAPPLIED/i);
    assert.match(PLATFORM_DOC, /router is still wired to the in-memory store/i);
  });

  it("records the AI-disclosure ruling as decided, not as an open question", () => {
    assert.match(PLATFORM_DOC, /FOUNDER RULING, 2026-08-16, IMPLEMENTED/);
    assert.ok(!PLATFORM_DOC.includes("REVIEW BEFORE LIVE MERGE"), "the P13 blocker is resolved and must not still be advertised");
    assert.ok(!PLATFORM_DOC.includes("unresolved product-policy decision"));
    assert.match(PLATFORM_DOC, /byte-identically/, "the inbound parity result is stated");
  });

  it("documents the durable architecture the code actually has", () => {
    for (const heading of [
      "Durable configuration architecture", "Storage model", "Database invariants",
      "Tenant authority", "HTTP surface", "Activation semantics", "Provider preview",
      "Voice configuration path", "Audit history", "Migration status",
    ]) {
      assert.ok(PLATFORM_DOC.includes(heading), `the doc is missing the "${heading}" section`);
    }
    // The tables must name the real artefacts.
    assert.ok(PLATFORM_DOC.includes("pcv_one_active_per_client"));
    assert.ok(PLATFORM_DOC.includes("acp1_create_client_configuration.sql"));
    assert.ok(PLATFORM_DOC.includes("PLATFORM_CONFIG_API_ENABLED"));
  });
});
