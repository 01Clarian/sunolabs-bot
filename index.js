// === IMPORTS ===
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
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
const RPC_URL = process.env.SOLANA_RPC_URL;
if (!RPC_URL) {
  throw new Error("❌ SOLANA_RPC_URL environment variable required!");
}
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

// === STATE ===
let treasurySUNO = 0;  // Competition pool in SUNO tokens
let transFeeCollected = 0;
let pendingPayments = [];
let participants = [];
let voters = [];
let phase = "submission";
let cycleStartTime = null;
let nextPhaseTime = null;

// === TREASURY PRIZE SYSTEM ===
const TREASURY_BONUS_CHANCE = 500; // 1 in 500 chance

// Dynamic treasury bonus percentage based on treasury size
function getTreasuryBonusPercentage() {
  if (treasurySUNO < 100000) return 0.20;      // 20% for small treasury (< 100k)
  if (treasurySUNO < 500000) return 0.15;      // 15% for medium treasury (100k-500k)
  if (treasurySUNO < 1000000) return 0.10;     // 10% for large treasury (500k-1M)
  if (treasurySUNO < 5000000) return 0.05;     // 5% for very large treasury (1M-5M)
  return 0.02;                                  // 2% for mega treasury (5M+)
}

// === CHECK FOR TREASURY BONUS WIN ===
function checkTreasuryBonus() {
  const roll = Math.floor(Math.random() * TREASURY_BONUS_CHANCE) + 1;
  return roll === 1; // 1 in 500 chance
}

// === CALCULATE POTENTIAL TREASURY BONUS ===
function calculateTreasuryBonus() {
  const percentage = getTreasuryBonusPercentage();
  return Math.floor(treasurySUNO * percentage);
}

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

// === GET TRACK DURATION ===
async function getTrackDuration(fileId) {
  try {
    const file = await bot.getFile(fileId);
    const fileInfo = await bot.getFile(fileId);
    
    // Try to get duration from audio metadata
    // Note: Telegram API provides duration for audio files
    const audioFile = await bot.getFileLink(fileId);
    
    // If we can't get the actual duration, return null and we'll use fallback
    // The audio object in message should have duration property
    return null; // Will be set from msg.audio.duration when available
    
  } catch (err) {
    console.log(`⚠️ Could not get track duration for ${fileId}: ${err.message}`);
    return null;
  }
}

// === CALCULATE VOTING TIME ===
function calculateVotingTime() {
  const uploaders = participants.filter(p => p.choice === "upload" && p.track);
  
  if (uploaders.length === 0) {
    return 3 * 60 * 1000; // Default 3 minutes if no tracks
  }
  
  let totalDuration = 0;
  let hasAllDurations = true;
  
  for (const uploader of uploaders) {
    if (uploader.trackDuration && uploader.trackDuration > 0) {
      totalDuration += uploader.trackDuration;
    } else {
      hasAllDurations = false;
    }
  }
  
  if (hasAllDurations && totalDuration > 0) {
    // Use actual durations + 1 minute for decision time
    const votingTime = (totalDuration + 60) * 1000; // Convert to milliseconds
    console.log(`⏱️ Voting time: ${Math.ceil(votingTime / 60000)} minutes (based on track durations)`);
    return votingTime;
  } else {
    // Fallback: 2 minutes per track
    const fallbackTime = uploaders.length * 2 * 60 * 1000;
    console.log(`⏱️ Voting time: ${Math.ceil(fallbackTime / 60000)} minutes (fallback: 2 min per track)`);
    return fallbackTime;
  }
}

// === CHECK FOR TREASURY BONUS WIN ===
function checkTreasuryBonus() {
  const roll = Math.floor(Math.random() * TREASURY_BONUS_CHANCE) + 1;
  return roll === 1; // 1 in 10,000 chance
}

// === CALCULATE POTENTIAL TREASURY BONUS ===
function calculateTreasuryBonus() {
  return Math.floor(treasurySUNO * TREASURY_BONUS_PERCENTAGE);
}

