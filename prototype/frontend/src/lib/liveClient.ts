import { Contract, Interface, JsonRpcProvider, parseUnits } from 'ethers';
import { GUARDRAILS, LIVE_SCENE_SPECS, RULE_ORDER, type LiveSceneSpec } from '../data/traces';
import type { Lang } from '../i18n';
import type {
  BatchRecord,
  DeploymentManifest,
  GuardrailDefinition,
  GuardrailResult,
  OrderRecord,
  RoundCheck,
  RoundRecord,
  RuleVersion,
  ScenarioTrace,
  SettlementEvent,
  StepRecord,
} from '../types/trace';

const units = (amount: string) => parseUnits(amount, 18);

export function browserRpcUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8545';
  return `${window.location.origin}/rpc`;
}

export function createBrowserProvider(): JsonRpcProvider {
  return new JsonRpcProvider(browserRpcUrl(), undefined, { cacheTimeout: -1 });
}

export interface LiveConnectionInfo {
  connected: boolean;
  manifest: DeploymentManifest | null;
  nodeInstanceId: string | null;
  staleNodeMismatch: boolean;
  hasVariants: boolean;
  errorMessage?: string;
}

export async function inspectLiveEnvironment(lang: Lang = 'en'): Promise<LiveConnectionInfo> {
  const en = lang === 'en';
  try {
    const res = await fetch('/api/deployment', { cache: 'no-store' });
    const data = (await res.json()) as { ok: boolean; manifest?: DeploymentManifest; message?: string; error?: string };
    if (!res.ok || !data.ok || !data.manifest) {
      return {
        connected: false,
        manifest: null,
        nodeInstanceId: null,
        staleNodeMismatch: false,
        hasVariants: false,
        errorMessage:
          (en
            ? 'Deployment manifest not found (run ./demo-env run node & ./demo-env demo:deploy --variants in prototype/).'
            : data.message) ||
          data.error ||
          (en ? 'Deployment manifest not found' : '未检测到本地部署清单'),
      };
    }

    const provider = createBrowserProvider();
    try {
      const meta = (await provider.send('hardhat_metadata', [])) as { chainId: number; instanceId: string };
      const stale = meta.instanceId !== data.manifest.nodeInstanceId || meta.chainId !== data.manifest.chainId;
      const hasVariants = Boolean(
        data.manifest.variants?.variant_A &&
          data.manifest.variants?.variant_B &&
          data.manifest.variants?.variant_AB,
      );
      return {
        connected: !stale,
        manifest: data.manifest,
        nodeInstanceId: meta.instanceId,
        staleNodeMismatch: stale,
        hasVariants,
        errorMessage: stale
          ? en
            ? 'Hardhat node restarted; deployment manifest is stale. Click "Redeploy".'
            : 'Hardhat 节点已重启，当前部署清单已过期，请点击「重新部署」'
          : undefined,
      };
    } catch (rpcErr) {
      return {
        connected: false,
        manifest: data.manifest,
        nodeInstanceId: null,
        staleNodeMismatch: false,
        hasVariants: Boolean(data.manifest.variants?.variant_A),
        errorMessage: en
          ? `Cannot connect to local Hardhat node (${(rpcErr as Error).message})`
          : `无法连接本地 Hardhat 节点 (${(rpcErr as Error).message})`,
      };
    } finally {
      provider.destroy();
    }
  } catch (err) {
    return {
      connected: false,
      manifest: null,
      nodeInstanceId: null,
      staleNodeMismatch: false,
      hasVariants: false,
      errorMessage: (err as Error).message,
    };
  }
}

export async function resetDemoViaApi(lang: Lang = 'en'): Promise<DeploymentManifest> {
  const res = await fetch('/api/reset', { method: 'POST' });
  const data = (await res.json()) as { ok: boolean; manifest?: DeploymentManifest; error?: string };
  if (!res.ok || !data.ok || !data.manifest) {
    throw new Error(
      data.error || (lang === 'en' ? 'Reset failed (Hardhat node may have restarted)' : 'Reset 失败（节点可能已重启）'),
    );
  }
  return data.manifest;
}

export async function redeployDemoViaApi(lang: Lang = 'en'): Promise<DeploymentManifest> {
  const res = await fetch('/api/deploy', { method: 'POST' });
  const data = (await res.json()) as { ok: boolean; manifest?: DeploymentManifest; error?: string };
  if (!res.ok || !data.ok || !data.manifest) {
    throw new Error(
      data.error || (lang === 'en' ? 'Deploy failed; verify hardhat node is running' : '部署失败，请确认 hardhat node 正在运行'),
    );
  }
  return data.manifest;
}

