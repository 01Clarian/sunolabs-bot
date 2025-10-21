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

// === TELEGRAM CONFIG ===
const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN not set");

// Initialize bot WITHOUT polling first
const bot = new TelegramBot(token, { polling: false });

// Global error handler for polling
bot.on("polling_error", (error) => {
  console.error("⚠️ Polling error:", error.message);
  if (error.message.includes("409 Conflict")) {
    console.error("❌ CRITICAL: Multiple bot instances detected!");
    console.error("💡 Solution: Stop all other instances and redeploy");
  }
});

// === Graceful shutdown handlers ===
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`🧹 Graceful shutdown (${signal}) — stopping polling...`);
  
  try {
    await bot.stopPolling();
    console.log("✅ Polling stopped cleanly");
  } catch (err) {
    console.error("⚠️ Error stopping polling:", err.message);
  }
  
  saveState();
  process.exit(0);
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

// Prevent unhandled rejections from crashing
process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ Unhandled Rejection at:", promise, "reason:", reason);
});

const CHANNEL = "sunolabs_submissions";

// === SOLANA CONFIG ===
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://mainnet.helius-rpc.com/?api-key=f6691497-4961-41e1-9a08-53f30c65bf43";
const connection = new Connection(RPC_URL, "confirmed");

// === TREASURY CONFIG ===
const TREASURY = new PublicKey("98tf4zU5WhLmsCt1D4HQH5Ej9C5aFwCz8KQwykmKvDDQ");
const TREASURY_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY
  ? Uint8Array.from(JSON.parse(process.env.BOT_PRIVATE_KEY))
  : null;
if (!TREASURY_PRIVATE_KEY)
  throw new Error("❌ BOT_PRIVATE_KEY missing in Render!");
const TREASURY_KEYPAIR = Keypair.fromSecretKey(TREASURY_PRIVATE_KEY);

// === STATE ===
let potSOL = 0;
let pendingPayments = [];
let submissions = [];
let phase = "submissions";
let nextRoundTime = null;
let votingEndTimeout = null; // Track the timeout

// === STATE PERSISTENCE ===
const SAVE_FILE = fs.existsSync("/data")
  ? "/data/submissions.json"
  : "./submissions.json";

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
    console.log(
      `📂 State restored — ${submissions.length} submissions, pot: ${potSOL} SOL, phase: ${phase}`
    );
    
    // If we crashed during voting, handle recovery
    if (phase === "voting" && nextRoundTime) {
      const elapsed = (Date.now() - nextRoundTime) / 1000;
      if (elapsed >= 270) { // 4.5 minutes
        console.log("⚠️ Detected incomplete voting round on restart, announcing winners...");
        setTimeout(() => announceWinners(), 5000); // Give bot time to start
      }
    }
  } catch (e) {
    console.error("⚠️ Failed to load:", e.message);
  }
}

// === EXPRESS SERVER ===
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

// === ROOT HEALTH ===
app.get("/", (_, res) => {
  res.json({
    status: "✅ SunoLabs Bot Web Service is live!",
    phase,
    submissions: submissions.length,
    potSOL: potSOL.toFixed(4),
    uptime: process.uptime(),
  });
});

