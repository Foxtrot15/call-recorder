// Minimal HTTP client with a per-session cookie jar, built on global fetch
// (Node 18+). Each session is an isolated "browser": the operator session and
// a client session keep separate jars, exactly like two logged-in browsers.
//
// Notes:
// - Cookies are stored regardless of the Secure attribute, so testing an
//   http://localhost target works even though the app sets Secure cookies
//   (a real browser would drop them over http; we don't need to).
// - No Accept header is sent, so requireLogin returns 401 JSON (not an HTML
//   redirect) for unauthenticated API calls — which is what we assert against.
// - Network errors are caught and surfaced as { status: 0, networkError },
//   so an unreachable server yields a clean failure message, not a stack trace.

const { timeoutMs } = require("../config");

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function createSession(baseUrl) {
  const jar = new Map();

  function cookieHeader() {
    if (jar.size === 0) return undefined;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  function storeCookies(headers) {
    for (const raw of readSetCookies(headers)) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || value === "deleted") jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function request(method, path, { body, headers } = {}) {
    const h = { ...(headers || {}) };
    const cookie = cookieHeader();
    if (cookie) h["cookie"] = cookie;

    let payload;
    if (body !== undefined) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(baseUrl + path, {
        method,
        headers: h,
        body: payload,
        redirect: "manual",
        signal: controller.signal,
      });
      storeCookies(res.headers);
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, headers: res.headers, text, json };
    } catch (err) {
      const reason = err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : err.message;
      return { status: 0, networkError: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: (path, opts) => request("GET", path, opts),
    post: (path, body, opts) => request("POST", path, { ...opts, body }),
    hasCookie: (name) => jar.has(name),
  };
}

module.exports = { createSession };
