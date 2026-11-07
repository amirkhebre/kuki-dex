/**
 * GitHub device-flow login (no browser automation, no secrets in the repo).
 *
 * Starts the flow, writes the one-time code to .github-device.json, then polls
 * until the user approves. The token is stored in .github-token (gitignored).
 *
 *   node scripts/github-login.mjs
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";

const CLIENT_ID = "178c6fc778ccc68e1d6a"; // GitHub CLI public client
const SCOPE = "repo read:user";
const DEVICE_FILE = ".github-device.json";
const TOKEN_FILE = ".github-token";

if (existsSync(TOKEN_FILE)) {
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const me = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}` } });
  if (me.ok) {
    const user = await me.json();
    console.log(`already authorized as ${user.login}`);
    process.exit(0);
  }
  console.log("stored token is invalid; starting a new login");
}

const start = await fetch("https://github.com/login/device/code", {
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
});
const device = await start.json();
if (!device.device_code) throw new Error(`device code failed: ${JSON.stringify(device)}`);

const state = {
  user_code: device.user_code,
  verification_uri: device.verification_uri,
  expires_at: Date.now() + device.expires_in * 1000,
  interval: device.interval ?? 5,
  device_code: device.device_code,
};
writeFileSync(DEVICE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
console.log(`CODE=${state.user_code}`);
console.log(`URL=${state.verification_uri}`);
console.log("waiting for approval…");

let interval = state.interval;
for (;;) {
  if (Date.now() > state.expires_at) {
    console.log("expired");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, interval * 1000));
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: state.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const json = await res.json();
  if (json.access_token) {
    writeFileSync(TOKEN_FILE, json.access_token, { mode: 0o600 });
    const me = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${json.access_token}`, "user-agent": "kuki-dex" },
    }).then((r) => r.json());
    console.log(`AUTHORIZED=${me.login}`);
    process.exit(0);
  }
  if (json.error === "authorization_pending") continue;
  if (json.error === "slow_down") {
    interval += 5;
    continue;
  }
  if (json.error === "expired_token") {
    console.log("expired");
    process.exit(1);
  }
  if (json.error === "access_denied") {
    console.log("denied");
    process.exit(1);
  }
  console.log(`error: ${json.error ?? "unknown"}`);
  process.exit(1);
}
