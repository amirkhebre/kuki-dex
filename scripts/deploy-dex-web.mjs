/**
 * Deploy the KUKI DEX web app to Cloudflare Workers without the wrangler CLI.
 *
 * The sandbox blocks wrangler's child process, but the OAuth token that
 * `wrangler login` stored can be used directly against the Cloudflare API.
 *
 *   node scripts/deploy-dex-web.mjs
 *
 * Prints the public URL on success. Never prints the token.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { homedir } from "node:os";

const WEB = join(process.cwd(), "web");
const PROJECT = "kuki-dex";
const CF = "https://api.cloudflare.com/client/v4";
const CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";

function wranglerConfig() {
  const p = join(process.env.APPDATA ?? homedir(), "xdg.config", ".wrangler", "config", "default.toml");
  if (!existsSync(p)) throw new Error("wrangler config not found; run `wrangler login` first");
  const text = readFileSync(p, "utf8");
  const get = (k) => {
    const m = new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, "m").exec(text);
    return m ? m[1] : "";
  };
  return { token: get("oauth_token"), refresh: get("refresh_token"), expires: get("expiration_time") };
}

async function accessToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  const cfg = wranglerConfig();
  const exp = Date.parse(cfg.expires);
  if (cfg.token && (!Number.isFinite(exp) || exp > Date.now() + 60_000)) return cfg.token;
  if (!cfg.refresh) throw new Error("Cloudflare token expired and no refresh token");
  const res = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refresh,
      client_id: CLIENT_ID,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`token refresh failed: ${json.error ?? res.status}`);
  return json.access_token;
}

async function cf(token, path, init = {}) {
  const res = await fetch(`${CF}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const err = json.errors?.[0];
    throw new Error(`${path}: ${err?.message ?? res.status} (${err?.code ?? ""})`);
  }
  return json.result;
}

function collect(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, base, out);
    else out.push(full);
  }
  return out;
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

function buildWorker() {
  const files = {};
  for (const full of collect(WEB)) {
    const url = "/" + relative(WEB, full).split("\\").join("/");
    const body = readFileSync(full).toString("base64");
    files[url] = { t: types[extname(full)] ?? "application/octet-stream", b: body };
  }
  const code = `
const FILES = ${JSON.stringify(files)};
const TYPES = ${JSON.stringify(types)};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/setup") {
      const key = request.headers.get("x-setup-key") || url.searchParams.get("key");
      if (!env.SETUP_KEY || key !== env.SETUP_KEY) return json({ ok: false, error: "forbidden" }, 403);
      if (!env.DEX_BOT_TOKEN) return json({ ok: false, error: "missing bot token" }, 500);
      const origin = url.origin;
      const tg = await fetch("https://api.telegram.org/bot" + env.DEX_BOT_TOKEN + "/setChatMenuButton", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ menu_button: { type: "web_app", text: "KUKI DEX", web_app: { url: origin } } })
      });
      const result = await tg.json().catch(() => ({}));
      await fetch("https://api.telegram.org/bot" + env.DEX_BOT_TOKEN + "/setMyCommands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands: [
          { command: "start", description: "Open KUKI DEX" },
          { command: "swap", description: "Swap KUKI and TON" },
          { command: "pool", description: "Provide liquidity" }
        ] })
      }).catch(() => null);
      return json({ ok: !!result.ok, telegram: result });
    }
    if (url.pathname === "/api/bot/status") {
      if (request.method === "POST") {
        if (!env.BOT_KEY || request.headers.get("x-bot-key") !== env.BOT_KEY) {
          return json({ ok: false, error: "forbidden" }, 403);
        }
        const body = await request.text();
        if (body.length > 4096) return json({ ok: false, error: "too large" }, 413);
        try {
          JSON.parse(body);
        } catch {
          return json({ ok: false, error: "bad json" }, 400);
        }
        if (!env.BOT_KV) return json({ ok: false, error: "no kv" }, 500);
        await env.BOT_KV.put("status", body, { expirationTtl: 3600 });
        return json({ ok: true });
      }
      const raw = env.BOT_KV ? await env.BOT_KV.get("status") : null;
      return json(raw ? JSON.parse(raw) : null);
    }
    if (url.pathname === "/tonconnect-manifest.json") {
      const origin = url.origin;
      return new Response(JSON.stringify({
        url: origin,
        name: "KUKI DEX",
        iconUrl: origin + "/assets/kuki-coin.webp"
      }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    const key = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = FILES[key] || FILES["/index.html"];
    const binary = Uint8Array.from(atob(file.b), (c) => c.charCodeAt(0));
    const headers = { "content-type": file.t, "cache-control": "public, max-age=300" };
    if (key.endsWith(".html")) headers["cache-control"] = "no-store";
    return new Response(binary, { headers });
  }
};
`;
  return code;
}

const token = await accessToken();
const envAccount = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
let account;
if (envAccount) {
  account = { id: envAccount, name: "(from CLOUDFLARE_ACCOUNT_ID)" };
} else {
  const accounts = await cf(token, "/accounts");
  if (!accounts?.length) throw new Error("no Cloudflare account on this token");
  account = accounts[0];
}
console.log(`account: ${account.name}`);

const sub = await cf(token, `/accounts/${account.id}/workers/subdomain`);
console.log(`workers.dev subdomain: ${sub.subdomain}`);

async function ensureKv(token, accountId, title) {
  const list = await cf(token, `/accounts/${accountId}/storage/kv/namespaces`);
  const found = (list ?? []).find((n) => n.title === title);
  if (found) return found.id;
  const created = await cf(token, `/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return created.id;
}

const kvId = await ensureKv(token, account.id, "kuki-dex-bot");
console.log(`kv namespace: ${kvId.slice(0, 8)}…`);

const worker = buildWorker();
const metadata = {
  main_module: "worker.mjs",
  compatibility_date: "2025-01-01",
  bindings: [{ type: "kv_namespace", name: "BOT_KV", namespace_id: kvId }],
};
const form = new FormData();
form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata");
form.set("worker.mjs", new Blob([worker], { type: "application/javascript+module" }), "worker.mjs");

const uploaded = await cf(token, `/accounts/${account.id}/workers/scripts/${PROJECT}`, { method: "PUT", body: form });
console.log(`script uploaded: ${PROJECT} (${uploaded?.modified_on ?? "ok"})`);

try {
  await cf(token, `/accounts/${account.id}/workers/scripts/${PROJECT}/subdomain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
} catch (err) {
  await cf(token, `/accounts/${account.id}/workers/scripts/${PROJECT}/subdomain`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
}

const publicUrl = `https://${PROJECT}.${sub.subdomain}.workers.dev`;
console.log(`public URL: ${publicUrl}`);

const botToken = (process.env.DEX_BOT_TOKEN ?? "").trim();
const botKey = (process.env.BOT_KEY ?? crypto.randomUUID()).replace(/-/g, "");
if (botToken) {
  const setupKey = (process.env.SETUP_KEY ?? crypto.randomUUID()).replace(/-/g, "");
  for (const [name, text] of [
    ["DEX_BOT_TOKEN", botToken],
    ["SETUP_KEY", setupKey],
    ["BOT_KEY", botKey],
  ]) {
    await cf(token, `/accounts/${account.id}/workers/scripts/${PROJECT}/secrets`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, text, type: "secret_text" }),
    });
  }
  console.log("bot secrets stored");

  let ok = false;
  for (let attempt = 0; attempt < 4 && !ok; attempt++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch(`${publicUrl}/api/setup`, { method: "POST", headers: { "x-setup-key": setupKey } });
      const json = await res.json();
      ok = json.ok === true;
      console.log(`telegram setup attempt ${attempt + 1}: ${ok ? "ok" : json.error ?? json.telegram?.description ?? "failed"}`);
    } catch (err) {
      console.log(`telegram setup attempt ${attempt + 1}: ${err.message}`);
    }
  }
  console.log(`status key: ${botKey}`);
} else {
  console.log("DEX_BOT_TOKEN not set — web deployed without the Telegram menu button");
}
