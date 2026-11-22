import { useState } from 'react';
import { useLang } from '../i18n';
import type { LiveConnectionInfo, LiveScenarioOptions } from '../lib/liveClient';
import type { GuardrailDefinition, GuardrailResult, RuleVersion, ScenarioTrace } from '../types/trace';
import { Act1Ordering } from './Act1Ordering';
import { Act2CowLadder } from './Act2CowLadder';
import { Act3GuardrailsDoS } from './Act3GuardrailsDoS';
import { Act4CrossBatch } from './Act4CrossBatch';
import type { ReceiptFocus } from './ReceiptDrawer';

export type CoreAct = 'act1' | 'act2' | 'act3' | 'act4';

interface View1CoreArenaProps {
  mode: 'replay' | 'live';
  liveInfo: LiveConnectionInfo;
  busy: boolean;
  resetGeneration: number;
  onRunScenario: (
    scenarioId: string,
    rule: RuleVersion,
    options?: LiveScenarioOptions,
  ) => Promise<ScenarioTrace | null>;
  onRunGuardrail: (
    id: GuardrailDefinition['id'],
    onStage?: (stage: 'reset' | 'sending' | 'reverted') => void,
  ) => Promise<GuardrailResult | null>;
  onActChange: () => void;
  onTraceFocus: (focus: ReceiptFocus) => void;
}

const ACTS: Array<{ id: CoreAct; tag: string; titleEn: string; titleZh: string }> = [
  { id: 'act1', tag: 'Act 1', titleEn: 'S1 Order Invariance + Sandwich Context', titleZh: 'S1 顺序对照 + 三明治动机' },
  { id: 'act2', tag: 'Act 2', titleEn: 'S2 CoW Matching Ladder (0/5/10E)', titleZh: 'S2 CoW 三档直配阶梯 (0/5/10E)' },
  { id: 'act3', tag: 'Act 3', titleEn: 'Guardrails + T-06/06b Anti-DoS', titleZh: '非法拦截 + T-06/06b 防 DoS' },
  { id: 'act4', tag: 'Act 4', titleEn: 'S3 Cross-Batch Risk & Extensions', titleZh: 'S3 跨批双分支 + 扩展边界' },
];

export function View1CoreArena({
  mode,
  liveInfo,
  busy,
  resetGeneration,
  onRunScenario,
  onRunGuardrail,
  onTraceFocus,
  onActChange,
}: View1CoreArenaProps) {
  const [act, setAct] = useState<CoreAct>('act1');
  const { lang } = useLang();

  function handleSelectAct(next: CoreAct) {
    if (next === act) return;
    onActChange();
    setAct(next);
  }

  return (
    <div className="space-y-4">
      {/* Sub-act navigation strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {ACTS.map((item) => {
          const active = act === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelectAct(item.id)}
              className={`rounded-xl border px-3.5 py-2.5 text-left transition ${
                active
                  ? 'border-blue-600 bg-blue-600 text-white shadow-sm'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <div className={`text-[11px] font-bold uppercase ${active ? 'text-blue-100' : 'text-blue-600'}`}>
                {item.tag}
              </div>
              <div className="mt-0.5 text-xs font-extrabold">{lang === 'en' ? item.titleEn : item.titleZh}</div>
            </button>
          );
        })}
      </div>

      {act === 'act1' && (
        <Act1Ordering
          mode={mode}
          liveInfo={liveInfo}
          busy={busy}
          resetGeneration={resetGeneration}
          onRunScenario={(sid, r, opt) => onRunScenario(sid, r, opt)}
          onTraceFocus={onTraceFocus}
        />
      )}
      {act === 'act2' && (
        <Act2CowLadder
          mode={mode}
          liveInfo={liveInfo}
          busy={busy}
          resetGeneration={resetGeneration}
          onRunScenario={(sid, r, opt) => onRunScenario(sid, r, opt)}
          onTraceFocus={onTraceFocus}
        />
      )}
      {act === 'act3' && (
        <Act3GuardrailsDoS
          mode={mode}
          liveInfo={liveInfo}
          busy={busy}
          resetGeneration={resetGeneration}
          onRunScenario={(sid, r, opt) => onRunScenario(sid, r, opt)}
          onRunGuardrail={onRunGuardrail}
          onTraceFocus={onTraceFocus}
        />
      )}
      {act === 'act4' && (
        <Act4CrossBatch
          mode={mode}
          liveInfo={liveInfo}
          busy={busy}
          resetGeneration={resetGeneration}
          onRunScenario={(sid, r, opt) => onRunScenario(sid, r, opt)}
          onTraceFocus={onTraceFocus}
        />
      )}
    </div>
  );
}
