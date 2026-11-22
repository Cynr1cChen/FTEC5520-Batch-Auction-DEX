import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserProvider, Contract, parseUnits } from "ethers";
import { network } from "hardhat";
import { deployDemo, mined } from "../scripts/local-demo.js";

const units = (value) => parseUnits(value, 18);
const amount = {
  buy: units("24000"),
  minBuyOut: units("12"),
  minFilled: units("20000"),
  sell: units("10"),
  minSellOut: units("20000"),
};

async function fixture(t) {
  const connection = await network.create();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  t.after(async () => {
    provider.destroy();
    await connection.close();
  });

  const { addresses, abis, roles, variants } = await deployDemo(provider, { includeVariants: true });
  const deployer = await provider.getSigner(roles.deployer);
  const alice = await provider.getSigner(roles.alice);
  const bob = await provider.getSigner(roles.bob);
  const eth = new Contract(addresses.mockETH, abis.MockToken, deployer);
  const usdc = new Contract(addresses.mockUSDC, abis.MockToken, deployer);
  const variant = new Contract(variants.variant_B.address, variants.variant_B.abi, deployer);

  async function settle() {
    const id = await variant.currentBatchId();
    const batch = await variant.batches(id);
    await provider.send("evm_setNextBlockTimestamp", [Number(batch.endTime)]);
    return mined(variant.settleBatch());
  }

  async function assertLiabilities(expectedETH, expectedUSDC) {
    assert.equal(await variant.claimableETH(), expectedETH);
    assert.equal(await variant.claimableUSDC(), expectedUSDC);
    const dustETH = await eth.balanceOf(variant.target) - await variant.reserveETH()
      - await variant.escrowedETH() - expectedETH;
    const dustUSDC = await usdc.balanceOf(variant.target) - await variant.reserveUSDC()
      - await variant.escrowedUSDC() - expectedUSDC;
    assert.ok(dustETH >= 0n && dustETH < 50n);
    assert.ok(dustUSDC >= 0n && dustUSDC < 50n);
  }

  return { provider, variant, eth, usdc, alice, bob, settle, assertLiabilities };
}

async function submitPair(variant, alice, bob, minimumFill) {
  if (minimumFill === null) {
    await mined(variant.connect(alice).submitOrder(true, amount.buy, amount.minBuyOut));
  } else {
    await mined(variant.connect(alice).submitPartialOrder(true, amount.buy, amount.minBuyOut, minimumFill));
  }
  await mined(variant.connect(bob).submitOrder(false, amount.sell, amount.minSellOut));
}

test("B partially fills a consenting buyer, conserves assets, and pays two assets exactly once", async (t) => {
  const { variant, eth, usdc, alice, bob, settle, assertLiabilities } = await fixture(t);
  const aliceBalanceETH = await eth.balanceOf(alice.address);
  const aliceBalanceUSDC = await usdc.balanceOf(alice.address);
  const bobBalanceUSDC = await usdc.balanceOf(bob.address);
  await submitPair(variant, alice, bob, amount.minFilled);
  assert.equal(await variant.escrowedETH(), amount.sell);
  assert.equal(await variant.escrowedUSDC(), amount.buy);
  await assertLiabilities(0n, 0n);

  const receipt = await settle();
  const partial = await variant.orders(0n);
  const full = await variant.orders(1n);
  assert.equal(partial.status, 4n);
  assert.equal(partial.filledIn, amount.minFilled);
  assert.equal(partial.receivedOut, amount.sell);
  assert.equal(partial.receivedOut * partial.amountIn, partial.minOut * partial.filledIn);
  assert.equal(partial.refundedIn, units("4000"));
  assert.equal(full.status, 1n);
  assert.equal(full.receivedOut, amount.minSellOut);
  assert.equal((await variant.batches(0n)).cowUSDC, units("20000"));
  assert.equal(await variant.escrowedETH(), 0n);
  assert.equal(await variant.escrowedUSDC(), 0n);
  await assertLiabilities(amount.sell, amount.buy);
  const event = receipt.logs.map((log) => variant.interface.parseLog(log))
    .find((log) => log?.name === "BatchPartialFill");
  assert.ok(event);
  assert.equal(event.args.filledIn, partial.filledIn);

  // A later batch must not consume earlier unclaimed liabilities.
  await mined(variant.connect(alice).submitOrder(true, units("1"), units("100")));
  assert.equal(await variant.escrowedUSDC(), units("1"));
  await settle();
  await assertLiabilities(amount.sell, amount.buy + units("1"));
  await assert.rejects(variant.connect(bob).claim.staticCall(0), (error) =>
    error.revert?.name === "NotOrderOwner");
  await mined(variant.connect(alice).claim(2));
  await mined(variant.connect(alice).claim(0));
  await mined(variant.connect(bob).claim(1));
  assert.equal(await eth.balanceOf(alice.address), aliceBalanceETH + amount.sell);
  assert.equal(await usdc.balanceOf(alice.address), aliceBalanceUSDC - amount.minFilled);
  assert.equal(await usdc.balanceOf(bob.address), bobBalanceUSDC + amount.minSellOut);
  await assertLiabilities(0n, 0n);
  await assert.rejects(variant.connect(alice).claim.staticCall(0), (error) =>
    error.revert?.name === "AlreadyClaimed");
});

