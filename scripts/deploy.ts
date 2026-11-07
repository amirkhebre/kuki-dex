/**
 * Deploy the factory and one KUKI-quoted pool.
 *
 *   $env:TON_ENDPOINT="https://toncenter.com/api/v2/jsonRPC"
 *   $env:KUKI_WALLET_MNEMONIC="word1 ... word24"
 *   $env:KUKI_JETTON="EQ..."
 *   $env:TON_SIDE="1"            # pool is KUKI + native TON
 *   $env:TOKEN_JETTON="EQ..."    # required only when TON_SIDE=0
 *   $env:WEIGHTS="1,1"
 *   $env:FEE_BPS="30"
 *   $env:ADMIN_ADDRESS="UQ..."   # optional: hand the pool/factory over
 *   $env:DRY_RUN="1"
 *
 * Two things are deliberate:
 *   1. The deployer is the temporary owner; `ADMIN_ADDRESS` receives the pool
 *      admin rights and the factory ownership at the end (relayer flow).
 *   2. Jetton wallets are bound *after* deployment because their addresses
 *      depend on the pool address, which depends on the pool init data.
 */
import { Address, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4, internal, type Sender } from "@ton/ton";

import { existsSync, readFileSync } from "node:fs";
import { PoolFactory } from "../build/kuki-dex_PoolFactory.ts";
import { WeightedPool } from "../build/kuki-dex_WeightedPool.ts";
import { jettonWalletAddress } from "../bot/src/exec/balances.ts";

const ZERO = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

const endpoint = process.env.TON_ENDPOINT ?? "https://toncenter.com/api/v2/jsonRPC";
const apiKey = process.env.TON_API_KEY;
let mnemonic = (process.env.KUKI_WALLET_MNEMONIC ?? "").trim().split(/\s+/).filter(Boolean);
// Relayer flow: the temporary deployer key lives in .relayer.json.
if (mnemonic.length === 0 && existsSync(".relayer.json")) {
  const file = JSON.parse(readFileSync(".relayer.json", "utf8")) as { mnemonic: string[] };
  mnemonic = file.mnemonic;
}
const kuki = process.env.KUKI_JETTON ?? "";
const tonSide = process.env.TON_SIDE === "1" || process.env.TON_SIDE === "true";
const token = tonSide ? ZERO : (process.env.TOKEN_JETTON ?? "");
const adminAddress = (process.env.ADMIN_ADDRESS ?? "").trim();
const refundTo = (process.env.REFUND_TO ?? adminAddress).trim();
const [wKuki, wToken] = (process.env.WEIGHTS ?? "1,1").split(",").map((s) => BigInt(s.trim()));
const feeBps = BigInt(process.env.FEE_BPS ?? "30");
const protocolFeeBps = Number(process.env.PROTOCOL_FEE_BPS ?? "10");
const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

function requireEnv(name: string, value: string) {
  if (!value) throw new Error(`${name} is required`);
}

requireEnv("KUKI_WALLET_MNEMONIC", mnemonic.join(" "));
requireEnv("KUKI_JETTON", kuki);
if (!tonSide) requireEnv("TOKEN_JETTON", token);

const client = new TonClient({ endpoint, apiKey });
const key = await mnemonicToPrivateKey(mnemonic);
const walletContract = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
const wallet = client.open(walletContract);
const owner = walletContract.address;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** toncenter rate-limits keyless clients; retry with backoff instead of dying. */
async function rpc<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { result?: string } }; message?: string };
      const rateLimited =
        e?.response?.status === 429 || String(e?.response?.data?.result ?? e?.message ?? "").includes("Ratelimit");
      if (!rateLimited) throw new Error(`${label}: ${e?.message ?? String(err)}`);
      await delay(3000 * (attempt + 1));
    }
  }
  throw new Error(`${label}: rate limited`);
}

/**
 * A fresh wallet has a balance but no code. `sendExternalMessage` attaches the
 * wallet's StateInit when the account is not deployed, which is exactly what a
 * relayer needs. We track seqno locally because the first send deploys it.
 */
let seqno: number | null = null;
async function nextSeqno(): Promise<number> {
  if (seqno === null) {
    seqno = (await rpc("deployed?", () => client.isContractDeployed(owner))) ? await rpc("seqno", () => wallet.getSeqno()) : 0;
  }
  const current = seqno;
  seqno += 1;
  return current;
}

const sender: Sender = {
  async send(args) {
    const transfer = walletContract.createTransfer({
      seqno: await nextSeqno(),
      secretKey: key.secretKey,
      messages: [
        internal({
          to: args.to,
          value: args.value,
          body: args.body,
          bounce: args.bounce,
          init: args.init,
        }),
      ],
    });
    await rpc("send", () => client.sendExternalMessage(walletContract, transfer));
  },
};

