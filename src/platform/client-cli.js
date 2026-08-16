// AIDA PLATFORM — the operator CLI's logic, separated from its shell (P10).
//
//   runClientCommand({ argv, store, now, io })  -> { exitCode, lines[] }
//
// ── WHY THE LOGIC IS NOT IN THE SCRIPT ──────────────────────────────
// scripts/client.js is thirty lines: read argv, call this, print, exit. Every
// decision lives here, where it can be tested without spawning a process,
// without a filesystem and without a clock.
//
// ── WHAT IT DELIBERATELY CANNOT DO ──────────────────────────────────
// There is no `activate` command, and that is not an omission.
//
// Putting a configuration live is the moment a business's telephone starts
// being answered differently, and it should require a person who has read a
// diff — not an operator with shell history and a habit. `approve` exists
// because approval is a record of a named human's decision and the CLI is a
// reasonable place to record one; activation is deliberately left to a caller
// that can show somebody what is about to change.
//
// It also cannot dial, provision, enable, suppress, or reach any compliance
// authority — the boundary ratchets assert that by reading the source.

const { validateBlueprint, emptyBlueprint } = require("./client-blueprint");
const { createBlueprintAuthority } = require("./blueprint-authority");
const { diffBlueprints } = require("./blueprint-diff");
const { compileBehaviourSpec } = require("./behaviour-spec");
const { compileRetellPreview } = require("./provider-compiler-retell");

const COMMANDS = Object.freeze(["init", "validate", "diff", "preview", "versions", "approve", "help"]);

const USAGE = [
  "aida client — inspect and prepare a client's configuration",
  "",
  "  init      <clientId> <vertical>              a valid-shaped starting point",
  "  validate  <clientId> [--version N]           check a version, and say what is wrong",
  "  diff      <clientId> --from N --to N         what changed, in words",
  "  preview   <clientId> [--version N]           what the assistant would be told",
  "  versions  <clientId>                         the history",
  "  approve   <clientId> --version N --by NAME   record a person's approval",
  "",
  "  Nothing here activates a configuration. Putting words live should require",
  "  somebody who has read a diff, not an operator with shell history.",
].join("\n");

/** `--from 3 --to 4 --by "Peter Dang"` -> { from: "3", to: "4", by: "Peter Dang" } */
function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[name] = true;
      else { flags[name] = next; i += 1; }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const asVersion = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Renders whatever a command produced. Nothing here decides anything. */
function renderValidation(result, label) {
  const lines = [];
  if (result.ok) {
    lines.push(`${label}: VALID`);
  } else {
    lines.push(`${label}: INVALID — ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`);
    for (const e of result.errors) lines.push(`  error   ${e.path}: ${e.message}`);
  }
  for (const w of result.warnings || []) lines.push(`  warning ${w.path}: ${w.message}`);
  return lines;
}

