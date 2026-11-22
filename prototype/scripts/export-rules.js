import { BrowserProvider, Contract, parseUnits } from "ethers";
import { network } from "hardhat";
import { resolve } from "node:path";
import { assetUnits, deployDemo, mined, resetDemo, writeManifest } from "./local-demo.js";

import { baselineReplayScenes, recordBaseline } from "./record-baseline.js";
import { studyCases } from "../verification/rule-study-cases.js";

const ONE = 10n ** 18n;
const allRules = ["v2.2", "variant_A", "variant_B", "variant_AB"];
const settlementStatuses = { 1: "Settled", 2: "Refunded", 4: "PartialFilled" };
const units = (amount) => parseUnits(amount, 18);

const scenarios = [
  ...[0, 5, 10].map((size) => ({
    id: `S2_sell_${size}`,
    rules: ["v2.2"],
    orders: size === 0
      ? [{ role: "alice", buy: true, amount: "20000", minimum: "0" }]
      : [
          { role: "alice", buy: true, amount: "20000", minimum: "0" },
          { role: "bob", buy: false, amount: String(size), minimum: "0" },
        ],
  })),
  {
    id: "A_reconsider",
    rules: allRules,
    orders: [
      { role: "alice", buy: true, amount: "20000", minimum: "9.7" },
      { role: "arb", buy: true, amount: "8000", minimum: "4" },
      { role: "bob", buy: false, amount: "10", minimum: "18000" },
    ],
  },
  {
    id: "B_partial",
    rules: allRules,
    orders: [
      { role: "alice", buy: true, amount: "24000", minimum: "12", partialMinimum: "20000" },
      { role: "bob", buy: false, amount: "10", minimum: "20000" },
    ],
  },
  {
    id: "AB_compound",
    rules: allRules,
    orders: [
      { role: "alice", buy: true, amount: "20000", minimum: "9.9" },
      { role: "arb", buy: true, amount: "8000", minimum: "4", partialMinimum: "4000" },
      { role: "bob", buy: false, amount: "10", minimum: "17000" },
      { role: "bot", buy: false, amount: "2", minimum: "4000" },
    ],
  },
  {
    id: "AB_preserve_payout",
    rules: allRules,
    orders: [
      { role: "alice", buy: true, amount: "20000", minimum: "9.85" },
      { role: "arb", buy: true, amount: "8000", minimum: "3.93", partialMinimum: "4000" },
      { role: "bob", buy: false, amount: "10", minimum: "17000" },
      { role: "bot", buy: false, amount: "1.9", minimum: "3800" },
    ],
  },
  {
    id: "S2_no_change",
    rules: allRules,
    orders: [
      { role: "alice", buy: true, amount: "20000", minimum: "9" },
      { role: "bob", buy: false, amount: "10", minimum: "18000" },
    ],
  },
];

function selectedRule(manifest, ruleVersion) {
  if (ruleVersion === "v2.2") {
    return {
      address: manifest.addresses.batchAuctionDEX,
      abi: manifest.abis.BatchAuctionDEX,
      buildVersion: manifest.buildVersion,
    };
  }
  return manifest.variants[ruleVersion];
}