export function getRuleContractMeta(manifest: DeploymentManifest, ruleVersion: RuleVersion, lang: Lang = 'en') {
  if (ruleVersion === 'traditional_amm') {
    return {
      address: manifest.addresses.traditionalAMM,
      abi: manifest.abis.TraditionalAMM,
      buildVersion: manifest.traditionalAMMBuildVersion ?? manifest.buildVersion,
      initialBatchEndTime: null as number | null,
    };
  }
  if (ruleVersion === 'v2.2') {
    return {
      address: manifest.addresses.batchAuctionDEX,
      abi: manifest.abis.BatchAuctionDEX,
      buildVersion: manifest.buildVersion,
      initialBatchEndTime: manifest.initialState.batchEndTime,
    };
  }
  const variant = manifest.variants?.[ruleVersion];
  if (!variant) {
    throw new Error(
      lang === 'en'
        ? `Manifest missing ${ruleVersion}; redeploy with --variants.`
        : `部署清单缺少 ${ruleVersion}，请使用 --variants 重新部署。`,
    );
  }
  return {
    address: variant.address,
    abi: variant.abi,
    buildVersion: variant.buildVersion,
    initialBatchEndTime: variant.batchEndTime,
  };
}

async function confirmed(
  txPromise: Promise<{ wait: () => Promise<{ status?: number | null } | null> }>,
  lang: Lang = 'en',
) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(lang === 'en' ? 'On-chain transaction confirmation failed' : '链上交易确认失败');
  }
  return receipt;
}

async function quoteRounds(
  dex: Contract,
  pool: { eth: string; usdc: string },
  submitted: Array<{ orderId: number; buy: boolean; amountIn: bigint; minOut: bigint }>,
): Promise<RoundRecord[]> {
  let active = submitted;
  const rounds: RoundRecord[] = [];
  for (;;) {
    const buyTotal = active.filter((o) => o.buy).reduce((acc, o) => acc + o.amountIn, 0n);
    const sellTotal = active.filter((o) => !o.buy).reduce((acc, o) => acc + o.amountIn, 0n);
    const quote = await dex._solve(BigInt(pool.eth), BigInt(pool.usdc), buyTotal, sellTotal);
    const checks: RoundCheck[] = active.map(({ orderId, buy, amountIn, minOut }) => {
      const totalPayout: bigint = buy ? quote.ethToBuyers : quote.usdcToSellers;
      const denom = buy ? buyTotal : sellTotal;
      const quotedOut = denom === 0n ? 0n : (amountIn * totalPayout) / denom;
      return {
        orderId,
        quotedOut: quotedOut.toString(),
        minOut: minOut.toString(),
        excluded: quotedOut < minOut,
      };
    });
    const excluded = new Set(checks.filter((c) => c.excluded).map((c) => c.orderId));
    rounds.push({
      round: rounds.length,
      clearingPrice: quote.price.toString(),
      buyTotal: buyTotal.toString(),
      sellTotal: sellTotal.toString(),
      checks,
      excludedOrderIds: [...excluded],
    });
    if (excluded.size === 0) return rounds;
    active = active.filter((o) => !excluded.has(o.orderId));
  }
}

export interface LiveRunResult {
  trace: ScenarioTrace;
  manifest: DeploymentManifest;
}

export interface LiveOrderProgress {
  id: string;
  orderId: number;
  batchId: number | null;
  trader: string;
  side: 'buyETH' | 'sellETH';
  assetIn: 'mETH' | 'mUSDC';
  assetOut: 'mETH' | 'mUSDC';
  submittedIn: string;
  minOut: string;
  partialFillMinimum: string | null;
  filledIn: string | null;
  receivedOut: string | null;
  refundedIn: string | null;
  status: 'Pending' | 'Settled' | 'PartialFilled' | 'Refunded';
  claimed: boolean;
}

export interface LiveStepEvent {
  phase: 'idle' | 'reset' | 'submit' | 'swap' | 'settle' | 'claim' | 'done';
  batchId: number | null;
  poolState: {
    eth: string;
    usdc: string;
    ucp: string | null;
    cowUSDC: string | null;
  };
  windowProgressPct: number;
  latestStep?: StepRecord;
  completedSteps: StepRecord[];
  ordersSoFar: LiveOrderProgress[];
  batchesSoFar: BatchRecord[];
  activeRounds?: RoundRecord[];
  message: string;
}

export interface LiveScenarioOptions {
  onEvent?: (evt: LiveStepEvent) => void;
  stepDelayMs?: number;
}

