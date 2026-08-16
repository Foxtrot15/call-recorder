// AIDA VOICE CONFIGURATION — the local simulator's logic (P45).
//
//   runVoiceCommand({ argv, platform, io }) -> { exitCode, lines[] }
//   COMMANDS / KNOWN_FLAGS / FORBIDDEN_FLAGS / USAGE
//
// Behaviour only — scripts/voice-config.js is the shell. Same split as
// provision-cli.js, so every decision here is testable without spawning a
// process, and the shell can build nothing but fakes.
//
// ── WHAT THIS CANNOT DO ─────────────────────────────────────────────
// There is no microphone, no speech recognition, no telephone and no model.
// It reads typed lines and hands them to the same session engine a real voice
// adapter would use one day. The point is to exercise the CONVERSATION, which
// is the part that decides what happens to a business's configuration.
//
// There is no --live, no --model and no --approve, and each is refused by name
// with a reason rather than reported as an unknown flag.

const { createVoiceSessionEngine, createInMemoryVoiceSessionStore } = require("./voice-session");
const { voicePrincipal } = require("../config-access");

const COMMANDS = Object.freeze(["simulate", "replay", "scenarios", "help"]);
const KNOWN_FLAGS = Object.freeze(["--client", "--scenario", "--say", "--json", "--quiet"]);

/** Flags that must never exist, each with the reason it does not. */
const FORBIDDEN_FLAGS = Object.freeze({
  "--live": "There is no live voice transport in this build. Wiring one is a separate, reviewed milestone.",
  "--model": "No language model is used. The interpreter is deterministic and injected.",
  "--approve": "Approval is a named human decision. A configuration conversation cannot make it.",
  "--activate": "Activation is an operator decision, and no conversation reaches it.",
  "--provision": "Provisioning is a separately authorised operation, not a configuration call.",
  "--retell": "No provider is contacted by anything in this subsystem.",
});

const USAGE = `aida voice-config — simulate a configuration conversation, locally

  scenarios                              list the golden transcripts
  simulate  --client <clientId>          type turns and watch the session
  replay    --scenario <id>              play a golden transcript through the engine

  --say "..."   supply one turn non-interactively (repeatable)
  --json        print the final session state as JSON

  Nothing here contacts a telephone, a speech provider or a language model.
  There is no --live, no --model, no --approve, no --activate and no
  --provision. A session ends at a DRAFT that a person must review.`;

const line = (lines) => (text = "") => lines.push(text);

async function runVoiceCommand({ argv = [], platform, scenarios = [] } = {}) {
  const lines = [];
  const say = line(lines);
  const done = (exitCode) => Object.freeze({ exitCode, lines: Object.freeze(lines) });

  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    say(USAGE);
    return done(0);
  }
  if (!COMMANDS.includes(command)) {
    say(`unknown command "${command}"`, "");
    say(USAGE);
    return done(1);
  }

  const { flags, positional } = parseArgs(rest);

  for (const [flag, why] of Object.entries(FORBIDDEN_FLAGS)) {
    if (flag in flags) { say(`REFUSED: ${flag} does not exist.`, why); return done(1); }
  }
  for (const flag of Object.keys(flags)) {
    if (!KNOWN_FLAGS.includes(flag)) { say(`unknown flag "${flag}"`, "", USAGE); return done(1); }
  }

  if (command === "scenarios") {
    say(`${scenarios.length} golden transcript(s):`, "");
    for (const s of scenarios) say(`  ${s.id.padEnd(36)} ${s.title}`);
    return done(0);
  }

  if (!platform) { say("no platform was supplied — this command needs one."); return done(1); }

  const clientId = flags["--client"] || positional[0];
  const scenario = flags["--scenario"];

  if (command === "replay") {
    const found = scenarios.find((s) => s.id === scenario);
    if (!found) { say(`no scenario "${scenario}". Run "scenarios" to see the list.`); return done(1); }
    return transcript(found.clientId, found.turns, found.title);
  }

  if (!clientId) { say("which client? Pass --client <clientId>."); return done(1); }

  const turns = [].concat(flags["--say"] || []).filter(Boolean);
  return transcript(clientId, turns, null);

  async function transcript(client, turnList, title) {
    const engine = createVoiceSessionEngine({
      configService: platform.configService,
      interpreter: platform.interpreter,
      store: createInMemoryVoiceSessionStore(),
      now: platform.now,
      audit: platform.voiceAudit || null,
    });

    const blueprint = platform.blueprint || null;
    if (title) say(`— ${title} —`, "");

    const started = await engine.start({
      principal: voicePrincipal({ clientId: client, actorId: "simulator" }),
      clientId: client,
      blueprint,
      hasActiveVersion: Boolean(platform.hasActiveVersion),
    });
    say(`Aida > ${started.spoken}`);

    let last = started;
    for (const text of turnList) {
      say(`You  > ${text}`);
      if (typeof platform.now.tick === "function") platform.now.tick(15000);
      last = await engine.hear({ sessionId: started.sessionId, transcript: text });
      say(`Aida > ${last.spoken || last.message}`);
      if (last.state && ["draft_created", "cancelled", "refused"].includes(last.state) && last.ok !== false) break;
    }

    const session = await engine.get({ sessionId: started.sessionId });
    say("");
    say(`state            ${session.state}`);
    say(`proposed changes ${session.proposedChanges.filter((c) => c.state === "confirmed" || c.state === "proposed").length}`);
    say(`unresolved       ${session.unresolved.length}`);
    say(`refused          ${session.refusals.length}${session.refusals.length ? ` (${session.refusals.map((r) => r.reason).join(", ")})` : ""}`);
    say(`draft            ${session.draft ? `version ${session.draft.configVersion}, ${session.draft.status}` : "none"}`);
    say("");
    say("approved  false    active  false    provider changed  false    calling changed  false");
    say("A draft is a proposal. Somebody at the business reviews and approves it before anything changes.");

    if (flags["--json"]) say("", JSON.stringify({
      state: session.state,
      changes: session.proposedChanges.filter((c) => c.state === "confirmed" || c.state === "proposed").map((c) => c.description),
      unresolved: session.unresolved.map((u) => u.question),
      refusals: session.refusals.map((r) => r.reason),
      draft: session.draft,
      approved: false, active: false, providerChanged: false, callingChanged: false,
    }, null, 2));

    return done(0);
  }
}

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) { flags[arg] = true; continue; }
    // --say is repeatable: a conversation has more than one turn.
    if (arg === "--say") { flags[arg] = [].concat(flags[arg] || []).concat(next); }
    else flags[arg] = next;
    i += 1;
  }
  return { flags, positional };
}

module.exports = { runVoiceCommand, parseArgs, COMMANDS, KNOWN_FLAGS, FORBIDDEN_FLAGS, USAGE };
