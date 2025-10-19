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
let phase = "submissions"; // "submissions" | "voting"
let nextRoundTime = null;

console.log("🚀 SunoLabs Bot process started at", new Date().toISOString());

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

// === HANDLE DM SUBMISSIONS ===
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;
  if (!msg.text && !msg.audio) return;

  const user = msg.from.username || msg.from.first_name;
  const userId = msg.from.id;

  // Block new entries during voting phase
  if (phase === "voting") {
    const diff = nextRoundTime ? nextRoundTime - Date.now() : 0;
    const minutes = Math.max(0, Math.floor(diff / 60000));
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Voting is live — submissions are closed!\n⏳ Next round opens in *${minutes}m*.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // === AUDIO SUBMISSION ===
  if (msg.audio) {
    const fileId = msg.audio.file_id;
    const now = new Date();
    const nextRound = new Date(Math.ceil(now.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000));
    const diffMs = nextRound - now;
    const minutesLeft = Math.floor(diffMs / 60000);

    submissions.push({
      user,
      userId,
      type: "audio",
      track: fileId,
      title: msg.audio.file_name || "Untitled Track",
      votes: 0,
      voters: []
    });
    saveSubmissions();

    await bot.sendMessage(
      msg.chat.id,
      `✅ Got your *audio track*! Next round posts in *${minutesLeft}m* — good luck 🍀`,
      { parse_mode: "Markdown" }
    );
    console.log(`🎧 Audio submission from @${user} (${userId})`);
    return;
  }

  // === LINK SUBMISSION (handles entities + text) ===
  let link = msg.text?.trim();
  if (!link && msg.entities) {
    const entity = msg.entities.find((e) => e.type === "url");
    if (entity && msg.text) {
      link = msg.text.slice(entity.offset, entity.offset + entity.length);
    }
  }

  if (link && (link.startsWith("http://") || link.startsWith("https://"))) {
    const now = new Date();
    const nextRound = new Date(Math.ceil(now.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000));
    const diffMs = nextRound - now;
    const minutesLeft = Math.floor(diffMs / 60000);

    submissions.push({
      user,
      userId,
      type: "link",
      track: link,
      votes: 0,
      voters: []
    });
    saveSubmissions();

    await bot.sendMessage(
      msg.chat.id,
      `✅ Got your *link submission*! Next round posts in *${minutesLeft}m* — good luck 🍀`,
      { parse_mode: "Markdown" }
    );
    console.log(`✅ Link submission from @${user} (${userId}): ${link}`);
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
  console.log(`🔥 ${voter} voted for ${entry.user} (${entry.userId})`);

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
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.userId}` }]]
        }
      });
    } else {
      await bot.editMessageText(text, {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.userId}` }]]
        }
      });
    }
  } catch (e) {
    console.error("Edit failed:", e.message);
  }

  bot.answerCallbackQuery(q.id, { text: "✅ Vote recorded!" });
});

// === POST SUBMISSIONS TO CHANNEL (ONE MESSAGE PER ENTRY) ===
async function postSubmissions() {
  if (submissions.length === 0) {
    console.log("🚫 No submissions to post.");
    return;
  }

  phase = "voting";
  nextRoundTime = new Date(Date.now() + 5 * 60 * 1000);
  saveSubmissions();

  for (const s of submissions) {
    try {
      const caption = `🎧 @${s.user} dropped a track${s.title ? ` — *${s.title}*` : ""}\n🔥 Votes: 0`;

      if (s.type === "audio") {
        try {
          // try sending as document first (more reliable than sendAudio)
          await bot.sendDocument(`@${CHANNEL}`, s.track, {
            caption,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${s.userId}` }]]
            }
          });
        } catch (err) {
          console.error(`❌ sendDocument failed for @${s.user}: ${err.message}`);
          await bot.sendMessage(
            `@${CHANNEL}`,
            `🎧 @${s.user} dropped a track (could not reupload)\n🎵 [Open Track](https://t.me/${s.user})\n🔥 Votes: 0`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${s.userId}` }]]
              }
            }
          );
        }
      } else {
        await bot.sendMessage(
          `@${CHANNEL}`,
          `🎧 @${s.user} dropped a track:\n${s.track}\n\n🔥 Votes: 0`,
          {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${s.userId}` }]]
            }
          }
        );
      }

      // Small delay to keep Telegram from merging messages
      await new Promise((res) => setTimeout(res, 1200));
    } catch (e) {
      console.error(`❌ Failed to post @${s.user}:`, e.message);
    }
  }

  console.log("✅ Posted all submissions separately and ready for voting.");
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
  nextRoundTime = new Date(Date.now() + 5 * 60 * 1000);
  saveSubmissions();
  console.log("♻️ Submissions cleared for next round.");
}

// === RUN CYCLE EVERY 5 MINUTES ===
if (!process.env.CRON_STARTED) {
  process.env.CRON_STARTED = true;
  cron.schedule("*/5 * * * *", async () => {
    console.log("⏰ Starting a new 5-minute cycle...");
    await postSubmissions();
    setTimeout(announceWinners, 5 * 60 * 1000);
  });
}

console.log("✅ SunoLabs Bot (5-minute persistent mode, Markdown-safe link+audio) is running...");

