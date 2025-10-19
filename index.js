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
    bot.sendMessage(msg.chat.id, "🎵 Send your Suno track link to enter today's round.");
    return;
  }
  submissions.push({ user: msg.from.username || msg.from.first_name, track: link, votes: 0, voters: [] });
  bot.sendMessage(msg.chat.id, "✅ Got your track for today's round!");
});

// Voting
bot.on("callback_query", (q) => {
  const [action, username] = q.data.split("_");
  const voter = q.from.username;
  const entry = submissions.find((s) => s.user === username);
  if (!entry) return;
  if (!entry.voters.includes(voter)) {
    if (action === "vote") entry.votes++;
    entry.voters.push(voter);
  }
  bot.answerCallbackQuery(q.id, { text: "✅ Vote recorded!" });
});

// Post all submissions daily
async function postSubmissions() {
  if (submissions.length === 0) return;
  for (const s of submissions) {
    await bot.sendMessage(`@${CHANNEL}`,
      `🎧 @${s.user} dropped a track:\n${s.track}\n⏳ Voting open for 24h!`,
      { reply_markup: { inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${s.user}` }]] } });
  }
  console.log("✅ Posted submissions.");
}

// Announce winners daily (after 24h)
async function announceWinners() {
  if (submissions.length === 0) return;
  const sorted = [...submissions].sort((a, b) => b.votes - a.votes);
  const top = sorted.slice(0, 3);
  let msg = "🏆 *Top Tracks of the Day* 🏆\n\n";
  top.forEach((s, i) => msg += `${i + 1}. @${s.user} — ${s.votes} 🔥\n${s.track}\n\n`);
  await bot.sendMessage(`@${CHANNEL}`, msg, { parse_mode: "Markdown" });
  submissions = [];
  console.log("✅ Winners announced and cleared.");
}

// Run daily jobs at 6 PM UTC
cron.schedule("0 18 * * *", postSubmissions);
cron.schedule("0 18 * * *", announceWinners, { timezone: "Etc/UTC" });

console.log("✅ SunoLabs Bot is running...");
