import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const CHANNEL = "sunolabs_submissions"; // without @
let submissions = [];

// === HANDLE DM SUBMISSIONS ===
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;

  const user = msg.from.username || msg.from.first_name;

  // === AUDIO SUBMISSION ===
  if (msg.audio) {
    const fileId = msg.audio.file_id;

    // calculate time left dynamically (2-minute rounds)
    const now = new Date();
    const nextRound = new Date(Math.ceil(now.getTime() / (2 * 60 * 1000)) * (2 * 60 * 1000));
    const diffMs = nextRound - now;
    const minutesLeft = Math.floor(diffMs / 60000);
    const secondsLeft = Math.floor((diffMs % 60000) / 1000);

    submissions.push({
      user,
      type: "audio",
      track: fileId,
      title: msg.audio.file_name || "Untitled Track",
      votes: 0,
      voters: []
    });

    await bot.sendMessage(
      msg.chat.id,
      `✅ Got your *audio track*! Next round posts in *${minutesLeft}m ${secondsLeft}s* — good luck 🍀`,
      { parse_mode: "Markdown" }
    );
    console.log(`🎧 Audio submission from @${user}`);
    return;
  }

  // === LINK SUBMISSION ===
  const link = msg.text?.trim();
  if (link?.startsWith("http")) {
    const now = new Date();
    const nextRound = new Date(Math.ceil(now.getTime() / (2 * 60 * 1000)) * (2 * 60 * 1000));
    const diffMs = nextRound - now;
    const minutesLeft = Math.floor(diffMs / 60000);
    const secondsLeft = Math.floor((diffMs % 60000) / 1000);

    submissions.push({
      user,
      type: "link",
      track: link,
      votes: 0,
      voters: []
    });

    await bot.sendMessage(
      msg.chat.id,
      `✅ Got your *link submission*! Next round posts in *${minutesLeft}m ${secondsLeft}s* — good luck 🍀`,
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

  // prevent multiple votes from same user
  if (entry.voters.includes(voter)) {
    return bot.answerCallbackQuery(q.id, { text: "⚠️ You already voted for this track." });
  }

  // register new vote
  entry.votes++;
  entry.voters.push(voter);
  console.log(`🔥 ${voter} voted for @${username}`);

  // visually update caption/text
  try {
    if (entry.type === "audio") {
      await bot.editMessageCaption(
        `🎧 @${entry.user} dropped a track${entry.title ? ` — *${entry.title}*` : ""}\n🔥 Votes: ${entry.votes}`,
        {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.user}` }]]
          }
        }
      );
    } else {
      await bot.editMessageText(
        `🎧 @${entry.user} dropped a track:\n${entry.track}\n\n🔥 Votes: ${entry.votes}`,
        {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.user}` }]]
          }
        }
      );
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

  for (const s of submissions) {
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
  }
  console.log("✅ Posted all submissions.");
}

// === ANNOUNCE WINNERS ===
async function announceWinners() {
  if (submissions.length === 0) {
    console.log("🚫 No submissions to tally.");
    return;
  }

  const sorted = [...submissions].sort((a, b) => b.votes - a.votes);
  const top = sorted.slice(0, 3);
  let msg = "🏆 *Top Tracks of the Round* 🏆\n\n";

  top.forEach((s, i) => {
    msg += `${i + 1}. @${s.user} — ${s.votes} 🔥\n`;
    if (s.type === "link") msg += `${s.track}\n\n`;
    else msg += `🎵 Audio submission\n\n`;
  });

  await bot.sendMessage(`@${CHANNEL}`, msg, { parse_mode: "Markdown" });
  console.log("✅ Winners announced.");

  submissions = []; // clear for next round
  console.log("♻️ Submissions cleared for next round.");
}

// === RUN TEST CYCLE EVERY 2 MINUTES ===
cron.schedule("*/2 * * * *", async () => {
  console.log("⏰ Starting a new 2-minute cycle...");
  await postSubmissions();
  setTimeout(announceWinners, 2 * 60 * 1000);
});

console.log("✅ SunoLabs Bot (2-min test mode, live votes) is running...");

