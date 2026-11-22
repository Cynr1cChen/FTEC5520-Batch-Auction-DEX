import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Play, ShieldAlert, Sparkles, TrendingUp } from 'lucide-react';
import { getHistoricalS1, getTrace } from '../data/traces';
import { useLang } from '../i18n';
import { formatGas, formatPrice, formatUnitsExact } from '../lib/format';
import { reconcileTraces } from '../lib/reconcile';
import type { LiveConnectionInfo, LiveScenarioOptions, LiveStepEvent } from '../lib/liveClient';
import type { ScenarioTrace } from '../types/trace';
import { buildReplayStepEvents, ExecutionTheater, type StagedOrderChip } from './ExecutionTheater';
import type { ReceiptFocus } from './ReceiptDrawer';
import { ReconcileBadge } from './ReconcileBadge';

interface Act1OrderingProps {
  mode: 'replay' | 'live';
  liveInfo: LiveConnectionInfo;
  busy: boolean;
  resetGeneration: number;
  onRunScenario: (
    scenarioId: string,
    rule: 'traditional_amm' | 'v2.2',
    options?: LiveScenarioOptions,
  ) => Promise<ScenarioTrace | null>;
  onTraceFocus: (focus: ReceiptFocus) => void;
}

function spotFromPool(ethWei?: string, usdcWei?: string): string {
  if (!ethWei || !usdcWei) return '—';
  const eth = BigInt(ethWei);
  const usdc = BigInt(usdcWei);
  if (eth <= 0n) return '—';
  return formatPrice(((usdc * 10n ** 18n) / eth).toString(), 2);
}

