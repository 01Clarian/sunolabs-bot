// webhook.js
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("✅ SunoLabs Webhook is live!");
});

app.post("/confirm-payment", async (req, res) => {
  try {
    const { signature, reference, userId, amount } = req.body;
    console.log("✅ Received payment confirmation:", {
      signature,
      reference,
      userId,
      amount,
    });
    process.stdout.write(""); // 👈 flush logs immediately

    const token = process.env.BOT_TOKEN;
    const TELEGRAM_API = `https://api.telegram.org/bot${token}/sendMessage`;

    if (userId) {
      const dm = await fetch(TELEGRAM_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userId,
          text: `✅ Payment confirmed! Signature: ${signature}`,
        }),
      });
      console.log("📨 DM status:", dm.status);
    }

    const CHANNEL = "@sunolabs_submissions";
    const broadcast = await fetch(TELEGRAM_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHANNEL,
        text: `💰 New payment confirmed: ${amount} SOL added to the pot.`,
      }),
    });
    console.log("📣 Channel post status:", broadcast.status);
    process.stdout.write(""); // flush again

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("⚠️ Webhook error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 SunoLabs Webhook running on port ${PORT}`);
  process.stdout.write("");
});

