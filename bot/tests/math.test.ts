import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { SCALE, exp, fmt, ln, powRatio } from "../src/math/fixed.ts";
import { amountIn, amountOut, applySwap, sharesForDeposit, spotPrice } from "../src/math/weighted.ts";
import { findBestArb, gasInKuki, roundTrip } from "../src/strategy/arb.ts";
import type { Venue } from "../src/venues/types.ts";

function venue(id: "stonfi" | "kuki", kuki: bigint, token: bigint, wKuki = 1n, wToken = 1n, feeBps = 30n): Venue {
  return { id, address: id, label: id, pool: { kuki, token, wKuki, wToken, feeBps } };
}

const K = 10n ** 9n;

describe("fixed point", () => {
  it("ln matches Math.log to 1e-9", () => {
    for (const v of [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999999, 1]) {
      const x = BigInt(Math.round(v * 1e18));
      const got = Number(ln(x)) / 1e18;
      assert.ok(Math.abs(got - Math.log(v)) < 1e-9, `${v}: ${got} vs ${Math.log(v)}`);
    }
  });

  it("exp(ln(x)) round-trips to 1e-12", () => {
    for (const v of [0.01, 0.1, 0.5, 0.9, 0.999]) {
      const x = BigInt(Math.round(v * 1e18));
      const back = Number(exp(ln(x))) / 1e18;
      assert.ok(Math.abs(back - v) < 1e-12, `${v} -> ${back}`);
    }
  });

  it("powRatio handles integer and fractional exponents", () => {
    const t = BigInt(Math.round(0.8 * 1e18));
    assert.ok(Math.abs(Number(powRatio(t, 4n, 1n)) / 1e18 - 0.8 ** 4) < 1e-12);
    assert.ok(Math.abs(Number(powRatio(t, 1n, 4n)) / 1e18 - 0.8 ** 0.25) < 1e-9);
    assert.equal(powRatio(SCALE, 3n, 7n), SCALE);
  });
});

describe("weighted pool", () => {
  it("50/50 is exactly constant product with the fee", () => {
    const kuki = 60_000n * K;
    const token = 600_000n * K;
    const amount = 100n * K;
    const expected = (token * amount * 9970n) / (kuki * 10_000n + amount * 9970n);
    assert.equal(amountOut({ kuki, token, wKuki: 1n, wToken: 1n, feeBps: 30n }, true, amount), expected);
  });

  it("80/20 matches the float Osmosis formula", () => {
    const kuki = 60_000n * K;
    const token = 600_000n * K;
    const amount = 100n * K;
    const got = Number(amountOut({ kuki, token, wKuki: 4n, wToken: 1n, feeBps: 30n }, true, amount)) / 1e9;
    const k = Number(kuki) / 1e9;
    const t = Number(token) / 1e9;
    const a = Number(amount) / 1e9;
    const expected = t * (1 - (k / (k + a * 0.997)) ** 4);
    assert.ok(Math.abs(got - expected) / expected < 1e-9, `${got} vs ${expected}`);
  });

  it("never returns more than the reserve and is monotonic", () => {
    const p = { kuki: 1_000n * K, token: 1_000n * K, wKuki: 3n, wToken: 1n, feeBps: 30n };
    let prev = 0n;
    for (const amount of [10n ** 6n, 10n ** 8n, 10n ** 9n, 10n ** 10n, 10n ** 11n]) {
      const out = amountOut(p, true, amount);
      assert.ok(out > prev, `amount ${amount}: ${out} <= ${prev}`);
      assert.ok(out < p.token);
      prev = out;
    }
  });

  it("amountIn inverts amountOut within a few wei", () => {
    const p = { kuki: 5_000n * K, token: 8_000n * K, wKuki: 2n, wToken: 1n, feeBps: 25n };
    const want = 123n * K;
    const need = amountIn(p, true, want);
    const got = amountOut(p, true, need);
    assert.ok(got >= want, `${got} < ${want}`);
    assert.ok(got - want <= 3n, `overshoot ${got - want}`);
  });

  it("spot price follows the weight ratio", () => {
    const p = { kuki: 60_000n * K, token: 600_000n * K, wKuki: 4n, wToken: 1n, feeBps: 30n };
    // (K/4) / (T/1) = 15000 / 600000 = 0.025 KUKI per token
    assert.equal(spotPrice(p), 25_000_000_000_000_000n);
  });

  it("applySwap conserves the fee in reserves", () => {
    const p = { kuki: 1_000n * K, token: 1_000n * K, wKuki: 1n, wToken: 1n, feeBps: 30n };
    const amount = 10n * K;
    const out = amountOut(p, true, amount);
    const next = applySwap(p, true, amount, out);
    assert.ok(next.kuki > p.kuki);
    assert.ok(next.token < p.token);
  });

  it("mints proportional LP shares", () => {
    const p = { kuki: 1_000n * K, token: 1_000n * K, wKuki: 1n, wToken: 1n, feeBps: 30n };
    const total = 1_000_000n * SCALE;
    const shares = sharesForDeposit(p, total, 10n * K, 10n * K);
    assert.equal(shares, total / 100n);
    assert.equal(sharesForDeposit(p, total, 10n * K, 20n * K), -1n);
  });
});

describe("arbitrage sizer", () => {
  const a = venue("stonfi", 60_000n * K, 600_000n * K);
  const b = venue("kuki", 60_000n * K, 588_000n * K); // token 2% dearer here

  it("finds the profitable direction", () => {
    const plan = findBestArb(a, b, 100_000n * K, 0n);
    assert.ok(plan);
    assert.equal(plan.buy.id, "stonfi");
    assert.equal(plan.sell.id, "kuki");
    assert.ok(plan.grossProfit > 0n);
    assert.ok(plan.amountIn > 0n);
    assert.ok(plan.amountIn < a.pool.kuki);
  });

  it("returns null when there is no edge", () => {
    const same = venue("kuki", 60_000n * K, 600_000n * K);
    assert.equal(findBestArb(a, same, 10_000n * K, 0n), null);
  });

  it("is within 0.2% of a brute-force optimum", () => {
    const cap = 2_000n * K;
    const plan = findBestArb(a, b, cap, 0n)!;
    let brute = 0n;
    let bruteX = 0n;
    for (let x = 1n * K; x <= cap; x += 1n * K) {
      const p = roundTrip(a, b, x).profit;
      if (p > brute) {
        brute = p;
        bruteX = x;
      }
    }
    assert.ok(plan);
    assert.ok(plan.grossProfit >= (brute * 998n) / 1000n, `plan ${plan.grossProfit} vs brute ${brute} at ${bruteX}`);
  });

  it("net profit subtracts the gas budget", () => {
    const plan = findBestArb(a, b, 100_000n * K, 0n)!;
    const gas = gasInKuki(450_000_000n, 40n * SCALE);
    const withGas = findBestArb(a, b, 100_000n * K, gas)!;
    assert.equal(withGas.netProfit, plan.grossProfit - gas);
  });

  it("formats big integers", () => {
    assert.equal(fmt(1_234_500_000_000_000_000_000n, 2), "1234.50");
  });
});
