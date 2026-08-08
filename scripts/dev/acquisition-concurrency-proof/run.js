// ============================================================================
// M8I CONCURRENCY PROOF - the runner.
//
//   NODE_PATH=../call-recorder/node_modules \
//   M8I_LAQ3_INDEXDEF="CREATE UNIQUE INDEX uq_acq_decisions_prev_hash ON public.acquisition_decisions USING btree (prev_hash)" \
//   node scripts/dev/acquisition-concurrency-proof/run.js
//
// Starts TWO SEPARATE OS PROCESSES at the same instant and checks what the
// database did to them. Neither process knows about the other; there is no
// shared memory, no shared client, no shared connection, and no coordination
// beyond a wall-clock timestamp both were given before either started work.
//
// WHAT WOULD MAKE THIS PROOF WORTHLESS, AND IS THEREFORE ASSERTED:
//   * the two processes reading DIFFERENT heads   -> no contention, C1 fails
//   * B starting after A finished                  -> no overlap,  C3 fails
//   * both INSERTs succeeding                      -> a real fork, C4 fails
//
// APPROVED PERMANENT RESIDUE: exactly 2 rows in acquisition_decisions.
// Asserted at the end against a count taken before the run.
// ============================================================================

const { spawn } = require("child_process");
const path = require("path");
const C = require("./common");
const { readChainState } = require("../../../src/services/acquisition-decision-log");
const { verifyRows } = require("../../../src/services/acquisition-audit");
const { fromDecisionRow } = require("../../../src/services/acquisition-store");

const WRITER = path.join(__dirname, "writer.js");
const LEAD_MS = 3000; // long enough for both children to boot, connect and mint

function startWriter(label, barrier) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, "--label", label, "--at", String(barrier)], {
      cwd: path.join(__dirname, "..", "..", ".."),
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
      process.stdout.write(d.toString());
    });
    child.stderr.on("data", (d) => process.stderr.write(d.toString()));
    child.on("close", (code) => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
      if (code !== 0 || !line) return reject(new Error(`writer ${label} exited ${code} without a result`));
      resolve(JSON.parse(line.slice("RESULT:".length)));
    });
    child.on("error", reject);
  });
}

async function readAll(client) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await client.from("acquisition_decisions").select("*").order("sequence", { ascending: true }).range(from, from + 499);
    if (error) throw new Error(`Read failed: ${error.message}`);
    for (const r of data || []) rows.push(fromDecisionRow(r));
    if ((data || []).length < 500) break;
  }
  return rows;
}

async function main() {
  console.log("=".repeat(74));
  console.log("M8I CONCURRENCY PROOF - two processes, one chain head");
  console.log("=".repeat(74));

  C.requireLaq3Attestation();
  console.log("laq3 attested by index definition. Proceeding.\n");

  const client = C.makeClient();
  const store = C.makeStore(client);

  const before = await readAll(client);
  const beforeState = await readChainState({ store });
  console.log(`before: ${before.length} decision row(s), head seq ${beforeState.sequence}\n`);
  C.check("P0", "the chain verifies BEFORE the proof runs", verifyRows(before).ok === true, "a proof that starts from a broken chain proves nothing");

  const barrier = Date.now() + LEAD_MS;
  console.log(`\nbarrier at ${barrier} (${LEAD_MS}ms from now). Starting both writers.\n`);
  const [a, b] = await Promise.all([startWriter("A", barrier), startWriter("B", barrier)]);

  console.log("");
  console.log("-".repeat(74));

  // ── The premise: genuine contention ──
  C.check("C1", "both processes read the SAME head", a.headHash === b.headHash && a.headSequence === b.headSequence, `A: seq ${a.headSequence}  B: seq ${b.headSequence}`);
  C.check("C2", "both minted a row claiming that head as prev_hash", a.mintedPrevHash === b.mintedPrevHash, `${String(a.mintedPrevHash).slice(0, 32)}...`);

  const overlap = Math.abs(a.firedAt - b.firedAt);
  C.check("C3", "the two INSERTs were in flight together", overlap <= 250 && a.firedAt <= b.landedAt && b.firedAt <= a.landedAt, `fired ${overlap}ms apart; A ${a.firedAt}-${a.landedAt}, B ${b.firedAt}-${b.landedAt}`);

  // ── What the database did ──
  const winners = [a, b].filter((r) => r.won);
  C.check("C4", "EXACTLY ONE first-attempt INSERT survived", winners.length === 1, winners.length === 1 ? `${winners[0].label} won the head` : `${winners.length} winners - the index is not enforcing, the chain may now be FORKED`);
  const losers = [a, b].filter((r) => !r.won);
  C.check("C5", "the other was refused as head_taken, not as a duplicate", losers.length === 1 && losers[0].firstAttempt === "head_taken", losers.map((l) => `${l.label}: ${l.firstAttempt}`).join(", "));

  // ── What the loser did next ──
  if (winners.length === 1 && losers.length === 1) {
    C.check("C6", "the loser re-minted against the WINNER's row", losers[0].finalPrevHash === winners[0].finalEntryHash, `loser follows ${String(losers[0].finalPrevHash).slice(0, 24)}...  winner is ${String(winners[0].finalEntryHash).slice(0, 24)}...`);
    C.check("C7", "the loser's sequence is the winner's plus one", losers[0].finalSequence === winners[0].finalSequence + 1, `winner ${winners[0].finalSequence}, loser ${losers[0].finalSequence}`);
    C.check("C8", "the loser recovered within the retry bound", losers[0].retryAttempts >= 1 && losers[0].retryAttempts <= 5, `${losers[0].retryAttempts} attempt(s)`);
    C.check("C9", "no decision was lost - both processes recorded theirs", Boolean(winners[0].finalEntryHash) && Boolean(losers[0].finalEntryHash), "each process has a durable row");
  }

  // ── What the table looks like afterwards ──
  const after = await readAll(client);
  C.check("C10", "the chain still verifies end to end", verifyRows(after).ok === true, verifyRows(after).ok ? `${after.length} row(s)` : verifyRows(after).message);
  C.check("C11", "exactly 2 rows were added", after.length === before.length + 2, `${before.length} -> ${after.length}`);

  const prevCounts = new Map();
  for (const r of after) prevCounts.set(r.prevHash, (prevCounts.get(r.prevHash) || 0) + 1);
  const forked = [...prevCounts.entries()].filter(([, n]) => n > 1);
  C.check("C12", "no prev_hash has two successors", forked.length === 0, forked.length ? forked.map(([h, n]) => `${h} x${n}`).join(", ") : "one successor per head");

  const sequences = after.map((r) => r.sequence);
  C.check("C13", "the sequence is still gapless from 1", sequences[0] === 1 && sequences.every((s, i) => s === i + 1), `1..${sequences[sequences.length - 1]}`);

  const added = after.slice(before.length);
  C.check("C14", "both new rows are the fictional probe and nothing else", added.every((r) => r.entityId === C.PROBE_ENTITY && r.correlationId === C.PROBE_CORRELATION), added.map((r) => `${r.sequence}:${r.entityId}`).join(", "));

  console.log("");
  console.log("-".repeat(74));
  console.log("PERMANENT DEV RESIDUE FROM THIS RUN");
  for (const r of added) console.log(`  seq ${r.sequence}  ${r.event}  ${r.actor}  ${r.entryHash.slice(0, 24)}...`);
  console.log(`  acquisition_decisions: ${before.length} -> ${after.length}`);
  console.log("  no prospect, phone, evidence, suppression, outcome, queue or qualification row.");

  process.exit(C.summary("M8I CONCURRENCY PROOF") ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
