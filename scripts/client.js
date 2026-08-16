#!/usr/bin/env node
// ============================================================================
// AIDA PLATFORM — the operator CLI (P10).
//
//   NODE_PATH=../call-recorder/node_modules node scripts/client.js help
//   node scripts/client.js init northside_locks locksmith
//   node scripts/client.js versions northside_locks --demo
//   node scripts/client.js preview northside_locks --demo
//
// ── THIS IS THE SHELL, NOT THE LOGIC ────────────────────────────────
// Read argv, call src/platform/client-cli.js, print, exit. Every decision
// lives there, where it is tested without spawning a process.
//
// ── WHERE THE VERSIONS COME FROM ────────────────────────────────────
// The in-memory store, seeded either from --demo (the four fixture clients) or
// from a JSON file given with --store. There is deliberately no Supabase
// connection: this batch designs the domain before inventing SQL, and a CLI
// that could reach a database is a CLI that could change one.
//
// ── WHAT IT CANNOT DO ───────────────────────────────────────────────
// No activate. No dial, provision, enable or suppress. It cannot open a
// socket, and the boundary ratchets assert that by reading the source of
// everything it imports.
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { runClientCommand } = require(path.join(ROOT, "src/platform/client-cli"));
const { createInMemoryBlueprintStore, createBlueprintAuthority } = require(path.join(ROOT, "src/platform/blueprint-authority"));
const { FIXTURE_CLIENTS } = require(path.join(ROOT, "src/platform/fixtures/clients"));

const argv = process.argv.slice(2);
const wants = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
};

/** The four fixture clients, each taken all the way to active. */
async function seedDemo(store, now) {
  const authority = createBlueprintAuthority({ store, now });
  for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
    const draft = await authority.createDraft({ clientId, blueprint: make(), createdBy: "demo seed" });
    const v = draft.version.metadata.configVersion;
    await authority.validateDraft(clientId, v);
    await authority.approveDraft({ clientId, configVersion: v, approvedBy: "Peter Dang", reason: "demonstration seed" });
    await authority.activateApprovedVersion({ clientId, configVersion: v, activatedBy: "Peter Dang" });
  }
}

/** A store from a JSON file of versions. Read-only — nothing is written back. */
async function seedFromFile(store, file) {
  const resolved = path.resolve(file);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const versions = Array.isArray(parsed) ? parsed : parsed.versions;
  if (!Array.isArray(versions)) throw new Error(`${resolved} must hold an array of versions, or { versions: [...] }`);
  for (const version of versions) await store.putVersion(version);
}

(async () => {
  const store = createInMemoryBlueprintStore();
  const now = () => new Date();

  try {
    if (wants("--demo")) await seedDemo(store, now);
    const file = valueOf("--store");
    if (file) await seedFromFile(store, file);
  } catch (error) {
    process.stdout.write(`could not load configuration: ${error.message}\n`);
    process.exit(1);
  }

  // Provider references are deployment facts. Supplied here or reported as
  // unresolved by name — never invented.
  const providerRefs = {
    llmId: valueOf("--llm-id"),
    voiceId: valueOf("--voice-id"),
    webhookUrl: valueOf("--webhook-url"),
    agentNamePrefix: valueOf("--agent-prefix") || "aida",
  };

  const consumed = new Set(["--demo", "--store", "--llm-id", "--voice-id", "--webhook-url", "--agent-prefix"]);
  const forCommand = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (consumed.has(argv[i])) { if (argv[i] !== "--demo") i += 1; continue; }
    forCommand.push(argv[i]);
  }

  const { exitCode, lines } = await runClientCommand({ argv: forCommand, store, now, providerRefs });
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(exitCode);
})();
