/**
 * Weighted-pool ("Osmosis classic") math, KUKI-normalised.
 *
 * Every pool is quoted in KUKI: reserve KUKI, reserve TOKEN, weight KUKI,
 * weight TOKEN. A 50/50 pool with weights (1,1) is a constant-product pool; an
 * 80/20 pool with weights (4,1) is the classic Osmosis shape.
 *
 * The formulas are the Balancer/Osmosis ones:
 *
 *   out = B_out * (1 - (B_in / (B_in + in * (1 - fee))) ^ (w_in / w_out))
 *
 * The contract implements exactly this with the same 1e18 fixed point and the
 * same floor rounding, so `amountOut()` here is a faithful simulation.
 */
import { BPS, SCALE, divFloor, mulDiv, powRatio } from "./fixed.ts";

export type WeightedPool = {
  /** Reserve of KUKI, in jetton units. */
  kuki: bigint;
  /** Reserve of the paired token, in jetton units. */
  token: bigint;
  /** Weight of KUKI, integer parts (e.g. 4 for an 80/20 pool). */
  wKuki: bigint;
  /** Weight of the paired token (e.g. 1). */
  wToken: bigint;
  /** Swap fee in basis points (30 = 0.30%). */
  feeBps: bigint;
};

export const FEE_DENOM = BPS;

export function isReady(p: WeightedPool): boolean {
  return p.kuki > 0n && p.token > 0n && p.wKuki > 0n && p.wToken > 0n;
}

/** Effective input after the swap fee. */
export function afterFee(amount: bigint, feeBps: bigint): bigint {
  return mulDiv(amount, FEE_DENOM - feeBps, FEE_DENOM);
}

/**
 * Output for swapping `amountIn` of KUKI (kukiIn = true) or of the paired token.
 * Returns 0 when the input is too small to move the curve by one unit.
 */
export function amountOut(p: WeightedPool, kukiIn: boolean, amountIn: bigint): bigint {
  if (amountIn <= 0n || !isReady(p)) return 0n;

  const reserveIn = kukiIn ? p.kuki : p.token;
  const reserveOut = kukiIn ? p.token : p.kuki;
  const wIn = kukiIn ? p.wKuki : p.wToken;
  const wOut = kukiIn ? p.wToken : p.wKuki;

  const inEff = afterFee(amountIn, p.feeBps);
  if (inEff <= 0n) return 0n;

  // 50/50 (and any balanced pool) is exactly constant-product: skip ln/exp so
  // the most common pool pays the least gas and gets exact integer math.
  const out =
    wIn === wOut
      ? mulDiv(reserveOut, inEff, reserveIn + inEff)
      : mulDiv(
          reserveOut,
          SCALE - powRatio(mulDiv(reserveIn, SCALE, reserveIn + inEff), wIn, wOut),
          SCALE,
        );

  return out >= reserveOut ? reserveOut - 1n : out;
}

/**
 * Input required to receive exactly `amountOut` (kukiIn = direction).
 * Inverse of `amountOut`, used by the arb sizer for the second leg.
 */
export function amountIn(p: WeightedPool, kukiIn: boolean, amountOutWanted: bigint): bigint {
  if (amountOutWanted <= 0n || !isReady(p)) return 0n;

  const reserveIn = kukiIn ? p.kuki : p.token;
  const reserveOut = kukiIn ? p.token : p.kuki;
  const wIn = kukiIn ? p.wKuki : p.wToken;
  const wOut = kukiIn ? p.wToken : p.wKuki;

  if (amountOutWanted >= reserveOut) return reserveIn; // unreachable output

  // ratio = (B_out / (B_out - out)) ^ (w_out / w_in)
  const base = mulDiv(reserveOut, SCALE, reserveOut - amountOutWanted);
  const ratio = powRatio(base, wOut, wIn);
  const inEff = mulDiv(reserveIn, ratio - SCALE, SCALE);
  if (inEff <= 0n) return 0n;

  // gross up for the fee, then nudge until floor rounding actually delivers
  let need = mulDiv(inEff, FEE_DENOM, FEE_DENOM - p.feeBps);
  for (let i = 0; i < 8 && amountOut(p, kukiIn, need) < amountOutWanted; i++) {
    need += 1n;
  }
  return need;
}

/**
 * Price of one token in KUKI (scaled by 1e18): (B_kuki·w_token)/(B_token·w_kuki).
 * For a 50/50 KUKI/TON pool this is directly KUKI per TON.
 */
export function spotPrice(p: WeightedPool): bigint {
  if (!isReady(p)) return 0n;
  return mulDiv(mulDiv(p.kuki, p.wToken, p.wKuki), SCALE, p.token);
}

/** Price of one KUKI in token units (scaled by 1e18). */
export function spotPriceInverse(p: WeightedPool): bigint {
  const s = spotPrice(p);
  return s === 0n ? 0n : mulDiv(SCALE, SCALE, s);
}

/** Apply a swap to the reserves. Fee stays in the pool (accrues to LPs). */
export function applySwap(p: WeightedPool, kukiIn: boolean, amountIn: bigint, amountOut: bigint): WeightedPool {
  return kukiIn
    ? { ...p, kuki: p.kuki + amountIn, token: p.token - amountOut }
    : { ...p, token: p.token + amountIn, kuki: p.kuki - amountOut };
}

/** Value of a deposit expressed in "share units" (homogeneous, weight-aware). */
export function depositValue(p: WeightedPool, kukiAmount: bigint, tokenAmount: bigint): bigint {
  const vKuki = divFloor(mulDiv(kukiAmount, SCALE, p.wKuki), 1n);
  const vToken = divFloor(mulDiv(tokenAmount, SCALE, p.wToken), 1n);
  return vKuki < vToken ? vKuki : vToken;
}

/**
 * Shares minted for a proportional deposit.
 * `totalShares == 0` bootstraps the pool; otherwise the deposit must be within
 * `toleranceBps` of the existing ratio or the result is negative.
 */
export function sharesForDeposit(
  p: WeightedPool,
  totalShares: bigint,
  kukiAmount: bigint,
  tokenAmount: bigint,
  toleranceBps = 50n,
): bigint {
  if (totalShares === 0n) return depositValue(p, kukiAmount, tokenAmount);

  const rKuki = mulDiv(kukiAmount, SCALE, p.kuki);
  const rToken = mulDiv(tokenAmount, SCALE, p.token);
  const diff = rKuki > rToken ? rKuki - rToken : rToken - rKuki;
  const hi = rKuki > rToken ? rKuki : rToken;
  if (mulDiv(diff, BPS, hi) > toleranceBps) return -1n;

  return mulDiv(totalShares, rKuki < rToken ? rKuki : rToken, SCALE);
}

/** Pro-rata withdrawal. */
export function amountsForWithdraw(
  p: WeightedPool,
  totalShares: bigint,
  shares: bigint,
): { kuki: bigint; token: bigint } {
  if (totalShares === 0n) return { kuki: 0n, token: 0n };
  return {
    kuki: mulDiv(p.kuki, shares, totalShares),
    token: mulDiv(p.token, shares, totalShares),
  };
}
