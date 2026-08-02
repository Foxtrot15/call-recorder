// AIDA — M7C checkpoint: .env loading for the standalone sandbox runner.
//
// The defect: scripts/retell-web-sandbox.js read process.env only. src/server.js
// loads dotenv; the script did not. So every variable placed in .env was
// invisible and a fully-configured sandbox still reported all nine gates
// missing — indistinguishable from having configured nothing.
//
// These tests run the REAL script as a child process with a temporary HOME-like
// working directory and a temporary .env. Nothing here touches the repository's
// own .env, and nothing contacts a provider: the script's default invocation is
// an assessment that constructs no transport.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "retell-web-sandbox.js");
const REAL_ENV = path.join(REPO_ROOT, ".env");

// A fake key that is obviously not a credential, long enough to pass length
// checks. Never a real value.
const FAKE_KEY = "sandbox_fake_key_00000000000000";
const FAKE_VOICE = "fake_voice_for_tests";

/**
 * Run the script with a chosen env, capturing stdout.
 *
 * `env` REPLACES the inherited environment except for PATH, so a developer's
 * own exported Retell variables cannot leak in and make a test pass for the
 * wrong reason.
 */
function runScript({ env = {}, args = [] } = {}) {
  try {
    return execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "test", ...env },
      cwd: os.tmpdir(),
    });
  } catch (err) {
    // A non-zero exit still carries usable output.
    return `${err.stdout || ""}${err.stderr || ""}`;
  }
}

/** Snapshot the real .env so a failure here can never be mistaken for damage. */
function realEnvFingerprint() {
  if (!fs.existsSync(REAL_ENV)) return "absent";
  const buf = fs.readFileSync(REAL_ENV);
  return `${buf.length}:${require("crypto").createHash("sha256").update(buf).digest("hex").slice(0, 16)}`;
}

