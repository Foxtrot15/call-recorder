// LOCKSMITH ACQUISITION M8B — the walkthrough script itself.
//
// The walkthrough is the artifact a founder reads to decide whether the machine
// works. That makes it worth testing as a deliverable, not just as a demo: it
// must actually run, it must actually prove the things it claims to prove, and
// it must never quietly start doing something external.
//
// It already self-checks — it exits non-zero if two workers get the same
// prospect, if the re-import escapes suppression, or if the audit chain breaks.
// This runs it and holds the output to what it says about itself.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/acquisition-m8b-walkthrough.js");

function runWalkthrough(args = []) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
}

describe("the walkthrough runs and proves what it claims", () => {
  const output = runWalkthrough();

  it("completes without failing its own invariants", () => {
    // A non-zero exit would have thrown above. These are the invariants the
    // script itself checks before deciding that.
    assert.ok(output.includes("WHAT DID NOT HAPPEN"), "it did not reach the end");
    assert.ok(!output.includes("WALKTHROUGH FAILED"));
    assert.ok(!output.includes("THIS IS A BUG"));
  });

  it("walks the whole chain the milestone asked for", () => {
    for (const stage of ["INGESTION", "NORMALISATION", "DEDUPLICATION", "QUALIFICATION", "HUMAN REVIEW", "COMPLIANCE DECISION", "QUEUE", "OUTCOME", "RE-IMPORT", "READ MODEL", "AUDIT"]) {
      assert.ok(output.includes(stage), `the walkthrough never reached ${stage}`);
    }
  });

  it("proves the re-import of an opted-out business stays suppressed", () => {
    assert.match(output, /Same identity: YES/);
    assert.match(output, /Suppression check on the re-imported record: SUPPRESSED/);
    assert.match(output, /Eligibility on the re-imported record: suppressed_permanently/);
    assert.match(output, /Either spelling of this business appearing in the queue: NO/);
  });

  it("proves two workers never receive the same business", () => {
    assert.match(output, /Overlap between the two workers: 0/);
  });

  it("proves calling hours are checked in the business's own timezone", () => {
    assert.match(output, /Fremantle Coast Locksmiths\s+local sat 07:30\s+before_permitted_hours/);
    assert.match(output, /Brunswick Rapid Locksmiths\s+local sat 09:30\s+window OK/);
  });

  it("proves a state-scoped public holiday blocks only that state", () => {
    assert.match(output, /Brunswick Rapid Locksmiths\s+VIC\s+local tue 13:00\s+public_holiday/);
    assert.match(output, /Inner West Lock & Key\s+NSW\s+local tue 13:00\s+window OK/);
  });

  it("proves the holiday calendar expiring stops calls rather than degrading", () => {
    assert.match(output, /holiday_coverage_unknown/);
  });

  it("proves the audit chain verifies", () => {
    assert.match(output, /Chain verification: INTACT/);
  });

  it("states the approvals it simulated, so nobody mistakes the run for permission", () => {
    assert.match(output, /SIMULATED FOR THIS WALKTHROUGH, AND FALSE IN EVERY REAL BUILD/);
    assert.match(output, /No counsel has approved the calling window/);
  });

  it("ends by saying what did not happen", () => {
    for (const claim of ["No website was fetched", "No call was placed", "No SQL was applied", "No provider was contacted"]) {
      assert.ok(output.includes(claim), `the closing section no longer says: ${claim}`);
    }
  });

  it("runs the same way twice — a founder re-running it sees the same thing", () => {
    assert.strictEqual(runWalkthrough(), output);
  });

  it("--verbose adds detail without changing the conclusions", () => {
    const verbose = runWalkthrough(["--verbose"]);
    assert.ok(verbose.length > output.length);
    assert.match(verbose, /Overlap between the two workers: 0/);
    assert.match(verbose, /Chain verification: INTACT/);
  });
});

describe("the walkthrough cannot reach anything external", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");

  it("references no provider, transport or network client", () => {
    // Import shapes, not bare words: the closing section legitimately names
    // Twilio, Retell and supabase/sql in order to say it did not contact them.
    // What must not appear is a CLIENT.
    for (const forbidden of ['require("twilio', "require('twilio", "@supabase/", "createClient(", "fetch(", "axios", "XMLHttpRequest", 'require("http', "require('http", "https://api.", "child_process"]) {
      assert.ok(!src.includes(forbidden), `the walkthrough must not reference ${forbidden}`);
    }
  });

  it("names a provider only in the closing disclaimer, never in the body", () => {
    const cut = src.indexOf("WHAT DID NOT HAPPEN");
    assert.ok(cut > 0);
    const body = src.slice(0, cut);
    const closing = src.slice(cut);
    for (const name of ["Twilio", "Retell", "Anthropic"]) {
      assert.ok(!body.includes(name), `"${name}" appears in the walkthrough body, not only in its disclaimer`);
      assert.ok(closing.includes(name), `"${name}" is no longer named in the disclaimer`);
    }
  });

  it("requires only local modules and node core", () => {
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      assert.ok(/node:/.test(m) || /require\(path\.join/.test(m), `${m} is not a local or core require`);
    }
  });

  it("writes no files and touches no database", () => {
    for (const forbidden of ["writeFileSync", "appendFileSync", "createWriteStream", "INSERT INTO", "psql"]) {
      assert.ok(!src.includes(forbidden), `the walkthrough must not ${forbidden}`);
    }
  });
});
