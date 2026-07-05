// Central config for the smoke suite. Everything is read from the environment
// so the same suite runs against localhost or the deployed Railway URL.
//
//   SMOKE_BASE_URL        target instance (default http://localhost:3000)
//   DASHBOARD_PASSWORD    operator password — required for authenticated checks
//   SMOKE_CLIENT_EMAIL    optional: enables the positive client-login check
//   SMOKE_CLIENT_PASSWORD optional: paired with the above
//   SMOKE_TIMEOUT_MS      per-request timeout (default 10000)

const rawBase = process.env.SMOKE_BASE_URL || "http://localhost:3000";

module.exports = {
  baseUrl: rawBase.replace(/\/+$/, ""),
  operatorPassword: process.env.DASHBOARD_PASSWORD || "",
  client: {
    email: process.env.SMOKE_CLIENT_EMAIL || "",
    password: process.env.SMOKE_CLIENT_PASSWORD || "",
    get enabled() {
      return Boolean(this.email && this.password);
    },
  },
  timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS) || 10000,
};
