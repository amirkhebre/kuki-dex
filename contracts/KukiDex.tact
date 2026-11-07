/**
 *  KUKI DEX — Osmosis-classic weighted pools, quoted in KUKI.
 *
 *  Design notes (read docs/01-design.md for the long version):
 *
 *  • Every pool is KUKI + one jetton. KUKI is the quote asset, so a pool is
 *    fully described by (reserveKuki, reserveToken, wKuki, wToken, fee).
 *  • Weights are integer parts, e.g. (4,1) is an 80/20 pool and (1,1) is 50/50.
 *    The swap curve is the Balancer/Osmosis weighted invariant:
 *
 *        out = B_out · (1 − (B_in / (B_in + in·(1−fee))) ^ (w_in / w_out))
 *
 *    Fractional exponents are computed as exp(ln(t)·w_in/w_out) in 1e18 fixed
 *    point, the same code as bot/src/math/fixed.ts (tested against it).
 *  • LP positions are an internal share ledger (v0). Shares are minted only for
 *    proportional deposits, which keeps the accounting oracle-free and
 *    manipulation-resistant; a single-sided "zap" is a v1 router feature.
 *  • TON is asynchronous: liquidity is added in two jetton transfers that are
 *    paired by (owner, nonce), then finalised automatically. If the second leg
 *    never arrives the owner can cancel and every leg is refunded.
 *  • Anything that goes wrong *after* jettons have been received refunds them;
 *    it never throws, because throwing would strand the funds in the pool's
 *    jetton wallet with no accounting entry.
 */

import "@stdlib/deploy";

const SCALE: Int = 1000000000000000000;
const BPS: Int = 10000;
const LN2: Int = 693147180559945309;
const ZERO_ADDR: Address = address("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");

// Forward payload opcodes (inside a jetton transfer notification).
const OP_SWAP: Int = 0x4b554b01;
const OP_LIQ: Int = 0x4b554b02;

// Direct messages to the pool.
const OP_CANCEL: Int = 0x4b554b03;
const OP_BIND: Int = 0x4b554b04;
const OP_SET_PAUSED: Int = 0x4b554b05;
const OP_SET_FEE: Int = 0x4b554b06;
const OP_WITHDRAW: Int = 0x4b554b07;
const OP_EXPIRE: Int = 0x4b554b08;
const OP_TOPUP: Int = 0x4b554b09;

// Events.
const OP_EV_SWAP: Int = 0x4b554b10;
const OP_EV_LIQ_ADD: Int = 0x4b554b11;
const OP_EV_LIQ_REM: Int = 0x4b554b12;

const GAS_JETTON: Int = 45000000; // 0.045 TON attached to an outgoing jetton transfer
const MIN_TON_GAS: Int = 50000000; // 0.05 TON the pool keeps from an incoming TON message
const MIN_WITHDRAW_VALUE: Int = 100000000; // 0.1 TON for the two outgoing transfers
const MAX_FEE_BPS: Int = 1000; // 10% hard cap
const MAX_WEIGHT: Int = 16;
const DEPOSIT_TOLERANCE_BPS: Int = 50; // 0.5% deviation from the pool ratio
const BOOTSTRAP_LOCK_DIVISOR: Int = 1000; // 0.1% of the first LP position is locked

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

message(0x4b554b01) SwapIntent {
    assetIn: Int as uint8;
    minOut: Int;
    receiver: Address;
    deadline: Int as uint32;
}

message(0x4b554b02) LiquidityPart {
    nonce: Int as uint64;
    assetIdx: Int as uint8;
    minShares: Int;
    deadline: Int as uint32;
    beneficiary: Address;
}

message(0x4b554b03) CancelLiquidity {
    nonce: Int as uint64;
}

message(0x4b554b04) BindWallet {
    index: Int as uint8;
    wallet: Address;
}

message(0x4b554b05) SetPaused {
    paused: Bool;
}

message(0x4b554b06) SetFee {
    feeBps: Int as uint16;
}

message(0x4b554b07) WithdrawLiquidity {
    shares: Int;
    minKuki: Int;
    minToken: Int;
}

message(0x4b554b08) ExpireLiquidity {
    owner: Address;
}

message(0x4b554b0a) WithdrawTon {
    amount: Int;
    to: Address;
}

