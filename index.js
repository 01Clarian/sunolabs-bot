import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const CHANNEL = "sunolabs"; // without @
let submissions = [];

// Handle DM submissions
bot.on("message", (msg) => {
  if (msg.chat.type !== "private") return;

  const link = msg.text?.trim();
  if (!link?.startsWith("http")) {
    bot.sendMessage(
      msg.chat.id,
      "🎵 Send your Suno track link (a URL) to enter today's round."
    );
    return;
  }

  submissions.push({
    user: msg.from.username || msg.from.first_name,
    track: link,
    votes: 0,
    voters: []
  });

  bot.sendMessage(
    msg.chat.id,
    "✅ Got your track for today's round! Results post in ~10 minutes for testing."
  );
  console.log(`✅ New submission from @${msg.from.username}: ${link}`);
});

// Handle 🔥 votes (only from bot's inline buttons)
bot.on("callback_query", (q) => {
  const [action, username] = q.data.split("_");
  const voter = q.from.username;
  const entry = submissions.find((s) => s.user === username);
  if (!entry) return;

  if (!entry.voters.includes(voter)) {
    if (action === "vote") entry.votes++;
    entry.voters.push(voter);
    console.log(`🔥 ${voter} voted for @${username}`);
  }

  bot.answerCallbackQuery(q.id, { text: "✅ Vote recorded!" });
});

// Post all submissions to the channel
async function postSubmissions() {
  if (submissions.length === 0) {
    console.log("🚫 No submissions to post.");
    return;
  }

  for (const s of submissions) {
    await bot.sendMessage(
      `@${CHANNEL}`,
      `🎧 @${s.user} dropped a track:\n${s.track}\n\n⏳ Voting open for 10 minutes!\n(Only 🔥 button clicks count as votes.)`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔥 Vote", callback_data: `vote_${s.user}` }]
          ]
        }
      }
    );
  }

  console.log("✅ Posted all submissions.");
}

// Tally votes and announce winners
async function announceWinners() {
  if (submissions.length === 0) {
    console.log("🚫 No submissions to tally.");
    return;
  }

  const sorted = [...submissions].sort((a, b) => b.votes - a.votes);
  const top = sorted.slice(0, 3);
  let msg = "🏆 *Top Tracks of the Round* 🏆\n\n";

  top.forEach((s, i) => {
    msg += `${i + 1}. @${s.user} — ${s.votes} 🔥\n${s.track}\n\n`;
  });

  await bot.sendMessage(`@${CHANNEL}`, msg, { parse_mode: "Markdown" });
  console.log("✅ Winners announced.");

  submissions = []; // clear for next round
  console.log("♻️ Submissions cleared for next round.");
}

// Run a full 10-minute test cycle
// Posts submissions, waits 10 minutes, then announces winners
cron.schedule("*/10 * * * *", async () => {
  console.log("⏰ Starting a new 10-minute test cycle...");
  await postSubmissions();
  setTimeout(announceWinners, 10 * 60 * 1000); // wait 10 minutes
});
console.log("✅ SunoLabs Bot (10-min test mode) is running...");