async function recordScenario(provider, manifest, scenario, ruleVersion, fixedClock) {
  const rule = selectedRule(manifest, ruleVersion);
  const dex = new Contract(rule.address, rule.abi, provider);
  const eth = new Contract(manifest.addresses.mockETH, manifest.abis.MockToken, provider);
  const usdc = new Contract(manifest.addresses.mockUSDC, manifest.abis.MockToken, provider);
  const deployer = await provider.getSigner(manifest.roles.deployer);
  const supportsPartial = ruleVersion === "variant_B" || ruleVersion === "variant_AB";

  const gas = { submitOrder: 0, settleBatch: 0, claim: 0 };
  const steps = [];
  const settlementEvents = [];
  let settled = false;
  const batchId = 0;
  const initialBatch = await dex.batches(batchId);
  const initialState = {
    pool: { eth: String(await dex.reserveETH()), usdc: String(await dex.reserveUSDC()) },
    feeBps: manifest.initialState.feeBps,
    batchId,
    batchEndTime: Number(initialBatch.endTime),
    batchDurationSeconds: manifest.batchDurationSeconds,
  };

  async function record(action, actor, transaction, orderId = null) {
    const receipt = await mined(transaction);
    const block = await receipt.getBlock();
    const gasUsed = Number(receipt.gasUsed);
    gas[action] += gasUsed;
    if (action === "settleBatch") {
      settled = true;
      for (const log of receipt.logs) {
        if (log.address !== dex.target) continue;
        const event = dex.interface.parseLog(log);
        if (event && ["OrderReconsidered", "BatchPartialFill"].includes(event.name)) {
          settlementEvents.push({
            name: event.name,
            args: Object.fromEntries(event.fragment.inputs.map((input, index) => [
              input.name, String(event.args[index]),
            ])),
          });
        }
      }
    }
    const batch = await dex.batches(batchId);
    steps.push({
      label: action,
      actor,
      action,
      orderId,
      batchId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.index,
      timestamp: block.timestamp,
      gasUsed,
      poolStateAfter: {
        eth: String(await dex.reserveETH()),
        usdc: String(await dex.reserveUSDC()),
        ucp: settled ? String(batch.clearingPrice) : null,
        cowUSDC: settled ? String(batch.cowUSDC) : null,
      },
    });
  }

  for (const [orderId, order] of scenario.orders.entries()) {
    const trader = await provider.getSigner(manifest.roles[order.role]);
    const contract = dex.connect(trader);
    const args = [order.buy, units(order.amount), units(order.minimum)];
    if (fixedClock) {
      const latest = await provider.getBlock("latest");
      await provider.send("evm_setNextBlockTimestamp", [latest.timestamp + 1]);
    }
    const transaction = supportsPartial && order.partialMinimum
      ? contract.submitPartialOrder(...args, units(order.partialMinimum))
      : contract.submitOrder(...args);
    await record("submitOrder", order.role, transaction, orderId);
  }

  await provider.send("evm_setNextBlockTimestamp", [Number(initialBatch.endTime)]);
  await record("settleBatch", "deployer", dex.connect(deployer).settleBatch());
  const batch = await dex.batches(batchId);
  const reserves = { mETH: await dex.reserveETH(), mUSDC: await dex.reserveUSDC() };
  const tokens = { mETH: eth, mUSDC: usdc };
  const orders = [];
  const pending = { mETH: 0n, mUSDC: 0n };

  for (const [orderId, input] of scenario.orders.entries()) {
    const onChain = await dex.orders(orderId);
    const submittedIn = units(input.amount);
    const [assetIn, assetOut] = input.buy ? ["mUSDC", "mETH"] : ["mETH", "mUSDC"];
    const refunded = onChain.status === 2n;
    const receivedOut = supportsPartial ? onChain.receivedOut : (refunded ? 0n : onChain.payout);
    const filledIn = supportsPartial ? onChain.filledIn : (refunded ? 0n : submittedIn);
    const refundedIn = submittedIn - filledIn;
    const status = filledIn === 0n ? "Refunded" : filledIn === submittedIn ? "Settled" : "PartialFilled";
    if (onChain.trader !== manifest.roles[input.role] || onChain.amountIn !== submittedIn
      || onChain.batchId !== BigInt(batchId)
      || onChain.minOut !== units(input.minimum) || onChain.isBuyETH !== input.buy
      || settlementStatuses[String(onChain.status)] !== status || receivedOut < 0n || refundedIn < 0n
      || (receivedOut * submittedIn < units(input.minimum) * filledIn)
      || (supportsPartial && onChain.refundedIn !== refundedIn)) {
      throw new Error(`Unexpected accounting for ${ruleVersion} order ${orderId}`);
    }
    pending[assetIn] += refundedIn;
    pending[assetOut] += receivedOut;
    orders.push({
      id: `${scenario.id}-${input.role}-${orderId}`,
      orderId,
      batchId,
      trader: input.role,
      side: input.buy ? "buyETH" : "sellETH",
      assetIn,
      assetOut,
      submittedIn: String(submittedIn),
      minOut: String(units(input.minimum)),
      partialFillMinimum: input.partialMinimum ? String(units(input.partialMinimum)) : null,
      partialFillEnabled: supportsPartial && Boolean(input.partialMinimum),
      filledIn: String(filledIn),
      receivedOut: String(receivedOut),
      refundedIn: String(refundedIn),
      status,
    });
  }

  const dustWei = {};
  for (const [asset, token] of Object.entries(tokens)) {
    const surplus = await token.balanceOf(dex.target) - reserves[asset] - pending[asset];
    if (surplus < 0n) throw new Error(`Shortfall in ${asset}`);
    dustWei[asset] = String(surplus);
  }

  for (const order of orders) {
    const trader = await provider.getSigner(manifest.roles[order.trader]);
    const inbound = tokens[order.assetIn];
    const outbound = tokens[order.assetOut];
    const inBefore = await inbound.balanceOf(trader.address);
    const outBefore = await outbound.balanceOf(trader.address);
    await record("claim", order.trader, dex.connect(trader).claim(order.orderId), order.orderId);
    if (await inbound.balanceOf(trader.address) - inBefore !== BigInt(order.refundedIn)
      || await outbound.balanceOf(trader.address) - outBefore !== BigInt(order.receivedOut)) {
      throw new Error(`Claim amount mismatch for ${order.id}`);
    }
  }
  for (const [asset, token] of Object.entries(tokens)) {
    if (await token.balanceOf(dex.target) !== reserves[asset] + BigInt(dustWei[asset])) {
      throw new Error(`Unreconciled ${asset} after claims`);
    }
  }

  return {
    scenarioId: scenario.id,
    ruleVersion,
    buildVersion: rule.buildVersion,
    evidenceSource: "hardhat",
    chainId: manifest.chainId,
    addresses: { ...manifest.addresses, batchAuctionDEX: dex.target },
    roles: manifest.roles,
    initialState,
    clearingPrice: String(batch.clearingPrice),
    cowUSDC: String(batch.cowUSDC),
    dustWei,
    settleGas: gas.settleBatch,
    gas: {
      byAction: gas,
      total: gas.submitOrder + gas.settleBatch + gas.claim,
      orderCount: orders.length,
      includesApproval: false,
    },
    orders,
    steps,
    settlementEvents,
    batches: [{
      batchId,
      endTime: initialState.batchEndTime,
      initialPool: initialState.pool,
      finalPool: { eth: String(reserves.mETH), usdc: String(reserves.mUSDC) },
      clearingPrice: String(batch.clearingPrice),
      cowUSDC: String(batch.cowUSDC),
      refundedCount: Number(batch.refundedCount),
      dustWei,
    }],
  };
}

