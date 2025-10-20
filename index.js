// === IMPORTS ===
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fs from "fs";
import express from "express";
import cors from "cors";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import BigNumber from "bignumber.js";

// === TELEGRAM CONFIG ===
const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN not set");
const bot = new TelegramBot(token, { polling: true });
const CHANNEL = "sunolabs_submissions"; // ensure bot is admin in channel

// === SOLANA CONFIG ===
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://mainnet.helius-rpc.com/?api-key=f6691497-4961-41e1-9a08-53f30c65bf43";
const connection = new Connection(RPC_URL, "confirmed");

// === TREASURY CONFIG ===
// Public treasury address (for UI / on-chain tracking)
const TREASURY = new PublicKey("98tf4zU5WhLmsCt1D4HQH5Ej9C5aFwCz8KQwykmKvDDQ");

// Private key for automated payouts
const TREASURY_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY
  ? Uint8Array.from(JSON.parse(process.env.BOT_PRIVATE_KEY))
  : null;
if (!TREASURY_PRIVATE_KEY)
  throw new Error("❌ BOT_PRIVATE_KEY missing in Render!");
const TREASURY_KEYPAIR = Keypair.fromSecretKey(TREASURY_PRIVATE_KEY);

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
      JSON.stringify({ submissions, phase, nextRoundTime, potSOL, pendingPayments }, null, 2)
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
    console.error("⚠️ Failed to load:", e.message);
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
    if (!userId || !reference) {
      console.warn("⚠️ Missing params:", req.body);
      return res.status(400).json({ error: "Missing parameters" });
    }

    console.log("✅ Received payment confirmation:", { reference, amount, userId });

    // Avoid duplicates
    if (pendingPayments.find((p) => p.reference === reference)) {
      console.log("⚠️ Duplicate reference:", reference);
      return res.json({ ok: true, message: "Already processed" });
    }

    pendingPayments.push({ userId, username: userId, reference, confirmed: true });
    potSOL += parseFloat(amount) || 0.01;

    const sub = submissions.find((s) => s.userId === userId);
    if (sub) sub.paid = true;
    saveState();

    const displayPot = potSOL * 0.5;

    try {
      await bot.sendMessage(userId, "✅ Payment confirmed — your track is officially entered!");
    } catch (e) {
      console.error("⚠️ DM error:", e.message);
    }

    try {
      await bot.sendMessage(
        `@${CHANNEL}`,
        `💰 ${userId} added ${amount} SOL to the pot (${displayPot.toFixed(2)} SOL prize pool)`
      );
    } catch (e) {
      console.error("⚠️ Channel post error:", e.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("💥 confirm-payment error:", err.stack || err);
    res.status(500).json({ error: "Internal server error" });
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
    await bot.sendMessage(userId, "⚠️ Voting is live — submissions closed.");
    return;
  }

  if (submissions.find((s) => s.userId === userId)) {
    await bot.sendMessage(userId, "⚠️ You already submitted this round!");
    return;
  }

  const reference = Keypair.generate().publicKey;
  const redirectLink = `https://sunolabs-redirect.onrender.com/pay?recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference.toBase58()}&userId=${userId}&label=SunoLabs%20Entry`;

  pendingPayments.push({
    userId,
    username: user,
    reference: reference.toBase58(),
    confirmed: false,
  });
  saveState();

  await bot.sendMessage(
    userId,
    `🎧 Got your track!\n\nBefore it's accepted, please confirm entry with ≥ *0.01 SOL*.\n👉 [Tap here to pay with Solana Pay](${redirectLink})`,
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
    wallet: TREASURY.toBase58(), // optional artist wallet later
  });
  saveState();
});

// === VOTING ===
bot.on("callback_query", async (q) => {
  const [, userIdStr] = q.data.split("_");
  const userId = Number(userIdStr);
  const voter = q.from.username || q.from.first_name;
  const entry = submissions.find((s) => s.userId === userId);
  if (!entry) return;

  if (entry.voters.includes(voter))
    return bot.answerCallbackQuery(q.id, { text: "⚠️ Already voted." });

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
        inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.userId}` }]],
      },
    });
  } catch (err) {
    console.error("⚠️ Edit caption failed:", err.message);
  }
  bot.answerCallbackQuery(q.id, { text: "✅ Vote recorded!" });
});

// === POST SUBMISSIONS ===
async function postSubmissions() {
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    console.log("🚫 No paid submissions this round.");
    return;
  }

  phase = "voting";
  saveState();

  const prizePool = potSOL * 0.5;
  await bot.sendMessage(
    `@${CHANNEL}`,
    `🎬 *Voting Round Started!*\n💰 Prize Pool: ${prizePool.toFixed(
      2
    )} SOL\n50 % → Winners • 50 % → Treasury`,
    { parse_mode: "Markdown" }
  );

  for (const s of paidSubs) {
    await bot.sendAudio(`@${CHANNEL}`, s.track, {
      caption: `🎧 ${s.user} — *${s.title}*\n🔥 Votes: 0`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${s.userId}` }]],
      },
    });
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log("✅ Posted all paid submissions.");
}

// === PAYOUT FUNCTION ===
async function sendPayout(destination, amountSOL) {
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: TREASURY_KEYPAIR.publicKey,
        toPubkey: new PublicKey(destination),
        lamports: Math.floor(amountSOL * 1e9),
      })
    );
    tx.feePayer = TREASURY_KEYPAIR.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const sig = await connection.sendTransaction(tx, [TREASURY_KEYPAIR]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`💸 Sent ${amountSOL.toFixed(3)} SOL → ${destination} (tx: ${sig})`);
  } catch (err) {
    console.error("⚠️ Payout failed:", err.message);
  }
}

// === ANNOUNCE WINNERS ===
async function announceWinners() {
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    phase = "submissions";
    saveState();
    return;
  }

  const sorted = [...paidSubs].sort((a, b) => b.votes - a.votes);
  const prizePool = potSOL * 0.5;
  const treasuryShare = potSOL * 0.5;

  const weights = [0.35, 0.25, 0.2, 0.1, 0.1];
  let msg = `🏆 *Top Tracks of the Round* 🏆\n💰 Total Pot: ${potSOL.toFixed(
    2
  )} SOL\n🏦 Treasury Retained: ${treasuryShare.toFixed(2)} SOL\n\n`;

  for (let i = 0; i < Math.min(5, sorted.length); i++) {
    const w = sorted[i];
    const amt = prizePool * weights[i];
    msg += `#${i + 1} ${w.user} — ${w.votes}🔥 — ${amt.toFixed(2)} SOL\n`;
    await sendPayout(w.wallet, amt);
  }

  await bot.sendMessage(`@${CHANNEL}`, msg, { parse_mode: "Markdown" });

  submissions = [];
  potSOL = 0;
  pendingPayments = [];
  phase = "submissions";
  saveState();
  console.log(`🏦 Retained ${treasuryShare.toFixed(2)} SOL in treasury`);
}

// === 5-MINUTE CYCLE (POST + RESULTS) ===
if (!process.env.CRON_STARTED) {
  process.env.CRON_STARTED = true;
  cron.schedule("*/5 * * * *", async () => {
    console.log("🎬 5-minute cycle — Posting submissions now…");
    await postSubmissions();
    setTimeout(async () => {
      console.log("🕒 Voting closed — Announcing winners…");
      await announceWinners();
    }, 5 * 60 * 1000);
  });
}

// === HEARTBEAT ===
setInterval(() => {
  console.log("⏰ Bot heartbeat — still alive ", new Date().toISOString());
}, 15000);

console.log("✅ SunoLabs Bot running with 5-minute cycles and auto payouts…");
