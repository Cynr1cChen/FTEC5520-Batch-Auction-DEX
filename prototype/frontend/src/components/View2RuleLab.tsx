import { useEffect, useRef, useState } from 'react';
import { BarChart3, Clock, Cpu, Info, Layers, Play, Sparkles } from 'lucide-react';
import { getSameFlowGasBenchmark, getTrace, getView2Scenarios, RULE_ORDER, VIEW2_SCENARIOS } from '../data/traces';
import { useLang } from '../i18n';
import {
  assetLabel,
  formatGas,
  formatPctDelta,
  formatPrice,
  formatUnitsExact,
  getRoleMeta,
  getRuleMeta,
  percentOfBigInt,
} from '../lib/format';
import {
  getRuleContractMeta,
  type LiveConnectionInfo,
  type LiveRuleSuiteCallbacks,
  type LiveStepEvent,
} from '../lib/liveClient';
import { reconcileTraces } from '../lib/reconcile';
import type { ScenarioTrace } from '../types/trace';
import { ReconcileBadge } from './ReconcileBadge';

type LabRule = (typeof RULE_ORDER)[number];
type PresetId = (typeof VIEW2_SCENARIOS)[number]['id'];

interface View2RuleLabProps {
  mode: 'replay' | 'live';
  liveInfo: LiveConnectionInfo;
  busy: boolean;
  resetGeneration: number;
  onRunRuleSuite: (
    scenarioId: string,
    callbacks?: LiveRuleSuiteCallbacks,
  ) => Promise<Record<LabRule, ScenarioTrace> | null>;
  onTraceFocus: (traces: ScenarioTrace[]) => void;
}

const ONE_USDC = 10n ** 18n;

const DEFAULT_FOCUS_BY_PRESET: Record<PresetId, LabRule> = {
  A_reconsider: 'variant_A',
  B_partial: 'variant_B',
  AB_preserve_payout: 'variant_AB',
  AB_compound: 'variant_AB',
  S2_no_change: 'variant_A',
};

