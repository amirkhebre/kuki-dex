import { Address, beginCell, toNano } from "https://esm.sh/@ton/core@0.62.1";

/* ------------------------------------------------------------------ config */
const POOL = "EQDuVJSV3M4MDU2NafdRDQVCDnRuZBAJv3_DFYIU49ro-Y1R";
const KUKI = "EQCK1R0hqLuqG3XuG_CR_flKuZZuOxryCrAL3bH44Dq9RUa3";
const STONFI = "EQCjsEs7maKN4R-f7Hbit7Ds7Ua5KBdUsaEKG7Dv6RyqTPGv";
const RPC = "https://toncenter.com/api/v2/runGetMethod";
const TONAPI = "https://tonapi.io/v2";
const SLIPPAGE = 0.005;

const $ = (id) => document.getElementById(id);
const state = {
  reserveKuki: 0n,
  reserveTon: 0n,
  totalShares: 0n,
  feeBps: 30n,
  protocolBps: 10n,
  paused: false,
  ready: false,
  side: "ton",
  wallet: null,
  quoteSeq: 0,
  tf: "hour",
  tokens: [],
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("on"), 2800);
}

function fmt(n, dp = 4) {
  if (!Number.isFinite(n)) return "â€”";
  return n.toLocaleString("en-US", { maximumFractionDigits: dp });
}

function parseNum(v) {
  if (typeof v !== "string") return BigInt(v);
  if (v.startsWith("-0x")) return -BigInt(v.slice(3));
  return BigInt(v);
}

/* ------------------------------------------------------------------- chain */
async function run(method, stack = [], address = POOL) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, method, stack }),
    });
    const json = await res.json();
    if (json.ok) return json.result.stack.map((i) => (i[0] === "num" ? parseNum(i[1]) : i[1]));
    if (json.code === 429) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    throw new Error(json.error || "rpc");
  }
  throw new Error("rate limited");
}

async function loadPool() {
  try {
    const [p, f] = await Promise.all([run("getPoolState"), run("getFees")]);
    state.reserveKuki = p[0];
    state.reserveTon = p[1];
    state.feeBps = p[4];
    state.totalShares = p[5];
    state.paused = p[6] !== 0n;
    state.ready = p[7] !== 0n;
    state.protocolBps = f[2];

    const kuki = Number(state.reserveKuki) / 1e9;
    const ton = Number(state.reserveTon) / 1e9;
    $("tvl").textContent = `${fmt(ton * 2, 2)} TON`;
    $("r-kuki").textContent = `${fmt(kuki, 2)} KUKI`;
    $("r-ton").textContent = `${fmt(ton, 4)} TON`;
    $("fees").textContent = `${fmt(Number(f[0]) / 1e9, 2)} KUKI Â· ${fmt(Number(f[1]) / 1e9, 4)} TON`;
    $("l-r-kuki").textContent = `${fmt(kuki, 2)} KUKI`;
    $("l-r-ton").textContent = `${fmt(ton, 4)} TON`;
    $("l-supply").textContent = fmt(Number(state.totalShares) / 1e18, 2);
    $("l-fees").textContent = `${fmt(Number(f[0]) / 1e9, 2)} KUKI Â· ${fmt(Number(f[1]) / 1e9, 4)} TON`;
    $("lp-fee").textContent = `${(Number(state.feeBps) / 100).toFixed(2)}%`;
    $("pr-fee").textContent = `${(Number(state.protocolBps) / 100).toFixed(2)}%`;

    const live = state.ready && !state.paused && kuki > 0 && ton > 0;
    $("liq-state").textContent = live ? "live" : "bootstrapping";
    $("swap").textContent = state.wallet ? (live ? "Swap" : "Pool is bootstrapping") : "Connect wallet";
    $("swap").disabled = !state.wallet || !live;
    $("add").textContent = state.wallet ? "Add liquidity" : "Connect wallet";
    $("add").disabled = !state.wallet || !state.ready;

    if (kuki > 0) {
      $("rate-pill").textContent = `1 KUKI = ${(ton / kuki).toFixed(8)} TON`;
      $("liq-ratio").textContent = `1 TON = ${fmt(kuki / ton, 0)} KUKI`;
      $("ratio").textContent = `1 TON = ${fmt(kuki / ton, 0)} KUKI`;
      $("price").textContent = `${(ton / kuki).toFixed(8)} TON`;
    }
  } catch (err) {
    console.warn(err);
    $("liq-state").textContent = "rpc offline";
  }
}

