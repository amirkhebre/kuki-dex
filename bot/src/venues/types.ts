/** A venue is one pool we can trade against, normalised to KUKI / token. */
import type { WeightedPool } from "../math/weighted.ts";

export type VenueId = "stonfi" | "kuki";

export type Venue = {
  id: VenueId;
  /** Pool contract address. */
  address: string;
  /** Human label for logs. */
  label: string;
  /** Normalised reserves and weights. */
  pool: WeightedPool;
};

export type StonfiPoolJson = {
  pool: {
    address: string;
    reserve0: string;
    reserve1: string;
    token0_address: string;
    token1_address: string;
    lp_fee: number | string;
    protocol_fee: number | string;
    router_address: string;
  };
};
