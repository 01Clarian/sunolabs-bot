// === IMPORTS ===
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fs from "fs";
import express from "express";
import cors from "cors";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { encodeURL } from "@solana/pay";
import BigNumber from "bignumber.js";

// === TELEGRAM CONFIG ===
const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN not set");
const bot = new TelegramBot(token, { polling: true });
const CHANNEL = "sunolabs_submissions"; // make sure the bot is admin in this channel

// === SOLANA CONFIG ===
const TREASURY = new PublicKey("98tf4zU5WhLmsCt1D4HQH5Ej9C5aFwCz8KQwykmKvDDQ");
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://mainnet.helius-rpc.com/?api-key=f6691497-4961-41e1-9a08-53f30c65bf43";
const connection = new Connection(RPC_URL, "confirmed");

// === STATE ===
let potSOL = 0;
let pendingPayments = []; // { userId, username, reference, confirmed }
let submissions = [];
let phase = "submissions";
let nextRoundTime = null;

// === STATE PERSISTENCE ===
const SAVE_FILE = "./submissions.json";

function saveState() {
  try {
    fs.writeFileSync(
      SAVE_FILE,
      JSON.stringify(
        { submissions, phase, nextRoundTime, potSOL, pendingPayments },
        null,
        2
      )
    );
  } catch (err) {
    console.error("⚠️ Failed to save state:", err.message);
  }
}

function loadState() {
  if (!fs.existsSync(SAVE_FILE)) return;
  try {
    const d = JSON.parse(fs.readFileSync(SAVE_FILE));
    submissions = d.submissions || [];
    phase = d.phase || "submissions";
    nextRoundTime = d.nextRoundTime || null;
    potSOL = d.potSOL || 0;
    pendingPayments = d.pendingPayments || [];
  } catch (e) {
    console.error("⚠️ Failed to load state:", e.message);
  }
}
loadState();

// === EXPRESS SERVER ===
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

// === ROOT HEALTH ===
app.get("/", (_, res) => res.send("✅ SunoLabs Bot Web Service is live!"));

