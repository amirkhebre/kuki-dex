/**
 * Minimum pool depth for the arbitrage bot to clear gas at a given gap.
 *   node dist/scripts/depth-scan.js
 */
import { toNano } from "@ton/core";
import { spotPrice } from "../bot/src/math/weighted.ts";
import { findBestArb, gasInKuki } from "../bot/src/strategy/arb.ts";
import { fetchStonfiPool } from "../bot/src/venues/stonfi.ts";
import type { Venue } from "../bot/src/venues/types.ts";

const KUKI_TON_POOL = "EQCjsEs7maKN4R-f7Hbit7Ds7Ua5KBdUsaEKG7Dv6RyqTPGv";
const KUKI = "EQCK1R0hqLuqG3XuG_CR_flKuZZuOxryCrAL3bH44Dq9RUa3";

const base = await fetchStonfiPool(KUKI_TON_POOL, KUKI);
const kukiPerTon = spotPrice(base.pool); // KUKI per TON, 1e18
const kukiPerTonHuman = Number(kukiPerTon) / 1e18;
const currentTon = Number(base.pool.token) / 1e9;

function venueAt(depthTon: number, gapBps: number, dearer: boolean): Venue {
  const scale = depthTon / currentTon;
  const kuki = BigInt(Math.round(Number(base.pool.kuki) * scale));
  const ton = BigInt(Math.round(Number(base.pool.token) * scale));
  // price = TON / KUKI; a dearer KUKI venue has less KUKI per TON.
  const factor = 1 + gapBps / 10_000;
  return {
    ...base,
    pool: {
      ...base.pool,
      kuki: dearer ? BigInt(Math.round(Number(kuki) / factor)) : kuki,
      token: dearer ? ton : BigInt(Math.round(Number(ton) / factor)),
    },
  };
}

function netTon(depthTon: number, gapBps: number, gasTon: number): number {
  const cheap = venueAt(depthTon, gapBps, false);
  const dear = venueAt(depthTon, gapBps, true);
  const gasKuki = gasInKuki(toNano(gasTon.toFixed(9)), kukiPerTon);
  const plan = findBestArb(cheap, dear, cheap.pool.kuki / 4n, gasKuki);
  if (!plan) return -Infinity;
  return Number(plan.netProfit) / 1e9 / kukiPerTonHuman; // KUKI -> TON
}

function minDepth(gapBps: number, gasTon: number): number {
  let lo = 20;
  let hi = 50_000;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (netTon(mid, gapBps, gasTon) > 0) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi);
}

console.log(`KUKI price: ${kukiPerTonHuman.toFixed(2)} KUKI per TON`);
console.log("\nminimum TON-side depth for a positive net trade:");
console.log("gap bps | gas 0.30 | gas 0.45 | KUKI needed at 0.45");
for (const gap of [150, 200, 250, 300, 337, 400, 500]) {
  const d30 = minDepth(gap, 0.3);
  const d45 = minDepth(gap, 0.45);
  console.log(
    `${gap.toString().padStart(7)} | ${d30.toString().padStart(8)} | ${d45.toString().padStart(8)} | ${Math.round(
      d45 * kukiPerTonHuman,
    ).toLocaleString("en-US")}`,
  );
}

console.log("\nnet per trade at the current 337 bps gap:");
console.log("depth TON | gas 0.30 | gas 0.45");
for (const depth of [500, 750, 1000, 1250, 1500, 2000, 3000, 5000]) {
  console.log(
    `${depth.toString().padStart(9)} | ${netTon(depth, 337, 0.3).toFixed(4).padStart(8)} | ${netTon(depth, 337, 0.45)
      .toFixed(4)
      .padStart(8)}`,
  );
}
