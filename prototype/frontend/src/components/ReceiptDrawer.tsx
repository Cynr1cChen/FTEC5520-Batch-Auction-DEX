import { useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileCheck2 } from 'lucide-react';
import { useLang } from '../i18n';
import { formatGas, formatPrice, formatUnitsExact, getRoleMeta, getRuleMeta, shortHash } from '../lib/format';
import type { ScenarioTrace } from '../types/trace';

interface ReceiptDrawerProps {
  traces: ScenarioTrace[];
  title?: string;
}

export function ReceiptDrawer({ traces, title }: ReceiptDrawerProps) {
  const [open, setOpen] = useState(false);
  const [traceIdx, setTraceIdx] = useState(0);
  const [stepLimit, setStepLimit] = useState<number | null>(null);
  const { lang, t } = useLang();

  const safeIdx = traceIdx < traces.length ? traceIdx : 0;
  const active = traces[safeIdx];

  useEffect(() => {
    setStepLimit(null);
  }, [active?.scenarioId, active?.ruleVersion, active?.steps.length]);

  if (!active) return null;

  const totalSteps = active.steps.length;
  const shownCount = stepLimit === null ? totalSteps : Math.min(stepLimit, totalSteps);
  const visibleSteps = active.steps.slice(0, shownCount);
  const resolvedTitle = title ?? t('On-Chain Receipt & State Audit Drawer', '底层链上回执与状态演进审计抽屉');

  return (
    <section className="mx-auto mt-4 max-w-[1440px] px-4 pb-6 sm:px-6">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between bg-slate-900 px-4 py-2.5 text-left text-white transition hover:bg-slate-800"
        >
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <FileCheck2 className="h-4 w-4 text-blue-400" />
            <span className="font-bold">{resolvedTitle}</span>
            <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-300 tabular-nums">
              {active.scenarioId} · {getRuleMeta(active.ruleVersion, lang).shortName} ·{' '}
              {t(`${totalSteps} receipts`, `${totalSteps} 笔回执`)} ·{' '}
              {t('Total Gas', '总 Gas')} {formatGas(active.gas.total)}
            </span>
            <span className="text-[11px] text-slate-400">
              {t(
                '(Scope: tx execution Gas only; excludes deploy & approve)',
                '（口径：成功交易原生 Gas，不含部署与预授权）',
              )}
            </span>
          </div>
          {open ? <ChevronUp className="h-4 w-4 text-slate-300" /> : <ChevronDown className="h-4 w-4 text-slate-300" />}
        </button>

        {open && (
          <div className="p-4">
            {/* Switch between traces if multiple shown side-by-side */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div className="flex flex-wrap items-center gap-2">
                {traces.map((tr, i) => (
                  <button
                    key={`${tr.scenarioId}-${tr.ruleVersion}`}
                    type="button"
                    onClick={() => setTraceIdx(i)}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${
                      i === safeIdx
                        ? 'border-blue-600 bg-blue-50 text-blue-800'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {tr.scenarioId} · {getRuleMeta(tr.ruleVersion, lang).shortName}
                  </button>
                ))}
              </div>

              {/* Chronological Step Player */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500">
                  {t('Step-by-step replay of steps[]:', '按原时间线回放 steps[]：')}
                </span>
                <button
                  type="button"
                  onClick={() => setStepLimit(Math.max(1, (stepLimit ?? totalSteps) - 1))}
                  className="rounded border border-slate-200 p-1 text-slate-700 hover:bg-slate-100"
                  title={t('Previous step', '上一步')}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-[4.5rem] text-center font-semibold text-slate-800 tabular-nums">
                  {shownCount} / {totalSteps} {t('steps', '步')}
                </span>
                <button
                  type="button"
                  onClick={() => setStepLimit(Math.min(totalSteps, (stepLimit ?? 0) + 1))}
                  className="rounded border border-slate-200 p-1 text-slate-700 hover:bg-slate-100"
                  title={t('Next step', '下一步')}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setStepLimit(null)}
                  className="rounded border border-slate-200 bg-slate-50 px-2 py-1 font-medium text-slate-700 hover:bg-slate-100"
                >
                  {t('Show All', '显示全部')}
                </button>
              </div>
            </div>

            {/* Summary metadata */}
            <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600 sm:grid-cols-4">
              <div>
                <span className="text-slate-400">{t('Source / Chain ID: ', '来源 / 链 ID：')}</span>
                <span className="font-semibold text-slate-800">
                  {active.evidenceSource} · chain {active.chainId}
                </span>
              </div>
              <div className="truncate">
                <span className="text-slate-400">{t('Build: ', '构建指纹：')}</span>
                <span className="font-mono text-slate-800">{shortHash(active.buildVersion.replace('sha256:', '0x'))}</span>
              </div>
              <div className="tabular-nums">
                <span className="text-slate-400">{t('Gas Breakdown: ', '分阶段 Gas：')}</span>
                <span className="font-semibold text-slate-800">
                  {Object.entries(active.gas.byAction)
                    .map(([k, v]) => `${k}:${formatGas(v)}`)
                    .join(' · ')}
                </span>
              </div>
              <div className="tabular-nums">
                <span className="text-slate-400">{t('Dust (ETH / USDC): ', '尾差 (ETH / USDC)：')}</span>
                <span className="font-semibold text-emerald-700">
                  {active.dustWei.mETH} / {active.dustWei.mUSDC} wei
                </span>
              </div>
            </div>

            {/* Steps table */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold text-slate-600 uppercase">
                    <th className="px-2.5 py-2">#</th>
                    <th className="px-2.5 py-2">{t('Batch', '批次')}</th>
                    <th className="px-2.5 py-2">{t('Action', '动作')}</th>
                    <th className="px-2.5 py-2">{t('Actor', '发起角色')}</th>
                    <th className="px-2.5 py-2">{t('Order', '订单')}</th>
                    <th className="px-2.5 py-2">{t('Block : Idx', '区块 / 序')}</th>
                    <th className="px-2.5 py-2 text-right">Gas</th>
                    <th className="px-2.5 py-2">{t('Tx Hash', '交易哈希')}</th>
                    <th className="px-2.5 py-2 text-right">{t('Reserves After (ETH / USDC)', '交易后池储备 (ETH / USDC)')}</th>
                    <th className="px-2.5 py-2 text-right">UCP / CoW</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {visibleSteps.map((s, idx) => {
                    const roleMeta = getRoleMeta(s.actor, lang);
                    return (
                      <tr key={`${s.txHash}-${idx}`} className={idx === shownCount - 1 && stepLimit !== null ? 'bg-blue-50/70' : 'hover:bg-slate-50'}>
                        <td className="px-2.5 py-1.5 font-mono text-slate-500">{idx + 1}</td>
                        <td className="px-2.5 py-1.5">
                          {s.batchId === null ? (
                            <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700">
                              {t('AMM Instant', 'AMM 即时')}
                            </span>
                          ) : (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700">
                              Batch #{s.batchId}
                            </span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono font-semibold text-slate-800">{s.action}</td>
                        <td className="px-2.5 py-1.5">
                          <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] font-semibold ${roleMeta.badgeClass}`}>
                            {roleMeta.label}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-slate-600">{s.orderId === null ? '—' : `#${s.orderId}`}</td>
                        <td className="px-2.5 py-1.5 font-mono text-slate-600">
                          {s.blockNumber}:{s.transactionIndex}
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-slate-800">{formatGas(s.gasUsed)}</td>
                        <td className="px-2.5 py-1.5 font-mono text-slate-500">{shortHash(s.txHash)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-slate-700">
                          {formatUnitsExact(s.poolStateAfter.eth, 4)} E / {formatUnitsExact(s.poolStateAfter.usdc, 2)} U
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-slate-700">
                          {s.poolStateAfter.ucp
                            ? `${formatPrice(s.poolStateAfter.ucp)} / CoW ${formatUnitsExact(s.poolStateAfter.cowUSDC, 2)}`
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
