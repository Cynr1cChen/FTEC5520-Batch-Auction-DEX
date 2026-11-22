import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, BrowserProvider, Contract, ContractFactory, keccak256, MaxUint256, parseUnits } from "ethers";
import { network } from "hardhat";
import { artifact, batchDurationSeconds, deployDemo, initialETH, initialUSDC, mined } from "../scripts/local-demo.js";

const units = (value) => parseUnits(value, 18);
const order = (actor, isBuyETH, amountIn, minOut) => ({
  actor, isBuyETH, amountIn: units(amountIn), minOut: units(minOut),
});

async function fixture(t) {
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
  const { addresses, abis, roles } = await deployDemo(provider);
  const signers = Object.fromEntries(await Promise.all(Object.entries(roles).map(
    async ([role, address]) => [role, await provider.getSigner(address)],
  )));
  const eth = new Contract(addresses.mockETH, abis.MockToken, signers.deployer);
  const usdc = new Contract(addresses.mockUSDC, abis.MockToken, signers.deployer);
  const baseline = new Contract(addresses.batchAuctionDEX, abis.BatchAuctionDEX, signers.deployer);
  const compiled = await artifact("BatchAuctionDEXReconsideration");
  const variant = await new ContractFactory(compiled.abi, compiled.bytecode, signers.deployer)
    .deploy(eth.target, usdc.target, batchDurationSeconds);
  await mined(variant.deploymentTransaction());
  for (const [token, reserve] of [[eth, initialETH], [usdc, initialUSDC]]) {
    await mined(token.mint(signers.deployer.address, reserve));
    for (const signer of Object.values(signers)) {
      await mined(token.connect(signer).approve(variant.target, MaxUint256));
    }
  }
  await mined(variant.initPool(initialETH, initialUSDC));
  let snapshot = await provider.send("evm_snapshot", []);

  async function run(dex, orders) {
    assert.equal(await dex.currentBatchId(), 0n);
    for (const { actor, isBuyETH, amountIn, minOut } of orders) {
      await mined(dex.connect(signers[actor]).submitOrder(isBuyETH, amountIn, minOut));
    }
    const { endTime } = await dex.batches(0);
    await provider.send("evm_setNextBlockTimestamp", [Number(endTime)]);
    const receipt = await mined(dex.settleBatch());
    const batch = await dex.batches(0);
    const reserveETH = await dex.reserveETH();
    const reserveUSDC = await dex.reserveUSDC();
    const debt = new Map([[eth.target, 0n], [usdc.target, 0n]]);
    const outcomes = [];
    for (const [index, input] of orders.entries()) {
      const filled = await dex.orders(index);
      assert.equal(filled.amountIn, input.amountIn);
      assert.equal(filled.minOut, input.minOut);
      assert.equal(filled.trader, roles[input.actor]);
      const refund = filled.status === 2n;
      assert.equal(filled.status, refund ? 2n : 1n);
      assert.equal(filled.refunded, refund);
      assert.ok(refund ? filled.payout === input.amountIn : filled.payout >= input.minOut);
      const token = refund !== input.isBuyETH ? eth : usdc;
      debt.set(token.target, debt.get(token.target) + filled.payout);
      outcomes.push({
        ...input,
        status: filled.status,
        payout: filled.payout,
        token,
      });
    }
    const dust = [];
    for (const [token, reserve] of [[eth, reserveETH], [usdc, reserveUSDC]]) {
      dust.push(await token.balanceOf(dex.target) - reserve - debt.get(token.target));
    }
    assert.ok(dust.every((amount) => amount >= 0n && amount < BigInt(Math.max(1, orders.length))));
    assert.ok(reserveETH * reserveUSDC >= initialETH * initialUSDC);

    for (const [index, { actor, payout, token }] of outcomes.entries()) {
      const before = await token.balanceOf(roles[actor]);
      await mined(dex.connect(signers[actor]).claim(index));
      assert.equal(await token.balanceOf(roles[actor]) - before, payout);
      assert.equal((await dex.orders(index)).status, 3n);
    }
    assert.equal(await eth.balanceOf(dex.target), reserveETH + dust[0]);
    assert.equal(await usdc.balanceOf(dex.target), reserveUSDC + dust[1]);
    const rescued = receipt.logs.map((log) => dex.interface.parseLog(log)).filter(
      (log) => log?.name === "OrderReconsidered",
    );
    assert.equal(await provider.send("evm_revert", [snapshot]), true);
    snapshot = await provider.send("evm_snapshot", []);
    return {
      cow: batch.cowUSDC,
      price: batch.clearingPrice,
      refunds: batch.refundedCount,
      reserveETH,
      reserveUSDC,
      gas: receipt.gasUsed,
      rescued,
      outcomes: outcomes.map(({ token, ...entry }) => entry),
    };
  }
  return { baseline, variant, run, roles };
}

const ordersWithRecovery = [
  order("alice", true, "20000", "9.7"),
  order("arb", true, "8000", "4"),
  order("bob", false, "10", "18000"),
];
const permutationsOfThree = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

