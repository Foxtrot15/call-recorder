// Unit tests for the invite-token logic (src/services/invite.js).
// invite.js depends only on node's crypto, so this runs without node_modules.
// Security-critical: these tokens gate client signup — verify the guards hold.

const { describe, it, before } = require("node:test");
const assert = require("node:assert");

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "unit-test-secret";
const { createInviteToken, verifyInviteToken } = require("../src/services/invite");

describe("invite tokens", () => {
  it("a freshly minted token verifies and decodes its clientId", () => {
    const token = createInviteToken("acme-plumbing");
    const decoded = verifyInviteToken(token);
    assert.ok(decoded, "token should verify");
    assert.strictEqual(decoded.clientId, "acme-plumbing");
  });

  it("rejects a tampered signature", () => {
    const token = createInviteToken("acme-plumbing");
    const flipped = token.slice(0, -1) + (token.slice(-1) === "0" ? "1" : "0");
    assert.strictEqual(verifyInviteToken(flipped), null);
  });

  it("rejects a forged clientId carrying a stale signature", () => {
    const token = createInviteToken("acme-plumbing");
    const parts = token.split(".");
    const forged = `${parts[0]}.someone-elses-slug.${parts[2]}.${parts[3]}`;
    assert.strictEqual(verifyInviteToken(forged), null);
  });

  it("rejects an expired token", () => {
    const expired = createInviteToken("acme-plumbing", -1000);
    assert.strictEqual(verifyInviteToken(expired), null);
  });

  it("rejects malformed / empty / undefined input without throwing", () => {
    assert.strictEqual(verifyInviteToken("not-a-token"), null);
    assert.strictEqual(verifyInviteToken(""), null);
    assert.strictEqual(verifyInviteToken(undefined), null);
  });

  it("refuses a clientId containing '.' at creation (protects the parser)", () => {
    assert.throws(() => createInviteToken("bad.slug"), /must not contain/);
  });
});

describe("invite tokens fail closed without a secret", () => {
  it("createInviteToken throws when SESSION_SECRET is unset", () => {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      assert.throws(() => createInviteToken("acme"), /SESSION_SECRET/);
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});
