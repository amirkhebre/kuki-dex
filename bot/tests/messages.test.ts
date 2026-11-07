import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Address, toNano } from "@ton/core";

import { OP_KUKI_SWAP, jettonTransferBody, kukiSwapPayload } from "../src/exec/messages.ts";

describe("swap wire format", () => {
  it("encodes the jetton transfer with the swap intent as a ref payload", () => {
    const receiver = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
    const payload = kukiSwapPayload({ assetIn: 1n, minOut: 123n, receiver, deadline: 1_800_000_000 });
    const body = jettonTransferBody({
      amount: 10n ** 9n,
      destination: receiver,
      responseDestination: receiver,
      forwardTonAmount: toNano("0.08"),
      forwardPayload: payload,
    });

    const s = body.beginParse();
    assert.equal(s.loadUint(32), 0x0f8a7ea5, "jetton transfer opcode");
    assert.equal(s.loadUint(64).toString(), "0", "query id");
    assert.equal(s.loadCoins(), 10n ** 9n);
    s.loadAddress();
    s.loadAddress();
    assert.equal(s.loadBit(), false, "no custom payload");
    assert.equal(s.loadCoins(), toNano("0.08"));
    assert.equal(s.loadBit(), true, "forward payload stored as a ref (Either ^Cell)");
    const inner = s.loadRef().asSlice();

    assert.equal(inner.loadUint(32), OP_KUKI_SWAP);
    assert.equal(inner.loadUint(8), 1);
    assert.equal(inner.loadCoins(), 123n);
    inner.loadAddress();
    assert.equal(inner.loadUint(32), 1_800_000_000);
    assert.equal(inner.remainingBits, 0);
  });
});
