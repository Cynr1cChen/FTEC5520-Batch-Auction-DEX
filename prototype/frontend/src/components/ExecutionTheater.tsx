import { CheckCircle2, Clock, Cpu, Flame, Lock, Sparkles } from 'lucide-react';
import { useLang, type Lang } from '../i18n';
import { formatGas, formatPrice, formatUnitsExact, shortHash } from '../lib/format';
import type { LiveOrderProgress, LiveStepEvent } from '../lib/liveClient';
import type { BatchRecord, OrderRecord, ScenarioTrace, StepRecord } from '../types/trace';

export interface StagedOrderChip {
  role: string;
  label: string;
}

interface ExecutionTheaterProps {
  variant: 'batch' | 'amm';
  status: 'ready' | 'running' | 'done';
  event: LiveStepEvent | null;
  stagedOrders?: StagedOrderChip[];
  compact?: boolean;
  readyPrompt?: string;
}

function computeImpliedSpot(ethWei: string, usdcWei: string): string {
  const eth = BigInt(ethWei || '0');
  const usdc = BigInt(usdcWei || '0');
  if (eth <= 0n) return '—';
  // 1e18 scale price = (usdc * 1e18) / eth
  return formatPrice(((usdc * 10n ** 18n) / eth).toString(), 2);
}

/**
 * Derive an identical sequence of step events from a pre-recorded ScenarioTrace
 * so Replay "Animate Process" uses the exact same state machine as real-time Live runs.
 */