// === PAYMENT CONFIRMATION ===
app.post("/confirm-payment", async (req, res) => {
  try {
    const { signature, reference, userId, amount, senderWallet } = req.body;
    if (!userId || !reference) {
      console.warn("⚠️ Missing params:", req.body);
      return res.status(400).json({ error: "Missing parameters" });
    }

    const userKey = String(userId);
    const amountNum = parseFloat(amount) || 0.01;
    
    console.log("✅ Received payment confirmation:", { 
      reference, 
      amount: amountNum, 
      userKey,
      senderWallet: senderWallet?.substring(0, 8) + "...",
      signature: signature?.substring(0, 8) + "..."
    });

    let existing = pendingPayments.find((p) => p.reference === reference);

    if (existing && existing.confirmed) {
      console.log("⚠️ Duplicate confirmed reference:", reference);
      return res.json({ ok: true, message: "Already processed" });
    }

    if (existing) {
      existing.confirmed = true;
      console.log("♻️ Marked existing reference as confirmed:", reference);
    } else {
      pendingPayments.push({
        userId: userKey,
        username: userKey,
        reference,
        confirmed: true,
      });
      console.log("🆕 Added new confirmed payment:", reference);
    }

    potSOL += amountNum;

    const sub = submissions.find((s) => String(s.userId) === userKey);
    if (sub) {
      sub.paid = true;
      // Store the sender's wallet address for payouts
      if (senderWallet) {
        sub.wallet = senderWallet;
        console.log(`💳 Stored wallet ${senderWallet.substring(0, 8)}... for user ${userKey}`);
      } else {
        console.warn(`⚠️ No wallet address provided by user ${userKey}`);
      }
      console.log(`💾 Marked submission ${userKey} as paid.`);
    } else {
      console.warn(`⚠️ No matching submission found for user ${userKey}.`);
    }

    saveState();

    const prizePool = potSOL * 0.5;

    // Calculate time until next announcement (next 5-min mark + 4.5 min voting)
    const now = new Date();
    const nextCycle = new Date(now);
    nextCycle.setMinutes(Math.ceil(now.getMinutes() / 5) * 5, 0, 0);
    const votingEnd = new Date(nextCycle.getTime() + 4.5 * 60 * 1000);
    const minutesUntilWinner = Math.ceil((votingEnd - now) / 60000);

    // Send DM confirmation with timer
    try {
      await bot.sendMessage(
        userId,
        `✅ Payment confirmed — your track is officially entered!\n\n⏰ Winner announced in ~${minutesUntilWinner} minutes\n💰 Current prize pool: ${prizePool.toFixed(2)} SOL`
      );
    } catch (e) {
      console.error("⚠️ DM error:", e.message);
    }

    // Post to channel - only show prize pool (50%)
    try {
      await bot.sendMessage(
        `@${CHANNEL}`,
        `💰 New entry! Prize pool now: ${prizePool.toFixed(2)} SOL`
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

// Start server first, then bot
app.listen(PORT, async () => {
  console.log(`🌐 SunoLabs Web Service running on port ${PORT}`);
  
  // Load state after server is up
  loadState();
  
  // NOW start polling
  try {
    await bot.startPolling();
    console.log("✅ Telegram bot polling started successfully");
  } catch (err) {
    console.error("❌ Failed to start polling:", err.message);
    process.exit(1);
  }
});

// === TELEGRAM BOT HANDLERS ===
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private" || !msg.audio) return;

  const user = msg.from.username
    ? `@${msg.from.username}`
    : msg.from.first_name || "Unknown";
  const userId = String(msg.from.id);

  if (phase === "voting") {
    await bot.sendMessage(userId, "⚠️ Voting is live — submissions closed.");
    return;
  }

  if (submissions.find((s) => String(s.userId) === userId)) {
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

  // Calculate times for user
  const now = new Date();
  const nextCycle = new Date(now);
  nextCycle.setMinutes(Math.ceil(now.getMinutes() / 5) * 5, 0, 0);
  const votingStart = new Date(nextCycle);
  const votingEnd = new Date(nextCycle.getTime() + 4.5 * 60 * 1000);
  const minutesUntilVoting = Math.ceil((votingStart - now) / 60000);
  const minutesUntilWinner = Math.ceil((votingEnd - now) / 60000);

  await bot.sendMessage(
    userId,
    `🎧 Got your track!\n\n*Before it's accepted:*\nPay ≥ 0.01 SOL via the link below. Your wallet will automatically be saved for prize payouts.\n\n👉 [Pay with Solana](${redirectLink})\n\n⏰ Voting starts in ~${minutesUntilVoting} min\n🏆 Winner announced in ~${minutesUntilWinner} min`,
    { parse_mode: "Markdown", disable_web_page_preview: true }
  );

  // Store submission without wallet initially - will be updated when payment comes through
  submissions.push({
    user,
    userId,
    track: msg.audio.file_id,
    title: msg.audio.file_name || "Untitled Track",
    votes: 0,
    voters: [],
    paid: false,
    wallet: null, // Will be filled when payment is confirmed
  });
  saveState();
});

// === VOTING ===
bot.on("callback_query", async (q) => {
  try {
    const [, userIdStr] = q.data.split("_");
    const userId = String(userIdStr);
    const voter = String(q.from.id); // Use ID instead of username for uniqueness
    const entry = submissions.find((s) => String(s.userId) === userId);
    
    if (!entry) {
      await bot.answerCallbackQuery(q.id, { text: "⚠️ Entry not found" });
      return;
    }

    if (entry.voters.includes(voter)) {
      await bot.answerCallbackQuery(q.id, { text: "⚠️ Already voted." });
      return;
    }

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
      console.error("⚠️ Edit caption failed:", err.message);
    }
    
    await bot.answerCallbackQuery(q.id, { text: "✅ Vote recorded!" });
  } catch (err) {
    console.error("⚠️ Callback query error:", err.message);
    try {
      await bot.answerCallbackQuery(q.id, { text: "❌ Error processing vote" });
    } catch {}
  }
});

// === POST SUBMISSIONS ===
async function postSubmissions() {
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    console.log("🚫 No paid submissions this round.");
    return false;
  }

  phase = "voting";
  nextRoundTime = Date.now();
  saveState();

  const prizePool = potSOL * 0.5; // Only show 50% as prize pool
  
  try {
    await bot.sendMessage(
      `@${CHANNEL}`,
      `🎬 *Voting Round Started!*\n💰 Prize Pool: ${prizePool.toFixed(
        2
      )} SOL\n⏰ Voting ends in ~4.5 minutes`,
      { parse_mode: "Markdown" }
    );

    for (const s of paidSubs) {
      await bot.sendAudio(`@${CHANNEL}`, s.track, {
        caption: `🎧 ${s.user} — *${s.title}*\n🔥 Votes: 0`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔥 Vote", callback_data: `vote_${s.userId}` }],
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 1200));
    }

    console.log("✅ Posted all paid submissions.");
    return true;
  } catch (err) {
    console.error("❌ Failed to post submissions:", err.message);
    return false;
  }
}

// === PAYOUT FUNCTION ===
async function sendPayout(destination, amountSOL) {
  try {
    const lamports = Math.floor(amountSOL * 1e9);
    
    if (lamports <= 0) {
      console.warn(`⚠️ Skipping payout to ${destination} — amount too small`);
      return;
    }
    
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: TREASURY_KEYPAIR.publicKey,
        toPubkey: new PublicKey(destination),
        lamports,
      })
    );
    tx.feePayer = TREASURY_KEYPAIR.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const sig = await connection.sendTransaction(tx, [TREASURY_KEYPAIR]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(
      `💸 Sent ${amountSOL.toFixed(3)} SOL → ${destination} (tx: ${sig})`
    );
  } catch (err) {
    console.error(`⚠️ Payout failed for ${destination}:`, err.message);
  }
}