async function pauseMs(ms: number) {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export async function runLiveScenario(
  scenarioId: string,
  ruleVersion: RuleVersion,
  onProgress?: (msg: string) => void,
  lang: Lang = 'en',
  options?: LiveScenarioOptions,
): Promise<LiveRunResult> {
  const en = lang === 'en';
  const scene: LiveSceneSpec | undefined = LIVE_SCENE_SPECS[scenarioId];
  if (!scene) {
    throw new Error(en ? `Unknown scenario: ${scenarioId}` : `未知场景 ${scenarioId}`);
  }

  const delayMs = options?.stepDelayMs ?? (options?.onEvent ? 320 : 0);

  onProgress?.(
    en
      ? 'Restoring initial EVM snapshot (100 ETH / 200,000 USDC)…'
      : '正在恢复初始快照 (100 ETH / 200,000 USDC)…',
  );
  const manifest = await resetDemoViaApi(lang);
  const provider = createBrowserProvider();

  try {
    const latestBlock = await provider.getBlock('latest');
    if (!latestBlock) {
      throw new Error(en ? 'Unable to read latest block timestamp' : '无法读取最新区块时间戳');
    }
    let lastBlockTs = Number(latestBlock.timestamp);

    const isAmm = ruleVersion === 'traditional_amm';
    const supportsPartial = ruleVersion === 'variant_B' || ruleVersion === 'variant_AB';
    const ruleMeta = getRuleContractMeta(manifest, ruleVersion, lang);
    const pool = new Contract(ruleMeta.address, ruleMeta.abi as never, provider);
    const eth = new Contract(manifest.addresses.mockETH, manifest.abis.MockToken as never, provider);
    const usdc = new Contract(manifest.addresses.mockUSDC, manifest.abis.MockToken as never, provider);
    const tokens: Record<'mETH' | 'mUSDC', Contract> = { mETH: eth, mUSDC: usdc };
    const dexInterface = new Interface(ruleMeta.abi as never);

    const readReserves = async () => ({
      eth: (await pool.reserveETH()).toString(),
      usdc: (await pool.reserveUSDC()).toString(),
    });

    const initialReserves = await readReserves();
    const initialState: ScenarioTrace['initialState'] = isAmm
      ? { pool: initialReserves, feeBps: manifest.initialState.feeBps }
      : {
          pool: initialReserves,
          feeBps: manifest.initialState.feeBps,
          batchId: 0,
          batchEndTime: Number((await pool.batches(0)).endTime),
          batchDurationSeconds: manifest.batchDurationSeconds,
        };

    const gasByAction: Record<string, number> = isAmm ? { swap: 0 } : { submitOrder: 0, settleBatch: 0, claim: 0 };
    const steps: StepRecord[] = [];
    const orders: OrderRecord[] = [];
    const ordersProgress: LiveOrderProgress[] = [];
    const batches: BatchRecord[] = [];
    const settlementEvents: SettlementEvent[] = [];
    const unclaimed = new Map<number, OrderRecord>();

    const emit = async (
      phase: LiveStepEvent['phase'],
      batchId: number | null,
      poolState: LiveStepEvent['poolState'],
      windowProgressPct: number,
      message: string,
      latestStep?: StepRecord,
      activeRounds?: RoundRecord[],
    ) => {
      options?.onEvent?.({
        phase,
        batchId,
        poolState: { ...poolState },
        windowProgressPct,
        latestStep,
        completedSteps: [...steps],
        ordersSoFar: ordersProgress.map((o) => ({ ...o })),
        batchesSoFar: [...batches],
        activeRounds,
        message,
      });
      await pauseMs(delayMs);
    };

    await emit(
      'reset',
      isAmm ? null : 0,
      { ...initialReserves, ucp: null, cowUSDC: null },
      0,
      en
        ? 'Initial EVM snapshot restored (100 ETH / 200,000 USDC)'
        : '已恢复初始 EVM 快照（100 ETH / 200,000 USDC）',
    );

    async function recordStep(
      action: string,
      actor: string,
      sendTx: () => Promise<{ wait: () => Promise<{ status?: number | null } | null> }>,
      batchId: number | null,
      orderId: number | null,
      explicitTimestamp?: number,
    ): Promise<StepRecord> {
      const nextTs =
        explicitTimestamp !== undefined
          ? Math.max(lastBlockTs + 1, explicitTimestamp)
          : lastBlockTs + 1;
      await provider.send('evm_setNextBlockTimestamp', [nextTs]);
      const receipt = (await confirmed(sendTx(), lang)) as unknown as {
        hash: string;
        blockNumber: number;
        index: number;
        gasUsed: bigint;
        logs: Array<{ address: string; topics: string[]; data: string }>;
        getBlock: () => Promise<{ timestamp: number }>;
      };
      const block = await receipt.getBlock();
      lastBlockTs = block.timestamp;
      const gasUsed = Number(receipt.gasUsed);
      gasByAction[action] = (gasByAction[action] ?? 0) + gasUsed;

      let settledBatch: { settled: boolean; clearingPrice: bigint; cowUSDC: bigint } | null = null;
      if (batchId !== null) {
        settledBatch = await pool.batches(batchId);
      }
      if (action === 'settleBatch') {
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== ruleMeta.address.toLowerCase()) continue;
          try {
            const parsed = dexInterface.parseLog(log);
            if (parsed && (parsed.name === 'OrderReconsidered' || parsed.name === 'BatchPartialFill')) {
              settlementEvents.push({
                name: parsed.name,
                args: Object.fromEntries(
                  parsed.fragment.inputs.map((inp, idx) => [inp.name, String(parsed.args[idx])]),
                ),
              });
            }
          } catch {
            // ignore non-matching logs
          }
        }
      }

      const stepRecord: StepRecord = {
        label: action,
        action,
        actor,
        orderId,
        batchId,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        transactionIndex: receipt.index,
        timestamp: block.timestamp,
        gasUsed,
        poolStateAfter: {
          ...(await readReserves()),
          ucp: settledBatch?.settled ? settledBatch.clearingPrice.toString() : null,
          cowUSDC: settledBatch?.settled ? settledBatch.cowUSDC.toString() : null,
        },
      };
      steps.push(stepRecord);
      return stepRecord;
    }

    async function computeDust(): Promise<{ mETH: string; mUSDC: string }> {
      const reserves = await readReserves();
      const accounted: Record<'mETH' | 'mUSDC', bigint> = {
        mETH: BigInt(reserves.eth),
        mUSDC: BigInt(reserves.usdc),
      };
      for (const order of unclaimed.values()) {
        accounted[order.assetIn] += BigInt(order.refundedIn);
        accounted[order.assetOut] += BigInt(order.receivedOut);
      }
      const surplus = { mETH: '0', mUSDC: '0' };
      for (const asset of ['mETH', 'mUSDC'] as const) {
        const bal: bigint = await tokens[asset].balanceOf(ruleMeta.address);
        const diff = bal - accounted[asset];
        if (diff < 0n) {
          throw new Error(
            en ? `Contract fund conservation check failed (${asset})` : `合约资金守恒校验失败 (${asset})`,
          );
        }
        surplus[asset] = diff.toString();
      }
      return surplus;
    }

    async function claimOrder(order: OrderRecord) {
      const signer = await provider.getSigner(manifest.roles[order.trader as keyof typeof manifest.roles]);
      const inbound = tokens[order.assetIn];
      const outbound = tokens[order.assetOut];
      const beforeIn: bigint = await inbound.balanceOf(signer.address);
      const beforeOut: bigint = await outbound.balanceOf(signer.address);
      const connected = pool.connect(signer) as Contract;
      const step = await recordStep('claim', order.trader, () => connected.claim(order.orderId), order.batchId, order.orderId);
      const gotIn: bigint = (await inbound.balanceOf(signer.address)) - beforeIn;
      const gotOut: bigint = (await outbound.balanceOf(signer.address)) - beforeOut;
      if (gotIn !== BigInt(order.refundedIn) || gotOut !== BigInt(order.receivedOut)) {
        throw new Error(en ? `Claim payout mismatch (${order.id})` : `领取对账不一致 (${order.id})`);
      }
      unclaimed.delete(order.orderId);
      const prog = ordersProgress.find((o) => o.orderId === order.orderId);
      if (prog) prog.claimed = true;
      await emit(
        'claim',
        order.batchId,
        step.poolStateAfter,
        100,
        en
          ? `${order.trader} claimed order #${order.orderId} (Block #${step.blockNumber})`
          : `${order.trader} 领取订单 #${order.orderId}（区块 #${step.blockNumber}）`,
        step,
        batches.at(-1)?.rounds,
      );
    }

    const invAddr = scene.inventoryRole ? manifest.roles[scene.inventoryRole] : null;
    const initialInventoryEth: bigint | null = invAddr ? await eth.balanceOf(invAddr) : null;
    const initialCashUsdc: bigint | null = invAddr ? await usdc.balanceOf(invAddr) : null;

    const stages = scene.nextBatch ? [scene.orders, scene.nextBatch] : [scene.orders];

    for (let batchIndex = 0; batchIndex < stages.length; batchIndex++) {
      const stageOrders = stages[batchIndex];
      const batchId = isAmm ? null : batchIndex;
      const beforePool = await readReserves();
      const windowBatch = isAmm ? null : await pool.batches(batchId);
      const submitted: Array<{
        orderId: number;
        batchId: number | null;
        trader: string;
        side: 'buyETH' | 'sellETH';
        assetIn: 'mETH' | 'mUSDC';
        assetOut: 'mETH' | 'mUSDC';
        buy: boolean;
        amountIn: bigint;
        minOut: bigint;
        partialFillMinimum: string | null;
        partialFillEnabled: boolean;
        id: string;
      }> = [];

      onProgress?.(
        isAmm
          ? en
            ? 'Executing instant swaps on TraditionalAMM…'
            : '正在传统 AMM 执行即时 Swap…'
          : en
            ? `Submitting orders in Batch ${batchIndex}…`
            : `正在 Batch ${batchIndex} 提交订单…`,
      );

      if (!isAmm && windowBatch !== null) {
        const headroom = Number(windowBatch.endTime) - lastBlockTs;
        if (headroom <= stageOrders.length) {
          throw new Error(
            en
              ? `Remaining batch window (${headroom}s) is too short for ${stageOrders.length} orders; click "Redeploy" to refresh snapshot.`
              : `初始快照剩余批次窗口仅 ${headroom} 秒，不足以提交本批 ${stageOrders.length} 笔订单，请点击「重新部署」刷新快照。`,
          );
        }
      }

      for (let sIdx = 0; sIdx < stageOrders.length; sIdx++) {
        const spec = stageOrders[sIdx];
        const orderId = orders.length + submitted.length;
        const amountIn =
          'amountFromOrder' in spec && spec.amountFromOrder !== undefined
            ? BigInt(orders[spec.amountFromOrder].receivedOut)
            : units(spec.amount ?? '0');
        const minOut = units(spec.minimum);
        const partialMin =
          'partialMinimum' in spec && spec.partialMinimum ? units(spec.partialMinimum) : null;
        const [assetIn, assetOut]: ['mETH' | 'mUSDC', 'mETH' | 'mUSDC'] = spec.buy
          ? ['mUSDC', 'mETH']
          : ['mETH', 'mUSDC'];
        const signer = await provider.getSigner(manifest.roles[spec.role]);
        const connected = pool.connect(signer) as Contract;

        if (isAmm) {
          const outBefore: bigint = await tokens[assetOut].balanceOf(signer.address);
          const swapFn = spec.buy ? connected.swapUSDCForETH : connected.swapETHForUSDC;
          const step = await recordStep('swap', spec.role, () => swapFn(amountIn, minOut), null, orderId);
          const received: bigint = (await tokens[assetOut].balanceOf(signer.address)) - outBefore;
          const entry: OrderRecord = {
            id: `${scene.id}-${spec.role}-${orderId}`,
            orderId,
            batchId: null,
            trader: spec.role,
            side: spec.buy ? 'buyETH' : 'sellETH',
            assetIn,
            assetOut,
            submittedIn: amountIn.toString(),
            minOut: minOut.toString(),
            partialFillMinimum: null,
            partialFillEnabled: false,
            filledIn: amountIn.toString(),
            receivedOut: received.toString(),
            refundedIn: '0',
            status: 'Settled',
          };
          orders.push(entry);
          ordersProgress.push({
            id: entry.id,
            orderId,
            batchId: null,
            trader: entry.trader,
            side: entry.side,
            assetIn,
            assetOut,
            submittedIn: entry.submittedIn,
            minOut: entry.minOut,
            partialFillMinimum: null,
            filledIn: entry.filledIn,
            receivedOut: entry.receivedOut,
            refundedIn: entry.refundedIn,
            status: 'Settled',
            claimed: true,
          });
          await emit(
            'swap',
            null,
            step.poolStateAfter,
            Math.round(((sIdx + 1) / stageOrders.length) * 100),
            en
              ? `${spec.role} executed instant AMM swap #${orderId} (Block #${step.blockNumber})`
              : `${spec.role} 在 AMM 即时成交 #${orderId}（区块 #${step.blockNumber}）`,
            step,
          );
        } else {
          const usePartial = supportsPartial && partialMin !== null;
          const step = await recordStep(
            'submitOrder',
            spec.role,
            () =>
              usePartial
                ? connected.submitPartialOrder(spec.buy, amountIn, minOut, partialMin)
                : connected.submitOrder(spec.buy, amountIn, minOut),
            batchId,
            orderId,
          );
          const sub = {
            id: `${scene.id}-${spec.role}-${orderId}`,
            orderId,
            batchId,
            trader: spec.role,
            side: (spec.buy ? 'buyETH' : 'sellETH') as 'buyETH' | 'sellETH',
            assetIn,
            assetOut,
            buy: spec.buy,
            amountIn,
            minOut,
            partialFillMinimum: partialMin ? partialMin.toString() : null,
            partialFillEnabled: usePartial,
          };
          submitted.push(sub);
          ordersProgress.push({
            id: sub.id,
            orderId,
            batchId,
            trader: sub.trader,
            side: sub.side,
            assetIn,
            assetOut,
            submittedIn: amountIn.toString(),
            minOut: minOut.toString(),
            partialFillMinimum: sub.partialFillMinimum,
            filledIn: null,
            receivedOut: null,
            refundedIn: null,
            status: 'Pending',
            claimed: false,
          });
          await emit(
            'submit',
            batchId,
            step.poolStateAfter,
            Math.min(72, Math.round(((sIdx + 1) / stageOrders.length) * 65)),
            en
              ? `${spec.role} escrowed order #${orderId} into Batch #${batchIndex} (Block #${step.blockNumber})`
              : `${spec.role} 将订单 #${orderId} 托管入 Batch #${batchIndex}（区块 #${step.blockNumber}）`,
            step,
          );
        }
      }

      if (isAmm || windowBatch === null || batchId === null) continue;

      const rounds = scene.showRounds ? await quoteRounds(pool, beforePool, submitted) : undefined;
      onProgress?.(
        en
          ? `Advancing timestamp & settling Batch ${batchIndex} via settleBatch()…`
          : `正在快进时间并在 Batch ${batchIndex} 触发 settleBatch()…`,
      );
      const deployerSigner = await provider.getSigner(manifest.roles.deployer);
      const deployerPool = pool.connect(deployerSigner) as Contract;
      const settleStep = await recordStep(
        'settleBatch',
        'deployer',
        () => deployerPool.settleBatch(),
        batchId,
        null,
        Number(windowBatch.endTime),
      );

      const settled = await pool.batches(batchId);
      for (const s of submitted) {
        const res = await pool.orders(s.orderId);
        const refunded = Number(res.status) === 2;
        const filledIn: bigint = supportsPartial ? res.filledIn : refunded ? 0n : s.amountIn;
        const receivedOut: bigint = supportsPartial ? res.receivedOut : refunded ? 0n : res.payout;
        const refundedIn = s.amountIn - filledIn;
        const status: OrderRecord['status'] =
          filledIn === 0n ? 'Refunded' : filledIn === s.amountIn ? 'Settled' : 'PartialFilled';

        const entry: OrderRecord = {
          id: s.id,
          orderId: s.orderId,
          batchId,
          trader: s.trader,
          side: s.side,
          assetIn: s.assetIn,
          assetOut: s.assetOut,
          submittedIn: s.amountIn.toString(),
          minOut: s.minOut.toString(),
          partialFillMinimum: s.partialFillMinimum,
          partialFillEnabled: s.partialFillEnabled,
          filledIn: filledIn.toString(),
          receivedOut: receivedOut.toString(),
          refundedIn: refundedIn.toString(),
          status,
        };
        orders.push(entry);
        unclaimed.set(entry.orderId, entry);

        const prog = ordersProgress.find((o) => o.orderId === s.orderId);
        if (prog) {
          prog.filledIn = entry.filledIn;
          prog.receivedOut = entry.receivedOut;
          prog.refundedIn = entry.refundedIn;
          prog.status = entry.status;
        }
      }

      batches.push({
        batchId,
        endTime: Number(windowBatch.endTime),
        initialPool: beforePool,
        finalPool: await readReserves(),
        clearingPrice: settled.clearingPrice.toString(),
        cowUSDC: settled.cowUSDC.toString(),
        refundedCount: Number(settled.refundedCount),
        dustWei: await computeDust(),
        ...(rounds ? { roundEvidenceSource: 'solver-calls-derived', rounds } : {}),
      });

      await emit(
        'settle',
        batchId,
        settleStep.poolStateAfter,
        100,
        en
          ? `Window closed -> settleBatch() computed CoW & UCP (Block #${settleStep.blockNumber})`
          : `关窗执行 settleBatch() 完成 CoW 与 UCP 清算（区块 #${settleStep.blockNumber}）`,
        settleStep,
        rounds,
      );

      onProgress?.(
        en ? `Claiming fills/refunds for Batch ${batchIndex}…` : `正在领取 Batch ${batchIndex} 成交额/退款…`,
      );
      for (const s of submitted) {
        // Replicate S3 cross-batch delayed claim: keep Batch 0 non-bot claim until after Batch 1 settles
        if (scene.nextBatch && batchId === 0 && s.trader !== scene.inventoryRole) {
          continue;
        }
        const entry = unclaimed.get(s.orderId);
        if (entry) await claimOrder(entry);
      }
    }

    for (const remaining of [...unclaimed.values()]) {
      await claimOrder(remaining);
    }

    let outcome: ScenarioTrace['outcome'] | undefined;
    if (scene.inventoryRole && initialCashUsdc !== null && initialInventoryEth !== null && invAddr) {
      const cashDelta: bigint = (await usdc.balanceOf(invAddr)) - initialCashUsdc;
      const invDelta: bigint = (await eth.balanceOf(invAddr)) - initialInventoryEth;
      outcome = {
        inventoryRole: scene.inventoryRole,
        cashDeltaMUSDCBeforeNativeGas: cashDelta.toString(),
        inventoryDeltaMETH: invDelta.toString(),
      };
    }

    const lastBatch = batches.at(-1);
    const totalGas = Object.values(gasByAction).reduce((acc, g) => acc + g, 0);

    const trace: ScenarioTrace = {
      scenarioId: scene.id,
      ruleVersion,
      buildVersion: ruleMeta.buildVersion,
      evidenceSource: 'hardhat',
      chainId: manifest.chainId,
      addresses: manifest.addresses,
      roles: manifest.roles,
      initialState,
      clearingPrice: lastBatch ? lastBatch.clearingPrice : null,
      cowUSDC: lastBatch ? lastBatch.cowUSDC : null,
      dustWei: await computeDust(),
      settleGas: isAmm ? null : gasByAction.settleBatch,
      gas: {
        byAction: gasByAction,
        total: totalGas,
        orderCount: orders.length,
        includesApproval: false,
      },
      orders,
      steps,
      settlementEvents,
      batches,
      ...(outcome ? { outcome } : {}),
    };

    options?.onEvent?.({
      phase: 'done',
      batchId: lastBatch ? lastBatch.batchId : null,
      poolState: steps.at(-1)?.poolStateAfter ?? { ...initialReserves, ucp: null, cowUSDC: null },
      windowProgressPct: 100,
      latestStep: steps.at(-1),
      completedSteps: [...steps],
      ordersSoFar: ordersProgress.map((o) => ({ ...o })),
      batchesSoFar: [...batches],
      activeRounds: batches.at(-1)?.rounds,
      message: en
        ? `Confirmed on-chain (${steps.length} txs, Total Gas ${totalGas.toLocaleString('en-US')})`
        : `实链全流程执行完毕（共 ${steps.length} 笔交易，总 Gas ${totalGas.toLocaleString('en-US')}）`,
    });

    return { manifest, trace };
  } finally {
    provider.destroy();
  }
}

