/**
 * Cloudflare OAuth login with PKCE and a localhost callback.
 *
 * Opens no browser itself: it prints an authorization URL (also written to
 * .cf-auth.json). After the user approves in Chrome, Cloudflare redirects to
 * http://localhost:8976/oauth/callback and the token is stored in .cf-token.
 *
 *   node scripts/cloudflare-login.mjs
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const REDIRECT = "http://localhost:8976/oauth/callback";
const SCOPES = [
  "user:read",
  "account:read",
  "workers:write",
  "workers_kv:write",
  "workers_scripts:write",
  "offline_access",
];

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

const url =
  "https://dash.cloudflare.com/oauth2/auth?" +
  new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

writeFileSync(".cf-auth.json", JSON.stringify({ url, created_at: Date.now() }, null, 2), { mode: 0o600 });
console.log(`URL=${url}`);
console.log("waiting for the browser callbackâ€¦");

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost:8976");
  if (u.pathname !== "/oauth/callback") {
    res.writeHead(404).end("not found");
    return;
  }
  if (u.searchParams.get("state") !== state) {
    res.writeHead(400).end("state mismatch");
    return;
  }
  const code = u.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("missing code");
    return;
  }

  try {
    const tokenRes = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) {
      res.writeHead(500).end(`token exchange failed: ${token.error ?? tokenRes.status}`);
      console.log(`ERROR=${token.error ?? tokenRes.status}`);
      return;
    }
    writeFileSync(
      ".cf-token",
      JSON.stringify(
        {
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h2>KUKI DEX</h2><p>Cloudflare connected. You can close this tab.</p>");
    console.log("AUTHORIZED");
    setTimeout(() => process.exit(0), 300);
  } catch (err) {
    res.writeHead(500).end("exchange error");
    console.log(`ERROR=${err.message}`);
  }
});

server.listen(8976, () => console.log("listening on http://localhost:8976"));
setTimeout(() => {
  console.log("timeout");
  process.exit(1);
}, 15 * 60_000);

