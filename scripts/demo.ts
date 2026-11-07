/**
 * End-to-end demo on a local TVM chain (no real funds).
 *
 *   node dist/scripts/demo.js
 *
 * It deploys the real factory + two real pools, seeds liquidity, shows the
 * protorev-style guard rejecting a thin edge, then executes a profitable round
 * trip (KUKI -> token on the cheap pool, token -> KUKI on the dear one) and
 * prints the P&L measured from on-chain balances.
 *
 * The two KUKI pools stand in for "STON.fi" and "KUKI DEX": the point is the
 * contracts, the math and the guard, not the venue adapters (which need network).
 */
import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, beginCell, Cell, toNano } from "@ton/core";

import { PoolFactory } from "../build/kuki-dex_PoolFactory.ts";
import { WeightedPool } from "../build/kuki-dex_WeightedPool.ts";
import { TestJettonMinter } from "../build/kuki-dex-test_TestJettonMinter.ts";
import { TestJettonWallet } from "../build/kuki-dex-test_TestJettonWallet.ts";
import { spotPrice, type WeightedPool as PoolMath } from "../bot/src/math/weighted.ts";
import { findBestArb } from "../bot/src/strategy/arb.ts";
import { checkPlan, leg2Floor, type GuardState } from "../bot/src/strategy/guard.ts";
import type { Venue } from "../bot/src/venues/types.ts";
import { OP_KUKI_SWAP } from "../bot/src/exec/messages.ts";

const K = 10n ** 9n;
const T0 = 1_800_000_000;
/** 0.45 TON at ~10,333 KUKI/TON, the real ratio of the live pool. */
const GAS_KUKI = 5_000n * K;

const tok = (x: bigint, dp = 2) => Number((Number(x) / 1e9).toFixed(dp));

function swapPayload(assetIn: bigint, minOut: bigint, receiver: Address, deadline: bigint): Cell {
  return beginCell()
    .storeUint(OP_KUKI_SWAP, 32)
    .storeUint(assetIn, 8)
    .storeCoins(minOut)
    .storeAddress(receiver)
    .storeUint(deadline, 32)
    .endCell();
}

