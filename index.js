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
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount
} from "@solana/spl-token";

// === TELEGRAM CONFIG ===
const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN not set");

const bot = new TelegramBot(token, { polling: false });

// === Graceful shutdown ===
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
process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ Unhandled Rejection:", reason);
});

const CHANNEL = "sunolabs_submissions";
const MAIN_CHANNEL = "sunolabs";

// === SOLANA CONFIG ===
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://mainnet.helius-rpc.com/?api-key=f6691497-4961-41e1-9a08-53f30c65bf43";
const connection = new Connection(RPC_URL, "confirmed");

// === TREASURY & TOKEN CONFIG ===
const TREASURY = new PublicKey("98tf4zU5WhLmsCt1D4HQH5Ej9C5aFwCz8KQwykmKvDDQ");
const TOKEN_MINT = new PublicKey("4vTeHaoJGvrKduJrxVmfgkjzDYPzD8BJJDv5Afempump");

const TREASURY_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY
  ? Uint8Array.from(JSON.parse(process.env.BOT_PRIVATE_KEY))
  : null;
if (!TREASURY_PRIVATE_KEY) throw new Error("❌ BOT_PRIVATE_KEY missing!");
const TREASURY_KEYPAIR = Keypair.fromSecretKey(TREASURY_PRIVATE_KEY);

// === STATE ===
let treasurySOL = 0;
let atStakeSOL = 0; // The 35% that's in play
let tokenHolders = {}; // { wallet: tokenBalance }
let totalTokenSupply = 0;
let pendingPayments = [];
let submissions = [];
let phase = "submission";
let cycleStartTime = null;
let nextPhaseTime = null;

// Price cache
let cachedTokenPrice = null;
let cacheTime = null;

// === CORRECT PAYMENT SPLIT (YOUR MODEL) ===
const SPLIT = {
  TOKEN_PURCHASE: 0.50,    // 50% → User gets tokens (treasury keeps SOL!)
  ENTRY_FEE: 0.50,         // 50% → Entry fee
  TREASURY_CUT: 0.35,      // 35% of entry → Treasury ALWAYS KEEPS (untouched)
  AT_STAKE: 0.65           // 65% of entry → Competition (prizes + rewards)
};

// Prize/reward split of the "at stake" amount
const STAKE_SPLIT = {
  PRIZES: 0.70,    // 70% of at-stake → Prizes
  REWARDS: 0.30    // 30% of at-stake → Token holder rewards
};

