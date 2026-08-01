// AIDA — isolated browser web-call harness (M7C, Proof C).
//
// The smallest thing that proves AIDA'S OWN browser path: a page asks AIDA's
// backend for a web call, the backend creates it through the existing shared
// Retell adapter, the token comes back to that browser and only that browser,
// and the official browser SDK joins the intended agent.
//
// ─── WHY THIS IS NOT A ROUTE IN THE APP ─────────────────────────────
// It is a standalone server the sandbox script starts and stops. Mounting it in
// src/server.js would create a production route whose only defence was a flag,
// and "the flag was off" is a weaker guarantee than "the code is not deployed".
// This binds to 127.0.0.1, lives for one run, and cannot be reached from
// anywhere else.
//
// ─── THE 30-SECOND WINDOW SHAPES EVERYTHING ─────────────────────────
// A Retell web-call access token is invalidated ~30 seconds after creation
// (docs.retellai.com/deploy/web-call, reviewed 2026-08-01). So the call is NOT
// created when the page loads or when the harness starts — it is created by the
// POST the browser sends the instant the operator clicks, and the SDK joins
// immediately. Any design that mints the token earlier is racing a stopwatch it
// cannot win.
//
// ─── SDK BOUNDARY ───────────────────────────────────────────────────
// The browser SDK (`retell-client-js-sdk`) exists ONLY in the served HTML, as a
// module import in the page. No server module imports it, the domain layer
// never hears of it, and it is not added to package.json — so the historical
// package-lock.json is untouched.
//
// Server-side call creation continues to use the existing native-fetch adapter.
//
// Dep-free: Node's http module and nothing else.

const crypto = require("crypto");
const { randomUUID } = require("crypto");

const HARNESS_VERSION = "retell-browser-harness-2026-08-01";

// Documented token lifetime. Displayed to the operator so the countdown they
// see is the provider's, not a number invented here.
const TOKEN_WINDOW_SECONDS = 30;

// Pinned in the page's import URL. Overridable so a founder can pin an exact
// version once they have confirmed one against the registry.
const DEFAULT_SDK_SPECIFIER = "retell-client-js-sdk@2";

/**
 * Build the browser-safe response.
 *
 * This is the ONLY place a token crosses into an HTTP response, and the shape
 * is deliberately minimal: nothing about the knowledge base, the prompt, the
 * provider request, or any other client. A browser needs four things to join a
 * call and to display which call it joined.
 */
function browserSafeResponse({ callId, agentId, callType, accessToken }) {
  return {
    callId,
    agentId,
    callType,
    accessToken,
    tokenWindowSeconds: TOKEN_WINDOW_SECONDS,
  };
}

/** Everything a diagnostics view may see. Never the token. */
function sanitiseForDisplay(response) {
  return {
    callId: response.callId,
    agentId: response.agentId,
    callType: response.callType,
    // Presence, never the value.
    accessToken: response.accessToken ? "[held in memory, not displayed]" : null,
  };
}

// ── The page ────────────────────────────────────────────────────────

/**
 * A single self-contained page.
 *
 * The harness key arrives in the URL FRAGMENT. A fragment is never sent to a
 * server, so it stays out of request logs and out of any Referer header, while
 * page JavaScript can still read it and send it as a request header.
 */