test("A restores Alice at 20,000 CoW across all six orderings and preserves Bob's payout", async (t) => {
  const { baseline, variant, run } = await fixture(t);
  const original = await run(baseline, ordersWithRecovery);
  assert.equal(original.cow, 0n);
  assert.equal(original.refunds, 2n);
  assert.equal(original.outcomes[0].status, 2n);
  assert.equal(original.outcomes[1].status, 2n);

  for (const permutation of permutationsOfThree) {
    const inputs = permutation.map((index) => ordersWithRecovery[index]);
    const actual = await run(variant, inputs);
    const byActor = Object.fromEntries(actual.outcomes.map((outcome) => [outcome.actor, outcome]));
    assert.equal(actual.cow, units("20000"));
    assert.equal(actual.price, units("2000"));
    assert.equal(actual.refunds, 1n);
    assert.equal(actual.reserveETH, initialETH);
    assert.equal(actual.reserveUSDC, initialUSDC);
    assert.deepEqual(
      [byActor.alice.status, byActor.arb.status, byActor.bob.status],
      [1n, 2n, 1n],
    );
    assert.equal(byActor.alice.payout, units("10"));
    assert.equal(byActor.bob.payout, units("20000"));
    assert.ok(byActor.bob.payout >= original.outcomes[2].payout);
    assert.equal(actual.rescued.length, 1);
    assert.equal(actual.rescued[0].args.orderId, BigInt(permutation.indexOf(0)));
    assert.equal(actual.rescued[0].args.originalClearingPrice, original.price);
    assert.equal(actual.rescued[0].args.originalCoWUSDC, original.cow);
  }
});

test("A declines an otherwise eligible newcomer when an incumbent would lose output", async (t) => {
  const { baseline, variant, run } = await fixture(t);
  const incumbents = [
    order("alice", true, "20000", "0"),
    order("bob", false, "10", "0"),
  ];
  const candidate = order("arb", true, "4000", "1.95");
  const ordinaryThree = await run(baseline, [...incumbents, candidate]);
  assert.equal(ordinaryThree.refunds, 0n);
  assert.ok(ordinaryThree.outcomes[0].payout < units("10"));
  const inputs = [...incumbents, candidate, order("bot", true, "4000", "1.95")];
  const original = await run(baseline, inputs);
  const actual = await run(variant, inputs);
  assert.equal(original.refunds, 2n);
  assert.equal(actual.rescued.length, 0);
  const economic = ({ gas, rescued, ...result }) => result;
  assert.deepEqual(economic(actual), economic(original));
});

test("A chooses among equal CoW candidates by fingerprint and handles identical orders", async (t) => {
  const { variant, run, roles } = await fixture(t);
  const alice = order("alice", true, "20000", "9.7");
  const arb = order("arb", true, "20000", "9.7");
  const seller = order("bob", false, "10", "18000");
  const fingerprint = ({ actor, isBuyETH, amountIn, minOut }) => keccak256(AbiCoder.defaultAbiCoder()
    .encode(["address", "bool", "uint256", "uint256"], [roles[actor], isBuyETH, amountIn, minOut]));
  const winner = fingerprint(alice) < fingerprint(arb) ? "alice" : "arb";
  for (const buyers of [[alice, arb], [arb, alice], [alice, alice]]) {
    const inputs = [...buyers, seller];
    const result = await run(variant, inputs);
    assert.equal(result.cow, units("20000"));
    assert.equal(result.refunds, 1n);
    assert.equal(result.rescued.length, 1);
    const restored = result.outcomes[Number(result.rescued[0].args.orderId)];
    assert.equal(restored.actor, buyers[0] === buyers[1] ? "alice" : winner);
    assert.equal(restored.payout, units("10"));
  }
});

test("A retains baseline economics for empty and all-refund batches", async (t) => {
  const { baseline, variant, run } = await fixture(t);
  for (const inputs of [[], [order("alice", true, "1000", "200")]]) {
    const original = await run(baseline, inputs);
    const actual = await run(variant, inputs);
    assert.deepEqual(actual.outcomes, original.outcomes);
    assert.equal(actual.cow, 0n);
    assert.equal(actual.price, original.price);
    assert.equal(actual.refunds, BigInt(inputs.length));
    assert.equal(actual.rescued.length, 0);
  }
});

test("A settles at the 50-order cap with 25 review candidates", async (t) => {
  const { baseline, variant, run } = await fixture(t);
  const inputs = [
    ...Array.from({ length: 25 }, () => order("alice", true, "4000", "2")),
    ...Array.from({ length: 25 }, () => order("bob", false, "0.4", "0")),
  ];
  const original = await run(baseline, inputs);
  const actual = await run(variant, inputs);
  assert.equal(original.refunds, 25n);
  assert.equal(actual.refunds, 24n);
  assert.equal(actual.cow, units("4000"));
  assert.equal(actual.rescued.length, 1);
  assert.ok(actual.gas < 8_000_000n);
  t.diagnostic(`Settlement Gas at 50 orders: baseline=${original.gas}, A=${actual.gas}`);
});

test("A cannot restore two missing counterparties in one reconsideration", async (t) => {
  const { baseline, variant, run } = await fixture(t);
  const tighterSeller = order("bob", false, "10", "20000");
  const [alice, extraBuyer] = ordersWithRecovery;
  const original = await run(baseline, [alice, extraBuyer, tighterSeller]);
  const reviewed = await run(variant, [alice, extraBuyer, tighterSeller]);
  assert.equal(original.refunds, 3n);
  assert.equal(reviewed.refunds, 3n);
  assert.equal(reviewed.cow, 0n);
  assert.equal(reviewed.rescued.length, 0);

  const feasiblePair = await run(baseline, [alice, tighterSeller]);
  assert.equal(feasiblePair.refunds, 0n);
  assert.equal(feasiblePair.cow, units("20000"));
});