async function quote() {
  const raw = $("pay").value.trim();
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount <= 0) {
    $("get").value = "";
    return;
  }
  const units = BigInt(Math.round(amount * 1e9));
  const assetIn = state.side === "ton" ? 1n : 0n;
  const seq = ++state.quoteSeq;
  try {
    const out = await run("getQuote", [
      { type: "num", value: `0x${assetIn.toString(16)}` },
      { type: "num", value: `0x${units.toString(16)}` },
    ]);
    if (seq !== state.quoteSeq) return;
    const q = out[0];
    $("get").value = q > 0n ? (Number(q) / 1e9).toFixed(6) : "0";
    $("min-out").textContent = `${((Number(q) * (1 - SLIPPAGE)) / 1e9).toFixed(6)} ${state.side === "ton" ? "KUKI" : "TON"}`;
  } catch {
    if (seq === state.quoteSeq) $("get").value = "";
  }
}

function setSide(side) {
  state.side = side;
  $("pay-sym").textContent = side === "ton" ? "TON" : "KUKI";
  $("get-sym").textContent = side === "ton" ? "KUKI" : "TON";
  $("pay-token").querySelector("img").src = side === "ton" ? "assets/ton.svg" : "assets/kuki-coin.webp";
  $("get-token").querySelector("img").src = side === "ton" ? "assets/kuki-coin.webp" : "assets/ton.svg";
  $("pay").value = side === "ton" ? "1" : "1000";
  quote();
}

/* --------------------------------------------------------------- TonConnect */
let tonConnectUI = null;
function initWallet() {
  if (!window.TON_CONNECT_UI) {
    setTimeout(initWallet, 800);
    return;
  }
  try {
    tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
      manifestUrl: new URL("tonconnect-manifest.json", location.href).toString(),
      buttonRootId: "wallet-root",
    });
    tonConnectUI.onStatusChange((w) => {
      state.wallet = w?.account?.address ?? null;
      loadPool();
      if (state.wallet) toast("Wallet connected");
    });
  } catch (err) {
    console.warn("tonconnect", err);
  }
}

async function jettonWallet(owner) {
  const raw = Address.parse(owner).toRawString();
  const res = await fetch(`${TONAPI}/accounts/${raw}/jettons/${KUKI}`);
  const json = await res.json();
  const addr = json?.wallet_address?.address;
  if (!addr) throw new Error("KUKI wallet not found");
  return addr;
}

async function doSwap() {
  if (!tonConnectUI || !state.wallet) return toast("Connect a wallet first");
  const amount = Number($("pay").value);
  if (!Number.isFinite(amount) || amount <= 0) return toast("Enter an amount");
  const q = Number($("get").value);
  if (!q || q <= 0) return toast("No quote for this size");

  const deadline = Math.floor(Date.now() / 1000) + 300;
  const minOut = BigInt(Math.floor(q * (1 - SLIPPAGE) * 1e9));
  const messages = [];

  try {
    if (state.side === "ton") {
      const body = beginCell()
        .storeUint(0x4b554b0b, 32)
        .storeCoins(toNano(amount.toFixed(9)))
        .storeCoins(minOut)
        .storeAddress(Address.parse(state.wallet))
        .storeUint(deadline, 32)
        .endCell();
      messages.push({
        address: POOL,
        amount: toNano((amount + 0.05).toFixed(9)).toString(),
        payload: body.toBoc().toString("base64"),
      });
    } else {
      const wallet = await jettonWallet(state.wallet);
      const intent = beginCell()
        .storeUint(0x4b554b01, 32)
        .storeUint(0, 8)
        .storeCoins(minOut)
        .storeAddress(Address.parse(state.wallet))
        .storeUint(deadline, 32)
        .endCell();
      const body = beginCell()
        .storeUint(0x0f8a7ea5, 32)
        .storeUint(0, 64)
        .storeCoins(toNano(amount.toFixed(9)))
        .storeAddress(Address.parse(POOL))
        .storeAddress(Address.parse(state.wallet))
        .storeUint(0, 1)
        .storeCoins(toNano("0.06"))
        .storeBit(true)
        .storeRef(intent)
        .endCell();
      messages.push({ address: wallet, amount: toNano("0.12").toString(), payload: body.toBoc().toString("base64") });
    }

    await tonConnectUI.sendTransaction({ validUntil: deadline, messages });
    toast("Transaction sent");
    setTimeout(loadPool, 6000);
  } catch (err) {
    console.warn(err);
    toast(err?.message?.slice(0, 90) || "Transaction failed");
  }
}

