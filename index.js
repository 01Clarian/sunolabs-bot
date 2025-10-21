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
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

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

// === WALLET ADDRESSES ===
const TREASURY = new PublicKey("98tf4zU5WhLmsCt1D4HQH5Ej9C5aFwCz8KQwykmKvDDQ");
const TRANS_FEE_WALLET = new PublicKey("CDfvckc6qBqBKaxXppPJrhkbZHHYvjVw2wAFjM38gX4B");
const TOKEN_MINT = new PublicKey("4vTeHaoJGvrKduJrxVmfgkjzDYPzD8BJJDv5Afempump");

const TREASURY_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY
  ? Uint8Array.from(JSON.parse(process.env.BOT_PRIVATE_KEY))
  : null;
if (!TREASURY_PRIVATE_KEY) throw new Error("❌ BOT_PRIVATE_KEY missing!");
const TREASURY_KEYPAIR = Keypair.fromSecretKey(TREASURY_PRIVATE_KEY);

// === PUMP.FUN CONFIG ===
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_FEE = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
const PUMP_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");

// === STATE ===
let treasurySOL = 0;
let transFeeCollected = 0;
let pendingPayments = [];
let participants = [];
let voters = [];
let phase = "submission";
let cycleStartTime = null;
let nextPhaseTime = null;

// === TIER CONFIGURATION ===
const TIERS = {
  BASIC: { 
    min: 0.01, 
    max: 0.049,
    retention: 0.50,
    multiplier: 1.0,
    name: "Basic",
    badge: "🎵"
  },
  MID: { 
    min: 0.05, 
    max: 0.099,
    retention: 0.55,
    multiplier: 1.05,
    name: "Mid Tier",
    badge: "💎"
  },
  HIGH: { 
    min: 0.10, 
    max: 0.499,
    retention: 0.60,
    multiplier: 1.10,
    name: "High Tier",
    badge: "👑"
  },
  WHALE: { 
    min: 0.50,
    max: 999,
    retention: 0.65,
    multiplier: 1.15,
    name: "Whale",
    badge: "🐋"
  }
};

function getTier(amount) {
  if (amount >= TIERS.WHALE.min) return TIERS.WHALE;
  if (amount >= TIERS.HIGH.min) return TIERS.HIGH;
  if (amount >= TIERS.MID.min) return TIERS.MID;
  return TIERS.BASIC;
}

function getWhaleRetention(amount) {
  if (amount < 0.50) return 0.65;
  if (amount >= 5.00) return 0.75;
  return 0.65 + ((amount - 0.50) / 4.50) * 0.10;
}

function getWhaleMultiplier(amount) {
  if (amount < 0.50) return 1.15;
  if (amount >= 5.00) return 1.50;
  return 1.15 + ((amount - 0.50) / 4.50) * 0.35;
}

// === CHECK IF TOKEN HAS BONDED ===
async function checkIfBonded() {
  try {
    console.log("🔍 Checking if SUNO has graduated from pump.fun...");
    
    // Derive bonding curve PDA
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), TOKEN_MINT.toBuffer()],
      PUMP_PROGRAM
    );
    
    const accountInfo = await connection.getAccountInfo(bondingCurve);
    
    if (!accountInfo) {
      console.log("✅ Token has graduated to Raydium! Using Jupiter...");
      return true; // Bonded/graduated
    }
    
    // Check if bonding curve is complete
    const data = accountInfo.data;
    const complete = data[8]; // Byte 8 indicates completion
    
    if (complete === 1) {
      console.log("✅ Bonding curve complete! Token graduated. Using Jupiter...");
      return true;
    }
    
    console.log("📊 Token still on pump.fun bonding curve. Using pump.fun buy...");
    return false;
    
  } catch (err) {
    console.error(`⚠️ Bond check error: ${err.message}. Defaulting to Jupiter...`);
    return true; // Default to Jupiter on error
  }
}

