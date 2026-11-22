import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Clock, Info, Play, ShieldAlert, Sparkles } from 'lucide-react';
import { getTrace } from '../data/traces';
import { useLang } from '../i18n';
import { formatGas, formatPrice, formatUnitsExact, getRoleMeta } from '../lib/format';
import { reconcileTraces } from '../lib/reconcile';
import type { LiveConnectionInfo, LiveScenarioOptions, LiveStepEvent } from '../lib/liveClient';
import type { ScenarioTrace } from '../types/trace';
import { buildReplayStepEvents, ExecutionTheater, type StagedOrderChip } from './ExecutionTheater';
import type { ReceiptFocus } from './ReceiptDrawer';
import { ReconcileBadge } from './ReconcileBadge';

interface Act4CrossBatchProps {
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

export function Act4CrossBatch({ mode, liveInfo, busy, resetGeneration, onRunScenario, onTraceFocus }: Act4CrossBatchProps) {
  // Default to Branch 1 first so viewer sees uncontested -> contested contrast cleanly
  const [branch, setBranch] = useState<'S3_inventory_alone' | 'S3_inventory_with_additional_seller'>(
    'S3_inventory_alone',
  );
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

  const replayTrace = getTrace(branch, 'v2.2');
  const liveDone = liveMap[branch];
  const activeTrace = mode === 'live' && liveDone ? liveDone : replayTrace;
  const report = mode === 'live' && liveDone ? reconcileTraces(liveDone, replayTrace, lang) : null;

  useEffect(() => {
    onTraceFocus({
      source: mode,
      sceneLabel: `Act 4 · ${branch}`,
      traces: mode === 'live' ? (liveDone ? [liveDone] : []) : [replayTrace],
    });
  }, [mode, branch, liveDone, replayTrace, resetGeneration, onTraceFocus]);

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
    branch === 'S3_inventory_alone'
      ? [
          { role: 'bot', label: 'B0: Bot Buy 30k' },
          { role: 'alice', label: 'B0: Alice Buy 20k' },
          { role: 'bot', label: t('B1: Bot Sell 11.97E', 'B1: Bot 卖 11.97E') },
        ]
      : [
          { role: 'bot', label: 'B0: Bot Buy 30k' },
          { role: 'alice', label: 'B0: Alice Buy 20k' },
          { role: 'bot', label: t('B1: Bot Sell 11.97E', 'B1: Bot 卖 11.97E') },
          { role: 'arb', label: t('B1: Arb Sell 15E', 'B1: Arb 卖 15E') },
        ];

  const completedSteps = theaterStatus === 'ready' ? [] : (resolvedEvent?.completedSteps ?? activeTrace.steps);
  const settledBatches = theaterStatus === 'ready' ? [] : (resolvedEvent?.batchesSoFar ?? activeTrace.batches);
  const finalReady = theaterStatus === 'done';

  const cashDeltaWei = BigInt(activeTrace.outcome?.cashDeltaMUSDCBeforeNativeGas ?? '0');
  const isProfit = cashDeltaWei > 0n;

  function switchBranch(next: 'S3_inventory_alone' | 'S3_inventory_with_additional_seller') {
    tokenRef.current += 1;
    setAnimating(false);
    setStreaming(false);
    setLiveEvent(null);
    setBranch(next);
  }

  async function triggerLive() {
    const token = ++tokenRef.current;
    const targetBranch = branch;
    setLiveEvent(null);
    setStreaming(true);
    const res = await onRunScenario(targetBranch, 'v2.2', {
      onEvent: (evt) => {
        if (tokenRef.current === token) setLiveEvent(evt);
      },
      stepDelayMs: 320,
    });
    if (tokenRef.current !== token) return;
    setStreaming(false);
    if (res) {
      setLiveMap((prev) => ({ ...prev, [targetBranch]: res }));
    }
  }

  async function animateReplay2Batch() {
    const token = ++tokenRef.current;
    setAnimating(true);
    const frames = buildReplayStepEvents(replayTrace, lang);
    for (const frame of frames) {
      if (tokenRef.current !== token) return;
      setLiveEvent(frame);
      await new Promise((r) => setTimeout(r, 400));
    }
    if (tokenRef.current === token) {
      setAnimating(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">
              {t('Act 4 · S3 Cross-Batch Boundary', 'Act 4 · S3 跨批次边界')}
            </span>
            <h2 className="text-base font-bold text-slate-900">
              {t(
                'Cross-Batch Inventory Risk in Plaintext Batches (Batch 0 Entry → Batch 1 Uncontested vs Contested Exit)',
                '明文批处理的跨批次库存风险（Batch 0 建仓 → Batch 1 无竞争 vs 有竞争卖家）',
              )}
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            {t(
              'In Batch 0, Bot spends 30k USDC and Alice spends 20k USDC at UCP 2,506.02; in Batch 1, Bot liquidates all 11.971183 ETH (both branches measured on Hardhat ',
              'Batch 0 中 Bot 花 30,000 USDC、Alice 花 20,000 USDC 共同以 UCP 2,506.02 成交；Batch 1 中 Bot 抛售全部所得 11.971183 ETH（两分支均已在当期 Hardhat 构建 ',
            )}
            <code className="rounded bg-slate-100 px-1">v2.2</code>
            {t(' build).', ' 实测）。')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              disabled={busy || streaming}
              onClick={() => switchBranch('S3_inventory_alone')}
              className={`rounded-md px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                branch === 'S3_inventory_alone'
                  ? 'bg-amber-600 text-white shadow-sm'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              {t('Branch 1: B2 Alone (+2,438.69 U)', '分支 1：B2 无额外卖方 (+2,438.69 U)')}
            </button>
            <button
              type="button"
              disabled={busy || streaming}
              onClick={() => switchBranch('S3_inventory_with_additional_seller')}
              className={`rounded-md px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                branch === 'S3_inventory_with_additional_seller'
                  ? 'bg-rose-700 text-white shadow-sm'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              {t('Branch 2: B2 Arb Sells 15E (−2,097.77 U)', '分支 2：B2 Arb 卖 15E (-2,097.77 U)')}
            </button>
          </div>

          {mode === 'live' ? (
            <button
              type="button"
              disabled={!liveInfo.connected || busy || streaming}
              onClick={triggerLive}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{streaming ? t('Streaming 2 Batches…', '实链双批执行中…') : t('Run 2-Batch Live', '实链重跑双批')}</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={animating}
              onClick={() => void animateReplay2Batch()}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>{animating ? t('Animating Steps…', '跨批逐步演示中…') : t('Animate 2-Batch Flow', '演示双批过程')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Live Execution Theater Strip (Compact) */}
      <ExecutionTheater
        variant="batch"
        compact
        status={theaterStatus}
        event={resolvedEvent}
        stagedOrders={stagedOrders}
        readyPrompt={t(
          'Initial reserves 100E / 200kU. Click Run 2-Batch Live to stream Batch 0 -> Bot Claim -> Batch 1 -> Alice Delayed Claim.',
          '初始储备 100E / 200kU，点击「实链重跑双批」逐笔观看 Batch 0 建仓 → Batch 1 出清 → Alice 跨批延迟领币。',
        )}
      />

      {/* Outcome Banner + Two-Batch Evolution */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left: Batch 0 -> Batch 1 Cards & Bot P&L (7 cols) */}
        <div className="space-y-3 lg:col-span-7">
          <div
            className={`rounded-xl border p-4 shadow-sm tabular-nums transition ${
              !finalReady
                ? 'border-slate-300 bg-white'
                : isProfit
                  ? 'border-amber-300 bg-amber-50/70'
                  : 'border-rose-300 bg-rose-50/70'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-slate-600">
                  {t(
                    'Bot Cross-Batch Cash Delta (ETH Inventory Flattened to 0, Excl. Gas)',
                    'Bot 跨批最终现金变化（ETH 库存已全部清零，未扣原生 Gas）',
                  )}
                </div>
                <div
                  className={`mt-1 text-2xl font-extrabold ${
                    !finalReady
                      ? 'text-slate-400'
                      : isProfit
                        ? 'text-amber-800'
                        : 'text-rose-700'
                  }`}
                >
                  {finalReady ? `${formatUnitsExact(cashDeltaWei, 6, { signed: true })} USDC` : t('— USDC (Pending Exit)', '— USDC（待 Batch 1 清零出清）')}
                </div>
              </div>
              <ReconcileBadge
                mode={mode}
                evidenceSource={activeTrace.evidenceSource}
                report={report}
                liveState={theaterStatus}
              />
            </div>
            <p className="mt-1.5 text-xs text-slate-700">
              {!finalReady
                ? theaterStatus === 'running'
                  ? t('Executing Batch 0 / Batch 1 transactions on-chain — cash delta settles once Batch 1 liquidates Bot’s ETH…', '正在执行双批实链交易，待 Batch 1 卖出全部 ETH 后揭晓净现金变化…')
                  : t('Click Run 2-Batch Live above to measure Bot’s net USDC outcome across two consecutive 120s batches.', '点击上方「实链重跑双批」，现场实测连续两个 120 秒批次后的净现金变化。')
                : isProfit
                  ? t(
                      'With no competing seller in Batch 1, Alice’s Batch-0 demand lifted the starting price and yielded positive cash; however, Bot must bear a full 120s window of unhedged inventory risk.',
                      '当 Batch 1 没有其他卖家介入时，Alice 的同批需求抬高了初始池价，使 Bot 在下一批抛售获得正现金差；但 Bot 必须承担整整 120 秒批次窗口的价格不确定性。',
                    )
                  : t(
                      'When competing seller Arb supplies 15 ETH in Batch 1, UCP drops from 2,506.02 to 2,330.78 — cross-batch atomicity breaks and Bot loses 2,097.77 USDC!',
                      '当 Batch 1 出现正常竞争卖家 Arb 卖出 15 ETH 时，清算价从 2,506.02 跌至 2,330.78，Bot 跨批原子性失效，反亏 2,097.77 USDC！',
                    )}
            </p>
          </div>

          {/* Batch 0 -> Batch 1 Cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 tabular-nums">
            {[0, 1].map((bid) => {
              const b = settledBatches.find((item) => item.batchId === bid);
              return (
                <div
                  key={bid}
                  className={`rounded-xl border p-3.5 shadow-sm transition ${
                    b ? 'animate-step-pop border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-50/70'
                  }`}
                >
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="rounded bg-slate-900 px-2 py-0.5 text-xs font-bold text-white">
                      Batch #{bid}
                    </span>
                    <span className="font-mono text-xs font-bold text-slate-700">
                      {b ? `UCP ${formatPrice(b.clearingPrice, 4)}` : t('Awaiting settleBatch()', '待清算')}
                    </span>
                  </div>
                  {b ? (
                    <div className="mt-2.5 space-y-1.5 text-xs text-slate-600">
                      <div className="flex justify-between">
                        <span>{t('Initial Pool:', '初池储备：')}</span>
                        <span className="font-mono font-semibold text-slate-800">
                          {formatUnitsExact(b.initialPool.eth, 4)} E / {formatUnitsExact(b.initialPool.usdc, 2)} U
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>{t('Final Pool:', '末池储备：')}</span>
                        <span className="font-mono font-semibold text-slate-800">
                          {formatUnitsExact(b.finalPool.eth, 4)} E / {formatUnitsExact(b.finalPool.usdc, 2)} U
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>{t('CoW / Refunds:', 'CoW 直配 / 退款数：')}</span>
                        <span className="font-semibold text-slate-800">
                          {formatUnitsExact(b.cowUSDC, 2)} U /{' '}
                          {t(`${b.refundedCount} orders`, `${b.refundedCount} 单`)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>{t('Unclaimed Dust:', '结算后未领余额尾差：')}</span>
                        <span className="font-mono text-emerald-700">
                          {b.dustWei.mETH} / {b.dustWei.mUSDC} wei
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="py-5 text-center text-xs text-slate-400">
                      {bid === 0
                        ? t('Populates on Batch #0 settleBatch()', 'Batch #0 结算后实时写入')
                        : t('Populates on Batch #1 settleBatch()', 'Batch #1 结算后实时写入')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Honest Extension Boundaries Box */}
          <div className="rounded-xl border border-slate-300 bg-slate-50 p-3.5 text-xs text-slate-700">
            <div className="flex items-center gap-1.5 font-extrabold text-slate-900">
              <Info className="h-4 w-4 text-blue-600" />
              <span>
                {t(
                  'Independent Extension Boundaries: Commit–Reveal & Mechanism C Rollover',
                  '独立扩展边界说明：Commit–Reveal 与 机制 C 顺延',
                )}
              </span>
            </div>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] leading-relaxed">
              <li>
                <strong>
                  Commit–Reveal (<code className="rounded bg-white px-1">BatchCommitReveal.sol</code>)
                </strong>
                {t(
                  ': Verified independently that salted minOut commitments lock funds during commit and expose minOut only on reveal, with full expiry refunds (commit 149,626 / reveal 58,322 / refund 44,272 Gas). ',
                  '：已独立实证在 commit 期将含高熵盐的限价承诺托管上链，reveal 期仅公开 ',
                )}
                {lang === 'zh' && (
                  <>
                    <code>minOut</code> 并验证到期全部退款（commit 149,626 / reveal 58,322 / refund 44,272 Gas）。
                  </>
                )}
                <strong>{t('Boundary:', '注意边界：')}</strong>{' '}
                {t(
                  'Trader, direction, and amount remain public during commit, and it is not wired into batch settlement — targeting slippage sniping rather than S3 directional cross-batch play.',
                  '承诺阶段交易者、买卖方向与金额仍然公开，且尚未接入交易清算，因此它针对滑点狙击而非消除 S3 的公开方向跨批博弈。',
                )}
              </li>
              <li>
                <strong>
                  {t('Mechanism C Rollover', '机制 C 顺延')} (<code className="rounded bg-white px-1">verify_rollover.py</code>)
                </strong>
                {t(
                  ': Off-chain opt-in manual claim of refunded tokens followed by one resubmission into the next batch, increasing Alice’s escrow lockup from 86s to 206s plus an extra submit+claim Gas cost.',
                  '：为链外自愿同意并手动领回退款后重投一次下一批，使 Alice 资产托管占用从 86s 增至 206s 并多一次 submit+claim Gas。',
                )}
              </li>
            </ul>
          </div>
        </div>

        {/* Right: Strict Chronological Steps Timeline (5 cols) */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-5">
          <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-2">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-extrabold text-slate-900">
                <Clock className="h-4 w-4 text-blue-600" />
                <span>
                  {t(
                    `Strict Chronological Timeline steps[] (${completedSteps.length} / ${replayTrace.steps.length} txs)`,
                    `严格时间线 steps[]（${completedSteps.length} / ${replayTrace.steps.length} 步原序播放）`,
                  )}
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                <code>batchId</code>{' '}
                {t(
                  'only tags batch membership and never reorders playback — final step proves Batch 0 Alice claims safely after Batch 1 settles.',
                  '仅标订单归属批次，不用于重排时间线——末步演示 Batch 0 Alice 在 Batch 1 结算后依然可安全领币。',
                )}
              </p>
            </div>
          </div>

          {completedSteps.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-xs text-slate-500">
              {t(
                'Timeline ready (0 / ' + replayTrace.steps.length + ' steps). Click Run 2-Batch Live to stream Batch 0 → Batch 1 → Safe Delayed Claim.',
                `时间线已就绪（0 / ${replayTrace.steps.length} 步）。点击「实链重跑双批」将按真实上链顺序逐条写入。`,
              )}
            </div>
          ) : (
            <ol className="space-y-1.5 tabular-nums">
              {completedSteps.map((st, idx) => {
                const roleMeta = getRoleMeta(st.actor, lang);
                const isCrossBatchDelayedClaim =
                  idx === replayTrace.steps.length - 1 && st.batchId === 0 && st.action === 'claim';
                return (
                  <li
                    key={`${st.txHash}-${idx}`}
                    className={`animate-step-pop flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                      isCrossBatchDelayedClaim
                        ? 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-400'
                        : st.batchId === 0
                          ? 'border-slate-200 bg-slate-50/70'
                          : 'border-blue-200 bg-blue-50/50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-4 font-mono text-[11px] text-slate-400">{idx + 1}.</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          st.batchId === 0 ? 'bg-slate-800 text-white' : 'bg-blue-700 text-white'
                        }`}
                      >
                        B{st.batchId}
                      </span>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${roleMeta.badgeClass}`}>
                        {roleMeta.label}
                      </span>
                      <span className="font-mono font-semibold text-slate-800">
                        {st.action}
                        {st.orderId !== null ? `(#${st.orderId})` : '()'}
                      </span>
                      {isCrossBatchDelayedClaim && (
                        <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                          {t('Safe Delayed Claim', '跨批后安全兑付')}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-slate-500">{formatGas(st.gasUsed)}</span>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-900 px-3 py-2 text-xs text-white tabular-nums">
            <span className="flex items-center gap-1">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
              {t('2-Batch Gas (excl. approve)', '双批汇总 Gas (excl. approve)')}
            </span>
            <span className="font-mono font-bold">
              {finalReady ? (
                <>
                  {t('Settle', '结算')} {formatGas(activeTrace.settleGas)} <ArrowRight className="inline h-3 w-3" />{' '}
                  {t('Total', '总计')} {formatGas(activeTrace.gas.total)}
                </>
              ) : (
                `${t('So Far', '当前累计')} ${formatGas(completedSteps.reduce((a, s) => a + s.gasUsed, 0))}`
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
