/**
 * The bot loop.
 *
 * Read both pools -> size the trade -> guard it -> (optionally) execute.
 *
 * The guard is the important part: a trade is only sent if a *fresh* quote for
 * both legs still clears gas + the profit floor. The second leg is re-checked
 * against the tokens actually received, so a stale price can never turn into a
 * losing round trip — the worst case is holding the intermediate token.
 */
import { Address, toNano } from "@ton/core";
import { TonClient } from "@ton/ton";

import type { BotConfig } from "./config.ts";
import { mulDiv, SCALE } from "./math/fixed.ts";
import { spotPrice } from "./math/weighted.ts";
import { findBestArb, gasInKuki, type ArbPlan } from "./strategy/arb.ts";
import { checkPlan, leg2Floor, type GuardState } from "./strategy/guard.ts";
import { fetchStonfiPool, stonfiQuote } from "./venues/stonfi.ts";
import { KukiVenueReader } from "./venues/kuki.ts";
import type { Venue } from "./venues/types.ts";
import { swapOnKuki } from "./exec/kuki.ts";
import { swapOnStonfi } from "./exec/stonfi.ts";
import { jettonBalance, waitForBalance } from "./exec/balances.ts";
import { openBotWallet, type BotWallet } from "./exec/wallet.ts";

/** Raw jetton units (9 decimals) -> display number. */
const tok = (raw: bigint, dp = 2) => Number((Number(raw) / 1e9).toFixed(dp));

