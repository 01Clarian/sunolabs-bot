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

    // === Send Telegram confirmation directly (no internal HTTP call)
    const token = process.env.BOT_TOKEN;
    const TELEGRAM_API = `https://api.telegram.org/bot${token}/sendMessage`;

    // ✅ DM the user who paid
    if (userId) {
      try {
        const dm = await fetch(TELEGRAM_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: userId,
            text: "✅ Payment confirmed — your track is officially entered!",
          }),
        });

        if (dm.ok) {
          console.log("📨 Sent Telegram DM to user", userId);
        } else {
          console.error("⚠️ Telegram DM failed:", await dm.text());
        }
      } catch (err) {
        console.error("⚠️ Error sending Telegram DM:", err.message);
      }
    }

    // ✅ Announce in the public channel
    const CHANNEL = "@sunolabs_submissions";
    try {
      const broadcast = await fetch(TELEGRAM_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHANNEL,
          text: `💰 New payment confirmed!\nAmount: ${amount} SOL\nSignature: ${signature}\nReference: ${reference}`,
        }),
      });

      if (broadcast.ok) {
        console.log("📣 Announced payment in channel.");
      } else {
        console.error("⚠️ Telegram broadcast failed:", await broadcast.text());
      }
    } catch (err) {
      console.error("⚠️ Error broadcasting to channel:", err.message);
    }

    // ✅ Always respond OK to caller
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

