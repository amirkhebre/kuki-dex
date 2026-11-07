/**
 * Create (or load) the temporary deployment wallet — the "relayer".
 *
 * The user funds this wallet with just enough TON to deploy. After the pool is
 * created the script hands the pool admin rights and the factory ownership to
 * ADMIN_ADDRESS, so the relayer keeps no control.
 *
 * The 24 words are written to `.relayer.json` (gitignored) and never printed.
 *
 *   node dist/scripts/new-relayer.js
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

const FILE = ".relayer.json";

type RelayerFile = { mnemonic: string[]; address: string };

async function addressFor(mnemonic: string[]): Promise<string> {
  const key = await mnemonicToPrivateKey(mnemonic);
  return WalletContractV4.create({ workchain: 0, publicKey: key.publicKey }).address.toString();
}

let relayer: RelayerFile;
if (existsSync(FILE)) {
  relayer = JSON.parse(readFileSync(FILE, "utf8")) as RelayerFile;
  console.log("existing relayer wallet loaded");
} else {
  const mnemonic = await mnemonicNew(24);
  relayer = { mnemonic, address: await addressFor(mnemonic) };
  writeFileSync(FILE, JSON.stringify(relayer, null, 2), { mode: 0o600 });
  console.log("new relayer wallet created (key in .relayer.json)");
}

console.log(`address: ${relayer.address}`);
console.log("\nSend the deployment budget to this address, then run scripts/deploy.ts.");
