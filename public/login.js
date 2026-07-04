const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { issueSessionCookie, clearSessionCookie } = require("../middleware/auth");

router.post("/", (req, res) => {
  const password = req.body?.password || "";
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected) {
    console.error("⚠️  DASHBOARD_PASSWORD is not set — login is disabled");
    return res.status(500).json({ error: "Login is not configured yet" });
  }

  const providedBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(expected);
  const match = providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!match) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  try {
    issueSessionCookie(res);
  } catch (err) {
    console.error("⚠️  Could not issue session:", err.message);
    return res.status(500).json({ error: "Login is not configured yet" });
  }

  res.json({ success: true });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

module.exports = router;