// === TRANSFER TOKENS TO RECIPIENT ===
async function transferTokensToRecipient(tokenAmount, recipientWallet) {
  try {
    console.log(`📤 Initiating token transfer...`);
    
    const recipientPubkey = new PublicKey(recipientWallet);
    
    // Get treasury token account
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    // Get or create recipient token account
    const recipientTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      recipientPubkey
    );
    
    // Check if recipient ATA exists
    const recipientATA = await connection.getAccountInfo(recipientTokenAccount);
    
    const tx = new Transaction();
    
    // Create recipient ATA if needed
    if (!recipientATA) {
      console.log("📝 Creating recipient token account...");
      tx.add(
        createAssociatedTokenAccountInstruction(
          TREASURY_KEYPAIR.publicKey,
          recipientTokenAccount,
          recipientPubkey,
          TOKEN_MINT
        )
      );
    }
    
    // Add transfer instruction
    tx.add(
      createTransferInstruction(
        treasuryTokenAccount,
        recipientTokenAccount,
        TREASURY_KEYPAIR.publicKey,
        tokenAmount
      )
    );
    
    tx.feePayer = TREASURY_KEYPAIR.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    
    console.log("✍️ Signing transfer transaction...");
    const sig = await connection.sendTransaction(tx, [TREASURY_KEYPAIR]);
    
    console.log(`📤 Transfer sent: ${sig.substring(0, 8)}...`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
    
    await connection.confirmTransaction(sig, "confirmed");
    
    console.log(`✅ Transfer confirmed!`);
    
    return true;
    
  } catch (err) {
    console.error(`❌ Token transfer failed: ${err.message}`);
    console.error(err.stack);
    return false;
  }
}

// === CHECK IF TOKEN HAS BONDED ===
async function checkIfBonded() {
  try {
    console.log("🔍 Checking if SUNO has graduated from pump.fun...");
    
    const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    
    // Derive bonding curve PDA
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), TOKEN_MINT.toBuffer()],
      PUMP_PROGRAM
    );
    
    const accountInfo = await connection.getAccountInfo(bondingCurve);
    
    if (!accountInfo) {
      console.log("✅ Token has graduated to Raydium! Using Jupiter...");
      return true;
    }
    
    // Check if bonding curve is complete
    const data = accountInfo.data;
    const complete = data[8];
    
    if (complete === 1) {
      console.log("✅ Bonding curve complete! Token graduated. Using Jupiter...");
      return true;
    }
    
    console.log("📊 Token still on pump.fun bonding curve. Using PumpPortal API...");
    return false;
    
  } catch (err) {
    console.error(`⚠️ Bond check error: ${err.message}. Defaulting to Jupiter...`);
    return true;
  }
}

// === PUMP.FUN BUY (Using PumpPortal API) ===
async function buyOnPumpFun(solAmount) {
  try {
    console.log(`🚀 Starting pump.fun buy with PumpPortal API: ${solAmount.toFixed(4)} SOL`);
    console.log(`📍 Buying to treasury, will split SUNO after...`);
    
    // Get transaction from PumpPortal
    console.log("📊 Getting PumpPortal transaction...");
    const quoteResponse = await fetch(`https://pumpportal.fun/api/trade-local`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        publicKey: TREASURY_KEYPAIR.publicKey.toBase58(),
        action: "buy",
        mint: TOKEN_MINT.toBase58(),
        denominatedInSol: "true",
        amount: solAmount,
        slippage: 10,
        priorityFee: 0.0001,
        pool: "pump"
      })
    });
    
    if (!quoteResponse.ok) {
      const errorText = await quoteResponse.text();
      throw new Error(`PumpPortal request failed: ${quoteResponse.status} - ${errorText}`);
    }
    
    const txData = await quoteResponse.arrayBuffer();
    console.log(`📦 Got transaction data: ${txData.byteLength} bytes`);
    
    // Deserialize the transaction
    const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
    
    // Sign transaction with treasury keypair
    console.log("✍️ Signing pump.fun transaction...");
    tx.sign([TREASURY_KEYPAIR]);
    
    // Send transaction
    console.log("📤 Sending pump.fun transaction...");
    const signature = await connection.sendTransaction(tx);
    
    console.log(`📤 Sent: ${signature.substring(0, 12)}...`);
    console.log(`🔗 https://solscan.io/tx/${signature}`);
    
    // Confirm transaction
    console.log("⏳ Confirming pump.fun transaction...");
    await connection.confirmTransaction(signature, "confirmed");
    
    console.log("✅ Pump.fun buy successful!");
    
    // Get token balance to see how much we got
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    const tokenBalance = await connection.getTokenAccountBalance(treasuryTokenAccount);
    const receivedTokens = parseInt(tokenBalance.value.amount);
    
    console.log(`🪙 Treasury received: ${receivedTokens.toLocaleString()} SUNO tokens`);
    
    return {
      success: true,
      signature,
      tokensReceived: receivedTokens
    };
    
  } catch (err) {
    console.error(`❌ Pump.fun buy failed: ${err.message}`);
    console.error(err.stack);
    return { success: false, error: err.message };
  }
}

