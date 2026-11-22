import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Play, Sparkles } from 'lucide-react';
import { getTrace } from '../data/traces';
import { useLang } from '../i18n';
import { formatGas, formatPrice, formatUnitsExact, percentOfBigInt } from '../lib/format';
import { reconcileTraces } from '../lib/reconcile';
import type { LiveConnectionInfo, LiveScenarioOptions, LiveStepEvent } from '../lib/liveClient';
import type { ScenarioTrace } from '../types/trace';
import { buildReplayStepEvents, ExecutionTheater, type StagedOrderChip } from './ExecutionTheater';
import type { ReceiptFocus } from './ReceiptDrawer';
import { ReconcileBadge } from './ReconcileBadge';

interface Act2CowLadderProps {
  mode: 'replay' | 'live';
  liveInfo: LiveConnectionInfo;
  busy: boolean;
  resetGeneration: number;
  onRunScenario: (
    scenarioId: string,
    rule: 'v2.2',
    options?: LiveScenarioOptions,
  ) => Promise<ScenarioTrace | null>;
  onTraceFocus: (focus: ReceiptFocus) => void;
}

const TIERS = [
  {
    id: 'S2_sell_0',
    labelEn: '0 ETH Sell',
    labelZh: '0 ETH 卖盘',
    subtitleEn: 'No CoW (100% AMM Net)',
    subtitleZh: '无 CoW（纯进 AMM 池）',
    badgeEn: '0% CoW',
    badgeZh: '0% 直配',
  },
  {
    id: 'S2_sell_5',
    labelEn: '5 ETH Sell',
    labelZh: '5 ETH 卖盘',
    subtitleEn: 'Partial CoW + Net Swap',
    subtitleZh: '部分 CoW + 净差额过池',
    badgeEn: '52.5% CoW',
    badgeZh: '52.5% 直配',
  },
  {
    id: 'S2_sell_10',
    labelEn: '10 ETH Sell',
    labelZh: '10 ETH 卖盘',
    subtitleEn: '100% P2P CoW Match',
    subtitleZh: '100% 纯 CoW 点对点直配',
    badgeEn: '100% CoW',
    badgeZh: '100% 直配',
  },
] as const;

const BUY_TOTAL_WEI = 20000n * 10n ** 18n;