/** Native-TON pool: buy KUKI with TON (or vice versa via `SwapIntent`). */
message(0x4b554b0b) SwapTonIntent {
    amountIn: Int as coins;
    minOut: Int as coins;
    receiver: Address;
    deadline: Int as uint32;
}

/** Native-TON pool: the TON leg of a liquidity deposit. */
message(0x4b554b0c) LiquidityTonPart {
    nonce: Int as uint64;
    minShares: Int as coins;
    deadline: Int as uint32;
    beneficiary: Address;
}

message(0x4b554b0d) SetAdmin {
    newAdmin: Address;
}

message(0x4b554b0e) ChangeOwner {
    newOwner: Address;
}

/** Protocol fee, taken from the input of every swap and paid to the admin. */
message(0x4b554b14) SetProtocolFee {
    feeBps: Int as uint16;
}

message(0x4b554b15) WithdrawFees {
    to: Address;
}

message(0x7362d09c) JettonNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forwardPayload: Slice as remaining;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

message(0x4b554b10) SwapEvent {
    trader: Address;
    kukiIn: Bool;
    amountIn: Int;
    amountOut: Int;
    reserveKuki: Int;
    reserveToken: Int;
}

message(0x4b554b11) LiquidityAdded {
    provider: Address;
    shares: Int;
    kukiAmount: Int;
    tokenAmount: Int;
}

