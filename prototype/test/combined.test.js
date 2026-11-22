import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserProvider, Contract, parseUnits } from "ethers";
import { network } from "hardhat";
import { deployDemo, mined } from "../scripts/local-demo.js";

const units = (value) => parseUnits(value, 18);

function order(actor, isBuyETH, input, minimum, partial = "0") {
  return {
    actor, isBuyETH, amountIn: units(input), minOut: units(minimum), minFillIn: units(partial),
  };
}

async function fixture(t) {
  const connection = await network.create();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  t.after(async () => {
    provider.destroy();
    await connection.close();
  });

  const { addresses, abis, roles, variants } = await deployDemo(provider, { includeVariants: true });
  const signers = Object.fromEntries(await Promise.all(Object.entries(roles).map(
    async ([role, address]) => [role, await provider.getSigner(address)],
  )));
  const eth = new Contract(addresses.mockETH, abis.MockToken, signers.deployer);
  const usdc = new Contract(addresses.mockUSDC, abis.MockToken, signers.deployer);
  const contracts = {
    baseline: new Contract(addresses.batchAuctionDEX, abis.BatchAuctionDEX, signers.deployer),
    ...Object.fromEntries(Object.entries(variants).map(
      ([rule, { address, abi }]) => [rule, new Contract(address, abi, signers.deployer)],
    )),
  };
  let snapshot = await provider.send("evm_snapshot", []);

  async function run(rule, inputs) {
    const dex = contracts[rule];
    const hasPartialFill = rule === "variant_B" || rule === "variant_AB";
    for (const { actor, isBuyETH, amountIn, minOut, minFillIn } of inputs) {
      const trader = dex.connect(signers[actor]);
      if (hasPartialFill && minFillIn !== 0n) {
        await mined(trader.submitPartialOrder(isBuyETH, amountIn, minOut, minFillIn));
      } else {
        await mined(trader.submitOrder(isBuyETH, amountIn, minOut));
      }
    }
    const { endTime } = await dex.batches(0n);
    await provider.send("evm_setNextBlockTimestamp", [Number(endTime)]);
    const receipt = await mined(dex.settleBatch());

    const { cowUSDC, clearingPrice } = await dex.batches(0n);
    const reserveETH = await dex.reserveETH();
    const reserveUSDC = await dex.reserveUSDC();
    let dueETH = 0n;
    let dueUSDC = 0n;
    const outcomes = {};
    for (const [id, input] of inputs.entries()) {
      const { actor, isBuyETH, amountIn, minOut, minFillIn } = input;
      const result = await dex.orders(id);
      const refund = result.status === 2n;
      const filledIn = hasPartialFill ? result.filledIn : refund ? 0n : amountIn;
      const receivedOut = hasPartialFill ? result.receivedOut : refund ? 0n : result.payout;
      const refundedIn = hasPartialFill ? result.refundedIn : refund ? result.payout : 0n;
      assert.equal(filledIn + refundedIn, amountIn);
      assert.ok(filledIn * minOut <= receivedOut * amountIn);
      if (filledIn > 0n && filledIn < amountIn) {
        assert.ok(minFillIn > 0n && filledIn >= minFillIn);
      }
      dueETH += isBuyETH ? receivedOut : refundedIn;
      dueUSDC += isBuyETH ? refundedIn : receivedOut;
      outcomes[`${actor}/${minFillIn}`] = { filledIn, receivedOut, refundedIn };
    }
    const events = receipt.logs.map(log => dex.interface.parseLog(log)).filter(Boolean);
    const reconsidered = events.find(log => log.name === "OrderReconsidered");
    const partial = events.find(log => log.name === "BatchPartialFill");
    const dustETH = await eth.balanceOf(dex.target) - reserveETH - dueETH;
    const dustUSDC = await usdc.balanceOf(dex.target) - reserveUSDC - dueUSDC;
    assert.ok(dustETH >= 0n && dustETH < BigInt(inputs.length));
    assert.ok(dustUSDC >= 0n && dustUSDC < BigInt(inputs.length));
    if (hasPartialFill) {
      assert.equal(await dex.claimableETH(), dueETH);
      assert.equal(await dex.claimableUSDC(), dueUSDC);
    }
    for (const [id, input] of inputs.entries()) {
      await mined(dex.connect(signers[input.actor]).claim(id));
    }
    assert.equal(await eth.balanceOf(dex.target), reserveETH + dustETH);
    assert.equal(await usdc.balanceOf(dex.target), reserveUSDC + dustUSDC);

    assert.equal(await provider.send("evm_revert", [snapshot]), true);
    snapshot = await provider.send("evm_snapshot", []);
    const reconsideredOrder = reconsidered ? inputs[Number(reconsidered.args.orderId)] : null;
    const partialOrder = partial ? inputs[Number(partial.args.orderId)] : null;
    return { cowUSDC, clearingPrice, outcomes, reconsideredOrder, partialOrder, gasUsed: receipt.gasUsed };
  }

  return { run };
}

