import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { BrowserProvider, Contract, ContractFactory, hexlify, parseUnits } from "ethers";
import { network } from "hardhat";
import { artifact, deployDemo, mined } from "../scripts/local-demo.js";

async function demo(t) {
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
  const [deployer, alice, bob] = await Promise.all(
    [roles.deployer, roles.alice, roles.bob].map((address) => provider.getSigner(address)),
  );
  const eth = new Contract(addresses.mockETH, abis.MockToken, provider);
  const usdc = new Contract(addresses.mockUSDC, abis.MockToken, provider);
  const compiled = await artifact("BatchCommitReveal");
  const escrow = await new ContractFactory(compiled.abi, compiled.bytecode, deployer)
    .deploy(eth.target, usdc.target, 120, 120);
  await mined(escrow.deploymentTransaction());
  return { provider, escrow, eth, usdc, alice, bob };
}

async function expectError(escrow, action, name) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, "CALL_EXCEPTION");
    assert.equal(error.data?.slice(0, 10), escrow.interface.getError(name).selector);
    return true;
  });
}

test("commit/reveal opens only the agreed limit and reclaims both opened and unopened escrows", async (t) => {
  const { provider, escrow, eth, usdc, alice, bob } = await demo(t);
  const buyAmount = parseUnits("20000", 18);
  const sellAmount = parseUnits("10", 18);
  const buyerLimit = parseUnits("9.7", 18);
  const sellerLimit = parseUnits("18000", 18);
  const salt = hexlify(randomBytes(32));
  const otherSalt = hexlify(randomBytes(32));
  const [buyerCommitment, sellerCommitment] = await Promise.all([
    escrow.computeCommitment(alice.address, true, buyAmount, buyerLimit, salt),
    escrow.computeCommitment(bob.address, false, sellAmount, sellerLimit, otherSalt),
  ]);
  assert.notEqual(
    await escrow.computeCommitment(bob.address, true, buyAmount, buyerLimit, salt),
    buyerCommitment,
  );
  const buyerStart = await usdc.balanceOf(alice.address);
  const sellerStart = await eth.balanceOf(bob.address);
  await mined(usdc.connect(alice).approve(escrow.target, buyAmount));
  await mined(eth.connect(bob).approve(escrow.target, sellAmount));

  const commitEnd = Number(await escrow.commitEnd());
  const revealEnd = Number(await escrow.revealEnd());
  const buyReceipt = await mined(escrow.connect(alice).commit(true, buyAmount, buyerCommitment));
  await provider.send("evm_setNextBlockTimestamp", [commitEnd - 1]);
  const sellReceipt = await mined(escrow.connect(bob).commit(false, sellAmount, sellerCommitment));
  assert.equal((await provider.getBlock(sellReceipt.blockNumber)).timestamp, commitEnd - 1);

  const committed = await escrow.entries(0);
  assert.equal(committed.trader, alice.address);
  assert.equal(committed.isBuyETH, true);
  assert.equal(committed.amountIn, buyAmount);
  assert.equal(committed.commitment, buyerCommitment);
  assert.equal(committed.minOut, 0n);
  assert.equal(committed.revealed, false);
  const commitTx = await provider.getTransaction(buyReceipt.hash);
  const commitData = escrow.interface.parseTransaction(commitTx);
  assert.equal(commitData.name, "commit");
  assert.deepEqual([...commitData.args], [true, buyAmount, buyerCommitment]);
  assert.equal(await usdc.balanceOf(escrow.target), buyAmount);
  assert.equal(await eth.balanceOf(escrow.target), sellAmount);
  await expectError(escrow, escrow.connect(alice).reveal.staticCall(0, buyerLimit, salt), "RevealWindowClosed");
  await expectError(escrow, escrow.connect(alice).refund.staticCall(0), "RefundWindowNotOpen");

  await provider.send("evm_setNextBlockTimestamp", [commitEnd]);
  const openedReceipt = await mined(escrow.connect(alice).reveal(0, buyerLimit, salt, { gasLimit: 150_000 }));
  assert.equal((await provider.getBlock(openedReceipt.blockNumber)).timestamp, commitEnd);
  assert.equal((await escrow.entries(0)).revealed, true);
  assert.equal((await escrow.entries(0)).minOut, buyerLimit);
  assert.equal(escrow.interface.parseLog(openedReceipt.logs[0]).args.minOut, buyerLimit);

  await expectError(escrow, escrow.connect(alice).commit.staticCall(true, buyAmount, buyerCommitment), "CommitWindowClosed");
  await expectError(escrow, escrow.connect(bob).reveal.staticCall(0, buyerLimit, salt), "NotTrader");
  await expectError(escrow, escrow.connect(bob).reveal.staticCall(1, sellerLimit, salt), "InvalidOpening");
  await expectError(escrow, escrow.connect(bob).reveal.staticCall(1, sellerLimit + 1n, otherSalt), "InvalidOpening");
  await expectError(escrow, escrow.connect(alice).reveal.staticCall(0, buyerLimit, salt), "AlreadyRevealed");
  await expectError(escrow, escrow.connect(bob).refund.staticCall(1), "RefundWindowNotOpen");

  await provider.send("evm_setNextBlockTimestamp", [revealEnd]);
  const refundReceipt = await mined(escrow.connect(bob).refund(1, { gasLimit: 150_000 }));
  assert.equal((await provider.getBlock(refundReceipt.blockNumber)).timestamp, revealEnd);
  await expectError(escrow, escrow.connect(bob).reveal.staticCall(1, sellerLimit, otherSalt), "RevealWindowClosed");
  await expectError(escrow, escrow.connect(bob).refund.staticCall(0), "NotTrader");
  await expectError(escrow, escrow.connect(bob).refund.staticCall(1), "AlreadyClaimed");
  await mined(escrow.connect(alice).refund(0));
  assert.equal(await usdc.balanceOf(alice.address), buyerStart);
  assert.equal(await eth.balanceOf(bob.address), sellerStart);
  assert.equal(await usdc.balanceOf(escrow.target), 0n);
  assert.equal(await eth.balanceOf(escrow.target), 0n);
  t.diagnostic(`Escrow Gas: commit=${buyReceipt.gasUsed}, reveal=${openedReceipt.gasUsed}, unrevealed refund=${refundReceipt.gasUsed}`);
});
