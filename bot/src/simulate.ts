/**
 * Economics workbench.
 *
 * Pulls the *real* KUKI/TON STON.fi pool, then asks: if the KUKI DEX quoted the
 * same pair at a given gap, how large would the optimal arbitrage be, what would
 * it earn, and what gap just covers gas? That is the honest way to size the
 * opportunity — the bot's profit is bounded by the depth of the shallower pool
 * and by how long a gap survives.
 *
 *   node bot/src/simulate.ts [gapBps...]
 */
import { toNano } from "@ton/core";
import { mulDiv, SCALE } from "./math/fixed.ts";
import { spotPrice } from "./math/weighted.ts";
import { findBestArb, gasInKuki, spotGapBps } from "./strategy/arb.ts";
import { fetchStonfiPool } from "./venues/stonfi.ts";
import type { Venue } from "./venues/types.ts";
import { loadConfig } from "./config.ts";

const KUKI_TON_POOL = "EQCjsEs7maKN4R-f7Hbit7Ds7Ua5KBdUsaEKG7Dv6RyqTPGv";
const GAS_TON = 0.45;
const TON_USD = 2.4;

/** Raw jetton units (9 decimals) -> display number. */
const tok = (raw: bigint, dp = 2) => Number((Number(raw) / 1e9).toFixed(dp));

const config = loadConfig();
const stonfi = await fetchStonfiPool(KUKI_TON_POOL, config.kukiJetton);
const pool = stonfi.pool;

const price = spotPrice(pool); // KUKI per TON, 1e18
const kukiPerTon = price;
const gasKuki = gasInKuki(toNano(GAS_TON.toFixed(9)), kukiPerTon);

console.log(`STON.fi KUKI/TON pool ${KUKI_TON_POOL}`);
console.log(`  reserves: ${tok(pool.kuki)} KUKI / ${tok(pool.token)} TON`);
console.log(`  price:    ${(Number(price) / 1e18).toFixed(2)} KUKI per TON`);
console.log(`  fee:      ${Number(pool.feeBps)} bps`);
console.log(`  gas:      ${GAS_TON} TON = ${tok(gasKuki, 0)} KUKI per round trip`);

// Optional: scale the pair to a hypothetical depth so the table answers "what
// would this look like if the KUKI DEX had N TON of liquidity?".
//   node bot/src/simulate.js depth=5000 100 200
const depthArg = process.argv.find((a) => a.startsWith("depth="));
const targetDepthTon = depthArg ? Number(depthArg.slice("depth=".length)) : 0;
const scale = targetDepthTon > 0 ? BigInt(Math.round((targetDepthTon / tok(pool.token, 6)) * 1000)) : 1000n;
const scaledPool = {
  ...pool,
  kuki: (pool.kuki * scale) / 1000n,
  token: (pool.token * scale) / 1000n,
};
if (targetDepthTon > 0) {
  console.log(`  scenario: scaled ${(Number(scale) / 1000).toFixed(1)}x to ~${targetDepthTon} TON depth`);
}

/** Both venues are assumed to sit at the same depth for a fair comparison. */
const base: Venue = { ...stonfi, pool: scaledPool };

/** Same pair, same KUKI depth, but the token costs `gapBps` more on KUKI DEX. */
function synthetic(gapBps: number): Venue {
  const factor = BigInt(Math.round((1 + gapBps / 10_000) * 1e6));
  return {
    id: "kuki",
    address: "simulated",
    label: "KUKI DEX (sim)",
    pool: { ...scaledPool, token: (scaledPool.token * 1_000_000n) / factor },
  };
}

const gaps = process.argv.slice(2).map(Number).filter((n) => n > 0);
const list = gaps.length > 0 ? gaps : [10, 25, 50, 100, 200, 400];

const rows = list.map((gap) => {
  const kuki = synthetic(gap);
  const maxIn = scaledPool.kuki / 4n;
  const plan = findBestArb(base, kuki, maxIn, gasKuki);
  const net = plan?.netProfit ?? 0n;
  const gross = plan?.grossProfit ?? 0n;
  const size = plan?.amountIn ?? 0n;
  const tonNet = mulDiv(net, SCALE, kukiPerTon);
  return {
    "gap bps": gap,
    "spot bps": Number(spotGapBps(base, kuki)),
    "size KUKI": tok(size, 1),
    "size % pool": Number(((size * 10_000n) / scaledPool.kuki).toString()) / 100,
    "gross KUKI": tok(gross, 2),
    "net KUKI": tok(net, 2),
    "net TON": tok(tonNet, 4),
    "net USD": Number((tok(tonNet, 4) * TON_USD).toFixed(2)),
  };
});

console.table(rows);

// Break-even gap: smallest gap whose best trade covers gas.
let lo = 1;
let hi = 2000;
let best = -1;
while (lo <= hi) {
  const mid = (lo + hi) >> 1;
  const plan = findBestArb(base, synthetic(mid), scaledPool.kuki / 4n, gasKuki);
  if (plan && plan.netProfit > 0n) {
    best = mid;
    hi = mid - 1;
  } else {
    lo = mid + 1;
  }
}
console.log(`\nbreak-even gap (covers ${GAS_TON} TON gas): ${best < 0 ? ">2000" : best} bps`);
console.log(`USD assumes TON = $${TON_USD}; the point is the shape, not the dollar figure.`);
