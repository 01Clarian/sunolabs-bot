// === IMPORTS ===
import TelegramBot from "node-telegram-bot-api";
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

// Initialize bot WITHOUT polling - we'll use webhooks
const bot = new TelegramBot(token, { polling: false });

// === Graceful shutdown handlers ===
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`🧹 Graceful shutdown (${signal})...`);
  
  saveState();
  
  console.log("✅ Shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

// Prevent unhandled rejections from crashing
process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ Unhandled Rejection at:", promise, "reason:", reason);
});

const CHANNEL = "sunolabs_submissions"; // Voting channel
const MAIN_CHANNEL = "sunolabs"; // Main announcements channel

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
let phase = "submission";
let cycleStartTime = null;
let nextPhaseTime = null;

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
    mode: "webhook",
    phase,
    submissions: submissions.length,
    potSOL: potSOL.toFixed(4),
    uptime: process.uptime(),
  });
});

// === WEBHOOK ENDPOINT ===
app.post(`/webhook/${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
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
      sub.amountPaid = amountNum;
      
      // Only the base 0.01 goes to prize pool split
      // Everything above 0.01 goes DIRECTLY to treasury
      const basePrize = 0.01 * 0.5;
      const baseTreasury = 0.01 * 0.5;
      const extraDonation = Math.max(0, amountNum - 0.01);
      
      // Calculate multiplier based on amount paid (conservative bonuses)
      if (amountNum >= 0.10) {
        sub.multiplier = 1.10;
        sub.badge = "👑";
        sub.tier = "Patron";
      } else if (amountNum >= 0.05) {
        sub.multiplier = 1.05;
        sub.badge = "💎";
        sub.tier = "Supporter";
      } else {
        sub.multiplier = 1.0;
        sub.badge = "";
        sub.tier = "Basic";
      }
      
      // Store the sender's wallet address for payouts
      if (senderWallet) {
        sub.wallet = senderWallet;
        console.log(`💳 ${sub.tier} entry: ${amountNum} SOL (${basePrize} to pool, ${baseTreasury + extraDonation} to treasury) - ${sub.multiplier}x multiplier`);
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

    // Post tally update to BOTH channels
    try {
      const paidCount = submissions.filter(s => s.paid).length;
      const tallyMsg = `💰 New entry! ${paidCount} track(s) entered\n💵 Prize pool: ${prizePool.toFixed(3)} SOL`;
      
      await bot.sendMessage(`@${MAIN_CHANNEL}`, tallyMsg);
      console.log("✅ Posted tally to main channel");
    } catch (e) {
      console.error("⚠️ Main channel post error:", e.message);
    }

    try {
      const paidCount = submissions.filter(s => s.paid).length;
      const tallyMsg = `💰 New entry! ${paidCount} track(s) entered\n💵 Prize pool: ${prizePool.toFixed(3)} SOL`;
      
      await bot.sendMessage(`@${CHANNEL}`, tallyMsg);
      console.log("✅ Posted tally to voting channel");
    } catch (e) {
      console.error("⚠️ Voting channel post error:", e.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("💥 confirm-payment error:", err.stack || err);
    res.status(500).json({ error: "Internal server error" });
  }
});

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

// === START NEW CYCLE ===
async function startNewCycle() {
  console.log("🔄 Starting new submission cycle...");
  
  // Clean up any old unpaid submissions from previous cycle
  const unpaidCount = submissions.filter(s => !s.paid).length;
  if (unpaidCount > 0) {
    console.log(`🧹 Cleaning up ${unpaidCount} unpaid submission(s) from previous cycle`);
  }
  
  phase = "submission";
  cycleStartTime = Date.now();
  nextPhaseTime = cycleStartTime + 5 * 60 * 1000;
  saveState();

  const prizePool = potSOL * 0.5;
  const botUsername = process.env.BOT_USERNAME || 'sunolabs_bot';
  
  const mainChannelMsg = `🎬 NEW COMPETITION CYCLE STARTED!\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ 5 minutes to submit your track!\n\n🎮 How to Play:\n• Send your audio track to the bot\n• Pay 0.01 SOL to enter\n• Your wallet auto-saved for prizes\n• Vote for your favorites\n• Winners get SOL prizes!\n\n🏆 Prize Split:\n• 1st Place: 35 percent\n• 2nd Place: 25 percent\n• 3rd Place: 20 percent\n• 4th Place: 10 percent\n• 5th Place: 10 percent\n\nStart here: @${botUsername}`;

  const votingChannelMsg = `🎬 *New Round Started!*\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ Submit your tracks in the next 5 minutes!\n\nSend your audio to the bot and pay 0.01 SOL to enter!`;

  try {
    await bot.sendMessage(`@${MAIN_CHANNEL}`, mainChannelMsg);
    console.log("✅ Posted cycle start to main channel");
  } catch (err) {
    console.error("❌ Failed to announce in main channel:", err.message);
  }

  try {
    await bot.sendMessage(`@${CHANNEL}`, votingChannelMsg, { parse_mode: "Markdown" });
    console.log("✅ Posted cycle start to voting channel");
  } catch (err) {
    console.error("❌ Failed to announce in voting channel:", err.message);
  }

  setTimeout(() => startVoting(), 5 * 60 * 1000);
}

// === START VOTING ===
async function startVoting() {
  console.log(`📋 Starting voting — Total: ${submissions.length}, Paid: ${submissions.filter(s => s.paid).length}`);
  
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    console.log("🚫 No paid submissions this round — restarting cycle in 1 minute");
    
    // Only post to voting channel, not main channel
    const noSubsMsg = "🚫 No submissions this round — new round starting in 1 minute!";
    try {
      await bot.sendMessage(`@${CHANNEL}`, noSubsMsg);
      console.log("✅ Posted empty round notice to voting channel");
    } catch (err) {
      console.error("❌ Failed to announce empty round:", err.message);
    }
    
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  console.log(`✅ Found ${paidSubs.length} paid submission(s), starting voting...`);
  
  phase = "voting";
  nextPhaseTime = Date.now() + 5 * 60 * 1000;
  saveState();

  const prizePool = potSOL * 0.5;
  
  // Announce voting in MAIN channel - NO MARKDOWN
  try {
    const voteLink = `https://t.me/${CHANNEL}`;
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🗳️ VOTING IS NOW LIVE!\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ 5 minutes to vote!\n🏆 Winners announced after voting ends\n\nGo vote now:\n${voteLink}`
    );
    console.log("✅ Posted voting announcement to main channel");
  } catch (err) {
    console.error("❌ Failed to announce voting in main channel:", err.message);
  }

  // Post submissions to voting channel
  try {
    await bot.sendMessage(
      `@${CHANNEL}`,
      `🎬 *Voting Round Started!*\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ *5 minutes to vote!*\n🏆 Winners announced after voting ends\n\n🔥 Vote for your favorites below!`,
      { parse_mode: "Markdown" }
    );
    console.log("✅ Posted voting announcement to voting channel");

    for (const s of paidSubs) {
      console.log(`🎵 Posting submission from ${s.user}...`);
      const badge = s.badge || "";
      const caption = badge ? `${badge} ${s.user} — *${s.title}*\n🔥 Votes: 0` : `🎧 ${s.user} — *${s.title}*\n🔥 Votes: 0`;
      
      await bot.sendAudio(`@${CHANNEL}`, s.track, {
        caption,
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

  setTimeout(() => announceWinners(), 5 * 60 * 1000);
}

// === ANNOUNCE WINNERS ===
async function announceWinners() {
  console.log(`🏆 Announcing winners — Phase: ${phase}, Submissions: ${submissions.length}`);
  
  phase = "cooldown";
  saveState();
  
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    console.log("🚫 No submissions to announce");
    setTimeout(() => startNewCycle(), 60 * 1000);
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
    const baseAmt = prizePool * weights[i];
    const multiplier = w.multiplier || 1;
    const finalAmt = baseAmt * multiplier;
    
    const badge = w.badge || "🎧";
    const multText = multiplier > 1 ? ` (+${((multiplier - 1) * 100).toFixed(0)}% bonus)` : "";
    fullMsg += `#${i + 1} ${badge} ${w.user} — ${w.votes}🔥 — ${finalAmt.toFixed(3)} SOL${multText}\n`;
    
    // Send payouts
    if (w.wallet && finalAmt > 0.000001) {
      console.log(`💸 Sending ${finalAmt.toFixed(3)} SOL to ${w.user} (${w.wallet.substring(0, 8)}...) [${multiplier}x multiplier]`);
      await sendPayout(w.wallet, finalAmt);
      
      // Send DM confirmation to winner
      try {
        const place = i + 1;
        const ordinal = place === 1 ? "1st" : place === 2 ? "2nd" : place === 3 ? "3rd" : `${place}th`;
        const bonusText = multiplier > 1 ? `\n🎁 Bonus: +${((multiplier - 1) * 100).toFixed(0)}% for ${w.tier} tier!` : "";
        await bot.sendMessage(
          w.userId,
          `🎉 *Congratulations!*\n\nYou placed *${ordinal}* in the competition!\n\n🔥 Votes: ${w.votes}\n💰 Base Prize: ${baseAmt.toFixed(3)} SOL${bonusText}\n💵 Total Prize: ${finalAmt.toFixed(3)} SOL\n\n✅ Payment sent to:\n${w.wallet}\n\nCheck your wallet! 🎊`,
          { parse_mode: "Markdown" }
        );
        console.log(`✅ Sent prize notification DM to ${w.user}`);
      } catch (dmErr) {
        console.error(`⚠️ Failed to send DM to ${w.user}:`, dmErr.message);
      }
    } else if (!w.wallet) {
      console.warn(`⚠️ No wallet for ${w.user} — cannot send ${finalAmt.toFixed(3)} SOL`);
      fullMsg += `   ⚠️ No wallet provided — prize forfeited\n`;
      
      // Notify user they missed out
      try {
        await bot.sendMessage(
          w.userId,
          `⚠️ You won ${finalAmt.toFixed(3)} SOL but we don't have your wallet address!\n\nNext time, make sure to pay via the Solana link so we can save your wallet for prizes.`
        );
      } catch (dmErr) {
        console.error(`⚠️ Failed to send wallet warning DM to ${w.user}`);
      }
    }
  }

  // Post full results to voting channel
  try {
    await bot.sendMessage(`@${CHANNEL}`, fullMsg, { parse_mode: "Markdown" });
    console.log("✅ Winners announced in voting channel");
  } catch (err) {
    console.error("❌ Failed to announce winners in voting channel:", err.message);
  }

  // Post top winner announcement to MAIN channel - NO MARKDOWN
  try {
    const winner = sorted[0];
    const winnerAmt = prizePool * weights[0] * (winner.multiplier || 1);
    const resultsLink = `https://t.me/${CHANNEL}`;
    const badge = winner.badge || "";
    const winnerMsg = `🎉 CONGRATULATIONS!\n🏆 Winner: ${badge} ${winner.user}\n🔥 Votes: ${winner.votes}\n💰 Prize: ${winnerAmt.toFixed(3)} SOL\n\n📊 Total Prize Pool: ${prizePool.toFixed(3)} SOL\n\nCheck all winners and full results:\n${resultsLink}\n\n⏰ New round starts in 1 minute!`;
    
    await bot.sendMessage(`@${MAIN_CHANNEL}`, winnerMsg);
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
  
  setTimeout(() => startNewCycle(), 60 * 1000);
}

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

  // IMPROVED CHECK: Only block if they have a PAID submission
  const existingPaidSubmission = submissions.find((s) => String(s.userId) === userId && s.paid);
  if (existingPaidSubmission) {
    await bot.sendMessage(userId, "⚠️ You already submitted and paid for this round!");
    return;
  }

  // Check if they have an unpaid submission already
  const existingUnpaidSubmission = submissions.find((s) => String(s.userId) === userId && !s.paid);
  if (existingUnpaidSubmission) {
    // They submitted before but didn't pay - allow resubmission
    const reference = Keypair.generate().publicKey;
    const redirectLink = `https://sunolabs-redirect.onrender.com/pay?recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference.toBase58()}&userId=${userId}&label=SunoLabs%20Entry`;

    const now = Date.now();
    const timeRemaining = cycleStartTime ? Math.max(0, (cycleStartTime + 5 * 60 * 1000) - now) : 5 * 60 * 1000;
    const minutesLeft = Math.ceil(timeRemaining / 60000);

    await bot.sendMessage(
      userId,
      `🎧 You already sent a track, but payment is pending!\n\n*Complete your entry:*\nPay ≥ 0.01 SOL via the link below.\n\n👉 [Submit Your Masterpiece](${redirectLink})\n\n⏰ Submission window closes in ~${minutesLeft} min`,
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );

    // Update the existing submission with new reference
    pendingPayments.push({
      userId,
      username: user,
      reference: reference.toBase58(),
      confirmed: false,
    });
    saveState();
    return;
  }

  // New submission - create it
  const reference = Keypair.generate().publicKey;
  const redirectLink = `https://sunolabs-redirect.onrender.com/pay?recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference.toBase58()}&userId=${userId}&label=SunoLabs%20Entry`;

  pendingPayments.push({
    userId,
    username: user,
    reference: reference.toBase58(),
    confirmed: false,
  });
  saveState();

  const now = Date.now();
  const timeRemaining = cycleStartTime ? Math.max(0, (cycleStartTime + 5 * 60 * 1000) - now) : 5 * 60 * 1000;
  const minutesLeft = Math.ceil(timeRemaining / 60000);

  await bot.sendMessage(
    userId,
    `🎧 Got your track!\n\n*Before it's accepted:*\nPay ≥ 0.01 SOL via the link below. Your wallet will automatically be saved for prize payouts.\n\n👉 [Submit Your Masterpiece](${redirectLink})\n\n⏰ Submission window closes in ~${minutesLeft} min`,
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
    wallet: null,
    amountPaid: 0,
    multiplier: 1,
  });
  saveState();
});

