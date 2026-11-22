import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserProvider, Contract, parseUnits } from "ethers";
import { network } from "hardhat";
import { deployDemo, initialETH, initialUSDC, localProvider, resetDemo } from "../scripts/local-demo.js";

import { baselineReplayScenes, recordBaseline } from "../scripts/record-baseline.js";

const units = (value) => parseUnits(value, 18);

async function createProvider(t) {
  const connection = await network.create();
  const provider = new BrowserProvider(
    { request: (request) => connection.provider.request(request) },
    undefined,
    { cacheTimeout: -1 },
  );
  t.after(async () => {
    provider.destroy();
    await connection.close();
  });
  return provider;
}

test("deployment, five S2 settlement and reset cycles, and stale manifest handling", async (t) => {
  const provider = await createProvider(t);
  const original = await deployDemo(provider);
  let manifest = original;
  const { addresses, abis, roles } = manifest;
  const dex = new Contract(addresses.batchAuctionDEX, abis.BatchAuctionDEX, provider);
  const amm = new Contract(addresses.traditionalAMM, abis.TraditionalAMM, provider);
  const eth = new Contract(addresses.mockETH, abis.MockToken, provider);
  const usdc = new Contract(addresses.mockUSDC, abis.MockToken, provider);
  const [alice, bob, deployer] = await Promise.all(
    [roles.alice, roles.bob, roles.deployer].map((address) => provider.getSigner(address)),
  );

  assert.throws(() => localProvider("https://example.org"), /loopback/);
  assert.equal(await amm.reserveETH(), initialETH);
  assert.equal(await amm.reserveUSDC(), initialUSDC);

  for (let cycle = 0; cycle < 5; cycle++) {
    assert.equal(await dex.ordersLength(), 0n);
    assert.equal(await dex.currentBatchId(), 0n);
    assert.equal(await dex.reserveETH(), initialETH);
    assert.equal(await dex.reserveUSDC(), initialUSDC);
    const aliceBefore = await eth.balanceOf(roles.alice);
    const bobBefore = await usdc.balanceOf(roles.bob);
    await (await dex.connect(alice).submitOrder(true, units("20000"), 0n)).wait();
    await (await dex.connect(bob).submitOrder(false, units("10"), 0n)).wait();
    const scheduled = await dex.batches(0);
    await provider.send("evm_setNextBlockTimestamp", [Number(scheduled.endTime)]);
    await (await dex.connect(deployer).settleBatch()).wait();
    const batch = await dex.batches(0);
    assert.equal(batch.clearingPrice, units("2000"));
    assert.equal(batch.cowUSDC, units("20000"));
    assert.equal(await eth.balanceOf(dex.target), initialETH + units("10"));
    assert.equal(await usdc.balanceOf(dex.target), initialUSDC + units("20000"));
    await (await dex.connect(alice).claim(0n)).wait();
    await (await dex.connect(bob).claim(1n)).wait();
    assert.equal(await eth.balanceOf(roles.alice), aliceBefore + units("10"));
    assert.equal(await usdc.balanceOf(roles.bob), bobBefore + units("20000"));
    manifest = await resetDemo(provider, manifest);
    assert.equal(await dex.ordersLength(), 0n);
    assert.equal(await dex.currentBatchId(), 0n);
    assert.equal(await eth.balanceOf(roles.alice), aliceBefore);
    assert.equal(await usdc.balanceOf(roles.bob), bobBefore);
  }
  await assert.rejects(resetDemo(provider, original), /snapshot is stale/);
  const otherNode = await createProvider(t);
  await assert.rejects(resetDemo(otherNode, manifest), /previous node instance/);
});

test("original contract rejects invalid settlement, late orders, and invalid claims", async (t) => {
  const provider = await createProvider(t);
  const { addresses, abis, roles } = await deployDemo(provider);
  const dex = new Contract(addresses.batchAuctionDEX, abis.BatchAuctionDEX, provider);
  const alice = await provider.getSigner(roles.alice);
  const bob = await provider.getSigner(roles.bob);
  const checkError = (name) => (error) => {
    assert.equal(error.data?.slice(0, 10), dex.interface.getError(name).selector);
    return true;
  };

  await assert.rejects(dex.settleBatch.staticCall(), checkError("BatchWindowNotClosed"));
  await (await dex.connect(alice).submitOrder(true, units("20000"), 0n)).wait();
  await assert.rejects(dex.connect(alice).claim.staticCall(0n), checkError("OrderNotSettled"));

  const batch = await dex.batches(0);
  await provider.send("evm_setNextBlockTimestamp", [Number(batch.endTime)]);
  await provider.send("evm_mine", []);
  await assert.rejects(
    dex.connect(bob).submitOrder.staticCall(false, units("10"), 0n),
    checkError("BatchWindowClosed"),
  );
  await (await dex.connect(bob).settleBatch()).wait();
  await assert.rejects(dex.connect(bob).claim.staticCall(0n), checkError("NotOrderOwner"));
  await (await dex.connect(alice).claim(0n)).wait();
  await assert.rejects(dex.connect(alice).claim.staticCall(0n), checkError("AlreadyClaimed"));
});

