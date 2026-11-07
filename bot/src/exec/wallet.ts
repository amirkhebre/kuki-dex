/** Wallet plumbing: one place that knows how to sign and send. */
import { Address, internal, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4 } from "@ton/ton";

export type BotWallet = {
  address: Address;
  send(to: Address, value: bigint, body: Parameters<typeof internal>[0]["body"], init?: Parameters<typeof internal>[0]["init"]): Promise<void>;
  balance(): Promise<bigint>;
};

export async function openBotWallet(client: TonClient, mnemonic: string[]): Promise<BotWallet> {
  if (mnemonic.length !== 24) throw new Error("KUKI_WALLET_MNEMONIC must be 24 words");
  const key = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
  const contract = client.open(wallet);

  return {
    address: wallet.address,
    async balance() {
      return BigInt(await contract.getBalance());
    },
    async send(to, value, body, init) {
      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: key.secretKey,
        messages: [internal({ to, value, body, init, bounce: true })],
      });
    },
  };
}

export { toNano };
