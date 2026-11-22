import assert from "node:assert/strict";
import { Contract, parseUnits } from "ethers";
import { mined } from "./local-demo.js";

const units = (value) => parseUnits(value, 18);
const buyer = { role: "alice", buy: true, amount: "20000", minimum: "0" };
const seller = { role: "bob", buy: false, amount: "10", minimum: "0" };

export const baselineReplayScenes = [
  { id: "S1_ordinary_buy_first", orders: [buyer, seller], compareAMM: true },
  { id: "S1_ordinary_sell_first", orders: [seller, buyer], compareAMM: true },
  {
    id: "T06_single_exclusion", showRounds: true,
    orders: [buyer, seller, { role: "arb", buy: true, amount: "2000", minimum: "5" }],
  },
  {
    id: "T06b_cascading_exclusion", showRounds: true,
    orders: [buyer, seller, { role: "bot", buy: true, amount: "60000", minimum: "30" },
      { role: "arb", buy: false, amount: "10", minimum: "23000" }],
  },
  ...[false, true].map((additionalSeller) => ({
    id: additionalSeller ? "S3_inventory_with_additional_seller" : "S3_inventory_alone",
    inventoryRole: "bot",
    orders: [{ role: "bot", buy: true, amount: "30000", minimum: "0" }, buyer],
    nextBatch: [
      { role: "bot", buy: false, amountFromOrder: 0, minimum: "0" },
      ...(additionalSeller ? [{ role: "arb", buy: false, amount: "15", minimum: "0" }] : []),
    ],
  })),
];

// The deployed solver supplies quotes for the original rule. The round list is
// derived from those quotes and checked against final storage, not an event log.
async function quoteRounds(dex, pool, submitted) {
  let active = submitted;
  const rounds = [];
  for (;;) {
    const sumSide = (buy) => active.filter((order) => order.buy === buy)
      .reduce((total, order) => total + order.amountIn, 0n);
    const buyTotal = sumSide(true);
    const sellTotal = sumSide(false);
    const quote = await dex._solve(BigInt(pool.eth), BigInt(pool.usdc), buyTotal, sellTotal);
    const checks = active.map(({ orderId, buy, amountIn, minOut }) => {
      const totalPayout = buy ? quote.ethToBuyers : quote.usdcToSellers;
      const quotedOut = amountIn * totalPayout / (buy ? buyTotal : sellTotal);
      return { orderId, quotedOut: String(quotedOut), minOut: String(minOut), excluded: quotedOut < minOut };
    });
    const excluded = new Set(checks.filter((order) => order.excluded).map((order) => order.orderId));
    rounds.push({ round: rounds.length, clearingPrice: String(quote.price), buyTotal: String(buyTotal),
      sellTotal: String(sellTotal), checks, excludedOrderIds: [...excluded] });
    if (excluded.size === 0) return rounds;
    active = active.filter((order) => !excluded.has(order.orderId));
  }
}

