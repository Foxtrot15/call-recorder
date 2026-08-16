// AIDA PLATFORM P10 — the operator CLI.
//
// The logic lives in src/platform/client-cli.js so it can be tested without
// spawning a process, without a filesystem and without a clock. These tests
// call it directly; a handful at the end run the actual script, because a CLI
// nobody has run is a CLI that does not work.
//
// The property that matters most: THERE IS NO ACTIVATE COMMAND. Putting a
// configuration live is the moment a business's telephone starts being
// answered differently, and it should require a person who has read a diff —
// not an operator with shell history and a habit.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { runClientCommand, parseFlags, COMMANDS, USAGE } = require("../src/platform/client-cli");
const { createInMemoryBlueprintStore, createBlueprintAuthority } = require("../src/platform/blueprint-authority");
const { locksmithA, plumberC } = require("../src/platform/fixtures/clients");

const REFS = Object.freeze({ llmId: "llm_fake", voiceId: "custom_voice_fake", webhookUrl: "https://example.invalid/h" });

function fixedClock(startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 1000) => { t += ms; return new Date(t); };
  return now;
}

/** One client, active at v1, with a second draft waiting. */
async function seeded() {
  const now = fixedClock();
  const store = createInMemoryBlueprintStore();
  const authority = createBlueprintAuthority({ store, now });

  const first = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
  await authority.validateDraft("northside_locks", 1);
  await authority.approveDraft({ clientId: "northside_locks", configVersion: 1, approvedBy: "Peter Dang" });
  await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: 1, activatedBy: "Peter Dang" });
  now.tick();

  const changed = locksmithA();
  changed.hours.weekly.saturday = { closed: true };
  changed.serviceArea.suburbs = [...changed.serviceArea.suburbs, "Reservoir"];
  await authority.createDraft({ clientId: "northside_locks", blueprint: changed, createdBy: "Peter Dang" });

  return { store, now, authority, first };
}

const run = (argv, extra = {}) => runClientCommand({ argv, providerRefs: REFS, ...extra });
const text = (result) => result.lines.join("\n");

describe("cli — argument parsing", () => {
  it("reads flags with values and flags without", () => {
    const { flags, positional } = parseFlags(["northside_locks", "--version", "3", "--verbose", "--by", "Peter Dang"]);
    assert.deepEqual(positional, ["northside_locks"]);
    assert.equal(flags.version, "3");
    assert.equal(flags.verbose, true);
    assert.equal(flags.by, "Peter Dang");
  });

  it("treats a flag followed by another flag as a bare flag", () => {
    const { flags } = parseFlags(["--demo", "--version", "2"]);
    assert.equal(flags.demo, true);
    assert.equal(flags.version, "2");
  });
});

describe("cli — help and unknown commands", () => {
  it("prints usage for help, and exits zero", async () => {
    const result = await run(["help"]);
    assert.equal(result.exitCode, 0);
    assert.equal(text(result), USAGE);
  });

  it("prints usage and fails when given nothing", async () => {
    const result = await run([]);
    assert.equal(result.exitCode, 1);
    assert.ok(text(result).includes("init"));
  });

  it("refuses a command it does not have", async () => {
    for (const unknown of ["activate", "deploy", "dial", "provision", "delete"]) {
      const result = await run([unknown, "northside_locks"]);
      assert.equal(result.exitCode, 1, `"${unknown}" must not be a command`);
      assert.ok(text(result).includes(`unknown command "${unknown}"`));
    }
  });

  it("needs a clientId for everything that acts on one", async () => {
    for (const command of COMMANDS.filter((c) => c !== "help")) {
      const result = await run([command]);
      assert.equal(result.exitCode, 1);
      assert.ok(text(result).includes("needs a clientId"), command);
    }
  });
});