async function doAddLiquidity() {
  if (!tonConnectUI || !state.wallet) return toast("Connect a wallet first");
  const kuki = Number($("liq-kuki").value);
  const ton = Number($("liq-ton").value);
  if (!Number.isFinite(kuki) || !Number.isFinite(ton) || kuki <= 0 || ton <= 0) return toast("Enter both amounts");

  const nonce = BigInt(Date.now()) % 1_000_000_000n;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const kukiRaw = BigInt(Math.floor(kuki * 1e9));
  const tonRaw = BigInt(Math.floor(ton * 1e9));
  let shares;
  if (state.totalShares === 0n) {
    const m = kukiRaw < tonRaw ? kukiRaw : tonRaw;
    shares = (m * 10n ** 18n) / 10n ** 9n;
  } else {
    const rk = (kukiRaw * 10n ** 18n) / state.reserveKuki;
    const rt = (tonRaw * 10n ** 18n) / state.reserveTon;
    shares = (state.totalShares * (rk < rt ? rk : rt)) / 10n ** 18n;
  }
  const minShares = (shares * 995n) / 1000n;

  try {
    const wallet = await jettonWallet(state.wallet);
    const liqJetton = beginCell()
      .storeUint(0x4b554b02, 32)
      .storeUint(nonce, 64)
      .storeUint(0, 8)
      .storeCoins(minShares)
      .storeUint(deadline, 32)
      .storeAddress(Address.parse(state.wallet))
      .endCell();
    const transfer = beginCell()
      .storeUint(0x0f8a7ea5, 32)
      .storeUint(nonce, 64)
      .storeCoins(kukiRaw)
      .storeAddress(Address.parse(POOL))
      .storeAddress(Address.parse(state.wallet))
      .storeUint(0, 1)
      .storeCoins(toNano("0.06"))
      .storeBit(true)
      .storeRef(liqJetton)
      .endCell();
    const liqTon = beginCell()
      .storeUint(0x4b554b0c, 32)
      .storeUint(nonce, 64)
      .storeCoins(minShares)
      .storeUint(deadline, 32)
      .storeAddress(Address.parse(state.wallet))
      .endCell();

    await tonConnectUI.sendTransaction({
      validUntil: deadline,
      messages: [
        { address: wallet, amount: toNano("0.12").toString(), payload: transfer.toBoc().toString("base64") },
        { address: POOL, amount: toNano((ton + 0.05).toFixed(9)).toString(), payload: liqTon.toBoc().toString("base64") },
      ],
    });
    toast("Liquidity sent");
    setTimeout(loadPool, 8000);
  } catch (err) {
    console.warn(err);
    toast(err?.message?.slice(0, 90) || "Transaction failed");
  }
}