export function buildReplayStepEvents(trace: ScenarioTrace, lang: Lang): LiveStepEvent[] {
  const en = lang === 'en';
  const frames: LiveStepEvent[] = [];
  const initPool = {
    eth: trace.initialState.pool.eth,
    usdc: trace.initialState.pool.usdc,
    ucp: null,
    cowUSDC: null,
  };

  frames.push({
    phase: 'reset',
    batchId: trace.ruleVersion === 'traditional_amm' ? null : 0,
    poolState: initPool,
    windowProgressPct: 0,
    completedSteps: [],
    ordersSoFar: [],
    batchesSoFar: [],
    message: en
      ? 'Initialized clean pool reserves (100 ETH / 200,000 USDC)'
      : '初始化洁净双池储备（100 ETH / 200,000 USDC）',
  });

  const completedSteps: StepRecord[] = [];
  const ordersSoFar: LiveOrderProgress[] = [];
  const batchesSoFar: BatchRecord[] = [];
  const orderMap = new Map<number, OrderRecord>(trace.orders.map((o) => [o.orderId, o]));

  let swapIdx = 0;
  let submitInBatch = 0;
  let lastBatchSeen: number | null = null;

  for (const step of trace.steps) {
    completedSteps.push(step);
    if (step.batchId !== lastBatchSeen && step.action === 'submitOrder') {
      submitInBatch = 0;
      lastBatchSeen = step.batchId;
    }

    if (step.action === 'swap') {
      swapIdx += 1;
      const ord = step.orderId !== null ? orderMap.get(step.orderId) : undefined;
      if (ord) {
        ordersSoFar.push({
          id: ord.id,
          orderId: ord.orderId,
          batchId: ord.batchId,
          trader: ord.trader,
          side: ord.side,
          assetIn: ord.assetIn,
          assetOut: ord.assetOut,
          submittedIn: ord.submittedIn,
          minOut: ord.minOut,
          partialFillMinimum: ord.partialFillMinimum,
          filledIn: ord.filledIn,
          receivedOut: ord.receivedOut,
          refundedIn: ord.refundedIn,
          status: ord.status,
          claimed: true,
        });
      }
      frames.push({
        phase: 'swap',
        batchId: null,
        poolState: { ...step.poolStateAfter },
        windowProgressPct: Math.round((swapIdx / Math.max(trace.orders.length, 1)) * 100),
        latestStep: step,
        completedSteps: [...completedSteps],
        ordersSoFar: ordersSoFar.map((o) => ({ ...o })),
        batchesSoFar: [...batchesSoFar],
        message: en
          ? `${step.actor} executed instant AMM swap #${step.orderId ?? ''} (Blk #${step.blockNumber})`
          : `${step.actor} 执行即时 AMM 交易 #${step.orderId ?? ''}（区块 #${step.blockNumber}）`,
      });
    } else if (step.action === 'submitOrder') {
      submitInBatch += 1;
      const ord = step.orderId !== null ? orderMap.get(step.orderId) : undefined;
      const batchTotal = Math.max(
        trace.orders.filter((o) => o.batchId === step.batchId).length,
        1,
      );
      if (ord) {
        ordersSoFar.push({
          id: ord.id,
          orderId: ord.orderId,
          batchId: ord.batchId,
          trader: ord.trader,
          side: ord.side,
          assetIn: ord.assetIn,
          assetOut: ord.assetOut,
          submittedIn: ord.submittedIn,
          minOut: ord.minOut,
          partialFillMinimum: ord.partialFillMinimum,
          filledIn: null,
          receivedOut: null,
          refundedIn: null,
          status: 'Pending',
          claimed: false,
        });
      }
      frames.push({
        phase: 'submit',
        batchId: step.batchId,
        poolState: { ...step.poolStateAfter },
        windowProgressPct: Math.min(72, Math.round((submitInBatch / batchTotal) * 65)),
        latestStep: step,
        completedSteps: [...completedSteps],
        ordersSoFar: ordersSoFar.map((o) => ({ ...o })),
        batchesSoFar: [...batchesSoFar],
        message: en
          ? `${step.actor} escrowed order #${step.orderId ?? ''} into Batch #${step.batchId ?? 0}`
          : `${step.actor} 将订单 #${step.orderId ?? ''} 托管入 Batch #${step.batchId ?? 0}`,
      });
    } else if (step.action === 'settleBatch') {
      for (const prog of ordersSoFar) {
        if (prog.batchId === step.batchId) {
          const orig = orderMap.get(prog.orderId);
          if (orig) {
            prog.filledIn = orig.filledIn;
            prog.receivedOut = orig.receivedOut;
            prog.refundedIn = orig.refundedIn;
            prog.status = orig.status;
          }
        }
      }
      const batchRec = trace.batches.find((b) => b.batchId === step.batchId);
      if (batchRec && !batchesSoFar.some((b) => b.batchId === batchRec.batchId)) {
        batchesSoFar.push(batchRec);
      }
      frames.push({
        phase: 'settle',
        batchId: step.batchId,
        poolState: { ...step.poolStateAfter },
        windowProgressPct: 100,
        latestStep: step,
        completedSteps: [...completedSteps],
        ordersSoFar: ordersSoFar.map((o) => ({ ...o })),
        batchesSoFar: [...batchesSoFar],
        activeRounds: batchRec?.rounds,
        message: en
          ? `Window closed -> settleBatch() computed UCP & CoW (Batch #${step.batchId ?? 0})`
          : `关窗执行 settleBatch() 完成 UCP 与 CoW 清算（Batch #${step.batchId ?? 0}）`,
      });
    } else if (step.action === 'claim') {
      const prog = ordersSoFar.find((o) => o.orderId === step.orderId);
      if (prog) prog.claimed = true;
      frames.push({
        phase: 'claim',
        batchId: step.batchId,
        poolState: { ...step.poolStateAfter },
        windowProgressPct: 100,
        latestStep: step,
        completedSteps: [...completedSteps],
        ordersSoFar: ordersSoFar.map((o) => ({ ...o })),
        batchesSoFar: [...batchesSoFar],
        activeRounds: batchesSoFar.at(-1)?.rounds,
        message: en
          ? `${step.actor} claimed order #${step.orderId ?? ''}`
          : `${step.actor} 领取订单 #${step.orderId ?? ''}`,
      });
    }
  }

  frames.push({
    phase: 'done',
    batchId: trace.batches.at(-1)?.batchId ?? null,
    poolState: trace.steps.at(-1)?.poolStateAfter ?? initPool,
    windowProgressPct: 100,
    latestStep: trace.steps.at(-1),
    completedSteps: [...trace.steps],
    ordersSoFar: trace.orders.map((ord) => ({
      id: ord.id,
      orderId: ord.orderId,
      batchId: ord.batchId,
      trader: ord.trader,
      side: ord.side,
      assetIn: ord.assetIn,
      assetOut: ord.assetOut,
      submittedIn: ord.submittedIn,
      minOut: ord.minOut,
      partialFillMinimum: ord.partialFillMinimum,
      filledIn: ord.filledIn,
      receivedOut: ord.receivedOut,
      refundedIn: ord.refundedIn,
      status: ord.status,
      claimed: true,
    })),
    batchesSoFar: [...trace.batches],
    activeRounds: trace.batches.at(-1)?.rounds,
    message: en
      ? `Complete (${trace.steps.length} txs · Total Gas ${formatGas(trace.gas.total)})`
      : `流程完成（${trace.steps.length} 笔交易 · 总 Gas ${formatGas(trace.gas.total)}）`,
  });

  return frames;
}

