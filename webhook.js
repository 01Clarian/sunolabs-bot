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

    // ✅ Forward confirmation to the Telegram bot service
    const botUrl = "https://sunolabs-bot.onrender.com/confirm-payment";

    try {
      const fwd = await fetch(botUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature, reference, userId, amount }),
      });

      if (fwd.ok) {
        console.log("📨 Successfully forwarded to Telegram bot ✅");
      } else {
        console.error("⚠️ Bot forward failed:", fwd.status, await fwd.text());
      }
    } catch (err) {
      console.error("⚠️ Error forwarding to bot:", err.message);
    }

    // Respond OK to payment page
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
