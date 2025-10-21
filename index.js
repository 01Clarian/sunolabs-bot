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
let phase = "submission"; // "submission", "voting", "cooldown"
let cycleStartTime = null;
let nextPhaseTime = null;
let votingEndTimeout = null;

// === STATE PERSISTENCE ===
const SAVE_FILE = fs.existsSync("/data")
  ? "/data/submissions.json"
  : "./submissions.json";

function saveState() {
  try {
    fs.writeFileSync(
      SAVE_FILE,
      JSON.stringify(
        { submissions, phase, cycleStartTime, nextPhaseTime, potSOL, pendingPayments },
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
    phase = d.phase || "submission";
    cycleStartTime = d.cycleStartTime || null;
    nextPhaseTime = d.nextPhaseTime || null;
    potSOL = d.potSOL || 0;
    pendingPayments = d.pendingPayments || [];
    console.log(
      `📂 State restored — ${submissions.length} submissions, pot: ${potSOL} SOL, phase: ${phase}`
    );
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
    
    console.log(`💰 Updated pot: ${potSOL.toFixed(3)} SOL total, ${prizePool.toFixed(3)} SOL prize pool`);

    // Calculate time remaining in current phase
    const now = Date.now();
    let timeMessage = "";
    
    if (phase === "submission" && cycleStartTime) {
      const timeRemaining = Math.max(0, (cycleStartTime + 5 * 60 * 1000) - now);
      const minutesLeft = Math.ceil(timeRemaining / 60000);
      timeMessage = `⏰ Submissions close in ~${minutesLeft} min`;
    } else if (phase === "voting" && nextPhaseTime) {
      const timeRemaining = Math.max(0, nextPhaseTime - now);
      const minutesLeft = Math.ceil(timeRemaining / 60000);
      timeMessage = `⏰ Voting ends in ~${minutesLeft} min`;
    }

    // Send DM confirmation
    try {
      await bot.sendMessage(
        userId,
        `✅ Payment confirmed — your track is officially entered!\n\n${timeMessage}\n💰 Current prize pool: ${prizePool.toFixed(3)} SOL\n\n📍 https://t.me/sunolabs`
      );
    } catch (e) {
      console.error("⚠️ DM error:", e.message);
    }

    // Post tally update to main channel
    try {
      const paidCount = submissions.filter(s => s.paid).length;
      await bot.sendMessage(
        `@${MAIN_CHANNEL}`,
        `💰 New entry! ${paidCount} track(s) entered\n💵 Prize pool: ${prizePool.toFixed(3)} SOL`
      );
    } catch (e) {
      console.error("⚠️ Main channel post error:", e.message);
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
  
  // Start first cycle immediately if not already in progress
  if (!cycleStartTime || phase === "cooldown") {
    console.log("🚀 Starting initial cycle...");
    setTimeout(() => startNewCycle(), 3000);
  } else {
    console.log(`⏳ Resuming ${phase} phase...`);
  }
});listen(PORT, async () => {
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

  if (phase !== "submission") {
    await bot.sendMessage(userId, `⚠️ Submissions closed — currently in ${phase} phase.`);
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

  // Calculate time remaining in submission window
  const now = Date.now();
  const timeRemaining = cycleStartTime ? Math.max(0, (cycleStartTime + 5 * 60 * 1000) - now) : 5 * 60 * 1000;
  const minutesLeft = Math.ceil(timeRemaining / 60000);

  await bot.sendMessage(
    userId,
    `🎧 Got your track!\n\n*Before it's accepted:*\nPay ≥ 0.01 SOL via the link below. Your wallet will automatically be saved for prize payouts.\n\n👉 [Pay with Solana](${redirectLink})\n\n⏰ Submission window closes in ~${minutesLeft} min\n📍 Submit here: https://t.me/sunolabs`,
    { parse_mode: "Markdown", disable_web_page_preview: true }
  );

  // Store submission without wallet initially
  submissions.push({
    user,
    userId,
    track: msg.audio.file_id,
    title: msg.audio.file_name || "Untitled Track",
    votes: 0,
    voters: [],
    paid: false,
    wallet: null,
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

// === SERVER STARTUP ===
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
  
  // Start first cycle immediately if not already in progress
  if (!cycleStartTime || phase === "cooldown") {
    console.log("🚀 Starting initial cycle...");
    setTimeout(() => startNewCycle(), 3000);
  } else {
    console.log(`⏳ Resuming ${phase} phase...`);
  }
});

// === HEARTBEAT ===
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(
    `⏰ Bot heartbeat — ${new Date().toISOString()} | Phase: ${phase} | Mem: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`
  );
}, 30000);

console.log("✅ SunoLabs Bot initialized with automatic cycles...");

// === START NEW CYCLE ===
async function startNewCycle() {
  console.log("🔄 Starting new submission cycle...");
  
  phase = "submission";
  cycleStartTime = Date.now();
  nextPhaseTime = cycleStartTime + 5 * 60 * 1000; // 5 minutes from now
  saveState();

  const prizePool = potSOL * 0.5;

  // Announce in main channel
  try {
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎬 *New Round Started!*\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ Submit your tracks in the next 5 minutes!\n\n📍 How to enter:\n1️⃣ Send your audio file to @${process.env.BOT_USERNAME || 'sunolabs_bot'}\n2️⃣ Pay 0.01 SOL to confirm\n3️⃣ Your wallet is automatically saved for prizes\n\n🔗 https://t.me/sunolabs`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("❌ Failed to announce new cycle:", err.message);
  }

  // Schedule voting to start in 5 minutes
  setTimeout(() => startVoting(), 5 * 60 * 1000);
}

// === POST SUBMISSIONS ===
async function startVoting() {
  console.log(`📋 Starting voting — Total: ${submissions.length}, Paid: ${submissions.filter(s => s.paid).length}`);
  
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    console.log("🚫 No paid submissions this round — restarting cycle in 1 minute");
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  console.log(`✅ Found ${paidSubs.length} paid submission(s), starting voting...`);
  
  phase = "voting";
  nextPhaseTime = Date.now() + 5 * 60 * 1000; // 5 minutes of voting
  saveState();

  const prizePool = potSOL * 0.5;
  
  // Announce voting in main channel
  try {
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🗳️ *Voting is Now Live!*\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ Vote for your favorite in the next 5 minutes!\n\n👉 Go vote: https://t.me/${CHANNEL}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("❌ Failed to announce voting:", err.message);
  }

  // Post submissions to voting channel
  try {
    await bot.sendMessage(
      `@${CHANNEL}`,
      `🎬 *Voting Round Started!*\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ Voting ends in 5 minutes`,
      { parse_mode: "Markdown" }
    );
    console.log("✅ Posted voting announcement");

    for (const s of paidSubs) {
      console.log(`🎵 Posting submission from ${s.user}...`);
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

    console.log(`✅ Posted all ${paidSubs.length} submissions to voting channel`);
  } catch (err) {
    console.error("❌ Failed to post submissions:", err.message);
  }

  // Schedule winner announcement in 5 minutes
  setTimeout(() => announceWinners(), 5 * 60 * 1000);
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
  console.log(`🏆 Announcing winners — Phase: ${phase}, Submissions: ${submissions.length}`);
  
  phase = "cooldown";
  saveState();
  
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    console.log("🚫 No submissions to announce");
    setTimeout(() => startNewCycle(), 60 * 1000); // 1 min cooldown
    return;
  }

  const sorted = [...paidSubs].sort((a, b) => b.votes - a.votes);
  const prizePool = potSOL * 0.5;
  const treasuryShare = potSOL * 0.5;

  const weights = [0.35, 0.25, 0.2, 0.1, 0.1];
  const numWinners = Math.min(5, sorted.length);
  
  // Build full winner message for voting channel
  let fullMsg = `🏆 *Top Tracks of the Round* 🏆\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n\n`;
  for (let i = 0; i < numWinners; i++) {
    const w = sorted[i];
    const amt = prizePool * weights[i];
    fullMsg += `#${i + 1} ${w.user} — ${w.votes}🔥 — ${amt.toFixed(3)} SOL\n`;
    
    // Send payouts
    if (w.wallet && amt > 0.000001) {
      console.log(`💸 Sending ${amt.toFixed(3)} SOL to ${w.user} (${w.wallet.substring(0, 8)}...)`);
      await sendPayout(w.wallet, amt);
    } else if (!w.wallet) {
      console.warn(`⚠️ No wallet for ${w.user} — cannot send ${amt.toFixed(3)} SOL`);
      fullMsg += `   ⚠️ No wallet provided — prize forfeited\n`;
    }
  }

  // Post full results to voting channel
  try {
    await bot.sendMessage(`@${CHANNEL}`, fullMsg, { parse_mode: "Markdown" });
    console.log("✅ Winners announced in voting channel");
  } catch (err) {
    console.error("❌ Failed to announce winners:", err.message);
  }

  // Post top winner announcement to main channel
  try {
    const winner = sorted[0];
    const winnerAmt = prizePool * weights[0];
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎉 *Congratulations!*\n🏆 Winner: ${winner.user}\n🔥 Votes: ${winner.votes}\n💰 Prize: ${winnerAmt.toFixed(3)} SOL\n\n📊 Total Prize Pool: ${prizePool.toFixed(3)} SOL\n\n✨ Check all winners & full results:\n👉 https://t.me/${CHANNEL}`,
      { parse_mode: "Markdown" }
    );
    console.log("✅ Top winner announced in main channel");
  } catch (err) {
    console.error("❌ Failed to announce in main channel:", err.message);
  }

  // Reset state for next round
  console.log(`🔄 Resetting for next round — Distributed ${prizePool.toFixed(3)} SOL, Retained ${treasuryShare.toFixed(3)} SOL`);
  
  submissions = [];
  potSOL = 0;
  pendingPayments = [];
  saveState();
  
  console.log(`🏦 Retained ${treasuryShare.toFixed(3)} SOL in treasury`);
  console.log(`💸 Distributed ${prizePool.toFixed(3)} SOL to ${numWinners} winner(s)`);
  
  // Wait 1 minute before starting new cycle
  setTimeout(() => startNewCycle(), 60 * 1000);
}

// === TELEGRAM BOT HANDLERS ===
