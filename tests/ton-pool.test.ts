/**
 * Native-TON pool tests: KUKI + TON, no token jetton.
 *
 * These exercise the code paths that differ from the jetton pool:
 *   - only the KUKI wallet is bound,
 *   - TON enters through a value-carrying message,
 *   - TON leaves through a native send,
 *   - the TON reserve is part of the contract balance.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, beginCell, Cell, toNano } from "@ton/core";

import { PoolFactory } from "../build/kuki-dex_PoolFactory.ts";
import { WeightedPool } from "../build/kuki-dex_WeightedPool.ts";
import { TestJettonMinter } from "../build/kuki-dex-test_TestJettonMinter.ts";
import { TestJettonWallet } from "../build/kuki-dex-test_TestJettonWallet.ts";
import { SCALE } from "../bot/src/math/fixed.ts";
import { amountOut } from "../bot/src/math/weighted.ts";

const ZERO = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
const OP_LIQ = 0x4b554b02;
const OP_SWAP = 0x4b554b01;
const OP_SWAP_TON = 0x4b554b0b;
const OP_LIQ_TON = 0x4b554b0c;
const T0 = 1_800_000_000;
const GAS = toNano("0.05");

function swapPayload(assetIn: bigint, minOut: bigint, receiver: Address, deadline: bigint): Cell {
  return beginCell()
    .storeUint(OP_SWAP, 32)
    .storeUint(assetIn, 8)
    .storeCoins(minOut)
    .storeAddress(receiver)
    .storeUint(deadline, 32)
    .endCell();
}

function tonSwapBody(amountIn: bigint, minOut: bigint, receiver: Address, deadline: bigint): Cell {
  return beginCell()
    .storeUint(OP_SWAP_TON, 32)
    .storeCoins(amountIn)
    .storeCoins(minOut)
    .storeAddress(receiver)
    .storeUint(deadline, 32)
    .endCell();
}

function liqPayload(nonce: bigint, assetIdx: bigint, minShares: bigint, deadline: bigint): Cell {
  return beginCell()
    .storeUint(OP_LIQ, 32)
    .storeUint(nonce, 64)
    .storeUint(assetIdx, 8)
    .storeCoins(minShares)
    .storeUint(deadline, 32)
    .storeAddress(ZERO)
    .endCell();
}

function tonLiqBody(nonce: bigint, minShares: bigint, deadline: bigint): Cell {
  return beginCell()
    .storeUint(OP_LIQ_TON, 32)
    .storeUint(nonce, 64)
    .storeCoins(minShares)
    .storeUint(deadline, 32)
    .storeAddress(ZERO)
    .endCell();
}

type Env = {
  chain: Blockchain;
  deployer: SandboxContract<TreasuryContract>;
  user: SandboxContract<TreasuryContract>;
  trader: SandboxContract<TreasuryContract>;
  receiver: SandboxContract<TreasuryContract>;
  kuki: SandboxContract<TestJettonMinter>;
  factory: SandboxContract<PoolFactory>;
  pool: SandboxContract<WeightedPool>;
  userKuki: SandboxContract<TestJettonWallet>;
};

async function transferKuki(
  env: Env,
  from: SandboxContract<TreasuryContract>,
  wallet: SandboxContract<TestJettonWallet>,
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
      destination: env.pool.address,
      responseDestination: from.address,
      customPayload: null,
      forwardTonAmount: toNano("0.1"),
      forwardPayload: payload,
    },
  );
}

async function setup(): Promise<Env> {
  const chain = await Blockchain.create();
  chain.now = T0;
  const deployer = await chain.treasury("deployer");
  const user = await chain.treasury("user");
  const trader = await chain.treasury("trader");
  const receiver = await chain.treasury("receiver");

  const kuki = chain.openContract(await TestJettonMinter.fromInit(deployer.address, 11n));
  await kuki.send(deployer.getSender(), { value: toNano("0.05") }, null);
  await kuki.send(deployer.getSender(), { value: toNano("0.3") }, { $$type: "Mint", to: user.address, amount: 5_000n * 10n ** 9n });
  await kuki.send(deployer.getSender(), { value: toNano("0.3") }, { $$type: "Mint", to: trader.address, amount: 5_000n * 10n ** 9n });

  const factory = chain.openContract(await PoolFactory.fromInit(deployer.address, kuki.address));
  await factory.send(deployer.getSender(), { value: toNano("0.05") }, null);
  await factory.send(
    deployer.getSender(),
    { value: toNano("0.2") },
    { $$type: "CreatePool", token: ZERO, wKuki: 1n, wToken: 1n, feeBps: 30n, tonSide: true },
  );

  const pool = chain.openContract(
    await WeightedPool.fromInit(factory.address, deployer.address, kuki.address, ZERO, 1n, 1n, 30n, true),
  );
  const kukiWallet = await TestJettonWallet.fromInit(pool.address, kuki.address);
  await pool.send(deployer.getSender(), { value: toNano("0.05") }, { $$type: "BindWallet", index: 0n, wallet: kukiWallet.address });

  const userKuki = chain.openContract(await TestJettonWallet.fromInit(user.address, kuki.address));
  const state = await pool.getGetPoolState();
  assert.equal(state.ready, true);
  assert.equal(state.reserveToken, 0n);

  return { chain, deployer, user, trader, receiver, kuki, factory, pool, userKuki };
}

async function seed(env: Env, kukiAmount: bigint, tonAmount: bigint) {
  const deadline = BigInt(T0 + 3600);
  await transferKuki(env, env.user, env.userKuki, kukiAmount, liqPayload(7n, 0n, 0n, deadline));
  await env.user.send({ to: env.pool.address, value: tonAmount + GAS, body: tonLiqBody(7n, 0n, deadline), bounce: true });
}

describe("native TON pool", () => {
  it("accepts KUKI + TON liquidity with only the KUKI wallet bound", async () => {
    const env = await setup();
    const K = 1_000n * 10n ** 9n;
    const TON = 10n * 10n ** 9n;
    await seed(env, K, TON);

    const state = await env.pool.getGetPoolState();
    assert.equal(state.reserveKuki, K);
    assert.equal(state.reserveToken, TON, "TON reserve is tracked in nanoTON");
    assert.equal(state.totalShares, TON * SCALE, "shares are the min weight-normalised value");

    // The contract's balance must cover the TON reserve (+ gas surplus).
    const balance = (await env.chain.getContract(env.pool.address)).balance;
    assert.ok(balance >= TON, `balance ${balance} < reserve ${TON}`);
  });

  it("quotes and executes TON -> KUKI", async () => {
    const env = await setup();
    const K = 1_000n * 10n ** 9n;
    const TON = 10n * 10n ** 9n;
    await seed(env, K, TON);

    const amountIn = 1n * 10n ** 9n;
    const expected = amountOut({ kuki: K, token: TON, wKuki: 1n, wToken: 1n, feeBps: 30n }, false, amountIn);
    assert.equal(await env.pool.getGetQuote(1n, amountIn), expected);

    const traderKuki = env.chain.openContract(await TestJettonWallet.fromInit(env.trader.address, env.kuki.address));
    const before = (await traderKuki.getGetWalletData()).balance;

    const res = await env.trader.send({
      to: env.pool.address,
      value: amountIn + GAS,
      body: tonSwapBody(amountIn, expected, env.trader.address, BigInt(T0 + 3600)),
      bounce: true,
    });
    assert.ok(res.transactions.length > 0);

    const after = (await traderKuki.getGetWalletData()).balance;
    assert.equal(after - before, expected);

    const state = await env.pool.getGetPoolState();
    assert.equal(state.reserveToken, TON + amountIn);
    assert.equal(state.reserveKuki, K - expected);
  });

  it("accrues the protocol fee to the admin and withdraws it", async () => {
    const env = await setup();
    const K = 1_000n * 10n ** 9n;
    const TON = 10n * 10n ** 9n;
    await env.pool.send(env.deployer.getSender(), { value: toNano("0.05") }, { $$type: "SetProtocolFee", feeBps: 10n });
    await seed(env, K, TON);

    const amountIn = 1n * 10n ** 9n;
    const cut = (amountIn * 10n) / 10_000n;
    const expected = amountOut(
      { kuki: K, token: TON, wKuki: 1n, wToken: 1n, feeBps: 30n },
      false,
      amountIn - cut,
    );
    assert.equal(await env.pool.getGetQuote(1n, amountIn), expected);

    const traderKuki = env.chain.openContract(await TestJettonWallet.fromInit(env.trader.address, env.kuki.address));
    const before = (await traderKuki.getGetWalletData()).balance;
    await env.trader.send({
      to: env.pool.address,
      value: amountIn + GAS,
      body: tonSwapBody(amountIn, expected, env.trader.address, BigInt(T0 + 3600)),
      bounce: true,
    });
    assert.equal((await traderKuki.getGetWalletData()).balance - before, expected);

    const fees = await env.pool.getGetFees();
    assert.equal(fees.pendingToken, cut);
    assert.equal(fees.protocolFeeBps, 10n);
    assert.equal(fees.recipient.toString(), env.deployer.address.toString());

    const tonBefore = (await env.chain.getContract(env.receiver.address)).balance;
    await env.pool.send(
      env.deployer.getSender(),
      { value: toNano("0.1") },
      { $$type: "WithdrawFees", to: env.receiver.address },
    );
    const tonAfter = (await env.chain.getContract(env.receiver.address)).balance;
    assert.ok(tonAfter > tonBefore, "fees must leave the pool");
    assert.equal((await env.pool.getGetFees()).pendingToken, 0n);
  });

  it("refunds TON when minOut is not met", async () => {
    const env = await setup();
    const K = 1_000n * 10n ** 9n;
    const TON = 10n * 10n ** 9n;
    await seed(env, K, TON);

    const amountIn = 1n * 10n ** 9n;
    const before = (await env.chain.getContract(env.pool.address)).balance;
    await env.trader.send({
      to: env.pool.address,
      value: amountIn + GAS,
      body: tonSwapBody(amountIn, amountIn * 1000n, env.trader.address, BigInt(T0 + 3600)),
      bounce: true,
    });
    const after = (await env.chain.getContract(env.pool.address)).balance;

    const state = await env.pool.getGetPoolState();
    assert.equal(state.reserveToken, TON, "reserve must not move on a rejected swap");
    // The pool kept only the gas buffer, not the swapped amount.
    assert.ok(after >= before - GAS - toNano("0.02"), `pool balance moved by ${before - after}`);
  });

  it("sells KUKI for native TON", async () => {
    const env = await setup();
    const K = 1_000n * 10n ** 9n;
    const TON = 10n * 10n ** 9n;
    await seed(env, K, TON);

    const amountIn = 10n * 10n ** 9n;
    const expected = amountOut({ kuki: K, token: TON, wKuki: 1n, wToken: 1n, feeBps: 30n }, true, amountIn);

    const traderKuki = env.chain.openContract(await TestJettonWallet.fromInit(env.trader.address, env.kuki.address));
    const tonBefore = (await env.chain.getContract(env.receiver.address)).balance;

    await transferKuki(env, env.trader, traderKuki, amountIn, swapPayload(0n, expected, env.receiver.address, BigInt(T0 + 3600)));

    const tonAfter = (await env.chain.getContract(env.receiver.address)).balance;
    // The receiver wallet pays its own incoming-message gas, so allow ~0.001 TON.
    const received = tonAfter - tonBefore;
    assert.ok(received <= expected, `received ${received} > quote ${expected}`);
    assert.ok(expected - received <= toNano("0.001"), `gas gap ${expected - received}`);
    const state = await env.pool.getGetPoolState();
    assert.equal(state.reserveKuki, K + amountIn);
    assert.equal(state.reserveToken, TON - expected);
  });

  it("withdraws KUKI and TON pro-rata", async () => {
    const env = await setup();
    const K = 1_000n * 10n ** 9n;
    const TON = 10n * 10n ** 9n;
    await seed(env, K, TON);

    const shares = (await env.pool.getGetShares(env.user.address)) / 2n;
    const traderKuki = env.chain.openContract(await TestJettonWallet.fromInit(env.user.address, env.kuki.address));
    const before = (await traderKuki.getGetWalletData()).balance;

    await env.pool.send(
      env.user.getSender(),
      { value: toNano("0.15") },
      { $$type: "WithdrawLiquidity", shares, minKuki: 0n, minToken: 0n },
    );

    const after = (await traderKuki.getGetWalletData()).balance;
    const state = await env.pool.getGetPoolState();
    assert.ok(after > before, "KUKI must come back");
    assert.ok(state.reserveToken < TON, "TON reserve must decrease");
    assert.equal(state.reserveKuki, K - (after - before));
  });

  it("hands admin and factory ownership over without keeping power", async () => {
    const env = await setup();
    await env.pool.send(env.deployer.getSender(), { value: toNano("0.05") }, { $$type: "SetAdmin", newAdmin: env.user.address });
    await env.factory.send(env.deployer.getSender(), { value: toNano("0.05") }, { $$type: "ChangeOwner", newOwner: env.user.address });

    assert.equal((await env.pool.getGetAdmin()).toString(), env.user.address.toString());
    assert.equal((await env.factory.getGetOwner()).toString(), env.user.address.toString());

    // The old deployer can no longer pause the pool.
    const denied = await env.pool.send(
      env.deployer.getSender(),
      { value: toNano("0.05") },
      { $$type: "SetPaused", paused: true },
    );
    assert.ok(
      denied.transactions.some((t) => (t.description as { aborted?: boolean }).aborted),
      "the old admin must be rejected",
    );
    // The new admin can.
    await env.pool.send(env.user.getSender(), { value: toNano("0.05") }, { $$type: "SetPaused", paused: true });
    assert.equal((await env.pool.getGetPoolState()).paused, true);
  });
});
