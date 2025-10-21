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
    
    // PumpPortal returns raw binary transaction data (not base64!)
    const txData = await quoteResponse.arrayBuffer();
    console.log(`✅ Got transaction data (${txData.byteLength} bytes)`);
    
    // Deserialize and sign transaction
    console.log("🔓 Deserializing transaction...");
    const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
    tx.sign([TREASURY_KEYPAIR]);
    
    // Send transaction
    console.log("📤 Sending buy transaction...");
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    });
    
    console.log(`📤 Transaction sent: ${sig.substring(0, 8)}...`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
    console.log("⏳ Confirming transaction...");
    
    await connection.confirmTransaction(sig, "confirmed");
    
    console.log(`✅ Pump.fun buy complete!`);
    
    // Wait for balance update
    await new Promise(r => setTimeout(r, 3000));
    
    // Get treasury token account
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    // Get tokens bought
    const balance = await connection.getTokenAccountBalance(treasuryTokenAccount);
    const receivedTokens = parseInt(balance.value.amount);
    
    console.log(`🪙 Treasury received ${receivedTokens.toLocaleString()} SUNO tokens (will split next)`);
    
    return receivedTokens;
    
  } catch (err) {
    console.error(`❌ Pump.fun buy failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

// === JUPITER SWAP ===
async function buyOnJupiter(solAmount) {
  try {
    console.log(`🪐 Starting Jupiter swap: ${solAmount.toFixed(4)} SOL → SUNO`);
    console.log(`📍 Buying to treasury, will split SUNO after...`);
    
    const lamports = Math.floor(solAmount * 1e9);
    
    // Get treasury's token account (where tokens will go)
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    console.log(`📍 Treasury token account: ${treasuryTokenAccount.toBase58().substring(0, 8)}...`);
    
    // Get quote from Jupiter
    console.log("📊 Getting Jupiter quote...");
    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${TOKEN_MINT.toBase58()}&amount=${lamports}&slippageBps=500`
    );
    
    if (!quoteResponse.ok) {
      throw new Error(`Jupiter quote request failed: ${quoteResponse.status} ${quoteResponse.statusText}`);
    }
    
    const quoteData = await quoteResponse.json();
    
    if (!quoteData || quoteData.error) {
      throw new Error(`Quote failed: ${quoteData?.error || 'Unknown error'}`);
    }
    
    const outAmount = parseInt(quoteData.outAmount);
    console.log(`💎 Quote received: ${outAmount.toLocaleString()} SUNO (${(outAmount / 1e6).toFixed(2)}M tokens)`);
    
    // Get swap transaction (to treasury's token account)
    console.log("🔨 Building swap transaction...");
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: TREASURY_KEYPAIR.publicKey.toBase58(),
        destinationTokenAccount: treasuryTokenAccount.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 100000,
            priorityLevel: "high"
          }
        }
      })
    });
    
    if (!swapResponse.ok) {
      throw new Error(`Jupiter swap request failed: ${swapResponse.status} ${swapResponse.statusText}`);
    }
    
    const swapData = await swapResponse.json();
    
    if (!swapData.swapTransaction) {
      throw new Error('No swap transaction returned from Jupiter');
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
      maxRetries: 3
    });
    
    console.log(`📤 Transaction sent: ${sig.substring(0, 8)}...`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
    console.log("⏳ Confirming transaction...");
    
    await connection.confirmTransaction(sig, 'confirmed');
    
    console.log(`✅ Jupiter swap complete!`);
    console.log(`🪙 Treasury received ~${outAmount.toLocaleString()} SUNO tokens (will split next)`);
    
    return outAmount;
    
  } catch (err) {
    console.error(`❌ Jupiter swap failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

// === MARKET INTEGRATION (Auto-detect pump.fun or Jupiter) ===
async function buySUNOOnMarket(solAmount) {
  try {
    console.log(`\n🔄 ========== BUYING SUNO ==========`);
    console.log(`💰 Amount: ${solAmount.toFixed(4)} SOL`);
    console.log(`📍 Buying to treasury (will split after)`);
    
    const isBonded = await checkIfBonded();
    
    let sunoAmount;
    if (isBonded) {
      // Use Jupiter
      console.log("📊 Using Jupiter (token graduated)...");
      sunoAmount = await buyOnJupiter(solAmount);
    } else {
      // Try pump.fun, fallback to Jupiter if it fails
      console.log("📊 Trying PumpPortal (token on bonding curve)...");
      try {
        sunoAmount = await buyOnPumpFun(solAmount);
      } catch (pumpError) {
        console.error(`⚠️ PumpPortal failed: ${pumpError.message}`);
        console.log("🔄 Falling back to Jupiter...");
        sunoAmount = await buyOnJupiter(solAmount);
      }
    }
    
    console.log(`✅ Purchase complete! ${sunoAmount.toLocaleString()} SUNO now in treasury`);
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
        treasurySUNO,
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
    treasurySUNO = d.treasurySUNO || 0;
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
app.use(express.json({ limit: '10kb' })); // Limit request size
const PORT = process.env.PORT || 10000;

// === RATE LIMITING ===
const paymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 payment confirmations per minute per IP
  message: { error: '⚠️ Too many payment attempts, please wait' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: { error: '⚠️ Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/", generalLimiter, async (_, res) => {
  const uploaders = participants.filter(p => p.choice === "upload" && p.paid).length;
  const voteOnly = voters.length;
  
  res.json({
    status: "✅ SunoLabs Buy SUNO System Live",
    mode: "webhook",
    phase,
    uploaders,
    voteOnly,
    treasury: treasurySUNO.toLocaleString() + " SUNO",
    transFees: transFeeCollected.toFixed(4) + " SOL",
    uptime: process.uptime()
  });
});

app.post(`/webhook/${token}`, generalLimiter, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === PAYMENT CONFIRMATION ===
app.post("/confirm-payment", paymentLimiter, async (req, res) => {
  console.log("\n==============================================");
  console.log("🔔 /confirm-payment ENDPOINT HIT!");
  console.log("📦 Request body:", JSON.stringify(req.body, null, 2));
  console.log("==============================================\n");
  
  try {
    const { signature, reference, userId, amount, senderWallet } = req.body;
    
    // === VALIDATION ===
    console.log("🔍 Validating parameters...");
    if (!userId || !reference || !senderWallet) {
      console.log("❌ MISSING PARAMETERS!");
      console.warn("⚠️ Missing params:", req.body);
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Validate amount is reasonable
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 0.001 || amountNum > 100) {
      console.log("❌ INVALID AMOUNT:", amount);
      return res.status(400).json({ error: "Invalid amount (must be 0.001-100 SOL)" });
    }
    
    // Validate wallet address
    try {
      new PublicKey(senderWallet);
    } catch (e) {
      console.log("❌ INVALID WALLET:", senderWallet);
      return res.status(400).json({ error: "Invalid wallet address" });
    }
    
    console.log("✅ Parameters validated!");

    const userKey = String(userId);
    
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
    const remainingSOL = amountNum * 0.90;
    
    const tier = getTier(amountNum);
    let retention = tier.retention;
    let multiplier = tier.multiplier;
    
    if (tier === TIERS.WHALE) {
      retention = getWhaleRetention(amountNum);
      multiplier = getWhaleMultiplier(amountNum);
    }
    
    console.log(`\n💰 ========== PAYMENT SPLIT ==========`);
    console.log(`🏦 Trans Fee (10%): ${transFee.toFixed(4)} SOL → Fee wallet`);
    console.log(`💎 Buy SUNO with: ${remainingSOL.toFixed(4)} SOL`);
    console.log(`📊 Then split SUNO tokens:`);
    console.log(`   👤 User gets: ${(retention * 100).toFixed(0)}% of SUNO`);
    console.log(`   🏆 Competition pool: ${((1 - retention) * 100).toFixed(0)}% of SUNO`);
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

    // === BUY SUNO WITH ALL REMAINING SOL ===
    let totalSUNO = 0;
    console.log("\n🪙 Starting SUNO purchase with ALL remaining SOL...");
    try {
      totalSUNO = await buySUNOOnMarket(remainingSOL);
      console.log(`\n✅ SUNO purchase SUCCESS: ${totalSUNO.toLocaleString()} tokens total`);
    } catch (err) {
      console.error(`\n❌ SUNO purchase FAILED: ${err.message}`);
      console.error(err.stack);
    }

    // === CHECK IF PURCHASE WAS SUCCESSFUL ===
    if (totalSUNO === 0 || !totalSUNO) {
      console.log("⚠️ SUNO purchase returned 0 tokens - notifying user of failure");
      
      try {
        await bot.sendMessage(
          userId,
          `❌ Purchase Failed!\n\n⚠️ We received your ${amountNum} SOL payment, but the SUNO token purchase failed.\n\n🔄 Please contact support or try again.\n\nError: Token purchase returned 0 tokens.`
        );
      } catch (e) {
        console.error("⚠️ Failed to send error message:", e.message);
      }
      
      console.log("✅ Error notification sent - returning error to client\n");
      return res.json({ ok: false, error: "SUNO purchase failed", sunoAmount: 0 });
    }

    // === SPLIT SUNO TOKENS ===
    const userSUNO = Math.floor(totalSUNO * retention);
    const competitionSUNO = totalSUNO - userSUNO;
    
    console.log(`\n💎 ========== SUNO TOKEN SPLIT ==========`);
    console.log(`🪙 Total SUNO bought: ${totalSUNO.toLocaleString()}`);
    console.log(`👤 User gets: ${userSUNO.toLocaleString()} SUNO (${(retention * 100).toFixed(0)}%)`);
    console.log(`🏆 Competition pool: ${competitionSUNO.toLocaleString()} SUNO (${((1 - retention) * 100).toFixed(0)}%)`);
    console.log(`========================================\n`);

    // === TRANSFER USER'S PORTION ===
    console.log(`📤 Transferring ${userSUNO.toLocaleString()} SUNO to user...`);
    const transferSuccess = await transferTokensToRecipient(userSUNO, senderWallet);
    
    if (!transferSuccess) {
      console.error("❌ Transfer failed!");
      try {
        await bot.sendMessage(
          userId,
          `❌ Transfer Failed!\n\n⚠️ SUNO purchase succeeded but transfer to your wallet failed.\n\nPlease contact support.`
        );
      } catch (e) {}
      return res.json({ ok: false, error: "Transfer failed", sunoAmount: 0 });
    }

    console.log(`✅ ${userSUNO.toLocaleString()} SUNO → ${senderWallet.substring(0, 8)}...`);

    // === ADD COMPETITION POOL TO TREASURY ===
    treasurySUNO += competitionSUNO;
    console.log(`\n🏦 Treasury updated: +${competitionSUNO.toLocaleString()} SUNO (Total: ${treasurySUNO.toLocaleString()} SUNO)`);

    // === SAVE USER DATA ===
    const userData = {
      userId: userKey,
      wallet: senderWallet,
      amount: amountNum,
      sunoReceived: userSUNO,
      tier: tier.name,
      tierBadge: tier.badge,
      retention: (retention * 100).toFixed(0) + "%",
      multiplier,
      paid: true,
      timestamp: Date.now()
    };

    // === REGISTER USER BASED ON PRE-SELECTED CHOICE ===
    const payment = pendingPayments.find(p => p.reference === reference);
    const userChoice = payment?.choice || "vote"; // Default to vote if somehow missing

    if (userChoice === "upload") {
      // Register as competitor
      if (!payment.track) {
        console.log("⚠️ User chose upload but didn't send audio - defaulting to vote");
        voters.push({
          ...userData,
          choice: "vote",
          votedFor: null
        });
        
        try {
          await bot.sendMessage(
            userId,
            `✅ Payment complete!\n\n🪙 ${userSUNO.toLocaleString()} SUNO sent!\n${tier.badge} ${tier.name} tier (${(retention * 100).toFixed(0)}% retention)\n💰 ${multiplier}x prize multiplier\n\n⚠️ No audio found - registered as voter.\n🗳️ Vote during voting phase to earn rewards!`
          );
        } catch (e) {
          console.error("⚠️ DM error:", e.message);
        }
      } else {
        participants.push({
          ...userData,
          choice: "upload",
          user: payment.user,
          track: payment.track,
          title: payment.title,
          votes: 0,
          voters: []
        });
        
        try {
          await bot.sendMessage(
            userId,
            `✅ Track entered!\n\n🪙 ${userSUNO.toLocaleString()} SUNO sent!\n${tier.badge} ${tier.name} tier (${(retention * 100).toFixed(0)}% retention)\n💰 ${multiplier}x prize multiplier\n\n🎵 Your track "${payment.title}" is in the competition!\n🍀 Good luck!`
          );
        } catch (e) {
          console.error("⚠️ DM error:", e.message);
        }
      }
    } else {
      // Register as voter
      voters.push({
        ...userData,
        choice: "vote",
        votedFor: null
      });
      
      try {
        await bot.sendMessage(
          userId,
          `✅ Registered as voter!\n\n🪙 ${userSUNO.toLocaleString()} SUNO sent!\n${tier.badge} ${tier.name} tier (${(retention * 100).toFixed(0)}% retention)\n💰 ${multiplier}x prize multiplier\n\n🗳️ Vote during voting phase to earn rewards!`
        );
      } catch (e) {
        console.error("⚠️ DM error:", e.message);
      }
    }

    // Mark as paid
    if (payment) {
      payment.paid = true;
      payment.userData = userData;
    }

    saveState();

    console.log("✅ Payment processing complete - returning success to client\n");
    res.json({ ok: true, sunoAmount: userSUNO });
  } catch (err) {
    console.error(`\n💥 FATAL ERROR in confirm-payment: ${err.message}`);
    console.error(err.stack);
    res.status(500).json({ error: "Internal error" });
  }
});

// === SOL PAYOUT (for trans fees) ===
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

// === SUNO TOKEN PAYOUT ===
async function sendSUNOPayout(destination, amountSUNO, reason = "payout") {
  try {
    console.log(`💸 ${reason}: ${amountSUNO.toLocaleString()} SUNO → ${destination.substring(0, 8)}...`);
    
    const success = await transferTokensToRecipient(amountSUNO, destination);
    
    if (!success) {
      console.error(`⚠️ ${reason} failed!`);
    }
    
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
  
  console.log(`🎬 NEW CYCLE: Submission phase (5 min), Prize pool: ${treasurySUNO.toLocaleString()} SUNO`);
  
  try {
    const botMention = botUsername.startsWith('@') ? botUsername : `@${botUsername}`;
    
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎬 NEW ROUND STARTED!\n\n💰 Prize Pool: ${treasurySUNO.toLocaleString()} SUNO\n⏰ 5 minutes to join!\n\n🎮 How to Play:\n1️⃣ Open ${botMention}\n2️⃣ Type /start\n3️⃣ Choose your path:\n   🎵 Upload track & compete for prizes\n   🗳️ Vote only & earn rewards\n4️⃣ Buy SUNO tokens (0.01 SOL minimum)\n5️⃣ Win SUNO prizes! 🏆\n\n🚀 Start now!`
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
      `🗳️ VOTING STARTED!\n\n💰 Prize Pool: ${treasurySUNO.toLocaleString()} SUNO\n⏰ 5 minutes to vote!\n\n🔥 Listen to tracks & vote for your favorite!\n📍 Vote here: https://t.me/${CHANNEL}\n\n🏆 Winners get 80% of prize pool\n💰 Voters who pick the winner share 20%!`
    );
  } catch {}

  try {
    await bot.sendMessage(
      `@${CHANNEL}`,
      `🗳️ VOTING STARTED!\n\n💰 Prize Pool: ${treasurySUNO.toLocaleString()} SUNO\n⏰ 5 minutes to vote!\n\n🎵 Listen to each track below\n🔥 Vote for your favorite!\n\n🏆 Top 5 tracks win prizes\n💎 Vote for the winner = earn rewards!`
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
    treasurySUNO = 0;
    pendingPayments = [];
    saveState();
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  const sorted = [...uploaders].sort((a, b) => b.votes - a.votes);
  const weights = [0.40, 0.25, 0.20, 0.10, 0.05];
  const numWinners = Math.min(5, sorted.length);
  
  const prizePool = Math.floor(treasurySUNO * 0.80);
  const voterPool = treasurySUNO - prizePool;
  
  let resultsMsg = `🏆 Competition Results 🏆\n💰 Prize Pool: ${prizePool.toLocaleString()} SUNO\n\n`;
  
  for (let i = 0; i < numWinners; i++) {
    const w = sorted[i];
    const baseAmt = Math.floor(prizePool * weights[i]);
    const finalAmt = Math.floor(baseAmt * w.multiplier);
    
    resultsMsg += `#${i + 1} ${w.tierBadge} ${w.user} — ${w.votes}🔥 — ${finalAmt.toLocaleString()} SUNO\n`;
    
    if (w.wallet && finalAmt > 0) {
      await sendSUNOPayout(w.wallet, finalAmt, `Prize #${i + 1}`);
      
      try {
        await bot.sendMessage(w.userId, `🎉 You won ${finalAmt.toLocaleString()} SUNO! Check your wallet! 🎊`);
      } catch {}
    }
  }

  const winner = sorted[0];
  const winnerVoters = voters.filter(v => v.votedFor === winner.userId);
  
  if (winnerVoters.length > 0 && voterPool > 0) {
    const totalVoterAmount = winnerVoters.reduce((sum, v) => sum + v.amount, 0);
    
    resultsMsg += `\n🗳️ Voter Rewards: ${voterPool.toLocaleString()} SUNO\n`;
    
    for (const v of winnerVoters) {
      const share = Math.floor((v.amount / totalVoterAmount) * voterPool);
      
      if (share > 0) {
        await sendSUNOPayout(v.wallet, share, "Voter reward");
        
        try {
          await bot.sendMessage(v.userId, `🎉 You voted for the winner!\nReward: ${share.toLocaleString()} SUNO 💰`);
        } catch {}
      }
    }
    
    resultsMsg += `✅ ${winnerVoters.length} voter(s) rewarded!`;
  }

  try {
    await bot.sendMessage(`@${CHANNEL}`, resultsMsg);
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎉 WINNER: ${winner.tierBadge} ${winner.user}\n💰 Won ${Math.floor(prizePool * 0.40 * winner.multiplier).toLocaleString()} SUNO!\n\n🏆 See full results in @${CHANNEL}\n⏰ Next round starts in 1 minute!\n\n🎮 Type /start in the bot to play!`
    );
  } catch {}

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

  await bot.sendMessage(
    userId,
    `🎮 Welcome to SunoLabs Competition!\n\n💰 Prize Pool: ${treasurySUNO.toLocaleString()} SUNO${timeMessage}\n\n🎯 Choose your path:`,
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

    // Save the track
    uploadChoice.track = msg.audio.file_id;
    uploadChoice.title = msg.audio.file_name || "Untitled";
    uploadChoice.user = user;
    saveState();

    const reference = uploadChoice.reference;
    const redirectLink = `https://sunolabs-redirect.onrender.com/pay?recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference}&userId=${userId}`;

    await bot.sendMessage(
      userId,
      `🎧 Track received!\n\n🪙 Now buy SUNO tokens to enter the competition!`,
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
