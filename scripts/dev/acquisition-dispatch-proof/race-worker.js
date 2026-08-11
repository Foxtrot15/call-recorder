#!/usr/bin/env node
// ============================================================================
// E-7B1 DISPATCH PROOF — one worker in a genuine two-process race.
//
//   node race-worker.js <label> <dispatchId> <prospectId> <destination> <startAtMs>
//
// Spawned TWICE by run.js as two separate OS processes with two separate
// database connections. Each busy-waits to a shared wall-clock instant and then
// issues its claim, so the two INSERTs genuinely contend inside Postgres rather
// than being serialised by one event loop.
//
// Prints one line of JSON to stdout. Writes nothing else, and resolves nothing.
// ============================================================================

const path = require("node:path");
const { makeClient, makeDispatchStore, proofDial } = require("./common");

const [label, dispatchId, prospectId, destination, startAtMs] = process.argv.slice(2);

(async () => {
  const root = path.join(__dirname, "..", "..", "..");
  const { claimAuthorisedDial } = require(path.join(root, "src/services/acquisition-dispatch-store"));

  const db = makeClient();
  const store = makeDispatchStore(db);
  const at = new Date().toISOString();

  // Warm the connection so TLS/DNS setup is not part of the race.
  await store.readCallingState();

  // Busy-wait to the agreed instant. Both processes leave this loop together.
  const target = Number(startAtMs);
  while (Date.now() < target) {
    /* spin */
  }

  const startedAt = Date.now();
  const result = await claimAuthorisedDial({
    store,
    dial: proofDial({ dispatchId, prospectId, destination, at }),
    provider: { name: "disabled", live: false },
    claimedBy: `e7b1-${label}`,
    now: () => new Date(),
  });

  process.stdout.write(
    JSON.stringify({
      label,
      code: result.code,
      claimed: result.claimed,
      conflictScope: result.conflictScope,
      message: result.message,
      startedAt,
      finishedAt: Date.now(),
      pid: process.pid,
    }) + "\n"
  );
})().catch((err) => {
  process.stdout.write(JSON.stringify({ label, code: "WORKER_ERROR", message: err.message, pid: process.pid }) + "\n");
  process.exit(1);
});