export function Act1Ordering({ mode, liveInfo, busy, resetGeneration, onTraceFocus, onRunScenario }: Act1OrderingProps) {
  const [orderChoice, setOrderChoice] = useState<'buy_first' | 'sell_first'>('buy_first');
  const [liveMap, setLiveMap] = useState<Record<string, ScenarioTrace>>({});
  const [runningSide, setRunningSide] = useState<'idle' | 'amm' | 'dex'>('idle');
  const [animating, setAnimating] = useState(false);
  const [ammEvent, setAmmEvent] = useState<LiveStepEvent | null>(null);
  const [dexEvent, setDexEvent] = useState<LiveStepEvent | null>(null);
  const runTokenRef = useRef(0);
  const { lang, t } = useLang();

  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    runTokenRef.current += 1;
    setAnimating(false);
    setAmmEvent(null);
    setDexEvent(null);
    setRunningSide('idle');
  }, [mode]);

  useEffect(() => {
    if (resetGeneration === 0) return;
    runTokenRef.current += 1;
    setAnimating(false);
    setRunningSide('idle');
    setAmmEvent(null);
    setDexEvent(null);
    setLiveMap({});
  }, [resetGeneration]);

  const scenarioId = orderChoice === 'buy_first' ? 'S1_ordinary_buy_first' : 'S1_ordinary_sell_first';
  const replayAmm = getTrace(scenarioId, 'traditional_amm');
  const replayDex = getTrace(scenarioId, 'v2.2');

  const liveAmmDone = liveMap[`${scenarioId}:amm`];
  const liveDexDone = liveMap[`${scenarioId}:dex`];

  useEffect(() => {
    onTraceFocus({
      source: mode,
      sceneLabel: `Act 1 · ${scenarioId}`,
      traces:
        mode === 'live'
          ? ([liveAmmDone, liveDexDone].filter(Boolean) as ScenarioTrace[])
          : [replayAmm, replayDex],
    });
  }, [mode, scenarioId, liveAmmDone, liveDexDone, replayAmm, replayDex, resetGeneration, onTraceFocus]);

  const ammTrace = mode === 'live' && liveAmmDone ? liveAmmDone : replayAmm;
  const dexTrace = mode === 'live' && liveDexDone ? liveDexDone : replayDex;

  const ammReport = mode === 'live' && liveAmmDone ? reconcileTraces(liveAmmDone, replayAmm, lang) : null;
  const dexReport = mode === 'live' && liveDexDone ? reconcileTraces(liveDexDone, replayDex, lang) : null;

  const historical = getHistoricalS1();

  const stagedOrders: StagedOrderChip[] =
    orderChoice === 'buy_first'
      ? [
          { role: 'alice', label: t('1. Alice Buy 20k U', '1. Alice 买 20k U') },
          { role: 'bob', label: t('2. Bob Sell 10 E', '2. Bob 卖 10 E') },
        ]
      : [
          { role: 'bob', label: t('1. Bob Sell 10 E', '1. Bob 卖 10 E') },
          { role: 'alice', label: t('2. Alice Buy 20k U', '2. Alice 买 20k U') },
        ];

  const ammStatus: 'ready' | 'running' | 'done' = (() => {
    if (runningSide === 'amm' || (animating && ammEvent && ammEvent.phase !== 'done')) return 'running';
    if (animating && ammEvent?.phase === 'done') return 'done';
    if (mode === 'live') {
      if (runningSide === 'dex' && ammEvent) return 'done';
      return liveAmmDone ? 'done' : 'ready';
    }
    return 'done';
  })();

  const dexStatus: 'ready' | 'running' | 'done' = (() => {
    if (runningSide === 'dex' || (animating && dexEvent && dexEvent.phase !== 'done')) return 'running';
    if (animating && (!dexEvent || dexEvent.phase === 'reset')) return 'ready';
    if (mode === 'live') {
      if (runningSide === 'amm') return 'ready';
      return liveDexDone ? 'done' : 'ready';
    }
    return 'done';
  })();

  const resolvedAmmEvent: LiveStepEvent | null = (() => {
    if (ammEvent && (runningSide !== 'idle' || animating || mode === 'live')) return ammEvent;
    if (mode === 'live' && liveAmmDone) return buildReplayStepEvents(liveAmmDone, lang).at(-1)!;
    if (mode === 'replay') return buildReplayStepEvents(replayAmm, lang).at(-1)!;
    return null;
  })();

  const resolvedDexEvent: LiveStepEvent | null = (() => {
    if (dexEvent && (runningSide !== 'idle' || animating || mode === 'live')) return dexEvent;
    if (mode === 'live' && liveDexDone) return buildReplayStepEvents(liveDexDone, lang).at(-1)!;
    if (mode === 'replay') return buildReplayStepEvents(replayDex, lang).at(-1)!;
    return null;
  })();

  async function runBothLive() {
    const token = ++runTokenRef.current;
    const targetSid = scenarioId;
    setAmmEvent(null);
    setDexEvent(null);
    setRunningSide('amm');
    const a = await onRunScenario(targetSid, 'traditional_amm', {
      onEvent: (evt) => {
        if (runTokenRef.current === token) setAmmEvent(evt);
      },
      stepDelayMs: 360,
    });
    if (runTokenRef.current !== token) return;
    if (!a) {
      setRunningSide('idle');
      return;
    }
    setLiveMap((prev) => ({ ...prev, [`${targetSid}:amm`]: a }));

    setRunningSide('dex');
    const b = await onRunScenario(targetSid, 'v2.2', {
      onEvent: (evt) => {
        if (runTokenRef.current === token) setDexEvent(evt);
      },
      stepDelayMs: 340,
    });
    if (runTokenRef.current !== token) return;
    setRunningSide('idle');
    if (b) {
      setLiveMap((prev) => ({
        ...prev,
        [`${targetSid}:amm`]: a,
        [`${targetSid}:dex`]: b,
      }));
    }
  }

  async function animateReplayProcess() {
    const token = ++runTokenRef.current;
    setAnimating(true);
    const ammFrames = buildReplayStepEvents(replayAmm, lang);
    const dexFrames = buildReplayStepEvents(replayDex, lang);
    setAmmEvent(ammFrames[0]);
    setDexEvent(dexFrames[0]);

    for (const frame of ammFrames) {
      if (runTokenRef.current !== token) return;
      setAmmEvent(frame);
      await new Promise((r) => setTimeout(r, 420));
    }
    for (const frame of dexFrames) {
      if (runTokenRef.current !== token) return;
      setDexEvent(frame);
      await new Promise((r) => setTimeout(r, 380));
    }
    if (runTokenRef.current === token) {
      setAnimating(false);
    }
  }

  function switchChoice(next: 'buy_first' | 'sell_first') {
    runTokenRef.current += 1;
    setAnimating(false);
    setRunningSide('idle');
    setAmmEvent(null);
    setDexEvent(null);
    setOrderChoice(next);
  }

  const ammSteps = ammStatus === 'ready' ? [] : (resolvedAmmEvent?.completedSteps ?? ammTrace.steps);
  const ammProgAlice =
    ammStatus === 'ready' ? undefined : resolvedAmmEvent?.ordersSoFar.find((o) => o.trader === 'alice');
  const ammProgBob =
    ammStatus === 'ready' ? undefined : resolvedAmmEvent?.ordersSoFar.find((o) => o.trader === 'bob');

  const dexProgAlice =
    dexStatus === 'ready' ? undefined : resolvedDexEvent?.ordersSoFar.find((o) => o.trader === 'alice');
  const dexProgBob =
    dexStatus === 'ready' ? undefined : resolvedDexEvent?.ordersSoFar.find((o) => o.trader === 'bob');
  const dexBatchSettled =
    dexStatus !== 'ready' && (Boolean(resolvedDexEvent?.batchesSoFar.length) || dexStatus === 'done');

  const ammAliceOut =
    ammStatus === 'ready'
      ? null
      : ammProgAlice?.receivedOut ?? (ammStatus === 'done' ? ammTrace.orders.find((o) => o.trader === 'alice')?.receivedOut ?? null : null);
  const ammBobOut =
    ammStatus === 'ready'
      ? null
      : ammProgBob?.receivedOut ?? (ammStatus === 'done' ? ammTrace.orders.find((o) => o.trader === 'bob')?.receivedOut ?? null : null);

  const dexAliceOut =
    dexStatus === 'ready' || !dexBatchSettled
      ? null
      : dexProgAlice?.receivedOut ?? (dexStatus === 'done' ? dexTrace.orders.find((o) => o.trader === 'alice')?.receivedOut ?? null : null);
  const dexBobOut =
    dexStatus === 'ready' || !dexBatchSettled
      ? null
      : dexProgBob?.receivedOut ?? (dexStatus === 'done' ? dexTrace.orders.find((o) => o.trader === 'bob')?.receivedOut ?? null : null);

  const dexSettledUcp =
    dexStatus === 'ready' || !dexBatchSettled
      ? null
      : resolvedDexEvent?.poolState.ucp ??
        resolvedDexEvent?.batchesSoFar.at(-1)?.clearingPrice ??
        (dexStatus === 'done' ? dexTrace.clearingPrice : null);
  const dexSettledCow =
    dexStatus === 'ready' || !dexBatchSettled
      ? null
      : resolvedDexEvent?.poolState.cowUSDC ??
        resolvedDexEvent?.batchesSoFar.at(-1)?.cowUSDC ??
        (dexStatus === 'done' ? dexTrace.cowUSDC : null);

  const fairEthNum = Number(historical.fairEth);
  const sandEthNum = Number(historical.sandwichedEth);
  const batchEthNum = Number(historical.batchAliceEth);

  return (
    <div className="space-y-4">
      {/* Control Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">
              {t('Act 1 · Interactive', 'Act 1 · 交互场景')}
            </span>
            <h2 className="text-base font-bold text-slate-900">
              {t(
                'Order Permutation Test: Why Does Execution Order Change Payouts on Continuous AMMs?',
                '普通买卖两单换序对照：同一笔交易，为什么先到先成交会剧烈改变结果？',
              )}
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            {t('Fixed initial reserves', '固定初始储备')}{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5">100 ETH / 200,000 USDC</code>{' '}
            {t(
              '& same 2 ordinary orders (Alice Buy 20,000 USDC · Bob Sell 10 ETH). Pick either submission order:',
              '与同两笔订单（Alice 买 20,000 USDC · Bob 卖 10 ETH），请台下观众任意指定提交顺序：',
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              disabled={busy || runningSide !== 'idle'}
              onClick={() => switchChoice('buy_first')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                orderChoice === 'buy_first'
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
              <span>{t('Order 1: Buy First (Alice → Bob)', '顺序 1：买单先到 (Alice → Bob)')}</span>
            </button>
            <button
              type="button"
              disabled={busy || runningSide !== 'idle'}
              onClick={() => switchChoice('sell_first')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                orderChoice === 'sell_first'
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
              <span>{t('Order 2: Sell First (Bob → Alice)', '顺序 2：卖单先到 (Bob → Alice)')}</span>
            </button>
          </div>

          {mode === 'live' ? (
            <button
              type="button"
              disabled={!liveInfo.connected || busy || runningSide !== 'idle'}
              onClick={runBothLive}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
              <span>
                {runningSide !== 'idle'
                  ? t('Streaming Live Txs…', '正在实链直播运行…')
                  : t('Run Both Pools Live', '实链重跑当前双池对照')}
              </span>
            </button>
          ) : (
            <button
              type="button"
              disabled={animating}
              onClick={() => void animateReplayProcess()}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-blue-500 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>{animating ? t('Animating Steps…', '逐步演示中…') : t('Animate Process', '播放过程')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Dual Venue Side-by-Side Comparison */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left: TraditionalAMM */}
        <div className="rounded-xl border border-rose-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-100 bg-rose-50/70 px-4 py-3">
            <div>
              <div className="text-xs font-bold tracking-wide text-rose-700 uppercase">
                {t('Control · TraditionalAMM', '对照组 · TraditionalAMM')}
              </div>
              <div className="text-sm font-extrabold text-slate-900">
                {t('Continuous Pool Swap (x · y = k, First-Come-First-Priced)', '按到达序即时过池（x · y = k，先到先定价）')}
              </div>
            </div>
            <ReconcileBadge
              mode={mode}
              evidenceSource={ammTrace.evidenceSource}
              report={ammReport}
              liveState={ammStatus}
            />
          </div>

          <div className="space-y-3 p-4">
            <ExecutionTheater
              variant="amm"
              status={ammStatus}
              event={resolvedAmmEvent}
              stagedOrders={stagedOrders}
              readyPrompt={t(
                'Pool at 100 ETH / 200,000 USDC (Spot 2,000). Click Run Both Pools Live to execute Tx #1 → Tx #2.',
                '池处于 100 ETH / 200,000 USDC（现价 2,000），点击「实链重跑」观察两笔串行成交价格跳变。',
              )}
            />

            {/* Live Spot Price Trajectory Strip */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-100 bg-rose-50/50 px-3 py-2 text-xs tabular-nums text-rose-950">
              <span className="font-semibold text-rose-800">{t('AMM Pool Spot Jump:', 'AMM 池实时定价轨迹：')}</span>
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                <span className="rounded bg-white px-1.5 py-0.5 border border-rose-200">
                  {t('Init', '初始')} 2,000
                </span>
                <span className="text-rose-400">→</span>
                <span
                  className={`rounded px-1.5 py-0.5 border ${
                    ammStatus !== 'ready' && ammSteps.length >= 1
                      ? 'animate-step-pop border-rose-400 bg-rose-100 font-bold text-rose-900'
                      : 'border-slate-200 bg-white text-slate-400'
                  }`}
                >
                  {t('Tx #1:', 'Tx #1:')}{' '}
                  {ammStatus !== 'ready' && ammSteps.length >= 1
                    ? spotFromPool(ammSteps[0].poolStateAfter.eth, ammSteps[0].poolStateAfter.usdc)
                    : '—'}
                </span>
                <span className="text-rose-400">→</span>
                <span
                  className={`rounded px-1.5 py-0.5 border ${
                    ammStatus !== 'ready' && ammSteps.length >= 2
                      ? 'animate-step-pop border-rose-400 bg-rose-100 font-bold text-rose-900'
                      : 'border-slate-200 bg-white text-slate-400'
                  }`}
                >
                  {t('Tx #2:', 'Tx #2:')}{' '}
                  {ammStatus !== 'ready' && ammSteps.length >= 2
                    ? spotFromPool(ammSteps[1].poolStateAfter.eth, ammSteps[1].poolStateAfter.usdc)
                    : '—'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 tabular-nums">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs font-semibold text-slate-500">
                  {t('Alice Receives (for 20,000 USDC)', 'Alice 投入 20,000 USDC 到账')}
                </div>
                <div className="mt-1 text-2xl font-extrabold text-rose-700">
                  {ammAliceOut ? formatUnitsExact(ammAliceOut, 6) : '—'}{' '}
                  <span className="text-sm font-bold">ETH</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {ammAliceOut
                    ? t('Order Swing: 9.0661 ↔ 10.8688 ETH (Δ 1.8027 ETH)', '换序振幅：9.0661 ↔ 10.8688 ETH（差 1.8027 ETH）')
                    : t('Awaiting sequential swap…', '等待顺序过池成交…')}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs font-semibold text-slate-500">
                  {t('Bob Receives (for 10 ETH)', 'Bob 卖出 10 ETH 到账')}
                </div>
                <div className="mt-1 text-2xl font-extrabold text-slate-900">
                  {ammBobOut ? formatUnitsExact(ammBobOut, 2) : '—'}{' '}
                  <span className="text-sm font-bold">USDC</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {ammBobOut
                    ? t('Order Swing: 21,737.52 ↔ 18,132.22 USDC', '换序振幅：21,737.52 ↔ 18,132.22 USDC')
                    : t('Awaiting sequential swap…', '等待顺序过池成交…')}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700 tabular-nums">
              <span>
                {t('Executed Swaps:', '执行步骤：')}{' '}
                <strong className="font-mono">{ammStatus === 'ready' ? 0 : ammSteps.length} / 2</strong>
              </span>
              <span>
                {t('Combined Gas:', '两笔合计 Gas：')}{' '}
                <strong className="font-mono">
                  {ammStatus === 'ready'
                    ? '—'
                    : formatGas(ammSteps.reduce((acc, s) => acc + s.gasUsed, 0))}
                </strong>
              </span>
            </div>
          </div>
        </div>

        {/* Right: BatchAuctionDEX v2.2 */}
        <div className="rounded-xl border border-emerald-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-100 bg-emerald-50/70 px-4 py-3">
            <div>
              <div className="text-xs font-bold tracking-wide text-emerald-700 uppercase">
                {t('BatchDEX · BatchAuctionDEX v2.2', '实验组 · BatchAuctionDEX v2.2')}
              </div>
              <div className="text-sm font-extrabold text-slate-900">
                {t('Same-Batch Escrow + CoW P2P Match + Uniform Clearing Price', '同批托管收集 + CoW 点对点直配 + 统一清算价')}
              </div>
            </div>
            <ReconcileBadge
              mode={mode}
              evidenceSource={dexTrace.evidenceSource}
              report={dexReport}
              liveState={dexStatus}
            />
          </div>

          <div className="space-y-3 p-4">
            <ExecutionTheater
              variant="batch"
              status={dexStatus}
              event={resolvedDexEvent}
              stagedOrders={stagedOrders}
              readyPrompt={t(
                'Orders queue in escrow without moving pool price until settleBatch() closes the 120s window.',
                '订单先入批托管且池价锁定不动，待关窗 settleBatch() 一次性统一清算。',
              )}
            />

            <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
              {dexSettledUcp ? (
                <>
                  {t('Batch #0 Settled:', 'Batch #0 已统一清算：')}{' '}
                  <strong className="font-bold">
                    {t(
                      `Permutation-invariant UCP = ${formatPrice(dexSettledUcp)} USDC/ETH (CoW ${formatUnitsExact(dexSettledCow, 2)} U)`,
                      `无论谁先提交，批内 UCP 严格 = ${formatPrice(dexSettledUcp)} USDC/ETH（CoW 直配 ${formatUnitsExact(dexSettledCow, 2)} U）`,
                    )}
                  </strong>
                </>
              ) : (
                <span className="text-emerald-800">
                  {dexStatus === 'running'
                    ? t('Escrowing batch orders — AMM reserves & clearing price remain untouched until settleBatch()…', '正在托管订单入批 —— 底层 AMM 储备在关窗清算前分毫不差…')
                    : t('Queue ready: both orders will enter Batch #0 and clear at a single UCP regardless of order.', '就绪：两笔订单无论按何顺序提交，都将汇入 Batch #0 并按同一 UCP 清算。')}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 tabular-nums">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/30 p-3">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                  <span>{t('Alice Receives (for 20k USDC)', 'Alice 投入 20,000 USDC 到账')}</span>
                  {dexProgAlice && (
                    <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 border border-emerald-200">
                      {dexProgAlice.status === 'Pending'
                        ? t('Escrowed', '托管中')
                        : dexProgAlice.claimed
                          ? t('Claimed', '已领币')
                          : t('Settled', '已结算')}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-2xl font-extrabold text-emerald-700">
                  {dexAliceOut ? formatUnitsExact(dexAliceOut, 6) : '—'}{' '}
                  <span className="text-sm font-bold">ETH</span>
                </div>
                <div className="mt-1 text-[11px] font-medium text-emerald-700">
                  {dexAliceOut
                    ? `${t('Order-Invariant · CoW', '两序全等 · 批内直配')} ${formatUnitsExact(dexSettledCow, 2)} USDC`
                    : dexProgAlice
                      ? t(`Order #${dexProgAlice.orderId} escrowed in Pending queue`, `订单 #${dexProgAlice.orderId} 已进入 Pending 托管队列`)
                      : t('Awaiting batch execution…', '等待批处理执行…')}
                </div>
              </div>

              <div className="rounded-lg border border-emerald-200 bg-emerald-50/30 p-3">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                  <span>{t('Bob Receives (for 10 ETH)', 'Bob 卖出 10 ETH 到账')}</span>
                  {dexProgBob && (
                    <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 border border-emerald-200">
                      {dexProgBob.status === 'Pending'
                        ? t('Escrowed', '托管中')
                        : dexProgBob.claimed
                          ? t('Claimed', '已领币')
                          : t('Settled', '已结算')}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-2xl font-extrabold text-emerald-700">
                  {dexBobOut ? formatUnitsExact(dexBobOut, 2) : '—'}{' '}
                  <span className="text-sm font-bold">USDC</span>
                </div>
                <div className="mt-1 text-[11px] font-medium text-emerald-700">
                  {dexBobOut
                    ? t('Underlying AMM reserves (100E / 200k U) untouched', 'AMM 底层储备 100 E / 200,000 U 分毫未动')
                    : dexProgBob
                      ? t(`Order #${dexProgBob.orderId} escrowed in Pending queue`, `订单 #${dexProgBob.orderId} 已进入 Pending 托管队列`)
                      : t('Awaiting batch execution…', '等待批处理执行…')}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700 tabular-nums">
              <span>
                {t('Gas So Far:', '当前累计 Gas：')}{' '}
                <strong className="font-mono">
                  {dexStatus === 'ready'
                    ? '—'
                    : formatGas((resolvedDexEvent?.completedSteps ?? dexTrace.steps).reduce((a, s) => a + s.gasUsed, 0))}
                </strong>
                {dexStatus === 'done' && ` (${t('Settle', '结算')} ${formatGas(dexTrace.settleGas)})`}
              </span>
              <span>
                {t('Contract Dust:', '余尘：')}{' '}
                {dexStatus === 'done' ? `${dexTrace.dustWei.mETH} / ${dexTrace.dustWei.mUSDC} wei` : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Historical S1 Sandwich Motivation Card (Strictly Scoped & Separated Accounting Basis) */}
      <div className="rounded-xl border border-amber-300 bg-gradient-to-br from-amber-50/80 via-white to-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-amber-200/80 pb-2.5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4.5 w-4.5 text-amber-600" />
            <div>
              <h3 className="text-sm font-extrabold text-slate-900">
                {t(
                  'Research Motivation · Historical S1 Ordering-Risk Benchmark',
                  '研究动机：S1 历史排序风险对照',
                )}
              </h3>
              <p className="text-[11px] text-amber-900">
                {t('Source: Historical Py-EVM summary (', '证据来源：Py-EVM 历史汇总（')}
                <code className="rounded bg-amber-100 px-1">verification_results.json</code>
                {t(
                  '), verifying sequential execution and equivalence across all 3 admitted batch permutations; ',
                  '），已验证顺序执行及固定集合下 3 种入批排列等价，',
                )}
                <strong>{t('no same-block receipts', '未提供同区块回执')}</strong>
                {t(
                  ' — strictly separated from the live Hardhat interactive traces above.',
                  '，与上方当期 Hardhat 交互回放严格区分。',
                )}
              </p>
            </div>
          </div>
          <span className="rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-900">
            {t('Historical Py-EVM Static Context', '历史 Py-EVM 静态动机证据')}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Bar Chart for Alice Output */}
          <div className="space-y-2 lg:col-span-7">
            <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
              <TrendingUp className="h-3.5 w-3.5 text-blue-600" />
              <span>
                {t(
                  'Alice ETH Output for 20,000 USDC (Higher = Fairer Execution)',
                  'Alice 花费 20,000 USDC 实得 ETH 对比（越高越公平）',
                )}
              </span>
            </div>

            <div className="space-y-2 text-xs tabular-nums">
              <div>
                <div className="mb-0.5 flex justify-between">
                  <span className="font-medium text-slate-600">
                    {t('Fair Baseline (TraditionalAMM, Unattacked)', '无夹击基准 (TraditionalAMM 单买)')}
                  </span>
                  <span className="font-bold text-slate-800">{historical.fairEth} ETH</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-slate-500" style={{ width: '100%' }} />
                </div>
              </div>

              <div>
                <div className="mb-0.5 flex justify-between">
                  <span className="font-medium text-rose-700">
                    {t('TraditionalAMM Sandwiched (Fixed 3-Tx Sequence)', 'TraditionalAMM 遭夹击 (按固定 3 步序)')}
                  </span>
                  <span className="font-bold text-rose-700">
                    {historical.sandwichedEth} ETH ({t(`-${historical.lossPct} Loss`, `损失 ${historical.lossPct}`)})
                  </span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-rose-100">
                  <div
                    className="h-full rounded-full bg-rose-600"
                    style={{ width: `${((sandEthNum / fairEthNum) * 100).toFixed(2)}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="mb-0.5 flex justify-between">
                  <span className="font-medium text-emerald-700">
                    {t('BatchAuctionDEX Same-Batch (All 3 Permutations Identical)', 'BatchAuctionDEX 同批清算 (3 排列全等)')}
                  </span>
                  <span className="font-bold text-emerald-700">
                    {historical.batchAliceEth} ETH (UCP = {historical.batchUcp})
                  </span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-emerald-100">
                  <div
                    className="h-full rounded-full bg-emerald-600"
                    style={{ width: `${((batchEthNum / fairEthNum) * 100).toFixed(2)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Strictly Separated Accounting Basis Box */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:col-span-5 tabular-nums">
            <div className="rounded-lg border border-rose-200 bg-rose-50/70 p-3">
              <div className="text-[11px] font-bold text-rose-800 uppercase">
                {t('AMM Basis: Realized Cash Profit', 'AMM 口径：已实现现金收益')}
              </div>
              <div className="mt-1 text-xl font-extrabold text-rose-700">
                +{Number(historical.botCashProfitUsdc).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC
              </div>
              <div className="mt-1 text-[11px] text-rose-900">
                {t(
                  'Bot buys then sells back to 0 net ETH delta — pure realized USDC profit (excl. Gas).',
                  'Bot 先买后卖后 ETH 净变动 = 0，纯落袋现金流利润（未扣原生 Gas）。',
                )}
              </div>
            </div>

            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3">
              <div className="text-[11px] font-bold text-emerald-800 uppercase">
                {t('Batch Basis: Mark-to-UCP Position', '批处理口径：按 UCP 估值持仓')}
              </div>
              <div className="mt-1 text-xl font-extrabold text-emerald-700">≈ 0.00 USDC</div>
              <div className="mt-1 text-[11px] text-emerald-900">
                {t('Account balance changes by ', '实际账户变化为 ')}
                <strong>{historical.botDeltaUsdc} USDC</strong> {t('and', '与')}{' '}
                <strong>+{historical.botDeltaEth} ETH</strong>
                {t(
                  ` (cross-batch inventory exposure), valued at ≈ 0 under UCP ${historical.batchUcp} (excl. Gas).`,
                  `（留有跨批敞口），按 UCP ${historical.batchUcp} 折算约 0（未计 Gas）。`,
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