const replayScene = (id) => baselineReplayScenes.find((scene) => scene.id === id);

for (const [id, exclusions, refunds] of [
  ["T06_single_exclusion", [[2], []], ["2000"]],
  ["T06b_cascading_exclusion", [[2], [3], []], ["60000", "10"]],
]) {
  test(`${id} settles valid orders and refunds excluded orders`, async (t) => {
    const provider = await createProvider(t);
    const manifest = await deployDemo(provider);
    const trace = await recordBaseline(provider, manifest, replayScene(id), "v2.2");
    const [batch] = trace.batches;
    assert.deepEqual(batch.rounds.map((round) => round.excludedOrderIds), exclusions);
    assert.equal(batch.roundEvidenceSource, "solver-calls-derived");
    assert.equal(batch.refundedCount, refunds.length);
    assert.equal(trace.clearingPrice, String(units("2000")));
    assert.equal(trace.cowUSDC, String(units("20000")));
    assert.deepEqual(trace.orders.slice(0, 2).map(({ receivedOut }) => receivedOut), ["10", "20000"].map((n) => String(units(n))));
    assert.deepEqual(trace.orders.slice(2).map(({ refundedIn }) => refundedIn), refunds.map((n) => String(units(n))));
    assert.deepEqual(trace.dustWei, { mETH: "0", mUSDC: "0" });
  });
}

test("same ordinary buy and sell change AMM payouts with order, but not one-batch payouts", async (t) => {
  const provider = await createProvider(t);
  let manifest = await deployDemo(provider);
  const resultsByRule = {};
  for (const rule of ["traditional_amm", "v2.2"]) {
    resultsByRule[rule] = [];
    for (const direction of ["buy", "sell"]) {
      const trace = await recordBaseline(provider, manifest, replayScene(`S1_ordinary_${direction}_first`), rule);
      resultsByRule[rule].push(Object.fromEntries(trace.orders.map(({ trader, receivedOut }) => [trader, BigInt(receivedOut)])));
      manifest = await resetDemo(provider, manifest);
    }
  }
  const [buyFirst, sellFirst] = resultsByRule.traditional_amm;
  assert.ok(buyFirst.alice < units("10") && sellFirst.alice > units("10"));
  assert.ok(buyFirst.bob > units("20000") && sellFirst.bob < units("20000"));
  for (const batch of resultsByRule["v2.2"]) {
    assert.deepEqual(batch, { alice: units("10"), bob: units("20000") });
  }
});

test("paired inventory replay uses identical first batches and reconciles both second batches", async (t) => {
  const provider = await createProvider(t);
  const manifest = await deployDemo(provider);
  const alone = await recordBaseline(provider, manifest, replayScene("S3_inventory_alone"), "v2.2");
  const reset = await resetDemo(provider, manifest);
  const shared = await recordBaseline(provider, reset, replayScene("S3_inventory_with_additional_seller"), "v2.2");
  assert.deepEqual(alone.batches[0], shared.batches[0]);
  assert.equal(alone.outcome.cashDeltaMUSDCBeforeNativeGas, "2438685673809364160136");
  assert.equal(shared.outcome.cashDeltaMUSDCBeforeNativeGas, "-2097767153858134150745");
  for (const trace of [alone, shared]) {
    assert.equal(trace.outcome.inventoryDeltaMETH, "0");
    const firstBuyerClaim = trace.steps.at(-1);
    assert.equal(firstBuyerClaim.batchId, 0);
    assert.equal(firstBuyerClaim.actor, "alice");
    assert.ok(firstBuyerClaim.blockNumber > trace.steps.findLast((step) => step.action === "settleBatch").blockNumber);
    assert.equal(trace.steps.reduce((total, step) => total + step.gasUsed, 0), trace.gas.total);
  }
});
