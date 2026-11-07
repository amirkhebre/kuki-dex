/**
 * KUKI DEX leg execution.
 *
 * One jetton transfer to the pool's KUKI wallet, with a swap intent in the
 * forward payload. The pool refunds the input if the trade would violate
 * `minOut` — so the bot never loses the input to slippage, only gas.
 */
import { Address, toNano } from "@ton/core";
import type { KukiVenueReader } from "../venues/kuki.ts";
import type { BotWallet } from "./wallet.ts";
import { jettonTransferBody, kukiSwapPayload } from "./messages.ts";
import { jettonWalletAddress } from "./balances.ts";

export type KukiSwapArgs = {
  reader: KukiVenueReader;
  wallet: BotWallet;
  pool: string;
  /** Jetton master of the input asset (KUKI or the paired token). */
  offerJetton: string;
  /** 0 = KUKI in, 1 = token in. */
  assetIn: 0 | 1;
  amountIn: bigint;
  minOut: bigint;
  /** Unix seconds. */
  deadline: number;
  forwardTon?: bigint;
};

export async function swapOnKuki(args: KukiSwapArgs): Promise<{ jettonWallet: Address }> {
  const { reader, wallet, pool, offerJetton, assetIn, amountIn, minOut, deadline } = args;
  // The input is sent from the wallet of *that* jetton, not always KUKI.
  const jettonWallet = await jettonWalletAddress(reader.client, offerJetton, wallet.address);

  const payload = kukiSwapPayload({
    assetIn: BigInt(assetIn),
    minOut,
    receiver: wallet.address,
    deadline,
  });

  const body = jettonTransferBody({
    amount: amountIn,
    destination: Address.parse(pool),
    responseDestination: wallet.address,
    forwardTonAmount: args.forwardTon ?? toNano("0.08"),
    forwardPayload: payload,
  });

  await wallet.send(jettonWallet, toNano("0.18"), body);
  return { jettonWallet };
}
