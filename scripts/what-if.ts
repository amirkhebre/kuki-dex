/**
 * What-if analysis: depth split and fee levels at the current 337 bps gap.
 *   node dist/scripts/what-if.js
 */
import { toNano } from "@ton/core";
import { spotPrice } from "../bot/src/math/weighted.ts";
import { findBestArb, gasInKuki } from "../bot/src/strategy/arb.ts";
import { fetchStonfiPool } from "../bot/src/venues/stonfi.ts";
import type { Venue } from "../bot/src/venues/types.ts";

const KUKI_TON_POOL = "EQCjsEs7maKN4R-f7Hbit7Ds7Ua5KBdUsaEKG7Dv6RyqTPGv";
const KUKI = "EQCK1R0hqLuqG3XuG_CR_flKuZZuOxryCrAL3bH44Dq9RUa3";
const GAP = 337;

const base = await fetchStonfiPool(KUKI_TON_POOL, KUKI);
const kukiPerTon = spotPrice(base.pool);
const kukiPerTonHuman = Number(kukiPerTon) / 1e18;
const priceTon = Number(base.pool.token) / Number(base.pool.kuki); // TON per KUKI

function venue(depthTon: number, feeBps: number, dearer: boolean): Venue {
  const factor = 1 + GAP / 10_000;
  const kuki = depthTon / priceTon / (dearer ? factor : 1);
  return {
    ...base,
    pool: {
      kuki: BigInt(Math.round(kuki * 1e9)),
      token: BigInt(Math.round(depthTon * 1e9)),
      wKuki: 1n,
      wToken: 1n,
      feeBps: BigInt(feeBps),
    },
  };
}

function net(kukiDepth: number, stonfiDepth: number, fee: number): string {
  const cheap = venue(stonfiDepth, fee, false);
  const dear = venue(kukiDepth, fee, true);
  const gas = gasInKuki(toNano("0.45"), kukiPerTon);
  const plan = findBestArb(cheap, dear, cheap.pool.kuki / 4n, gas);
  if (!plan) return "no plan";
  const ton = Number(plan.netProfit) / 1e9 / kukiPerTonHuman;
  return `${ton >= 0 ? "+" : ""}${ton.toFixed(4)} TON (size ${(Number(plan.amountIn) / 1e9).toFixed(0)} KUKI)`;
}

console.log("KUKI price:", priceTon.toExponential(4), "TON; gap", GAP, "bps\n");
console.log("kukiDepth | stonfiDepth | fee 40bps | fee 15bps | fee 5bps");
for (const [k, s] of [
  [0.3, 59],
  [59, 59],
  [300, 300],
  [300, 10000],
  [1000, 1000],
  [1000, 10000],
  [3000, 3000],
  [5000, 5000],
]) {
  console.log(
    `${String(k).padStart(9)} | ${String(s).padStart(11)} | ${net(k, s, 40)} | ${net(k, s, 15)} | ${net(k, s, 5)}`,
  );
}