describe("sandbox runner .env loading", () => {
  test("the repository's real .env is never modified by these tests", () => {
    const before = realEnvFingerprint();
    runScript({ env: {} });
    runScript({ env: { RETELL_API_KEY: FAKE_KEY } });
    assert.equal(realEnvFingerprint(), before, "the real .env must be byte-identical afterwards");
  });

  test("the script loads dotenv the way src/server.js does", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    assert.match(script, /require\("dotenv"\)\.config\(/, "must use the repository's existing convention");
    // Pinned to the repo root: a standalone script is not always run from there,
    // and a silently-missing .env is the failure being fixed.
    assert.match(script, /__dirname/, "the .env path must not depend on the working directory");
  });

  test("no override flag is passed, so exported shell values keep precedence", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    const call = (script.match(/require\("dotenv"\)\.config\(\{[^}]*\}\)/) || [""])[0];
    assert.ok(!/override\s*:\s*true/.test(call), "dotenv must not be allowed to overwrite process.env");
  });

  test("dotenv's default precedence is shell-wins (the behaviour relied upon)", () => {
    // Pinning the assumption itself: if a future dotenv changed this default,
    // an exported key could be silently replaced by a stale .env value.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aida-dotenv-"));
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(envFile, "AIDA_PRECEDENCE_PROBE=from_dotenv\n");
    try {
      const out = execFileSync(
        process.execPath,
        ["-e", `require("dotenv").config({path:${JSON.stringify(envFile)}});console.log(process.env.AIDA_PRECEDENCE_PROBE)`],
        { encoding: "utf8", env: { ...process.env, AIDA_PRECEDENCE_PROBE: "from_shell" } }
      ).trim();
      assert.equal(out, "from_shell", "an exported value must survive dotenv");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the pinned-path pattern really does load values from a .env file", () => {
    // Requirement: prove a .env is actually read. The real script pins its path
    // to the repository root, and the repository's own .env must not be
    // touched — so this builds a faithful replica of the fixed line in a
    // temporary tree and runs it.
    //
    // tmp/
    //   .env                    <- the file under test
    //   scripts/probe.js        <- same require("dotenv").config({path: ../.env})
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aida-envtree-"));
    try {
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.writeFileSync(
        path.join(dir, ".env"),
        `RETELL_API_KEY=${FAKE_KEY}\nRETELL_DEFAULT_VOICE_ID=${FAKE_VOICE}\nRETELL_SANDBOX_EXECUTE=true\n`
      );
      // Byte-for-byte the same loading form as scripts/retell-web-sandbox.js.
      fs.writeFileSync(
        path.join(dir, "scripts", "probe.js"),
        [
          'const path = require("path");',
          'require("dotenv").config({ path: path.join(__dirname, "..", ".env") });',
          "console.log(JSON.stringify({",
          "  key: Boolean(process.env.RETELL_API_KEY),",
          "  voice: Boolean(process.env.RETELL_DEFAULT_VOICE_ID),",
          "  execute: process.env.RETELL_SANDBOX_EXECUTE,",
          "}));",
        ].join("\n")
      );

      const out = execFileSync(process.execPath, [path.join(dir, "scripts", "probe.js")], {
        encoding: "utf8",
        // Run from somewhere else entirely, proving the pinned path — not the
        // working directory — is what finds the file.
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_PATH: path.join(REPO_ROOT, "node_modules") },
      });

      const loaded = JSON.parse(out);
      assert.equal(loaded.key, true, "the API key must load from .env");
      assert.equal(loaded.voice, true, "the voice id must load from .env");
      assert.equal(loaded.execute, "true", "gate values must load from .env");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an exported shell value overrides the same key in .env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aida-envtree-"));
    try {
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.writeFileSync(path.join(dir, ".env"), "RETELL_ALLOWED_TAG=from_dotenv\n");
      fs.writeFileSync(
        path.join(dir, "scripts", "probe.js"),
        [
          'const path = require("path");',
          'require("dotenv").config({ path: path.join(__dirname, "..", ".env") });',
          "console.log(process.env.RETELL_ALLOWED_TAG);",
        ].join("\n")
      );

      const out = execFileSync(process.execPath, [path.join(dir, "scripts", "probe.js")], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          NODE_PATH: path.join(REPO_ROOT, "node_modules"),
          RETELL_ALLOWED_TAG: "from_shell",
        },
      }).trim();

      assert.equal(out, "from_shell", "an already-exported variable must win over .env");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── WHY GATE LOGIC IS NOT TESTED THROUGH THE SCRIPT ───────────────
  //
  // These assertions used to spawn the script with a restricted environment and
  // check the printed blockers. That worked only while the repository's .env
  // held no Retell values. Once the sandbox was genuinely configured — which is
  // exactly when these tests matter — the script loaded the real .env and
  // filled in every "missing" variable, so a fail-closed test reported the
  // gates OPEN.
  //
  // A test whose result depends on the developer's own .env is not a test. Gate
  // logic is a pure function over an env object, so it is asserted directly;
  // the subprocess tests below cover only what genuinely needs the script —
  // that dotenv loads at all, that no secret is printed, and that no transport
  // is constructed.
  test("missing variables fail closed (asserted on the pure gate, not the script)", () => {
    const g = require("../src/config/retell-sandbox").evaluateSandboxGate({});
    assert.equal(g.allowed, false);
    assert.ok(g.blockers.length > 0);
  });

  test("a partial configuration fails closed", () => {
    const cfg = require("../src/config/retell-sandbox");
    const partial = {
      RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true", RETELL_DRY_RUN: "false",
      RETELL_SANDBOX_WEB_CALL_ENABLED: "true", RETELL_ALLOWED_TAG: "dev",
      RETELL_API_KEY: FAKE_KEY, RETELL_DEFAULT_VOICE_ID: FAKE_VOICE, RETELL_DEFAULT_LANGUAGE: "en-AU",
    };
    const g = cfg.evaluateSandboxGate(partial);
    assert.equal(g.allowed, false);
    assert.match(g.blockers.join(" "), /RETELL_SANDBOX_EXECUTE is not "true"/);
  });

  test("these tests do not depend on the repository's .env contents", () => {
    // The guard for the defect above: the pure gate must reach the same verdict
    // whether or not real credentials exist on this machine.
    const cfg = require("../src/config/retell-sandbox");
    assert.equal(cfg.evaluateSandboxGate({}).allowed, false, "an empty env is always closed");
    assert.equal(cfg.getSandboxConfig({}).hasApiKey, false, "an empty env never reports a key");
  });

  test("no secret value is ever printed", () => {
    const out = runScript({
      env: {
        RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true", RETELL_DRY_RUN: "false",
        RETELL_SANDBOX_WEB_CALL_ENABLED: "true", RETELL_SANDBOX_EXECUTE: "true", RETELL_ALLOWED_TAG: "dev",
        RETELL_API_KEY: FAKE_KEY, RETELL_DEFAULT_VOICE_ID: FAKE_VOICE, RETELL_DEFAULT_LANGUAGE: "en-AU",
      },
    });
    assert.ok(!out.includes(FAKE_KEY), "the API key must never appear in output");
    assert.ok(!out.includes(FAKE_VOICE), "the voice id is configuration, not something to echo back");
    assert.match(out, /api key\s+: present \(never printed\)/);
  });

  test("the default invocation makes no network request and creates no transport", () => {
    // Run with global fetch removed. If the assessment path constructed a
    // transport, this would throw rather than complete.
    const out = execFileSync(
      process.execPath,
      ["-e", `delete globalThis.fetch; process.argv[1]=${JSON.stringify(SCRIPT)}; require(${JSON.stringify(SCRIPT)});`],
      { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "test" }, cwd: os.tmpdir() }
    );
    assert.match(out, /No provider request was made/);
  });
});

