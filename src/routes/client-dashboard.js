const express = require("express");
const router = express.Router();
const { requireClientAuth } = require("../middleware/auth");
const { listContacts } = require("../services/contacts");

// GET /client-dashboard/contacts
// clientId comes from the verified session (req.clientId) — never from
// the request itself, so a client can't ask for another client's data.
router.get("/contacts", requireClientAuth, async (req, res) => {
  try {
    const contacts = await listContacts(req.clientId);
    res.json({ contacts, businessName: req.client.name });
  } catch (err) {
    console.error("Client contacts fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
