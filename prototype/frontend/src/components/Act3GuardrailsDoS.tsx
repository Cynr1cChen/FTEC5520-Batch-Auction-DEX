import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Cpu, Play, ShieldBan, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { getGuardrails, getTrace } from '../data/traces';
import { useLang } from '../i18n';
import { assetLabel, formatGas, formatPrice, formatUnitsExact, getRoleMeta } from '../lib/format';
import { reconcileTraces } from '../lib/reconcile';
import type { LiveConnectionInfo, LiveScenarioOptions, LiveStepEvent } from '../lib/liveClient';
import type { GuardrailDefinition, GuardrailResult, RoundRecord, ScenarioTrace } from '../types/trace';
import { buildReplayStepEvents, ExecutionTheater, type StagedOrderChip } from './ExecutionTheater';
import { ReconcileBadge } from './ReconcileBadge';

interface Act3GuardrailsDoSProps {
  mode: 'replay' | 'live';
  liveInfo: LiveConnectionInfo;
  busy: boolean;
  resetGeneration: number;
  onRunScenario: (
    scenarioId: string,
    rule: 'v2.2',
    options?: LiveScenarioOptions,
  ) => Promise<ScenarioTrace | null>;
  onRunGuardrail: (
    id: GuardrailDefinition['id'],
    onStage?: (stage: 'reset' | 'sending' | 'reverted') => void,
  ) => Promise<GuardrailResult | null>;
  onTraceFocus: (traces: ScenarioTrace[]) => void;
}

