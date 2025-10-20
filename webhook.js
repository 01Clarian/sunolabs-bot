// webhook.js — lightweight public web service for Solana Pay confirmations
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ✅ Health check
app.get("/", (req, res) => {
  res.send("✅ SunoLabs Webhook is live!");
});

// ✅ Webhook endpoint to receive payment confirmations
app.post("/confirm-payment", async (req, res) => {
  try {
    const { signature, reference, userId, amount } = req.body;
    console.log("✅ Received payment confirmation:", {
      signature,
      reference,
      userId,
      amount,
    });

    // 🔧 Optional: later, you can forward this info to your Telegram bot here.
    // For now, just log it so you see it in Render logs.
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("⚠️ Webhook error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🌐 SunoLabs Webhook running on port ${PORT}`);
});