const study = process.argv[2] === "--study";
const connection = await network.create();
const provider = new BrowserProvider({ request: (request) => connection.provider.request(request) },
  undefined, { cacheTimeout: -1 });
try {
  let manifest = await deployDemo(provider, { includeVariants: true });
  const traces = [];
  if (study) {
    const cases = [...scenarios.filter(({ rules }) => rules === allRules), ...studyCases()];
    for (const scenario of cases) {
      for (const rule of allRules) {
        traces.push(await recordScenario(provider, manifest, scenario, rule, true));
        manifest = await resetDemo(provider, manifest);
      }
    }
    const path = resolve(process.argv[3] ?? "runtime/rule_study_trace.json");
    await writeManifest(path, {
      schemaVersion: 1,
      assetUnits,
      cases: cases.map(({ id, reverseOf }) => ({ id, ...(reverseOf ? { reverseOf } : {}) })),
      scenarios: traces,
    });
    console.log(`Exported ${traces.length} study runs to ${path}`);
  } else {
    for (const scenario of scenarios) {
      for (const ruleVersion of scenario.rules) {
        traces.push(await recordScenario(provider, manifest, scenario, ruleVersion));
        manifest = await resetDemo(provider, manifest);
      }
    }
    for (const scene of baselineReplayScenes) {
      const rules = scene.compareAMM ? ["v2.2", "traditional_amm"] : ["v2.2"];
      for (const ruleVersion of rules) {
        traces.push(await recordBaseline(provider, manifest, scene, ruleVersion));
        manifest = await resetDemo(provider, manifest);
      }
    }
    const lookup = (id, rule) => traces.find((entry) => entry.scenarioId === id && entry.ruleVersion === rule);
    const a = lookup("A_reconsider", "variant_A");
    const b = lookup("B_partial", "variant_B");
    if (BigInt(a.cowUSDC) !== 20000n * ONE || BigInt(b.cowUSDC) !== 20000n * ONE
      || b.orders[0].status !== "PartialFilled" || BigInt(b.orders[0].refundedIn) !== 4000n * ONE) {
      throw new Error("Expected showcase outcomes were not reproduced");
    }
    const partialPrice = (200000n * 1000n + 20000n * 997n) * ONE / (105n * 997n);
    const s2 = [0, 5, 10].map((size) => lookup(`S2_sell_${size}`, "v2.2"));
    if (s2[0].cowUSDC !== "0" || BigInt(s2[1].cowUSDC) !== partialPrice * 5n
      || BigInt(s2[2].cowUSDC) !== 20000n * ONE) {
      throw new Error("S2 does not agree with the independently calculated direct matching totals");
    }
    const stable = allRules.map((rule) => lookup("S2_no_change", rule));
    const economics = (entry) => JSON.stringify([entry.cowUSDC, entry.clearingPrice, entry.orders]);
    if (stable.slice(1).some((entry) => economics(entry) !== economics(stable[0]))) {
      throw new Error("Unexpected mechanism effect on the unchanged-order control");
    }
    const compound = allRules.map((rule) => lookup("AB_compound", rule));
    if (compound.some((entry, index) => BigInt(entry.cowUSDC) !== [0n, 20000n, 24000n, 24000n][index] * ONE)
      || JSON.stringify(compound[2].orders) !== JSON.stringify(compound[3].orders)
      || compound[3].settlementEvents.map(({ name }) => name).join(",") !== "OrderReconsidered,BatchPartialFill") {
      throw new Error("The combined fixture did not reproduce both stages and the expected payouts");
    }
    const protectedA = lookup("AB_preserve_payout", "variant_A");
    const protectedB = lookup("AB_preserve_payout", "variant_B");
    const protectedAB = lookup("AB_preserve_payout", "variant_AB");
    if (BigInt(protectedB.cowUSDC) <= BigInt(protectedA.cowUSDC)
      || BigInt(protectedB.orders[0].receivedOut) >= BigInt(protectedA.orders[0].receivedOut)
      || protectedAB.cowUSDC !== protectedA.cowUSDC
      || protectedAB.orders[0].receivedOut !== protectedA.orders[0].receivedOut) {
      throw new Error("The protected payout control did not reproduce the expected tradeoff");
    }
    const path = resolve(process.argv[2] ?? "verification/rule_comparison_trace.json");
    await writeManifest(path, { schemaVersion: 1, assetUnits, clearingPriceDecimals: 18, scenarios: traces });
    console.log(`Exported ${traces.length} rule runs to ${path}`);
  }
} finally {
  provider.destroy();
  await connection.close();
}
