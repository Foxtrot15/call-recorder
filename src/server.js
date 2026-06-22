require("dotenv").config();
const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────
app.use("/inbound",  require("./routes/inbound"));
app.use("/outbound", require("./routes/outbound"));
app.use("/recording",require("./routes/recording"));

// ─── Health check ─────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "call-recorder running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