message(0x4b554b12) LiquidityRemoved {
    provider: Address;
    shares: Int;
    kukiAmount: Int;
    tokenAmount: Int;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Pending {
    nonce: Int as uint64;
    deadline: Int as uint32;
    minShares: Int;
    hasA: Bool;
    aIdx: Int as uint8;
    aAmt: Int;
    hasB: Bool;
    bIdx: Int as uint8;
    bAmt: Int;
    beneficiary: Address;
}

struct PoolState {
    reserveKuki: Int;
    reserveToken: Int;
    wKuki: Int;
    wToken: Int;
    feeBps: Int;
    totalShares: Int;
    paused: Bool;
    ready: Bool;
}

struct Assets {
    kuki: Address;
    token: Address;
}

struct Fees {
    pendingKuki: Int;
    pendingToken: Int;
    protocolFeeBps: Int;
    recipient: Address;
}

struct Wallets {
    kuki: Address;
    token: Address;
}

// ---------------------------------------------------------------------------
// Fixed-point helpers (mirror bot/src/math/fixed.ts)
// ---------------------------------------------------------------------------

fun divFloor(a: Int, b: Int): Int {
    let q: Int = a / b;
    if (a % b != 0 && ((a < 0) != (b < 0))) {
        q -= 1;
    }
    return q;
}

fun md(a: Int, b: Int, c: Int): Int {
    return divFloor(a * b, c);
}

fun lnT(x: Int): Int {
    if (x <= 0) {
        return 0;
    }
    if (x == SCALE) {
        return 0;
    }
    // normalise m = x * 2^k into [SCALE, 2*SCALE)
    let k: Int = 0;
    let m: Int = x;
    while (m < SCALE) {
        m = m * 2;
        k += 1;
    }
    let z: Int = md(m - SCALE, SCALE, m + SCALE);
    let z2: Int = md(z, z, SCALE);
    let term: Int = z;
    let sum: Int = z;
    let i: Int = 1;
    while (i <= 12) {
        term = md(term, z2, SCALE);
        sum += divFloor(term, 2 * i + 1);
        i += 1;
    }
    return 2 * sum - k * LN2;
}

fun expT(y: Int): Int {
    if (y >= 0) {
        return SCALE;
    }
    let a: Int = -y;
    let n: Int = a / LN2;
    let r: Int = a - n * LN2;
    let term: Int = SCALE;
    let sum: Int = SCALE;
    let neg: Bool = true;
    let i: Int = 1;
    while (i <= 20) {
        term = divFloor(md(term, r, SCALE), i);
        if (neg) {
            sum -= term;
        } else {
            sum += term;
        }
        neg = !neg;
        i += 1;
    }
    if (n > 62) {
        return 0;
    }
    return sum >> n;
}

fun powRatio(t: Int, num: Int, den: Int): Int {
    if (num == 0) {
        return SCALE;
    }
    if (t <= 0) {
        return 0;
    }
    if (t == SCALE) {
        return SCALE;
    }
    return expT(divFloor(lnT(t) * num, den));
}

/** Output of a weighted swap. */
fun amountOutOf(rIn: Int, rOut: Int, wIn: Int, wOut: Int, feeBps: Int, amt: Int): Int {
    let inEff: Int = amt * (BPS - feeBps) / BPS;
    if (inEff <= 0) {
        return 0;
    }
    if (wIn == wOut) {
        return rOut * inEff / (rIn + inEff);
    }
    let t: Int = md(rIn, SCALE, rIn + inEff);
    let u: Int = powRatio(t, wIn, wOut);
    let out: Int = md(rOut, SCALE - u, SCALE);
    if (out >= rOut) {
        return rOut - 1;
    }
    return out;
}

/** Weight-aware deposit value used for bootstrap shares; homogeneous of degree 1. */
fun depositValue(kukiAmt: Int, tokenAmt: Int, wKuki: Int, wToken: Int): Int {
    let vK: Int = md(kukiAmt, SCALE, wKuki);
    let vT: Int = md(tokenAmt, SCALE, wToken);
    return vK < vT ? vK : vT;
}

fun jettonTransferBody(amount: Int, to: Address, response: Address): Cell {
    return beginCell()
        .storeUint(0x0f8a7ea5, 32)
        .storeUint(0, 64)
        .storeCoins(amount)
        .storeAddress(to)
        .storeAddress(response)
        .storeUint(0, 1)
        .storeCoins(0)
        .storeUint(0, 1)
        .endCell();
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

contract WeightedPool {
    factory: Address;
    admin: Address;
    kuki: Address;
    token: Address;

    wKuki: Int as uint16;
    wToken: Int as uint16;
    feeBps: Int as uint16;

    /** Extra fee on the input, paid to the admin (protocol revenue). */
    protocolFeeBps: Int as uint16;
    pendingFeesKuki: Int;
    pendingFeesToken: Int;

    walletKuki: Address;
    walletToken: Address;
    boundKuki: Bool;
    boundToken: Bool;

    reserveKuki: Int;
    reserveToken: Int;

    totalShares: Int;
    shares: map<Address, Int>;
    pending: map<Address, Pending>;

    paused: Bool;
    /** true = the second asset is native TON (no jetton wallet for it). */
    tonSide: Bool;

    init(
        factory: Address,
        admin: Address,
        kuki: Address,
        token: Address,
        wKuki: Int,
        wToken: Int,
        feeBps: Int,
        tonSide: Bool,
    ) {
        require(wKuki > 0 && wKuki <= MAX_WEIGHT, "bad weight KUKI");
        require(wToken > 0 && wToken <= MAX_WEIGHT, "bad weight token");
        require(feeBps <= MAX_FEE_BPS, "bad fee");
        if (tonSide) {
            require(token == ZERO_ADDR, "ton pool has no token");
        } else {
            require(kuki != token, "same asset");
            require(token != ZERO_ADDR, "token required");
        }

        self.factory = factory;
        self.admin = admin;
        self.kuki = kuki;
        self.token = token;
        self.wKuki = wKuki;
        self.wToken = wToken;
        self.feeBps = feeBps;
        self.walletKuki = ZERO_ADDR;
        self.walletToken = ZERO_ADDR;
        self.boundKuki = false;
        self.boundToken = false;
        self.reserveKuki = 0;
        self.reserveToken = 0;
        self.totalShares = 0;
        self.protocolFeeBps = 0;
        self.pendingFeesKuki = 0;
        self.pendingFeesToken = 0;
        self.shares = emptyMap();
        self.pending = emptyMap();
        self.paused = false;
        self.tonSide = tonSide;
    }

    receive() {}

    receive("topup") {
        // anyone may fund the pool's gas balance
    }

    // -- admin -------------------------------------------------------------

    receive(msg: BindWallet) {
        require(sender() == self.admin, "admin only");
        require(msg.index <= 1, "bad index");
        require(msg.wallet != myAddress(), "self wallet");
        if (msg.index == 0) {
            require(!self.boundKuki, "already bound");
            self.walletKuki = msg.wallet;
            self.boundKuki = true;
        } else {
            require(!self.tonSide, "TON side has no jetton wallet");
            require(!self.boundToken, "already bound");
            self.walletToken = msg.wallet;
            self.boundToken = true;
        }
    }

    receive(msg: SetAdmin) {
        require(sender() == self.admin, "admin only");
        require(msg.newAdmin != ZERO_ADDR, "zero admin");
        self.admin = msg.newAdmin;
    }

    receive(msg: SetPaused) {
        require(sender() == self.admin, "admin only");
        self.paused = msg.paused;
    }

    receive(msg: SetFee) {
        require(sender() == self.admin, "admin only");
        require(msg.feeBps <= MAX_FEE_BPS, "bad fee");
        self.feeBps = msg.feeBps;
    }

    receive(msg: SetProtocolFee) {
        require(sender() == self.admin, "admin only");
        require(msg.feeBps <= 100, "bad protocol fee");
        self.protocolFeeBps = msg.feeBps;
    }

    /** Withdraw the accumulated protocol fees to the admin's address. */
    receive(msg: WithdrawFees) {
        require(sender() == self.admin, "admin only");
        require(context().value >= MIN_WITHDRAW_VALUE, "gas");
        let k: Int = self.pendingFeesKuki;
        let t: Int = self.pendingFeesToken;
        self.pendingFeesKuki = 0;
        self.pendingFeesToken = 0;
        if (k > 0) {
            self.sendJettons(self.walletKuki, k, msg.to);
        }
        if (t > 0) {
            if (self.tonSide) {
                self.sendTon(msg.to, t);
            } else {
                self.sendJettons(self.walletToken, t, msg.to);
            }
        }
    }

    receive(msg: WithdrawTon) {
        require(sender() == self.admin, "admin only");
        // Only the gas surplus can leave. In a TON pool the TON reserve is part
        // of the balance, so it must be excluded explicitly.
        if (self.tonSide) {
            require(myBalance() > self.reserveToken + self.pendingFeesToken + msg.amount + 100000000, "keep gas reserve");
        } else {
            require(myBalance() > msg.amount + 100000000, "keep gas reserve");
        }
        send(SendParameters{ to: msg.to, value: msg.amount, bounce: true, body: null });
    }

    // -- jetton entry point -------------------------------------------------

    receive(msg: JettonNotification) {
        let body: Slice = msg.forwardPayload;
        // TEP-74 forward_payload is Either Cell ^Cell: one selector bit, then
        // either the inline payload or a reference to it.
        if (body.bits() >= 1) {
            let isRef: Bool = body.loadBit();
            if (isRef) {
                body = body.loadRef().asSlice();
            }
        }

        // Identify the asset from the *wallet that notified us*, never from the
        // payload: a pool jetton wallet address is the only authentication we
        // have, and it cannot be forged by the sender.
        let idx: Int = -1;
        if (self.boundKuki && sender() == self.walletKuki) {
            idx = 0;
        } else if (self.boundToken && sender() == self.walletToken) {
            idx = 1;
        }
        if (idx < 0) {
            // Not a bound pool wallet: return the jettons to whoever sent them.
            self.sendJettons(sender(), msg.amount, msg.sender);
            return;
        }
        if (body.bits() < 32) {
            self.sendJettons(sender(), msg.amount, msg.sender);
            return;
        }

        let op: Int = body.loadUint(32);
        if (op == OP_SWAP) {
            let assetIn: Int = body.loadUint(8);
            let minOut: Int = body.loadCoins();
            let receiver: Address = body.loadAddress();
            let deadline: Int = body.loadUint(32);
            self.handleSwap(idx, assetIn, minOut, receiver, deadline, msg.amount, msg.sender);
            return;
        }
        if (op == OP_LIQ) {
            let nonce: Int = body.loadUint(64);
            let assetIdx: Int = body.loadUint(8);
            let minShares: Int = body.loadCoins();
            let deadline: Int = body.loadUint(32);
            let beneficiary: Address = body.loadAddress();
            self.handleLiquidity(idx, nonce, assetIdx, minShares, deadline, msg.amount, msg.sender, beneficiary);
            return;
        }

        self.sendJettons(sender(), msg.amount, msg.sender);
    }

    // -- swap ---------------------------------------------------------------

    fun handleSwap(
        idx: Int,
        assetIn: Int,
        minOut: Int,
        receiver: Address,
        deadline: Int,
        amountIn: Int,
        trader: Address,
    ) {
        let refundWallet: Address = sender();
        if (self.paused || assetIn != idx || amountIn <= 0 || deadline < now() || !self.ready()) {
            self.sendJettons(refundWallet, amountIn, trader);
            return;
        }
        // In a TON pool the jetton side only ever sells KUKI; TON enters through
        // `SwapTonIntent`.
        if (self.tonSide && assetIn != 0) {
            self.sendJettons(refundWallet, amountIn, trader);
            return;
        }

        // Protocol fee is taken from the input before the curve.
        let cut: Int = amountIn * self.protocolFeeBps / BPS;
        let netIn: Int = amountIn - cut;

        // Slippage: reject before touching state, refund the input.
        let out: Int = assetIn == 0
            ? amountOutOf(self.reserveKuki, self.reserveToken, self.wKuki, self.wToken, self.feeBps, netIn)
            : amountOutOf(self.reserveToken, self.reserveKuki, self.wToken, self.wKuki, self.feeBps, netIn);

        if (out <= 0 || out < minOut || out >= (assetIn == 0 ? self.reserveToken : self.reserveKuki)) {
            self.sendJettons(refundWallet, amountIn, trader);
            return;
        }

        if (assetIn == 0) {
            self.reserveKuki += netIn;
            self.pendingFeesKuki += cut;
            self.reserveToken -= out;
        } else {
            self.reserveToken += netIn;
            self.pendingFeesToken += cut;
            self.reserveKuki -= out;
        }

        let to: Address = receiver == myAddress() ? trader : receiver;
        if (assetIn == 0 && self.tonSide) {
            self.sendTon(to, out);
        } else {
            let outWallet: Address = assetIn == 0 ? self.walletToken : self.walletKuki;
            self.sendJettons(outWallet, out, to);
        }

        emit(
            SwapEvent{
                trader: trader,
                kukiIn: assetIn == 0,
                amountIn: amountIn,
                amountOut: out,
                reserveKuki: self.reserveKuki,
                reserveToken: self.reserveToken,
            }.toCell(),
        );
    }

    // -- liquidity ----------------------------------------------------------

    fun handleLiquidity(
        idx: Int,
        nonce: Int,
        assetIdx: Int,
        minShares: Int,
        deadline: Int,
        amount: Int,
        owner: Address,
        beneficiary: Address,
    ) {
        let refundWallet: Address = sender();
        if (self.paused || assetIdx != idx || amount <= 0 || deadline < now() || !self.ready()) {
            self.sendJettons(refundWallet, amount, owner);
            return;
        }
        if (self.tonSide && idx != 0) {
            self.sendJettons(refundWallet, amount, owner);
            return;
        }

        self.creditLiquidity(owner, idx, amount, nonce, minShares, deadline, beneficiary);
    }

    /** Shared by the jetton and the native-TON legs. */
    fun creditLiquidity(
        owner: Address,
        idx: Int,
        amount: Int,
        nonce: Int,
        minShares: Int,
        deadline: Int,
        beneficiary: Address,
    ) {
        let to: Address = beneficiary == ZERO_ADDR ? owner : beneficiary;
        let existing: Pending? = self.pending.get(owner);
        if (existing == null) {
            self.pending.set(
                owner,
                Pending{
                    nonce: nonce,
                    deadline: deadline,
                    minShares: minShares,
                    hasA: true,
                    aIdx: idx,
                    aAmt: amount,
                    hasB: false,
                    bIdx: 0,
                    bAmt: 0,
                    beneficiary: to,
                },
            );
            return;
        }

        let p: Pending = existing!!;
        if (p.nonce != nonce || p.hasB || p.aIdx == idx || p.minShares != minShares) {
            // A second, unrelated leg: never mix it into the open session.
            self.refundAsset(idx, amount, owner);
            return;
        }

        p.hasB = true;
        p.bIdx = idx;
        p.bAmt = amount;
        self.pending.del(owner);
        self.finalizeLiquidity(owner, p);
    }

    // -- native TON entry points --------------------------------------------

    receive(msg: SwapTonIntent) {
        require(self.tonSide, "not a TON pool");
        let trader: Address = sender();
        // The value must cover the swap plus the gas the pool keeps.
        require(context().value >= msg.amountIn + MIN_TON_GAS, "not enough TON");

        if (self.paused || !self.ready() || msg.amountIn <= 0 || msg.deadline < now()) {
            self.sendTon(trader, msg.amountIn);
            return;
        }

        let cut: Int = msg.amountIn * self.protocolFeeBps / BPS;
        let netIn: Int = msg.amountIn - cut;
        let out: Int = amountOutOf(
            self.reserveToken,
            self.reserveKuki,
            self.wToken,
            self.wKuki,
            self.feeBps,
            netIn,
        );
        if (out <= 0 || out < msg.minOut || out >= self.reserveKuki) {
            self.sendTon(trader, msg.amountIn);
            return;
        }

        self.reserveToken += netIn;
        self.pendingFeesToken += cut;
        self.reserveKuki -= out;

        let to: Address = msg.receiver == myAddress() ? trader : msg.receiver;
        self.sendJettons(self.walletKuki, out, to);

        emit(
            SwapEvent{
                trader: trader,
                kukiIn: false,
                amountIn: msg.amountIn,
                amountOut: out,
                reserveKuki: self.reserveKuki,
                reserveToken: self.reserveToken,
            }.toCell(),
        );
    }

    receive(msg: LiquidityTonPart) {
        require(self.tonSide, "not a TON pool");
        require(context().value >= MIN_TON_GAS, "not enough TON");
        let owner: Address = sender();
        let amount: Int = context().value - MIN_TON_GAS;

        if (self.paused || !self.ready() || amount <= 0 || msg.deadline < now()) {
            self.sendTon(owner, amount);
            return;
        }

        self.creditLiquidity(owner, 1, amount, msg.nonce, msg.minShares, msg.deadline, msg.beneficiary);
    }

    fun finalizeLiquidity(owner: Address, p: Pending) {
        let kukiAmt: Int = p.aIdx == 0 ? p.aAmt : p.bAmt;
        let tokenAmt: Int = p.aIdx == 0 ? p.bAmt : p.aAmt;

        if (kukiAmt <= 0 || tokenAmt <= 0) {
            self.refundPending(owner, p);
            return;
        }

        let minted: Int = 0;
        if (self.totalShares == 0) {
            // Bootstrap: the first provider sets the price. Shares are a
            // weight-normalised value proxy, so proportional deposits scale
            // shares exactly.
            minted = depositValue(kukiAmt, tokenAmt, self.wKuki, self.wToken);
        } else {
            let rK: Int = md(kukiAmt, SCALE, self.reserveKuki);
            let rT: Int = md(tokenAmt, SCALE, self.reserveToken);
            let diff: Int = rK > rT ? rK - rT : rT - rK;
            let hi: Int = rK > rT ? rK : rT;
            if (hi == 0 || md(diff, BPS, hi) > DEPOSIT_TOLERANCE_BPS) {
                self.refundPending(owner, p);
                return;
            }
            let ratio: Int = rK < rT ? rK : rT;
            minted = md(self.totalShares, ratio, SCALE);
        }

        if (minted <= 0 || minted < p.minShares) {
            self.refundPending(owner, p);
            return;
        }

        // Bootstrap lock: a sliver of the first position is assigned to the pool
        // itself, so totalShares can never be driven to zero.
        if (self.totalShares == 0) {
            let lock: Int = minted / BOOTSTRAP_LOCK_DIVISOR;
            if (lock < 1) {
                lock = 1;
            }
            if (lock >= minted) {
                lock = minted / 2;
            }
            self.shares.set(myAddress(), lock);
            self.totalShares = minted;
            self.shares.set(p.beneficiary, minted - lock);
        } else {
            self.totalShares += minted;
            let prevOpt: Int? = self.shares.get(p.beneficiary);
            let prev: Int = prevOpt == null ? 0 : prevOpt!!;
            self.shares.set(p.beneficiary, prev + minted);
        }

        self.reserveKuki += kukiAmt;
        self.reserveToken += tokenAmt;

        emit(
            LiquidityAdded{
                provider: p.beneficiary,
                shares: minted,
                kukiAmount: kukiAmt,
                tokenAmount: tokenAmt,
            }.toCell(),
        );
    }

    receive(msg: CancelLiquidity) {
        let p: Pending? = self.pending.get(sender());
        if (p == null) {
            return;
        }
        let pp: Pending = p!!;
        if (pp.nonce != msg.nonce) {
            return;
        }
        self.pending.del(sender());
        self.refundPending(sender(), pp);
    }

    receive(msg: ExpireLiquidity) {
        let p: Pending? = self.pending.get(msg.owner);
        if (p == null) {
            return;
        }
        let pp: Pending = p!!;
        if (now() <= pp.deadline) {
            return;
        }
        self.pending.del(msg.owner);
        self.refundPending(msg.owner, pp);
    }

    fun refundPending(owner: Address, p: Pending) {
        if (p.hasA) {
            self.refundAsset(p.aIdx, p.aAmt, owner);
        }
        if (p.hasB) {
            self.refundAsset(p.bIdx, p.bAmt, owner);
        }
    }

    fun refundAsset(idx: Int, amount: Int, to: Address) {
        if (self.tonSide && idx == 1) {
            self.sendTon(to, amount);
        } else {
            let w: Address = idx == 0 ? self.walletKuki : self.walletToken;
            self.sendJettons(w, amount, to);
        }
    }

    receive(msg: WithdrawLiquidity) {
        require(msg.shares > 0, "zero shares");
        require(context().value >= MIN_WITHDRAW_VALUE, "gas");

        let ownedOpt: Int? = self.shares.get(sender());
        let owned: Int = ownedOpt == null ? 0 : ownedOpt!!;
        require(msg.shares <= owned, "not enough shares");

        let kukiOut: Int = md(self.reserveKuki, msg.shares, self.totalShares);
        let tokenOut: Int = md(self.reserveToken, msg.shares, self.totalShares);
        require(kukiOut >= msg.minKuki, "kuki slippage");
        require(tokenOut >= msg.minToken, "token slippage");
        require(kukiOut > 0 && tokenOut > 0, "dust");

        self.shares.set(sender(), owned - msg.shares);
        self.totalShares -= msg.shares;
        self.reserveKuki -= kukiOut;
        self.reserveToken -= tokenOut;

        self.sendJettons(self.walletKuki, kukiOut, sender());
        if (self.tonSide) {
            self.sendTon(sender(), tokenOut);
        } else {
            self.sendJettons(self.walletToken, tokenOut, sender());
        }

        emit(
            LiquidityRemoved{
                provider: sender(),
                shares: msg.shares,
                kukiAmount: kukiOut,
                tokenAmount: tokenOut,
            }.toCell(),
        );
    }

    // -- helpers ------------------------------------------------------------

    fun ready(): Bool {
        return self.boundKuki && (self.tonSide || self.boundToken);
    }

    fun sendJettons(wallet: Address, amount: Int, to: Address) {
        send(
            SendParameters{
                to: wallet,
                value: GAS_JETTON,
                bounce: true,
                body: jettonTransferBody(amount, to, myAddress()),
            },
        );
    }

    fun sendTon(to: Address, amount: Int) {
        // Fees come from the gas surplus the pool keeps on every TON message.
        send(SendParameters{ to: to, value: amount, bounce: true, body: null });
    }

    // -- getters ------------------------------------------------------------

    get fun getPoolState(): PoolState {
        return PoolState{
            reserveKuki: self.reserveKuki,
            reserveToken: self.reserveToken,
            wKuki: self.wKuki,
            wToken: self.wToken,
            feeBps: self.feeBps,
            totalShares: self.totalShares,
            paused: self.paused,
            ready: self.ready(),
        };
    }

    get fun getShares(owner: Address): Int {
        let s: Int? = self.shares.get(owner);
        return s == null ? 0 : s!!;
    }

    get fun getPending(owner: Address): Pending? {
        return self.pending.get(owner);
    }

    /** Price of 1 token in KUKI, scaled by 1e18. */
    get fun getSpotPrice(): Int {
        if (self.reserveKuki == 0 || self.reserveToken == 0) {
            return 0;
        }
        return md(md(self.reserveKuki, self.wToken, self.wKuki), SCALE, self.reserveToken);
    }

    /**
     * Authoritative quote for a swap, computed by the pool itself.
     * The bot uses this instead of its local math to build `minOut`, so a
     * stale cache can never turn into a bad trade.
     */
    get fun getQuote(assetIn: Int, amountIn: Int): Int {
        if (amountIn <= 0 || !self.ready() || self.paused) {
            return 0;
        }
        let netIn: Int = amountIn - amountIn * self.protocolFeeBps / BPS;
        if (assetIn == 0) {
            return amountOutOf(self.reserveKuki, self.reserveToken, self.wKuki, self.wToken, self.feeBps, netIn);
        }
        return amountOutOf(self.reserveToken, self.reserveKuki, self.wToken, self.wKuki, self.feeBps, netIn);
    }

    get fun getAssets(): Assets {
        return Assets{ kuki: self.kuki, token: self.token };
    }

    get fun getWallets(): Wallets {
        return Wallets{ kuki: self.walletKuki, token: self.walletToken };
    }

    get fun getAdmin(): Address {
        return self.admin;
    }

    get fun getTonSide(): Bool {
        return self.tonSide;
    }

    get fun getFees(): Fees {
        return Fees{
            pendingKuki: self.pendingFeesKuki,
            pendingToken: self.pendingFeesToken,
            protocolFeeBps: self.protocolFeeBps,
            recipient: self.admin,
        };
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

message(0x4b554b20) CreatePool {
    token: Address;
    wKuki: Int as uint16;
    wToken: Int as uint16;
    feeBps: Int as uint16;
    tonSide: Bool;
}

message(0x4b554b21) PoolCreated {
    pool: Address;
    kuki: Address;
    token: Address;
    wKuki: Int;
    wToken: Int;
    feeBps: Int;
}

contract PoolFactory {
    owner: Address;
    kuki: Address;
    poolCount: Int;
    pools: map<Int, Address>;
    exists: map<Address, Bool>;

    init(owner: Address, kuki: Address) {
        self.owner = owner;
        self.kuki = kuki;
        self.poolCount = 0;
        self.pools = emptyMap();
        self.exists = emptyMap();
    }

    receive() {}

    receive(msg: CreatePool) {
        require(sender() == self.owner, "owner only");
        if (msg.tonSide) {
            require(msg.token == ZERO_ADDR, "TON pool has no token");
        } else {
            require(msg.token != self.kuki, "KUKI is the quote");
            require(msg.token != ZERO_ADDR, "token required");
        }
        require(msg.wKuki > 0 && msg.wKuki <= MAX_WEIGHT, "bad wKuki");
        require(msg.wToken > 0 && msg.wToken <= MAX_WEIGHT, "bad wToken");
        require(msg.feeBps <= MAX_FEE_BPS, "bad fee");

        let init: StateInit = initOf WeightedPool(
            myAddress(),
            self.owner,
            self.kuki,
            msg.token,
            msg.wKuki,
            msg.wToken,
            msg.feeBps,
            msg.tonSide,
        );
        let poolAddr: Address = contractAddress(init);
        require(self.exists.get(poolAddr) == null, "pool exists");

        self.exists.set(poolAddr, true);
        self.pools.set(self.poolCount, poolAddr);
        self.poolCount += 1;

        send(
            SendParameters{
                to: poolAddr,
                value: 50000000,
                bounce: true,
                code: init.code,
                data: init.data,
                body: null,
            },
        );

        emit(
            PoolCreated{
                pool: poolAddr,
                kuki: self.kuki,
                token: msg.token,
                wKuki: msg.wKuki,
                wToken: msg.wToken,
                feeBps: msg.feeBps,
            }.toCell(),
        );
    }

    get fun getPoolCount(): Int {
        return self.poolCount;
    }

    receive(msg: ChangeOwner) {
        require(sender() == self.owner, "owner only");
        require(msg.newOwner != ZERO_ADDR, "zero owner");
        self.owner = msg.newOwner;
    }

    get fun getOwner(): Address {
        return self.owner;
    }

    get fun getPool(index: Int): Address {
        return self.pools.get(index)!!;
    }

    get fun getKuki(): Address {
        return self.kuki;
    }
}
