/** CLI entry: `node bot/src/index.ts` (or `pnpm bot`). */
import { loadConfig } from "./config.ts";
import { runForever } from "./bot.ts";

const config = loadConfig();
if (!config.kukiPool) {
  console.error("KUKI_POOL is not set. Deploy the pool first (see scripts/deploy.ts) and put its address in .env.");
  process.exit(1);
}

process.on("SIGINT", () => {
  console.log("\nstopped");
  process.exit(0);
});

await runForever(config);