export function View2RuleLab({
  mode,
  liveInfo,
  busy,
  resetGeneration,
  onRunRuleSuite,
  onTraceFocus,
}: View2RuleLabProps) {
  // Default to Preset #1 (A · Limit Reconsideration) with Variant A focused
  const [scenarioId, setScenarioId] = useState<PresetId>('A_reconsider');
  const [focusedRule, setFocusedRule] = useState<LabRule>('variant_A');
  const [liveSuite, setLiveSuite] = useState<Record<string, Partial<Record<LabRule, ScenarioTrace>>>>({});
  const [activeRunningRule, setActiveRunningRule] = useState<LabRule | null>(null);
  const [activeStepEvent, setActiveStepEvent] = useState<LiveStepEvent | null>(null);
  const [animating, setAnimating] = useState(false);
  const [animatedShownCount, setAnimatedShownCount] = useState<number | null>(null);
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
    setAnimatedShownCount(null);
    setActiveStepEvent(null);
  }, [mode]);

  useEffect(() => {
    if (resetGeneration === 0) return;
    tokenRef.current += 1;
    setAnimating(false);
    setAnimatedShownCount(null);
    setActiveRunningRule(null);
    setActiveStepEvent(null);
    setLiveSuite({});
  }, [resetGeneration]);

  const scenarios = getView2Scenarios(lang);
  const meta = scenarios.find((s) => s.id === scenarioId)!;
  const replayByRule = Object.fromEntries(
    RULE_ORDER.map((r) => [r, getTrace(scenarioId, r)]),
  ) as Record<LabRule, ScenarioTrace>;

  const livePartial = liveSuite[scenarioId] ?? {};
  const allLiveCompleted = RULE_ORDER.every((r) => Boolean(livePartial[r]));
  const anyLiveRunningOrDone = activeRunningRule !== null || RULE_ORDER.some((r) => Boolean(livePartial[r]));

  const activeByRule: Record<LabRule, ScenarioTrace> = Object.fromEntries(
    RULE_ORDER.map((r) => [r, mode === 'live' && livePartial[r] ? livePartial[r]! : replayByRule[r]]),
  ) as Record<LabRule, ScenarioTrace>;

  const baseTrace = activeByRule['v2.2'];
  const focusTrace = activeByRule[focusedRule];
  const focusLiveReady = mode === 'replay' || Boolean(livePartial[focusedRule]);
  const focusReport =
    mode === 'live' && livePartial[focusedRule]
      ? reconcileTraces(livePartial[focusedRule]!, replayByRule[focusedRule], lang)
      : null;

  const overallLiveState: 'ready' | 'running' | 'done' =
    activeRunningRule !== null || animating
      ? 'running'
      : mode === 'live'
        ? allLiveCompleted
          ? 'done'
          : 'ready'
        : 'done';

  const sameFlow = getSameFlowGasBenchmark();

  function handleSelectScenario(nextId: PresetId) {
    tokenRef.current += 1;
    setAnimating(false);
    setAnimatedShownCount(null);
    setActiveRunningRule(null);
    setActiveStepEvent(null);
    setScenarioId(nextId);
    setFocusedRule(DEFAULT_FOCUS_BY_PRESET[nextId]);
    const nextTraces = RULE_ORDER.map((r) =>
      mode === 'live' && liveSuite[nextId]?.[r] ? liveSuite[nextId]![r]! : getTrace(nextId, r),
    );
    onTraceFocus(nextTraces);
  }

  async function triggerSuiteLive() {
    const sid = scenarioId;
    tokenRef.current += 1;
    setAnimating(false);
    setAnimatedShownCount(null);
    setLiveSuite((prev) => ({ ...prev, [sid]: {} }));
    setFocusedRule('v2.2');

    const res = await onRunRuleSuite(sid, {
      onRuleStart: (rule) => {
        setActiveRunningRule(rule);
        setActiveStepEvent(null);
        setFocusedRule(rule);
      },
      onRuleStep: (_rule, evt) => {
        setActiveStepEvent(evt);
      },
      onRuleComplete: (rule, trace) => {
        setLiveSuite((prev) => ({
          ...prev,
          [sid]: { ...(prev[sid] ?? {}), [rule]: trace },
        }));
      },
      stepDelayMs: 130,
    });
    setActiveRunningRule(null);
    setActiveStepEvent(null);
    setFocusedRule(DEFAULT_FOCUS_BY_PRESET[sid]);
    if (res) {
      onTraceFocus(RULE_ORDER.map((r) => res[r]));
    }
  }

  async function animateReplayRace() {
    const token = ++tokenRef.current;
    setAnimating(true);
    setAnimatedShownCount(0);
    for (let i = 0; i < RULE_ORDER.length; i++) {
      if (tokenRef.current !== token) return;
      setFocusedRule(RULE_ORDER[i]);
      setAnimatedShownCount(i + 1);
      await new Promise((r) => setTimeout(r, 560));
    }
    if (tokenRef.current === token) {
      setFocusedRule(DEFAULT_FOCUS_BY_PRESET[scenarioId]);
      setAnimatedShownCount(null);
      setAnimating(false);
    }
  }

  const isRuleVisible = (rule: LabRule, idx: number): boolean => {
    if (mode === 'live') {
      return Boolean(livePartial[rule]);
    }
    if (animatedShownCount !== null) {
      return idx < animatedShownCount;
    }
    return true;
  };

  const maxCow = RULE_ORDER.reduce((mx, r, idx) => {
    if (!isRuleVisible(r, idx)) return mx;
    const v = BigInt(activeByRule[r].cowUSDC ?? '0');
    return v > mx ? v : mx;
  }, 1n);

  const maxTotalGas = Math.max(
    ...RULE_ORDER.map((r, idx) => (isRuleVisible(r, idx) ? activeByRule[r].gas.total : 0)),
    1,
  );

  return (
    <div className="space-y-4">
      {/* Top Scenario Switcher */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-bold text-indigo-800">
                {t('Act 5 · View 2 (Clearing Rule Lab)', 'Act 5 · 视角二（规则对比实验室）')}
              </span>
              <h2 className="text-base font-bold text-slate-900">
                {t(
                  'Same Reserves & Orders — Switch Clearing Rules: Original v2.2 vs Variant A vs Variant B vs Combined A+B',
                  '同储备同输入下，切换清算规则：原版 v2.2 vs 机制 A vs 机制 B vs 组合 A+B',
                )}
              </h2>
            </div>
            <p className="mt-1 text-xs text-slate-600">{meta.takeaway}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {mode === 'live' ? (
              <button
                type="button"
                disabled={!liveInfo.connected || !liveInfo.hasVariants || busy || activeRunningRule !== null}
                onClick={triggerSuiteLive}
                title={
                  !liveInfo.hasVariants
                    ? t(
                        'Deployment manifest missing variants; redeploy with --variants',
                        '当前部署清单不含变体合约，请用 --variants 重新部署',
                      )
                    : ''
                }
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" />
                <span>
                  {activeRunningRule
                    ? t('Streaming 4 Contracts Live…', '正依次跑通 4 套实链合约…')
                    : t('Run All 4 Rules Live', '实链逐个跑通全部 4 套规则')}
                </span>
              </button>
            ) : (
              <button
                type="button"
                disabled={animating}
                onClick={() => void animateReplayRace()}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>{animating ? t('Racing 4 Rules…', '规则逐步演示中…') : t('Animate 4-Rule Race', '逐套对比演示')}</span>
              </button>
            )}
            <ReconcileBadge
              mode={mode}
              evidenceSource={focusTrace.evidenceSource}
              report={focusReport}
              liveState={overallLiveState}
            />
          </div>
        </div>

        {/* 5 Preset Pills */}
        <div className="mt-3 flex flex-wrap gap-2">
          {scenarios.map((sc) => {
            const active = sc.id === scenarioId;
            return (
              <button
                key={sc.id}
                type="button"
                disabled={busy || activeRunningRule !== null}
                onClick={() => handleSelectScenario(sc.id)}
                className={`flex flex-col rounded-lg border px-3 py-2 text-left transition disabled:opacity-55 ${
                  active
                    ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-white'
                }`}
              >
                <div className="flex items-center gap-2 text-xs font-extrabold">
                  <span>{sc.title}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      active ? 'bg-indigo-500 text-white' : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {sc.badge}
                  </span>
                </div>
                <span className={`mt-0.5 text-[11px] ${active ? 'text-indigo-100' : 'text-slate-500'}`}>
                  {sc.ordersSummary}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {mode === 'live' && activeRunningRule !== null && (
        <div className="animate-step-pop flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue-300 bg-blue-50/90 px-4 py-2 text-xs text-blue-950 shadow-2xs tabular-nums">
          <div className="flex flex-wrap items-center gap-2">
            <Cpu className="h-3.5 w-3.5 animate-spin text-blue-600" />
            <span className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-bold text-white">
              {getRuleMeta(activeRunningRule, lang).shortName}
            </span>
            <span className="rounded border border-blue-200 bg-white px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-blue-800">
              {activeStepEvent?.phase ?? 'reset'}
            </span>
            <span className="font-semibold">
              {activeStepEvent?.message ?? t('Initializing rule contract snapshot…', '正在初始化合约快照…')}
            </span>
          </div>
          <span className="font-mono text-[11px] font-bold text-blue-800">
            {activeStepEvent?.completedSteps.length ?? 0} {t('txs', '笔交易')}
          </span>
        </div>
      )}

      {/* 4-Rule Scoreboard Cards (Click to Focus) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 tabular-nums">
        {RULE_ORDER.map((rule, idx) => {
          const trace = activeByRule[rule];
          const rMeta = getRuleMeta(rule, lang);
          const isFocused = rule === focusedRule;
          const visible = isRuleVisible(rule, idx);
          const isCurrentlyExecuting = mode === 'live' && activeRunningRule === rule;
          const baseReady = mode === 'replay' || Boolean(livePartial['v2.2']);
          const settleDelta =
            rule === 'v2.2'
              ? t('Baseline', '基线')
              : visible && baseReady
                ? formatPctDelta(trace.settleGas, baseTrace.settleGas)
                : '—';
          const totalDelta =
            rule === 'v2.2'
              ? t('Baseline', '基线')
              : visible && baseReady
                ? formatPctDelta(trace.gas.total, baseTrace.gas.total)
                : '—';
          const liveRec =
            mode === 'live' && livePartial[rule]
              ? reconcileTraces(livePartial[rule]!, replayByRule[rule], lang)
              : null;
          const endTimeChip =
            mode === 'live' && liveInfo.manifest && liveInfo.hasVariants
              ? getRuleContractMeta(liveInfo.manifest, rule, lang).initialBatchEndTime
              : trace.batches[0]?.endTime ?? trace.initialState.batchEndTime;

          return (
            <button
              key={rule}
              type="button"
              onClick={() => setFocusedRule(rule)}
              className={`flex flex-col justify-between rounded-xl border p-3.5 text-left transition ${
                isCurrentlyExecuting
                  ? 'animate-pulse-ring border-blue-600 bg-blue-50/40 ring-2 ring-blue-500 shadow-md'
                  : isFocused
                    ? 'border-indigo-600 bg-white ring-2 ring-indigo-600 shadow-md'
                    : 'border-slate-200 bg-white hover:border-slate-300 shadow-sm'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-1.5">
                  <span className={`rounded border px-2 py-0.5 text-[11px] font-bold ${rMeta.chipClass}`}>
                    {rMeta.shortName}
                  </span>
                  {isCurrentlyExecuting ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-800">
                      <Cpu className="h-3 w-3 animate-spin" />{' '}
                      {activeStepEvent?.phase ? activeStepEvent.phase.toUpperCase() : t('LIVE', '运行中')}
                    </span>
                  ) : liveRec ? (
                    <span
                      className={`animate-step-pop rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        liveRec.matched ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                      }`}
                    >
                      {liveRec.matched ? 'Live≡Replay' : t('Mismatch', '差异')}
                    </span>
                  ) : mode === 'live' ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                      {t('Queued', '待跑')}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5 text-xs font-semibold text-slate-500">{rMeta.subtitle}</div>

                {isCurrentlyExecuting && (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-all duration-300"
                      style={{ width: `${activeStepEvent?.windowProgressPct ?? 20}%` }}
                    />
                  </div>
                )}

                <div className="mt-2.5 flex items-baseline justify-between">
                  <div>
                    <div className="text-[11px] text-slate-400">{t('CoW Matched', 'CoW 批内直配额')}</div>
                    <div className="text-xl font-extrabold text-slate-900">
                      {visible ? formatUnitsExact(trace.cowUSDC, 2) : '—'}{' '}
                      <span className="text-xs font-bold text-slate-500">U</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] text-slate-400">UCP</div>
                    <div className="font-mono text-sm font-bold text-slate-700">
                      {visible ? formatPrice(trace.clearingPrice, 2) : '—'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-600">
                <div className="flex justify-between">
                  <span>{t('Settle Gas:', '结算 Gas：')}</span>
                  <span className="font-mono font-bold text-slate-800">
                    {visible ? `${formatGas(trace.settleGas)} (${settleDelta})` : '—'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{t('Total Gas:', '全流程 Gas：')}</span>
                  <span className="font-mono font-semibold text-slate-700">
                    {visible ? `${formatGas(trace.gas.total)} (${totalDelta})` : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-slate-400">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" /> endTime={endTimeChip ?? '—'}
                  </span>
                  <span>
                    {!visible
                      ? '100E / 200kU'
                      : trace.settlementEvents.length > 0
                        ? trace.settlementEvents.map((e) => e.name).join('+')
                        : t('No extra events', '无扩展事件')}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Middle Section: Per-Order Capital Flow (Left 7) + Dual Benefit vs Gas SVG Chart (Right 5) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Per-Order Flow Breakdown: Original v2.2 vs Focused Rule */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-7">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-indigo-600" />
              <h3 className="text-sm font-extrabold text-slate-900">
                {t('Per-Order Flow Breakdown: Original v2.2 vs ', '逐单资金流拆解：原版 v2.2 vs ')}
                <span className="text-indigo-700">{getRuleMeta(focusedRule, lang).name}</span>
              </h3>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />{' '}
                {t('Filled Input filledIn', '实际成交扣款 filledIn')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-sm bg-amber-400" />{' '}
                {t('Refunded Input refundedIn', '退回原币 refundedIn')}
              </span>
            </div>
          </div>

          <div className="space-y-3 tabular-nums">
            {focusTrace.orders.map((ord, idx) => {
              const baseOrd = baseTrace.orders[idx];
              const roleMeta = getRoleMeta(ord.trader, lang);
              const showLiveValues = focusLiveReady;
              const filledPct = showLiveValues ? percentOfBigInt(ord.filledIn, ord.submittedIn) : 0;
              const refundPct = showLiveValues ? 100 - filledPct : 0;

              const changedFromBase =
                showLiveValues &&
                (mode === 'replay' || Boolean(livePartial['v2.2'])) &&
                baseOrd &&
                (baseOrd.status !== ord.status ||
                  baseOrd.filledIn !== ord.filledIn ||
                  baseOrd.receivedOut !== ord.receivedOut);

              return (
                <div
                  key={ord.id}
                  className={`rounded-xl border p-3 transition ${
                    changedFromBase ? 'border-indigo-300 bg-indigo-50/35' : 'border-slate-200 bg-slate-50/50'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-bold text-slate-500">#{ord.orderId}</span>
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] font-bold ${roleMeta.badgeClass}`}>
                        {roleMeta.label}
                      </span>
                      <span className="font-semibold text-slate-800">
                        {ord.side === 'buyETH' ? t('Buy ETH', '买 ETH') : t('Sell ETH', '卖 ETH')} ·{' '}
                        {t('Submitted', '提交')} {formatUnitsExact(ord.submittedIn, 2)} {assetLabel(ord.assetIn)}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        ({t('Limit', '限价')} ≥ {formatUnitsExact(ord.minOut, 4)} {assetLabel(ord.assetOut)}
                        {ord.partialFillMinimum
                          ? ` · ${t('Voluntary minFill', '自愿最低成交')} ${formatUnitsExact(ord.partialFillMinimum, 0)} ${assetLabel(ord.assetIn)}`
                          : ''}
                        )
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {baseOrd && changedFromBase && (
                        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                          {t('v2.2', '原版')} {baseOrd.status}
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                          !showLiveValues
                            ? 'bg-slate-200 text-slate-600'
                            : ord.status === 'Settled'
                              ? 'bg-emerald-100 text-emerald-800'
                              : ord.status === 'PartialFilled'
                                ? 'bg-violet-100 text-violet-800'
                                : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {!showLiveValues
                          ? activeRunningRule === focusedRule
                            ? t('Executing…', '实链执行中…')
                            : t('Queued', '待执行')
                          : ord.status}
                      </span>
                    </div>
                  </div>

                  {/* Proportional Stacked Fill/Refund Bar */}
                  <div className="mt-2 flex h-4 w-full overflow-hidden rounded bg-slate-200">
                    {showLiveValues ? (
                      <>
                        {filledPct > 0 && (
                          <div
                            className="bg-emerald-500 transition-all duration-500"
                            style={{ width: `${filledPct}%` }}
                            title={`filledIn: ${formatUnitsExact(ord.filledIn, 4)} ${assetLabel(ord.assetIn)}`}
                          />
                        )}
                        {refundPct > 0 && (
                          <div
                            className="bg-amber-400 transition-all duration-500"
                            style={{ width: `${refundPct}%` }}
                            title={`refundedIn: ${formatUnitsExact(ord.refundedIn, 4)} ${assetLabel(ord.assetIn)}`}
                          />
                        )}
                      </>
                    ) : (
                      <div className="flex w-full items-center justify-center text-[10px] font-semibold text-slate-400">
                        {activeRunningRule === focusedRule
                          ? t('Running contract on Hardhat…', '正在 Hardhat 上执行合约…')
                          : t('Awaiting Run All 4 Rules Live', '等待运行 4 套实链对比')}
                      </div>
                    )}
                  </div>

                  {/* Numeric Breakdown */}
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <span className="text-[11px] text-slate-400">{t('Filled Input (filledIn)', '实际成交扣款 (filledIn)')}</span>
                      <div className="font-mono font-bold text-slate-800">
                        {showLiveValues ? `${formatUnitsExact(ord.filledIn, 4)} ${assetLabel(ord.assetIn)}` : '—'}
                      </div>
                    </div>
                    <div>
                      <span className="text-[11px] text-slate-400">{t('Received Asset (receivedOut)', '实得资产 (receivedOut)')}</span>
                      <div className="font-mono font-bold text-emerald-700">
                        {showLiveValues ? `${formatUnitsExact(ord.receivedOut, 6)} ${assetLabel(ord.assetOut)}` : '—'}
                        {baseOrd && changedFromBase ? (
                          <span className="ml-1 text-[10px] font-normal text-slate-400">
                            ({t('v2.2', '原版')} {formatUnitsExact(baseOrd.receivedOut, 4)})
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[11px] text-slate-400">{t('Refunded Input (refundedIn)', '退回原币 (refundedIn)')}</span>
                      <div className="font-mono font-bold text-amber-700">
                        {showLiveValues ? `${formatUnitsExact(ord.refundedIn, 4)} ${assetLabel(ord.assetIn)}` : '—'}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: CoW vs Gas Dual Comparison + Honest Mechanism Boundaries (5 cols) */}
        <div className="space-y-4 lg:col-span-5">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm tabular-nums">
            <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2">
              <div className="flex items-center gap-1.5 text-sm font-extrabold text-slate-900">
                <BarChart3 className="h-4 w-4 text-indigo-600" />
                <span>{t('Benefit vs Cost (CoW Match vs Total Gas)', '收益 vs 成本双指标对照（CoW 直配 vs 全流程 Gas）')}</span>
              </div>
              <span className="text-[10px] text-slate-400">{t('Excl. deploy & approve', '不含部署与预授权')}</span>
            </div>

            <div className="space-y-3">
              {RULE_ORDER.map((r, idx) => {
                const tr = activeByRule[r];
                const visible = isRuleVisible(r, idx);
                const cowVal = visible ? BigInt(tr.cowUSDC ?? '0') : 0n;
                const cowPct = visible && maxCow > 0n ? Number((cowVal * 10000n) / maxCow) / 100 : 0;
                const gasPct = visible ? (tr.gas.total / maxTotalGas) * 100 : 0;
                return (
                  <div key={r} className="space-y-1 text-xs">
                    <div className="flex justify-between font-bold text-slate-800">
                      <span>{getRuleMeta(r, lang).shortName}</span>
                      <span className="font-mono text-[11px] text-slate-500">
                        {visible
                          ? `CoW ${formatUnitsExact(cowVal, 2)} U · Total ${formatGas(tr.gas.total)} Gas`
                          : mode === 'live' && activeRunningRule === r
                            ? t('Executing on Hardhat…', '正在实链执行…')
                            : mode === 'live' && !anyLiveRunningOrDone
                              ? t('Queued', '待运行')
                              : '—'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="w-8 text-[10px] text-emerald-700">CoW</span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                            style={{ width: `${!visible || cowVal === 0n ? 0 : Math.max(cowPct, 4)}%` }}
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-8 text-[10px] text-slate-600">Gas</span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${gasPct.toFixed(1)}%`, backgroundColor: getRuleMeta(r, lang).barColor }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              {t('Extended Benchmark (Py-EVM pre-approved balanced flow): n=20 batch averages ', '扩展基准对照（Py-EVM 同流预授权均衡样本）：n=20 批处理均摊 ')}
              <strong>{Math.round(sameFlow[0]?.batchPerOrder ?? 231247).toLocaleString('en-US')}</strong>{' '}
              {t('Gas/order (AMM ', 'Gas/单（AMM ')}
              <strong>{(sameFlow[0]?.ratio ?? 3.19).toFixed(2)}×</strong>
              {t('); n=50 is ', '）；n=50 为 ')}
              <strong>{(sameFlow[1]?.ratio ?? 3.08).toFixed(2)}×</strong>
              {t(' (AMM baseline 72,538; all excl. approve).', '（AMM 基准 72,538，均未计 approve）。')}
            </div>
          </div>

          {/* Honest Mechanism Boundaries Card */}
          <div className="rounded-xl border border-slate-300 bg-slate-50 p-4 text-xs text-slate-700">
            <div className="flex items-center gap-1.5 font-extrabold text-slate-900">
              <Info className="h-4 w-4 text-indigo-600" />
              <span>{t('Mechanism Scope & Honest Boundaries', '三种改版的真实机制边界（严谨口径）')}</span>
            </div>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[11px] leading-relaxed">
              <li>
                <strong>{t('Variant A (Whole-Order Reconsideration)', '机制 A（整单二次复核）')}</strong>
                {t(': Re-admits at most ', '：最多恢复 ')}
                <strong>{t('1 excluded whole order', '1 笔')}</strong>
                {lang === 'zh' && <>被剔除整单</>}
                {t(' without reducing baseline winner payouts; breaks CoW ties via ', '且不减损原成交者到账；用 ')}{' '}
                <code>keccak256(trader, side, amountIn, minOut)</code>{' '}
                {t(
                  '— order-invariant for fixed batch contents (address-dependent key, no cross-identity fairness guarantee; cannot jointly recover two mutually excluded counterparties such as bob≥20k).',
                  '打破同 CoW 平手，同一批订单提交顺序无关（但地址参与键，无跨身份公平保证；若双对手方皆被剔除如 bob≥20k，A 无法成对恢复）。',
                )}
              </li>
              <li>
                <strong>{t('Variant B (Voluntary 2-Tier Partial Fill)', '机制 B（自愿两档部分成交）')}</strong>
                {t(': 2-tier fallback between ', '：为')}
                <strong>{t('full fill / opt-in minFillIn', '全额 / 授权回退额 minFillIn')}</strong>{' '}
                {t('(≤4 candidates per batch), not continuous optimization (e.g. ', '两档回退单（每批最多 4 单试算），并非连续区间最优化（如 ')}
                <code>minFillIn=19,000</code>{' '}
                {t(
                  'misses a feasible 20,000 match), with significantly higher Gas from partial-fill tracking & extra solver loops.',
                  '测试会漏掉可行的 20,000 解），且因增加负债账本和重算次数使 Gas 显著上升。',
                )}
              </li>
              <li>
                <strong>{t('Variant A+B (Sequential Composition)', '机制 A+B（顺序组合取舍）')}</strong>
                {t(': ', '：')}
                <code>AB_preserve_payout</code>{' '}
                {t(
                  'demonstrates the explicit trade-off — after Stage A locks Alice at 10 ETH, letting Stage B shrink Arb drops Alice to ',
                  '清楚揭示制度权衡——先定 A 阶段成交后，若允许 Stage B 缩量会把 Alice 到账从 ',
                )}
                {lang === 'zh' && <code>10</code>}
                {lang === 'zh' && ' 压到 '}
                <code>9.9643 ETH</code>
                {t(
                  ', so A+B foregoes higher CoW (23,885 U) to protect Stage-A payouts; ',
                  '，因此组合主动放弃更高直配额（23,885 U）以保住 Alice 10 ETH；',
                )}
                <code>AB_compound</code>{' '}
                {t(
                  'shows that when both stages fire, final fills match B alone while adding +23,315 settle Gas.',
                  '则展示两阶段同触发时结果与单跑 B 相同但多花 23,315 Gas。',
                )}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// Keep unused import guard clean
void ONE_USDC;
