// The grid is fixed before comparing results. Every book starts at the demo reserves.
const order = (role, buy, amount, minimum, partialMinimum) => ({
  role, buy, amount: String(amount), minimum: String(minimum),
  ...(partialMinimum === undefined ? {} : { partialMinimum: String(partialMinimum) }),
});

export function studyCases() {
  const cases = [];
  const add = (family, index, orders) => cases.push({ id: `${family}/${index}`, orders });

  for (const [i, size] of [5, 8, 10, 12, 15, 20].entries()) {
    add("balanced", i, [
      order("alice", true, 2000 * size, 0), order("bob", false, size, 0),
    ]);
    add("buy-surplus", i, [
      order("alice", true, 2000 * size + 6000, size - 1), order("bob", false, size, 1900 * size),
      order("arb", false, 1, 2000),
    ]);
    add("sell-surplus", i, [
      order("alice", true, 2000 * size, size - 1), order("bob", false, size + 3, 1900 * (size + 3)),
      order("arb", true, 2000, "0.95"),
    ]);
    add("one-sided", i, i % 2 === 0
      ? [order("alice", true, 2000 * size, 0), order("arb", true, 2400, "1.4", 1750)]
      : [order("bob", false, size, 0), order("arb", false, 2, 5000, 1)]);
    add("partial-buy", i, [
      order("alice", true, 2000 * size + 4000, size + 2, 2000 * size - 1000),
      order("bob", false, size, 2000 * size),
    ]);
    add("partial-sell", i, [
      order("alice", true, 2000 * size, size),
      order("bob", false, size + 2, 2000 * (size + 2), size - 1),
    ]);
  }

  for (const [i, limit] of [18000, 18132, 18133, 19000, 20000, 20100].entries()) {
    add("joint-recovery", i, [
      order("alice", true, 20000, "9.7"), order("arb", true, 8000, 4),
      order("bob", false, 10, limit),
    ]);
    add("mixed-limits", i, [
      order("alice", true, 20000, "9.85"), order("arb", true, 8000, "3.93", 4000 - 100 * i),
      order("bob", false, 10, limit), order("bot", false, "1.9", 3800),
    ]);
  }

  add("incompatible-limits", 0, [
    order("alice", true, 24000, 12, 19000), order("bob", false, 10, 20001),
  ]);
  add("incompatible-limits", 1, [
    order("alice", true, 20000, "10.01"), order("bob", false, 12, 24000, 9),
  ]);

  for (const [i, orderBook] of cases.filter(({ id }) =>
    ["balanced/2", "joint-recovery/4", "partial-buy/2", "mixed-limits/0"].includes(id)).entries()) {
    cases.push({ id: `reverse/${i}`, orders: [...orderBook.orders].reverse(), reverseOf: orderBook.id });
  }
  return cases;
}