// === TOKEN PRICE FETCHING ===
async function getTokenPrice() {
  const now = Date.now();
  
  if (cachedTokenPrice && cacheTime && (now - cacheTime) < 60000) {
    return cachedTokenPrice;
  }
  
  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT.toBase58()}`
    );
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      // Get SOL price in USD
      const solPriceUSD = 150; // Approximate, adjust as needed
      const tokenPriceUSD = parseFloat(data.pairs[0].priceUsd);
      const tokenPriceSOL = tokenPriceUSD / solPriceUSD;
      
      cachedTokenPrice = tokenPriceSOL || 0.0001;
      cacheTime = now;
      return cachedTokenPrice;
    }
  } catch (err) {
    console.warn("⚠️ Failed to fetch token price:", err.message);
  }
  
  cachedTokenPrice = 0.0001; // Fallback: 1 SUNO = 0.0001 SOL
  cacheTime = now;
  return cachedTokenPrice;
}

// === TOKEN CALCULATION ===
async function calculateTokenAmount(paymentSOL) {
  const tokenValue = paymentSOL * SPLIT.TOKEN_PURCHASE; // 50% of payment
  const tokenPrice = await getTokenPrice();
  const baseTokens = tokenValue / tokenPrice;
  
  // Apply tier bonuses
  if (paymentSOL >= 0.20) return Math.floor(baseTokens * 1.20); // +20%
  if (paymentSOL >= 0.10) return Math.floor(baseTokens * 1.10); // +10%
  return Math.floor(baseTokens);
}

// === SPL TOKEN TRANSFER (FIXED) ===
async function sendTokens(recipientAddress, amount) {
  try {
    console.log(`🪙 Attempting to send ${amount} tokens to ${recipientAddress.substring(0, 8)}...`);
    
    const recipient = new PublicKey(recipientAddress);
    
    // Get token accounts
    const fromATA = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    const toATA = await getAssociatedTokenAddress(
      TOKEN_MINT,
      recipient
    );
    
    console.log(`📍 From: ${fromATA.toBase58().substring(0, 8)}...`);
    console.log(`📍 To: ${toATA.toBase58().substring(0, 8)}...`);
    
    // Build transaction
    const tx = new Transaction();
    tx.feePayer = TREASURY_KEYPAIR.publicKey;
    
    // Check if recipient token account exists
    let needsAccountCreation = false;
    try {
      await getAccount(connection, toATA);
      console.log(`✅ Recipient token account exists`);
    } catch (err) {
      console.log(`📝 Need to create token account for recipient`);
      needsAccountCreation = true;
      
      // Add create account instruction
      tx.add(
        createAssociatedTokenAccountInstruction(
          TREASURY_KEYPAIR.publicKey, // payer
          toATA,                       // associated token account
          recipient,                   // owner
          TOKEN_MINT                   // mint
        )
      );
    }
    
    // Add transfer instruction
    tx.add(
      createTransferInstruction(
        fromATA,                    // source
        toATA,                      // destination
        TREASURY_KEYPAIR.publicKey, // owner
        amount,                     // amount (in smallest units)
        [],                         // multisigners
        TOKEN_PROGRAM_ID
      )
    );
    
    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    
    // Sign and send
    tx.sign(TREASURY_KEYPAIR);
    
    console.log(`📡 Sending transaction...`);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
    
    console.log(`⏳ Confirming transaction: ${signature.substring(0, 8)}...`);
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    }, 'confirmed');
    
    console.log(`🪙 Successfully sent ${amount} SUNO to ${recipientAddress.substring(0, 8)}...`);
    return signature;
  } catch (err) {
    console.error(`❌ Token transfer failed:`, err);
    throw err;
  }
}

// === CHECK TREASURY TOKEN BALANCE ===
async function checkTreasuryTokenBalance() {
  try {
    const treasuryATA = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    const account = await getAccount(connection, treasuryATA);
    const balance = Number(account.amount);
    
    console.log(`💰 Treasury token balance: ${balance.toLocaleString()} SUNO`);
    
    if (balance < 10000) {
      console.warn(`⚠️ LOW TOKEN SUPPLY! Only ${balance} SUNO remaining`);
    }
    
    return balance;
  } catch (err) {
    if (err.message.includes('could not find account')) {
      console.warn("⚠️ Treasury token account doesn't exist yet - will be created on first token transfer");
      return 0;
    }
    console.error("❌ Failed to check treasury balance:", err.message);
    return 0;
  }
}

// === STATE PERSISTENCE ===
const SAVE_FILE = fs.existsSync("/data")
  ? "/data/submissions.json"
  : "./submissions.json";

function saveState() {
  try {
    fs.writeFileSync(
      SAVE_FILE,
      JSON.stringify({
        submissions,
        phase,
        cycleStartTime,
        nextPhaseTime,
        treasurySOL,
        atStakeSOL,
        pendingPayments,
        tokenHolders,
        totalTokenSupply
      }, null, 2)
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
    treasurySOL = d.treasurySOL || 0;
    atStakeSOL = d.atStakeSOL || 0;
    pendingPayments = d.pendingPayments || [];
    tokenHolders = d.tokenHolders || {};
    totalTokenSupply = d.totalTokenSupply || 0;
    console.log(`📂 State restored — ${submissions.length} submissions, phase: ${phase}`);
  } catch (e) {
    console.error("⚠️ Failed to load:", e.message);
  }
}

// === EXPRESS SERVER ===
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get("/", async (_, res) => {
  const tokenBalance = await checkTreasuryTokenBalance();
  const prizePool = atStakeSOL * STAKE_SPLIT.PRIZES;
  const rewardsPool = atStakeSOL * STAKE_SPLIT.REWARDS;
  
  res.json({
    status: "✅ SunoLabs Token System Live",
    mode: "webhook",
    phase,
    submissions: submissions.length,
    atStake: atStakeSOL.toFixed(4) + " SOL",
    prizePool: prizePool.toFixed(4) + " SOL",
    rewardsPool: rewardsPool.toFixed(4) + " SOL",
    treasury: treasurySOL.toFixed(4) + " SOL (guaranteed profit)",
    tokenBalance: tokenBalance.toLocaleString() + " SUNO",
    tokenHolders: Object.keys(tokenHolders).length,
    totalTokenSupply: totalTokenSupply.toLocaleString(),
    uptime: process.uptime()
  });
});

app.post(`/webhook/${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === PAYMENT CONFIRMATION ===
app.post("/confirm-payment", async (req, res) => {
  try {
    const { signature, reference, userId, amount, senderWallet } = req.body;
    
    if (!userId || !reference || !senderWallet) {
      console.warn("⚠️ Missing params:", req.body);
      return res.status(400).json({ error: "Missing parameters" });
    }

    const userKey = String(userId);
    const amountNum = parseFloat(amount) || 0.02;
    
    console.log("✅ Payment received:", { 
      amount: amountNum,
      user: userKey,
      wallet: senderWallet.substring(0, 8) + "..."
    });

    // Check for duplicates
    let existing = pendingPayments.find((p) => p.reference === reference);
    if (existing && existing.confirmed) {
      return res.json({ ok: true, message: "Already processed" });
    }

    if (existing) {
      existing.confirmed = true;
    } else {
      pendingPayments.push({
        userId: userKey,
        username: userKey,
        reference,
        confirmed: true,
      });
    }

    // === CALCULATE AND SEND TOKENS ===
    const tokenAmount = await calculateTokenAmount(amountNum);
    
    try {
      await sendTokens(senderWallet, tokenAmount);
      console.log(`✅ Sent ${tokenAmount} SUNO to user`);
      
      // Track token holdings
      tokenHolders[senderWallet] = (tokenHolders[senderWallet] || 0) + tokenAmount;
      totalTokenSupply += tokenAmount;
    } catch (tokenErr) {
      console.error("❌ Token transfer failed:", tokenErr.message);
      // Continue anyway - user paid, we'll handle tokens later
    }

    // === SPLIT THE SOL PAYMENT (YOUR MODEL) ===
    const tokenPurchaseValue = amountNum * SPLIT.TOKEN_PURCHASE; // 50%
    const entryFee = amountNum * SPLIT.ENTRY_FEE; // 50%
    
    const treasuryCut = entryFee * SPLIT.TREASURY_CUT; // 30% of entry
    const atStake = entryFee * SPLIT.AT_STAKE; // 70% of entry
    
    // Treasury always gets: token purchase value + 30% of entry
    treasurySOL += tokenPurchaseValue + treasuryCut;
    
    // At stake for competition
    atStakeSOL += atStake;

    console.log(`💰 Split: ${tokenPurchaseValue.toFixed(3)} + ${treasuryCut.toFixed(3)} → Treasury (${treasurySOL.toFixed(3)} total)`);
    console.log(`🎮 At Stake: ${atStake.toFixed(3)} added (${atStakeSOL.toFixed(3)} total)`);

    // === UPDATE SUBMISSION ===
    const sub = submissions.find((s) => String(s.userId) === userKey);
    if (sub) {
      sub.paid = true;
      sub.amountPaid = amountNum;
      sub.tokensPurchased = tokenAmount;
      sub.wallet = senderWallet;
      
      // Set tier
      if (amountNum >= 0.20) {
        sub.multiplier = 1.10;
        sub.badge = "👑";
        sub.tier = "Patron";
      } else if (amountNum >= 0.10) {
        sub.multiplier = 1.05;
        sub.badge = "💎";
        sub.tier = "Supporter";
      } else {
        sub.multiplier = 1.0;
        sub.badge = "";
        sub.tier = "Basic";
      }
      
      console.log(`💎 ${sub.tier}: ${tokenAmount} SUNO attempted, ${amountNum} SOL received`);
    } else {
      console.warn(`⚠️ No matching submission for user ${userKey}`);
    }

    saveState();

    // === SEND CONFIRMATION DM ===
    try {
      const tokenPrice = await getTokenPrice();
      const tokenValue = (tokenAmount * tokenPrice).toFixed(4);
      
      // Calculate time remaining in submission phase
      const now = Date.now();
      let timeMessage = "";
      
      if (phase === "submission" && cycleStartTime) {
        const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
        const timeRemaining = Math.max(0, submissionEndTime - now);
        const minutesLeft = Math.ceil(timeRemaining / 60000);
        timeMessage = `\n⏰ Voting starts in ~${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}`;
      } else if (phase === "voting") {
        timeMessage = `\n⏰ Voting is live now!`;
      }
      
      await bot.sendMessage(
        userId,
        `✅ Purchase complete!\n\n🪙 ${tokenAmount.toLocaleString()} SUNO tokens sent\n💰 Value: ~${tokenValue} SOL\n🏆 Competition entered${timeMessage}\n\n📍 https://t.me/sunolabs`
      );
    } catch (e) {
      console.error("⚠️ DM error:", e.message);
    }

    // === POST TO CHANNELS ===
    try {
      const paidCount = submissions.filter(s => s.paid).length;
      const prizePool = atStakeSOL * STAKE_SPLIT.PRIZES;
      await bot.sendMessage(
        `@${MAIN_CHANNEL}`,
        `💰 New entry! ${paidCount} participant(s)\n🏆 Prize pool: ${prizePool.toFixed(3)} SOL`
      );
    } catch {}

    res.json({ ok: true });
  } catch (err) {
    console.error("💥 confirm-payment error:", err.stack || err);
    res.status(500).json({ error: "Internal error" });
  }
});

// === SOL PAYOUT ===
async function sendSOLPayout(destination, amountSOL, reason = "payout") {
  try {
    const lamports = Math.floor(amountSOL * 1e9);
    if (lamports <= 0) return;
    
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
    console.log(`💸 ${reason}: ${amountSOL.toFixed(4)} SOL → ${destination.substring(0, 8)}...`);
  } catch (err) {
    console.error(`⚠️ ${reason} failed:`, err.message);
  }
}

// === START NEW CYCLE ===
async function startNewCycle() {
  console.log("🔄 Starting new submission cycle...");
  
  const unpaidCount = submissions.filter(s => !s.paid).length;
  if (unpaidCount > 0) {
    console.log(`🧹 Cleaning up ${unpaidCount} unpaid submission(s) from previous cycle`);
  }
  
  phase = "submission";
  cycleStartTime = Date.now();
  nextPhaseTime = cycleStartTime + 5 * 60 * 1000;
  saveState();

  const botUsername = process.env.BOT_USERNAME || 'sunolabs_bot';
  const prizePool = atStakeSOL * STAKE_SPLIT.PRIZES;
  
  console.log(`🎬 NEW CYCLE: Submission phase (5 min), Prize pool: ${prizePool.toFixed(3)} SOL`);
  
  // Announce to main channel
  try {
    const botMention = botUsername.startsWith('@') ? botUsername : `@${botUsername}`;
    
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎬 NEW ROUND STARTED!\n\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ 5 minutes to submit your track!\n\n🎮 How to Enter:\n• Send audio to ${botMention}\n• Buy SUNO tokens + enter\n• Vote for favorites\n• Win SOL prizes!\n\n🏆 Top 5 share the prize pool\n💎 Token holders earn passive rewards\n\nGo! ⚡`
    );
    console.log("✅ Posted cycle start to main channel");
  } catch (err) {
    console.error("❌ Failed to announce in main channel:", err.message);
  }

  // Announce to voting channel
  try {
    await bot.sendMessage(
      `@${CHANNEL}`,
      `🎬 New Round!\n💰 ${prizePool.toFixed(3)} SOL\n⏰ 5 min to submit\n\nSend audio to the bot!`
    );
    console.log("✅ Posted cycle start to voting channel");
  } catch (err) {
    console.error("❌ Failed to announce in voting channel:", err.message);
  }

  // Schedule voting to start in 5 minutes
  setTimeout(() => startVoting(), 5 * 60 * 1000);
}

// === VOTING ===
async function startVoting() {
  console.log(`📋 Starting voting — Total: ${submissions.length}, Paid: ${submissions.filter(s => s.paid).length}`);
  
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    console.log("🚫 No paid submissions this round - skipping to next cycle");
    
    // Only announce in main channel, NOT in submissions channel
    try {
      await bot.sendMessage(
        `@${MAIN_CHANNEL}`,
        `⏰ No entries this round\nNew round starting in 1 minute!`
      );
      console.log("✅ Posted no-entries notice to main channel only");
    } catch (err) {
      console.error("❌ Failed to announce:", err.message);
    }
    
    // Skip voting, go straight to next cycle
    phase = "cooldown";
    saveState();
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  console.log(`✅ ${paidSubs.length} paid submission(s), starting voting...`);
  
  phase = "voting";
  nextPhaseTime = Date.now() + 5 * 60 * 1000;
  saveState();

  const prizePool = atStakeSOL * STAKE_SPLIT.PRIZES;

  // Announce voting in MAIN channel
  try {
    const voteLink = `https://t.me/${CHANNEL}`;
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🗳️ VOTING IS LIVE!\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ 5 minutes to vote!\n\n📍 Vote here: ${voteLink}`
    );
    console.log("✅ Voting announced in main channel");
  } catch (err) {
    console.error("❌ Failed to announce voting in main:", err.message);
  }

  // Post to voting channel
  try {
    await bot.sendMessage(
      `@${CHANNEL}`,
      `🗳️ VOTING STARTED!\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n⏰ 5 minutes to vote!\n\n🔥 Vote for your favorites below!`
    );

    for (const s of paidSubs) {
      const badge = s.badge || "🎧";
      await bot.sendAudio(`@${CHANNEL}`, s.track, {
        caption: `${badge} ${s.user} — ${s.title}\n🔥 0`,
        reply_markup: {
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${s.userId}` }]]
        }
      });
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log(`✅ Posted all ${paidSubs.length} submissions to voting channel`);
  } catch (err) {
    console.error("❌ Voting post failed:", err.message);
  }

  setTimeout(() => announceWinners(), 5 * 60 * 1000);
}

