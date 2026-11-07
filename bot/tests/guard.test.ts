import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { checkPlan, edgeBps, leg2Floor, type GuardConfig, type GuardState } from "../src/strategy/guard.ts";
import type { ArbPlan } from "../src/strategy/arb.ts";
import type { Venue } from "../src/venues/types.ts";

const K = 10n ** 9n;

function venue(id: "stonfi" | "kuki", kuki: bigint, token: bigint): Venue {
  return { id, address: id, label: id, pool: { kuki, token, wKuki: 1n, wToken: 1n, feeBps: 30n } };
}

const buy = venue("stonfi", 60_000n * K, 600_000n * K);
const sell = venue("kuki", 60_000n * K, 612_000n * K);

const plan: ArbPlan = {
  buy,
  sell,
  amountIn: 1_000n * K,
  tokenOut: 9_950n * K,
  amountBack: 1_015n * K,
  grossProfit: 15n * K,
  gasKuki: 4n * K,
  netProfit: 11n * K,
  gapBps: 200,
};

const cfg: GuardConfig = {
  minProfit: 5n * K,
  maxTrade: 10_000n * K,
  minEdgeBps: 40,
  maxPoolShareBps: 2_000,
  cooldownMs: 20_000,
  maxConsecutiveFailures: 3,
};

const fresh: GuardState = { lastTradeAt: 0, consecutiveFailures: 0 };

describe("profit guard (protorev-style)", () => {
  it("accepts a plan that clears gas and the profit floor", () => {
    assert.deepEqual(checkPlan(plan, cfg, fresh, 1_000_000), { ok: true });
  });

  it("rejects a negative or thin edge", () => {
    assert.equal((checkPlan({ ...plan, netProfit: 1n * K }, cfg, fresh) as any).reason, "below_min_profit");
    assert.equal((checkPlan({ ...plan, grossProfit: 0n }, cfg, fresh) as any).reason, "gross_not_positive");
    assert.equal((checkPlan(null, cfg, fresh) as any).reason, "no_edge");
  });

  it("rejects oversized trades and pool-share violations", () => {
    assert.equal((checkPlan({ ...plan, amountIn: 20_000n * K }, cfg, fresh) as any).reason, "above_max_trade");
    const smallPool = venue("stonfi", 2_000n * K, 20_000n * K);
    const oversized = { ...plan, buy: smallPool, amountIn: 1_000n * K };
    assert.equal((checkPlan(oversized, cfg, fresh) as any).reason, "too_much_of_pool");
  });

  it("rejects a low realised edge", () => {
    const lowEdge = { ...plan, grossProfit: 2n * K, netProfit: 6n * K };
    assert.equal((checkPlan(lowEdge, cfg, fresh) as any).reason, "edge_below_floor");
    assert.ok(edgeBps(lowEdge) < cfg.minEdgeBps);
  });

  it("enforces cooldown and the circuit breaker", () => {
    const cooling: GuardState = { lastTradeAt: 1_000_000, consecutiveFailures: 0 };
    assert.equal((checkPlan(plan, cfg, cooling, 1_005_000) as any).reason, "cooldown");
    const broken: GuardState = { lastTradeAt: 0, consecutiveFailures: 3 };
    assert.equal((checkPlan(plan, cfg, broken) as any).reason, "circuit_open");
  });

  it("leg 2 floor refuses to sell at a loss", () => {
    // 0.4% gross is eaten by 0.5% slippage → floor below the input
    assert.equal(
      leg2Floor({ size: 1_000n * K, received: 9_950n * K, quoteOut: 1_004n * K, slippageBps: 50, minProfit: 0n }),
      null,
    );
    // profitable: 1,100 out, 50 bps slippage → 1,094.5 ≥ 1,000 + 5
    const floor = leg2Floor({
      size: 1_000n * K,
      received: 9_950n * K,
      quoteOut: 1_100n * K,
      slippageBps: 50,
      minProfit: 5n * K,
    });
    assert.ok(floor !== null);
    assert.equal(floor, 1_094_500_000_000n);
  });
});