export interface LiveRuleSuiteCallbacks {
  onRuleStart?: (rule: 'v2.2' | 'variant_A' | 'variant_B' | 'variant_AB', index: number) => void;
  onRuleStep?: (rule: 'v2.2' | 'variant_A' | 'variant_B' | 'variant_AB', evt: LiveStepEvent) => void;
  onRuleComplete?: (
    rule: 'v2.2' | 'variant_A' | 'variant_B' | 'variant_AB',
    trace: ScenarioTrace,
    index: number,
  ) => void;
  stepDelayMs?: number;
}

export async function runLiveRuleSuite(
  scenarioId: string,
  onProgress?: (msg: string) => void,
  lang: Lang = 'en',
  callbacks?: LiveRuleSuiteCallbacks,
): Promise<{
  tracesByRule: Record<'v2.2' | 'variant_A' | 'variant_B' | 'variant_AB', ScenarioTrace>;
  manifest: DeploymentManifest;
}> {
  const result = {} as Record<'v2.2' | 'variant_A' | 'variant_B' | 'variant_AB', ScenarioTrace>;
  let latestManifest!: DeploymentManifest;
  const stepDelay = callbacks?.stepDelayMs ?? (callbacks ? 130 : 0);
  for (let i = 0; i < RULE_ORDER.length; i++) {
    const rule = RULE_ORDER[i];
    callbacks?.onRuleStart?.(rule, i);
    onProgress?.(
      lang === 'en'
        ? `Running live rule ${i + 1}/4: ${rule}…`
        : `正在实链对比规则 ${i + 1}/4：${rule}…`,
    );
    const run = await runLiveScenario(
      scenarioId,
      rule,
      undefined,
      lang,
      callbacks
        ? {
            onEvent: (evt) => callbacks.onRuleStep?.(rule, evt),
            stepDelayMs: stepDelay,
          }
        : undefined,
    );
    result[rule] = run.trace;
    latestManifest = run.manifest;
    callbacks?.onRuleComplete?.(rule, run.trace, i);
  }
  return { tracesByRule: result, manifest: latestManifest };
}

