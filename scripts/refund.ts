/**
 * Return the relayer's TON balance to the owner wallet.
 *
 *   $env:REFUND_TO="UQ..."   # defaults to ADMIN_ADDRESS
 *   node dist/scripts/refund.js
 *
 * Keeps a small gas buffer so the message can be paid for.
 */
import { existsSync, readFileSync } from "node:fs";
import { Address, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4, internal } from "@ton/ton";

const endpoint = process.env.TON_ENDPOINT ?? "https://toncenter.com/api/v2/jsonRPC";
const apiKey = process.env.TON_API_KEY;
const to = (process.env.REFUND_TO ?? process.env.ADMIN_ADDRESS ?? "").trim();

if (!to) throw new Error("REFUND_TO is required");
if (!existsSync(".relayer.json")) throw new Error(".relayer.json not found");

const file = JSON.parse(readFileSync(".relayer.json", "utf8")) as { mnemonic: string[] };
const key = await mnemonicToPrivateKey(file.mnemonic);
const walletContract = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
const client = new TonClient({ endpoint, apiKey });

async function rpc<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { result?: string } }; message?: string };
      const rateLimited =
        e?.response?.status === 429 || String(e?.response?.data?.result ?? e?.message ?? "").includes("Ratelimit");
      if (!rateLimited) throw new Error(`${label}: ${e?.message ?? String(err)}`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw new Error(`${label}: rate limited`);
}

const balance = await rpc("balance", () => client.getBalance(walletContract.address));

const keep = toNano("0.015");
if (balance <= keep + toNano("0.01")) {
  console.log(`nothing to refund: balance ${Number(balance) / 1e9} TON`);
  process.exit(0);
}

const seqno = await rpc("seqno", () => client.open(walletContract).getSeqno());
const value = balance - keep;
const transfer = walletContract.createTransfer({
  seqno,
  secretKey: key.secretKey,
  messages: [internal({ to: Address.parse(to), value, body: null, bounce: true })],
});

console.log(`relayer : ${walletContract.address.toString()}`);
console.log(`balance : ${Number(balance) / 1e9} TON`);
console.log(`refund  : ${Number(value) / 1e9} TON -> ${to}`);

for (let attempt = 0; attempt < 6; attempt++) {
  try {
    await client.sendExternalMessage(walletContract, transfer);
    break;
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: { result?: string } }; message?: string };
    const rateLimited =
      e?.response?.status === 429 || String(e?.response?.data?.result ?? e?.message ?? "").includes("Ratelimit");
    if (!rateLimited) throw err;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
}

console.log("sent.");