// === PAYMENT CONFIRMATION ===
app.post("/confirm-payment", async (req, res) => {
  try {
    const { signature, reference, userId, amount } = req.body;
    if (!userId || !reference)
      return res.status(400).json({ error: "Missing parameters" });

    console.log("✅ Received payment confirmation:", { reference, amount });

    // Avoid duplicates
    if (pendingPayments.find((p) => p.reference === reference)) {
      return res.json({ ok: true, message: "Already processed" });
    }

    // Record payment
    pendingPayments.push({
      userId,
      username: userId,
      reference,
      confirmed: true,
    });
    potSOL += parseFloat(amount) || 0.01;

    const sub = submissions.find((s) => s.userId === userId);
    if (sub) sub.paid = true;
    saveState();

    // === Telegram Notifications ===
    try {
      await bot.sendMessage(
        userId,
        "✅ Payment confirmed — your track is officially entered!"
      );
      console.log("📨 Sent Telegram DM to user", userId);
    } catch (e) {
      console.error("⚠️ Failed to DM user:", e.message);
    }

    try {
      await bot.sendMessage(
        `@${CHANNEL}`,
        `💰 ${userId} added ${amount} SOL to the pot (${potSOL.toFixed(
          2
        )} SOL total)`
      );
      console.log("📣 Announced payment in channel.");
    } catch (e) {
      console.error("⚠️ Failed to post in channel:", e.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("⚠️ confirm-payment error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.listen(PORT, () =>
  console.log(`🌐 SunoLabs Web Service running on port ${PORT}`)
);

// === TELEGRAM BOT HANDLERS ===
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private" || !msg.audio) return;

  const user = msg.from.username
    ? `@${msg.from.username}`
    : msg.from.first_name || "Unknown";
  const userId = msg.from.id;

  if (phase === "voting") {
    const diff = nextRoundTime ? nextRoundTime - Date.now() : 0;
    const hours = Math.max(0, Math.floor(diff / 3600000));
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Voting is live — submissions closed.\n⏳ Next round opens in *${hours}h*.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (submissions.find((s) => s.userId === userId)) {
    await bot.sendMessage(
      msg.chat.id,
      "⚠️ You already submitted a track this round!",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const reference = Keypair.generate().publicKey;
  const amount = new BigNumber(0.01);

  const redirectLink = `https://sunolabs-redirect.onrender.com/pay?recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference.toBase58()}&userId=${userId}&label=SunoLabs%20Entry&message=Confirm%20entry%20for%20${encodeURIComponent(
    user
  )}`;

  pendingPayments.push({
    userId,
    username: user,
    reference: reference.toBase58(),
    confirmed: false,
  });
  saveState();

  await bot.sendMessage(
    msg.chat.id,
    `🎧 Got your audio track!\n\nBefore it's accepted, please confirm your entry by sending ≥ *0.01 SOL*.\n\n👉 [Tap here to pay with Solana Pay](${redirectLink})\n\nFunds go directly to the community pot.`,
    { parse_mode: "Markdown", disable_web_page_preview: true }
  );

  submissions.push({
    user,
    userId,
    track: msg.audio.file_id,
    title: msg.audio.file_name || "Untitled Track",
    votes: 0,
    voters: [],
    paid: false,
  });
  saveState();
});

// === VOTING ===
bot.on("callback_query", async (q) => {
  const [action, userIdStr] = q.data.split("_");
  const userId = Number(userIdStr);
  const voter = q.from.username || q.from.first_name;
  const entry = submissions.find((s) => s.userId === userId);
  if (!entry) return;

  if (entry.voters.includes(voter))
    return bot.answerCallbackQuery(q.id, { text: "⚠️ You already voted." });

  entry.votes++;
  entry.voters.push(voter);
  saveState();

  const caption = `🎧 ${entry.user} — *${entry.title}*\n🔥 Votes: ${entry.votes}`;
  try {
    await bot.editMessageCaption(caption, {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Vote", callback_data: `vote_${entry.userId}` }],
        ],
      },
    });
  } catch (err) {
    console.error("⚠️ Failed to edit message caption:", err.message);
  }
  bot.answerCallbackQuery(q.id, { text: "✅ Vote recorded!" });
});

// === POST SUBMISSIONS ===
async function postSubmissions() {
  const paidSubs = submissions.filter((s) => s.paid);
  if (paidSubs.length === 0) {
    console.log("🚫 No paid submissions.");
    return;
  }

  phase = "voting";
  nextRoundTime = new Date(Date.now() + 12 * 60 * 60 * 1000);
  saveState();

  await bot.sendMessage(
    `@${CHANNEL}`,
    `🎬 *Voting Round Started!*\n💰 Total POT: ${potSOL.toFixed(
      2
    )} SOL\n50% → Winners • 50% → Treasury`,
    { parse_mode: "Markdown" }
  );

  for (const s of paidSubs) {
    try {
      await bot.sendAudio(`@${CHANNEL}`, s.track, {
        caption: `🎧 ${s.user} — *${s.title}*\n🔥 Votes: 0`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔥 Vote", callback_data: `vote_${s.userId}` }],
          ],
        },
      });
      await new Promise((res) => setTimeout(res, 1500));
    } catch (e) {
      console.error(`❌ Failed to post ${s.user}:`, e.message);
    }
  }
  console.log("✅ Posted all paid submissions.");
}

// === ANNOUNCE WINNERS ===
async function announceWinners() {
  const paidSubs = submissions.filter((s) => s.paid);
  if (paidSubs.length === 0) {
    phase = "submissions";
    saveState();
    return;
  }

  const sorted = [...paidSubs].sort((a, b) => b.votes - a.votes);
  const prizePool = potSOL * 0.5;
  const treasuryShare = potSOL * 0.5;
  const first = prizePool * 0.5;
  const second = prizePool * 0.3;
  const third = prizePool * 0.2;

  let msg = `🏆 *Top Tracks of the Day* 🏆\n\n💰 Total Pot: ${potSOL.toFixed(
    2
  )} SOL\nTreasury Share: ${treasuryShare.toFixed(2)} SOL\n\n`;
  if (sorted[0])
    msg += `🥇 ${sorted[0].user} — ${sorted[0].votes}🔥 — ${first.toFixed(
      2
    )} SOL\n`;
  if (sorted[1])
    msg += `🥈 ${sorted[1].user} — ${sorted[1].votes}🔥 — ${second.toFixed(
      2
    )} SOL\n`;
  if (sorted[2])
    msg += `🥉 ${sorted[2].user} — ${sorted[2].votes}🔥 — ${third.toFixed(
      2
    )} SOL\n`;

  await bot.sendMessage(`@${CHANNEL}`, msg, { parse_mode: "Markdown" });

  submissions = [];
  potSOL = 0;
  pendingPayments = [];
  phase = "submissions";
  nextRoundTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
  saveState();
}

// === DAILY CYCLE ===
if (!process.env.CRON_STARTED) {
  process.env.CRON_STARTED = true;
  cron.schedule("0 0 * * *", async () => {
    console.log("🎬 Starting daily cycle…");
    await postSubmissions();
    setTimeout(async () => {
      console.log("🕒 Announcing daily winners…");
      await announceWinners();
    }, 12 * 60 * 60 * 1000);
  });
}

// === HEARTBEAT ===
setInterval(() => {
  console.log("⏰ Bot heartbeat — still alive", new Date().toISOString());
}, 15000);

console.log("✅ SunoLabs Bot (web service mode) running…");