describe("dotenv must not weaken any gate", () => {
  const ALL_GATES = {
    RETELL_ENABLED: "true",
    RETELL_LIVE_WRITES_ENABLED: "true",
    RETELL_DRY_RUN: "false",
    RETELL_SANDBOX_WEB_CALL_ENABLED: "true",
    RETELL_SANDBOX_EXECUTE: "true",
    RETELL_ALLOWED_TAG: "dev",
    RETELL_API_KEY: FAKE_KEY,
    RETELL_DEFAULT_VOICE_ID: FAKE_VOICE,
    RETELL_DEFAULT_LANGUAGE: "en-AU",
  };

  // Asserted on the pure gate for the isolation reason documented above: a
  // subprocess would inherit the repository's real .env and never see a
  // variable as absent.
  const gateOf = (env) => require("../src/config/retell-sandbox").evaluateSandboxGate(env);

  test("every gate satisfied is required before the gates report open", () => {
    assert.equal(gateOf(ALL_GATES).allowed, true);
  });

  for (const key of ["RETELL_ENABLED", "RETELL_LIVE_WRITES_ENABLED", "RETELL_SANDBOX_WEB_CALL_ENABLED", "RETELL_SANDBOX_EXECUTE", "RETELL_API_KEY", "RETELL_DEFAULT_VOICE_ID"]) {
    test(`removing ${key} closes the gate`, () => {
      const env = { ...ALL_GATES };
      delete env[key];
      assert.equal(gateOf(env).allowed, false, `${key} must remain required`);
    });
  }

  test("RETELL_DRY_RUN left on closes the gate", () => {
    const g = gateOf({ ...ALL_GATES, RETELL_DRY_RUN: "true" });
    assert.equal(g.allowed, false);
    assert.match(g.blockers.join(" "), /RETELL_DRY_RUN is on/);
  });

  test("a tag other than dev closes the gate", () => {
    assert.equal(gateOf({ ...ALL_GATES, RETELL_ALLOWED_TAG: "prod" }).allowed, false);
  });

  test("live TELEPHONE calls being enabled still refuses the sandbox", () => {
    const g = gateOf({ ...ALL_GATES, RETELL_LIVE_CALLS_ENABLED: "true" });
    assert.equal(g.allowed, false);
    assert.match(g.blockers.join(" "), /RETELL_LIVE_CALLS_ENABLED/);
  });

  test("production refuses before anything else is evaluated", () => {
    const out = runScript({ env: { ...ALL_GATES, NODE_ENV: "production" } });
    assert.match(out, /Refusing to run the Retell sandbox in production/);
  });

  test("no gate defaults to true", () => {
    // The shipped configuration — nothing set — must open nothing.
    const cfg = require("../src/config/retell-sandbox");
    const c = cfg.getSandboxConfig({});
    assert.equal(c.enabled, false);
    assert.equal(c.executeRequested, false);
    assert.equal(c.keepResourcesRequested, false);
    assert.equal(c.retellEnabled, false);
    assert.equal(c.liveWritesEnabled, false);
    assert.equal(c.dryRun, true, "dry-run is the safe default and stays on");
    assert.equal(cfg.evaluateSandboxGate({}).allowed, false);
  });
});