describe("cli — there is no way to put anything live", () => {
  it("has no activate command", () => {
    assert.ok(!COMMANDS.includes("activate"));
    assert.ok(!COMMANDS.includes("publish"));
    assert.ok(!COMMANDS.includes("deploy"));
    assert.ok(!COMMANDS.includes("golive"));
  });

  it("says so in its own usage, so the omission is legible", () => {
    assert.match(USAGE, /Nothing here activates/i);
  });

  it("leaves the active version untouched after every command it does have", async () => {
    const { store, now, authority } = await seeded();
    const before = JSON.stringify((await authority.getActiveVersion("northside_locks")).version);

    for (const argv of [
      ["versions", "northside_locks"],
      ["validate", "northside_locks"],
      ["validate", "northside_locks", "--version", "2"],
      ["diff", "northside_locks", "--to", "2"],
      ["preview", "northside_locks"],
      ["approve", "northside_locks", "--version", "2", "--by", "Peter Dang"],
    ]) {
      await run(argv, { store, now });
    }

    const after = await authority.getActiveVersion("northside_locks");
    assert.equal(JSON.stringify(after.version), before, "no command may change what is live");
    assert.equal(after.version.metadata.configVersion, 1);
  });
});

describe("cli — init", () => {
  it("prints a valid-shaped starting point", async () => {
    const result = await run(["init", "acme_electrical", "electrical"]);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(text(result));
    assert.equal(parsed.identity.clientId, "acme_electrical");
    assert.equal(parsed.identity.vertical, "electrical");
    assert.equal(parsed.metadata.status, "draft");
  });

  it("needs a vertical", async () => {
    const result = await run(["init", "acme_electrical"]);
    assert.equal(result.exitCode, 1);
    assert.ok(text(result).includes("needs a vertical"));
  });

  it("works with no store and no clock, because it touches nothing", async () => {
    const result = await runClientCommand({ argv: ["init", "acme_electrical", "electrical"] });
    assert.equal(result.exitCode, 0);
  });

  it("produces something that does not accidentally validate", async () => {
    const { validateBlueprint } = require("../src/platform/client-blueprint");
    const result = await run(["init", "acme_electrical", "electrical"]);
    assert.equal(validateBlueprint(JSON.parse(text(result))).ok, false, "a blank client is not a configured one");
  });
});

describe("cli — versions", () => {
  it("lists the history with status, author and approver", async () => {
    const { store, now } = await seeded();
    const result = await run(["versions", "northside_locks"], { store, now });
    assert.equal(result.exitCode, 0);
    const out = text(result);
    assert.match(out, /2 versions/);
    assert.match(out, /v1\s+active/);
    assert.match(out, /v2\s+draft/);
    assert.match(out, /approved by Peter Dang/);
  });

  it("says so when a client has none", async () => {
    const { store, now } = await seeded();
    const result = await run(["versions", "nobody_at_all"], { store, now });
    assert.equal(result.exitCode, 1);
    assert.ok(text(result).includes("has no versions"));
  });
});

describe("cli — validate", () => {
  it("validates the ACTIVE version by default, and says which it used", async () => {
    const { store, now } = await seeded();
    const result = await run(["validate", "northside_locks"], { store, now });
    assert.equal(result.exitCode, 0);
    assert.ok(text(result).includes("using the ACTIVE version"));
    assert.match(text(result), /v1: VALID/);
  });

  it("validates a named version", async () => {
    const { store, now } = await seeded();
    const result = await run(["validate", "northside_locks", "--version", "2"], { store, now });
    assert.equal(result.exitCode, 0);
    assert.match(text(result), /v2: VALID/);
  });

  it("names every error, and exits non-zero", async () => {
    const now = fixedClock();
    const store = createInMemoryBlueprintStore();
    const authority = createBlueprintAuthority({ store, now });
    const broken = locksmithA();
    broken.services = [];
    broken.knowledge.uncertaintyPolicy = null;
    await authority.createDraft({ clientId: "northside_locks", blueprint: broken, createdBy: "Peter Dang" });

    const result = await run(["validate", "northside_locks"], { store, now });
    assert.equal(result.exitCode, 1);
    const out = text(result);
    assert.ok(out.includes("no active version — using the latest, v1"));
    assert.match(out, /error\s+services:/);
    assert.match(out, /error\s+knowledge\.uncertaintyPolicy:/);

    // Removing the services cascades: everything that referenced one is now
    // dangling, and the CLI reports each rather than stopping at the first.
    const counted = out.match(/INVALID — (\d+) errors/);
    assert.ok(counted, `expected an error count, got: ${out}`);
    const printed = out.split("\n").filter((l) => l.trim().startsWith("error ")).length;
    assert.equal(printed, Number(counted[1]), "the count must match what was actually printed");
    assert.ok(printed >= 2);
    assert.match(out, /error\s+callHandling\.escalation\.eligibleServices\[0\]/);
  });

  it("refuses a version number that is not one", async () => {
    const { store, now } = await seeded();
    for (const bad of ["nought", "-1", "0", "1.5"]) {
      const result = await run(["validate", "northside_locks", "--version", bad], { store, now });
      assert.equal(result.exitCode, 1, bad);
      assert.ok(text(result).includes("positive whole number"), bad);
    }
  });

  it("says plainly when the version does not exist", async () => {
    const { store, now } = await seeded();
    const result = await run(["validate", "northside_locks", "--version", "99"], { store, now });
    assert.equal(result.exitCode, 1);
    assert.ok(text(result).includes("has no version 99"));
  });
});