// === PUMP.FUN BUY ===
async function buyOnPumpFun(solAmount, recipientWallet) {
  try {
    console.log(`🚀 Starting pump.fun buy: ${solAmount.toFixed(4)} SOL → ${recipientWallet.substring(0, 8)}...`);
    
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), TOKEN_MINT.toBuffer()],
      PUMP_PROGRAM
    );
    
    const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
      [
        bondingCurve.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        TOKEN_MINT.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    const recipientPubkey = new PublicKey(recipientWallet);
    const recipientTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      recipientPubkey
    );
    
    // Check if ATA exists
    const ataInfo = await connection.getAccountInfo(recipientTokenAccount);
    const needsATA = !ataInfo;
    
    if (needsATA) {
      console.log("📝 Creating associated token account...");
    }
    
    // Calculate slippage (1% slippage)
    const slippageBps = 100; // 1%
    const lamports = Math.floor(solAmount * 1e9);
    
    console.log(`💰 Buy amount: ${lamports.toLocaleString()} lamports`);
    
    const tx = new Transaction();
    
    // Add compute budget
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
    );
    
    // Create ATA if needed
    if (needsATA) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          TREASURY_KEYPAIR.publicKey,
          recipientTokenAccount,
          recipientPubkey,
          TOKEN_MINT
        )
      );
    }
    
    // Build buy instruction
    const keys = [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE, isSigner: false, isWritable: true },
      { pubkey: TOKEN_MINT, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TREASURY_KEYPAIR.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Buy instruction data: [102, 6, 190, 52, 184, 101, 70, 20] + amount + max_sol + slippage
    const data = Buffer.alloc(24);
    data.write("66063bbe34b84614", 0, "hex"); // Buy discriminator
    data.writeBigUInt64LE(BigInt(lamports), 8);
    data.writeBigUInt64LE(BigInt(slippageBps), 16);
    
    tx.add({
      keys,
      programId: PUMP_PROGRAM,
      data,
    });
    
    tx.feePayer = TREASURY_KEYPAIR.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    
    console.log("✍️ Signing transaction...");
    const sig = await connection.sendTransaction(tx, [TREASURY_KEYPAIR], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    
    console.log(`📤 Transaction sent: ${sig.substring(0, 8)}...`);
    console.log("⏳ Confirming transaction...");
    
    await connection.confirmTransaction(sig, "confirmed");
    
    console.log(`✅ Pump.fun buy complete! Tx: ${sig}`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
    
    // Get token balance
    await new Promise(r => setTimeout(r, 2000)); // Wait for balance update
    const balance = await connection.getTokenAccountBalance(recipientTokenAccount);
    const tokenAmount = parseInt(balance.value.amount);
    
    console.log(`🪙 Received ${tokenAmount.toLocaleString()} SUNO tokens`);
    
    return tokenAmount;
    
  } catch (err) {
    console.error(`❌ Pump.fun buy failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

// === JUPITER SWAP ===
async function buyOnJupiter(solAmount, recipientWallet) {
  try {
    console.log(`🪐 Starting Jupiter swap: ${solAmount.toFixed(4)} SOL → SUNO`);
    
    const lamports = Math.floor(solAmount * 1e9);
    const recipientPubkey = new PublicKey(recipientWallet);
    const recipientTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      recipientPubkey
    );
    
    // Get quote from Jupiter
    console.log("📊 Getting Jupiter quote...");
    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${TOKEN_MINT.toBase58()}&amount=${lamports}&slippageBps=100`
    );
    
    const quoteData = await quoteResponse.json();
    
    if (!quoteData || quoteData.error) {
      throw new Error(`Quote failed: ${quoteData?.error || 'Unknown error'}`);
    }
    
    const outAmount = parseInt(quoteData.outAmount);
    console.log(`💎 Quote: ${lamports.toLocaleString()} lamports → ${outAmount.toLocaleString()} SUNO`);
    
    // Get swap transaction
    console.log("🔨 Building swap transaction...");
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: TREASURY_KEYPAIR.publicKey.toBase58(),
        destinationTokenAccount: recipientTokenAccount.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 50000,
      })
    });
    
    const swapData = await swapResponse.json();
    
    if (!swapData.swapTransaction) {
      throw new Error('No swap transaction returned');
    }
    
    console.log("✍️ Signing and sending transaction...");
    
    // Deserialize and sign
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([TREASURY_KEYPAIR]);
    
    const rawTransaction = transaction.serialize();
    const sig = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    console.log(`📤 Transaction sent: ${sig.substring(0, 8)}...`);
    console.log("⏳ Confirming transaction...");
    
    await connection.confirmTransaction(sig, 'confirmed');
    
    console.log(`✅ Jupiter swap complete! Tx: ${sig}`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
    console.log(`🪙 Estimated ${outAmount.toLocaleString()} SUNO tokens sent to user`);
    
    return outAmount;
    
  } catch (err) {
    console.error(`❌ Jupiter swap failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

// === MARKET INTEGRATION (Auto-detect pump.fun or Jupiter) ===
async function buySUNOOnMarket(solAmount, recipientWallet) {
  try {
    console.log(`\n🔄 ========== BUYING SUNO ==========`);
    console.log(`💰 Amount: ${solAmount.toFixed(4)} SOL`);
    console.log(`👛 Recipient: ${recipientWallet.substring(0, 8)}...`);
    
    const isBonded = await checkIfBonded();
    
    let sunoAmount;
    if (isBonded) {
      // Use Jupiter
      sunoAmount = await buyOnJupiter(solAmount, recipientWallet);
    } else {
      // Use pump.fun
      sunoAmount = await buyOnPumpFun(solAmount, recipientWallet);
    }
    
    console.log(`✅ Purchase complete! ${sunoAmount.toLocaleString()} SUNO → ${recipientWallet.substring(0, 8)}...`);
    console.log(`🔄 ===================================\n`);
    return sunoAmount;
    
  } catch (err) {
    console.error(`❌ Market buy failed: ${err.message}`);
    console.error(err.stack);
    throw err;
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
        participants,
        voters,
        phase,
        cycleStartTime,
        nextPhaseTime,
        treasurySOL,
        transFeeCollected,
        pendingPayments
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
    participants = d.participants || [];
    voters = d.voters || [];
    phase = d.phase || "submission";
    cycleStartTime = d.cycleStartTime || null;
    nextPhaseTime = d.nextPhaseTime || null;
    treasurySOL = d.treasurySOL || 0;
    transFeeCollected = d.transFeeCollected || 0;
    pendingPayments = d.pendingPayments || [];
    console.log(`📂 State restored — ${participants.length} participants, phase: ${phase}`);
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
  const uploaders = participants.filter(p => p.choice === "upload" && p.paid).length;
  const voteOnly = voters.length;
  
  res.json({
    status: "✅ SunoLabs Buy SUNO System Live",
    mode: "webhook",
    phase,
    uploaders,
    voteOnly,
    treasury: treasurySOL.toFixed(4) + " SOL",
    transFees: transFeeCollected.toFixed(4) + " SOL",
    uptime: process.uptime()
  });
});

app.post(`/webhook/${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === PAYMENT CONFIRMATION ===
app.post("/confirm-payment", async (req, res) => {
  console.log("\n==============================================");
  console.log("🔔 /confirm-payment ENDPOINT HIT!");
  console.log("📦 Request body:", JSON.stringify(req.body, null, 2));
  console.log("==============================================\n");
  
  try {
    const { signature, reference, userId, amount, senderWallet } = req.body;
    
    console.log("🔍 Validating parameters...");
    if (!userId || !reference || !senderWallet) {
      console.log("❌ MISSING PARAMETERS!");
      console.warn("⚠️ Missing params:", req.body);
      return res.status(400).json({ error: "Missing parameters" });
    }
    console.log("✅ Parameters validated!");

    const userKey = String(userId);
    const amountNum = parseFloat(amount) || 0.01;
    
    console.log(`\n💳 ========== PAYMENT RECEIVED ==========`);
    console.log(`💰 Amount: ${amountNum} SOL`);
    console.log(`👤 User: ${userKey}`);
    console.log(`👛 Wallet: ${senderWallet.substring(0, 8)}...`);
    console.log(`📝 Reference: ${reference.substring(0, 8)}...`);
    console.log(`=====================================\n`);

    // Check for duplicates
    let existing = pendingPayments.find((p) => p.reference === reference);
    if (existing && existing.confirmed) {
      console.log("⚠️ Payment already processed - returning success");
      return res.json({ ok: true, message: "Already processed" });
    }

    if (existing) {
      existing.confirmed = true;
    } else {
      pendingPayments.push({
        userId: userKey,
        reference,
        confirmed: true,
      });
    }

    // === PAYMENT SPLIT ===
    console.log("💰 Calculating payment split...");
    const transFee = amountNum * 0.10;
    const remaining = amountNum * 0.90;
    
    const tier = getTier(amountNum);
    let retention = tier.retention;
    let multiplier = tier.multiplier;
    
    if (tier === TIERS.WHALE) {
      retention = getWhaleRetention(amountNum);
      multiplier = getWhaleMultiplier(amountNum);
    }
    
    const userAmount = remaining * retention;
    const treasuryAmount = remaining * (1 - retention);
    
    console.log(`\n💰 ========== PAYMENT SPLIT ==========`);
    console.log(`🏦 Trans Fee (10%): ${transFee.toFixed(4)} SOL`);
    console.log(`👤 User SUNO Buy (${(retention * 100).toFixed(0)}%): ${userAmount.toFixed(4)} SOL`);
    console.log(`🏆 Competition Pool: ${treasuryAmount.toFixed(4)} SOL`);
    console.log(`${tier.badge} Tier: ${tier.name} | ${multiplier}x multiplier`);
    console.log(`=====================================\n`);

    // === SEND TRANS FEE ===
    console.log("💸 Sending trans fee...");
    try {
      await sendSOLPayout(TRANS_FEE_WALLET.toBase58(), transFee, "Trans fee");
      transFeeCollected += transFee;
      console.log("✅ Trans fee sent successfully");
    } catch (err) {
      console.error(`❌ Trans fee failed: ${err.message}`);
    }

    // === BUY SUNO FOR USER ===
    let sunoAmount = 0;
    console.log("\n🪙 Starting SUNO purchase...");
    try {
      sunoAmount = await buySUNOOnMarket(userAmount, senderWallet);
      console.log(`\n✅ SUNO purchase SUCCESS: ${sunoAmount.toLocaleString()} tokens`);
    } catch (err) {
      console.error(`\n❌ SUNO purchase FAILED: ${err.message}`);
      console.error(err.stack);
    }

    // === ADD TO TREASURY ===
    treasurySOL += treasuryAmount;
    console.log(`\n🏦 Treasury updated: +${treasuryAmount.toFixed(4)} SOL (Total: ${treasurySOL.toFixed(4)} SOL)`);

    // === SAVE USER DATA ===
    const userData = {
      userId: userKey,
      wallet: senderWallet,
      amount: amountNum,
      sunoReceived: sunoAmount,
      tier: tier.name,
      tierBadge: tier.badge,
      retention: (retention * 100).toFixed(0) + "%",
      multiplier,
      paid: true,
      timestamp: Date.now()
    };

    saveState();

    // === SEND CHOICE BUTTONS ===
    const now = Date.now();
    let timeMessage = "";
    
    if (phase === "submission" && cycleStartTime) {
      const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
      const timeRemaining = Math.max(0, submissionEndTime - now);
      const minutesLeft = Math.ceil(timeRemaining / 60000);
      timeMessage = `\n⏰ Voting starts in ~${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}`;
    }

    console.log("\n📱 Sending choice buttons to user...");
    try {
      await bot.sendMessage(
        userId,
        `✅ Purchase complete!\n\n🪙 ${sunoAmount.toLocaleString()} SUNO bought\n${tier.badge} ${tier.name} tier (${(retention * 100).toFixed(0)}% retention)\n💰 ${multiplier}x prize multiplier${timeMessage}\n\n🎯 What do you want to do?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🎵 Upload Track & Compete", callback_data: `choice_upload_${userKey}` }],
              [{ text: "🗳️ Vote Only & Earn", callback_data: `choice_vote_${userKey}` }]
            ]
          }
        }
      );
      
      pendingPayments.find(p => p.reference === reference).userData = userData;
      console.log("✅ Choice buttons sent successfully\n");
      
    } catch (e) {
      console.error("⚠️ DM error:", e.message);
    }

    console.log("✅ Payment processing complete - returning success to client\n");
    res.json({ ok: true, sunoAmount });
  } catch (err) {
    console.error(`\n💥 FATAL ERROR in confirm-payment: ${err.message}`);
    console.error(err.stack);
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
    console.error(`⚠️ ${reason} failed: ${err.message}`);
  }
}

// === START NEW CYCLE ===
async function startNewCycle() {
  console.log("🔄 Starting new cycle...");
  
  phase = "submission";
  cycleStartTime = Date.now();
  nextPhaseTime = cycleStartTime + 5 * 60 * 1000;
  saveState();

  const botUsername = process.env.BOT_USERNAME || 'sunolabs_bot';
  
  console.log(`🎬 NEW CYCLE: Submission phase (5 min), Prize pool: ${treasurySOL.toFixed(3)} SOL`);
  
  try {
    const botMention = botUsername.startsWith('@') ? botUsername : `@${botUsername}`;
    
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎬 NEW ROUND STARTED!\n\n💰 Prize Pool: ${treasurySOL.toFixed(3)} SOL\n⏰ 5 minutes to join!\n\n🎮 Buy SUNO + Choose:\n• Upload track & compete\n• Vote only & earn\n\nStart: ${botMention}`
    );
    console.log("✅ Posted cycle start to main channel");
  } catch (err) {
    console.error("❌ Failed to announce:", err.message);
  }

  setTimeout(() => startVoting(), 5 * 60 * 1000);
}

// === VOTING ===
async function startVoting() {
  console.log(`📋 Starting voting — Uploaders: ${participants.filter(p => p.choice === "upload" && p.paid).length}`);
  
  const uploaders = participants.filter((p) => p.choice === "upload" && p.paid);
  
  if (!uploaders.length) {
    console.log("🚫 No uploads this round");
    
    try {
      await bot.sendMessage(
        `@${MAIN_CHANNEL}`,
        `⏰ No entries this round\nNew round in 1 minute!`
      );
    } catch {}
    
    phase = "cooldown";
    saveState();
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  phase = "voting";
  nextPhaseTime = Date.now() + 5 * 60 * 1000;
  saveState();

  try {
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🗳️ VOTING LIVE!\n💰 Prize: ${treasurySOL.toFixed(3)} SOL\n⏰ 5 min!\n\n📍 Vote: https://t.me/${CHANNEL}`
    );
  } catch {}

  try {
    await bot.sendMessage(
      `@${CHANNEL}`,
      `🗳️ VOTING STARTED!\n💰 ${treasurySOL.toFixed(3)} SOL\n⏰ 5 min!\n\n🔥 Vote below!`
    );

    for (const p of uploaders) {
      await bot.sendAudio(`@${CHANNEL}`, p.track, {
        caption: `${p.tierBadge} ${p.user} — ${p.title}\n🔥 0`,
        reply_markup: {
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${p.userId}` }]]
        }
      });
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log(`✅ Posted ${uploaders.length} tracks`);
  } catch (err) {
    console.error("❌ Voting failed:", err.message);
  }

  setTimeout(() => announceWinners(), 5 * 60 * 1000);
}

// === ANNOUNCE WINNERS ===
async function announceWinners() {
  console.log(`🏆 Announcing winners...`);
  
  phase = "cooldown";
  saveState();
  
  const uploaders = participants.filter((p) => p.choice === "upload" && p.paid);
  
  if (!uploaders.length) {
    console.log("🚫 No uploads");
    participants = [];
    voters = [];
    treasurySOL = 0;
    pendingPayments = [];
    saveState();
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  const sorted = [...uploaders].sort((a, b) => b.votes - a.votes);
  const weights = [0.40, 0.25, 0.20, 0.10, 0.05];
  const numWinners = Math.min(5, sorted.length);
  
  const prizePool = treasurySOL * 0.80;
  const voterPool = treasurySOL * 0.20;
  
  let resultsMsg = `🏆 Competition Results 🏆\n💰 Prize Pool: ${prizePool.toFixed(3)} SOL\n\n`;
  
  for (let i = 0; i < numWinners; i++) {
    const w = sorted[i];
    const baseAmt = prizePool * weights[i];
    const finalAmt = baseAmt * w.multiplier;
    
    resultsMsg += `#${i + 1} ${w.tierBadge} ${w.user} — ${w.votes}🔥 — ${finalAmt.toFixed(3)} SOL\n`;
    
    if (w.wallet && finalAmt > 0.000001) {
      await sendSOLPayout(w.wallet, finalAmt, `Prize #${i + 1}`);
      
      try {
        await bot.sendMessage(w.userId, `🎉 You won ${finalAmt.toFixed(3)} SOL! Check your wallet! 🎊`);
      } catch {}
    }
  }

  const winner = sorted[0];
  const winnerVoters = voters.filter(v => v.votedFor === winner.userId);
  
  if (winnerVoters.length > 0 && voterPool > 0) {
    const totalVoterAmount = winnerVoters.reduce((sum, v) => sum + v.amount, 0);
    
    resultsMsg += `\n🗳️ Voter Rewards: ${voterPool.toFixed(4)} SOL\n`;
    
    for (const v of winnerVoters) {
      const share = (v.amount / totalVoterAmount) * voterPool;
      
      if (share > 0.000001) {
        await sendSOLPayout(v.wallet, share, "Voter reward");
        
        try {
          await bot.sendMessage(v.userId, `🎉 You voted for the winner!\nReward: ${share.toFixed(4)} SOL 💰`);
        } catch {}
      }
    }
    
    resultsMsg += `✅ ${winnerVoters.length} voter(s) rewarded!`;
  }

  try {
    await bot.sendMessage(`@${CHANNEL}`, resultsMsg);
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎉 WINNER: ${winner.tierBadge} ${winner.user}\n💰 ${(prizePool * 0.40 * winner.multiplier).toFixed(3)} SOL\n\n⏰ New round in 1 min`
    );
  } catch {}

  console.log(`💰 Distributed ${treasurySOL.toFixed(3)} SOL`);
  participants = [];
  voters = [];
  treasurySOL = 0;
  pendingPayments = [];
  saveState();
  
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

  const reference = Keypair.generate().publicKey;
  const redirectLink = `https://sunolabs-redirect.onrender.com/pay?recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference.toBase58()}&userId=${userId}`;

  pendingPayments.push({
    userId,
    user,
    track: msg.audio.file_id,
    title: msg.audio.file_name || "Untitled",
    reference: reference.toBase58(),
    confirmed: false,
  });
  saveState();

  await bot.sendMessage(
    userId,
    `🎧 Track received!\n\n🪙 Get SUNO tokens + enter the competition!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🪙 Get SUNO Tokens", url: redirectLink }]
        ]
      }
    }
  );
});

bot.on("callback_query", async (q) => {
  try {
    if (q.data.startsWith("choice_")) {
      const [, choice, userKey] = q.data.split("_");
      
      const payment = pendingPayments.find(p => p.userId === userKey && p.userData);
      
      if (!payment || !payment.userData) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Data not found" });
        return;
      }

      if (choice === "upload") {
        const audio = pendingPayments.find(p => p.userId === userKey && p.track);
        
        if (!audio) {
          await bot.answerCallbackQuery(q.id, { text: "⚠️ Please send your audio first!" });
          return;
        }

        participants.push({
          ...payment.userData,
          choice: "upload",
          user: audio.user,
          track: audio.track,
          title: audio.title,
          votes: 0,
          voters: []
        });
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Track uploaded!" });
        await bot.sendMessage(userKey, "🎵 Your track is entered! Good luck! 🍀");
        
      } else if (choice === "vote") {
        voters.push({
          ...payment.userData,
          choice: "vote",
          votedFor: null
        });
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Set to vote only!" });
        await bot.sendMessage(userKey, "🗳️ You'll earn rewards if you vote for the winner!");
      }
      
      saveState();
      return;
    }

    if (q.data.startsWith("vote_")) {
      const [, userIdStr] = q.data.split("_");
      const targetId = String(userIdStr);
      const voterId = String(q.from.id);
      
      const entry = participants.find((p) => String(p.userId) === targetId);
      
      if (!entry) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Not found" });
        return;
      }

      if (entry.voters.includes(voterId)) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Already voted" });
        return;
      }

      entry.votes++;
      entry.voters.push(voterId);
      
      const voter = voters.find(v => v.userId === voterId);
      if (voter) {
        voter.votedFor = targetId;
      }
      
      saveState();

      try {
        await bot.editMessageCaption(`${entry.tierBadge} ${entry.user} — ${entry.title}\n🔥 ${entry.votes}`, {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: {
            inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.userId}` }]]
          }
        });
      } catch {}
      
      await bot.answerCallbackQuery(q.id, { text: "✅ Voted!" });
    }
  } catch (err) {
    console.error("⚠️ Callback error:", err.message);
  }
});

// === STARTUP ===
app.listen(PORT, async () => {
  console.log(`🌐 SunoLabs Buy SUNO Bot on port ${PORT}`);
  
  loadState();
  
  const webhookUrl = `https://sunolabs-bot.onrender.com/webhook/${token}`;
  try {
    await bot.deleteWebHook();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await bot.setWebHook(webhookUrl);
    console.log("✅ Webhook set");
  } catch (err) {
    console.error("❌ Webhook failed:", err.message);
  }
  
  const now = Date.now();
  
  if (!cycleStartTime || phase === "cooldown") {
    console.log("🚀 Starting new cycle in 3 seconds...");
    setTimeout(() => startNewCycle(), 3000);
  } else if (phase === "submission") {
    const timeLeft = (cycleStartTime + 5 * 60 * 1000) - now;
    if (timeLeft <= 0) {
      setTimeout(() => startVoting(), 1000);
    } else {
      console.log(`⏰ Resuming submission (${Math.ceil(timeLeft / 60000)}m left)`);
      setTimeout(() => startVoting(), timeLeft);
    }
  } else if (phase === "voting") {
    const timeLeft = nextPhaseTime - now;
    if (timeLeft <= 0) {
      setTimeout(() => announceWinners(), 1000);
    } else {
      console.log(`⏰ Resuming voting (${Math.ceil(timeLeft / 60000)}m left)`);
      setTimeout(() => announceWinners(), timeLeft);
    }
  }
});

setInterval(() => {
  console.log(`⏰ Phase: ${phase} | Uploaders: ${participants.filter(p => p.choice === "upload").length} | Voters: ${voters.length}`);
}, 30000);

console.log("✅ SunoLabs Buy SUNO Bot initialized...");
