import { useState } from 'react';
import { CheckCircle2, AlertCircle, Database } from 'lucide-react';
import { useLang } from '../i18n';
import type { ReconciliationReport } from '../types/trace';

interface ReconcileBadgeProps {
  mode: 'replay' | 'live';
  evidenceSource: string;
  report?: ReconciliationReport | null;
  liveState?: 'ready' | 'running' | 'done';
}

export function ReconcileBadge({ mode, evidenceSource, report, liveState }: ReconcileBadgeProps) {
  const [open, setOpen] = useState(false);
  const { t } = useLang();

  if (mode === 'replay') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
        <Database className="h-3.5 w-3.5 text-slate-500" />
        <span>{t(`Deterministic Replay (${evidenceSource})`, `Replay 确定性实测 (${evidenceSource})`)}</span>
      </span>
    );
  }

  if (!report) {
    if (liveState === 'running') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-300 bg-blue-50 px-2.5 py-0.5 text-xs font-bold text-blue-800">
          <span className="h-2 w-2 rounded-full bg-blue-600 animate-ping" />
          <span>{t('Streaming Live Txs…', '实链交易直播执行中…')}</span>
        </span>
      );
    }
    if (liveState === 'ready') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span>{t('Ready · Click Run Live', '就绪 · 点击实链运行')}</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
        <span>
          {t('Replay Preloaded (click Run Live to verify wei parity)', 'Replay 预载（点击「实链重跑」验证 Live ≡ Replay）')}
        </span>
      </span>
    );
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold transition ${
          report.matched
            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
            : 'border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100'
        }`}
      >
        {report.matched ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 text-rose-600" />
        )}
        <span>
          {report.matched
            ? t('Live ≡ Replay Exact Wei Match (Inspect)', 'Live ≡ Replay 逐 wei 一致（点击看明细）')
            : t('Live vs Replay Mismatch', 'Live 与 Replay 存在差异')}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-1.5 text-xs font-bold text-slate-800">
            <span>
              {t('Live vs Replay Reconciliation (hashes & time excluded)', 'Live vs Replay 经济状态对账（已忽略哈希与时间）')}
            </span>
            <button type="button" onClick={() => setOpen(false)} className="shrink-0 text-slate-400 hover:text-slate-700">
              {t('Close', '关闭')}
            </button>
          </div>
          <ul className="space-y-1.5 text-xs">
            {report.checks.map((c) => (
              <li key={c.label} className="flex items-start justify-between gap-2">
                <span className="text-slate-600">{c.label}</span>
                <span className={`shrink-0 font-semibold ${c.passed ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {c.passed ? t('PASS', '通过') : `${c.liveVal} ≠ ${c.replayVal}`}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-slate-100 pt-1.5 text-[11px] text-slate-500 tabular-nums">
            {t('Total Gas Delta (Live − Replay):', 'Gas 总差额 (Live − Replay)：')}{' '}
            {report.gasDelta > 0 ? `+${report.gasDelta}` : report.gasDelta}
          </div>
        </div>
      )}
    </div>
  );
}
