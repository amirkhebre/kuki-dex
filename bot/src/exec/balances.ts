/** Small helpers to read jetton balances through a TON HTTP API. */
import { Address, beginCell } from "@ton/core";
import type { TonClient } from "@ton/ton";

export async function jettonWalletAddress(client: TonClient, master: string, owner: Address): Promise<Address> {
  const res = await client.runMethod(Address.parse(master), "get_wallet_address", [
    { type: "slice", cell: beginCell().storeAddress(owner).endCell() },
  ]);
  return res.stack.readAddress();
}

export async function jettonBalance(client: TonClient, master: string, owner: Address): Promise<bigint> {
  const wallet = await jettonWalletAddress(client, master, owner);
  const res = await client.runMethod(wallet, "get_wallet_data");
  return res.stack.readBigNumber();
}

export async function waitForBalance(
  client: TonClient,
  master: string,
  owner: Address,
  predicate: (balance: bigint) => boolean,
  timeoutMs = 60_000,
  pollMs = 3_000,
): Promise<bigint> {
  const started = Date.now();
  let last = 0n;
  while (Date.now() - started < timeoutMs) {
    last = await jettonBalance(client, master, owner);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return last;
}