export function ExecutionTheater({
  variant,
  status,
  event,
  stagedOrders,
  compact = false,
  readyPrompt,
}: ExecutionTheaterProps) {
  const { t } = useLang();

  const phase = event?.phase ?? (status === 'ready' ? 'idle' : 'done');
  const poolEth = event?.poolState.eth ?? '100000000000000000000';
  const poolUsdc = event?.poolState.usdc ?? '200000000000000000000000';
  const settledUcp = event?.poolState.ucp;
  const impliedPrice = settledUcp ? formatPrice(settledUcp, 2) : computeImpliedSpot(poolEth, poolUsdc);
  const windowPct = status === 'ready' ? 0 : (event?.windowProgressPct ?? 100);
  const steps = event?.completedSteps ?? [];

  const stageIndex = (() => {
    if (status === 'ready' || phase === 'idle') return 0;
    if (phase === 'reset') return 0;
    if (variant === 'amm') {
      if (phase === 'swap') {
        return Math.min(2, Math.max(1, steps.length));
      }
      return 3;
    }
    if (phase === 'submit') return 1;
    if (phase === 'settle') return 2;
    if (phase === 'claim' || phase === 'done') return 3;
    return 0;
  })();

  const stages =
    variant === 'amm'
      ? [
          { label: t('1. Pool Init', '1. 初始池 (100E/200kU)') },
          { label: t('2. Tx #1 Swap', '2. 第 1 笔即时成交') },
          { label: t('3. Tx #2 Swap', '3. 第 2 笔即时成交') },
          { label: t('4. Final State', '4. 最终滑点定格') },
        ]
      : [
          { label: t('1. Pool Init', '1. 初始快照') },
          { label: t('2. Escrow (Frozen)', '2. 托管锁价收集') },
          { label: t('3. Close & Settle', '3. 关窗 CoW+UCP') },
          { label: t('4. Claims & Verified', '4. 领币核验完成') },
        ];

  return (
    <div
      className={`rounded-xl border p-3 transition ${
        status === 'running'
          ? 'border-blue-400 bg-gradient-to-br from-blue-50/80 via-white to-slate-50 shadow-sm'
          : status === 'ready'
            ? 'border-slate-300 bg-slate-50/90'
            : 'border-slate-200 bg-slate-50/70'
      }`}
    >
      {/* Top Row: Stage Pipeline + Live Reserves Meter */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {stages.map((st, idx) => {
            const done = status === 'done' || idx < stageIndex || (status === 'running' && idx === 3 && phase === 'done');
            const active = status === 'running' && idx === stageIndex && phase !== 'done';
            return (
              <div key={st.label} className="flex items-center gap-1.5">
                <span
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold transition ${
                    active
                      ? 'animate-pulse-ring bg-blue-600 text-white'
                      : done
                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                        : 'bg-white text-slate-500 border border-slate-200'
                  }`}
                >
                  {done ? (
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                  ) : active ? (
                    <Cpu className="h-3 w-3 animate-spin" />
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-slate-300" />
                  )}
                  <span>{st.label}</span>
                </span>
                {idx < stages.length - 1 && <span className="text-slate-300 text-xs">→</span>}
              </div>
            );
          })}
        </div>

        {/* Live Pool State Meter */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-mono tabular-nums text-slate-700">
          <span>
            {t('Pool:', '池储备:')}{' '}
            <strong>
              {formatUnitsExact(poolEth, 2)} E / {formatUnitsExact(poolUsdc, 0)} U
            </strong>
          </span>
          <span className="text-slate-300">|</span>
          <span className={settledUcp ? 'font-bold text-emerald-700' : 'text-slate-600'}>
            {settledUcp ? `UCP ${impliedPrice}` : `${t('Spot', '现价')} ${impliedPrice}`}
          </span>
          {variant === 'batch' && phase === 'submit' && (
            <span className="inline-flex items-center gap-0.5 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-sans font-bold text-blue-800">
              <Lock className="h-2.5 w-2.5" /> {t('Price Frozen', '池价未动')}
            </span>
          )}
        </div>
      </div>

      {/* Batch 120s Window Progress Bar (for BatchDEX) */}
      {variant === 'batch' && (
        <div className="mt-2.5 flex items-center gap-2.5 text-[11px] tabular-nums">
          <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-slate-600">
            <Clock className="h-3 w-3 text-blue-600" />
            {event?.batchId !== null && event?.batchId !== undefined
              ? `Batch #${event.batchId} · ${t('120s Window', '120s 批收集窗')}`
              : t('120s Batch Window', '120s 批收集窗')}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                windowPct >= 100 ? 'bg-emerald-500' : 'bg-blue-600'
              }`}
              style={{ width: `${windowPct}%` }}
            />
          </div>
          <span className="w-24 shrink-0 text-right font-mono font-semibold text-slate-600">
            {status === 'ready'
              ? t('0s / Ready', '0s / 就绪')
              : windowPct >= 100
                ? t('120s / Closed', '120s / 已结算')
                : `${Math.round((windowPct / 100) * 120)}s / ${t('Collecting', '收集中')}`}
          </span>
        </div>
      )}

      {/* Ready Banner OR Live Activity Feed */}
      {status === 'ready' ? (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-600">
          <div className="flex flex-wrap items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-blue-600" />
            <span className="font-semibold text-slate-800">
              {readyPrompt ??
                t(
                  'Clean snapshot ready on Hardhat. Click Run Live to watch on-chain txs stream block by block.',
                  '本地 Hardhat 洁净快照就绪，点击「实链运行」即可逐块直播交易上链过程。',
                )}
            </span>
          </div>
          {stagedOrders && stagedOrders.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-slate-400">{t('Queued:', '待提交:')}</span>
              {stagedOrders.map((chip, i) => (
                <span
                  key={`${chip.role}-${i}`}
                  className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700"
                >
                  {chip.label}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2.5 space-y-1.5">
          {event?.message && (
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              {status === 'running' ? (
                <Flame className="h-3.5 w-3.5 text-amber-500" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              )}
              <span>{event.message}</span>
            </div>
          )}
          {!compact && steps.length > 0 && (
            <div className="flex flex-wrap gap-1.5 tabular-nums">
              {steps.map((st, idx) => (
                <span
                  key={`${st.txHash}-${idx}`}
                  className="animate-step-pop inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-mono text-slate-700 shadow-2xs"
                >
                  <span className="font-bold text-blue-700">#{st.blockNumber}</span>
                  <span>{st.actor}</span>
                  <span className="text-slate-400">·</span>
                  <span className="font-semibold text-slate-900">
                    {st.action}
                    {st.orderId !== null ? `(#${st.orderId})` : '()'}
                  </span>
                  <span className="text-slate-400">{shortHash(st.txHash)}</span>
                  <span className="text-emerald-700">{formatGas(st.gasUsed)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