const compoundOrders = [
  order("alice", true, "20000", "9.9"),
  order("arb", true, "8000", "4", "4000"),
  order("bob", false, "10", "17000"),
  order("bot", false, "2", "4000"),
];

test("AB runs both stages, preserves the restored order, and ties B-only in this case", async (t) => {
  const { run } = await fixture(t);
  const baseline = await run("baseline", compoundOrders);
  const reconsideration = await run("variant_A", compoundOrders);
  const partial = await run("variant_B", compoundOrders);
  assert.equal(baseline.cowUSDC, 0n);
  assert.equal(reconsideration.cowUSDC, units("20000"));
  assert.equal(partial.cowUSDC, units("24000"));

  for (const inputs of [compoundOrders, compoundOrders.toReversed()]) {
    const combined = await run("variant_AB", inputs);
    assert.equal(combined.cowUSDC, partial.cowUSDC);
    assert.deepEqual(combined.outcomes, partial.outcomes);
    assert.equal(combined.reconsideredOrder.actor, "alice");
    assert.equal(combined.partialOrder.actor, "arb");
    t.diagnostic(`combined settlement: ${combined.gasUsed} Gas`);
  }
});

test("AB declines B's higher direct match when it would reduce an A-stage payout", async (t) => {
  const { run } = await fixture(t);
  const inputs = [
    order("alice", true, "20000", "9.85"),
    order("arb", true, "8000", "3.93", "4000"),
    order("bob", false, "10", "17000"),
    order("bot", false, "1.9", "3800"),
  ];
  const baseline = await run("baseline", inputs);
  const reconsideration = await run("variant_A", inputs);
  const partial = await run("variant_B", inputs);
  const combined = await run("variant_AB", inputs);
  assert.equal(baseline.cowUSDC, 0n);
  assert.equal(reconsideration.cowUSDC, units("20000"));
  assert.ok(partial.cowUSDC > reconsideration.cowUSDC);
  assert.ok(partial.outcomes["alice/0"].receivedOut >= units("9.85"));
  assert.ok(partial.outcomes["alice/0"].receivedOut < units("10"));
  assert.equal(combined.cowUSDC, reconsideration.cowUSDC);
  assert.deepEqual(combined.outcomes, reconsideration.outcomes);
  assert.equal(combined.reconsideredOrder.actor, "alice");
  assert.equal(combined.partialOrder, null);
});

test("AB keeps the baseline when neither rule changes the fully matched result", async (t) => {
  const { run } = await fixture(t);
  const inputs = [
    order("alice", true, "20000", "10", "18000"),
    order("bob", false, "10", "20000"),
  ];
  const baseline = await run("baseline", inputs);
  const combined = await run("variant_AB", inputs);
  assert.equal(combined.cowUSDC, units("20000"));
  assert.deepEqual(combined.outcomes, baseline.outcomes);
  assert.equal(combined.reconsideredOrder, null);
  assert.equal(combined.partialOrder, null);
});

test("AB resolves equal full-order identities consistently when partial consent differs", async (t) => {
  const { run } = await fixture(t);
  const whole = order("alice", true, "20000", "9.7");
  const flexible = order("alice", true, "20000", "9.7", "18000");
  const counter = order("bob", false, "10", "17000");
  for (const input of [[whole, flexible, counter], [flexible, whole, counter]]) {
    const combined = await run("variant_AB", input);
    assert.equal(combined.reconsideredOrder.minFillIn, 0n);
    assert.equal(combined.outcomes["alice/0"].filledIn, units("20000"));
    assert.equal(combined.outcomes[`alice/${flexible.minFillIn}`].filledIn, 0n);
    assert.equal(combined.partialOrder, null);
  }
});
