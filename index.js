// === IMPORTS ===
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fs from "fs";
import { Connection, clusterApiUrl, Keypair, PublicKey } from "@solana/web3.js";
import { encodeURL, findReference } from "@solana/pay";
import BigNumber from "bignumber.js"; // ✅ BigNumber fix

// === TELEGRAM CONFIG ===
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const CHANNEL = "sunolabs_submissions"; // without @

// === SOLANA CONFIG ===
const TREASURY = new PublicKey("98tf4zU5WhLmsCt1D4HQH5Ej9C5aFwCz8KQwykmKvDDQ");
const connection = new Connection(clusterApiUrl("mainnet-beta"));
let potSOL = 0;
let pendingPayments = []; // { userId, username, reference, confirmed }

// === SAVE PATH ===
const SAVE_FILE = fs.existsSync("/data")
  ? "/data/submissions.json"
  : "./submissions.json";

let submissions = [];
let phase = "submissions";
let nextRoundTime = null;

// === UTILS ===
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
    console.error("⚠️ Failed to load:", e.message);
  }
}
loadState();

console.log("🚀 SunoLabs Bot started at", new Date().toISOString());

// === HANDLE AUDIO SUBMISSIONS ===
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private" || !msg.audio) return;

  const user = msg.from.username
    ? `@${msg.from.username}`
    : msg.from.first_name || "Unknown";
  const userId = msg.from.id;

  // prevent new entries during voting
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

  // prevent duplicates
  if (submissions.find((s) => s.userId === userId)) {
    await bot.sendMessage(
      msg.chat.id,
      "⚠️ You already submitted a track this round!",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // === Generate Solana Pay Link ===
  const reference = Keypair.generate().publicKey;
  const amount = new BigNumber(0.01); // ✅ must be BigNumber

  const payURL = encodeURL({
    recipient: TREASURY,
    amount,
    label: "SunoLabs Entry",
    message: `Confirm entry for ${user}`,
    reference: [reference],
  });

  pendingPayments.push({
    userId,
    username: user,
    reference: reference.toBase58(),
    confirmed: false,
  });
  saveState();

// === create Phantom-compatible redirect link ===
const redirectLink = `https://phantom.app/ul/v1/pay?recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference.toBase58()}&label=SunoLabs%20Entry&message=Confirm%20entry%20for%20${encodeURIComponent(
  user
)}`;

// === send Telegram message ===
await bot.sendMessage(
  msg.chat.id,
  `🎧 Got your audio track!\n\nBefore it's accepted, please confirm your entry by sending ≥ *0.01 SOL*.\n\n👉 [Tap here to pay with Phantom (Solana Pay)](${redirectLink})\n\nFunds go directly to the community pot.`,
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

// === PAYMENT WATCHER ===
setInterval(async () => {
  for (const p of pendingPayments.filter((x) => !x.confirmed)) {
    try {
      const sigInfo = await findReference(
        connection,
        new PublicKey(p.reference)
      );
      // if found, mark confirmed
      p.confirmed = true;
      potSOL += 0.01; // assume min 0.01 SOL
      saveState();

      const entry = submissions.find((s) => s.userId === p.userId);
      if (entry) entry.paid = true;

      await bot.sendMessage(
        "@sunolabs",
        `💰 ${p.username} donated 0.01 SOL — added to the POT! 💎\nCurrent total: ${potSOL.toFixed(
          2
        )} SOL`
      );
      await bot.sendMessage(
        p.userId,
        "✅ Payment confirmed — your track is now officially entered!"
      );
    } catch {
      // not found yet
    }
  }
}, 60000); // every 60 seconds

// === HANDLE VOTES ===
bot.on("callback_query", async (q) => {
  const [action, userIdStr] = q.data.split("_");
  const userId = Number(userIdStr);
  const voter = q.from.username || q.from.first_name;
  const entry = submissions.find((s) => s.userId === userId);
  if (!entry) return;

  if (entry.voters.includes(voter)) {
    return bot.answerCallbackQuery(q.id, { text: "⚠️ You already voted." });
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
  } catch {}
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
  )} SOL\n`;
  msg += `Treasury Share: ${treasuryShare.toFixed(2)} SOL\n\n`;
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

  // reset state
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
    console.log("🎬 Starting daily cycle...");
    await postSubmissions();
    setTimeout(async () => {
      console.log("🕒 Announcing daily winners...");
      await announceWinners();
    }, 12 * 60 * 60 * 1000);
  });
}

console.log("✅ SunoLabs Bot (with Solana Pay donations) running...");


