/**
 * End-to-end tests for the KUKI weighted pools, on a real TVM emulator.
 *
 * They run the actual jetton transfer flow (test jetton -> pool wallet ->
 * notification -> curve -> outgoing jetton), not just the math. The expected
 * numbers come from the TypeScript reference in bot/src/math, which the
 * contract is supposed to match to the wei.
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

const OP_SWAP = 0x4b554b01;
const OP_LIQ = 0x4b554b02;

const T0 = 1_800_000_000;

type Env = {
  chain: Blockchain;
  deployer: SandboxContract<TreasuryContract>;
  user: SandboxContract<TreasuryContract>;
  kuki: SandboxContract<TestJettonMinter>;
  token: SandboxContract<TestJettonMinter>;
  factory: SandboxContract<PoolFactory>;
};

function swapPayload(assetIn: bigint, minOut: bigint, receiver: Address, deadline: bigint): Cell {
  return beginCell()
    .storeUint(OP_SWAP, 32)
    .storeUint(assetIn, 8)
    .storeCoins(minOut)
    .storeAddress(receiver)
    .storeUint(deadline, 32)
    .endCell();
}

function liqPayload(nonce: bigint, assetIdx: bigint, minShares: bigint, deadline: bigint, beneficiary?: Address): Cell {
  return beginCell()
    .storeUint(OP_LIQ, 32)
    .storeUint(nonce, 64)
    .storeUint(assetIdx, 8)
    .storeCoins(minShares)
    .storeUint(deadline, 32)
    .storeAddress(beneficiary ?? Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"))
    .endCell();
}

async function setup(): Promise<Env> {
  const chain = await Blockchain.create();
  chain.now = T0;

  const deployer = await chain.treasury("deployer");
  const user = await chain.treasury("user");

  const kuki = chain.openContract(await TestJettonMinter.fromInit(deployer.address, 1n));
  const token = chain.openContract(await TestJettonMinter.fromInit(deployer.address, 2n));
  await kuki.send(deployer.getSender(), { value: toNano("0.05") }, null);
  await token.send(deployer.getSender(), { value: toNano("0.05") }, null);

  const factory = chain.openContract(await PoolFactory.fromInit(deployer.address, kuki.address));
  await factory.send(deployer.getSender(), { value: toNano("0.05") }, null);

  return { chain, deployer, user, kuki, token, factory };
}

async function createPool(
  env: Env,
  wKuki: bigint,
  wToken: bigint,
  feeBps: bigint,
): Promise<SandboxContract<WeightedPool>> {
  const { deployer, factory, kuki, token } = env;
  await factory.send(
    deployer.getSender(),
    { value: toNano("0.2") },
    { $$type: "CreatePool", token: token.address, wKuki, wToken, feeBps, tonSide: false },
  );

  const pool = env.chain.openContract(
    await WeightedPool.fromInit(factory.address, deployer.address, kuki.address, token.address, wKuki, wToken, feeBps, false),
  );

  const kukiWallet = await TestJettonWallet.fromInit(pool.address, kuki.address);
  const tokenWallet = await TestJettonWallet.fromInit(pool.address, token.address);

  await pool.send(
    deployer.getSender(),
    { value: toNano("0.05") },
    { $$type: "BindWallet", index: 0n, wallet: kukiWallet.address },
  );
  await pool.send(
    deployer.getSender(),
    { value: toNano("0.05") },
    { $$type: "BindWallet", index: 1n, wallet: tokenWallet.address },
  );

  const state = await pool.getGetPoolState();
  assert.equal(state.ready, true);
  return pool;
}

async function mint(env: Env, minter: SandboxContract<TestJettonMinter>, to: Address, amount: bigint) {
  await minter.send(env.deployer.getSender(), { value: toNano("0.2") }, { $$type: "Mint", to, amount });
}

async function jettonWallet(env: Env, minter: SandboxContract<TestJettonMinter>, owner: Address) {
  return env.chain.openContract(await TestJettonWallet.fromInit(owner, minter.address));
}

async function transfer(
  env: Env,
  wallet: SandboxContract<TestJettonWallet>,
  from: SandboxContract<TreasuryContract>,
  to: Address,
  amount: bigint,
  forwardPayload: Cell,
  forwardTon = toNano("0.1"),
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
      forwardTonAmount: forwardTon,
      forwardPayload,
    },
  );
}

async function addLiquidity(
  env: Env,
  pool: SandboxContract<WeightedPool>,
  kukiAmount: bigint,
  tokenAmount: bigint,
  nonce = 1n,
) {
  const { user, kuki, token } = env;
  const kukiWallet = await jettonWallet(env, kuki, user.address);
  const tokenWallet = await jettonWallet(env, token, user.address);
  const deadline = BigInt(T0 + 3600);

  await transfer(env, kukiWallet, user, pool.address, kukiAmount, liqPayload(nonce, 0n, 0n, deadline));
  await transfer(env, tokenWallet, user, pool.address, tokenAmount, liqPayload(nonce, 1n, 0n, deadline));
}

describe("KUKI weighted pool", () => {
  it("creates a pool, binds wallets and mints LP shares on a 50/50 deposit", async () => {
    const env = await setup();
    const { user, kuki, token } = env;

    const KUKI = 1_000n * 10n ** 9n;
    const TOKEN = 10_000n * 10n ** 9n;
    await mint(env, kuki, user.address, KUKI * 2n);
    await mint(env, token, user.address, TOKEN * 2n);

    const pool = await createPool(env, 1n, 1n, 30n);
    await addLiquidity(env, pool, KUKI, TOKEN);

    const state = await pool.getGetPoolState();
    assert.equal(state.reserveKuki, KUKI);
    assert.equal(state.reserveToken, TOKEN);
    assert.equal(state.wKuki, 1n);
    assert.equal(state.wToken, 1n);
    assert.equal(state.feeBps, 30n);

    // Bootstrap shares use the weight-normalised value proxy; 0.1% is locked.
    const expectedMinted = KUKI * SCALE;
    const lock = expectedMinted / 1000n;
    assert.equal(state.totalShares, expectedMinted);

    const userShares = await pool.getGetShares(user.address);
    assert.equal(userShares, expectedMinted - lock);

    const poolShares = await pool.getGetShares(pool.address);
    assert.equal(poolShares, lock);
  });

  it("swaps KUKI -> token with the exact curve output", async () => {
    const env = await setup();
    const { user, kuki, token } = env;

    const KUKI = 1_000n * 10n ** 9n;
    const TOKEN = 10_000n * 10n ** 9n;
    await mint(env, kuki, user.address, KUKI * 3n);
    await mint(env, token, user.address, TOKEN * 3n);

    const pool = await createPool(env, 1n, 1n, 30n);
    await addLiquidity(env, pool, KUKI, TOKEN);

    const amountIn = 10n * 10n ** 9n;
    const expected = amountOut(
      { kuki: KUKI, token: TOKEN, wKuki: 1n, wToken: 1n, feeBps: 30n },
      true,
      amountIn,
    );

    const kukiWallet = await jettonWallet(env, kuki, user.address);
    const tokenWallet = await jettonWallet(env, token, user.address);
    const before = (await tokenWallet.getGetWalletData()).balance;

    // The pool's own quote must match the reference implementation exactly.
    assert.equal(await pool.getGetQuote(0n, amountIn), expected);

    const res = await transfer(
      env,
      kukiWallet,
      user,
      pool.address,
      amountIn,
      swapPayload(0n, expected - 1n, user.address, BigInt(T0 + 3600)),
    );
    assert.equal(res.transactions.length > 0, true);

    const after = (await tokenWallet.getGetWalletData()).balance;
    assert.equal(after - before, expected);

    const state = await pool.getGetPoolState();
    assert.equal(state.reserveKuki, KUKI + amountIn);
    assert.equal(state.reserveToken, TOKEN - expected);
  });

  it("refunds instead of throwing when slippage is not met", async () => {
    const env = await setup();
    const { user, kuki, token } = env;

    const KUKI = 1_000n * 10n ** 9n;
    const TOKEN = 10_000n * 10n ** 9n;
    await mint(env, kuki, user.address, KUKI * 2n);
    await mint(env, token, user.address, TOKEN * 2n);

    const pool = await createPool(env, 1n, 1n, 30n);
    await addLiquidity(env, pool, KUKI, TOKEN);

    const kukiWallet = await jettonWallet(env, kuki, user.address);
    const amountIn = 10n * 10n ** 9n;
    const before = (await kukiWallet.getGetWalletData()).balance;

    await transfer(
      env,
      kukiWallet,
      user,
      pool.address,
      amountIn,
      swapPayload(0n, amountIn * 1000n, user.address, BigInt(T0 + 3600)),
    );

    const after = (await kukiWallet.getGetWalletData()).balance;
    assert.equal(after, before, "input must come back");

    const state = await pool.getGetPoolState();
    assert.equal(state.reserveKuki, KUKI);
  });

  it("prices an 80/20 pool like Osmosis classic (exp/ln path)", async () => {
    const env = await setup();
    const { user, kuki, token } = env;

    const KUKI = 1_000n * 10n ** 9n;
    const TOKEN = 10_000n * 10n ** 9n;
    await mint(env, kuki, user.address, KUKI * 3n);
    await mint(env, token, user.address, TOKEN * 3n);

    const pool = await createPool(env, 4n, 1n, 30n);
    await addLiquidity(env, pool, KUKI, TOKEN);

    const amountIn = 50n * 10n ** 9n;
    const expectedKukiToToken = amountOut(
      { kuki: KUKI, token: TOKEN, wKuki: 4n, wToken: 1n, feeBps: 30n },
      true,
      amountIn,
    );

    const kukiWallet = await jettonWallet(env, kuki, user.address);
    const tokenWallet = await jettonWallet(env, token, user.address);

    const tokenBefore = (await tokenWallet.getGetWalletData()).balance;
    await transfer(
      env,
      kukiWallet,
      user,
      pool.address,
      amountIn,
      swapPayload(0n, expectedKukiToToken - 1n, user.address, BigInt(T0 + 3600)),
    );
    const tokenAfter = (await tokenWallet.getGetWalletData()).balance;
    assert.equal(tokenAfter - tokenBefore, expectedKukiToToken);

    // The reverse leg is priced against the *post-swap* reserves.
    const expectedTokenToKuki = amountOut(
      {
        kuki: KUKI + amountIn,
        token: TOKEN - expectedKukiToToken,
        wKuki: 4n,
        wToken: 1n,
        feeBps: 30n,
      },
      false,
      amountIn,
    );

    const kukiBefore = (await kukiWallet.getGetWalletData()).balance;
    await transfer(
      env,
      tokenWallet,
      user,
      pool.address,
      amountIn,
      swapPayload(1n, expectedTokenToKuki - 1n, user.address, BigInt(T0 + 3600)),
    );
    const kukiAfter = (await kukiWallet.getGetWalletData()).balance;
    assert.equal(kukiAfter - kukiBefore, expectedTokenToKuki);
  });

  it("withdraws pro-rata and keeps the locked bootstrap shares", async () => {
    const env = await setup();
    const { user, kuki, token } = env;

    const KUKI = 1_000n * 10n ** 9n;
    const TOKEN = 10_000n * 10n ** 9n;
    await mint(env, kuki, user.address, KUKI * 2n);
    await mint(env, token, user.address, TOKEN * 2n);

    const pool = await createPool(env, 1n, 1n, 30n);
    await addLiquidity(env, pool, KUKI, TOKEN);

    const shares = (await pool.getGetShares(user.address)) / 2n;
    const kukiWallet = await jettonWallet(env, kuki, user.address);
    const tokenWallet = await jettonWallet(env, token, user.address);
    const kukiBefore = (await kukiWallet.getGetWalletData()).balance;
    const tokenBefore = (await tokenWallet.getGetWalletData()).balance;

    const res = await pool.send(
      user.getSender(),
      { value: toNano("0.12") },
      { $$type: "WithdrawLiquidity", shares, minKuki: 0n, minToken: 0n },
    );
    assert.equal(res.transactions.length > 0, true);

    const state = await pool.getGetPoolState();
    const kukiGain = (await kukiWallet.getGetWalletData()).balance - kukiBefore;
    const tokenGain = (await tokenWallet.getGetWalletData()).balance - tokenBefore;
    assert.ok(kukiGain > 0n);
    assert.ok(tokenGain > 0n);

    const remaining = await pool.getGetShares(user.address);
    assert.equal(remaining, shares);
  });

  it("refunds a stray liquidity leg that does not match the open session", async () => {
    const env = await setup();
    const { user, kuki, token } = env;

    const KUKI = 1_000n * 10n ** 9n;
    const TOKEN = 10_000n * 10n ** 9n;
    await mint(env, kuki, user.address, KUKI);
    await mint(env, token, user.address, TOKEN);

    const pool = await createPool(env, 1n, 1n, 30n);

    const kukiWallet = await jettonWallet(env, kuki, user.address);
    const deadline = BigInt(T0 + 3600);

    // open a session with nonce 1
    await transfer(env, kukiWallet, user, pool.address, KUKI / 2n, liqPayload(1n, 0n, 0n, deadline));
    const before = (await kukiWallet.getGetWalletData()).balance;

    // a second leg with a different nonce must be refunded, not merged
    await transfer(env, kukiWallet, user, pool.address, KUKI / 4n, liqPayload(2n, 0n, 0n, deadline));
    const after = (await kukiWallet.getGetWalletData()).balance;
    assert.equal(after, before);

    const state = await pool.getGetPoolState();
    assert.equal(state.totalShares, 0n);
  });
});