// === VOTING ===
bot.on("callback_query", async (q) => {
  try {
    const [, userIdStr] = q.data.split("_");
    const userId = String(userIdStr);
    const voter = String(q.from.id);
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

    const badge = entry.badge || "🎧";
    const caption = `${badge} ${entry.user} — *${entry.title}*\n🔥 Votes: ${entry.votes}`;
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
  
  loadState();
  
  // Set up webhook
  const webhookUrl = `https://sunolabs-bot.onrender.com/webhook/${token}`;
  
  console.log("📡 Setting up webhook...");
  try {
    await bot.deleteWebHook();
    console.log("✅ Cleared any previous webhook");
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const result = await bot.setWebHook(webhookUrl);
    console.log("✅ Webhook set:", result);
    
    const info = await bot.getWebHookInfo();
    console.log("📊 Webhook info:");
    console.log(`  URL: ${info.url}`);
    console.log(`  Pending updates: ${info.pending_update_count}`);
    if (info.last_error_message) {
      console.warn(`  Last error: ${info.last_error_message}`);
    }
  } catch (err) {
    console.error("❌ Failed to set webhook:", err.message);
  }
  
  if (!cycleStartTime || phase === "cooldown") {
    console.log("🚀 Starting initial cycle...");
    setTimeout(() => startNewCycle(), 3000);
  } else {
    console.log(`⏳ Resuming ${phase} phase...`);
    
    const now = Date.now();
    
    if (phase === "submission" && cycleStartTime) {
      const elapsed = now - cycleStartTime;
      const submissionDuration = 5 * 60 * 1000;
      
      if (elapsed >= submissionDuration) {
        console.log("⚠️ Submission phase overdue, starting voting now...");
        setTimeout(() => startVoting(), 1000);
      } else {
        const timeLeft = submissionDuration - elapsed;
        console.log(`⏰ Submission phase has ${Math.ceil(timeLeft / 60000)} min remaining`);
        setTimeout(() => startVoting(), timeLeft);
      }
    } else if (phase === "voting" && nextPhaseTime) {
      const timeLeft = nextPhaseTime - now;
      
      if (timeLeft <= 0) {
        console.log("⚠️ Voting phase overdue, announcing winners now...");
        setTimeout(() => announceWinners(), 1000);
      } else {
        console.log(`⏰ Voting phase has ${Math.ceil(timeLeft / 60000)} min remaining`);
        setTimeout(() => announceWinners(), timeLeft);
      }
    }
  }
});

// === HEARTBEAT ===
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(
    `⏰ Bot heartbeat — ${new Date().toISOString()} | Phase: ${phase} | Mem: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`
  );
}, 30000);

console.log("✅ SunoLabs Bot initialized with webhooks and automatic cycles...");
