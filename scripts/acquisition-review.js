#!/usr/bin/env node
// AIDA Locksmith Acquisition — the founder review queue (M8H).
//
//   node scripts/acquisition-review.js list [--status open|resolved]
//   node scripts/acquisition-review.js show <review-id>
//   node scripts/acquisition-review.js resolve <review-id> --decision <d> --by <name> --reason "..."
//                                              [--target <prospect-id>]
//
// The ambiguous imported locksmiths, and what a human decides about them.
//
// ── EVERY DECISION IS TYPED BY A PERSON ─────────────────────────────
// There is no --auto, no --approve-all and no heuristic default. The queue
// exists precisely because the classifier could not decide; a command that let
// it decide anyway would be the classifier deciding with extra steps. `--by`
// and `--reason` are required, and a decision is recorded with
// actorKind: "human" against a named person.
//
// ── IT READS AND WRITES DECISIONS. NOTHING ELSE. ────────────────────
// No provider, no network, no dialler, no outreach. Resolving a review does not
// make a business callable: approval is about identity, and permission is
// decided at the M8E authorisation gate from durable suppression state.
//
// Dev only. It refuses any project that is not dev, before a client exists.

const DEV_REF = "wvwemitmmsdytyutaqbm";

const { listReviewItems, loadReviewItem, resolveReviewItem, REVIEW_DECISIONS, STATUS } = require("../src/services/acquisition-review-queue");
const { attachMergedListing } = require("../src/services/acquisition-persist");

function parseArgs(argv) {
  // A leading flag is not a command. `--help` on its own must print help
  // rather than fall through and demand credentials to explain itself.
  const first = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  const out = { command: first, id: null, help: !first };
  for (let i = first ? 1 : 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--status") out.status = argv[++i];
    else if (a === "--decision" || a === "-d") out.decision = argv[++i];
    else if (a === "--by") out.by = argv[++i];
    else if (a === "--reason" || a === "-r") out.reason = argv[++i];
    else if (a === "--target" || a === "-t") out.target = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) out.unknown = a;
    else if (!out.id) out.id = a;
  }
  return out;
}