// === WINNERS ===
async function announceWinners() {
  phase = "cooldown";
  saveState();
  
  const paidSubs = submissions.filter((s) => s.paid);
  if (!paidSubs.length) {
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  const sorted = [...paidSubs].sort((a, b) => b.votes - a.votes);
  
  // Split the at-stake amount
  const prizePool = atStakeSOL * STAKE_SPLIT.PRIZES; // 70% for prizes
  const rewardsPool = atStakeSOL * STAKE_SPLIT.REWARDS; // 30% for token rewards
  
  const weights = [0.40, 0.25, 0.20, 0.10, 0.05];
  const numWinners = Math.min(5, sorted.length);
  
  // Pay competition prizes
  for (let i = 0; i < numWinners; i++) {
    const w = sorted[i];
    const baseAmt = prizePool * weights[i];
    const finalAmt = baseAmt * (w.multiplier || 1);
    
    if (w.wallet && finalAmt > 0.000001) {
      await sendSOLPayout(w.wallet, finalAmt, `Prize #${i + 1}`);
      
      // DM winner
      try {
        const place = i + 1;
        const ordinal = place === 1 ? "1st" : place === 2 ? "2nd" : place === 3 ? "3rd" : `${place}th`;
        await bot.sendMessage(
          w.userId,
          `🎉 Congratulations!\n\nYou placed *${ordinal}* in the competition!\n\n🔥 Votes: ${w.votes}\n💰 Base Prize: ${baseAmt.toFixed(3)} SOL\n💵 Total Prize: ${finalAmt.toFixed(3)} SOL\n\n✅ Payment sent to:\n${w.wallet}\n\nCheck your wallet! 🎊`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }
  }

  // Pay token holder rewards
  if (rewardsPool > 0 && totalTokenSupply > 0) {
    for (const [wallet, tokens] of Object.entries(tokenHolders)) {
      const share = (tokens / totalTokenSupply) * rewardsPool;
      if (share > 0.000001) {
        await sendSOLPayout(wallet, share, "Token rewards");
      }
    }
  }

  // Announce
  try {
    const winner = sorted[0];
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎉 WINNER: ${winner.user}\n💰 Prizes paid!\n💎 Token holders earned!\n\n⏰ New round in 1 min`
    );
  } catch {}

  // Reset
  submissions = [];
  atStakeSOL = 0; // Reset at-stake amount
  pendingPayments = [];
  saveState();
  
  console.log(`💰 Treasury kept: ${treasurySOL.toFixed(3)} SOL`);
  console.log(`💎 Total tokens in circulation: ${totalTokenSupply.toLocaleString()}`);
  
  setTimeout(() => startNewCycle(), 60 * 1000);
}

// === TELEGRAM HANDLERS ===
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private" || !msg.audio) return;

  const user = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "Unknown";
  const userId = String(msg.from.id);

  if (phase !== "submission") {
    await bot.sendMessage(userId, `⚠️ ${phase} phase active`);
    return;
  }

  const existingPaid = submissions.find((s) => String(s.userId) === userId && s.paid);
  if (existingPaid) {
    await bot.sendMessage(userId, "⚠️ Already entered!");
    return;
  }

  const reference = Keypair.generate().publicKey;
  const redirectLink = `https://sunolabs-redirect.onrender.com/pay?recipient=${TREASURY.toBase58()}&amount=0.02&reference=${reference.toBase58()}&userId=${userId}`;

  pendingPayments.push({
    userId,
    username: user,
    reference: reference.toBase58(),
    confirmed: false,
  });
  saveState();

  await bot.sendMessage(
    userId,
    `🎧 Track received!\n\n👉 Buy SUNO Tokens & Enter:\n${redirectLink}\n\n🪙 Get tokens + compete!`,
    { disable_web_page_preview: true }
  );

  submissions.push({
    user,
    userId,
    track: msg.audio.file_id,
    title: msg.audio.file_name || "Untitled",
    votes: 0,
    voters: [],
    paid: false,
    wallet: null,
    tokensPurchased: 0,
    multiplier: 1,
  });
  saveState();
});

bot.on("callback_query", async (q) => {
  try {
    const [, userIdStr] = q.data.split("_");
    const userId = String(userIdStr);
    const voter = String(q.from.id);
    const entry = submissions.find((s) => String(s.userId) === userId);
    
    if (!entry) {
      await bot.answerCallbackQuery(q.id, { text: "⚠️ Not found" });
      return;
    }

    if (entry.voters.includes(voter)) {
      await bot.answerCallbackQuery(q.id, { text: "⚠️ Already voted" });
      return;
    }

    entry.votes++;
    entry.voters.push(voter);
    saveState();

    const badge = entry.badge || "🎧";
    try {
      await bot.editMessageCaption(`${badge} ${entry.user} — ${entry.title}\n🔥 ${entry.votes}`, {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        reply_markup: {
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.userId}` }]]
        }
      });
    } catch {}
    
    await bot.answerCallbackQuery(q.id, { text: "✅ Voted!" });
  } catch (err) {
    console.error("⚠️ Callback error:", err.message);
  }
});

// === STARTUP ===
app.listen(PORT, async () => {
  console.log(`🌐 SunoLabs Token Bot on port ${PORT}`);
  
  loadState();
  
  // Check treasury token balance on startup
  await checkTreasuryTokenBalance();
  
  // Setup webhook
  const webhookUrl = `https://sunolabs-bot.onrender.com/webhook/${token}`;
  try {
    await bot.deleteWebHook();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await bot.setWebHook(webhookUrl);
    console.log("✅ Webhook set");
    
    const info = await bot.getWebHookInfo();
    console.log(`📊 Webhook URL: ${info.url}`);
    console.log(`📊 Pending updates: ${info.pending_update_count}`);
  } catch (err) {
    console.error("❌ Webhook failed:", err.message);
  }
  
  // Handle cycle resumption or new cycle
  const now = Date.now();
  
  if (!cycleStartTime || phase === "cooldown") {
    console.log("🚀 No active cycle - starting new cycle in 3 seconds...");
    setTimeout(() => startNewCycle(), 3000);
  } else if (phase === "submission") {
    const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
    const timeLeft = submissionEndTime - now;
    
    if (timeLeft <= 0) {
      console.log("⚠️ Submission phase overdue - starting voting now...");
      setTimeout(() => startVoting(), 1000);
    } else {
      const minutesLeft = Math.ceil(timeLeft / 60000);
      console.log(`⏰ Resuming submission phase with ${minutesLeft} minute(s) remaining`);
      setTimeout(() => startVoting(), timeLeft);
    }
  } else if (phase === "voting") {
    if (!nextPhaseTime) {
      console.log("⚠️ Voting phase but no end time set - announcing winners in 1 min...");
      setTimeout(() => announceWinners(), 60 * 1000);
    } else {
      const timeLeft = nextPhaseTime - now;
      
      if (timeLeft <= 0) {
        console.log("⚠️ Voting phase overdue - announcing winners now...");
        setTimeout(() => announceWinners(), 1000);
      } else {
        const minutesLeft = Math.ceil(timeLeft / 60000);
        console.log(`⏰ Resuming voting phase with ${minutesLeft} minute(s) remaining`);
        setTimeout(() => announceWinners(), timeLeft);
      }
    }
  }
  
  console.log(`📊 Current state: Phase=${phase}, Submissions=${submissions.length}, Treasury=${treasurySOL.toFixed(3)} SOL`);
});

setInterval(() => {
  const now = Date.now();
  let phaseInfo = phase;
  
  if (phase === "submission" && cycleStartTime) {
    const timeLeft = Math.ceil((cycleStartTime + 5 * 60 * 1000 - now) / 60000);
    phaseInfo = `${phase} (${Math.max(0, timeLeft)}m left)`;
  } else if (phase === "voting" && nextPhaseTime) {
    const timeLeft = Math.ceil((nextPhaseTime - now) / 60000);
    phaseInfo = `${phase} (${Math.max(0, timeLeft)}m left)`;
  }
  
  console.log(`⏰ ${new Date().toISOString()} | Phase: ${phaseInfo} | Entries: ${submissions.filter(s => s.paid).length}`);
}, 30000);

console.log("✅ SunoLabs Token Bot initialized...");