export async function recordBaseline(provider, manifest, scene, ruleVersion) {
  const amm = ruleVersion === "traditional_amm";
  const address = amm ? manifest.addresses.traditionalAMM : manifest.addresses.batchAuctionDEX;
  const abi = amm ? manifest.abis.TraditionalAMM : manifest.abis.BatchAuctionDEX;
  const pool = new Contract(address, abi, provider);
  const eth = new Contract(manifest.addresses.mockETH, manifest.abis.MockToken, provider);
  const usdc = new Contract(manifest.addresses.mockUSDC, manifest.abis.MockToken, provider);
  const tokens = { mETH: eth, mUSDC: usdc };
  const gas = amm ? { swap: 0 } : { submitOrder: 0, settleBatch: 0, claim: 0 };
  const steps = [];
  const orders = [];
  const batches = [];
  const unclaimed = new Map();

  const reserves = async () => ({ eth: String(await pool.reserveETH()), usdc: String(await pool.reserveUSDC()) });
  const initialState = { pool: await reserves(), feeBps: manifest.initialState.feeBps };
  if (!amm) Object.assign(initialState, manifest.initialState, { batchDurationSeconds: manifest.batchDurationSeconds });

  async function record(action, actor, transaction, batchId = null, orderId = null) {
    const receipt = await mined(transaction);
    const block = await receipt.getBlock();
    const batch = batchId === null ? null : await pool.batches(batchId);
    const gasUsed = Number(receipt.gasUsed);
    gas[action] += gasUsed;
    steps.push({
      label: action, action, actor, orderId, batchId,
      txHash: receipt.hash, blockNumber: receipt.blockNumber, transactionIndex: receipt.index,
      timestamp: block.timestamp, gasUsed,
      poolStateAfter: { ...await reserves(), ucp: batch?.settled ? String(batch.clearingPrice) : null,
        cowUSDC: batch?.settled ? String(batch.cowUSDC) : null },
    });
  }

  async function dust() {
    const balances = await reserves();
    const accounted = { mETH: BigInt(balances.eth), mUSDC: BigInt(balances.usdc) };
    for (const order of unclaimed.values()) {
      accounted[order.assetIn] += BigInt(order.refundedIn);
      accounted[order.assetOut] += BigInt(order.receivedOut);
    }
    const surplus = {};
    for (const [asset, token] of Object.entries(tokens)) {
      const amount = await token.balanceOf(address) - accounted[asset];
      assert.ok(amount >= 0n, `${scene.id}: ${asset} shortfall`);
      surplus[asset] = String(amount);
    }
    return surplus;
  }

  async function claim(order) {
    const signer = await provider.getSigner(manifest.roles[order.trader]);
    const inbound = tokens[order.assetIn];
    const outbound = tokens[order.assetOut];
    const beforeIn = await inbound.balanceOf(signer.address);
    const beforeOut = await outbound.balanceOf(signer.address);
    const expectedDust = await dust();
    await record("claim", order.trader, pool.connect(signer).claim(order.orderId), order.batchId, order.orderId);
    assert.equal(await inbound.balanceOf(signer.address) - beforeIn, BigInt(order.refundedIn));
    assert.equal(await outbound.balanceOf(signer.address) - beforeOut, BigInt(order.receivedOut));
    assert.equal((await pool.orders(order.orderId)).status, 3n);
    unclaimed.delete(order.orderId);
    assert.deepEqual(await dust(), expectedDust);
  }

  const inventory = scene.inventoryRole ? manifest.roles[scene.inventoryRole] : null;
  const initialInventory = inventory ? await eth.balanceOf(inventory) : null;
  const initialCash = inventory ? await usdc.balanceOf(inventory) : null;
  const stages = scene.nextBatch ? [scene.orders, scene.nextBatch] : [scene.orders];
  for (const [batchIndex, inputs] of stages.entries()) {
    const batchId = amm ? null : batchIndex;
    const before = await reserves();
    const window = amm ? null : await pool.batches(batchId);
    const submitted = [];
    for (const input of inputs) {
      const { role, buy, minimum, amount, amountFromOrder } = input;
      const orderId = orders.length + submitted.length;
      const amountIn = amountFromOrder === undefined ? units(amount) : BigInt(orders[amountFromOrder].receivedOut);
      const minOut = units(minimum);
      const [assetIn, assetOut] = buy ? ["mUSDC", "mETH"] : ["mETH", "mUSDC"];
      const signer = await provider.getSigner(manifest.roles[role]);
      const contract = pool.connect(signer);
      const order = { id: `${scene.id}-${role}-${orderId}`, orderId, batchId, trader: role,
        side: buy ? "buyETH" : "sellETH", assetIn, assetOut, submittedIn: String(amountIn),
        minOut: String(minOut), partialFillMinimum: null, partialFillEnabled: false };
      if (amm) {
        const outBefore = await tokens[assetOut].balanceOf(signer.address);
        const inBefore = await tokens[assetIn].balanceOf(signer.address);
        const swap = buy ? contract.swapUSDCForETH : contract.swapETHForUSDC;
        await record("swap", role, swap(amountIn, minOut), null, orderId);
        assert.equal(inBefore - await tokens[assetIn].balanceOf(signer.address), amountIn);
        const received = await tokens[assetOut].balanceOf(signer.address) - outBefore;
        assert.ok(received > 0n && received >= minOut);
        orders.push({ ...order, filledIn: String(amountIn), receivedOut: String(received), refundedIn: "0", status: "Settled" });
      } else {
        await record("submitOrder", role, contract.submitOrder(buy, amountIn, minOut), batchId, orderId);
        submitted.push({ ...order, buy, amountIn });
      }
    }
    if (amm) continue;

    const rounds = scene.showRounds
      ? await quoteRounds(pool, before, submitted.map((order) => ({ ...order, minOut: BigInt(order.minOut) }))) : null;
    const operator = await provider.getSigner(manifest.roles.deployer);
    await provider.send("evm_setNextBlockTimestamp", [Number(window.endTime)]);
    await record("settleBatch", "deployer", pool.connect(operator).settleBatch(), batchId);
    const settled = await pool.batches(batchId);
    assert.equal(settled.orderCount, BigInt(submitted.length));
    const excluded = [];
    for (const { buy, amountIn, ...order } of submitted) {
      const result = await pool.orders(order.orderId);
      assert.equal(result.isBuyETH, buy);
      assert.equal(result.amountIn, amountIn);
      assert.equal(result.minOut, BigInt(order.minOut));
      assert.equal(result.trader, manifest.roles[order.trader]);
      assert.equal(result.batchId, BigInt(batchId));
      const refunded = result.status === 2n;
      assert.equal(result.refunded, refunded);
      assert.ok(refunded ? result.payout === amountIn : result.status === 1n && result.payout >= result.minOut);
      if (refunded) excluded.push(order.orderId);
      const entry = { ...order, filledIn: refunded ? "0" : order.submittedIn,
        receivedOut: refunded ? "0" : String(result.payout), refundedIn: refunded ? order.submittedIn : "0",
        status: refunded ? "Refunded" : "Settled" };
      orders.push(entry);
      unclaimed.set(entry.orderId, entry);
    }
    assert.equal(settled.refundedCount, BigInt(excluded.length));
    if (rounds) {
      assert.deepEqual(rounds.flatMap(({ excludedOrderIds }) => excludedOrderIds).sort((a, b) => a - b), excluded);
      assert.equal(rounds.at(-1).clearingPrice, String(settled.clearingPrice));
    }
    batches.push({ batchId, endTime: Number(window.endTime), initialPool: before, finalPool: await reserves(),
      clearingPrice: String(settled.clearingPrice), cowUSDC: String(settled.cowUSDC),
      refundedCount: Number(settled.refundedCount), dustWei: await dust(),
      ...(rounds ? { roundEvidenceSource: "solver-calls-derived", rounds } : {}),
    });
    for (const input of submitted) {
      // Keep Alice's first payout outstanding through the next batch in S3.
      if (scene.nextBatch && batchId === 0 && input.trader !== scene.inventoryRole) continue;
      await claim(unclaimed.get(input.orderId));
    }
  }
  for (const outstanding of unclaimed.values()) await claim(outstanding);

  let outcome;
  if (inventory) {
    const cashDelta = await usdc.balanceOf(inventory) - initialCash;
    const inventoryDelta = await eth.balanceOf(inventory) - initialInventory;
    assert.equal(cashDelta, BigInt(orders[2].receivedOut) - BigInt(orders[0].filledIn));
    assert.equal(inventoryDelta, 0n);
    outcome = { inventoryRole: scene.inventoryRole, cashDeltaMUSDCBeforeNativeGas: String(cashDelta),
      inventoryDeltaMETH: String(inventoryDelta) };
  }
  const lastBatch = batches.at(-1);
  return {
    scenarioId: scene.id, ruleVersion, buildVersion: amm ? manifest.traditionalAMMBuildVersion : manifest.buildVersion,
    evidenceSource: "hardhat", chainId: manifest.chainId, addresses: manifest.addresses, roles: manifest.roles,
    initialState, clearingPrice: lastBatch?.clearingPrice ?? null, cowUSDC: lastBatch?.cowUSDC ?? null,
    dustWei: await dust(), settleGas: gas.settleBatch ?? null,
    gas: { byAction: gas, total: Object.values(gas).reduce((total, used) => total + used, 0),
      orderCount: orders.length, includesApproval: false },
    orders, steps, settlementEvents: [], batches, ...(outcome ? { outcome } : {}),
  };
}
