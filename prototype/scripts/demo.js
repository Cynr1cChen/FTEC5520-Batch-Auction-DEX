import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deployDemo, localProvider, resetDemo, writeManifest } from "./local-demo.js";

const [command, ...options] = process.argv.slice(2);
const includeVariants = options.includes("--variants");
const paths = options.filter((arg) => arg !== "--variants");
const [output = "runtime/deployment.json"] = paths;
if (!["deploy", "reset"].includes(command) || paths.length > 1
  || (includeVariants && command !== "deploy")) {
  throw new Error("Usage: node scripts/demo.js {deploy|reset} [deployment.json] [--variants]");
}

const path = resolve(output);
const provider = localProvider(process.env.FTEC5520_RPC_URL);
try {
  const manifest = command === "deploy"
    ? await deployDemo(provider, { includeVariants })
    : await resetDemo(provider, JSON.parse(await readFile(path, "utf8")));
  await writeManifest(path, manifest);
  console.log(`${command}: ${path} on chain ${manifest.chainId}`);
} finally {
  provider.destroy();
}
