import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { TupleReader } from "@ton/core";

import { parseStonfiPool, stonfiQuote } from "../src/venues/stonfi.ts";
import { parseKukiState } from "../src/venues/kuki.ts";

const KUKI = "EQCK1R0hqLuqG3XuG_CR_flKuZZuOxryCrAL3bH44Dq9RUa3";
const TON = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

// Recorded from https://api.ston.fi/v1/pools/EQCjsEs7maKN4R-f7Hbit7Ds7Ua5KBdUsaEKG7Dv6RyqTPGv
const FIXTURE = {
  pool: {
    address: "EQCjsEs7maKN4R-f7Hbit7Ds7Ua5KBdUsaEKG7Dv6RyqTPGv",
    reserve0: "60187496174",
    reserve1: "621934326020020",
    token0_address: TON,
    token1_address: KUKI,
    lp_fee: 20,
    protocol_fee: 10,
    router_address: "EQCiypoBWNIEPlarBp04UePyEj5zH0ZDHxuRNqJ1WQx3FCY-",
  },
};

describe("STON.fi venue", () => {
  it("normalises reserves so KUKI is always the base", () => {
    const v = parseStonfiPool(FIXTURE, KUKI, FIXTURE.pool.address);
    assert.equal(v.pool.kuki, 621_934_326_020_020n);
    assert.equal(v.pool.token, 60_187_496_174n);
    assert.equal(v.pool.feeBps, 30n);
    assert.equal(v.pool.wKuki, 1n);
    assert.equal(v.pool.wToken, 1n);
  });

  it("rejects a pool that does not contain KUKI", () => {
    const other = { pool: { ...FIXTURE.pool, token1_address: "EQBsomeOtherJetton" } };
    assert.throws(() => parseStonfiPool(other, KUKI, "x"), /KUKI is not in this pool/);
  });

  it("quotes constant product with fees", () => {
    const v = parseStonfiPool(FIXTURE, KUKI, FIXTURE.pool.address);
    const out = stonfiQuote(v, false, 10n * 10n ** 9n); // 10 TON in
    assert.ok(out > 0n);
    assert.ok(out < v.pool.kuki);
    // fee makes it strictly worse than the no-fee curve
    const noFee = (v.pool.kuki * 10n * 10n ** 9n) / (v.pool.token + 10n * 10n ** 9n);
    assert.ok(out < noFee);
  });
});

describe("KUKI pool state decoder", () => {
  it("reads the getter tuple in order", () => {
    const stack = new TupleReader([
      { type: "int", value: 1000n },
      { type: "int", value: 2000n },
      { type: "int", value: 4n },
      { type: "int", value: 1n },
      { type: "int", value: 30n },
      { type: "int", value: 123n },
      { type: "int", value: 0n }, // paused = false
      { type: "int", value: -1n }, // ready = true
    ]);
    const state = parseKukiState(stack);
    assert.equal(state.kuki, 1000n);
    assert.equal(state.token, 2000n);
    assert.equal(state.wKuki, 4n);
    assert.equal(state.wToken, 1n);
    assert.equal(state.totalShares, 123n);
    assert.equal(state.ready, true);
  });

  it("refuses a paused or unready pool", () => {
    const mk = (paused: bigint, ready: bigint) =>
      new TupleReader([
        { type: "int", value: 1n },
        { type: "int", value: 1n },
        { type: "int", value: 1n },
        { type: "int", value: 1n },
        { type: "int", value: 30n },
        { type: "int", value: 1n },
        { type: "int", value: paused },
        { type: "int", value: ready },
      ]);
    assert.throws(() => parseKukiState(mk(-1n, 0n)), /not bound/);
    assert.throws(() => parseKukiState(mk(-1n, -1n)), /paused/);
  });
});