describe("cli — diff", () => {
  it("compares a version against the active one by default", async () => {
    const { store, now } = await seeded();
    const result = await run(["diff", "northside_locks", "--to", "2"], { store, now });
    assert.equal(result.exitCode, 0);
    const out = text(result);
    assert.ok(out.includes("the active v1 -> v2"));
    assert.match(out, /Reservoir/);
    assert.match(out, /saturday/);
  });

  it("compares two named versions", async () => {
    const { store, now } = await seeded();
    const result = await run(["diff", "northside_locks", "--from", "1", "--to", "2"], { store, now });
    assert.equal(result.exitCode, 0);
    assert.ok(text(result).includes("v1 -> v2"));
  });

  it("reports no changes rather than pretending there are some", async () => {
    const now = fixedClock();
    const store = createInMemoryBlueprintStore();
    const authority = createBlueprintAuthority({ store, now });
    await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    now.tick();
    await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });

    const result = await run(["diff", "northside_locks", "--from", "1", "--to", "2"], { store, now });
    assert.equal(result.exitCode, 0);
    assert.ok(text(result).includes("no changes"));
  });

  it("needs a --to", async () => {
    const { store, now } = await seeded();
    const result = await run(["diff", "northside_locks"], { store, now });
    assert.equal(result.exitCode, 1);
    assert.ok(text(result).includes("needs --to"));
  });

  it("refuses a version that does not exist, in either direction", async () => {
    const { store, now } = await seeded();
    for (const argv of [
      ["diff", "northside_locks", "--to", "99"],
      ["diff", "northside_locks", "--from", "99", "--to", "2"],
    ]) {
      const result = await run(argv, { store, now });
      assert.equal(result.exitCode, 1);
      assert.ok(text(result).includes("has no version 99"));
    }
  });
});

