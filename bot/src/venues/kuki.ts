/**
 * KUKI DEX venue.
 *
 * The pool is a Tact contract with a `getPoolState` getter:
 *   (reserveKuki, reserveToken, wKuki, wToken, feeBps, totalShares, paused, ready)
 *
 * The bot reads it through a TON HTTP API (toncenter by default). The same
 * client is later used to send the swap messages.
 */
import { Address, TupleReader, beginCell } from "@ton/core";
import { TonClient } from "@ton/ton";
import type { WeightedPool } from "../math/weighted.ts";
import type { Venue } from "./types.ts";

export class KukiError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** Pure decoder, split out so it can be tested without a network. */
export function parseKukiState(stack: TupleReader): WeightedPool & { totalShares: bigint; paused: boolean; ready: boolean } {
  const reserveKuki = stack.readBigNumber();
  const reserveToken = stack.readBigNumber();
  const wKuki = stack.readBigNumber();
  const wToken = stack.readBigNumber();
  const feeBps = stack.readBigNumber();
  const totalShares = stack.readBigNumber();
  const paused = stack.readBoolean();
  const ready = stack.readBoolean();

  if (!ready) throw new KukiError("pool wallets are not bound yet", "not_ready");
  if (paused) throw new KukiError("pool is paused", "paused");
  // An empty pool is valid (bootstrapping): the bot simply reports "no edge".

  return { kuki: reserveKuki, token: reserveToken, wKuki, wToken, feeBps, totalShares, paused, ready };
}

export class KukiVenueReader {
  readonly client: TonClient;

  constructor(
    readonly address: string,
    readonly kuki: string,
    endpoint: string,
    apiKey?: string,
  ) {
    this.client = new TonClient({ endpoint, apiKey });
  }

  async read(): Promise<Venue> {
    const address = Address.parse(this.address);
    const [res, feesRes] = await Promise.all([
      this.client.runMethod(address, "getPoolState"),
      this.client.runMethod(address, "getFees"),
    ]);
    const state = parseKukiState(res.stack);
    // getFees -> (pendingKuki, pendingToken, protocolFeeBps, recipient)
    feesRes.stack.readBigNumber();
    feesRes.stack.readBigNumber();
    const protocolFeeBps = feesRes.stack.readBigNumber();
    return {
      id: "kuki",
      address: address.toString(),
      label: "KUKI DEX",
      pool: {
        kuki: state.kuki,
        token: state.token,
        wKuki: state.wKuki,
        wToken: state.wToken,
        // The protocol cut is taken from the input as well, so the bot sizes
        // with the combined fee. Execution always uses the pool's own quote.
        feeBps: state.feeBps + protocolFeeBps,
      },
    };
  }

  /** Address of `owner`'s jetton wallet for the KUKI jetton. */
  async jettonWallet(owner: string): Promise<Address> {
    const res = await this.client.runMethod(Address.parse(this.kuki), "get_wallet_address", [
      { type: "slice", cell: beginAddressCell(owner) },
    ]);
    return res.stack.readAddress();
  }
}

function beginAddressCell(owner: string) {
  return beginCell().storeAddress(Address.parse(owner)).endCell();
}
