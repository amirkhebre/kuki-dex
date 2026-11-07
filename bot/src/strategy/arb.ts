/**
 * Cross-venue arbitrage sizing.
 *
 * The bot buys the token where KUKI is cheap and sells it where KUKI is
 * expensive. Profit as a function of size is concave (fees + price impact), so
 * a ternary search finds the optimum; a short linear scan around it removes
 * integer-rounding noise.
 *
 * Everything is in raw jetton units. `gasKuki` converts the TON gas budget into
 * KUKI units so the net number is directly comparable to the profit.
 */
import { BPS, SCALE, mulDiv } from "../math/fixed.ts";
import { amountOut, spotPrice } from "../math/weighted.ts";
import type { Venue } from "../venues/types.ts";

export type ArbPlan = {
  /** Venue where KUKI is bought (KUKI -> token). */
  buy: Venue;
  /** Venue where the token is sold (token -> KUKI). */
  sell: Venue;
  amountIn: bigint;
  tokenOut: bigint;
  amountBack: bigint;
  grossProfit: bigint;
  gasKuki: bigint;
  netProfit: bigint;
  /** Spot-price difference in basis points (sell vs buy). */
  gapBps: number;
};

/** KUKI -> token on `buy`, then token -> KUKI on `sell`. */
export function roundTrip(buy: Venue, sell: Venue, amountIn: bigint): { tokenOut: bigint; amountBack: bigint; profit: bigint } {
  const tokenOut = amountOut(buy.pool, true, amountIn);
  if (tokenOut <= 0n) return { tokenOut: 0n, amountBack: 0n, profit: -amountIn };
  const amountBack = amountOut(sell.pool, false, tokenOut);
  return { tokenOut, amountBack, profit: amountBack - amountIn };
}

/** `kukiPerTon` is KUKI per 1 TON, scaled by 1e18. */
export function gasInKuki(gasTon: bigint, kukiPerTon: bigint): bigint {
  return mulDiv(gasTon, kukiPerTon, SCALE);
}

/**
 * Edge in bps: how much more expensive the token is on `sell` than on `buy`.
 * Positive means the round trip is directionally profitable before fees.
 */
export function spotGapBps(buy: Venue, sell: Venue): number {
  const pb = spotPrice(buy.pool);
  const ps = spotPrice(sell.pool);
  if (pb === 0n) return 0;
  return Number(((ps - pb) * BPS) / pb);
}

export function findBestArb(a: Venue, b: Venue, maxKukiIn: bigint, gasKuki: bigint): ArbPlan | null {
  if (maxKukiIn <= 0n) return null;

  const candidates: ArbPlan[] = [];
  for (const [buy, sell] of [
    [a, b],
    [b, a],
  ] as const) {
    // Buy the token where it is cheapest (lowest KUKI price) and sell it where
    // it is dearest.
    if (spotPrice(buy.pool) >= spotPrice(sell.pool)) continue;

    const cap = minBigInt(maxKukiIn, buy.pool.kuki / 4n);
    if (cap <= 0n) continue;

    const f = (x: bigint) => roundTrip(buy, sell, x).profit;

    let lo = 1n;
    let hi = cap;
    while (hi - lo > 8n) {
      const third = (hi - lo) / 3n;
      const m1 = lo + third;
      const m2 = hi - third;
      if (f(m1) < f(m2)) lo = m1;
      else hi = m2;
    }

    let bestX = lo;
    let bestProfit = f(lo);
    for (let x = lo; x <= hi; x++) {
      const p = f(x);
      if (p > bestProfit) {
        bestProfit = p;
        bestX = x;
      }
    }

    // Refine one wei at a time around the integer optimum: rounding can put the
    // true peak a few units away from the ternary result.
    for (let d = 1n; d <= 64n; d++) {
      const up = bestX + d;
      if (up <= cap && f(up) > bestProfit) {
        bestProfit = f(up);
        bestX = up;
      }
      const down = bestX - d;
      if (down > 0n && f(down) > bestProfit) {
        bestProfit = f(down);
        bestX = down;
      }
    }

    const trip = roundTrip(buy, sell, bestX);
    if (trip.profit <= 0n) continue;

    candidates.push({
      buy,
      sell,
      amountIn: bestX,
      tokenOut: trip.tokenOut,
      amountBack: trip.amountBack,
      grossProfit: trip.profit,
      gasKuki,
      netProfit: trip.profit - gasKuki,
      gapBps: spotGapBps(buy, sell),
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((x, y) => (y.netProfit > x.netProfit ? 1 : y.netProfit < x.netProfit ? -1 : 0));
  return candidates[0]!;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