// === JUPITER BUY (For bonded tokens) ===
async function buyOnJupiter(solAmount) {
  try {
    console.log(`🪐 Starting Jupiter swap: ${solAmount.toFixed(4)} SOL → SUNO`);
    
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const inputMint = SOL_MINT;
    const outputMint = TOKEN_MINT.toBase58();
    const amount = Math.floor(solAmount * 1e9); // Convert to lamports
    
    // Get quote from Jupiter
    console.log("📊 Getting Jupiter quote...");
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=300`;
    
    const quoteResponse = await fetch(quoteUrl);
    if (!quoteResponse.ok) {
      throw new Error(`Quote failed: ${quoteResponse.status}`);
    }
    
    const quoteData = await quoteResponse.json();
    console.log(`📊 Expected output: ~${(parseInt(quoteData.outAmount) / 1e6).toFixed(2)} SUNO`);
    
    // Get swap transaction
    console.log("🔄 Building swap transaction...");
    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: TREASURY_KEYPAIR.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        priorityLevelWithMaxLamports: {
          maxLamports: 100000,
          priorityLevel: "medium"
        }
      })
    });
    
    if (!swapResponse.ok) {
      throw new Error(`Swap transaction failed: ${swapResponse.status}`);
    }
    
    const { swapTransaction } = await swapResponse.json();
    
    // Deserialize and sign
    const swapTxBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    
    console.log("✍️ Signing Jupiter transaction...");
    tx.sign([TREASURY_KEYPAIR]);
    
    // Send transaction
    console.log("📤 Sending Jupiter swap...");
    const signature = await connection.sendTransaction(tx);
    
    console.log(`📤 Sent: ${signature.substring(0, 12)}...`);
    console.log(`🔗 https://solscan.io/tx/${signature}`);
    
    // Confirm
    console.log("⏳ Confirming Jupiter swap...");
    await connection.confirmTransaction(signature, "confirmed");
    
    console.log("✅ Jupiter swap successful!");
    
    // Get token balance
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    const tokenBalance = await connection.getTokenAccountBalance(treasuryTokenAccount);
    const receivedTokens = parseInt(tokenBalance.value.amount);
    
    console.log(`🪙 Treasury received: ${receivedTokens.toLocaleString()} SUNO tokens`);
    
    return {
      success: true,
      signature,
      tokensReceived: receivedTokens
    };
    
  } catch (err) {
    console.error(`❌ Jupiter swap failed: ${err.message}`);
    console.error(err.stack);
    return { success: false, error: err.message };
  }
}

// === EXPRESS APP ===
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

app.get("/", (req, res) => {
  const bonusPercentage = getTreasuryBonusPercentage();
  res.json({
    status: "✅ SunoLabs Buy SUNO Bot running!",
    phase,
    participants: participants.length,
    voters: voters.length,
    treasurySUNO: treasurySUNO.toLocaleString(),
    bonusPrize: `${calculateTreasuryBonus().toLocaleString()} SUNO (${(bonusPercentage * 100).toFixed(0)}% of treasury)`,
    bonusChance: `1 in ${TREASURY_BONUS_CHANCE.toLocaleString()}`,
    uptime: process.uptime()
  });
});

