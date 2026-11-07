/**
 * STON.fi leg execution, through the official SDK.
 *
 * The SDK builds the router message for the deployed router version; we only
 * sign and send it. `getSwapJettonToJettonTxParams` is a pure builder (it reads
 * no chain state), so the bot can use it even while the first leg settles.
 *
 * NOTE: this path has not been exercised against mainnet in this repository.
 * It is guarded by `EXECUTE=1` and should be tested with a small amount first.
 */
import type { Address } from "@ton/core";
import type { TonClient } from "@ton/ton";
import type { StonfiRouterVersion } from "../config.ts";
import type { BotWallet } from "./wallet.ts";

export type StonfiSwapArgs = {
  client: TonClient;
  wallet: BotWallet;
  router: string;
  version: StonfiRouterVersion;
  offerJetton: string;
  askJetton: string;
  amountIn: bigint;
  minOut: bigint;
};

export async function swapOnStonfi(args: StonfiSwapArgs): Promise<void> {
  const { DEX } = await import("@ston-fi/sdk");
  const family = DEX[args.version];
  if (!family) throw new Error(`unsupported STON.fi router version ${args.version}`);

  const router = args.client.open(family.Router.CPI.create(args.router));
  const params = await router.getSwapJettonToJettonTxParams({
    userWalletAddress: args.wallet.address.toString(),
    offerJettonAddress: args.offerJetton,
    askJettonAddress: args.askJetton,
    offerAmount: args.amountIn,
    minAskAmount: args.minOut,
    queryId: BigInt(Date.now() % 1_000_000),
  });

  await args.wallet.send(
    params.to as Address,
    BigInt(params.value),
    params.body,
    (params as { init?: unknown }).init as never,
  );
}