export function Act3GuardrailsDoS({
  mode,
  liveInfo,
  busy,
  resetGeneration,
  onRunScenario,
  onRunGuardrail,
  onTraceFocus,
}: Act3GuardrailsDoSProps) {
  // Default to first preset (T-06 Single Exclusion, Round 0)
  const [sceneId, setSceneId] = useState<'T06_single_exclusion' | 'T06b_cascading_exclusion'>('T06_single_exclusion');
  const [roundIdx, setRoundIdx] = useState(0);
  const [liveMap, setLiveMap] = useState<Record<string, ScenarioTrace>>({});
  const [guardResults, setGuardResults] = useState<Partial<Record<GuardrailDefinition['id'], GuardrailResult>>>({});
  const [guardStages, setGuardStages] = useState<Partial<Record<GuardrailDefinition['id'], 'reset' | 'sending' | 'reverted'>>>({});
  const [streaming, setStreaming] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [liveEvent, setLiveEvent] = useState<LiveStepEvent | null>(null);
  const [streamedRounds, setStreamedRounds] = useState<RoundRecord[] | null>(null);
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
    setStreamedRounds(null);
  }, [mode]);

  useEffect(() => {
    if (resetGeneration === 0) return;
    tokenRef.current += 1;
    setAnimating(false);
    setStreaming(false);
    setLiveEvent(null);
    setStreamedRounds(null);
    setLiveMap({});
    setGuardResults({});
    setGuardStages({});
    setRoundIdx(0);
  }, [resetGeneration]);

  const guardrails = getGuardrails(lang);
  const replayTrace = getTrace(sceneId, 'v2.2');
  const liveDone = liveMap[sceneId];
  const activeTrace = mode === 'live' && liveDone ? liveDone : replayTrace;
  const report = mode === 'live' && liveDone ? reconcileTraces(liveDone, replayTrace, lang) : null;

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

  const batch = resolvedEvent?.batchesSoFar.at(-1) ?? activeTrace.batches[0];
  const rounds: RoundRecord[] = (() => {
    if (theaterStatus === 'ready') return [];
    if (streamedRounds) return streamedRounds;
    if (theaterStatus === 'running') {
      return resolvedEvent?.activeRounds ?? [];
    }
    return batch.rounds ?? [];
  })();

  const safeRoundIdx = rounds.length > 0 && roundIdx < rounds.length ? roundIdx : 0;
  const activeRound = rounds[safeRoundIdx];
  const batchSettled = theaterStatus !== 'ready' && (theaterStatus === 'done' || Boolean(resolvedEvent?.batchesSoFar.length));
  const liveSettleGas =
    resolvedEvent?.completedSteps.find((s) => s.action === 'settleBatch')?.gasUsed ?? activeTrace.settleGas;

  const stagedOrders: StagedOrderChip[] =
    sceneId === 'T06_single_exclusion'
      ? [
          { role: 'alice', label: '#0 Alice Buy 20k' },
          { role: 'bob', label: '#1 Bob Sell 10E' },
          { role: 'arb', label: t('#2 Arb Buy 2k (min 5E!)', '#2 Arb 买 2k (限 5E!)') },
        ]
      : [
          { role: 'alice', label: '#0 Alice Buy 20k' },
          { role: 'bob', label: '#1 Bob Sell 10E' },
          { role: 'bot', label: t('#2 Bot Buy 60k (min 30E!)', '#2 Bot 买 60k (限 30E!)') },
          { role: 'arb', label: t('#3 Arb Sell 10E (min 23kU!)', '#3 Arb 卖 10E (限 23kU!)') },
        ];

  function switchScene(next: 'T06_single_exclusion' | 'T06b_cascading_exclusion') {
    tokenRef.current += 1;
    setAnimating(false);
    setStreaming(false);
    setLiveEvent(null);
    setStreamedRounds(null);
    setSceneId(next);
    setRoundIdx(0);
    onTraceFocus([mode === 'live' && liveMap[next] ? liveMap[next] : getTrace(next, 'v2.2')]);
  }

  async function revealRoundsStepByStep(fullRounds: RoundRecord[], token: number) {
    for (let i = 0; i < fullRounds.length; i++) {
      if (tokenRef.current !== token) return;
      setStreamedRounds(fullRounds.slice(0, i + 1));
      setRoundIdx(i);
      await new Promise((r) => setTimeout(r, 680));
    }
  }

  async function triggerLiveScene() {
    const token = ++tokenRef.current;
    setLiveEvent(null);
    setStreamedRounds(null);
    setRoundIdx(0);
    setStreaming(true);

    let roundsPromise: Promise<void> | null = null;
    const res = await onRunScenario(sceneId, 'v2.2', {
      onEvent: (evt) => {
        setLiveEvent(evt);
        if (evt.phase === 'settle' && evt.activeRounds && evt.activeRounds.length > 0 && !roundsPromise) {
          roundsPromise = revealRoundsStepByStep(evt.activeRounds, token);
        }
      },
      stepDelayMs: 320,
    });
    if (roundsPromise) await roundsPromise;
    setStreaming(false);
    setStreamedRounds(null);
    if (res) {
      setLiveMap((prev) => ({ ...prev, [sceneId]: res }));
      setRoundIdx((res.batches[0]?.rounds?.length ?? 1) - 1);
      onTraceFocus([res]);
    }
  }

  async function animateReplayRounds() {
    const token = ++tokenRef.current;
    setAnimating(true);
    setStreamedRounds(null);
    setRoundIdx(0);
    const frames = buildReplayStepEvents(replayTrace, lang);
    for (const frame of frames) {
      if (tokenRef.current !== token) return;
      setLiveEvent(frame);
      if (frame.phase === 'settle' && frame.activeRounds && frame.activeRounds.length > 0) {
        await revealRoundsStepByStep(frame.activeRounds, token);
      } else {
        await new Promise((r) => setTimeout(r, 340));
      }
    }
    if (tokenRef.current === token) {
      setStreamedRounds(null);
      setAnimating(false);
    }
  }

  async function triggerGuardrail(id: GuardrailDefinition['id']) {
    const res = await onRunGuardrail(id, (stage) => {
      setGuardStages((prev) => ({ ...prev, [id]: stage }));
    });
    if (res) {
      setGuardResults((prev) => ({ ...prev, [id]: res }));
      setGuardStages((prev) => ({ ...prev, [id]: 'reverted' }));
    } else {
      setGuardStages((prev) => ({ ...prev, [id]: undefined }));
    }
  }

  return (
    <div className="space-y-4">
      {/* Top Card: 5 Custom Error Hard Guardrails */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
          <div className="flex items-center gap-2">
            <ShieldBan className="h-4.5 w-4.5 text-rose-600" />
            <div>
              <h2 className="text-sm font-extrabold text-slate-900">
                {t(
                  'Act 3A · Five Protocol Security Guardrails (Strict 4-Byte Custom Error Selector Check)',
                  'Act 3A · 五大非法操作硬拦截（4-Byte Custom Error Selector 强核对）',
                )}
              </h2>
              <p className="text-xs text-slate-500">
                {t('All 5 4-byte selectors passed in Py-EVM & ', 'Hardhat 测试已逐一核验 4 字节选择器（Py-EVM 与 ')}
                <code className="rounded bg-slate-100 px-1">local-demo.test.js</code>
                {t('; switch to Live mode to trigger each revert on-chain.', ' 全绿）；切换到 Live 模式可现场逐个触发真链拦截。')}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
          {guardrails.map((g) => {
            const liveRes = guardResults[g.id];
            const stage = guardStages[g.id];
            const isSending = stage === 'reset' || stage === 'sending';
            return (
              <div
                key={g.id}
                className={`flex flex-col justify-between rounded-xl border p-3 transition ${
                  isSending
                    ? 'animate-pulse-ring border-amber-400 bg-amber-50/80'
                    : liveRes?.passed
                      ? 'animate-step-pop border-emerald-300 bg-emerald-50/60'
                      : 'border-slate-200 bg-slate-50/70'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-[11px] font-bold text-rose-700">{g.selector}</span>
                    {isSending ? (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                        <Cpu className="h-3 w-3 animate-spin" /> {t('Testing…', '检测中…')}
                      </span>
                    ) : liveRes ? (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">
                        <CheckCircle2 className="h-3 w-3" /> {t('Blocked Live', '实链已拦截')}
                      </span>
                    ) : (
                      <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                        {t('Selector Verified', '已验选择器')}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-xs font-extrabold text-slate-900">{g.errorName}</div>
                  <div className="mt-0.5 text-xs font-semibold text-slate-700">{g.title}</div>
                  <div className="mt-1 text-[11px] text-slate-500">{g.actorAction}</div>
                </div>

                <div className="mt-2.5 border-t border-slate-200/70 pt-2">
                  {mode === 'live' ? (
                    <button
                      type="button"
                      disabled={!liveInfo.connected || busy}
                      onClick={() => triggerGuardrail(g.id)}
                      className={`w-full rounded-md px-2 py-1 text-[11px] font-bold text-white transition disabled:opacity-40 ${
                        isSending ? 'bg-amber-600' : 'bg-rose-600 hover:bg-rose-500'
                      }`}
                    >
                      {isSending
                        ? stage === 'reset'
                          ? t('Resetting Snapshot…', '正在重置快照…')
                          : t('Sending Invalid Tx…', '发送非法交易…')
                        : t('Trigger Revert Live', '现场触发拦截测试')}
                    </button>
                  ) : (
                    <div className="text-[11px] text-slate-500">{g.whyItMatters}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Card: Non-blocking Iterative Exclusion Stepper */}
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="shrink-0 whitespace-nowrap rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">
                {t('Act 3B · Anti-DoS Exclusion', 'Act 3B · 防 DoS 迭代剔除')}
              </span>
              <h3 className="text-base font-extrabold text-slate-900">
                {t(
                  'Unfillable Limit Order Isolation & Cascading Re-Solve (T-06 / T-06b · MAX_ORDERS_PER_BATCH = 50)',
                  '恶意高限价单隔离与多轮级联重算（T-06 / T-06b · MAX_ORDERS_PER_BATCH = 50）',
                )}
              </h3>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              {t('Per-round quotes derived via deployed pure solver ', '轮次过程来自当期已部署纯求解函数 ')}
              <code className="rounded bg-slate-100 px-1">_solve</code>
              {t(' (', ' 复算（')}
              <code className="rounded bg-slate-100 px-1">
                roundEvidenceSource: {batch.roundEvidenceSource ?? 'solver-calls-derived'}
              </code>
              {t(
                '), reconciled against final on-chain order statuses & receipts.',
                '），并与最终链上订单状态与结算回执严格对账。',
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                disabled={busy || streaming}
                onClick={() => switchScene('T06_single_exclusion')}
                className={`rounded-md px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                  sceneId === 'T06_single_exclusion'
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-700 hover:bg-white'
                }`}
              >
                {t('T-06 Single Exclusion (2 Rounds)', 'T-06 单轮剔除（2 轮）')}
              </button>
              <button
                type="button"
                disabled={busy || streaming}
                onClick={() => switchScene('T06b_cascading_exclusion')}
                className={`rounded-md px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                  sceneId === 'T06b_cascading_exclusion'
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-700 hover:bg-white'
                }`}
              >
                {t('T-06b Cascading Exclusion (3 Rounds)', 'T-06b 级联剔除（3 轮）')}
              </button>
            </div>

            {mode === 'live' ? (
              <button
                type="button"
                disabled={!liveInfo.connected || busy || streaming}
                onClick={triggerLiveScene}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{streaming ? t('Streaming…', '直播执行中…') : t('Run Live', '实链运行')}</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={animating}
                onClick={() => void animateReplayRounds()}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>{animating ? t('Stepping Rounds…', '轮次步进中…') : t('Animate Rounds', '演示多轮重算')}</span>
              </button>
            )}

            <ReconcileBadge
              mode={mode}
              evidenceSource={activeTrace.evidenceSource}
              report={report}
              liveState={theaterStatus}
            />
          </div>
        </div>

        <ExecutionTheater
          variant="batch"
          status={theaterStatus}
          event={resolvedEvent}
          stagedOrders={stagedOrders}
          readyPrompt={t(
            'Batch #0 empty at 100E / 200kU. Click Run Live to watch orders submit, then settleBatch() isolate unfillable orders round by round.',
            'Batch #0 初始快照就绪（100E / 200kU），点击「实链运行」实时演示订单入批及 settleBatch() 逐轮剔除。',
          )}
        />

        {/* Round Stepper Tabs + Active Round Breakdown */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Left: Round Selector & Solver State */}
          <div className="space-y-3 lg:col-span-4">
            <div className="text-xs font-bold text-slate-600 uppercase">
              {t('Select Re-Solve Iteration', '选择迭代重算轮次')}
            </div>

            {rounds.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-500">
                {theaterStatus === 'running'
                  ? t('Escrowing orders into Batch #0 — waiting for settleBatch() solver rounds…', '订单正逐笔托管入 Batch #0 —— 即将进入关窗迭代试算…')
                  : t('Click Run Live above to step through iterative exclusion Round 0 → Converged.', '点击上方「实链运行」，从 Round 0 起步实时观看级联剔除过程。')}
              </div>
            ) : (
              <div className="space-y-2">
                {rounds.map((r, idx) => {
                  const selected = idx === safeRoundIdx;
                  return (
                    <button
                      key={r.round}
                      type="button"
                      onClick={() => setRoundIdx(idx)}
                      className={`animate-step-pop w-full rounded-xl border p-3 text-left transition tabular-nums ${
                        selected
                          ? 'border-blue-600 bg-blue-50/70 ring-1 ring-blue-600'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-extrabold text-slate-900">
                          Round {r.round}{' '}
                          {r.excludedOrderIds.length === 0
                            ? t('· Converged', '· 收敛定版')
                            : `· ${t('Excluded', '剔除')} ${r.excludedOrderIds.map((id) => `#${id}`).join(', ')}`}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            r.excludedOrderIds.length === 0
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {r.excludedOrderIds.length === 0 ? t('All Met', '全部达标') : t('Re-Solve', '重算触发')}
                        </span>
                      </div>
                      <div className="mt-1 grid grid-cols-3 gap-1 text-[11px] text-slate-600">
                        <div>B = {formatUnitsExact(r.buyTotal, 0)} U</div>
                        <div>S = {formatUnitsExact(r.sellTotal, 0)} E</div>
                        <div className="text-right font-semibold text-slate-800">UCP {formatPrice(r.clearingPrice, 2)}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-950 tabular-nums">
              <div className="flex items-center gap-1.5 font-bold text-emerald-800">
                <ShieldCheck className="h-4 w-4" />
                <span>{t('Final On-Chain Convergence', '最终链上收敛结果')}</span>
              </div>
              {batchSettled ? (
                <div className="mt-1 space-y-0.5 text-[11px]">
                  <div>
                    {t('Final UCP:', '最终 UCP：')} <strong>{formatPrice(batch.clearingPrice, 4)} USDC/ETH</strong>
                  </div>
                  <div>
                    {t('CoW Matched:', 'CoW 直配：')} <strong>{formatUnitsExact(batch.cowUSDC, 2)} USDC</strong>
                  </div>
                  <div>
                    {t('Refunded:', '退款单数：')}{' '}
                    <strong>{t(`${batch.refundedCount} orders (100% returned)`, `${batch.refundedCount} 笔全退原币`)}</strong> ·{' '}
                    {t('Dust:', '尾差：')} {batch.dustWei.mETH}/{batch.dustWei.mUSDC} wei
                  </div>
                  <div>
                    settleBatch Gas: <strong>{formatGas(liveSettleGas)}</strong> (
                    {t(`${rounds.length} rounds total`, `${rounds.length} 轮总耗`)})
                  </div>
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-emerald-800">
                  {t('Waiting for settleBatch() convergence…', '等待关窗结算收敛…')}
                </div>
              )}
            </div>
          </div>

          {/* Right: Orders Evaluated in Selected Round + Final Settlement Status */}
          <div className="space-y-3 lg:col-span-8">
            {activeRound ? (
              <div className="animate-step-pop rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-extrabold text-slate-900">
                    {t(
                      `Round ${activeRound.round} Clearing Check (${activeRound.checks.length} active orders · UCP = ${formatPrice(activeRound.clearingPrice, 4)})`,
                      `Round ${activeRound.round} 盘口试算（当前有效集 ${activeRound.checks.length} 单 · UCP = ${formatPrice(activeRound.clearingPrice, 4)}）`,
                    )}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {t(
                      'Rule: If quotedOut < minOut, order is marked Refunded & excluded from next round while honest orders keep settling.',
                      '规则：若试算到账 quotedOut < 限价 minOut，本单本轮置 Refunded 并从下一轮剔除，其余诚实订单继续重算。',
                    )}
                  </span>
                </div>

                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full border-collapse text-left text-xs tabular-nums">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold text-slate-600 uppercase">
                        <th className="px-3 py-2">{t('Order', '订单')}</th>
                        <th className="px-3 py-2">{t('Actor / Side', '角色 / 方向')}</th>
                        <th className="px-3 py-2 text-right">{t('Submitted', '投入数量')}</th>
                        <th className="px-3 py-2 text-right">{t('Limit minOut', '限价 minOut')}</th>
                        <th className="px-3 py-2 text-right">{t('Round Quote', '本轮试算到账')}</th>
                        <th className="px-3 py-2 text-center">{t('Decision', '本轮判定')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {activeRound.checks.map((chk) => {
                        const ord = activeTrace.orders.find((o) => o.orderId === chk.orderId)!;
                        const roleMeta = getRoleMeta(ord.trader, lang);
                        return (
                          <tr key={chk.orderId} className={chk.excluded ? 'bg-rose-50/70' : ''}>
                            <td className="px-3 py-2 font-mono font-bold text-slate-800">#{ord.orderId}</td>
                            <td className="px-3 py-2">
                              <span className={`mr-1.5 inline-block rounded border px-1.5 py-0.5 text-[10px] font-bold ${roleMeta.badgeClass}`}>
                                {roleMeta.label}
                              </span>
                              <span className="text-slate-600">
                                {ord.side === 'buyETH' ? t('Buy ETH', '买 ETH') : t('Sell ETH', '卖 ETH')}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right font-mono">
                              {formatUnitsExact(ord.submittedIn, 2)} {assetLabel(ord.assetIn)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-slate-600">
                              {formatUnitsExact(chk.minOut, 4)} {assetLabel(ord.assetOut)}
                            </td>
                            <td className={`px-3 py-2 text-right font-mono font-bold ${chk.excluded ? 'text-rose-700' : 'text-emerald-700'}`}>
                              {formatUnitsExact(chk.quotedOut, 4)} {assetLabel(ord.assetOut)}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {chk.excluded ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800">
                                  <XCircle className="h-3 w-3" /> {t('Below Limit · Excluded', '不达标 · 剔除退款')}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                                  <CheckCircle2 className="h-3 w-3" /> {t('Kept', '达标保留')}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-6 text-center text-xs text-slate-500">
                {theaterStatus === 'running'
                  ? t('Orders are entering Batch #0 escrow; per-round clearing check appears when settleBatch() executes…', '订单正进入 Batch #0 托管；当执行 settleBatch() 时这里将逐步弹出每轮试算表…')
                  : t('Pre-Run Ready: Click Run Live to watch iterative limit-price exclusion across rounds.', '就绪：点击「实链运行」即可动态看到各轮盘口试算与异常单剥离。')}
              </div>
            )}

            {/* Final On-Chain Order Outcomes */}
            <div className="rounded-xl border border-slate-200 bg-white p-3.5">
              <div className="mb-2 text-xs font-extrabold text-slate-800">
                {t('On-Chain Order States (100% Settled or Fully Refunded)', '链上订单状态（全部 100% 兑付或退原币）')}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 tabular-nums">
                {activeTrace.orders.map((ord) => {
                  const prog = resolvedEvent?.ordersSoFar.find((o) => o.orderId === ord.orderId);
                  const livePending = theaterStatus === 'ready' || !batchSettled;
                  const resolvedStatus = prog?.status && prog.status !== 'Pending' ? prog.status : ord.status;
                  const resolvedRefunded = prog?.refundedIn ?? ord.refundedIn;
                  const resolvedReceived = prog?.receivedOut ?? ord.receivedOut;
                  const statusLabel = livePending
                    ? prog
                      ? 'Pending'
                      : t('Queued', '待提交')
                    : resolvedStatus;
                  return (
                    <div
                      key={ord.id}
                      className={`rounded-lg border p-2.5 text-xs transition ${
                        livePending
                          ? 'border-slate-200 bg-slate-50/70'
                          : resolvedStatus === 'Refunded'
                            ? 'border-amber-300 bg-amber-50/70'
                            : 'border-emerald-200 bg-emerald-50/50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold text-slate-800">#{ord.orderId} {ord.trader}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            livePending
                              ? 'bg-slate-200 text-slate-700'
                              : resolvedStatus === 'Refunded'
                                ? 'bg-amber-200 text-amber-900'
                                : 'bg-emerald-200 text-emerald-900'
                          }`}
                        >
                          {statusLabel}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-slate-600">
                        {t('Submitted:', '提交：')} {formatUnitsExact(ord.submittedIn, 2)} {assetLabel(ord.assetIn)}
                      </div>
                      <div className="mt-0.5 font-semibold text-slate-900">
                        {livePending
                          ? t('Awaiting settleBatch()', '等待结算…')
                          : resolvedStatus === 'Refunded'
                            ? `${t('Refunded:', '退回：')} ${formatUnitsExact(resolvedRefunded, 2)} ${assetLabel(ord.assetIn)}`
                            : `${t('Received:', '到账：')} ${formatUnitsExact(resolvedReceived, 4)} ${assetLabel(ord.assetOut)}`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