describe("cli — preview", () => {
  it("shows the hashes, the opening line and the whole prompt", async () => {
    const { store, now } = await seeded();
    const result = await run(["preview", "northside_locks"], { store, now });
    assert.equal(result.exitCode, 0);
    const out = text(result);
    assert.match(out, /behaviour\s+[0-9a-f]{64}/);
    assert.match(out, /payload\s+[0-9a-f]{64}/);
    assert.match(out, /engine\s+[0-9a-f]{64}/);
    assert.match(out, /agent\s+[0-9a-f]{64}/);
    assert.ok(out.includes("the first thing a caller hears"));
    assert.match(out, /AI assistant/);
    assert.ok(out.includes("# Who you are"));
    assert.ok(out.includes("Northside Lock & Key"));
  });

  it("refuses to preview an invalid configuration", async () => {
    const now = fixedClock();
    const store = createInMemoryBlueprintStore();
    const authority = createBlueprintAuthority({ store, now });
    const broken = plumberC();
    broken.callHandling.escalation.primaryNumber = null;
    await authority.createDraft({ clientId: "riverside_plumbing", blueprint: broken, createdBy: "Ravi Menon" });

    const result = await run(["preview", "riverside_plumbing"], { store, now });
    assert.equal(result.exitCode, 1);
    const out = text(result);
    assert.match(out, /INVALID/);
    assert.ok(out.includes("refusing to preview an invalid configuration"));
    assert.ok(!out.includes("# Who you are"), "nothing misleading may be printed");
  });

  it("names unresolved provider references instead of inventing them", async () => {
    const { store, now } = await seeded();
    const result = await run(["preview", "northside_locks"], { store, now, providerRefs: {} });
    assert.equal(result.exitCode, 1);
    const out = text(result);
    assert.match(out, /NOT READY — unresolved: /);
    for (const ref of ["llmId", "voiceId", "webhookUrl"]) assert.ok(out.includes(ref), ref);
    assert.ok(out.includes("never guessed"));
  });

  it("previews a draft as well as the active version", async () => {
    const { store, now } = await seeded();
    const result = await run(["preview", "northside_locks", "--version", "2"], { store, now });
    assert.equal(result.exitCode, 0);
    assert.ok(text(result).includes("v2 (draft)"));
  });
});

describe("cli — preview shows the job-specific questions separately", () => {
  // This is the defect the CLI itself surfaced: emitting every additional
  // question as always-ask told the plumber's assistant to say "is anyone
  // still inside, go outside and don't use switches" on a call about a
  // dripping tap.
  async function plumberPreview() {
    const now = fixedClock();
    const store = createInMemoryBlueprintStore();
    const authority = createBlueprintAuthority({ store, now });
    await authority.createDraft({ clientId: "riverside_plumbing", blueprint: plumberC(), createdBy: "Ravi Menon" });
    const result = await run(["preview", "riverside_plumbing"], { store, now });
    assert.equal(result.exitCode, 0, text(result));
    return text(result);
  }

  it("keeps a service-scoped question out of the always-ask list", async () => {
    const out = await plumberPreview();
    const always = out.slice(out.indexOf("# What you always find out"), out.indexOf("# What you also ask"));
    assert.ok(!always.includes("Is anyone still inside"), "the gas question must not be asked on every call");
    assert.ok(!always.includes("how old is the hot water system"));
    assert.ok(always.includes("caller name"));
  });

  it("puts it under the job it belongs to", async () => {
    const out = await plumberPreview();
    const scoped = out.slice(out.indexOf("# What you also ask"));
    assert.match(scoped, /Gas fitting[\s\S]{0,120}Is anyone still inside/);
    assert.match(scoped, /Hot water system[\s\S]{0,120}how old is the hot water system/);
  });

  it("carries the per-service collection that was previously dropped entirely", async () => {
    const out = await plumberPreview();
    const scoped = out.slice(out.indexOf("# What you also ask"));
    assert.match(scoped, /Burst pipe: [^\n]*access notes/);
    assert.match(scoped, /Burst pipe: [^\n]*on site now/);
  });

  it("omits the section entirely for a client with nothing job-specific", async () => {
    const now = fixedClock();
    const store = createInMemoryBlueprintStore();
    const authority = createBlueprintAuthority({ store, now });
    const simple = locksmithA();
    simple.callHandling.collectByService = {};
    simple.callHandling.additionalQuestions = [];
    await authority.createDraft({ clientId: "northside_locks", blueprint: simple, createdBy: "Peter Dang" });

    const result = await run(["preview", "northside_locks"], { store, now });
    assert.equal(result.exitCode, 0);
    assert.ok(!text(result).includes("# What you also ask"));
  });
});

