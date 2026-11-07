/**
 * Configure the KUKI DEX Telegram bot to open the mini app.
 *
 * The token is read from the environment and never written to the repository.
 *
 *   $env:DEX_BOT_TOKEN="123:AA..."
 *   $env:DEX_URL="https://kuki-dex.kukitap.workers.dev"
 *   node scripts/setup-dex-bot.mjs
 */
const token = (process.env.DEX_BOT_TOKEN ?? "").trim();
const url = (process.env.DEX_URL ?? "").trim().replace(/\/$/, "");

if (!token) throw new Error("DEX_BOT_TOKEN is required");
if (!/^https:\/\//.test(url)) throw new Error("DEX_URL must be an https URL");

const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

async function call(method, body) {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description ?? json.error_code}`);
  return json.result;
}

const me = await call("getMe");
console.log(`bot: @${me.username} (${me.id})`);

await call("setChatMenuButton", {
  menu_button: {
    type: "web_app",
    text: "KUKI DEX",
    web_app: { url },
  },
});
console.log("menu button -> " + url);

await call("setMyCommands", {
  commands: [
    { command: "start", description: "Open KUKI DEX" },
    { command: "swap", description: "Swap KUKI and TON" },
    { command: "pool", description: "Provide liquidity" },
  ],
});
console.log("commands set");