function renderHarnessPage({ sdkSpecifier = DEFAULT_SDK_SPECIFIER, agentId, language, sandboxNames = {} } = {}) {
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>AIDA internal sandbox — Retell web-call proof</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 46rem; margin: 0 auto; padding: 1.5rem; line-height: 1.5; font-size: 16px; }
  .banner { background: #7a4a06; color: #fff; padding: 0.9rem 1rem; border-radius: 8px; font-weight: 600; }
  .banner small { display: block; font-weight: 400; opacity: 0.9; margin-top: 0.25rem; }
  .card { border: 1px solid #8888; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  button { font: inherit; font-weight: 600; padding: 0.75rem 1.25rem; min-height: 48px;
           border-radius: 8px; border: 1px solid #8888; cursor: pointer; }
  button[disabled] { opacity: 0.5; cursor: default; }
  #start { background: #12507e; color: #fff; border-color: #12507e; }
  #stop { background: #8a2b18; color: #fff; border-color: #8a2b18; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1rem; margin: 0; }
  dt { font-weight: 600; } dd { margin: 0; font-variant-numeric: tabular-nums; }
  .state { font-weight: 700; }
  .err { color: #8a2b18; font-weight: 600; }
  ul.log { list-style: none; padding: 0; max-height: 14rem; overflow-y: auto; font-size: 0.9rem; }
  ul.log li { padding: 0.15rem 0; border-bottom: 1px solid #8883; }
</style>
</head>
<body>

<p class="banner">
  INTERNAL SANDBOX — NOT A CUSTOMER INTERFACE
  <small>This page places a real, billable Retell web call to a temporary test agent.
  It uses fictional demonstration data only. Nothing here touches a client.</small>
</p>

<h1>AIDA browser web-call proof</h1>
<p>This proves AIDA's own path: this page asks the AIDA backend for a web call,
the backend creates it through AIDA's Retell adapter, and this page joins with
the returned token. It is not the Retell dashboard.</p>

<div class="card">
  <dl>
    <dt>Agent</dt><dd id="agent">${esc(agentId || "(supplied at call time)")}</dd>
    <dt>Language</dt><dd>${esc(language || "(from configuration)")}</dd>
    <dt>Agent name</dt><dd>${esc(sandboxNames.agent || "(temporary sandbox agent)")}</dd>
    <dt>State</dt><dd class="state" id="state">idle</dd>
    <dt>Microphone</dt><dd id="mic">not requested</dd>
    <dt>Call ID</dt><dd id="callId">—</dd>
    <dt>Token</dt><dd id="token">—</dd>
  </dl>
</div>

<p>
  <button id="start">Start test call</button>
  <button id="stop" disabled>Disconnect</button>
</p>

<p id="error" class="err" hidden></p>

<div class="card">
  <strong>Event log</strong>
  <ul class="log" id="log"></ul>
</div>

<script type="module">
// The official browser SDK. Loaded here and ONLY here — no server module
// imports it, and it is not in package.json, so package-lock.json is untouched.
import { RetellWebClient } from "https://esm.sh/${esc(sdkSpecifier)}";

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const li = document.createElement("li");
  li.textContent = new Date().toLocaleTimeString() + "  " + msg;
  $("log").prepend(li);
};
const setState = (s) => { $("state").textContent = s; };
const showError = (m) => { $("error").hidden = false; $("error").textContent = m; };

// The harness key travels in the URL fragment, which browsers never send to a
// server. Read once, then removed from the address bar.
const harnessKey = new URLSearchParams(location.hash.slice(1)).get("k") || "";
history.replaceState(null, "", location.pathname);

const client = new RetellWebClient();

client.on("call_started",       () => { setState("connected — microphone live"); $("mic").textContent = "granted"; log("call_started"); });
client.on("call_ready",         () => { setState("connected — agent ready");     log("call_ready"); });
client.on("agent_start_talking",() => { setState("agent speaking");              log("agent_start_talking"); });
client.on("agent_stop_talking", () => { setState("listening");                   log("agent_stop_talking"); });
client.on("call_ended",         () => { setState("ended"); $("start").disabled = false; $("stop").disabled = true; log("call_ended"); });
client.on("error", (e) => {
  // Provider errors may echo request content. Only the message is shown, and
  // anything token-shaped is scrubbed before it reaches the DOM.
  const raw = (e && e.message) ? String(e.message) : "unknown error";
  showError(raw.replace(/[A-Za-z0-9_\\-]{24,}/g, "[redacted]"));
  setState("error");
  client.stopCall();
  $("start").disabled = false; $("stop").disabled = true;
  log("error");
});

$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  $("error").hidden = true;
  setState("requesting call from AIDA…");
  log("POST /api/web-call");

  let token = null;
  try {
    // The call is created NOW, on this click. The token is valid for about
    // ${TOKEN_WINDOW_SECONDS} seconds, so it is used immediately and never stored.
    const res = await fetch("/api/web-call", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aida-sandbox-key": harnessKey },
      body: JSON.stringify({ confirm: true }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body && body.error ? body.error : ("HTTP " + res.status));

    $("callId").textContent = body.callId || "—";
    $("agent").textContent = body.agentId || "—";
    $("token").textContent = "received — in memory only, never stored";
    log("call " + body.callId + " created for agent " + body.agentId);

    token = body.accessToken;
    if (!token) throw new Error("the backend returned no access token");
    if (body.callType && body.callType !== "web_call") throw new Error("unexpected call type: " + body.callType);

    setState("connecting…");
    $("mic").textContent = "requesting permission";
    await client.startCall({ accessToken: token });
    $("stop").disabled = false;
  } catch (err) {
    showError(String(err && err.message ? err.message : err).replace(/[A-Za-z0-9_\\-]{24,}/g, "[redacted]"));
    setState("failed");
    $("start").disabled = false;
  } finally {
    // Drop the reference whether we connected or not. The SDK holds what it
    // needs; nothing else should.
    token = null;
  }
});

$("stop").addEventListener("click", () => {
  log("stopCall()");
  client.stopCall();
  setState("disconnecting…");
  $("stop").disabled = true;
});

// NOTHING happens on load. No call is created until the button is pressed.
log("ready — no call has been created");
</script>
</body>
</html>`;
}

// ── The server ──────────────────────────────────────────────────────

/**
 * Create the harness HTTP server.
 *
 * `createCall` is injected — the harness never talks to a provider itself, it
 * calls back into the sandbox orchestration which owns the adapter.
 */
function createBrowserHarness({
  createCall,
  agentId = null,
  language = null,
  sandboxNames = {},
  sdkSpecifier = DEFAULT_SDK_SPECIFIER,
  logger = console,
  harnessKey = randomUUID(),
} = {}) {
  if (typeof createCall !== "function") throw new Error("the harness needs a createCall function");

  const state = {
    harnessKey,
    callsCreated: 0,
    lastCallId: null,
    lastError: null,
    // One call per run. A harness that can be clicked repeatedly is a harness
    // that quietly spends money.
    maxCalls: 1,
  };

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(payload);
  }

  function authorised(req) {
    const supplied = req.headers["x-aida-sandbox-key"];
    if (typeof supplied !== "string" || supplied.length !== state.harnessKey.length) return false;
    // Constant-time compare: the key is short-lived, but a timing oracle on a
    // localhost service is still free to fix.
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(state.harnessKey));
  }

  const handler = async (req, res) => {
    const url = (req.url || "/").split("?")[0];

    // ── The page. Creates nothing. ─────────────────────────────────
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      const html = renderHarnessPage({ sdkSpecifier, agentId, language, sandboxNames });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      res.end(html);
      return;
    }

    // ── Sanitised state, for diagnostics. Never the token. ─────────
    if (req.method === "GET" && url === "/api/state") {
      json(res, 200, { callsCreated: state.callsCreated, lastCallId: state.lastCallId, lastError: state.lastError, maxCalls: state.maxCalls });
      return;
    }

    // ── Call creation. POST only, authenticated, explicit. ─────────
    if (url === "/api/web-call") {
      if (req.method !== "POST") {
        // A GET must never create a call: a prefetch, a crawler or a reload
        // would spend money without anyone clicking anything.
        json(res, 405, { error: "Use POST. A call is only ever created by an explicit action." });
        return;
      }
      if (!authorised(req)) {
        json(res, 401, { error: "Missing or invalid sandbox key." });
        return;
      }
      if (state.callsCreated >= state.maxCalls) {
        json(res, 429, { error: "This harness creates one call per run. Restart it to make another." });
        return;
      }

      try {
        const result = await createCall();
        if (!result || !result.ok) {
          state.lastError = (result && result.code) || "call_failed";
          json(res, 502, { error: (result && result.message) || "The provider did not create the call." });
          return;
        }

        state.callsCreated += 1;
        state.lastCallId = result.callId;
        // Logged WITHOUT the token. The id is safe; the token never is.
        logger.log(`[harness] web call created: ${result.callId} agent=${result.agentId}`);

        json(res, 201, browserSafeResponse(result));
        return;
      } catch (err) {
        state.lastError = "harness_exception";
        logger.error(`[harness] call creation failed: ${err.message}`);
        json(res, 500, { error: "Could not create the call." });
        return;
      }
    }

    json(res, 404, { error: "Not found." });
  };

  return { handler, state, harnessKey: state.harnessKey, HARNESS_VERSION };
}

/**
 * Start the harness on loopback only.
 *
 * 127.0.0.1 is not a default that could be widened by configuration — it is the
 * only address this ever binds, so the page cannot be reached from the network
 * even if the machine is exposed.
 */
function startBrowserHarness(harness, { port = 0, logger = console } = {}) {
  const http = require("http");
  const server = http.createServer((req, res) => {
    harness.handler(req, res).catch((err) => {
      logger.error(`[harness] unhandled: ${err.message}`);
      try { res.writeHead(500).end("{}"); } catch { /* response already gone */ }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        url: `http://127.0.0.1:${actual}/#k=${harness.harnessKey}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = {
  HARNESS_VERSION,
  TOKEN_WINDOW_SECONDS,
  DEFAULT_SDK_SPECIFIER,
  browserSafeResponse,
  sanitiseForDisplay,
  renderHarnessPage,
  createBrowserHarness,
  startBrowserHarness,
};