describe("cli — approve", () => {
  it("validates, approves and says plainly that it is still not live", async () => {
    const { store, now, authority } = await seeded();
    const result = await run(["approve", "northside_locks", "--version", "2", "--by", "Peter Dang"], { store, now });
    assert.equal(result.exitCode, 0);
    const out = text(result);
    assert.match(out, /v2 APPROVED by Peter Dang/);
    assert.ok(out.includes("It is NOT live"));

    const stillActive = await authority.getActiveVersion("northside_locks");
    assert.equal(stillActive.version.metadata.configVersion, 1);
    const v2 = await authority.getDraft("northside_locks", 2);
    assert.equal(v2.version.metadata.status, "approved");
  });

  it("refuses an approval with no person attached", async () => {
    const { store, now } = await seeded();
    for (const argv of [
      ["approve", "northside_locks", "--version", "2"],
      ["approve", "northside_locks", "--version", "2", "--by"],
    ]) {
      const result = await run(argv, { store, now });
      assert.equal(result.exitCode, 1);
      assert.ok(text(result).includes("not an approval"));
    }
  });

  it("refuses an approval by something that is not a person", async () => {
    const { store, now } = await seeded();
    for (const machine of ["system", "aida", "bot", "cron"]) {
      const result = await run(["approve", "northside_locks", "--version", "2", "--by", machine], { store, now });
      assert.equal(result.exitCode, 1, machine);
      assert.ok(text(result).includes("not a person"), machine);
    }
  });

  it("refuses to approve something invalid, listing why", async () => {
    const now = fixedClock();
    const store = createInMemoryBlueprintStore();
    const authority = createBlueprintAuthority({ store, now });
    const broken = locksmithA();
    broken.services = [];
    await authority.createDraft({ clientId: "northside_locks", blueprint: broken, createdBy: "Peter Dang" });

    const result = await run(["approve", "northside_locks", "--version", "1", "--by", "Peter Dang"], { store, now });
    assert.equal(result.exitCode, 1);
    assert.match(text(result), /error\s+services:/);
  });

  it("needs a version", async () => {
    const { store, now } = await seeded();
    const result = await run(["approve", "northside_locks", "--by", "Peter Dang"], { store, now });
    assert.equal(result.exitCode, 1);
    assert.ok(text(result).includes("needs --version"));
  });

  it("records a reason when one is given", async () => {
    const { store, now, authority } = await seeded();
    await run(["approve", "northside_locks", "--version", "2", "--by", "Peter Dang", "--reason", "Read it to the owner."], { store, now });
    const v2 = await authority.getDraft("northside_locks", 2);
    assert.equal(v2.version.metadata.approvalReason, "Read it to the owner.");
  });
});

describe("cli — the script actually runs", () => {
  const script = path.join(__dirname, "..", "scripts", "client.js");
  const exec = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }) };
    } catch (error) {
      return { code: error.status, out: `${error.stdout || ""}${error.stderr || ""}` };
    }
  };

  it("prints help", () => {
    const { code, out } = exec(["help"]);
    assert.equal(code, 0);
    assert.match(out, /aida client/);
  });

  it("seeds the four fixture clients with --demo", () => {
    for (const clientId of ["northside_locks", "southbank_security", "riverside_plumbing", "rolladoor_repairs"]) {
      const { code, out } = exec(["versions", clientId, "--demo"]);
      assert.equal(code, 0, out);
      assert.match(out, /v1\s+active/);
    }
  });

  it("previews a seeded client all the way to a prompt", () => {
    const { code, out } = exec([
      "preview", "southbank_security", "--demo",
      "--llm-id", "llm_fake", "--voice-id", "custom_voice_fake", "--webhook-url", "https://example.invalid/h",
    ]);
    assert.equal(code, 0, out);
    assert.match(out, /Southbank Security/);
    assert.match(out, /AI assistant/);
    assert.match(out, /# Who you are/);
  });

  it("exits non-zero and names what is unresolved when references are missing", () => {
    const { code, out } = exec(["preview", "southbank_security", "--demo"]);
    assert.equal(code, 1);
    assert.match(out, /NOT READY/);
    assert.match(out, /voiceId/);
  });

  it("reports an unreadable store file rather than crashing", () => {
    const { code, out } = exec(["versions", "northside_locks", "--store", "no-such-file.json"]);
    assert.equal(code, 1);
    assert.match(out, /could not load configuration/);
  });
});
