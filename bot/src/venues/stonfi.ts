/**
 * STON.fi venue.
 *
 * Reserves come from the public API (the same endpoint the KUKI mini-app
 * already uses). STON.fi v2 pools are constant-product, so they are just
 * weighted pools with equal weights.
 *
 * Fee accounting: `lp_fee + protocol_fee` are basis points in the API response
 * (20 + 10 = 0.30%). The bot verifies the sum is sane (0…200) before trading.
 */
import { BPS } from "../math/fixed.ts";
import type { WeightedPool } from "../math/weighted.ts";
import { sameAddress } from "../config.ts";
import type { StonfiPoolJson, Venue } from "./types.ts";

export const STONFI_API = "https://api.ston.fi/v1";

export class StonfiError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** Pure parser, unit-tested against a recorded API response. */
export function parseStonfiPool(json: StonfiPoolJson, kuki: string, address: string): Venue {
  const p = json.pool;
  if (!p) throw new StonfiError("missing pool object", "shape");

  const kukiIs0 = sameAddress(p.token0_address, kuki);
  const kukiIs1 = sameAddress(p.token1_address, kuki);
  if (!kukiIs0 && !kukiIs1) throw new StonfiError("KUKI is not in this pool", "not_kuki_pair");

  // The API returns these as strings or numbers depending on the endpoint
  // version; Number() first or "20" + "10" silently becomes 2010.
  const feeBps = BigInt(Number(p.lp_fee ?? 0) + Number(p.protocol_fee ?? 0));
  if (feeBps < 0n || feeBps > 200n) throw new StonfiError(`unexpected fee ${feeBps}`, "fee");

  const pool: WeightedPool = {
    kuki: BigInt(kukiIs0 ? p.reserve0 : p.reserve1),
    token: BigInt(kukiIs0 ? p.reserve1 : p.reserve0),
    wKuki: 1n,
    wToken: 1n,
    feeBps: feeBps > 0n ? feeBps : 30n,
  };

  if (pool.kuki <= 0n || pool.token <= 0n) throw new StonfiError("empty pool", "empty");

  return {
    id: "stonfi",
    address: p.address ?? address,
    label: "STON.fi",
    pool,
  };
}

export async function fetchStonfiPool(
  address: string,
  kuki: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Venue> {
  const url = `${STONFI_API}/pools/${encodeURIComponent(address)}`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new StonfiError(`STON.fi HTTP ${res.status}`, `http_${res.status}`);
  const json = (await res.json()) as StonfiPoolJson;
  return parseStonfiPool(json, kuki, address);
}

/**
 * Simulate a STON.fi swap locally. The API returns the same curve; doing it
 * locally keeps the hot loop fast and lets the sizer evaluate hundreds of
 * candidate sizes per tick.
 */
export function stonfiQuote(venue: Venue, kukiIn: boolean, amountIn: bigint): bigint {
  const p = venue.pool;
  const inEff = (amountIn * (BPS - p.feeBps)) / BPS;
  if (inEff <= 0n) return 0n;
  const rIn = kukiIn ? p.kuki : p.token;
  const rOut = kukiIn ? p.token : p.kuki;
  return (rOut * inEff) / (rIn + inEff);
}
