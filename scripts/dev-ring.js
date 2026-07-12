#!/usr/bin/env node
/**
 * DEV-ONLY ring trigger (M3A): create a Twilio REST call to the dev client
 * identity so the registered emulator app receives a real FCM call invite.
 *
 * No phone number, no webhook, no inbound routing — the call is created
 * directly to `client:client_dev_client` in the DEV subaccount, so nothing
 * here can touch production call flow. Guards, in order:
 *   - refuses without --yes (dry run prints the plan)
 *   - refuses unless VOIP_V2_ENABLED=true (dev-stack signature)
 *   - refuses unless SUPABASE_URL is the known dev project ref (proxy for
 *     "this .env is the dev stack, not production")
 * Reads config from the local .env only; prints SIDs and statuses, never
 * secrets. Lazy-requires twilio per house style.
 */

const DEV_SUPABASE_REF = "wvwemitmmsdytyutaqbm";
const IDENTITY = "client_dev_client"; // services/voip-identity.js clientIdentity("dev-client")
const RING_TIMEOUT_SECONDS = 30;      // caller gives up -> app should see Cancelled

function fail(msg) {
  console.error(`FAILURE: ${msg}`);
  process.exit(1);
}

async function main() {
  require("dotenv").config();
  const confirmed = process.argv.includes("--yes");

  if (process.env.VOIP_V2_ENABLED !== "true") fail("VOIP_V2_ENABLED is not true — refusing (dev stack only).");
  const supabaseUrl = process.env.SUPABASE_URL || "";
  if (!supabaseUrl.includes(DEV_SUPABASE_REF)) {
    fail("SUPABASE_URL is not the known dev project — refusing to ring against this .env.");
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !keySid || !keySecret) fail("TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET missing.");

  if (!confirmed) {
    console.log(
      `DRY RUN OK: would create a call to ${IDENTITY} in account ${accountSid.slice(0, 6)}… ` +
        `(ring timeout ${RING_TIMEOUT_SECONDS}s). Re-run with --yes to ring.`,
    );
    return;
  }

  const twilio = require("twilio");
  const client = twilio(keySid, keySecret, { accountSid });

  const call = await client.calls.create({
    to: `client:${IDENTITY}`,
    from: "client:dev-ring-trigger",
    timeout: RING_TIMEOUT_SECONDS,
    twiml: '<Response><Say>Aida dev ring test.</Say><Pause length="30"/></Response>',
  });
  console.log(`RING: created call ${call.sid} -> client:${IDENTITY}`);

  // Poll to a terminal status so the exit-gate evidence (rejected leg ends /
  // cancel drill) comes from Twilio itself, not inference.
  const TERMINAL = ["completed", "busy", "failed", "no-answer", "canceled"];
  let last = "";
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const c = await client.calls(call.sid).fetch();
    if (c.status !== last) {
      last = c.status;
      console.log(`status: ${c.status}`);
    }
    if (TERMINAL.includes(c.status)) {
      console.log(`TERMINAL: ${c.status} (duration=${c.duration ?? "n/a"}s)`);
      return;
    }
  }
  console.log("gave up polling after 90s (call may still be in progress)");
}

main().catch((e) => fail(e.message));