app.post(`/webhook/${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post("/confirm-payment", async (req, res) => {
  try {
    const { signature, reference, userId, amount, senderWallet } = req.body;
    
    console.log(`💰 Payment confirmation: ${amount} SOL from ${senderWallet?.substring(0, 8)}...`);
    
    if (!signature || !reference || !userId) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const pending = pendingPayments.find(p => p.reference === reference && p.userId === userId);
    
    if (!pending) {
      console.log(`⚠️ No pending payment found for reference ${reference}`);
      return res.status(404).json({ error: "Payment not found" });
    }
    
    if (pending.confirmed) {
      console.log(`⚠️ Payment already confirmed for ${userId}`);
      return res.json({ 
        message: "Already processed",
        sunoAmount: pending.sunoReceived || 0
      });
    }
    
    // Verify the transaction on-chain
    console.log(`🔍 Verifying transaction ${signature.substring(0, 8)}...`);
    
    try {
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      
      if (!tx) {
        throw new Error("Transaction not found");
      }
      
      console.log("✅ Transaction verified on-chain");
      
    } catch (verifyErr) {
      console.error(`❌ Transaction verification failed: ${verifyErr.message}`);
      return res.status(400).json({ error: "Transaction verification failed" });
    }
    
    // Mark as confirmed
    pending.confirmed = true;
    pending.signature = signature;
    pending.senderWallet = senderWallet;
    pending.solAmount = parseFloat(amount);
    
    const solAmount = parseFloat(amount);
    const transFee = solAmount * 0.10;
    const netSol = solAmount - transFee;
    
    const tier = getTier(solAmount);
    let retention = tier.retention;
    let multiplier = tier.multiplier;
    
    if (tier.name === "Whale") {
      retention = getWhaleRetention(solAmount);
      multiplier = getWhaleMultiplier(solAmount);
    }
    
    const userShare = netSol * retention;
    const poolShare = netSol - userShare;
    
    console.log(`📊 Tier: ${tier.badge} ${tier.name}`);
    console.log(`💰 Amount: ${solAmount} SOL → Net: ${netSol.toFixed(4)} SOL`);
    console.log(`👤 User gets: ${userShare.toFixed(4)} SOL in SUNO (${(retention*100).toFixed(0)}%)`);
    console.log(`🎯 Pool gets: ${poolShare.toFixed(4)} SOL in SUNO`);
    
    // Check if token has bonded
    const isBonded = await checkIfBonded();
    
    // Buy SUNO tokens
    let buyResult;
    if (isBonded) {
      buyResult = await buyOnJupiter(netSol);
    } else {
      buyResult = await buyOnPumpFun(netSol);
    }
    
    if (!buyResult.success) {
      console.error(`❌ Failed to buy SUNO: ${buyResult.error}`);
      return res.status(500).json({ error: "Token purchase failed" });
    }
    
    const totalTokens = buyResult.tokensReceived;
    const userTokens = Math.floor(totalTokens * retention);
    const poolTokens = totalTokens - userTokens;
    
    console.log(`🪙 Total SUNO: ${totalTokens.toLocaleString()}`);
    console.log(`👤 User SUNO: ${userTokens.toLocaleString()}`);
    console.log(`🎯 Pool SUNO: ${poolTokens.toLocaleString()}`);
    
    // Transfer user's share to their wallet
    const transferSuccess = await transferTokensToRecipient(userTokens, senderWallet);
    
    if (!transferSuccess) {
      console.error(`❌ Failed to transfer SUNO to user`);
      return res.status(500).json({ error: "Token transfer failed" });
    }
    
    // Add to treasury pool
    treasurySUNO += poolTokens;
    transFeeCollected += transFee;
    
    pending.sunoReceived = userTokens;
    pending.tierBadge = tier.badge;
    pending.tierName = tier.name;
    pending.multiplier = multiplier;
    
    // Mark as paid and add to appropriate group
    if (pending.choice === "upload") {
      participants.push({
        userId,
        user: pending.user || `User_${userId.substring(0, 6)}`,
        track: pending.track,
        trackDuration: pending.trackDuration || 0,
        title: pending.title,
        votes: 0,
        voters: [],
        solAmount,
        sunoReceived: userTokens,
        choice: "upload",
        tierBadge: tier.badge,
        tierName: tier.name,
        multiplier: multiplier,
        wallet: senderWallet
      });
      
      console.log(`🎵 Added uploader: ${pending.user}`);
      
      await bot.sendMessage(
        userId,
        `✅ Track Submitted!\n\n` +
        `${tier.badge} ${tier.name} Entry\n` +
        `💰 You received: ${userTokens.toLocaleString()} SUNO\n` +
        `🎯 Added to pool: ${poolTokens.toLocaleString()} SUNO\n` +
        `🏆 Prize Multiplier: ${multiplier.toFixed(2)}x\n\n` +
        `🎮 Voting starts soon! Good luck!`
      );
      
    } else {
      voters.push({
        userId,
        user: `User_${userId.substring(0, 6)}`,
        solAmount,
        sunoReceived: userTokens,
        votedFor: null,
        tierBadge: tier.badge,
        tierName: tier.name,
        multiplier: multiplier,
        wallet: senderWallet
      });
      
      console.log(`🗳️ Added voter`);
      
      await bot.sendMessage(
        userId,
        `✅ Registered as Voter!\n\n` +
        `${tier.badge} ${tier.name} Entry\n` +
        `💰 You received: ${userTokens.toLocaleString()} SUNO\n` +
        `🎯 Added to pool: ${poolTokens.toLocaleString()} SUNO\n` +
        `🏆 Voting Reward Multiplier: ${multiplier.toFixed(2)}x\n\n` +
        `🗳️ You'll earn rewards when you vote!`
      );
    }
    
    pending.paid = true;
    saveState();
    
    console.log(`✅ Payment processed for ${userId}`);
    console.log(`💎 Treasury: ${treasurySUNO.toLocaleString()} SUNO`);
    
    res.json({
      success: true,
      message: "Payment confirmed",
      sunoAmount: userTokens,
      poolAmount: poolTokens,
      treasuryTotal: treasurySUNO
    });
    
  } catch (err) {
    console.error(`❌ Payment confirmation error: ${err.message}`);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// === STATE PERSISTENCE ===
const STATE_FILE = "state.json";

function saveState() {
  try {
    const state = {
      treasurySUNO,
      transFeeCollected,
      pendingPayments,
      participants,
      voters,
      phase,
      cycleStartTime,
      nextPhaseTime
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("⚠️ Save state error:", err.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      treasurySUNO = state.treasurySUNO || 0;
      transFeeCollected = state.transFeeCollected || 0;
      pendingPayments = state.pendingPayments || [];
      participants = state.participants || [];
      voters = state.voters || [];
      phase = state.phase || "submission";
      cycleStartTime = state.cycleStartTime || null;
      nextPhaseTime = state.nextPhaseTime || null;
      console.log("✅ State loaded");
    }
  } catch (err) {
    console.error("⚠️ Load state error:", err.message);
  }
}

// === CYCLE MANAGEMENT ===
async function startNewCycle() {
  phase = "submission";
  cycleStartTime = Date.now();
  nextPhaseTime = cycleStartTime + (5 * 60 * 1000); // 5 minutes
  pendingPayments = [];
  participants = [];
  voters = [];
  saveState();

  const treasuryBonus = calculateTreasuryBonus();
  
  await bot.sendMessage(
    `@${MAIN_CHANNEL}`,
    `🎮 NEW COMPETITION ROUND!\n\n` +
    `💰 Current Prize Pool: ${treasurySUNO.toLocaleString()} SUNO\n` +
    `🎰 Bonus Prize: +${treasuryBonus.toLocaleString()} SUNO available!\n` +
    `✨ 1 in ${TREASURY_BONUS_CHANCE} chance to win it!\n\n` +
    `⏰ 5 minutes to join!\n\n` +
    `🎵 Upload track & compete OR 🗳️ Vote & earn\n` +
    `Start: @sunolabs_submissions_bot`
  );

  console.log(`🚀 New cycle started! 5 minute submission phase.`);
  
  setTimeout(() => startVoting(), 5 * 60 * 1000);
}

async function startVoting() {
  const uploaders = participants.filter(p => p.choice === "upload" && p.track);

  if (uploaders.length === 0) {
    phase = "cooldown";
    saveState();
    
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `⚠️ No tracks submitted this round.\n\n💰 ${treasurySUNO.toLocaleString()} SUNO rolls over to next round!\n\n🎮 New round in 1 minute...`
    );
    
    console.log("⚠️ No submissions. Starting new cycle in 1 minute.");
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  phase = "voting";
  
  // Calculate voting time dynamically
  const votingDuration = calculateVotingTime();
  nextPhaseTime = Date.now() + votingDuration;
  
  saveState();

  const votingMinutes = Math.ceil(votingDuration / 60000);
  const treasuryBonus = calculateTreasuryBonus();

  await bot.sendMessage(
    `@${MAIN_CHANNEL}`,
    `🗳️ VOTING PHASE!\n\n` +
    `🎵 ${uploaders.length} track${uploaders.length !== 1 ? 's' : ''} competing\n` +
    `⏰ ${votingMinutes} minute${votingMinutes !== 1 ? 's' : ''} to vote!\n\n` +
    `💰 Prize Pool: ${treasurySUNO.toLocaleString()} SUNO\n` +
    `🎰 Bonus Prize: +${treasuryBonus.toLocaleString()} SUNO!\n` +
    `✨ 1 in ${TREASURY_BONUS_CHANCE} chance for winner!\n\n` +
    `Tracks below 👇`
  );

  for (const entry of uploaders) {
    try {
      await bot.sendAudio(
        `@${CHANNEL}`,
        entry.track,
        {
          caption: `${entry.tierBadge} ${entry.user} — ${entry.title}\n🔥 0`,
          reply_markup: {
            inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.userId}` }]]
          }
        }
      );
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.error(`❌ Failed to post track for ${entry.user}: ${err.message}`);
    }
  }

  console.log(`🗳️ Voting started for ${votingMinutes} minutes (based on ${uploaders.length} tracks)`);
  
  setTimeout(() => announceWinners(), votingDuration);
}

async function announceWinners() {
  phase = "cooldown";
  saveState();

  const uploaders = participants.filter(p => p.choice === "upload" && p.track);
  
  if (uploaders.length === 0) {
    console.log("⚠️ No tracks to announce winners for");
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  uploaders.sort((a, b) => b.votes - a.votes);

  const maxVotes = uploaders[0].votes;
  const winners = uploaders.filter(e => e.votes === maxVotes);

  console.log(`🏆 Winners: ${winners.length} with ${maxVotes} votes each`);

  // Check for treasury bonus (1 in 10,000 chance)
  const wonTreasuryBonus = checkTreasuryBonus();
  const treasuryBonusAmount = calculateTreasuryBonus();
  
  let bonusMessage = "";
  if (wonTreasuryBonus) {
    bonusMessage = `\n\n🎰✨ BONUS PRIZE HIT! ✨🎰\nWinner(s) get +${treasuryBonusAmount.toLocaleString()} SUNO bonus!`;
  }

  const baseShare = Math.floor(treasurySUNO / winners.length);
  
  let announceText = `🏆 WINNERS!\n\n`;
  
  for (const winner of winners) {
    let winnerPrize = Math.floor(baseShare * winner.multiplier);
    
    // Add treasury bonus if won
    if (wonTreasuryBonus) {
      winnerPrize += treasuryBonusAmount;
    }
    
    announceText += `${winner.tierBadge} ${winner.user}\n`;
    announceText += `🔥 ${winner.votes} votes\n`;
    announceText += `💰 ${winnerPrize.toLocaleString()} SUNO`;
    if (wonTreasuryBonus) {
      announceText += ` (+ ${treasuryBonusAmount.toLocaleString()} bonus!)`;
    }
    announceText += `\n\n`;
    
    const transferSuccess = await transferTokensToRecipient(winnerPrize, winner.wallet);
    
    if (transferSuccess) {
      await bot.sendMessage(
        winner.userId,
        `🎉 YOU WON!\n\n` +
        `🏆 Prize: ${winnerPrize.toLocaleString()} SUNO\n` +
        `🔥 ${winner.votes} votes\n` +
        `${winner.tierBadge} ${winner.tierName} (${winner.multiplier.toFixed(2)}x)\n` +
        (wonTreasuryBonus ? `🎰 BONUS PRIZE: +${treasuryBonusAmount.toLocaleString()} SUNO!\n` : '') +
        `\n✅ Transferred to your wallet!`
      );
    }
  }

  announceText += bonusMessage;
  announceText += `\n\n🎰 Every round: 1 in ${TREASURY_BONUS_CHANCE} chance for bonus!`;

  await bot.sendMessage(`@${MAIN_CHANNEL}`, announceText);

  // Distribute voter rewards
  const voterRewards = Math.floor(treasurySUNO * 0.10 / voters.length);
  
  for (const voter of voters) {
    if (!voter.votedFor) continue;
    
    const voterPrize = Math.floor(voterRewards * voter.multiplier);
    
    const transferSuccess = await transferTokensToRecipient(voterPrize, voter.wallet);
    
    if (transferSuccess) {
      await bot.sendMessage(
        voter.userId,
        `🗳️ Voting Reward!\n\n` +
        `💰 ${voterPrize.toLocaleString()} SUNO\n` +
        `${voter.tierBadge} ${voter.tierName} (${voter.multiplier.toFixed(2)}x)\n\n` +
        `Thanks for participating!`
      );
    }
  }

  console.log(`💰 Distributed ${treasurySUNO.toLocaleString()} SUNO`);
  participants = [];
  voters = [];
  treasurySUNO = 0;
  pendingPayments = [];
  saveState();
  
  setTimeout(() => startNewCycle(), 60 * 1000);
}

// === TELEGRAM HANDLERS ===
bot.onText(/\/start|play/i, async (msg) => {
  const user = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "Unknown";
  const userId = String(msg.from.id);

  if (phase !== "submission") {
    await bot.sendMessage(userId, `⚠️ ${phase} phase active. Wait for next round!`);
    return;
  }

  const now = Date.now();
  let timeMessage = "";
  
  if (cycleStartTime) {
    const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
    const timeRemaining = Math.max(0, submissionEndTime - now);
    const minutesLeft = Math.ceil(timeRemaining / 60000);
    timeMessage = `\n⏰ ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''} left to join!`;
  }

  const treasuryBonus = calculateTreasuryBonus();

  await bot.sendMessage(
    userId,
    `🎮 Welcome to SunoLabs Competition!\n\n` +
    `💰 Prize Pool: ${treasurySUNO.toLocaleString()} SUNO\n` +
    `🎰 Bonus Prize: +${treasuryBonus.toLocaleString()} SUNO available!\n` +
    `✨ 1 in ${TREASURY_BONUS_CHANCE} chance to win it!${timeMessage}\n\n` +
    `🎯 Choose your path:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎵 Upload Track & Compete", callback_data: `start_upload_${userId}` }],
          [{ text: "🗳️ Vote Only & Earn", callback_data: `start_vote_${userId}` }]
        ]
      }
    }
  );
});