function liqPayload(nonce: bigint, assetIdx: bigint, deadline: bigint): Cell {
  return beginCell()
    .storeUint(0x4b554b02, 32)
    .storeUint(nonce, 64)
    .storeUint(assetIdx, 8)
    .storeCoins(0n)
    .storeUint(deadline, 32)
    .storeAddress(Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"))
    .endCell();
}

async function jetton(
  chain: Blockchain,
  deployer: SandboxContract<TreasuryContract>,
  id: bigint,
): Promise<{ minter: SandboxContract<TestJettonMinter>; mint: (to: Address, amount: bigint) => Promise<void> }> {
  const minter = chain.openContract(await TestJettonMinter.fromInit(deployer.address, id));
  await minter.send(deployer.getSender(), { value: toNano("0.05") }, null);
  return {
    minter,
    mint: async (to, amount) => {
      await minter.send(deployer.getSender(), { value: toNano("0.2") }, { $$type: "Mint", to, amount });
    },
  };
}

async function walletOf(chain: Blockchain, owner: Address, minter: SandboxContract<TestJettonMinter>) {
  return chain.openContract(await TestJettonWallet.fromInit(owner, minter.address));
}

async function transfer(
  chain: Blockchain,
  wallet: SandboxContract<TestJettonWallet>,
  from: SandboxContract<TreasuryContract>,
  to: Address,
  amount: bigint,
  payload: Cell,
) {
  return wallet.send(
    from.getSender(),
    { value: toNano("0.3") },
    {
      $$type: "TokenTransfer",
      queryId: 0n,
      amount,
      destination: to,
      responseDestination: from.address,
      customPayload: null,
      forwardTonAmount: toNano("0.1"),
      forwardPayload: payload,
    },
  );
}

async function createPool(
  chain: Blockchain,
  deployer: SandboxContract<TreasuryContract>,
  factory: SandboxContract<PoolFactory>,
  kuki: Address,
  token: Address,
  feeBps: bigint,
): Promise<SandboxContract<WeightedPool>> {
  await factory.send(
    deployer.getSender(),
    { value: toNano("0.2") },
    { $$type: "CreatePool", token, wKuki: 1n, wToken: 1n, feeBps, tonSide: false },
  );
  const pool = chain.openContract(
    await WeightedPool.fromInit(factory.address, deployer.address, kuki, token, 1n, 1n, feeBps, false),
  );
  const kw = await TestJettonWallet.fromInit(pool.address, kuki);
  const tw = await TestJettonWallet.fromInit(pool.address, token);
  await pool.send(deployer.getSender(), { value: toNano("0.05") }, { $$type: "BindWallet", index: 0n, wallet: kw.address });
  await pool.send(deployer.getSender(), { value: toNano("0.05") }, { $$type: "BindWallet", index: 1n, wallet: tw.address });
  return pool;
}

async function seed(
  chain: Blockchain,
  deployer: SandboxContract<TreasuryContract>,
  pool: SandboxContract<WeightedPool>,
  kukiWallet: SandboxContract<TestJettonWallet>,
  tokenWallet: SandboxContract<TestJettonWallet>,
  kukiAmount: bigint,
  tokenAmount: bigint,
) {
  const deadline = BigInt(T0 + 3600);
  await transfer(chain, kukiWallet, deployer, pool.address, kukiAmount, liqPayload(1n, 0n, deadline));
  await transfer(chain, tokenWallet, deployer, pool.address, tokenAmount, liqPayload(1n, 1n, deadline));
}

function venue(id: "stonfi" | "kuki", address: string, p: PoolMath): Venue {
  return { id, address, label: id === "stonfi" ? "pools.A" : "pools.B", pool: p };
}

async function main() {
  const chain = await Blockchain.create();
  chain.now = T0;
  const deployer = await chain.treasury("deployer");
  const bot = await chain.treasury("bot");

  console.log("1) deploying test jettons + factory");
  const kuki = await jetton(chain, deployer, 1n);
  const token = await jetton(chain, deployer, 2n);
  const factory = chain.openContract(await PoolFactory.fromInit(deployer.address, kuki.minter.address));
  await factory.send(deployer.getSender(), { value: toNano("0.05") }, null);

  await kuki.mint(bot.address, 5_000_000n * K);
  await token.mint(bot.address, 50_000_000n * K);
  await kuki.mint(deployer.address, 20_000_000n * K);
  await token.mint(deployer.address, 200_000_000n * K);

  console.log("2) creating pools A (1:1) and B (1:1, different fee so the address differs)");
  const poolA = await createPool(chain, deployer, factory, kuki.minter.address, token.minter.address, 30n);
  const poolB = await createPool(chain, deployer, factory, kuki.minter.address, token.minter.address, 31n);

  const dKuki = await walletOf(chain, deployer.address, kuki.minter);
  const dToken = await walletOf(chain, deployer.address, token.minter);

  console.log("3) seeding: A at 10 TOKEN/KUKI, B at ~11.1 TOKEN/KUKI");
  await seed(chain, deployer, poolA, dKuki, dToken, 5_000_000n * K, 50_000_000n * K);
  await seed(chain, deployer, poolB, dKuki, dToken, 5_000_000n * K, 45_000_000n * K);

  const stateA = await poolA.getGetPoolState();
  const stateB = await poolB.getGetPoolState();
  const pA: PoolMath = {
    kuki: stateA.reserveKuki,
    token: stateA.reserveToken,
    wKuki: stateA.wKuki,
    wToken: stateA.wToken,
    feeBps: stateA.feeBps,
  };
  const pB: PoolMath = {
    kuki: stateB.reserveKuki,
    token: stateB.reserveToken,
    wKuki: stateB.wKuki,
    wToken: stateB.wToken,
    feeBps: stateB.feeBps,
  };
  console.log(`   A: ${tok(pA.kuki)} KUKI / ${tok(pA.token)} TOKEN (price ${(Number(spotPrice(pA)) / 1e18).toFixed(4)} KUKI/token)`);
  console.log(`   B: ${tok(pB.kuki)} KUKI / ${tok(pB.token)} TOKEN (price ${(Number(spotPrice(pB)) / 1e18).toFixed(4)} KUKI/token)`);

  const A = venue("stonfi", poolA.address.toString(), pA);
  const B = venue("kuki", poolB.address.toString(), pB);

  const botKuki = await walletOf(chain, bot.address, kuki.minter);
  const botToken = await walletOf(chain, bot.address, token.minter);
  const botKukiBal = (await botKuki.getGetWalletData()).balance;
  const botTokenBal = (await botToken.getGetWalletData()).balance;
  console.log(`   bot: ${tok(botKukiBal)} KUKI / ${tok(botTokenBal)} TOKEN`);

  console.log("\n4) sizing with the real guard");
  const plan = findBestArb(A, B, botKukiBal, GAS_KUKI)!;
  console.log(
    `   buy ${plan.buy.id} -> sell ${plan.sell.id}, size ${tok(plan.amountIn)} KUKI,` +
      ` gross ${tok(plan.grossProfit)} KUKI, gas ${tok(plan.gasKuki)} KUKI, net ${tok(plan.netProfit)} KUKI`,
  );

  const cfg = {
    minProfit: 0n,
    maxTrade: botKukiBal,
    minEdgeBps: 40,
    maxPoolShareBps: 2_000,
    cooldownMs: 0,
    maxConsecutiveFailures: 3,
  };
  const fresh: GuardState = { lastTradeAt: 0, consecutiveFailures: 0 };
  const verdict = checkPlan(plan, cfg, fresh);
  console.log("   guard:", verdict);

  // Thin-edge counterfactual: a sell venue only 150 bps above pool A. The
  // round trip exists on paper but cannot cover gas, so the guard must refuse.
  const thinSell: Venue = {
    ...B,
    pool: { ...B.pool, token: (A.pool.token * 10_000n) / 10_150n },
  };
  const thinPlan = findBestArb(A, thinSell, botKukiBal, GAS_KUKI);
  console.log("   thin edge:", thinPlan === null ? "no plan" : checkPlan(thinPlan, cfg, fresh));

  if (!verdict.ok) {
    console.log("\n5) guard blocked the trade — nothing was sent (this is the point)");
    return;
  }

  console.log("\n5) guard approved — executing the round trip on-chain");
  const tonStart = (await chain.getContract(bot.address)).balance;
  const q1 = await poolA.getGetQuote(0n, plan.amountIn);
  const minOut1 = (q1 * 9_950n) / 10_000n;
  console.log(`   leg1: A quote ${tok(q1)} TOKEN, minOut ${tok(minOut1)}`);
  const r1 = await transfer(chain, botKuki, bot, poolA.address, plan.amountIn, swapPayload(0n, minOut1, bot.address, BigInt(T0 + 3600)));
  if (r1.transactions.some((t) => (t.description as any).aborted)) throw new Error("leg1 aborted");

  const afterToken = (await botToken.getGetWalletData()).balance;
  const received = afterToken - botTokenBal;
  console.log(`   leg1 settled: +${tok(received)} TOKEN`);

  const q2 = await poolB.getGetQuote(1n, received);
  const floor2 = leg2Floor({ size: plan.amountIn, received, quoteOut: q2, slippageBps: 50, minProfit: 0n });
  console.log(`   leg2: B quote ${tok(q2)} KUKI, floor ${floor2 === null ? "HOLD" : tok(floor2)}`);
  if (floor2 === null) {
    console.log("   guard: holding the token instead of selling at a loss");
  } else {
    const r2 = await transfer(chain, botToken, bot, poolB.address, received, swapPayload(1n, floor2, bot.address, BigInt(T0 + 3600)));
    if (r2.transactions.some((t) => (t.description as any).aborted)) throw new Error("leg2 aborted");
  }

  const finalKuki = (await botKuki.getGetWalletData()).balance;
  const finalToken = (await botToken.getGetWalletData()).balance;
  const kukiPnl = finalKuki - botKukiBal;
  const tokenPnl = finalToken - botTokenBal;
  const tonPnl = (await chain.getContract(bot.address)).balance - tonStart;

  console.log("\n6) result (measured on-chain)");
  console.log(`   KUKI P&L   : ${tok(kukiPnl)} KUKI`);
  console.log(`   TOKEN P&L  : ${tok(tokenPnl)} TOKEN`);
  console.log(`   TON gas    : ${Number(tonPnl) / 1e9} TON`);
  console.log(`   net in KUKI (conservative gas @ ${tok(GAS_KUKI)} KUKI): ${tok(kukiPnl - GAS_KUKI)} KUKI`);
  console.log(`   final pool A: ${tok((await poolA.getGetPoolState()).reserveKuki)} KUKI / ${tok((await poolA.getGetPoolState()).reserveToken)} TOKEN`);
  console.log(`   final pool B: ${tok((await poolB.getGetPoolState()).reserveKuki)} KUKI / ${tok((await poolB.getGetPoolState()).reserveToken)} TOKEN`);

  const invariant = (s: { reserveKuki: bigint; reserveToken: bigint }) => s.reserveKuki * s.reserveToken;
  console.log(`   k of A: ${invariant(stateA)} -> ${invariant(await poolA.getGetPoolState())}`);
  console.log(`   k of B: ${invariant(stateB)} -> ${invariant(await poolB.getGetPoolState())}`);
}

await main();
