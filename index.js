import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fs from "fs";

// === CONFIG ===
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const CHANNEL = "sunolabs_submissions"; // without @
const SAVE_FILE = "./submissions.json";

let submissions = [];
let phase = "submissions"; // "submissions" | "voting"
let nextRoundTime = null;

// === PERSISTENCE ===
function saveSubmissions() {
  try {
    fs.writeFileSync(SAVE_FILE, JSON.stringify(submissions, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to save submissions:", err.message);
  }
}

function loadSubmissions() {
  if (fs.existsSync(SAVE_FILE)) {
    try {
      submissions = JSON.parse(fs.readFileSync(SAVE_FILE));
      console.log(`💾 Loaded ${submissions.length} saved submissions`);
    } catch (err) {
      console.error("⚠️ Failed to load saved submissions:", err.message);
    }
  }
}
loadSubmissions();

// === HANDLE DM SUBMISSIONS ===
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;
  if (!msg.text && !msg.audio) return;

  // Block new entries during voting phase
  if (phase === "voting") {
    const diff = nextRoundTime ? nextRoundTime - Date.now() : 0;
    const hours = Math.max(0, Math.floor(diff / 3600000));
    const minutes = Math.max(0, Math.floor((diff % 3600000) / 60000));
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Voting is live — submissions are closed!\n⏳ Next round opens in *${hours}h ${minutes}m*.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const user = msg.from.username || msg.from.first_name;

  // === AUDIO SUBMISSION ===
  if (msg.audio) {
    const fileId = msg.audio.file_id;
    const now = new Date();
    const nextRound = new Date(
      Math.ceil(now.getTime() / (2 * 60 * 60 * 1000)) * (2 * 60 * 60 * 1000)
    );
    const diffMs = nextRound - now;
    const hoursLeft = Math.floor(diffMs / 3600000);
    const minutesLeft = Math.floor((diffMs % 3600000) / 60000);

    submissions.push({
      user,
      type: "audio",
      track: fileId,
      title: msg.audio.file_name || "Untitled Track",
      votes: 0,
      voters: []
    });
    saveSubmissions();

    await bot.sendMessage(
      msg.chat.id,
      `✅ Got your *audio track*! Next round posts in *${hoursLeft}h ${minutesLeft}m* — good luck 🍀`,
      { parse_mode: "Markdown" }
    );
    console.log(`🎧 Audio submission from @${user}`);
    return;
  }

  // === LINK SUBMISSION ===
  const link = msg.text?.trim();
  if (link?.startsWith("http")) {
    const now = new Date();
    const nextRound = new Date(
      Math.ceil(now.getTime() / (2 * 60 * 60 * 1000)) * (2 * 60 * 60 * 1000)
    );
    const diffMs = nextRound - now;
    const hoursLeft = Math.floor(diffMs / 3600000);
    const minutesLeft = Math.floor((diffMs % 3600000) / 60000);

    submissions.push({
      user,
      type: "link",
      track: link,
      votes: 0,
      voters: []
    });
    saveSubmissions();

    await bot.sendMessage(
      msg.chat.id,
      `✅ Got your *link submission*! Next round posts in *${hoursLeft}h ${minutesLeft}m* — good luck 🍀`,
      { parse_mode: "Markdown" }
    );
    console.log(`✅ Link submission from @${user}: ${link}`);
    return;
  }

  // === UNKNOWN INPUT ===
  await bot.sendMessage(
    msg.chat.id,
    "🎵 Send your Suno track link *or upload an audio file* to enter today's round.",
    { parse_mode: "Markdown" }
  );
});

// === HANDLE 🔥 VOTES ===
bot.on("callback_query", async (q) => {
  const [action, username] = q.data.split("_");
  const voter = q.from.username;
  const entry = submissions.find((s) => s.user === username);
  if (!entry) return;

  if (entry.voters.includes(voter)) {
    return bot.answerCallbackQuery(q.id, { text: "⚠️ You already voted for this track." });
  }

  entry.votes++;
  entry.voters.push(voter);
  saveSubmissions();
  console.log(`🔥 ${voter} voted for @${username}`);

  try {
    const text =
      entry.type === "audio"
        ? `🎧 @${entry.user} dropped a track${entry.title ? ` — *${entry.title}*` : ""}\n🔥 Votes: ${entry.votes}`
        : `🎧 @${entry.user} dropped a track:\n${entry.track}\n\n🔥 Votes: ${entry.votes}`;

    if (entry.type === "audio") {
      await bot.editMessageCaption(text, {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.user}` }]]
        }
      });
    } else {
      await bot.editMessageText(text, {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.user}` }]]
        }
      });
    }
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
  nextRoundTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
  saveSubmissions();

  for (const s of submissions) {
    try {
      if (s.type === "audio") {
        await bot.sendAudio(`@${CHANNEL}`, s.track, {
          caption: `🎧 @${s.user} dropped a track${s.title ? ` — *${s.title}*` : ""}\n🔥 Votes: 0`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${s.user}` }]]
          }
        });
      } else {
        await bot.sendMessage(
          `@${CHANNEL}`,
          `🎧 @${s.user} dropped a track:\n${s.track}\n\n🔥 Votes: 0`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${s.user}` }]]
            }
          }
        );
      }
    } catch (e) {
      console.error(`❌ Failed to post @${s.user}:`, e.message);
    }
  }
  console.log("✅ Posted all submissions.");
}

// === ANNOUNCE WINNERS ===
async function announceWinners() {
  if (submissions.length === 0) {
    console.log("🚫 No submissions to tally.");
    phase = "submissions";
    saveSubmissions();
    return;
  }

  const sorted = [...submissions].sort((a, b) => b.votes - a.votes);
  let msg = "🏆 *Top Tracks of the Round* 🏆\n\n";

  sorted.forEach((s, i) => {
    msg += `${i + 1}. @${s.user} — ${s.votes} 🔥\n`;
    if (s.type === "link") msg += `${s.track}\n\n`;
    else msg += `🎵 Audio submission\n\n`;
  });

  await bot.sendMessage(`@${CHANNEL}`, msg, { parse_mode: "Markdown" });
  console.log("✅ Winners announced.");

  submissions = [];
  phase = "submissions";
  nextRoundTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
  saveSubmissions();
  console.log("♻️ Submissions cleared for next round.");
}

// === RUN CYCLE EVERY 2 HOURS ===
if (!process.env.CRON_STARTED) {
  process.env.CRON_STARTED = true;
  cron.schedule("0 */2 * * *", async () => {
    console.log("⏰ Starting a new 2-hour cycle...");
    await postSubmissions();
    setTimeout(announceWinners, 2 * 60 * 60 * 1000);
  });
}

console.log("✅ SunoLabs Bot (2-hour persistent mode, live votes) is running...");
