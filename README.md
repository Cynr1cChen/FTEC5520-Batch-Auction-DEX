# BatchClear

**A Batch Auction DEX for Studying Order Dependence and Clearing Trade-offs**

批处理 DEX 中的交易顺序影响与清算规则权衡

CUHK FTEC5520A · Group 9

A classroom prototype comparing sequential constant-product swaps with batch settlement. The batch DEX uses a uniform clearing price, directly matches opposing orders where possible, and routes residual demand through its pool. The rule lab compares the original clearing rule with whole-order reconsideration (A), opt-in two-tier partial filling (B), and their sequential combination (A+B).

All assets and transactions in Live mode are on a local Hardhat test chain. The interface uses ETH and USDC as display labels for mock tokens.

## Start here

| Resource | Where to find it |
| --- | --- |
| System design, results, and defense questions | [项目原理深度学习与答辩通关手册](docs/FTEC5520_项目原理深度学习与答辩通关手册.pdf) |
| How to navigate the five acts | [前端界面讲解与 Demo 走位排练手册](docs/FTEC5520_前端界面讲解与Demo走位排练手册.pdf) |
| English narration with Chinese cues | [课堂 Demo 演示双语讲稿](docs/FTEC5520_课堂Demo演示双语讲稿.pdf) |
| Smart contracts and local tests | [Contracts](prototype/contracts/) · [Tests](prototype/test/) |
| Replay and research datasets | [Verification](prototype/verification/) |

## Install and verify

Install Node.js 24 and pnpm 11.25.0. From the repository root:

```sh
cd prototype
./demo-env install --frozen-lockfile --ignore-scripts
./demo-env test
cd frontend
../demo-env install --frozen-lockfile --ignore-scripts
../demo-env run typecheck
../demo-env run build
```

The launcher uses a compatible Node on your PATH. When multiple installations are present, set `FTEC5520_NODE_BIN` to the directory containing the Node 24 executable you want to use.

## Replay

In a terminal opened at the repository root:

```sh
cd prototype/frontend
../demo-env run dev
```

Open the local address printed by Vite (normally [127.0.0.1:5173](http://127.0.0.1:5173/)). Replay uses bundled JSON fixtures and works without a running Hardhat node. To use the production build, run `../demo-env run preview` from the frontend directory and open the printed address.

## Live

Open three terminals at the repository root and run these commands in order:

| Terminal | Command |
| --- | --- |
| 1 · keep running | `cd prototype && ./demo-env run node` |
| 2 · after the node starts | `cd prototype && ./demo-env demo:deploy --variants` |
| 3 · keep running | `cd prototype/frontend && ../demo-env run dev` |

Open the frontend and select **Live**. **Reset** restores the local deployment snapshot. After restarting Hardhat, deploy again. The development server brokers local RPC; use the development server for Live.

## Reproduce the rule comparison

Run from `prototype/`:

```sh
./demo-env demo:export-rules
./demo-env demo:export-rules --study
python3 verification/analyze_rule_study.py runtime/rule_study_trace.json verification/rule_study_results.json
```

The demo dataset contains 14 presets and 31 run records. The study contains 55 small order books and four reversal checks, with 236 executions across four rules. Gas totals for batch orders include submission, settlement, and claiming. Deployment and preapproval are outside those totals. More direct matching measures trading volume, and net economic benefit depends separately on trading value and fees.
