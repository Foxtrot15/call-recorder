// ============================================================================
// M8I CONCURRENCY PROOF - one writer. Started twice, at the same instant.
//
//   node scripts/dev/acquisition-concurrency-proof/writer.js --label A --at <epochMs>
//
// Not run by hand. run.js starts two of these as SEPARATE OS PROCESSES and
// gives both the same barrier timestamp.
//
// ── WHY A BARRIER, AND NOT "START B WHEN A FINISHES" ────────────────
// Because that would prove nothing. A sequential second writer is the M8H
// restart case, which already passes; what has to be shown is two INSERTs in
// flight against the same head at the same moment. So each process does all of
// its slow work first -- construct the client, read the head, mint the row --
// then spins on the clock until the shared instant, and issues the INSERT with
// nothing else in the way. The two requests leave within milliseconds of each
// other and the timestamps are printed so the overlap can be read rather than
// taken on trust.
//
// ── FOUR PHASES ─────────────────────────────────────────────────────
//   1  read the head                          (both see the same H)
//   2  mint a successor to H                  (both claim prev_hash = H)
//   3  wait for the barrier, then INSERT      (exactly one may survive)
//   4  the loser re-reads, re-mints, appends  (the production retry path)
//
// Phase 4 is appendDecisionSerialised, unchanged -- the point is that the
// recovery being demonstrated is the shipped one, not a special case written
// for the proof.
//
// Emits one line of JSON on stdout, prefixed RESULT:, for run.js to read.
// ============================================================================

const C = require("./common");
const { createAuditLog } = require("../../../src/services/acquisition-audit");
const { appendDecisionSerialised, readChainState } = require("../../../src/services/acquisition-decision-log");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const LABEL = arg("label", "?");
const BARRIER = Number(arg("at", "0"));

const now = () => new Date();
const log = (msg) => console.log(`[${LABEL}] ${msg}`);

async function main() {
  C.requireLaq3Attestation();
  if (!Number.isFinite(BARRIER) || BARRIER <= 0) throw new Error("writer.js needs --at <epoch ms>.");

  const store = C.makeStore(C.makeClient());

  // ── 1. the head, read independently ──
  const state = await readChainState({ store });
  log(`head: seq ${state.sequence}  ${state.entryHash ? state.entryHash.slice(0, 24) : "(genesis)"}...`);

  // ── 2. mint a successor to it ──
  const minted = createAuditLog({ now, initialHead: state.entryHash, initialSequence: state.sequence }).record({
    entityType: "prospect",
    entityId: C.PROBE_ENTITY,
    event: `m8i_concurrency_probe_${LABEL.toLowerCase()}`,
    decision: "record",
    actor: `m8i-proof-${LABEL.toLowerCase()}`,
    actorKind: "system",
    reason: `M8I concurrency proof: process ${LABEL} minted a successor to the head it read, at the same moment as the other process.`,
    correlationId: C.PROBE_CORRELATION,
    detail: { proof: "m8i", process: LABEL, hydratedFromSequence: state.sequence },
  });
  log(`minted seq ${minted.sequence} claiming prev_hash ${minted.prevHash.slice(0, 24)}...`);

  // ── 3. the barrier ──
  //
  // A short sleep to within 25ms, then a spin. Sleeping the whole way leaves
  // the two processes at the mercy of the timer's resolution; spinning the
  // whole way burns a second of CPU for no benefit.
  const remaining = BARRIER - Date.now();
  if (remaining > 25) await new Promise((r) => setTimeout(r, remaining - 25));
  while (Date.now() < BARRIER) { /* spin to the instant */ }

  const firedAt = Date.now();
  const first = await store.appendDecision(minted);
  const landedAt = Date.now();
  log(`INSERT fired at ${firedAt} (barrier ${BARRIER}, drift ${firedAt - BARRIER}ms), answered in ${landedAt - firedAt}ms`);

  const result = {
    label: LABEL,
    headSequence: state.sequence,
    headHash: state.entryHash,
    mintedPrevHash: minted.prevHash,
    mintedSequence: minted.sequence,
    firedAt,
    landedAt,
    firstAttempt: first.created ? "created" : first.conflict || first.reason,
    won: first.created === true,
    finalSequence: null,
    finalPrevHash: null,
    finalEntryHash: null,
    retryAttempts: 0,
  };

  if (first.created) {
    log("WON the head. Row is durable.");
    result.finalSequence = first.decision.sequence;
    result.finalPrevHash = first.decision.prevHash;
    result.finalEntryHash = first.decision.entryHash;
  } else {
    // ── 4. the loser, on the shipped retry path ──
    log(`LOST the head (${result.firstAttempt}). Re-reading and re-minting.`);
    const outcome = await appendDecisionSerialised({
      store,
      now,
      onConflict: ({ attempt }) => log(`  attempt ${attempt} lost; re-reading the head`),
      mint: ({ log: l, head, attempt }) =>
        l.record({
          entityType: "prospect",
          entityId: C.PROBE_ENTITY,
          event: `m8i_concurrency_probe_${LABEL.toLowerCase()}`,
          decision: "record",
          actor: `m8i-proof-${LABEL.toLowerCase()}`,
          actorKind: "system",
          reason: `M8I concurrency proof: process ${LABEL} lost the race for the head and re-minted against the winner's row.`,
          correlationId: C.PROBE_CORRELATION,
          detail: { proof: "m8i", process: LABEL, lostTo: head ? head.entryHash : null, retryAttempt: attempt },
        }),
    });
    if (!outcome.appended) throw new Error(`${LABEL} did not recover: ${JSON.stringify(outcome)}`);
    log(`RECOVERED on attempt ${outcome.attempts}: seq ${outcome.decision.sequence}, following ${outcome.decision.prevHash.slice(0, 24)}...`);
    result.finalSequence = outcome.decision.sequence;
    result.finalPrevHash = outcome.decision.prevHash;
    result.finalEntryHash = outcome.decision.entryHash;
    result.retryAttempts = outcome.attempts;
  }

  console.log(`RESULT:${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(`[${LABEL}] FAILED: ${err.message}`);
  process.exit(1);
});
