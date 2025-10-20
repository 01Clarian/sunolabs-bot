// webhook.js
import express from "express";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const QUEUE_PATH = "/data/payments.json";

// ✅ Health
app.get("/", (_, res) => res.send("✅ SunoLabs Webhook is live!"));

// ✅ Payment confirmation → append to queue
app.post("/confirm-payment", async (req, res) => {
  try {
    const { signature, reference, userId, amount } = req.body;
    console.log("✅ Received payment confirmation:", {
      signature,
      reference,
      userId,
      amount,
    });

    // --- Load existing queue or initialize ---
    let queue = [];
    if (fs.existsSync(QUEUE_PATH)) {
      try {
        queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
      } catch (e) {
        console.error("⚠️ Failed to read queue:", e.message);
      }
    }

    // --- Append entry ---
    queue.push({ signature, reference, userId, amount, time: Date.now() });

    // --- Write back to disk ---
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
    console.log("💾 Added payment to queue file:", QUEUE_PATH);

    res.json({ ok: true });
  } catch (err) {
    console.error("⚠️ Webhook error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () =>
  console.log(`🌐 SunoLabs Webhook running on port ${PORT}`)
);