bot.on("message", async (msg) => {
  // Ignore non-private chats
  if (msg.chat.type !== "private") return;

  const userId = String(msg.from.id);
  
  // Handle audio files (track uploads)
  if (msg.audio) {
    const user = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "Unknown";

    if (phase !== "submission") {
      await bot.sendMessage(userId, `⚠️ ${phase} phase active. Type /start when a new round begins!`);
      return;
    }

    // Check if user has chosen upload path
    const uploadChoice = pendingPayments.find(p => p.userId === userId && p.choice === "upload" && !p.paid);
    
    if (!uploadChoice) {
      await bot.sendMessage(
        userId,
        `⚠️ Please type /start and choose "Upload Track" first!`
      );
      return;
    }

    // Save the track and duration
    uploadChoice.track = msg.audio.file_id;
    uploadChoice.title = msg.audio.file_name || msg.audio.title || "Untitled";
    uploadChoice.trackDuration = msg.audio.duration || 0; // Duration in seconds
    uploadChoice.user = user;
    saveState();

    const reference = uploadChoice.reference;
    const redirectLink = `https://sunolabs-redirect.onrender.com/pay?recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference}&userId=${userId}`;

    await bot.sendMessage(
      userId,
      `🎧 Track received! ${uploadChoice.trackDuration > 0 ? `(${uploadChoice.trackDuration}s)` : ''}\n\n🪙 Now buy SUNO tokens to enter the competition!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🪙 Buy SUNO & Enter Competition", url: redirectLink }]
          ]
        }
      }
    );
    return;
  }
  
  // Handle /start command (already handled above, but just in case)
  if (msg.text?.match(/^\/start|^play$/i)) {
    return; // Already handled by onText
  }
  
  // Catch-all for any other text message
  if (msg.text) {
    const now = Date.now();
    let phaseInfo = "";
    
    if (phase === "submission" && cycleStartTime) {
      const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
      const timeRemaining = Math.max(0, submissionEndTime - now);
      const minutesLeft = Math.ceil(timeRemaining / 60000);
      phaseInfo = `\n\n⏰ Current round ends in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`;
    } else if (phase === "voting") {
      phaseInfo = `\n\n🗳️ Voting is currently active! Check @${CHANNEL}`;
    } else if (phase === "cooldown") {
      phaseInfo = `\n\n⏰ New round starting soon!`;
    }
    
    await bot.sendMessage(
      userId,
      `👋 Hi! Welcome to SunoLabs Competition!\n\n🎮 To play, type:\n/start\n\nThen choose:\n🎵 Upload track & compete for SUNO prizes\n🗳️ Vote only & earn SUNO rewards${phaseInfo}`
    );
  }
});

bot.on("callback_query", async (q) => {
  try {
    // Handle initial choice (before payment)
    if (q.data.startsWith("start_")) {
      const [, action, userKey] = q.data.split("_");
      
      if (phase !== "submission") {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Submission phase ended!" });
        return;
      }

      const reference = Keypair.generate().publicKey;
      const redirectLink = `https://sunolabs-redirect.onrender.com/pay?recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference.toBase58()}&userId=${userKey}`;

      if (action === "upload") {
        // User chose to upload track
        pendingPayments.push({
          userId: userKey,
          choice: "upload",
          reference: reference.toBase58(),
          confirmed: false,
          paid: false
        });
        saveState();

        await bot.answerCallbackQuery(q.id, { text: "✅ Upload mode selected!" });
        await bot.sendMessage(
          userKey,
          `🎵 Upload Track & Compete!\n\n📤 Send me your audio file now.`
        );

      } else if (action === "vote") {
        // User chose to vote only
        pendingPayments.push({
          userId: userKey,
          choice: "vote",
          reference: reference.toBase58(),
          confirmed: false,
          paid: false
        });
        saveState();

        await bot.answerCallbackQuery(q.id, { text: "✅ Vote mode selected!" });
        await bot.sendMessage(
          userKey,
          `🗳️ Vote Only & Earn!\n\n🪙 Buy SUNO tokens to participate!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🪙 Buy SUNO & Join as Voter", url: redirectLink }]
              ]
            }
          }
        );
      }
      
      return;
    }

    // Handle voting on tracks
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