async function runClientCommand({ argv = [], store, now, providerRefs = {} } = {}) {
  const lines = [];
  const say = (...text) => lines.push(...text);
  const done = (exitCode) => Object.freeze({ exitCode, lines: Object.freeze(lines) });

  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    say(USAGE);
    return done(command ? 0 : 1);
  }
  if (!COMMANDS.includes(command)) {
    say(`unknown command "${command}"`, "", USAGE);
    return done(1);
  }

  const { flags, positional } = parseFlags(rest);
  const clientId = positional[0];
  if (!clientId) {
    say(`${command} needs a clientId`, "", USAGE);
    return done(1);
  }

  // `init` is the only command that needs neither a store nor a clock.
  if (command === "init") {
    const vertical = positional[1];
    if (!vertical) {
      say("init needs a vertical, e.g. `init northside_locks locksmith`");
      return done(1);
    }
    const blueprint = emptyBlueprint({ clientId, vertical });
    say(JSON.stringify(blueprint, null, 2));
    return done(0);
  }

  if (!store) { say("no store available"); return done(1); }
  if (typeof now !== "function") { say("no clock available"); return done(1); }
  const authority = createBlueprintAuthority({ store, now });

  /** The version asked for, or the active one, or the latest. */
  async function resolveVersion() {
    const explicit = flags.version !== undefined ? asVersion(flags.version) : null;
    if (flags.version !== undefined && explicit === null) {
      return { error: `--version must be a positive whole number, got "${flags.version}"` };
    }
    if (explicit !== null) {
      const got = await authority.getDraft(clientId, explicit);
      if (!got.ok) return { error: `${clientId} has no version ${explicit}` };
      return { version: got.version };
    }
    const active = await authority.getActiveVersion(clientId);
    if (active.ok) return { version: active.version, note: "using the ACTIVE version" };
    const listed = await authority.listVersions(clientId);
    if (!listed.versions.length) return { error: `${clientId} has no versions at all` };
    const latest = listed.versions[listed.versions.length - 1].configVersion;
    const got = await authority.getDraft(clientId, latest);
    return { version: got.version, note: `no active version — using the latest, v${latest}` };
  }

  if (command === "versions") {
    const listed = await authority.listVersions(clientId);
    if (!listed.versions.length) { say(`${clientId} has no versions`); return done(1); }
    say(`${clientId} — ${listed.versions.length} version${listed.versions.length === 1 ? "" : "s"}`);
    for (const v of listed.versions) {
      const bits = [`v${v.configVersion}`.padEnd(5), v.status.padEnd(11), `created ${v.createdAt || "?"}`];
      if (v.createdBy) bits.push(`by ${v.createdBy}`);
      if (v.approvedBy) bits.push(`approved by ${v.approvedBy}`);
      if (v.activatedAt) bits.push(`activated ${v.activatedAt}`);
      if (v.source) bits.push(`source ${v.source}`);
      say(`  ${bits.join("  ")}`);
    }
    return done(0);
  }

  if (command === "validate") {
    const resolved = await resolveVersion();
    if (resolved.error) { say(resolved.error); return done(1); }
    if (resolved.note) say(resolved.note);
    const result = validateBlueprint(resolved.version);
    say(...renderValidation(result, `${clientId} v${resolved.version.metadata.configVersion}`));
    return done(result.ok ? 0 : 1);
  }

  if (command === "diff") {
    const to = asVersion(flags.to);
    if (to === null) { say("diff needs --to N"); return done(1); }
    const toGot = await authority.getDraft(clientId, to);
    if (!toGot.ok) { say(`${clientId} has no version ${to}`); return done(1); }

    let fromBody = null;
    let fromLabel = "nothing";
    if (flags.from !== undefined) {
      const from = asVersion(flags.from);
      if (from === null) { say(`--from must be a positive whole number, got "${flags.from}"`); return done(1); }
      const fromGot = await authority.getDraft(clientId, from);
      if (!fromGot.ok) { say(`${clientId} has no version ${from}`); return done(1); }
      fromBody = fromGot.version;
      fromLabel = `v${from}`;
    } else {
      const active = await authority.getActiveVersion(clientId);
      if (active.ok) { fromBody = active.version; fromLabel = `the active v${active.version.metadata.configVersion}`; }
    }

    const diff = diffBlueprints(fromBody, toGot.version);
    say(`${clientId}: ${fromLabel} -> v${to}`);
    if (!diff.hasChanges) { say("  no changes"); return done(0); }
    for (const change of diff.changes) say(`  ${change.summary}`);
    say(`  (${diff.summary})`);
    return done(0);
  }

  if (command === "preview") {
    const resolved = await resolveVersion();
    if (resolved.error) { say(resolved.error); return done(1); }
    if (resolved.note) say(resolved.note);

    const validation = validateBlueprint(resolved.version);
    if (!validation.ok) {
      say(...renderValidation(validation, `${clientId} v${resolved.version.metadata.configVersion}`));
      say("", "refusing to preview an invalid configuration — a preview of something that cannot ship is misleading");
      return done(1);
    }

    const { spec, behaviourHash } = compileBehaviourSpec(resolved.version);
    const compiled = compileRetellPreview({ spec, providerRefs });

    say(`${clientId} v${resolved.version.metadata.configVersion} (${resolved.version.metadata.status})`);
    say(`behaviour  ${behaviourHash}`);
    say(`payload    ${compiled.payloadHash}`);
    say(`engine     ${compiled.responseEngineHash}`);
    say(`agent      ${compiled.agentHash}`);
    if (!compiled.ready) {
      // Named, not defaulted — the whole point of the compiler's contract.
      say("", `NOT READY — unresolved: ${compiled.unresolved.join(", ")}`);
      say("These are deployment facts and must be supplied, never guessed.");
    }
    say("", "── the first thing a caller hears ──", compiled.responseEngine.begin_message);
    say("", "── what the assistant is told ──", compiled.responseEngine.general_prompt);
    return done(compiled.ready ? 0 : 1);
  }

  if (command === "approve") {
    const version = asVersion(flags.version);
    if (version === null) { say("approve needs --version N"); return done(1); }
    const by = typeof flags.by === "string" ? flags.by : null;
    if (!by) { say("approve needs --by NAME — an approval without a person is not an approval"); return done(1); }

    const validated = await authority.validateDraft(clientId, version);
    if (!validated.ok) {
      say(`cannot approve ${clientId} v${version}: ${validated.message}`);
      for (const e of validated.errors || []) say(`  error   ${e.path}: ${e.message}`);
      return done(1);
    }

    const approved = await authority.approveDraft({
      clientId,
      configVersion: version,
      approvedBy: by,
      reason: typeof flags.reason === "string" ? flags.reason : null,
    });
    if (!approved.ok) { say(`cannot approve ${clientId} v${version}: ${approved.message}`); return done(1); }

    say(`${clientId} v${version} APPROVED by ${approved.version.metadata.approvedBy} at ${approved.version.metadata.approvedAt}`);
    say("", "It is NOT live. Activation is a separate decision, made by somebody who has seen the diff.");
    return done(0);
  }

  /* istanbul ignore next — every command in COMMANDS is handled above */
  say(`"${command}" is listed but not implemented`);
  return done(1);
}

module.exports = { runClientCommand, parseFlags, COMMANDS, USAGE };