export function Act2CowLadder({ mode, liveInfo, busy, resetGeneration, onRunScenario, onTraceFocus }: Act2CowLadderProps) {
  // Default to first tier (0 ETH Sell) so viewer climbs 0 -> 5 -> 10E cleanly
  const [selectedId, setSelectedId] = useState<(typeof TIERS)[number]['id']>('S2_sell_0');
  const [liveMap, setLiveMap] = useState<Record<string, ScenarioTrace>>({});
  const [streaming, setStreaming] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [liveEvent, setLiveEvent] = useState<LiveStepEvent | null>(null);
  const tokenRef = useRef(0);
  const { lang, t } = useLang();

  useEffect(() => {
    return () => {
      tokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    tokenRef.current += 1;
    setAnimating(false);
    setLiveEvent(null);
    setStreaming(false);
  }, [mode]);

  useEffect(() => {
    if (resetGeneration === 0) return;
    tokenRef.current += 1;
    setAnimating(false);
    setStreaming(false);
    setLiveEvent(null);
    setLiveMap({});
  }, [resetGeneration]);

  const replayTrace = getTrace(selectedId, 'v2.2');
  const liveDone = liveMap[selectedId];
  const activeTrace = mode === 'live' && liveDone ? liveDone : replayTrace;
  const report = mode === 'live' && liveDone ? reconcileTraces(liveDone, replayTrace, lang) : null;

  useEffect(() => {
    onTraceFocus({
      source: mode,
      sceneLabel: `Act 2 · ${selectedId}`,
      traces: mode === 'live' ? (liveDone ? [liveDone] : []) : [replayTrace],
    });
  }, [mode, selectedId, liveDone, replayTrace, resetGeneration, onTraceFocus]);

  const theaterStatus: 'ready' | 'running' | 'done' = (() => {
    if (streaming || (animating && liveEvent && liveEvent.phase !== 'done')) return 'running';
    if (mode === 'live') return liveDone ? 'done' : 'ready';
    return 'done';
  })();

  const resolvedEvent: LiveStepEvent | null = (() => {
    if (liveEvent && (streaming || animating || mode === 'live')) return liveEvent;
    if (mode === 'live' && liveDone) return buildReplayStepEvents(liveDone, lang).at(-1)!;
    if (mode === 'replay') return buildReplayStepEvents(replayTrace, lang).at(-1)!;
    return null;
  })();

  const stagedOrders: StagedOrderChip[] =
    selectedId === 'S2_sell_0'
      ? [{ role: 'alice', label: t('Alice Buy 20,000 USDC', 'Alice 买 20,000 USDC') }]
      : selectedId === 'S2_sell_5'
        ? [
            { role: 'alice', label: t('Alice Buy 20k USDC', 'Alice 买 20k U') },
            { role: 'bob', label: t('Bob Sell 5 ETH', 'Bob 卖 5 ETH') },
          ]
        : [
            { role: 'alice', label: t('Alice Buy 20k USDC', 'Alice 买 20k U') },
            { role: 'bob', label: t('Bob Sell 10 ETH', 'Bob 卖 10 ETH') },
          ];

  const batchSettled = Boolean(resolvedEvent?.batchesSoFar.length) || theaterStatus === 'done';
  const latestBatch = resolvedEvent?.batchesSoFar.at(-1) ?? activeTrace.batches[0];
  const progAlice = resolvedEvent?.ordersSoFar.find((o) => o.trader === 'alice');
  const progBob = resolvedEvent?.ordersSoFar.find((o) => o.trader === 'bob');

  const aliceOut =
    theaterStatus === 'ready' || !batchSettled
      ? null
      : progAlice?.receivedOut ?? activeTrace.orders.find((o) => o.trader === 'alice')?.receivedOut ?? null;
  const bobOut =
    theaterStatus === 'ready' || !batchSettled
      ? null
      : progBob?.receivedOut ?? activeTrace.orders.find((o) => o.trader === 'bob')?.receivedOut ?? null;
  const bobSubmitted = activeTrace.orders.find((o) => o.trader === 'bob')?.submittedIn ?? null;

  const settledUcp =
    theaterStatus === 'ready' || !batchSettled
      ? null
      : resolvedEvent?.poolState.ucp ?? latestBatch.clearingPrice ?? activeTrace.clearingPrice;
  const cowWei =
    theaterStatus === 'ready' || !batchSettled
      ? 0n
      : BigInt(resolvedEvent?.poolState.cowUSDC ?? latestBatch.cowUSDC ?? activeTrace.cowUSDC ?? '0');
  const poolSwapUsdcWei = BUY_TOTAL_WEI - cowWei;
  const cowPct = theaterStatus === 'ready' || !batchSettled ? 0 : percentOfBigInt(cowWei, BUY_TOTAL_WEI);

  const finalPoolEth =
    theaterStatus === 'ready'
      ? latestBatch.initialPool.eth
      : (resolvedEvent?.poolState.eth ?? latestBatch.finalPool.eth);
  const finalPoolUsdc =
    theaterStatus === 'ready'
      ? latestBatch.initialPool.usdc
      : (resolvedEvent?.poolState.usdc ?? latestBatch.finalPool.usdc);
  const reserveUnchanged =
    theaterStatus !== 'ready' &&
    batchSettled &&
    finalPoolEth === latestBatch.initialPool.eth &&
    finalPoolUsdc === latestBatch.initialPool.usdc;
  const liveSettleGas =
    resolvedEvent?.completedSteps.find((s) => s.action === 'settleBatch')?.gasUsed ?? activeTrace.settleGas;

  async function runLive() {
    const token = ++tokenRef.current;
    const targetId = selectedId;
    setLiveEvent(null);
    setStreaming(true);
    const res = await onRunScenario(targetId, 'v2.2', {
      onEvent: (evt) => {
        if (tokenRef.current === token) setLiveEvent(evt);
      },
      stepDelayMs: 360,
    });
    if (tokenRef.current !== token) return;
    setStreaming(false);
    if (res) {
      setLiveMap((prev) => ({ ...prev, [targetId]: res }));
    }
  }

  async function animateReplay() {
    const token = ++tokenRef.current;
    setAnimating(true);
    const frames = buildReplayStepEvents(replayTrace, lang);
    for (const frame of frames) {
      if (tokenRef.current !== token) return;
      setLiveEvent(frame);
      await new Promise((r) => setTimeout(r, 420));
    }
    if (tokenRef.current === token) {
      setAnimating(false);
    }
  }

  function selectTier(id: (typeof TIERS)[number]['id']) {
    tokenRef.current += 1;
    setAnimating(false);
    setStreaming(false);
    setLiveEvent(null);
    setSelectedId(id);
  }

  const currentTier = TIERS.find((item) => item.id === selectedId)!;

  return (
    <div className="space-y-4">
      {/* Header Control */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">
              {t('Act 2 · S2 Ladder', 'Act 2 · S2 阶梯')}
            </span>
            <h2 className="text-base font-bold text-slate-900">
              {t(
                'CoW Demand-Matching Ladder (0 → 5 → 10 ETH): Eliminating Slippage & Pool Fees',
                'CoW 需求直配三档阶梯：从 0 → 5 → 10 ETH 卖盘，看如何省去 AMM 冲击与池费',
              )}
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            {t('Alice buys a fixed ', 'Alice 固定投入 ')}
            <code className="rounded bg-slate-100 px-1 py-0.5">20,000 USDC</code>{' '}
            {t(
              'while Bob supplies 0 / 5 / 10 ETH in the same batch (all 3 tiers measured on Hardhat ',
              '买 ETH，改变同批内 Bob 的卖盘深度（三档均已当期 Hardhat 构建 ',
            )}
            <code className="rounded bg-slate-100 px-1">v2.2</code>
            {t(' build):', ' 实测）：')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex flex-wrap items-center rounded-lg bg-slate-100 p-1">
            {TIERS.map((tier) => (
              <button
                key={tier.id}
                type="button"
                disabled={busy || streaming}
                onClick={() => selectTier(tier.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                  selectedId === tier.id
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-700 hover:bg-white'
                }`}
              >
                {lang === 'en' ? tier.labelEn : tier.labelZh}
              </button>
            ))}
          </div>

          {mode === 'live' ? (
            <button
              type="button"
              disabled={!liveInfo.connected || busy || streaming}
              onClick={runLive}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
              <span>
                {streaming
                  ? t('Streaming Live…', '实链直播运行中…')
                  : t(`Run Live (${currentTier.labelEn})`, `实链重跑 ${currentTier.labelZh}`)}
              </span>
            </button>
          ) : (
            <button
              type="button"
              disabled={animating}
              onClick={() => void animateReplay()}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-blue-500 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>{animating ? t('Animating…', '演示中…') : t('Animate Process', '播放过程')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Main CoW Flow Panel */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Visual Flow Split (7 cols) */}
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
            <div>
              <div className="text-xs font-bold text-slate-500 uppercase">
                {t('Order Flow Routing · Batch #0', '资金路由拆解 · Batch #0')}
              </div>
              <div className="text-sm font-extrabold text-slate-900">
                {t(
                  'Alice’s 20,000 USDC Order: P2P CoW Match vs Net AMM Pool Execution',
                  'Alice 20,000 USDC 买单流向：CoW 点对点直配 vs AMM 净额进池',
                )}
              </div>
            </div>
            <ReconcileBadge
              mode={mode}
              evidenceSource={activeTrace.evidenceSource}
              report={report}
              liveState={theaterStatus}
            />
          </div>

          <ExecutionTheater
            variant="batch"
            status={theaterStatus}
            event={resolvedEvent}
            stagedOrders={stagedOrders}
            readyPrompt={t(
              `Snapshot reset at 100E / 200kU. Click Run Live (${currentTier.labelEn}) to stream submit -> settle -> claim.`,
              `快照就绪（100E / 200kU），点击「实链重跑 ${currentTier.labelZh}」实时见证提交→结算→领币全过程。`,
            )}
          />

          {/* Stacked Proportion Bar */}
          <div className="space-y-2 tabular-nums">
            <div className="flex justify-between text-xs font-semibold">
              <span className="text-emerald-700">
                {t('Intra-Batch CoW:', 'CoW 批内直配：')}{' '}
                {batchSettled && theaterStatus !== 'ready'
                  ? `${formatUnitsExact(cowWei, 2)} USDC (${cowPct.toFixed(1)}% · ${t('0.3% AMM Fee Saved', '免 0.3% AMM 池费')})`
                  : t('Pending settlement…', '待结算揭晓…')}
              </span>
              <span className="text-blue-700">
                {t('Net to AMM Pool:', '净额进 AMM 池：')}{' '}
                {batchSettled && theaterStatus !== 'ready' ? `${formatUnitsExact(poolSwapUsdcWei, 2)} USDC` : '—'}
              </span>
            </div>
            <div className="flex h-7 w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
              {theaterStatus === 'ready' || !batchSettled ? (
                <div className="flex w-full items-center justify-center text-xs font-semibold text-slate-400">
                  {theaterStatus === 'running'
                    ? t('Escrowing orders before settleBatch() computes CoW split…', '订单托管入批中，待关窗结算计算直配比例…')
                    : t('Awaiting Run Live — CoW vs AMM split will animate on settlement', '等待运行 — 结算时将动态展开 CoW 与 AMM 净额比例')}
                </div>
              ) : (
                <>
                  {cowPct > 0 && (
                    <div
                      className="flex items-center justify-center bg-emerald-500 text-xs font-extrabold text-white transition-all duration-500"
                      style={{ width: `${cowPct}%` }}
                    >
                      {cowPct >= 18 ? `CoW ${cowPct.toFixed(1)}%` : ''}
                    </div>
                  )}
                  {100 - cowPct > 0 && (
                    <div
                      className="flex items-center justify-center bg-blue-600 text-xs font-extrabold text-white transition-all duration-500"
                      style={{ width: `${(100 - cowPct).toFixed(2)}%` }}
                    >
                      {100 - cowPct >= 18 ? `${t('AMM Net', 'AMM 净差额')} ${(100 - cowPct).toFixed(1)}%` : ''}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Key KPI Row */}
          <div className="grid grid-cols-3 gap-3 tabular-nums">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] font-semibold text-slate-500">{t('Clearing Price (UCP)', '统一清算价 UCP')}</div>
              <div className="mt-1 text-lg font-extrabold text-slate-900">
                {settledUcp ? formatPrice(settledUcp, 4) : '—'}
              </div>
              <div className="text-[11px] text-slate-500">USDC / ETH</div>
            </div>

            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
              <div className="text-[11px] font-semibold text-emerald-700">{t('Alice ETH Received', 'Alice 实得 ETH')}</div>
              <div className="mt-1 text-lg font-extrabold text-emerald-700">
                {aliceOut ? formatUnitsExact(aliceOut, 6) : '—'}
              </div>
              <div className="text-[11px] text-emerald-800">
                {!aliceOut
                  ? t('Pending settlement', '等待结算')
                  : selectedId === 'S2_sell_0'
                    ? t('Zero seller baseline', '无对手卖盘基准')
                    : t(
                        `+${(Number(formatUnitsExact(aliceOut, 6).replace(/,/g, '')) - 9.066109).toFixed(6)} E vs 0E tier`,
                        `较 0 ETH 多拿 +${(Number(formatUnitsExact(aliceOut, 6).replace(/,/g, '')) - 9.066109).toFixed(6)} E`,
                      )}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] font-semibold text-slate-500">{t('Bob USDC Received', 'Bob 卖盘收款')}</div>
              <div className="mt-1 text-lg font-extrabold text-slate-900">
                {bobSubmitted ? (bobOut ? formatUnitsExact(bobOut, 2) : '—') : '0.00'}
              </div>
              <div className="text-[11px] text-slate-500">
                {bobSubmitted
                  ? t(`Selling ${formatUnitsExact(bobSubmitted, 2)} ETH`, `卖出 ${formatUnitsExact(bobSubmitted, 2)} ETH`)
                  : t('No sell order in tier', '本档未提交卖单')}
              </div>
            </div>
          </div>

          {/* Pool Reserve Conservation Highlight */}
          <div
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-xs tabular-nums ${
              reserveUnchanged
                ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
                : 'border-slate-200 bg-slate-50 text-slate-800'
            }`}
          >
            <div className="flex items-center gap-2">
              {reserveUnchanged ? (
                <Sparkles className="h-4 w-4 text-emerald-600" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-blue-600" />
              )}
              <div>
                <div className="font-bold">
                  {!batchSettled || theaterStatus === 'ready'
                    ? t('AMM Reserves Locked Before Settlement:', '清算前 AMM 储备状态：')
                    : reserveUnchanged
                      ? t(
                          'Underlying AMM Reserves 100 ETH / 200,000 USDC Completely Untouched! (reserveUnchanged = true)',
                          '底层 AMM 储备 100 ETH / 200,000 USDC 分毫未动！（reserveUnchanged = true）',
                        )
                      : t('Underlying AMM Absorbs Only Remaining Net Imbalance:', '底层 AMM 仅消化剩余净差额：')}
                </div>
                <div className="mt-0.5 text-[11px] opacity-85">
                  {t('Initial 100.0000 E / 200,000.00 U → Current ', '初始储备 100.0000 E / 200,000.00 U → 当前 ')}{' '}
                  <strong>
                    {formatUnitsExact(finalPoolEth, 6)} ETH / {formatUnitsExact(finalPoolUsdc, 2)} USDC
                  </strong>
                </div>
              </div>
            </div>
            <div className="text-right font-mono">
              <div>
                {t('Settle Gas:', '结算 Gas：')}{' '}
                {batchSettled && theaterStatus !== 'ready' ? formatGas(liveSettleGas) : '—'}
              </div>
              <div className="text-[11px] text-slate-500">
                {t('Gas So Far:', '当前累计 Gas：')}{' '}
                {theaterStatus === 'ready'
                  ? '—'
                  : formatGas((resolvedEvent?.completedSteps ?? activeTrace.steps).reduce((a, s) => a + s.gasUsed, 0))}
              </div>
            </div>
          </div>
        </div>

        {/* 3-Tier Overview Table (5 cols) */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-5">
          <h3 className="text-sm font-extrabold text-slate-900">
            {t('3-Tier Overview (Click Any Row to Switch)', '三档实测阶梯总览（点击任意行快速切换）')}
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {t(
              'As opposing sell depth increases, UCP converges to 2,000 spot and CoW ratio rises from 0% to 100%.',
              '随批内对称流动性增加，UCP 向现价 2,000 收敛，CoW 直配比例从 0% 升至 100%。',
            )}
          </p>

          <div className="mt-3 space-y-2.5 tabular-nums">
            {TIERS.map((tier) => {
              const liveTier = liveMap[tier.id];
              const tr = mode === 'live' && liveTier ? liveTier : getTrace(tier.id, 'v2.2');
              const tAlice = tr.orders.find((o) => o.trader === 'alice')!;
              const isSelected = tier.id === selectedId;
              const hideSpoilersInLive = mode === 'live' && !liveTier;
              return (
                <button
                  key={tier.id}
                  type="button"
                  disabled={busy || streaming}
                  onClick={() => selectTier(tier.id)}
                  className={`w-full rounded-xl border p-3 text-left transition disabled:opacity-60 ${
                    isSelected
                      ? 'border-emerald-500 bg-emerald-50/70 ring-1 ring-emerald-500'
                      : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-extrabold text-slate-900">
                        {lang === 'en' ? tier.labelEn : tier.labelZh}
                      </span>
                      <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-bold text-white">
                        {lang === 'en' ? tier.badgeEn : tier.badgeZh}
                      </span>
                      {mode === 'live' && (
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                            liveTier ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {liveTier ? t('Live Verified', 'Live 已实测') : t('Pending Live', '待实链运行')}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-xs font-semibold text-slate-600">
                      {hideSpoilersInLive ? 'UCP —' : `UCP ${formatPrice(tr.clearingPrice, 2)}`}
                    </span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs text-slate-600">
                    <div>
                      <span className="text-[11px] text-slate-400">{t('CoW Matched', 'CoW 直配')}</span>
                      <div className="font-bold text-emerald-700">
                        {hideSpoilersInLive ? '—' : `${formatUnitsExact(tr.cowUSDC, 2)} U`}
                      </div>
                    </div>
                    <div>
                      <span className="text-[11px] text-slate-400">{t('Alice Output', 'Alice 到账')}</span>
                      <div className="font-bold text-slate-900">
                        {hideSpoilersInLive ? '—' : `${formatUnitsExact(tAlice.receivedOut, 6)} E`}
                      </div>
                    </div>
                    <div>
                      <span className="text-[11px] text-slate-400">{t('Settle Gas', '结算 Gas')}</span>
                      <div className="font-mono font-semibold text-slate-700">
                        {hideSpoilersInLive ? '—' : formatGas(tr.settleGas)}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
