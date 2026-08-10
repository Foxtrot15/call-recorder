#!/usr/bin/env node
// AIDA Locksmith Acquisition — durable founder batch approval (E-5).
//
//   node scripts/acquisition-batch.js preview --prospect <id> [--prospect <id> ...]
//   node scripts/acquisition-batch.js approve <batch-key> --by "<name>" --reason "<why>"
//                                             --prospect <id> [--prospect <id> ...]
//   node scripts/acquisition-batch.js show <batch-key>
//   node scripts/acquisition-batch.js list [--status approved|withdrawn]
//   node scripts/acquisition-batch.js revoke <batch-key> --by "<name>" --reason "<why>"
//
// ── WHY `approve` MAKES YOU NAME THE PROSPECTS AGAIN ────────────────
// It looks redundant next to the batch key, and it is the whole safety
// property. The key is DERIVED from the membership, so re-deriving it from the
// prospects you name and comparing it against the key you typed is what proves
// the list has not moved since `preview` printed it. If a number changed, or a
// business was added, or one was dropped, the re-derived key differs and this
// command refuses rather than approving something you never saw.
//
// A command that took only a key would be approving a name, and a name can be
// pointed at anything.
//
// ── THIS APPROVES A LIST. IT DOES NOT PERMIT A CALL. ────────────────
// No provider, no network, no dialler, no outreach. An approved batch is a
// dormant record. Every call still has to pass DNCR, suppression, the calling
// window, holidays, the attempt policy, duplicates, lifecycle, campaign and the
// M8E final authorisation gate, all evaluated at the moment of the call, and
// only that gate mints an AuthorisedDial.
//
// ── THERE IS NO AUTOMATIC MODE ──────────────────────────────────────
// No --yes, no --all, no default approver. `--by` and `--reason` are required
// and a system actor is refused by name.
//
// Dev only. It refuses any project that is not dev, before a client exists.

const DEV_REF = "wvwemitmmsdytyutaqbm";

const {
  canonicalBatchIdentity,
  recordBatchApproval,
  loadBatchApproval,
  listBatchApprovals,
  revokeBatchApproval,
  checkDurableFreshness,
  STATUS,
} = require("../src/services/acquisition-batch-approval");
const { normalisePhone } = require("../src/services/acquisition-phone");
const { DEFAULT_CAPS } = require("../src/config/acquisition");

function parseArgs(argv) {
  const first = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  const out = { command: first, id: null, prospects: [], help: !first };
  for (let i = first ? 1 : 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--prospect" || a === "-p") out.prospects.push(argv[++i]);
    else if (a === "--by") out.by = argv[++i];
    else if (a === "--reason" || a === "-r") out.reason = argv[++i];
    else if (a === "--note" || a === "-n") out.note = argv[++i];
    else if (a === "--label" || a === "-l") out.label = argv[++i];
    else if (a === "--campaign") out.campaign = argv[++i];
    else if (a === "--status") out.status = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a && a.startsWith("--")) out.unknown = a;
    else if (!out.id) out.id = a;
  }
  return out;
}

function usage() {
  console.log(`
AIDA locksmith acquisition — founder batch approval (E-5)

  node scripts/acquisition-batch.js preview --prospect <id> [--prospect <id> ...]
  node scripts/acquisition-batch.js approve <batch-key> \\
        --prospect <id> [--prospect <id> ...] \\
        --by "<your name>" --reason "<why>" [--note "..."] [--label "..."]
  node scripts/acquisition-batch.js show <batch-key>
  node scripts/acquisition-batch.js list [--status approved|withdrawn]
  node scripts/acquisition-batch.js revoke <batch-key> --by "<name>" --reason "<why>"

  preview  prints the exact membership and the batch key it hashes to.
           Nothing is written. Run this first and read it.
  approve  re-derives the key from the prospects you name and refuses unless it
           matches the key you typed. Approving the same unchanged batch twice
           is idempotent — the second run writes nothing.

  The maximum batch size is ${DEFAULT_CAPS.maxBatchSize}. A-L9 — who besides the
  founder may approve, and whether a larger batch needs a second approver — is
  an open governance question and this command does not answer it.

Approving a batch does not call anybody, and does not permit a call. Every call
is still decided at the M8E gate against the state of the world at that moment.
`);
}

