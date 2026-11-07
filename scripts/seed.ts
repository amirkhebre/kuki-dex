/**
 * Seed a KUKI pool with its first (or additional) liquidity.
 *
 * The pool takes liquidity in two legs paired by `nonce`:
 *   - jetton pool: KUKI transfer + token transfer
 *   - native-TON pool: KUKI transfer + a TON message
 *
 *   $env:KUKI_POOL="EQ..."
 *   $env:TON_SIDE="1"             # native TON pool
 *   $env:KUKI_AMOUNT="1000"       # human units
 *   $env:TOKEN_AMOUNT="0.5"       # TON amount when TON_SIDE=1
 *   $env:KUKI_WALLET_MNEMONIC="..."
 *   $env:EXECUTE="1"
 *   node --env-file=.env dist/scripts/seed.js
 */
import { existsSync, readFileSync } from "node:fs";
import { Address, beginCell, type Cell, toNano } from "@ton/core";import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4, internal, type Sender } from "@ton/ton";

import { SCALE, mulDiv } from "../bot/src/math/fixed.ts";
import { jettonWalletAddress } from "../bot/src/exec/balances.ts";

const endpoint = process.env.TON_ENDPOINT ?? "https://toncenter.com/api/v2/jsonRPC";
const apiKey = process.env.TON_API_KEY;
const mnemonic = (process.env.KUKI_WALLET_MNEMONIC ?? "").trim().split(/\s+/).filter(Boolean);
const poolAddr = process.env.KUKI_POOL ?? "";
const kuki = process.env.KUKI_JETTON ?? "";
const tonSide = process.env.TON_SIDE === "1" || process.env.TON_SIDE === "true";
const token = tonSide ? "" : (process.env.TOKEN_JETTON ?? "");
const kukiAmount = BigInt(Math.round(Number(process.env.KUKI_AMOUNT ?? "0") * 1e9));
const secondAmount = BigInt(Math.round(Number(process.env.TOKEN_AMOUNT ?? "0") * 1e9));
const execute = process.env.EXECUTE === "1";

let words = mnemonic;
if (words.length !== 24 && existsSync(".relayer.json")) {
  words = (JSON.parse(readFileSync(".relayer.json", "utf8")) as { mnemonic: string[] }).mnemonic;
}

if (words.length !== 24) throw new Error("KUKI_WALLET_MNEMONIC (24 words) is required");
if (!poolAddr || !kuki) throw new Error("KUKI_POOL and KUKI_JETTON are required");
if (!tonSide && !token) throw new Error("TOKEN_JETTON is required for a jetton pool");
if (kukiAmount <= 0n || secondAmount <= 0n) throw new Error("KUKI_AMOUNT and TOKEN_AMOUNT are required");

const client = new TonClient({ endpoint, apiKey });
const key = await mnemonicToPrivateKey(words);
const walletContract = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
const wallet = client.open(walletContract);
const owner = walletContract.address;
let seqno: number | null = null;

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

const sender: Sender = {
  async send(args) {
    if (seqno === null) {
      seqno = (await rpc("deployed?", () => client.isContractDeployed(owner))) ? await rpc("seqno", () => wallet.getSeqno()) : 0;
    }
    const transfer = walletContract.createTransfer({
      seqno: seqno,
      secretKey: key.secretKey,
      messages: [internal({ to: args.to, value: args.value, body: args.body, bounce: args.bounce, init: args.init })],
    });
    seqno += 1;
    await rpc("send", () => client.sendExternalMessage(walletContract, transfer));
  },
};

const pool = Address.parse(poolAddr);
const state = await rpc("pool state", () => client.runMethod(pool, "getPoolState"));
const reserveKuki = state.stack.readBigNumber();
const reserveSecond = state.stack.readBigNumber();
const wKuki = state.stack.readBigNumber();
const wToken = state.stack.readBigNumber();
state.stack.readBigNumber(); // fee
const totalShares = state.stack.readBigNumber();

const expected =
  totalShares === 0n
    ? minBig(mulDiv(kukiAmount, SCALE, wKuki), mulDiv(secondAmount, SCALE, wToken))
    : minBig(
        mulDiv(totalShares, mulDiv(kukiAmount, SCALE, reserveKuki), SCALE),
        mulDiv(totalShares, mulDiv(secondAmount, SCALE, reserveSecond), SCALE),
      );
const minShares = (expected * 99n) / 100n;

console.log(`pool        : ${pool.toString()}`);
console.log(`deposit     : ${Number(kukiAmount) / 1e9} KUKI + ${Number(secondAmount) / 1e9} ${tonSide ? "TON" : "token"}`);
console.log(`expected LP : ${expected.toString()} (min ${minShares.toString()})`);
console.log(`mode        : ${execute ? "LIVE" : "dry run (EXECUTE=1 to send)"}`);
if (!execute) process.exit(0);

const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const nonce = BigInt(Date.now()) % 1_000_000_000n;
const beneficiary = Address.parse(process.env.BENEFICIARY ?? owner.toString());

function jettonLiquidityPayload(assetIdx: bigint): Cell {
  return beginCell()
    .storeUint(0x4b554b02, 32)
    .storeUint(nonce, 64)
    .storeUint(assetIdx, 8)
    .storeCoins(minShares)
    .storeUint(deadline, 32)
    .storeAddress(beneficiary)
    .endCell();
}

function tonLiquidityBody(): Cell {
  return beginCell()
    .storeUint(0x4b554b0c, 32)
    .storeUint(nonce, 64)
    .storeCoins(minShares)
    .storeUint(deadline, 32)
    .storeAddress(beneficiary)
    .endCell();
}

function transferBody(to: Address, amount: bigint, forward: Cell) {
  return beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(nonce, 64)
    .storeCoins(amount)
    .storeAddress(to)
    .storeAddress(owner)
    .storeUint(0, 1)
    .storeCoins(toNano("0.06"))
    .storeBit(true)
    .storeRef(forward)
    .endCell();
}

const kukiWallet = await rpc("kuki wallet", () => jettonWalletAddress(client, kuki, owner));

console.log("sending KUKI leg…");
await sender.send({ to: kukiWallet, value: toNano("0.12"), body: transferBody(pool, kukiAmount, jettonLiquidityPayload(0n)), bounce: true });
await sleep(6000);

if (tonSide) {
  console.log("sending TON leg…");
  await sender.send({ to: pool, value: secondAmount + toNano("0.05"), body: tonLiquidityBody(), bounce: true });
} else {
  console.log("sending token leg…");
  const tokenWallet = await jettonWalletAddress(client, token, owner);
  await sender.send({ to: tokenWallet, value: toNano("0.12"), body: transferBody(pool, secondAmount, jettonLiquidityPayload(1n)), bounce: true });
}
await sleep(8000);

const after = await rpc("final state", () => client.runMethod(pool, "getPoolState"));
console.log("done.");
console.log(`reserves: ${after.stack.readBigNumber()} KUKI / ${after.stack.readBigNumber()} ${tonSide ? "nanoTON" : "token"}`);

function minBig(a: bigint, b: bigint) {
  return a < b ? a : b;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
