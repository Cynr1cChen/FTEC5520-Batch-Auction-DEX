import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Contract, ContractFactory, JsonRpcProvider, MaxUint256, parseUnits } from "ethers";

export const assetUnits = { mETH: 18, mUSDC: 18 };
export const batchDurationSeconds = 120;
export const initialETH = parseUnits("100", 18);
export const initialUSDC = parseUnits("200000", 18);
const demoChainId = 31337;

export function localProvider(rpcUrl = "http://127.0.0.1:8545") {
  const url = new URL(rpcUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The mock-token demo requires a loopback HTTP RPC URL");
  }
  return new JsonRpcProvider(url.href, undefined, { cacheTimeout: -1 });
}

async function nodeMetadata(provider) {
  const metadata = await provider.send("hardhat_metadata", []);
  if (metadata.chainId !== demoChainId || typeof metadata.instanceId !== "string") {
    throw new Error("Expected a Hardhat local node on chain 31337");
  }
  return metadata;
}

export async function artifact(name) {
  const path = new URL(`../artifacts/contracts/${name}.sol/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8"));
}

export async function mined(transaction) {
  const receipt = await (await transaction).wait();
  if (receipt?.status !== 1) {
    throw new Error("Failed to confirm demo transaction");
  }
  return receipt;
}

export async function writeManifest(path, manifest) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function buildVersion(compiled) {
  return "sha256:" + createHash("sha256").update(Buffer.from(compiled.bytecode.slice(2), "hex")).digest("hex");
}

export async function deployDemo(provider, { includeVariants = false } = {}) {
  const metadata = await nodeMetadata(provider);
  const [mock, traditional, auction] = await Promise.all([
    artifact("MockToken"),
    artifact("TraditionalAMM"),
    artifact("BatchAuctionDEX"),
  ]);
  const variantNames = includeVariants ? [
    ["variant_A", "BatchAuctionDEXReconsideration"],
    ["variant_B", "BatchAuctionDEXPartialFill"],
    ["variant_AB", "BatchAuctionDEXCombined"],
  ] : [];
  const variantArtifacts = await Promise.all(variantNames.map(([, name]) => artifact(name)));
  const [deployer, alice, bot, bob, arb] = await Promise.all(
    [0, 1, 2, 3, 4].map((index) => provider.getSigner(index)),
  );

  async function deploy(compiled, ...args) {
    const contract = await new ContractFactory(compiled.abi, compiled.bytecode, deployer).deploy(...args);
    await mined(contract.deploymentTransaction());
    return contract;
  }

  const snapshotBeforeDeploy = await provider.send("evm_snapshot", []);
  try {
    const eth = await deploy(mock, "Mock Ether", "mETH");
    const usdc = await deploy(mock, "Mock USD Coin", "mUSDC");
    const amm = await deploy(traditional, eth.target, usdc.target);
    const dex = await deploy(auction, eth.target, usdc.target, batchDurationSeconds);

    const variants = [];
    for (const [index, [rule]] of variantNames.entries()) {
      const args = [eth.target, usdc.target, batchDurationSeconds];
      if (rule !== "variant_A") args.push(dex.target);
      variants.push(await deploy(variantArtifacts[index], ...args));
    }
    const pools = [amm, dex, ...variants];
    for (const token of [eth, usdc]) {
      const seed = token === eth ? initialETH : initialUSDC;
      await mined(token.mint(deployer.address, seed * BigInt(pools.length)));
      for (const pool of pools) {
        await mined(token.approve(pool.target, seed));
      }
      for (const signer of [alice, bot, bob, arb]) {
        await mined(token.mint(signer.address, seed));
        for (const pool of pools) {
          await mined(token.connect(signer).approve(pool.target, MaxUint256));
        }
      }
    }
    for (const pool of pools) {
      await mined(pool.initPool(initialETH, initialUSDC));
    }
    const snapshotBlock = await provider.getBlock("latest");
    const [batch, ...variantBatches] = await Promise.all([dex, ...variants].map((pool) => pool.batches(0)));
    for (const head of [batch, ...variantBatches]) {
      if (BigInt(snapshotBlock.timestamp) >= head.endTime) {
        throw new Error("Demo batch expired before seed completed");
      }
    }
    const snapshotId = await provider.send("evm_snapshot", []);
    return {
      schemaVersion: 1,
      chainId: demoChainId,
      nodeInstanceId: metadata.instanceId,
      ruleVersion: "v2.2",
      buildVersion: buildVersion(auction),
      traditionalAMMBuildVersion: buildVersion(traditional),
      assetUnits,
      batchDurationSeconds,
      initialSnapshotId: snapshotId,
      snapshotBlockHash: snapshotBlock.hash,
      addresses: {
        mockETH: eth.target,
        mockUSDC: usdc.target,
        traditionalAMM: amm.target,
        batchAuctionDEX: dex.target,
      },
      roles: { deployer: deployer.address, alice: alice.address, bot: bot.address, bob: bob.address, arb: arb.address },
      abis: { MockToken: mock.abi, TraditionalAMM: traditional.abi, BatchAuctionDEX: auction.abi },
      variants: Object.fromEntries(variants.map((variant, index) => {
        const compiled = variantArtifacts[index];
        return [variantNames[index][0], {
          address: variant.target,
          abi: compiled.abi,
          buildVersion: buildVersion(compiled),
          batchEndTime: Number(variantBatches[index].endTime),
        }];
      })),
      initialState: {
        pool: { eth: initialETH.toString(), usdc: initialUSDC.toString() },
        feeBps: 30,
        batchId: 0,
        batchEndTime: Number(batch.endTime),
      },
    };
  } catch (error) {
    const reverted = await provider.send("evm_revert", [snapshotBeforeDeploy]).catch(() => false);
    if (!reverted) {
      throw new Error("Demo deployment failed and rollback could not be confirmed", { cause: error });
    }
    throw error;
  }
}

export async function resetDemo(provider, manifest) {
  if (manifest.schemaVersion !== 1 || manifest.chainId !== demoChainId) {
    throw new Error("Unsupported deployment manifest");
  }
  const metadata = await nodeMetadata(provider);
  if (metadata.instanceId !== manifest.nodeInstanceId) {
    throw new Error("The manifest belongs to a previous node instance. Redeploy the demo.");
  }
  const reverted = await provider.send("evm_revert", [manifest.initialSnapshotId]);
  if (!reverted) {
    throw new Error("Demo snapshot is stale. Redeploy the demo.");
  }
  const block = await provider.getBlock("latest");
  if (block.hash !== manifest.snapshotBlockHash) {
    throw new Error("Reset reached a different block. Redeploy the demo.");
  }
  const deployments = [
    { address: manifest.addresses.batchAuctionDEX, abi: manifest.abis.BatchAuctionDEX },
    ...Object.values(manifest.variants ?? {}),
  ];
  for (const { address, abi } of deployments) {
    const dex = new Contract(address, abi, provider);
    if (await dex.currentBatchId() !== BigInt(manifest.initialState.batchId)
      || await dex.reserveETH() !== BigInt(manifest.initialState.pool.eth)
      || await dex.reserveUSDC() !== BigInt(manifest.initialState.pool.usdc)
      || await dex.ordersLength() !== 0n) {
      throw new Error("Reset reached a different state. Redeploy the demo.");
    }
  }
  return { ...manifest, initialSnapshotId: await provider.send("evm_snapshot", []) };
}