function store() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("This command needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.");
    process.exit(1);
  }
  if (!url.includes(DEV_REF)) {
    console.error(`REFUSING TO RUN. Batch approval is dev-only (${DEV_REF}); SUPABASE_URL points elsewhere.`);
    process.exit(1);
  }
  const { createSupabaseAcquisitionStore } = require("../src/services/acquisition-store");
  return createSupabaseAcquisitionStore();
}

/**
 * Turn the prospect ids a founder typed into batch members.
 *
 * Reads each prospect and its phones from the store and normalises the number
 * THE SAME WAY the authorisation gate will. A member whose stored number does
 * not normalise to something callable is refused here rather than being
 * approved and then silently failing at the gate.
 */
async function membersFor(s, prospectIds) {
  const members = [];
  const problems = [];
  const seen = new Set();

  for (const rawId of prospectIds) {
    const id = String(rawId || "").trim();
    if (!id) continue;
    if (seen.has(id)) {
      problems.push(`${id} was named twice.`);
      continue;
    }
    seen.add(id);

    const prospect = await s.loadProspect(id);
    if (!prospect) {
      problems.push(`${id} — no such prospect is stored.`);
      continue;
    }
    if (prospect.lifecycle !== "review_approved") {
      // Not a compliance check — the gate does that too. It is here so a founder
      // is not asked to approve a business a human has not yet accepted.
      problems.push(`${id} — "${prospect.businessName}" is ${prospect.lifecycle}, not review_approved. Resolve its review first.`);
      continue;
    }

    const phones = await s.listProspectPhones(id);
    const callable = phones.map((p) => normalisePhone(p.raw)).filter((n) => n.ok && n.callable);
    if (callable.length === 0) {
      problems.push(`${id} — "${prospect.businessName}" has no callable number stored.`);
      continue;
    }

    members.push({ rowId: id, prospectId: id, e164: callable[0].e164, businessName: prospect.businessName, suburb: prospect.suburb, state: prospect.state });
  }

  return { members, problems };
}

function printMembership(identity, members) {
  console.log("");
  console.log("=".repeat(78));
  console.log(`BATCH ${identity.batchKey}`);
  console.log("=".repeat(78));
  console.log(`  businesses  ${identity.recordCount} of a maximum ${identity.maxBatchSize}`);
  console.log(`  hash        ${identity.membershipHash}`);
  if (identity.label) console.log(`  label       ${identity.label}   (not part of the hash)`);
  if (identity.campaignId) console.log(`  campaign    ${identity.campaignId}`);
  console.log("");
  for (const m of identity.members) {
    const extra = members.find((x) => x.rowId === m.rowId) || {};
    console.log(`   · ${(extra.businessName || m.prospectId).padEnd(36)} ${m.e164}`);
    console.log(`     ${m.prospectId}${extra.suburb ? `   ${extra.suburb} ${extra.state || ""}` : ""}`);
  }
  console.log("");
}