console.log(`endpoint : ${endpoint}`);
console.log(`deployer : ${owner.toString()}`);
console.log(`KUKI     : ${kuki}`);
console.log(`pair     : ${tonSide ? "native TON" : token}`);
console.log(`weights  : ${wKuki}:${wToken}, LP fee ${feeBps} bps, protocol ${protocolFeeBps} bps`);
console.log(`handover : ${adminAddress || "(none)"}`);
console.log(`mode     : ${dryRun ? "DRY RUN" : "LIVE"}`);

const factory = client.open(await PoolFactory.fromInit(owner, Address.parse(kuki)));
const pool = await WeightedPool.fromInit(
  factory.address,
  owner,
  Address.parse(kuki),
  Address.parse(token),
  wKuki,
  wToken,
  feeBps,
  tonSide,
);

console.log(`factory  : ${factory.address.toString()}`);
console.log(`pool     : ${pool.address.toString()}`);

const kukiWallet = await rpc("kuki wallet", () => jettonWalletAddress(client, kuki, pool.address));
const tokenWallet = tonSide ? null : await rpc("token wallet", () => jettonWalletAddress(client, token, pool.address));
console.log(`pool KUKI wallet : ${kukiWallet.toString()}`);
console.log(`pool token wallet: ${tokenWallet ? tokenWallet.toString() : "(native TON)"}`);

if (dryRun) {
  console.log("\nDRY_RUN=1 — nothing was sent.");
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\n1/5 deploying factory…");
await factory.send(sender, { value: toNano("0.05") }, null);
await sleep(5000);

console.log("2/5 creating pool…");
await factory.send(
  sender,
  { value: toNano("0.2") },
  { $$type: "CreatePool", token: Address.parse(token), wKuki, wToken, feeBps, tonSide },
);
await sleep(7000);

const openedPool = client.open(pool);
console.log("3/5 binding the KUKI jetton wallet…");
await openedPool.send(sender, { value: toNano("0.03") }, { $$type: "BindWallet", index: 0n, wallet: kukiWallet });
await sleep(5000);

if (tokenWallet) {
  console.log("   binding the token jetton wallet…");
  await openedPool.send(sender, { value: toNano("0.03") }, { $$type: "BindWallet", index: 1n, wallet: tokenWallet });
  await sleep(5000);
}

console.log(`4/5 setting protocol fee to ${protocolFeeBps} bps (paid to the admin)…`);
await openedPool.send(sender, { value: toNano("0.02") }, { $$type: "SetProtocolFee", feeBps: BigInt(protocolFeeBps) });
await sleep(5000);

if (adminAddress) {
  console.log("5/5 handing ownership to ADMIN_ADDRESS…");
  await openedPool.send(
    sender,
    { value: toNano("0.02") },
    { $$type: "SetAdmin", newAdmin: Address.parse(adminAddress) },
  );
  await sleep(5000);
  await factory.send(
    sender,
    { value: toNano("0.02") },
    { $$type: "ChangeOwner", newOwner: Address.parse(adminAddress) },
  );
  await sleep(5000);
}

const state = await rpc("pool state", () => openedPool.getGetPoolState());
console.log("\ndone.");
console.log(`factory: ${factory.address.toString()}`);
console.log(`pool   : ${pool.address.toString()}`);
console.log(`ready  : ${state.ready}`);
console.log(`reserves: ${state.reserveKuki} KUKI / ${state.reserveToken} ${tonSide ? "nanoTON" : "token"}`);
if (adminAddress) {
  console.log(`admin  : ${(await rpc("admin", () => openedPool.getGetAdmin())).toString()}`);
}
console.log(`fees   : protocol ${(await rpc("fees", () => openedPool.getGetFees())).protocolFeeBps} bps -> admin`);

// Return the relayer's leftover TON so it keeps no budget after deployment.
if (refundTo) {
  try {
    const balance = await wallet.getBalance();
    const keep = toNano("0.02");
    if (balance > keep + toNano("0.01")) {
      await sender.send({ to: Address.parse(refundTo), value: balance - keep, body: null, bounce: true });
      console.log(`refund : ${Number(balance - keep) / 1e9} TON -> ${refundTo}`);
    }
  } catch (err) {
    console.log(`refund skipped: ${(err as Error).message}`);
  }
}

console.log("\nPut this in .env:");
console.log(`KUKI_POOL=${pool.address.toString()}`);
console.log(`STONFI_POOL=EQCjsEs7maKN4R-f7Hbit7Ds7Ua5KBdUsaEKG7Dv6RyqTPGv`);