test("B preserves the no-opt-in refund and can miss a feasible amount above its only trial size", async (t) => {
  const { provider, variant, alice, bob, settle, assertLiabilities } = await fixture(t);
  let snapshot = await provider.send("evm_snapshot", []);
  for (const minimumFill of [null, units("19000"), units("20000")]) {
    await submitPair(variant, alice, bob, minimumFill);
    await settle();
    const aliceOrder = await variant.orders(0);
    const bobOrder = await variant.orders(1);
    const batch = await variant.batches(0);
    if (minimumFill === amount.minFilled) {
      assert.equal(batch.cowUSDC, units("20000"));
      assert.equal(aliceOrder.status, 4n);
      assert.equal(bobOrder.status, 1n);
    } else {
      assert.equal(batch.cowUSDC, 0n);
      assert.equal(aliceOrder.status, 2n);
      assert.equal(bobOrder.status, 2n);
      assert.equal(aliceOrder.refundedIn, amount.buy);
      assert.equal(bobOrder.refundedIn, amount.sell);
      await assertLiabilities(amount.sell, amount.buy);
    }
    assert.equal(await provider.send("evm_revert", [snapshot]), true);
    snapshot = await provider.send("evm_snapshot", []);
  }
});

test("B is symmetric for consent on the sell side and preserves results under submit reversal", async (t) => {
  const { provider, variant, alice, bob, settle, assertLiabilities } = await fixture(t);
  let snapshot = await provider.send("evm_snapshot", []);
  for (const reversed of [false, true]) {
    const submitBuy = () => mined(variant.connect(alice).submitOrder(true, units("20000"), units("10")));
    const submitSell = () => mined(variant.connect(bob).submitPartialOrder(
      false, units("12"), units("24000"), units("10"),
    ));
    for (const submit of reversed ? [submitSell, submitBuy] : [submitBuy, submitSell]) {
      await submit();
    }
    await settle();
    const filled = await variant.orders(reversed ? 0 : 1);
    assert.equal(filled.status, 4n);
    assert.equal(filled.filledIn, units("10"));
    assert.equal(filled.receivedOut, units("20000"));
    assert.equal(filled.refundedIn, units("2"));
    await assertLiabilities(units("12"), units("20000"));
    await mined(variant.connect(bob).claim(reversed ? 0 : 1));
    await assertLiabilities(units("10"), 0n);
    assert.equal(await provider.send("evm_revert", [snapshot]), true);
    snapshot = await provider.send("evm_snapshot", []);
  }
});

test("B clears 50 orders and four unsuccessful opt-in trials within the node Gas bound", async (t) => {
  const { variant, alice, bob, settle, assertLiabilities } = await fixture(t);
  const aliceDEX = variant.connect(alice);
  const bobDEX = variant.connect(bob);
  for (let i = 0; i < 4; i++) {
    await mined(aliceDEX.submitPartialOrder(true, units("24000"), units("12"), units("20000")));
  }
  await assert.rejects(aliceDEX.submitPartialOrder.staticCall(
    true, units("100"), units("1"), units("50"),
  ), (error) => error.revert?.name === "PartialOrderCapacityReached");

  for (let i = 0; i < 23; i++) {
    await mined(aliceDEX.submitOrder(true, units("2"), 0));
    await mined(bobDEX.submitOrder(false, units("0.001"), 0));
  }
  await assert.rejects(aliceDEX.submitOrder.staticCall(true, units("1"), 0), (error) =>
    error.revert?.name === "BatchFull");
  const receipt = await settle();
  const batch = await variant.batches(0);
  assert.equal(batch.orderCount, 50n);
  assert.equal(batch.refundedCount, 4n);
  assert.equal(batch.cowUSDC, units("46"));
  assert.ok(receipt.gasUsed < 8_000_000n);
  t.diagnostic(`50-order settlement with four attempted trims: ${receipt.gasUsed} Gas`);
  await assertLiabilities(units("0.023"), units("96046"));
});