const FOOTER = [
  "  Approving this is NOT permission to call any of them. It records that you",
  "  looked at exactly this list and accepted it. Every call is still decided at",
  "  the final gate against DNCR, suppression, calling hours, holidays, the",
  "  attempt policy, duplicates, lifecycle and the campaign, at that moment.",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) return usage();
  if (args.unknown) {
    console.error(`Unknown option "${args.unknown}". See --help.`);
    process.exit(1);
  }

  const now = () => new Date();
  const s = store();

  // ── preview ───────────────────────────────────────────────────────
  if (args.command === "preview") {
    if (args.prospects.length === 0) {
      console.error("Which businesses? Pass --prospect <id> for each one.");
      process.exit(1);
    }
    const { members, problems } = await membersFor(s, args.prospects);
    for (const p of problems) console.error(`  EXCLUDED: ${p}`);

    const identity = canonicalBatchIdentity({ members, label: args.label || null, campaignId: args.campaign || null });
    if (!identity.ok) {
      console.error(`\n  ${identity.message}\n`);
      process.exit(1);
    }
    printMembership(identity, members);

    const already = await checkDurableFreshness({ store: s, identity });
    if (already.unavailable) console.log(`  approval    COULD NOT BE READ: ${already.message}`);
    else if (already.fresh) console.log(`  approval    ALREADY APPROVED — ${already.message}`);
    else console.log(`  approval    NOT YET APPROVED.`);

    console.log("");
    console.log(FOOTER.join("\n"));
    console.log("");
    console.log(`  To approve exactly this, run:`);
    console.log(`    node scripts/acquisition-batch.js approve ${identity.batchKey} \\`);
    for (const m of identity.members) console.log(`      --prospect ${m.prospectId} \\`);
    console.log(`      --by "<your name>" --reason "<why>"`);
    console.log("");
    console.log("  NOTHING WAS WRITTEN.");
    console.log("");
    return;
  }

  // ── approve ───────────────────────────────────────────────────────
  if (args.command === "approve") {
    if (!args.id) {
      console.error("Which batch? Pass the batch key that `preview` printed.");
      process.exit(1);
    }
    if (args.prospects.length === 0) {
      console.error("Name the businesses being approved with --prospect <id>. The key alone is not enough: re-deriving it from the members is what proves the list has not changed since you looked at it.");
      process.exit(1);
    }
    if (!args.by || !args.reason) {
      console.error("An approval needs --by and --reason. There is no automatic mode and no default approver.");
      process.exit(1);
    }

    const { members, problems } = await membersFor(s, args.prospects);
    for (const p of problems) console.error(`  EXCLUDED: ${p}`);

    const identity = canonicalBatchIdentity({ members, label: args.label || null, campaignId: args.campaign || null });
    if (!identity.ok) {
      console.error(`\n  REFUSED: ${identity.message}\n`);
      process.exit(1);
    }

    // ── THE STALENESS CHECK ─────────────────────────────────────────
    if (identity.batchKey !== args.id.trim()) {
      console.error("");
      console.error("  REFUSED — THIS IS NOT THE BATCH YOU ASKED TO APPROVE.");
      console.error(`    you typed        ${args.id.trim()}`);
      console.error(`    these members    ${identity.batchKey}`);
      console.error("");
      console.error("  The businesses, or one of their numbers, changed after the key was printed.");
      console.error("  Run `preview` again, read the new list, and approve the key it gives you.");
      console.error("  Nothing was written.");
      console.error("");
      process.exit(1);
    }

    printMembership(identity, members);
    console.log(`  approving as  ${args.by}`);
    console.log(`  because       ${args.reason}`);
    console.log("");
    console.log(FOOTER.join("\n"));
    console.log("");

    const result = await recordBatchApproval({ store: s, now, identity, approvedBy: args.by, reason: args.reason, note: args.note || null });

    if (!result.ok) {
      console.error(`  REFUSED: ${result.message}`);
      console.error("  Nothing was written.");
      process.exit(1);
    }
    console.log(`  ${result.created ? "RECORDED" : "ALREADY RECORDED"}. ${result.message}`);
    if (!result.created) console.log("  This run wrote nothing — approving the same unchanged batch twice is idempotent.");
    console.log("");
    return;
  }

  // ── show ──────────────────────────────────────────────────────────
  if (args.command === "show") {
    if (!args.id) {
      console.error("Which batch? Pass a batch key.");
      process.exit(1);
    }
    const state = await loadBatchApproval({ store: s, batchKey: args.id });
    if (!state.available) {
      console.error(`  The approval store could not be read: ${state.reason}`);
      console.error("  This is NOT the same as 'not approved'. Nothing about this batch has been established.");
      process.exit(1);
    }
    if (state.status === STATUS.NONE) {
      console.error(`  Nothing has been approved under "${args.id}".`);
      console.error("  If a batch with these businesses was approved before, its membership has changed since —");
      console.error("  a different membership is a different batch and needs its own approval.");
      process.exit(1);
    }

    const a = state.approval || state.previousApproval;
    console.log("");
    console.log("=".repeat(78));
    console.log(`${state.batchKey} — ${state.status.toUpperCase()}`);
    console.log("=".repeat(78));
    console.log(`  approved by   ${a.approvedBy} (${a.approverKind})`);
    console.log(`  approved at   ${a.approvedAt}`);
    console.log(`  because       ${a.reason}`);
    if (a.note) console.log(`  note          ${a.note}`);
    console.log(`  hash          ${a.membershipHash}`);
    console.log(`  businesses    ${a.recordCount}`);
    if (a.label) console.log(`  label         ${a.label}`);
    if (a.campaignId) console.log(`  campaign      ${a.campaignId}`);
    if (state.status === STATUS.WITHDRAWN) {
      console.log("");
      console.log(`  WITHDRAWN by  ${state.withdrawnBy} on ${state.withdrawnAt}`);
      console.log(`  because       ${state.withdrawnReason}`);
      console.log("  The approval is kept, not deleted. It happened.");
    }
    console.log("");
    for (const m of a.members) console.log(`   · ${m.prospectId.padEnd(40)} ${m.e164}`);
    console.log("");
    if (a.authorises) console.log(`  ${a.authorises}`);
    console.log("");
    for (const h of state.history) console.log(`  ${h.at}  ${h.event}  ${h.actor}: ${h.reason}`);
    console.log("");
    return;
  }

  // ── list ──────────────────────────────────────────────────────────
  if (args.command === "list") {
    const listed = await listBatchApprovals({ store: s, status: args.status || null });
    if (!listed.available) {
      console.error(`  The approval store could not be read: ${listed.reason}`);
      process.exit(1);
    }
    console.log("");
    console.log("=".repeat(78));
    console.log(`FOUNDER BATCH APPROVALS — ${listed.batches.length}${args.status ? ` (${args.status})` : ""}`);
    console.log("=".repeat(78));
    if (listed.batches.length === 0) {
      console.log("\n  Nothing has been approved.\n");
      return;
    }
    for (const b of listed.batches) {
      const a = b.approval || b.previousApproval;
      console.log("");
      console.log(`  ${b.batchKey}   ${b.status.toUpperCase()}`);
      console.log(`    ${a.recordCount} business${a.recordCount === 1 ? "" : "es"}${a.label ? `   "${a.label}"` : ""}`);
      console.log(`    approved by ${a.approvedBy} on ${a.approvedAt}`);
      if (b.status === STATUS.WITHDRAWN) console.log(`    withdrawn by ${b.withdrawnBy} on ${b.withdrawnAt}: ${b.withdrawnReason}`);
    }
    console.log("");
    console.log("  None of these permits a call. See `show <batch-key>` for what each covers.");
    console.log("");
    return;
  }

  // ── revoke ────────────────────────────────────────────────────────
  if (args.command === "revoke") {
    if (!args.id) {
      console.error("Which batch? Pass a batch key.");
      process.exit(1);
    }
    if (!args.by || !args.reason) {
      console.error("Withdrawing an approval needs --by and --reason.");
      process.exit(1);
    }
    const result = await revokeBatchApproval({ store: s, now, batchKey: args.id, actor: args.by, reason: args.reason });
    if (!result.ok) {
      console.error(`  REFUSED: ${result.message}`);
      process.exit(1);
    }
    console.log(`\n  ${result.message}`);
    console.log("  The original approval is kept and still readable with `show`.\n");
    return;
  }

  console.error(`Unknown command "${args.command}". See --help.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`\nThe batch command failed: ${err.message}`);
  process.exit(1);
});
