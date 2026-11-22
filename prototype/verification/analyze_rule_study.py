#!/usr/bin/env python3
"""Audit Hardhat receipts and enumerate small-book settlement alternatives off-chain."""

import argparse
from collections import defaultdict
from fractions import Fraction
from itertools import product
from math import ceil
import json
from pathlib import Path
from statistics import median


UNIT = 10**18
FEE = Fraction(997, 1000)
RULES = ("v2.2", "variant_A", "variant_B", "variant_AB")


def quote(pool, orders, fills):
    """Evaluate a fixed fill vector using the specified UCP and integer token units."""
    x, y = pool
    buys = sum(f for o, f in zip(orders, fills) if o["side"] == "buyETH")
    sells = sum(f for o, f in zip(orders, fills) if o["side"] == "sellETH")
    spot = Fraction(y, x)
    final_pool = pool
    if not buys and not sells:
        price, eth_out, cash_out, cow = int(spot * UNIT), 0, 0, 0
    elif not sells or Fraction(buys, sells) > spot / FEE:
        price = int((y / FEE + buys) * UNIT / (x + sells))
        cash_out = cow = sells * price // UNIT
        net_cash = buys - cow
        eth_from_pool = int(x * net_cash * FEE / (y + net_cash * FEE))
        eth_out = sells + eth_from_pool
        final_pool = x - eth_from_pool, y + net_cash
    elif Fraction(buys, sells) < spot * FEE:
        price = int((y + buys) * FEE * UNIT / (x + sells * FEE))
        matched_eth = min(sells, buys * UNIT // price)
        net_eth = sells - matched_eth
        cash_from_pool = int(y * net_eth * FEE / (x + net_eth * FEE))
        eth_out, cash_out, cow = matched_eth, buys + cash_from_pool, buys
        final_pool = x + net_eth, y - cash_from_pool
    else:
        price = buys * UNIT // sells
        eth_out, cash_out, cow = sells, buys, buys
    payouts = tuple(
        0 if not filled else filled * eth_out // buys if order["side"] == "buyETH"
        else filled * cash_out // sells
        for order, filled in zip(orders, fills)
    )
    return price, cow, payouts, final_pool


def amounts(orders, key):
    return tuple(int(order[key]) for order in orders)


def is_feasible(orders, fills, payouts, baseline_payouts):
    return all(
        out >= floor and out * int(order["submittedIn"]) >= int(order["minOut"]) * fill
        for order, fill, out, floor in zip(orders, fills, payouts, baseline_payouts)
    )


def two_order_candidate(pool, orders, baseline_fills, baseline_payouts):
    """Try one additional amount from the full opposing order valued at initial spot."""
    opted = [i for i, o in enumerate(orders) if o["partialFillMinimum"]]
    if len(orders) != 2 or len(opted) != 1 or orders[0]["side"] == orders[1]["side"]:
        return None
    i, = opted
    if baseline_fills[i]:
        return None
    submitted = amounts(orders, "submittedIn")
    x, y = pool
    intended = submitted[1 - i] * y // x if orders[i]["side"] == "buyETH" else submitted[1 - i] * x // y
    if not int(orders[i]["partialFillMinimum"]) <= intended < submitted[i]:
        return None
    fills = list(submitted)
    fills[i] = intended
    _, cow, payouts, _ = quote(pool, orders, fills)
    feasible = is_feasible(orders, fills, payouts, baseline_payouts)
    return {"feasible": feasible, "fills": list(map(str, fills)),
            "payouts": list(map(str, payouts)), "cowUSDC": str(cow) if feasible else None}


def reference(pool, orders, baseline_fills, baseline_payouts, partial):
    """Maximize internal matching over full orders and up to one trimmed order."""
    submitted = amounts(orders, "submittedIn")
    choices = [(fill,) if fill else (0, total) for fill, total in zip(baseline_fills, submitted)]
    grids = [choices]
    if partial:
        for i, order in enumerate(orders):
            minimum = order["partialFillMinimum"]
            if not minimum or baseline_fills[i]:
                continue
            minimum = int(minimum)
            step = 250 * UNIT if order["side"] == "buyETH" else UNIT // 4
            grid = range(((minimum + step - 1) // step) * step, submitted[i], step)
            trimmed = list(choices)
            trimmed[i] = tuple(sorted({minimum, *grid}))
            grids.append(trimmed)

    best = -1
    witness = None
    for grid in grids:
        for fills in product(*grid):
            _, cow, payouts, _ = quote(pool, orders, fills)
            if cow <= best or not is_feasible(orders, fills, payouts, baseline_payouts):
                continue
            best = cow
            witness = {"fills": list(map(str, fills)), "payouts": list(map(str, payouts))}
    assert best >= 0
    return best, witness


def audit(run):
    orders = run["orders"]
    fills = amounts(orders, "filledIn")
    payouts = amounts(orders, "receivedOut")
    refunds = amounts(orders, "refundedIn")
    submitted = amounts(orders, "submittedIn")
    batch, = run["batches"]
    pool = tuple(int(batch["initialPool"][k]) for k in ("eth", "usdc"))
    price, cow, expected, reserves = quote(pool, orders, fills)
    assert expected == payouts
    assert price == int(run["clearingPrice"]) and cow == int(run["cowUSDC"])
    assert reserves == tuple(int(batch["finalPool"][k]) for k in ("eth", "usdc"))
    assert reserves[0] * reserves[1] >= pool[0] * pool[1]
    conservation = list(pool)
    for order, total, fill, out, refund in zip(orders, submitted, fills, payouts, refunds):
        buy = order["side"] == "buyETH"
        assert 0 <= fill <= total and fill + refund == total
        assert order["status"] == ("Refunded" if not fill else "Settled" if fill == total else "PartialFilled")
        if 0 < fill < total:
            assert order["partialFillEnabled"] and fill >= int(order["partialFillMinimum"])
        assert out * total >= int(order["minOut"]) * fill
        conservation[buy] += fill
        conservation[not buy] -= out
    assert sum(o["status"] == "Refunded" for o in orders) == batch["refundedCount"]
    for i, asset in enumerate(("mETH", "mUSDC")):
        assert 0 <= conservation[i] - reserves[i] == int(run["dustWei"][asset]) < len(orders)
    by_action = run["gas"]["byAction"]
    assert len(run["steps"]) == 2 * len(orders) + 1
    for action, counted in by_action.items():
        assert counted == sum(r["gasUsed"] for r in run["steps"] if r["action"] == action)
    assert run["gas"]["total"] == sum(by_action.values())
    return pool, fills, payouts


def outcomes(run):
    return {o["trader"]: (o["status"], o["filledIn"], o["receivedOut"], o["refundedIn"]) for o in run["orders"]}


def summarize(study):
    by_case = defaultdict(dict)
    for run in study["scenarios"]:
        row = by_case[run["scenarioId"]]
        assert run["ruleVersion"] not in row
        row[run["ruleVersion"]] = run
    metrics = defaultdict(list)
    by_family = defaultdict(lambda: defaultdict(list))
    combined_vs_single = defaultdict(int)
    additional_candidates = defaultdict(int)
    repeats = 0
    records = []
    versions = {}
    assert len(study["cases"]) == len(by_case)
    for case in study["cases"]:
        case_id = case["id"]
        runs = by_case[case_id]
        assert set(runs) == set(RULES)
        base = runs["v2.2"]
        pool, base_fills, base_payouts = audit(base)
        orders = base["orders"]
        full_cow, full_witness = reference(pool, orders, base_fills, base_payouts, partial=False)
        grid_cow, grid_witness = reference(pool, orders, base_fills, base_payouts, partial=True)
        record = {
            "caseId": case_id,
            "inputs": [{k: o[k] for k in ("trader", "side", "submittedIn", "minOut", "partialFillMinimum")}
                       for o in orders],
            "reference": {
                "wholeOrders": {"cowUSDC": str(full_cow), **full_witness},
                "withPartialGrid": {"cowUSDC": str(grid_cow), **grid_witness},
            },
            "rules": {},
        }
        if "reverseOf" not in case:
            combined = int(runs["variant_AB"]["cowUSDC"])
            best_single = max(int(runs[rule]["cowUSDC"]) for rule in ("variant_A", "variant_B"))
            comparison = "higher" if combined > best_single else "lower" if combined < best_single else "equal"
            combined_vs_single[comparison] += 1
        candidate = two_order_candidate(pool, orders, base_fills, base_payouts)
        if candidate is not None:
            record["spotCandidateTwoOrders"] = candidate
            if "reverseOf" not in case:
                additional_candidates["evaluated"] += 1
                if candidate["feasible"]:
                    additional_candidates["feasible"] += 1
                    additional_candidates["higherCoWThanB"] += (
                        int(candidate["cowUSDC"]) > int(runs["variant_B"]["cowUSDC"])
                    )
        for rule, run in runs.items():
            versions.setdefault(rule, run["buildVersion"])
            assert versions[rule] == run["buildVersion"]
            if rule != "v2.2":
                input_keys = record["inputs"][0].keys()
                assert [{k: o[k] for k in input_keys} for o in run["orders"]] == record["inputs"]
                actual_pool, fills, payouts = audit(run)
                assert actual_pool == pool
                assert all(f == old_fill and p >= old_out for f, p, old_fill, old_out
                           in zip(fills, payouts, base_fills, base_payouts) if old_fill)
            target = full_cow if rule in ("v2.2", "variant_A") else grid_cow
            cow = int(run["cowUSDC"])
            assert int(base["cowUSDC"]) <= cow <= target
            changed = outcomes(run) != outcomes(base)
            if "reverseOf" in case:
                forward = by_case[case["reverseOf"]][rule]
                assert outcomes(run) == outcomes(forward)
                assert run["batches"][0]["finalPool"] == forward["batches"][0]["finalPool"]
                assert all(run[k] == forward[k] for k in ("clearingPrice", "cowUSDC"))
            else:
                observation = (cow > int(base["cowUSDC"]), changed, cow < target, cow < grid_cow,
                               run["gas"]["total"], base["gas"]["total"], run["settleGas"])
                metrics[rule].append(observation)
                by_family[case_id.split("/")[0] if "/" in case_id else "demo"][rule].append(observation)
            if rule == "variant_AB":
                assert all(
                    int(o["filledIn"]) == int(a["filledIn"]) and int(o["receivedOut"]) >= int(a["receivedOut"])
                    for o, a in zip(run["orders"], runs["variant_A"]["orders"]) if int(a["filledIn"])
                )
            record["rules"][rule] = {
                "cowUSDC": str(cow), "settleGas": run["settleGas"], "fullLifecycleGas": run["gas"]["total"],
                "outcomesByTrader": outcomes(run), "referenceGapUSDC": str(target - cow),
            }
        repeats += int("reverseOf" in case)
        records.append(record)

    def report(results):
        increases = [(gas / base - 1) * 100 for _, _, _, _, gas, base, _ in results]
        return {
            "cases": len(results),
            "higherCoW": sum(win for win, *_ in results),
            "changedOrders": sum(changed for _, changed, *_ in results),
            "belowRuleScopeReference": sum(gap for _, _, gap, *_ in results),
            "belowCommonPartialGridReference": sum(gap for _, _, _, gap, *_ in results),
            "medianFullLifecycleGasDeltaPercent": round(median(increases), 2),
            "medianFullLifecycleGasDeltaPercentUnchanged": round(
                median(delta for (_, changed, *_), delta in zip(results, increases) if not changed), 2
            ),
            "p90SettlementGas": sorted(s for *_, s in results)[ceil(0.9 * len(results)) - 1],
            "maxSettlementGasInStudy": max(s for *_, s in results),
        }

    return {
        "evidence": "Hardhat receipts checked against a separate fixed-fill Python implementation",
        "reference": "All whole-order subsets plus at most one optional trim on a grid of 250 mUSDC or 0.25 mETH, including opt-in minima",
        "constraints": "Limits, user-authorized amounts, and original v2.2 filled quantity and payout floors",
        "buildVersions": versions,
        "forwardBooks": len(by_case) - repeats,
        "reversedBooks": repeats,
        "contractRuns": len(study["scenarios"]),
        "metrics": {rule: report(values) for rule, values in metrics.items()},
        "offlineTwoOrderSpotCandidates": dict(additional_candidates),
        "combinedVsBestSingleCoW": {label: combined_vs_single[label] for label in ("higher", "equal", "lower")},
        "higherCoWByFamily": {
            family: {rule: sum(win for win, *_ in results) for rule, results in values.items()}
            for family, values in by_family.items()
        },
        "cases": records,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = summarize(json.loads(args.trace.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "cases"}, indent=2))


if __name__ == "__main__":
    main()
