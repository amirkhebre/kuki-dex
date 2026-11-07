/** Runtime configuration for the KUKI arbitrage bot. */
import { Address } from "@ton/core";

export type StonfiRouterVersion = "v2_1" | "v2_2";

export type BotConfig = {
  /** KUKI jetton master. */
  kukiJetton: string;
  /** KUKI DEX pool (KUKI/token) address. Empty until the pool is deployed. */
  kukiPool: string;
  /** STON.fi pool for the same pair. */
  stonfiPool: string;
  /** Router that executes the STON.fi leg. */
  stonfiRouter: string;
  stonfiRouterVersion: StonfiRouterVersion;
  /** TON HTTP API used to read the KUKI pool and send transactions. */
  endpoint: string;
  apiKey?: string;
  /** Execute for real. Without this the bot only logs opportunities. */
  execute: boolean;
  walletMnemonic?: string[];
  /** Minimum net profit, in TON, before a trade is considered. */
  minProfitTon: number;
  /** Hard cap on the KUKI side of one trade, in TON of value. */
  maxTradeTon: number;
  /** Gas budget for both legs, in TON. */
  gasPerTradeTon: number;
  /** Poll interval. */
  intervalMs: number;
  /** Slippage tolerance for each leg, in basis points. */
  slippageBps: number;
  /** Minimum realised edge (profit / size) in bps. */
  minEdgeBps: number;
  /** Never use more than this share of the buy pool's KUKI reserve (bps). */
  maxPoolShareBps: number;
  /** Minimum time between two trades. */
  cooldownMs: number;
  /** Stop trading after this many consecutive failures. */
  maxConsecutiveFailures: number;
  /** Where trading profit is swept. Empty = keep it in the bot wallet. */
  sweepTo: string;
  /** Keep at least this much TON in the bot wallet for gas. */
  sweepMinTon: number;
  /** Public status endpoint (the DEX worker). */
  statusUrl: string;
  /** Shared secret for the status endpoint. */
  statusKey: string;
};

const DEFAULTS = {
  kukiJetton: "EQCK1R0hqLuqG3XuG_CR_flKuZZuOxryCrAL3bH44Dq9RUa3",
  stonfiPool: "EQCjsEs7maKN4R-f7Hbit7Ds7Ua5KBdUsaEKG7Dv6RyqTPGv",
  stonfiRouter: "EQCiypoBWNIEPlarBp04UePyEj5zH0ZDHxuRNqJ1WQx3FCY-",
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const mnemonic = env.KUKI_WALLET_MNEMONIC?.trim();
  return {
    kukiJetton: env.KUKI_JETTON ?? DEFAULTS.kukiJetton,
    kukiPool: env.KUKI_POOL ?? "",
    stonfiPool: env.STONFI_POOL ?? DEFAULTS.stonfiPool,
    stonfiRouter: env.STONFI_ROUTER ?? DEFAULTS.stonfiRouter,
    stonfiRouterVersion: (env.STONFI_ROUTER_VERSION as StonfiRouterVersion) ?? "v2_1",
    endpoint: env.TON_ENDPOINT ?? DEFAULTS.endpoint,
    apiKey: env.TON_API_KEY,
    execute: env.EXECUTE === "1" || env.EXECUTE === "true",
    walletMnemonic: mnemonic ? mnemonic.split(/\s+/) : undefined,
    // Any strictly positive net edge is worth taking; gas is already subtracted.
    minProfitTon: Number(env.MIN_PROFIT_TON ?? "0"),
    maxTradeTon: Number(env.MAX_TRADE_TON ?? "5"),
    gasPerTradeTon: Number(env.GAS_PER_TRADE_TON ?? "0.45"),
    intervalMs: Number(env.INTERVAL_MS ?? "8000"),
    slippageBps: Number(env.SLIPPAGE_BPS ?? "50"),
    minEdgeBps: Number(env.MIN_EDGE_BPS ?? "0"),
    maxPoolShareBps: Number(env.MAX_POOL_SHARE_BPS ?? "2000"),
    cooldownMs: Number(env.COOLDOWN_MS ?? "20000"),
    maxConsecutiveFailures: Number(env.MAX_FAILURES ?? "3"),
    sweepTo: (env.SWEEP_TO ?? "").trim(),
    sweepMinTon: Number(env.SWEEP_MIN_TON ?? "0.1"),
    statusUrl: (env.STATUS_URL ?? "").trim().replace(/\/$/, ""),
    statusKey: (env.STATUS_KEY ?? "").trim(),
  };
}

/** TON addresses arrive in EQ…/UQ…/kQ…/0Q… forms; compare raw form. */
export function sameAddress(a: string, b: string): boolean {
  try {
    return Address.parse(a).toRawString() === Address.parse(b).toRawString();
  } catch {
    return a === b;
  }
}

export function toTon(raw: bigint): number {
  return Number(raw) / 1e9;
}