/* ------------------------------------------------------------------- chart */
async function loadChart() {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/ton/pools/${STONFI}/ohlcv?timeframe=${state.tf}&aggregate=1&limit=${
        state.tf === "hour" ? 168 : state.tf === "day" ? 90 : 52
      }`,
      { headers: { accept: "application/json" } },
    );
    const json = await res.json();
    const rows = json?.data?.attributes?.ohlcv_list ?? [];
    if (!rows.length) return;
    drawChart(rows.map((r) => ({ t: r[0] * 1000, c: r[4] })));
    const first = rows[0][4];
    const last = rows[rows.length - 1][4];
    const change = ((last - first) / first) * 100;
    $("change").textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    $("change").style.color = change >= 0 ? "var(--mint)" : "var(--pink)";
    $("chart-time").textContent = new Date(rows[rows.length - 1][0] * 1000).toLocaleString();
    if (!$("price").textContent || $("price").textContent === "â€”") $("price").textContent = Number(last).toFixed(8);
  } catch (err) {
    console.warn("chart", err);
  }
}

function drawChart(points) {
  const canvas = $("chart");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const min = Math.min(...points.map((p) => p.c));
  const max = Math.max(...points.map((p) => p.c));
  const pad = (max - min) * 0.15 || max * 0.02;
  const lo = min - pad;
  const hi = max + pad;
  const x = (i) => (i / (points.length - 1)) * (w - 8) + 4;
  const y = (v) => h - 12 - ((v - lo) / (hi - lo)) * (h - 30);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(168,85,247,0.35)");
  grad.addColorStop(1, "rgba(168,85,247,0)");

  ctx.beginPath();
  ctx.moveTo(x(0), y(points[0].c));
  for (let i = 1; i < points.length; i++) ctx.lineTo(x(i), y(points[i].c));
  ctx.lineTo(x(points.length - 1), h);
  ctx.lineTo(x(0), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x(0), y(points[0].c));
  for (let i = 1; i < points.length; i++) ctx.lineTo(x(i), y(points[i].c));
  ctx.strokeStyle = "#c084fc";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();
}

/* ------------------------------------------------------------------ tokens */
async function loadTokens() {
  try {
    const res = await fetch(`${TONAPI}/jettons?limit=200`);
    const json = await res.json();
    state.tokens = (json.jettons ?? []).map((j) => ({
      address: j.address,
      symbol: j.metadata?.symbol ?? "?",
      name: j.metadata?.name ?? "",
      image: j.metadata?.image ?? "",
      kuki: j.address === KUKI,
    }));
    state.tokens.sort((a, b) => Number(b.kuki) - Number(a.kuki));
    renderTokens();
  } catch (err) {
    console.warn(err);
    $("token-count").textContent = "offline";
  }
}

function renderTokens() {
  const q = $("search").value.trim().toLowerCase();
  const list = state.tokens.filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
  $("token-count").textContent = `${list.length} tokens`;
  $("token-grid").innerHTML = list
    .slice(0, 120)
    .map(
      (t) => `<div class="token-card" data-addr="${esc(t.address)}" data-sym="${esc(t.symbol)}">
        <img src="${esc(t.image) || "assets/kuki-coin.webp"}" alt="" loading="lazy" onerror="this.src='assets/kuki-coin.webp'" />
        <div><b>${esc(t.symbol)}</b><span>${esc(t.name)}</span></div>
        ${t.kuki ? '<span class="kuki-tag">base</span>' : ""}
      </div>`,
    )
    .join("");

  document.querySelectorAll(".token-card").forEach((el) => {
    el.addEventListener("click", () => {
      const sym = el.dataset.sym;
      if (sym === "KUKI" || sym === "TON") {
        location.hash = "#swap";
        setSide(sym === "TON" ? "ton" : "kuki");
      } else {
        toast(`Pool for ${sym} is not live yet â€” it is created against KUKI.`);
      }
    });
  });
}

/* --------------------------------------------------------------------- nav */
function route() {
  const view = (location.hash || "#swap").slice(1);
  const known = ["swap", "liquidity", "tokens"];
  const target = known.includes(view) ? view : "swap";
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === `view-${target}`));
  document.querySelectorAll("#nav a, #dock a").forEach((a) => a.classList.toggle("on", a.dataset.view === target));
  if (target === "tokens" && state.tokens.length === 0) loadTokens();
  if (target === "swap") setTimeout(loadChart, 50);
}

/* ------------------------------------------------------------------- wiring */
$("pay").addEventListener("input", () => {
  clearTimeout(quote.t);
  quote.t = setTimeout(quote, 250);
});
$("flip").addEventListener("click", () => setSide(state.side === "ton" ? "kuki" : "ton"));
$("swap").addEventListener("click", doSwap);
$("add").addEventListener("click", doAddLiquidity);
$("search").addEventListener("input", renderTokens);
$("liq-kuki").addEventListener("input", () => {
  const v = Number($("liq-kuki").value);
  if (state.reserveKuki > 0n && state.reserveTon > 0n && Number.isFinite(v)) {
    const ratio = Number(state.reserveTon) / Number(state.reserveKuki);
    $("liq-ton").value = v > 0 ? (v * ratio).toFixed(6) : "";
  }
});
document.querySelectorAll("#tf button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#tf button").forEach((x) => x.classList.toggle("on", x === b));
    state.tf = b.dataset.tf;
    loadChart();
  }),
);
window.addEventListener("hashchange", route);
window.addEventListener("resize", () => loadChart());

if (window.Telegram?.WebApp) {
  const tg = window.Telegram.WebApp;
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor("#07030f");
    tg.setBackgroundColor("#07030f");
  } catch {}
}

initWallet();
route();
loadPool();
setSide("ton");
loadChart();
setInterval(loadPool, 30000);

async function loadBotStatus() {
  try {
    const res = await fetch("/api/bot/status");
    const s = await res.json();
    if (!s) {
      $("bot-state").textContent = "offline";
      $("bot-mode").textContent = "—";
      return;
    }
    const price = Number(s.stonfiKuki || 0) / Number(s.stonfiTon || 1);
    const netTon = price > 0 ? Number(s.netKuki || 0) / 1e9 / price : 0;
    $("bot-state").textContent = s.mode === "live" ? "live" : "monitor";
    $("bot-mode").textContent = s.mode === "live" ? "trading" : "monitoring";
    $("bot-gap").textContent = `${Number(s.gapBps || 0).toFixed(2)} bps`;
    $("bot-net").textContent = `${netTon >= 0 ? "+" : ""}${netTon.toFixed(4)} TON`;
    $("bot-trade").textContent = s.lastTradeAt ? new Date(s.lastTradeAt).toLocaleTimeString() : "none";
    $("bot-ts").textContent = s.ts ? new Date(s.ts).toLocaleTimeString() : "—";
  } catch {
    $("bot-state").textContent = "offline";
  }
}
loadBotStatus();
setInterval(loadBotStatus, 60000);

