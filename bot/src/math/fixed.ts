/**
 * Fixed-point math for the KUKI weighted pools.
 *
 * Everything is an integer scaled by 1e18 (`SCALE`). The exact same algorithms
 * are implemented in `contracts/KukiDex.tact`; the TypeScript version is the
 * reference the contracts are tested against and the one the arbitrage bot uses
 * to price trades before sending them on-chain.
 *
 * Why ln/exp and not `x ** (p/q)`?
 * Osmosis-classic pools allow arbitrary weights (80/20, 75/25, ...). The swap
 * formula needs `t ** (wIn / wOut)` for a fractional exponent, and TVM has no
 * floats. We compute it as `exp(ln(t) * wIn / wOut)` with 18 decimals, which is
 * precise to ~1e-9 relative — far below the smallest jetton unit in practice.
 */

export const SCALE = 10n ** 18n;
export const BPS = 10_000n;

/** ln(2) scaled by 1e18. */
export const LN2 = 693_147_180_559_945_309n;

/** Floor division that also works for negative numerators. */
export function divFloor(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("division by zero");
  const q = a / b;
  if (a % b !== 0n && (a < 0n) !== (b < 0n)) return q - 1n;
  return q;
}

export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error("division by zero");
  return divFloor(a * b, c);
}

/**
 * Natural logarithm of `x / SCALE`, returned scaled by `SCALE`.
 * Domain: 0 < x <= SCALE. Returns 0 for x == SCALE.
 */
export function ln(x: bigint): bigint {
  if (x <= 0n) throw new Error("ln domain");
  if (x === SCALE) return 0n;

  // Normalise m = x * 2^k into [SCALE, 2 * SCALE).
  let k = 0n;
  let m = x;
  while (m < SCALE) {
    m <<= 1n;
    k += 1n;
  }

  // ln(m) = 2 * atanh((m-1)/(m+1)), z in [0, 1/3].
  const z = mulDiv(m - SCALE, SCALE, m + SCALE);
  const z2 = mulDiv(z, z, SCALE);

  let term = z;
  let sum = z;
  for (let i = 1n; i <= 12n; i++) {
    term = mulDiv(term, z2, SCALE);
    sum += divFloor(term, 2n * i + 1n);
  }

  return 2n * sum - k * LN2;
}

/**
 * e ** (y / SCALE) scaled by `SCALE`.
 * Supports negative and (moderate) positive exponents; the pool itself only
 * ever passes non-positive ones, while `amountIn()` needs the positive branch.
 */
export function exp(y: bigint): bigint {
  if (y === 0n) return SCALE;

  const negative = y < 0n;
  const a = negative ? -y : y;
  const n = a / LN2; // floor(|y| / ln2)
  const r = a - n * LN2; // [0, ln2)

  // exp(±r) with an alternating Taylor series; 20 terms is < 1e-18 error.
  // For +r every term is positive; for -r the signs alternate.
  let term = SCALE;
  let sum = SCALE;
  let sign = negative ? -1n : 1n;
  for (let i = 1n; i <= 20n; i++) {
    term = divFloor(mulDiv(term, r, SCALE), i);
    sum += sign * term;
    if (negative) sign = -sign;
  }

  // exp(y) = 2^±n * exp(±r). Below 1e-18 rounds to zero; above ~1e36 would
  // overflow the 257-bit TVM integer, so clamp instead of wrapping.
  if (n > 60n) return negative ? 0n : (1n << 255n) - 1n;
  return negative ? sum >> n : sum << n;
}

/** `t ** (num / den)` for t in (0, SCALE], returned scaled by SCALE. */
export function powRatio(t: bigint, num: bigint, den: bigint): bigint {
  if (num === 0n) return SCALE;
  if (t <= 0n) return 0n;
  if (t >= SCALE && num === den) return SCALE;
  const l = ln(t);
  const e = divFloor(l * num, den);
  return exp(e);
}

/** Integer square root (Newton), matches Tact's `sqrt` for positive inputs. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt domain");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Format a 1e18-scaled integer as a human string (for logs). */
export function fmt(x: bigint, decimals = 6): string {
  const neg = x < 0n;
  const v = neg ? -x : x;
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(18, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}${decimals > 0 ? "." + frac : ""}`;
}