export type RunDeps = {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

export type Tick = {
  stonfi: Venue;
  kuki: Venue;
  plan: ArbPlan | null;
  kukiPerTon: bigint;
  gasKuki: bigint;
  maxKukiIn: bigint;
};

export async function readTick(config: BotConfig, deps: RunDeps = {}): Promise<Tick> {
  if (!config.kukiPool) throw new Error("KUKI_POOL is not configured");
  const log = deps.log ?? console.log;

  const reader = new KukiVenueReader(config.kukiPool, config.kukiJetton, config.endpoint, config.apiKey);
  const [stonfi, kuki] = await Promise.all([
    fetchStonfiPool(config.stonfiPool, config.kukiJetton, deps.fetchImpl ?? fetch),
    reader.read(),
  ]);

  // The pool quotes KUKI per TON directly, which is exactly the unit gas needs.
  const kukiPerTon = spotPrice(stonfi.pool);
  if (kukiPerTon === 0n) log("warn: cannot derive KUKI/TON price; gas accounting disabled");

  const gasKuki = kukiPerTon === 0n ? 0n : gasInKuki(toNano(config.gasPerTradeTon.toFixed(9)), kukiPerTon);
  const capByTon = kukiPerTon === 0n ? 0n : mulDiv(toNano(config.maxTradeTon.toFixed(9)), kukiPerTon, SCALE);

  let walletKuki = capByTon;
  if (config.execute && config.walletMnemonic) {
    const client = new TonClient({ endpoint: config.endpoint, apiKey: config.apiKey });
    const wallet = await openBotWallet(client, config.walletMnemonic);
    const bal = await jettonBalance(client, config.kukiJetton, wallet.address);
    walletKuki = bal < capByTon ? bal : capByTon;
  }

  const plan = findBestArb(stonfi, kuki, walletKuki, gasKuki);
  return { stonfi, kuki, plan, kukiPerTon, gasKuki, maxKukiIn: walletKuki };
}

export function describeTick(tick: Tick): string {
  const { plan } = tick;
  const base =
    `STON.fi ${tok(tick.stonfi.pool.kuki)} KUKI / ${tok(tick.stonfi.pool.token)} TON` +
    ` | KUKI DEX ${tok(tick.kuki.pool.kuki)} KUKI / ${tok(tick.kuki.pool.token)} TON`;
  if (!plan) return `${base} | no edge`;
  const tonProfit = tick.kukiPerTon === 0n ? 0n : mulDiv(plan.netProfit, SCALE, tick.kukiPerTon);
  return (
    `${base} | gap ${plan.gapBps.toFixed(1)} bps | buy ${plan.buy.id} sell ${plan.sell.id}` +
    ` | size ${tok(plan.amountIn)} KUKI` +
    ` | gross ${tok(plan.grossProfit)} KUKI` +
    ` | net ${tok(plan.netProfit)} KUKI (${tok(tonProfit, 4)} TON)`
  );
}

/** Ask the pool itself for the quote it would execute. */
export async function onChainQuote(reader: KukiVenueReader, assetIn: 0 | 1, amount: bigint): Promise<bigint> {
  const res = await reader.client.runMethod(Address.parse(reader.address), "getQuote", [
    { type: "int", value: BigInt(assetIn) },
    { type: "int", value: amount },
  ]);
  return res.stack.readBigNumber();
}

async function quoteVenue(
  venue: Venue,
  assetIn: 0 | 1,
  amount: bigint,
  reader: KukiVenueReader,
  config: BotConfig,
): Promise<bigint> {
  if (venue.id === "kuki") return onChainQuote(reader, assetIn, amount);
  // STON.fi has no synchronous on-chain getter for us; refresh the pool first so
  // the quote is as close to execution time as possible.
  const fresh = await fetchStonfiPool(config.stonfiPool, config.kukiJetton);
  return stonfiQuote(fresh, assetIn === 0, amount);
}

export type ExecutionResult = "done" | "aborted" | "held";

export async function executePlan(
  plan: ArbPlan,
  config: BotConfig,
  log: (line: string) => void,
): Promise<ExecutionResult> {
  if (plan.netProfit <= 0n) return "aborted";
  if (!config.walletMnemonic) throw new Error("wallet mnemonic missing");

  const client = new TonClient({ endpoint: config.endpoint, apiKey: config.apiKey });
  const wallet = await openBotWallet(client, config.walletMnemonic);
  const reader = new KukiVenueReader(config.kukiPool, config.kukiJetton, config.endpoint, config.apiKey);
  const token = await tokenAddress(reader);
  const slip = BigInt(10_000 - config.slippageBps);

  // Gas floor, expressed in KUKI. Use the KUKI-side pool we can read; if the
  // buy venue is STON.fi, the sell venue is the KUKI pool.
  const kukiPerTon = spotPrice(plan.buy.id === "kuki" ? plan.buy.pool : plan.sell.pool);
  const minProfitKuki = mulDiv(toNano(config.minProfitTon.toFixed(9)), kukiPerTon, SCALE);

  // ---- pre-trade proof, with fresh quotes -------------------------------
  const q1 = await quoteVenue(plan.buy, 0, plan.amountIn, reader, config);
  if (q1 <= 0n) {
    log("abort: buy side returned no quote");
    return "aborted";
  }
  const q2 = await quoteVenue(plan.sell, 1, q1, reader, config);
  const guaranteed = mulDiv(q2, slip, 10_000n);
  if (guaranteed <= plan.amountIn) {
    log(`abort: fresh quotes say loss (${tok(guaranteed)} <= ${tok(plan.amountIn)})`);
    return "aborted";
  }
  if (guaranteed - plan.amountIn < minProfitKuki) {
    log("abort: fresh proof is below MIN_PROFIT_TON");
    return "aborted";
  }

  const minOut1 = mulDiv(q1, slip, 10_000n);
  log(
    `leg1: ${plan.buy.id} KUKI->token size ${tok(plan.amountIn, 4)}` +
      ` (proof ${tok(guaranteed - plan.amountIn, 4)} KUKI)`,
  );

  if (plan.buy.id === "stonfi") {
    await swapOnStonfi({
      client,
      wallet,
      router: config.stonfiRouter,
      version: config.stonfiRouterVersion,
      offerJetton: config.kukiJetton,
      askJetton: token,
      amountIn: plan.amountIn,
      minOut: minOut1,
    });
  } else {
    await swapOnKuki({
      reader,
      wallet,
      pool: config.kukiPool,
      offerJetton: config.kukiJetton,
      assetIn: 0,
      amountIn: plan.amountIn,
      minOut: minOut1,
      deadline: Math.floor(Date.now() / 1000) + 120,
    });
  }

  // ---- wait for the intermediate token ---------------------------------
  const before = await jettonBalance(client, token, wallet.address);
  const after = await waitForBalance(client, token, wallet.address, (b) => b > before);
  const received = after - before;
  log(`leg1 settled: +${tok(received, 4)} token`);
  if (received <= 0n) {
    log("abort: no token received; holding");
    return "aborted";
  }

  // ---- leg 2 must still be profitable with the amount we actually got ---
  const q2b = await quoteVenue(plan.sell, 1, received, reader, config);
  const floor2 = leg2Floor({
    size: plan.amountIn,
    received,
    quoteOut: q2b,
    slippageBps: config.slippageBps,
    minProfit: minProfitKuki,
  });
  if (floor2 === null) {
    log(`hold: selling ${tok(received, 4)} now would not clear gas + floor; keeping token`);
    return "held";
  }

  log(`leg2: ${plan.sell.id} token->KUKI min ${tok(floor2, 4)}`);
  if (plan.sell.id === "stonfi") {
    await swapOnStonfi({
      client,
      wallet,
      router: config.stonfiRouter,
      version: config.stonfiRouterVersion,
      offerJetton: token,
      askJetton: config.kukiJetton,
      amountIn: received,
      minOut: floor2,
    });
  } else {
    await swapOnKuki({
      reader,
      wallet,
      pool: config.kukiPool,
      offerJetton: token,
      assetIn: 1,
      amountIn: received,
      minOut: floor2,
      deadline: Math.floor(Date.now() / 1000) + 120,
    });
  }
  log("leg2 sent: round trip complete");
  return "done";
}

async function tokenAddress(reader: KukiVenueReader): Promise<string> {
  const res = await reader.client.runMethod(Address.parse(reader.address), "getAssets");
  res.stack.readAddress(); // KUKI
  return res.stack.readAddress().toString();
}

export async function runForever(config: BotConfig, deps: RunDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  if (config.execute) log("EXECUTE=1 — the bot will send real transactions");
  else log("dry-run: set EXECUTE=1 to trade");

  const state: GuardState = { lastTradeAt: 0, consecutiveFailures: 0 };
  const guardCfg = {
    minProfit: 0n, // converted per tick once the KUKI/TON price is known
    maxTrade: 0n,
    minEdgeBps: config.minEdgeBps,
    maxPoolShareBps: config.maxPoolShareBps,
    cooldownMs: config.cooldownMs,
    maxConsecutiveFailures: config.maxConsecutiveFailures,
  };

  let wallet: BotWallet | null = null;
  let lastStatus = 0;
  let lastSweep = 0;

  for (;;) {
    try {
      const tick = await readTick(config, deps);
      log(describeTick(tick));

      if (tick.plan && tick.kukiPerTon > 0n) {
        guardCfg.minProfit = mulDiv(toNano(config.minProfitTon.toFixed(9)), tick.kukiPerTon, SCALE);
        guardCfg.maxTrade = tick.maxKukiIn;
        const verdict = checkPlan(tick.plan, guardCfg, state, Date.now());
        if (!verdict.ok) {
          if (verdict.reason !== "no_edge") log(`skip: ${verdict.reason}`);
        } else if (!config.execute) {
          log("would trade (dry-run)");
        } else {
          if (!wallet && config.walletMnemonic) {
            const client = new TonClient({ endpoint: config.endpoint, apiKey: config.apiKey });
            wallet = await openBotWallet(client, config.walletMnemonic);
          }
          const result = await executePlan(tick.plan, config, log);
          state.lastTradeAt = Date.now();
          state.consecutiveFailures = result === "done" ? 0 : state.consecutiveFailures + 1;
          if (state.consecutiveFailures > 0) {
            log(`failures: ${state.consecutiveFailures}/${config.maxConsecutiveFailures}`);
          }
        }
      }

      // Publish a compact status for the DEX dashboard (KV-backed).
      if (config.statusUrl && config.statusKey && Date.now() - lastStatus > 5 * 60_000) {
        lastStatus = Date.now();
        const payload = {
          ts: Date.now(),
          pool: config.kukiPool,
          stonfi: config.stonfiPool,
          kukiReserve: tick.kuki.pool.kuki.toString(),
          tonReserve: tick.kuki.pool.token.toString(),
          stonfiKuki: tick.stonfi.pool.kuki.toString(),
          stonfiTon: tick.stonfi.pool.token.toString(),
          gapBps: tick.plan ? Number(tick.plan.gapBps.toFixed(2)) : 0,
          netKuki: tick.plan ? tick.plan.netProfit.toString() : "0",
          mode: config.execute ? "live" : "monitor",
          lastTradeAt: state.lastTradeAt,
          failures: state.consecutiveFailures,
        };
        try {
          await fetch(`${config.statusUrl}/api/bot/status`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bot-key": config.statusKey },
            body: JSON.stringify(payload),
          });
        } catch (err) {
          log(`status post failed: ${(err as Error).message}`);
        }
      }

      // Sweep trading profit to the admin wallet, keeping a gas buffer.
      if (config.execute && config.sweepTo && wallet && Date.now() - lastSweep > 10 * 60_000) {
        lastSweep = Date.now();
        try {
          const balance = await wallet.balance();
          const keep = toNano(config.sweepMinTon.toFixed(9));
          if (balance > keep + toNano("0.05")) {
            const value = balance - keep;
            await wallet.send(Address.parse(config.sweepTo), value, null);
            log(`sweep: ${Number(value) / 1e9} TON -> ${config.sweepTo}`);
          }
        } catch (err) {
          log(`sweep failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      log(`tick failed: ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }
}
