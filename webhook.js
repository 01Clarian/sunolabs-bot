// webhook.js — lightweight public web service for Solana Pay confirmations
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ✅ Health check
app.get("/", (req, res) => {
  res.send("✅ SunoLabs Webhook is live!");
});

// ✅ Main webhook endpoint
app.post("/confirm-payment", async (req, res) => {
  try {
    const { signature, reference, userId, amount } = req.body;
    console.log("✅ Received payment confirmation:", {
      signature,
      reference,
      userId,
      amount,
    });
    process.stdout.write(""); // flush logs to Render immediately

    // ✅ Forward this confirmation to the background worker (the bot)
    const botUrl = "https://sunolabs-bot.onrender.com/update-state";
    const forward = await fetch(botUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature, reference, userId, amount }),
    });

    if (!forward.ok) {
      const errText = await forward.text();
      console.error("⚠️ Forward to bot failed:", forward.status, errText);
      return res.status(500).json({ error: "Failed to notify bot" });
    }

    console.log("📨 Successfully forwarded payment to bot service ✅");
    process.stdout.write(""); // flush again
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("⚠️ Webhook error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🌐 SunoLabs Webhook running on port ${PORT}`);
  process.stdout.write("");
});

