/** Wire formats shared by the executor and the tests. */
import { Address, beginCell, Cell } from "@ton/core";

export const OP_KUKI_SWAP = 0x4b554b01;
export const OP_JETTON_TRANSFER = 0x0f8a7ea5;

/**
 * Forward payload for a KUKI pool swap. It is sent as the *content* of the
 * jetton transfer's `Either Cell ^Cell` forward payload, i.e. no extra selector
 * bit here — the wallet adds that.
 */
export function kukiSwapPayload(args: {
  assetIn: bigint;
  minOut: bigint;
  receiver: Address;
  deadline: number;
}): Cell {
  return beginCell()
    .storeUint(OP_KUKI_SWAP, 32)
    .storeUint(args.assetIn, 8)
    .storeCoins(args.minOut)
    .storeAddress(args.receiver)
    .storeUint(args.deadline, 32)
    .endCell();
}

export function jettonTransferBody(args: {
  queryId?: bigint;
  amount: bigint;
  destination: Address;
  responseDestination: Address;
  forwardTonAmount: bigint;
  forwardPayload: Cell;
}): Cell {
  return beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(args.queryId ?? 0n, 64)
    .storeCoins(args.amount)
    .storeAddress(args.destination)
    .storeAddress(args.responseDestination)
    .storeUint(0, 1) // no custom payload
    .storeCoins(args.forwardTonAmount)
    .storeBit(true)
    .storeRef(args.forwardPayload)
    .endCell();
}