// === ANNOUNCE WINNERS ===
async function announceWinners() {
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    console.log("🚫 No submissions to announce");
    phase = "submissions";
    nextRoundTime = null;
    saveState();
    return;
  }

  const sorted = [...paidSubs].sort((a, b) => b.votes - a.votes);
  const prizePool = potSOL * 0.5; // This is what winners split
  const treasuryShare = potSOL * 0.5; // This stays in treasury

  const weights = [0.35, 0.25, 0.2, 0.1, 0.1];
  
  // Build winner message - only show prize pool (not full pot)
  let msg = `🏆 *Top Tracks of the Round* 🏆\n💰 Prize Pool: ${prizePool.toFixed(2)} SOL\n\n`;

  const numWinners = Math.min(5, sorted.length);
  
  for (let i = 0; i < numWinners; i++) {
    const w = sorted[i];
    const amt = prizePool * weights[i];
    msg += `#${i + 1} ${w.user} — ${w.votes}🔥 — ${amt.toFixed(3)} SOL\n`;
    
    // Actually send the payout
    if (amt > 0.000001) { // Only if meaningful amount
      await sendPayout(w.wallet, amt);
    }
  }

  try {
    await bot.sendMessage(`@${CHANNEL}`, msg, { parse_mode: "Markdown" });
    console.log("✅ Winners announced successfully");
  } catch (err) {
    console.error("❌ Failed to announce winners:", err.message);
  }

  // Reset state for next round
  submissions = [];
  potSOL = 0;
  pendingPayments = [];
  phase = "submissions";
  nextRoundTime = null;
  saveState();
  
  console.log(`🏦 Retained ${treasuryShare.toFixed(3)} SOL in treasury`);
  console.log(`💸 Distributed ${prizePool.toFixed(3)} SOL to ${numWinners} winner(s)`);
}

// === 5-MINUTE CYCLE (POST + RESULTS) ===
cron.schedule("*/5 * * * *", async () => {
  console.log("🎬 5-minute cycle triggered —", new Date().toISOString());
  
  // Clear any existing timeout
  if (votingEndTimeout) {
    clearTimeout(votingEndTimeout);
    votingEndTimeout = null;
  }
  
  const posted = await postSubmissions();

  if (posted) {
    // Schedule winner announcement after 4.5 minutes
    votingEndTimeout = setTimeout(async () => {
      const elapsed = nextRoundTime ? (Date.now() - nextRoundTime) / 1000 : 0;
      if (phase !== "voting" || elapsed < 240) {
        console.log("⏳ Skipping premature announce — voting still active.");
        return;
      }
      console.log("🕒 Voting closed — Announcing winners…");
      await announceWinners();
    }, 4.5 * 60 * 1000);
  }
});

// === HEARTBEAT ===
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(
    `⏰ Bot heartbeat — ${new Date().toISOString()} | Phase: ${phase} | Mem: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`
  );
}, 30000); // Every 30 seconds instead of 15

console.log("✅ SunoLabs Bot initialized with 5-minute cycles and auto payouts…");
