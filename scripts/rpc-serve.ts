// Ephemeral RPC server for tests: prints RPC_PORT=<n> and runs until killed.
// Usage: npx tsx scripts/rpc-serve.ts [--chrome-path <exe>]
import { RpcServer } from "../src/rpc/server.js";
import { findChrome } from "../src/transport.js";

const i = process.argv.indexOf("--chrome-path");
const exe = i >= 0 ? process.argv[i + 1] : findChrome() ?? undefined;
const s = new RpcServer({
  mode: "managed",
  browser: exe ? { executablePath: exe } : {},
  headless: true,
});
const port = await s.start(0);
console.log(`RPC_PORT=${port}`);
const shutdown = async () => { await s.stop(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise(() => {});
