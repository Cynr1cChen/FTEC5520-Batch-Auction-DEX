import type { Lang } from '../i18n';
import type { ReconciliationCheck, ReconciliationReport, ScenarioTrace } from '../types/trace';

/**
 * Reconcile a freshly executed Live Hardhat run against the deterministic Replay trace
 * on economic outcomes, state transitions, dust, buildVersion, and event decisions
 * (explicitly ignoring ephemeral run hashes, timestamps, and block numbers).
 */
export function reconcileTraces(
  live: ScenarioTrace,
  replay: ScenarioTrace,
  lang: Lang = 'en',
): ReconciliationReport {
  const checks: ReconciliationCheck[] = [];
  const isAmm = replay.ruleVersion === 'traditional_amm';
  const en = lang === 'en';

  checks.push({
    label: en ? 'Scenario, Rule & Initial Reserves' : '场景、规则与初始储备',
    passed:
      live.scenarioId === replay.scenarioId &&
      live.ruleVersion === replay.ruleVersion &&
      live.initialState.pool.eth === replay.initialState.pool.eth &&
      live.initialState.pool.usdc === replay.initialState.pool.usdc,
    liveVal: `${live.scenarioId}/${live.ruleVersion}`,
    replayVal: `${replay.scenarioId}/${replay.ruleVersion}`,
  });

  checks.push({
    label: en ? 'Build Fingerprint (buildVersion)' : '构建指纹 (buildVersion)',
    passed: live.buildVersion === replay.buildVersion,
    liveVal: live.buildVersion.slice(0, 18),
    replayVal: replay.buildVersion.slice(0, 18),
  });

  checks.push({
    label: en ? 'Uniform Clearing Price (UCP)' : '统一清算价 (UCP)',
    passed: live.clearingPrice === replay.clearingPrice,
    liveVal: isAmm ? 'N/A (AMM)' : (live.clearingPrice ?? 'null'),
    replayVal: isAmm ? 'N/A (AMM)' : (replay.clearingPrice ?? 'null'),
  });

  checks.push({
    label: en ? 'Intra-Batch CoW Matched (cowUSDC)' : '批内直配额 (cowUSDC)',
    passed: live.cowUSDC === replay.cowUSDC,
    liveVal: isAmm ? 'N/A (AMM)' : (live.cowUSDC ?? 'null'),
    replayVal: isAmm ? 'N/A (AMM)' : (replay.cowUSDC ?? 'null'),
  });

  if (isAmm) {
    const liveLast = live.steps.at(-1)?.poolStateAfter;
    const replayLast = replay.steps.at(-1)?.poolStateAfter;
    checks.push({
      label: en ? 'AMM Final Pool Reserves (eth / usdc)' : 'AMM 最终池储备 (eth / usdc)',
      passed:
        Boolean(liveLast && replayLast) &&
        liveLast?.eth === replayLast?.eth &&
        liveLast?.usdc === replayLast?.usdc,
      liveVal: liveLast ? `${liveLast.eth}/${liveLast.usdc}` : 'missing',
      replayVal: replayLast ? `${replayLast.eth}/${replayLast.usdc}` : 'missing',
    });
  }

  checks.push({
    label: en ? 'Contract Dust (dustWei)' : '合约留存尾差 (dustWei)',
    passed:
      live.dustWei.mETH === replay.dustWei.mETH && live.dustWei.mUSDC === replay.dustWei.mUSDC,
    liveVal: `${live.dustWei.mETH}/${live.dustWei.mUSDC}`,
    replayVal: `${replay.dustWei.mETH}/${replay.dustWei.mUSDC}`,
  });

  const batchMatch =
    live.batches.length === replay.batches.length &&
    live.batches.every((lb, idx) => {
      const rb = replay.batches[idx];
      return (
        lb.batchId === rb.batchId &&
        lb.clearingPrice === rb.clearingPrice &&
        lb.cowUSDC === rb.cowUSDC &&
        lb.refundedCount === rb.refundedCount &&
        lb.finalPool.eth === rb.finalPool.eth &&
        lb.finalPool.usdc === rb.finalPool.usdc
      );
    });
  checks.push({
    label: en
      ? `Batch States (${replay.batches.length} batches reserves & UCP)`
      : `批次状态 (${replay.batches.length} 批储备与 UCP)`,
    passed: batchMatch,
    liveVal: `${live.batches.length} batches`,
    replayVal: `${replay.batches.length} batches`,
  });

  const ordersMatch =
    live.orders.length === replay.orders.length &&
    live.orders.every((lo, idx) => {
      const ro = replay.orders[idx];
      return (
        lo.status === ro.status &&
        lo.filledIn === ro.filledIn &&
        lo.receivedOut === ro.receivedOut &&
        lo.refundedIn === ro.refundedIn
      );
    });
  checks.push({
    label: en
      ? `Per-Order Fill/Out/Refund (${replay.orders.length} orders exact wei)`
      : `逐单实扣/到账/退款 (${replay.orders.length} 单逐 wei 核对)`,
    passed: ordersMatch,
    liveVal: live.orders.map((o) => o.status).join(','),
    replayVal: replay.orders.map((o) => o.status).join(','),
  });

  if (replay.outcome || live.outcome) {
    const outcomeMatch =
      live.outcome?.cashDeltaMUSDCBeforeNativeGas === replay.outcome?.cashDeltaMUSDCBeforeNativeGas &&
      live.outcome?.inventoryDeltaMETH === replay.outcome?.inventoryDeltaMETH;
    checks.push({
      label: en ? 'Cross-Batch Cash Delta (cashDelta)' : '跨批现金流变动 (cashDelta)',
      passed: outcomeMatch,
      liveVal: live.outcome?.cashDeltaMUSDCBeforeNativeGas ?? '—',
      replayVal: replay.outcome?.cashDeltaMUSDCBeforeNativeGas ?? '—',
    });
  }

  const liveEv = live.settlementEvents.map((e) => e.name).join(',');
  const replayEv = replay.settlementEvents.map((e) => e.name).join(',');
  checks.push({
    label: en ? 'Rule Events (settlementEvents)' : '规则机制事件 (settlementEvents)',
    passed: liveEv === replayEv,
    liveVal: liveEv || '(none)',
    replayVal: replayEv || '(none)',
  });

  return {
    matched: checks.every((c) => c.passed),
    checks,
    gasDelta: live.gas.total - replay.gas.total,
  };
}
