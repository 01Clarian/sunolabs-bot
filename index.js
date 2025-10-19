import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fs from "fs";

// === CONFIG ===
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const CHANNEL = "sunolabs_submissions"; // without @

// === PERSISTENT SAVE PATH ===
const SAVE_FILE = fs.existsSync("/data") ? "/data/submissions.json" : "./submissions.json";

let submissions = [];
let phase = "submissions";
let nextRoundTime = null;

console.log("🚀 SunoLabs Bot started at", new Date().toISOString());

// === PERSISTENCE ===
function saveSubmissions() {
  try {
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ submissions, phase, nextRoundTime }, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to save submissions:", err.message);
  }
}

function loadSubmissions() {
  if (fs.existsSync(SAVE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SAVE_FILE));
      submissions = data.submissions || [];
      phase = data.phase || "submissions";
      nextRoundTime = data.nextRoundTime || null;
      console.log(`💾 Loaded ${submissions.length} saved submissions (phase: ${phase})`);
    } catch (err) {
      console.error("⚠️ Failed to load saved submissions:", err.message);
    }
  }
}
loadSubmissions();

// === HANDLE AUDIO SUBMISSIONS (DM ONLY) ===
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private" || !msg.audio) return;

  const user =
    msg.from.username
      ? `@${msg.from.username.replace(/_/g, "\\_")}`
      : `${msg.from.first_name || "Unknown"}`;
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

  // Prevent duplicate submissions per user
  if (submissions.find((s) => s.userId === userId)) {
    await bot.sendMessage(
      msg.chat.id,
      "⚠️ You already submitted a track this round! Please wait for the next one.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const fileId = msg.audio.file_id;
  const now = new Date();
  const nextRound = new Date(Math.ceil(now.getTime() / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000));
  const diffMs = nextRound - now;
  const hoursLeft = Math.floor(diffMs / 3600000);

  submissions.push({
    user,
    userId,
    track: fileId,
    title: msg.audio.file_name || "Untitled Track",
    votes: 0,
    voters: [],
  });
  saveSubmissions();

  await bot.sendMessage(
    msg.chat.id,
    `✅ Got your *audio track*! Next round posts in *${hoursLeft}h*.`,
    { parse_mode: "Markdown" }
  );
  console.log(`🎧 Audio submission from ${user} (${userId})`);
});

// === HANDLE 🔥 VOTES ===
bot.on("callback_query", async (q) => {
  const [action, userIdStr] = q.data.split("_");
  const userId = Number(userIdStr);
  const voter = q.from.username || q.from.first_name;
  const entry = submissions.find((s) => s.userId === userId);
  if (!entry) return;

  if (entry.voters.includes(voter)) {
    return bot.answerCallbackQuery(q.id, { text: "⚠️ You already voted for this track." });
  }

  entry.votes++;
  entry.voters.push(voter);
  saveSubmissions();

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
  } catch (e) {
    console.error("Edit failed:", e.message);
  }

  bot.answerCallbackQuery(q.id, { text: "✅ Vote recorded!" });
});

// === POST SUBMISSIONS TO CHANNEL ===
async function postSubmissions() {
  if (submissions.length === 0) {
    console.log("🚫 No submissions to post.");
    return;
  }

  phase = "voting";
  nextRoundTime = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 h voting window
  saveSubmissions();

  for (const s of submissions) {
    try {
      await bot.sendAudio(`@${CHANNEL}`, s.track, {
        caption: `🎧 ${s.user} — *${s.title}*\n🔥 Votes: 0`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${s.userId}` }]],
        },
      });
      await new Promise((res) => setTimeout(res, 1500));
    } catch (e) {
      console.error(`❌ Failed to post ${s.user}:`, e.message);
      await bot.sendMessage(
        `@${CHANNEL}`,
        `🎧 ${s.user} dropped a track (could not reupload)\n🔥 Votes: 0`,
        { parse_mode: "Markdown" }
      );
    }
  }

  console.log("✅ Posted all audio submissions separately.");
}

// === ANNOUNCE WINNERS AFTER VOTING ===
async function announceWinners() {
  if (submissions.length === 0) {
    console.log("🚫 No submissions to tally.");
    phase = "submissions";
    saveSubmissions();
    return;
  }

  const sorted = [...submissions].sort((a, b) => b.votes - a.votes);
  let msg = "🏆 *Top Tracks of the Day* 🏆\n\n";

  sorted.forEach((s, i) => {
    msg += `${i + 1}. ${s.user} — ${s.votes} 🔥\n🎵 ${s.title}\n\n`;
  });

  await bot.sendMessage(`@${CHANNEL}`, msg, { parse_mode: "Markdown" });
  console.log("✅ Winners announced.");

  submissions = [];
  phase = "submissions";
  nextRoundTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
  saveSubmissions();
  console.log("♻️ Cleared submissions for next day.");
}

// === RUN DAILY CYCLE ===
if (!process.env.CRON_STARTED) {
  process.env.CRON_STARTED = true;
  cron.schedule("0 0 * * *", async () => {   // every midnight UTC
    console.log("🎬 Starting daily cycle...");
    await postSubmissions();

    // Announce winners 12 hours later
    setTimeout(async () => {
      console.log("🕒 Announcing daily winners...");
      await announceWinners();
    }, 12 * 60 * 60 * 1000);
  });
}

console.log("✅ SunoLabs Bot (24 h daily round, audio-only) is running...");