function extractRevertSelector(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { data?: string; info?: { error?: { data?: string } } };
  const raw = typeof e.data === 'string' ? e.data : e.info?.error?.data;
  if (typeof raw === 'string' && raw.startsWith('0x') && raw.length >= 10) {
    return raw.slice(0, 10).toLowerCase();
  }
  return null;
}

export async function runLiveGuardrail(
  guardrailId: GuardrailDefinition['id'],
  lang: Lang = 'en',
  onStage?: (stage: 'reset' | 'sending' | 'reverted') => void,
): Promise<GuardrailResult> {
  const en = lang === 'en';
  const def = GUARDRAILS.find((g) => g.id === guardrailId);
  if (!def) throw new Error(`Unknown guardrail: ${guardrailId}`);

  onStage?.('reset');
  const manifest = await resetDemoViaApi(lang);
  const provider = createBrowserProvider();

  try {
    const latestBlock = await provider.getBlock('latest');
    if (!latestBlock) {
      throw new Error(en ? 'Unable to read latest block timestamp' : '无法读取最新区块时间戳');
    }
    let lastBlockTs = Number(latestBlock.timestamp);

    const pinAndConfirm = async (
      sendTx: () => Promise<{ wait: () => Promise<{ status?: number | null } | null> }>,
      explicitTimestamp?: number,
    ) => {
      const nextTs =
        explicitTimestamp !== undefined
          ? Math.max(lastBlockTs + 1, explicitTimestamp)
          : lastBlockTs + 1;
      await provider.send('evm_setNextBlockTimestamp', [nextTs]);
      await confirmed(sendTx(), lang);
      const latest = await provider.getBlock('latest');
      if (latest) lastBlockTs = Number(latest.timestamp);
    };

    const dex = new Contract(manifest.addresses.batchAuctionDEX, manifest.abis.BatchAuctionDEX as never, provider);
    const iface = new Interface(manifest.abis.BatchAuctionDEX as never);
    const alice = await provider.getSigner(manifest.roles.alice);
    const bob = await provider.getSigner(manifest.roles.bob);
    const expectedSelector = iface.getError(def.errorName)?.selector.toLowerCase() ?? def.selector.toLowerCase();

    const captureSelector = async (call: () => Promise<unknown>): Promise<string | null> => {
      try {
        await call();
        throw new Error(
          en ? 'Expected contract revert guardrail, but call unexpectedly succeeded' : '预期应被合约 Revert 拦截，但调用意外成功',
        );
      } catch (err) {
        const sel = extractRevertSelector(err);
        if (!sel) throw err;
        return sel;
      }
    };

    onStage?.('sending');
    await pauseMs(220);

    let actualSelector: string | null = null;
    if (guardrailId === 'early_settle') {
      actualSelector = await captureSelector(() => dex.settleBatch.staticCall());
    } else if (guardrailId === 'claim_before_settle') {
      await pinAndConfirm(() => (dex.connect(alice) as Contract).submitOrder(true, units('20000'), 0n));
      actualSelector = await captureSelector(() => (dex.connect(alice) as Contract).claim.staticCall(0n));
    } else if (guardrailId === 'late_submit') {
      const batch = await dex.batches(0);
      await provider.send('evm_setNextBlockTimestamp', [Math.max(lastBlockTs + 1, Number(batch.endTime))]);
      await provider.send('evm_mine', []);
      actualSelector = await captureSelector(() =>
        (dex.connect(bob) as Contract).submitOrder.staticCall(false, units('10'), 0n),
      );
    } else if (guardrailId === 'wrong_owner') {
      await pinAndConfirm(() => (dex.connect(alice) as Contract).submitOrder(true, units('20000'), 0n));
      const batch = await dex.batches(0);
      await pinAndConfirm(() => (dex.connect(bob) as Contract).settleBatch(), Number(batch.endTime));
      actualSelector = await captureSelector(() => (dex.connect(bob) as Contract).claim.staticCall(0n));
    } else if (guardrailId === 'double_claim') {
      await pinAndConfirm(() => (dex.connect(alice) as Contract).submitOrder(true, units('20000'), 0n));
      const batch = await dex.batches(0);
      await pinAndConfirm(() => (dex.connect(bob) as Contract).settleBatch(), Number(batch.endTime));
      await pinAndConfirm(() => (dex.connect(alice) as Contract).claim(0n));
      actualSelector = await captureSelector(() => (dex.connect(alice) as Contract).claim.staticCall(0n));
    }

    onStage?.('reverted');
    const passed = actualSelector === expectedSelector;
    return {
      id: guardrailId,
      passed,
      errorName: def.errorName,
      expectedSelector,
      actualSelector,
      detail: passed
        ? en
          ? `Blocked via Hardhat staticCall with exact 4-byte selector ${actualSelector}`
          : `本地节点 staticCall 精确拦截并匹配 4 字节选择器 ${actualSelector}`
        : en
          ? `Selector mismatch: expected ${expectedSelector}, got ${actualSelector ?? 'null'}`
          : `选择器不匹配：期望 ${expectedSelector}，实际 ${actualSelector ?? 'null'}`,
    };
  } finally {
    // Always restore pristine snapshot after guardrail test
    await resetDemoViaApi(lang).catch(() => undefined);
    provider.destroy();
  }
}
