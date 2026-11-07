/**
 * The "never trade at a loss" gate — our version of Osmosis ProtoRev's
 * profitability check.
 *
 * ProtoRev runs on-chain at the end of a block and only captures a cyclic arb
 * if the simulated result is positive. TON cannot make two independent AMM
 * calls atomic, so we do the next best thing:
 *
 *   1. prove the profit twice with fresh quotes (before leg 1 and again before
 *      leg 2, using the tokens actually received),
 *   2. put a hard `minOut` on every leg,
 *   3. refuse to open a trade that does not clear gas + the configured floor,
 *   4. stop after repeated failures instead of bleeding gas.
 *
 * Every check is a pure function so it can be unit-tested without a network.
 */
import { mulDiv } from "../math/fixed.ts";
import type { ArbPlan } from "./arb.ts";

export type GuardConfig = {
  /** Minimum net profit in KUKI raw units. */
  minProfit: bigint;
  /** Maximum KUKI input per trade, raw units. */
  maxTrade: bigint;
  /** Minimum realised edge (gross profit / size) in bps. */
  minEdgeBps: number;
  /** Never use more than this share of the buy pool's KUKI reserve. */
  maxPoolShareBps: number;
  /** Minimum time between two trades. */
  cooldownMs: number;
  /** Open the circuit after this many consecutive failures. */
  maxConsecutiveFailures: number;
};

export type GuardState = {
  lastTradeAt: number;
  consecutiveFailures: number;
};

export type GuardResult = { ok: boolean; reason?: string };

/** Realised edge of the plan, in bps of the input. */
export function edgeBps(plan: ArbPlan): number {
  if (plan.amountIn <= 0n) return 0;
  return Number((plan.grossProfit * 10_000n) / plan.amountIn);
}

export function checkPlan(plan: ArbPlan | null, cfg: GuardConfig, state: GuardState, now = Date.now()): GuardResult {
  if (!plan) return { ok: false, reason: "no_edge" };
  if (plan.amountIn <= 0n) return { ok: false, reason: "zero_size" };
  if (plan.grossProfit <= 0n) return { ok: false, reason: "gross_not_positive" };
  if (plan.netProfit < cfg.minProfit) return { ok: false, reason: "below_min_profit" };
  if (plan.amountIn > cfg.maxTrade) return { ok: false, reason: "above_max_trade" };
  if (plan.amountIn * 10_000n > plan.buy.pool.kuki * BigInt(cfg.maxPoolShareBps)) {
    return { ok: false, reason: "too_much_of_pool" };
  }
  if (plan.tokenOut <= 0n || plan.tokenOut >= plan.sell.pool.token) {
    return { ok: false, reason: "sell_side_exhausted" };
  }
  if (edgeBps(plan) < cfg.minEdgeBps) return { ok: false, reason: "edge_below_floor" };
  if (state.consecutiveFailures >= cfg.maxConsecutiveFailures) return { ok: false, reason: "circuit_open" };
  if (state.lastTradeAt > 0 && now - state.lastTradeAt < cfg.cooldownMs) {
    return { ok: false, reason: "cooldown" };
  }
  return { ok: true };
}

/**
 * Second gate, run with the tokens actually received after leg 1.
 * `quoteOut` is the fresh quote for selling `received` on the second venue.
 * Returns the minimum acceptable output for leg 2, or null to hold the token.
 */
export function leg2Floor(args: {
  size: bigint;
  received: bigint;
  quoteOut: bigint;
  slippageBps: number;
  minProfit: bigint;
}): bigint | null {
  const slip = BigInt(10_000 - args.slippageBps);
  const floor = mulDiv(args.quoteOut, slip, 10_000n);
  if (floor <= args.size) return null;
  if (floor - args.size < args.minProfit) return null;
  return floor;
}