function usage() {
  console.log(`
AIDA locksmith acquisition — review queue

  node scripts/acquisition-review.js list [--status open|resolved]
  node scripts/acquisition-review.js show <review-id>
  node scripts/acquisition-review.js resolve <review-id> \\
        --decision <${Object.values(REVIEW_DECISIONS).join("|")}> \\
        --by "<your name>" --reason "<why>" [--target <prospect-id>]

  --target is required for ${REVIEW_DECISIONS.MERGE_INTO_EXISTING}.
  ${REVIEW_DECISIONS.NEEDS_MORE_INFORMATION} records a note and leaves the item open.

Every decision names a person and a reason. There is no automatic mode.
Resolving a review does not make a business callable.
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
    console.error(`REFUSING TO RUN. The review queue is dev-only (${DEV_REF}); SUPABASE_URL points elsewhere.`);
    process.exit(1);
  }
  const { createSupabaseAcquisitionStore } = require("../src/services/acquisition-store");
  return createSupabaseAcquisitionStore();
}

const age = (iso, now) => {
  const days = Math.floor((now - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) return usage();
  if (args.unknown) {
    console.error(`Unknown option "${args.unknown}". See --help.`);
    process.exit(1);
  }

  const now = () => new Date();
  const s = store();

  if (args.command === "list") {
    const items = await listReviewItems({ store: s, status: args.status || null });
    const at = Date.now();
    console.log("");
    console.log("=".repeat(78));
    console.log(`ACQUISITION REVIEW QUEUE — ${items.length} item(s)${args.status ? ` (${args.status})` : ""}`);
    console.log("=".repeat(78));
    if (items.length === 0) {
      console.log("\n  Nothing waiting.\n");
      return;
    }

    const open = items.filter((i) => i.status === STATUS.OPEN);
    const byReason = open.reduce((acc, i) => {
      const key = (i.candidate && i.possibleMatches.length ? "possible duplicate" : "needs a decision");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    console.log(`\n  unresolved ${open.length}   ${Object.entries(byReason).map(([k, v]) => `${k}: ${v}`).join("   ")}\n`);

    for (const i of items) {
      const c = i.candidate || {};
      console.log(`  ${i.reviewId}`);
      console.log(`    ${c.businessName || "(no name)"} — ${[c.suburb, c.state, c.postcode].filter(Boolean).join(" ")}`);
      console.log(`    category ${c.tradeCategory || "(none)"}   phones ${(c.phones || []).map((p) => p.raw).join(", ") || "(none)"}`);
      console.log(`    ${i.status.toUpperCase()}   opened ${age(i.openedAt, at)} ago${i.possibleMatches.length ? `   may be ${i.possibleMatches.join(", ")}` : ""}`);
      if (i.status === STATUS.RESOLVED) console.log(`    decided ${i.decision} by ${i.decidedBy}: ${i.decisionReason}`);
      console.log("");
    }
    return;
  }

  if (args.command === "show") {
    if (!args.id) {
      console.error("Which item? Pass a review id.");
      process.exit(1);
    }
    const i = await loadReviewItem({ store: s, reviewId: args.id });
    if (!i) {
      console.error(`No review item "${args.id}".`);
      process.exit(1);
    }
    const c = i.candidate || {};
    console.log("");
    console.log("=".repeat(78));
    console.log(`${i.reviewId} — ${i.status.toUpperCase()}`);
    console.log("=".repeat(78));
    console.log(`  business    ${c.businessName || "(no name)"}`);
    console.log(`  locality    ${[c.suburb, c.state, c.postcode].filter(Boolean).join(" ") || "(unknown)"}`);
    console.log(`  timezone    ${c.timezone || "(none — calling hours cannot be checked)"}`);
    console.log(`  category    ${c.tradeCategory || "(none)"}`);
    console.log(`  phones      ${(c.phones || []).map((p) => p.raw).join(", ") || "(none)"}`);
    console.log(`  origin      ${c.origin || "(unknown)"}`);
    console.log(`  opened      ${i.openedAt}`);
    console.log(`  why         ${i.reason}`);
    if (i.possibleMatches.length) console.log(`  may be      ${i.possibleMatches.join(", ")}`);
    if (i.signals.length) console.log(`  signals     ${i.signals.join(", ")}`);
    if (i.importContext) console.log(`  from        line ${i.importContext.line}, classified ${i.importContext.classification}`);
    if (i.history.length > 1) {
      console.log("\n  history");
      for (const h of i.history) console.log(`    ${h.at}  ${h.event}  ${h.decision}  ${h.actor}: ${h.reason}`);
    }
    console.log("");
    console.log("  Deciding this does not make the business callable. Suppression, DNCR and");
    console.log("  the calling policy all still apply, and the final gate reads them.");
    console.log("");
    return;
  }

  if (args.command === "resolve") {
    if (!args.id) {
      console.error("Which item? Pass a review id.");
      process.exit(1);
    }
    if (!args.decision || !args.by || !args.reason) {
      console.error("A decision needs --decision, --by and --reason. There is no automatic mode.");
      process.exit(1);
    }

    const before = await loadReviewItem({ store: s, reviewId: args.id });
    if (!before) {
      console.error(`No review item "${args.id}".`);
      process.exit(1);
    }

    // SAY WHAT WILL HAPPEN, before it happens.
    console.log("");
    console.log(`  ${args.id} — ${before.candidate.businessName}`);
    console.log(`  decision  ${args.decision} by ${args.by}`);
    if (args.decision === REVIEW_DECISIONS.MERGE_INTO_EXISTING) {
      console.log(`  merging into ${args.target}`);
      console.log(`  will attach  ${(before.candidate.phones || []).map((p) => p.raw).join(", ") || "no numbers"} (only what is genuinely new)`);
    } else if (args.decision === REVIEW_DECISIONS.APPROVE_AS_NEW) {
      console.log(`  will create  a new prospect for this business, unreviewed and unwashed`);
    } else {
      console.log(`  will record  the decision only; no prospect is created`);
    }
    console.log("");

    const r = await resolveReviewItem({
      store: s,
      reviewId: args.id,
      decision: args.decision,
      actor: args.by,
      reason: args.reason,
      mergeTarget: args.target || null,
      now,
    });

    if (!r.ok) {
      console.error(`  ${r.message}`);
      process.exit(1);
    }

    if (args.decision === REVIEW_DECISIONS.MERGE_INTO_EXISTING) {
      const attached = await attachMergedListing({
        canonicalProspectId: args.target,
        candidate: before.candidate,
        evidence: [],
        store: s,
        now,
      });
      console.log(`  ${attached.message}`);
    }

    console.log(`  Recorded. ${r.item.reviewId} is now ${r.item.status}.`);
    console.log("");
    return;
  }

  console.error(`Unknown command "${args.command}". See --help.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`\nThe review command failed: ${err.message}`);
  process.exit(1);
});
