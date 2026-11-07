/**
 * Minimal TEP-74 jetton used only by the test-suite.
 *
 * It is deliberately small: mint, transfer, transfer-notification. It follows
 * the standard wire format closely enough to exercise the pool exactly the way
 * a real jetton would (Either-encoded forward payload, wallet deployment on
 * first transfer, excesses back to the sender).
 */

message(0x0f8a7ea5) TokenTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    destination: Address;
    responseDestination: Address;
    customPayload: Cell?;
    forwardTonAmount: Int as coins;
    forwardPayload: Cell?;
}

message(0x178d4519) TokenInternalTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    from: Address;
    responseAddress: Address;
    forwardTonAmount: Int as coins;
    forwardPayload: Cell?;
}

message(0x7362d09c) TokenNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forwardPayload: Cell?;
}

message(0xd53276db) Excesses {
    queryId: Int as uint64;
}

message(0x4b554b30) Mint {
    to: Address;
    amount: Int;
}

struct WalletData {
    balance: Int;
    owner: Address;
    master: Address;
}

contract TestJettonWallet {
    balance: Int;
    owner: Address;
    master: Address;

    init(owner: Address, master: Address) {
        self.balance = 0;
        self.owner = owner;
        self.master = master;
    }

    receive() {}

    receive(msg: TokenInternalTransfer) {
        self.balance += msg.amount;
        if (msg.forwardTonAmount > 0 && msg.forwardPayload != null) {
            send(
                SendParameters{
                    to: self.owner,
                    value: msg.forwardTonAmount,
                    bounce: false,
                    body: TokenNotification{
                        queryId: msg.queryId,
                        amount: msg.amount,
                        sender: msg.from,
                        forwardPayload: msg.forwardPayload,
                    }.toCell(),
                },
            );
        }
    }

    receive(msg: TokenTransfer) {
        require(sender() == self.owner, "not owner");
        require(self.balance >= msg.amount, "insufficient balance");
        require(msg.amount > 0, "zero amount");

        self.balance -= msg.amount;

        let dest: StateInit = initOf TestJettonWallet(msg.destination, self.master);
        send(
            SendParameters{
                to: contractAddress(dest),
                value: msg.forwardTonAmount + 30000000,
                bounce: true,
                code: dest.code,
                data: dest.data,
                body: TokenInternalTransfer{
                    queryId: msg.queryId,
                    amount: msg.amount,
                    from: self.owner,
                    responseAddress: msg.responseDestination,
                    forwardTonAmount: msg.forwardTonAmount,
                    forwardPayload: msg.forwardPayload,
                }.toCell(),
            },
        );

        let excess: Int = context().value - msg.forwardTonAmount - 50000000;
        if (excess > 0) {
            send(
                SendParameters{
                    to: msg.responseDestination,
                    value: excess,
                    mode: 0,
                    bounce: false,
                    body: Excesses{ queryId: msg.queryId }.toCell(),
                },
            );
        }
    }

    get fun getWalletData(): WalletData {
        return WalletData{ balance: self.balance, owner: self.owner, master: self.master };
    }
}

contract TestJettonMinter {
    admin: Address;
    totalSupply: Int;
    id: Int;

    init(admin: Address, id: Int) {
        self.admin = admin;
        self.totalSupply = 0;
        self.id = id;
    }

    receive() {}

    receive(msg: Mint) {
        require(sender() == self.admin, "admin only");
        require(msg.amount > 0, "zero amount");

        self.totalSupply += msg.amount;

        let w: StateInit = initOf TestJettonWallet(msg.to, myAddress());
        send(
            SendParameters{
                to: contractAddress(w),
                value: 40000000,
                bounce: true,
                code: w.code,
                data: w.data,
                body: TokenInternalTransfer{
                    queryId: 0,
                    amount: msg.amount,
                    from: myAddress(),
                    responseAddress: myAddress(),
                    forwardTonAmount: 0,
                    forwardPayload: null,
                }.toCell(),
            },
        );
    }

    get fun getTotalSupply(): Int {
        return self.totalSupply;
    }
}
