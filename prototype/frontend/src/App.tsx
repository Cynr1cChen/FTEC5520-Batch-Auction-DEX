import { useCallback, useEffect, useState } from 'react';
import { getTrace } from './data/traces';
import { useLang } from './i18n';
import {
  inspectLiveEnvironment,
  type LiveConnectionInfo,
  type LiveRuleSuiteCallbacks,
  type LiveScenarioOptions,
  redeployDemoViaApi,
  resetDemoViaApi,
  runLiveGuardrail,
  runLiveRuleSuite,
  runLiveScenario,
} from './lib/liveClient';
import { ReceiptDrawer } from './components/ReceiptDrawer';
import { type ActiveView, type ExecMode, TopBar } from './components/TopBar';
import { View1CoreArena } from './components/View1CoreArena';
import { View2RuleLab } from './components/View2RuleLab';
import type { GuardrailDefinition, RuleVersion, ScenarioTrace } from './types/trace';

export function App() {
  const { lang, t } = useLang();
  const [activeView, setActiveView] = useState<ActiveView>('core_arena');
  const [mode, setMode] = useState<ExecMode>('replay');
  const [liveInfo, setLiveInfo] = useState<LiveConnectionInfo>({
    connected: false,
    manifest: null,
    nodeInstanceId: null,
    staleNodeMismatch: false,
    hasVariants: false,
  });
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [noticeBanner, setNoticeBanner] = useState<string | null>(null);
  const [resetGeneration, setResetGeneration] = useState(0);
  const [focusedTraces, setFocusedTraces] = useState<ScenarioTrace[]>(() => [
    getTrace('S1_ordinary_buy_first', 'traditional_amm'),
    getTrace('S1_ordinary_buy_first', 'v2.2'),
  ]);

  const refreshLiveStatus = useCallback(async () => {
    const info = await inspectLiveEnvironment(lang);
    setLiveInfo(info);
    return info;
  }, [lang]);

  useEffect(() => {
    void refreshLiveStatus();
  }, [refreshLiveStatus]);

  function handleViewChange(view: ActiveView) {
    setActiveView(view);
    if (view === 'core_arena') {
      setFocusedTraces([
        getTrace('S1_ordinary_buy_first', 'traditional_amm'),
        getTrace('S1_ordinary_buy_first', 'v2.2'),
      ]);
    } else {
      setFocusedTraces([
        getTrace('A_reconsider', 'v2.2'),
        getTrace('A_reconsider', 'variant_A'),
        getTrace('A_reconsider', 'variant_B'),
        getTrace('A_reconsider', 'variant_AB'),
      ]);
    }
  }

  async function handleModeChange(next: ExecMode) {
    setErrorBanner(null);
    setNoticeBanner(null);
    if (next === 'live') {
      const info = await refreshLiveStatus();
      if (!info.connected) {
        setErrorBanner(
          info.errorMessage ??
            t(
              'Not connected to local Hardhat node (run ./demo-env run node & ./demo-env demo:deploy --variants in prototype/). You can switch back to Replay anytime.',
              '当前未连接到本地 Hardhat 实链节点（请在 prototype/ 运行 ./demo-env run node 与 ./demo-env demo:deploy --variants），仍可随时切回 Replay。',
            ),
        );
      }
    }
    setMode(next);
  }

  async function handleReset() {
    setErrorBanner(null);
    setNoticeBanner(null);
    setBusyMessage(t('Restoring initial EVM snapshot…', '正在恢复初始 EVM 快照…'));
    try {
      const manifest = await resetDemoViaApi(lang);
      setLiveInfo((prev) => ({ ...prev, manifest, connected: true, staleNodeMismatch: false }));
      setResetGeneration((g) => g + 1);
      setNoticeBanner(
        t(
          `Reset to initial snapshot (${manifest.initialSnapshotId}): both pools restored to 100 ETH / 200,000 USDC.`,
          `已成功重置至初始快照 (${manifest.initialSnapshotId})：双池恢复 100 ETH / 200,000 USDC。`,
        ),
      );
    } catch (err) {
      setErrorBanner(
        t(
          `Snapshot reset failed: ${(err as Error).message} (if the node restarted, click Redeploy or switch to Replay).`,
          `快照重置失败：${(err as Error).message}（如节点已重启，请点击重新部署或切回 Replay 兜底）`,
        ),
      );
      await refreshLiveStatus();
    } finally {
      setBusyMessage(null);
    }
  }

  async function handleRedeploy() {
    setErrorBanner(null);
    setNoticeBanner(null);
    setBusyMessage(
      t('Redeploying pools + A/B/AB variants and capturing snapshot…', '正在重新部署双池与 A/B/AB 变体并拍初始快照…'),
    );
    try {
      const manifest = await redeployDemoViaApi(lang);
      setLiveInfo({
        connected: true,
        manifest,
        nodeInstanceId: manifest.nodeInstanceId,
        staleNodeMismatch: false,
        hasVariants: Boolean(manifest.variants?.variant_A),
      });
      setResetGeneration((g) => g + 1);
      setNoticeBanner(
        t(
          `Redeployed on node ${manifest.nodeInstanceId.slice(0, 12)}… and updated deployment.json.`,
          `已重新部署至节点 ${manifest.nodeInstanceId.slice(0, 12)}… 并更新 deployment.json。`,
        ),
      );
    } catch (err) {
      setErrorBanner(t(`Redeploy failed: ${(err as Error).message}`, `重新部署失败：${(err as Error).message}`));
    } finally {
      setBusyMessage(null);
    }
  }

  async function handleRunScenario(
    scenarioId: string,
    rule: RuleVersion,
    options?: LiveScenarioOptions,
  ): Promise<ScenarioTrace | null> {
    setErrorBanner(null);
    setNoticeBanner(null);
    setBusyMessage(t(`Running ${scenarioId} (${rule}) live…`, `正在实链执行 ${scenarioId} (${rule})…`));
    try {
      const res = await runLiveScenario(scenarioId, rule, (m) => setBusyMessage(m), lang, options);
      setLiveInfo((prev) => ({ ...prev, manifest: res.manifest, connected: true, staleNodeMismatch: false }));
      return res.trace;
    } catch (err) {
      setErrorBanner(t(`Live execution failed: ${(err as Error).message}`, `Live 执行失败：${(err as Error).message}`));
      await refreshLiveStatus();
      return null;
    } finally {
      setBusyMessage(null);
    }
  }

  async function handleRunRuleSuite(scenarioId: string, callbacks?: LiveRuleSuiteCallbacks) {
    setErrorBanner(null);
    setNoticeBanner(null);
    setBusyMessage(
      t(`Running all 4 rule variants for ${scenarioId} live…`, `正在实链对比 ${scenarioId} 全部 4 套规则…`),
    );
    try {
      const res = await runLiveRuleSuite(scenarioId, (m) => setBusyMessage(m), lang, callbacks);
      setLiveInfo((prev) => ({ ...prev, manifest: res.manifest, connected: true, staleNodeMismatch: false }));
      setNoticeBanner(
        t(
          `Completed live execution of all 4 rules for ${scenarioId}. Inspect the Live ≡ Replay wei-parity badges below.`,
          `已完成 ${scenarioId} 全部 4 套规则的本地实链运行，请查看 Live ≡ Replay 逐 wei 对账徽章。`,
        ),
      );
      return res.tracesByRule;
    } catch (err) {
      setErrorBanner(
        t(`Live rule suite failed: ${(err as Error).message}`, `规则对比 Live 运行失败：${(err as Error).message}`),
      );
      await refreshLiveStatus();
      return null;
    } finally {
      setBusyMessage(null);
    }
  }

  async function handleRunGuardrail(
    id: GuardrailDefinition['id'],
    onStage?: (stage: 'reset' | 'sending' | 'reverted') => void,
  ) {
    setErrorBanner(null);
    setNoticeBanner(null);
    setBusyMessage(t(`Triggering guardrail revert test (${id})…`, `正在现场触发非法拦截校验 (${id})…`));
    try {
      const res = await runLiveGuardrail(id, lang, onStage);
      await refreshLiveStatus();
      setNoticeBanner(res.detail);
      return res;
    } catch (err) {
      setErrorBanner(
        t(`Guardrail trigger failed: ${(err as Error).message}`, `非法拦截触发失败：${(err as Error).message}`),
      );
      await refreshLiveStatus();
      return null;
    } finally {
      setBusyMessage(null);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <TopBar
        activeView={activeView}
        onViewChange={handleViewChange}
        mode={mode}
        onModeChange={handleModeChange}
        liveInfo={liveInfo}
        busyMessage={busyMessage}
        onReset={handleReset}
        onRedeploy={handleRedeploy}
        onRefreshLive={() => void refreshLiveStatus()}
      />

      {/* Alerts */}
      {(errorBanner || noticeBanner) && (
        <div className="mx-auto mt-3 max-w-[1440px] px-4 sm:px-6">
          {errorBanner && (
            <div className="flex flex-wrap items-center justify-between gap-2 overflow-hidden rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 text-xs font-semibold text-rose-900">
              <span className="min-w-0 flex-1 break-all">{errorBanner}</span>
              <div className="flex shrink-0 items-center gap-2">
                {mode === 'live' && (
                  <button
                    type="button"
                    onClick={() => setMode('replay')}
                    className="rounded-md bg-rose-700 px-2.5 py-1 text-white hover:bg-rose-600"
                  >
                    {t('Switch to Replay Fallback', '一键切换 Replay 兜底')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setErrorBanner(null)}
                  className="text-rose-500 hover:text-rose-800"
                >
                  {t('Close', '关闭')}
                </button>
              </div>
            </div>
          )}
          {noticeBanner && (
            <div className="flex items-center justify-between gap-2 overflow-hidden rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-900">
              <span className="min-w-0 flex-1 break-words">{noticeBanner}</span>
              <button
                type="button"
                onClick={() => setNoticeBanner(null)}
                className="shrink-0 text-emerald-600 hover:text-emerald-900"
              >
                {t('Close', '关闭')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      <main className="mx-auto max-w-[1440px] px-4 pt-4 sm:px-6">
        {activeView === 'core_arena' ? (
          <View1CoreArena
            mode={mode}
            liveInfo={liveInfo}
            busy={Boolean(busyMessage)}
            resetGeneration={resetGeneration}
            onRunScenario={handleRunScenario}
            onRunGuardrail={handleRunGuardrail}
            onTraceFocus={setFocusedTraces}
          />
        ) : (
          <View2RuleLab
            mode={mode}
            liveInfo={liveInfo}
            busy={Boolean(busyMessage)}
            resetGeneration={resetGeneration}
            onRunRuleSuite={handleRunRuleSuite}
            onTraceFocus={setFocusedTraces}
          />
        )}
      </main>

      {/* Bottom Shared Receipt & Step Audit Drawer */}
      <ReceiptDrawer traces={focusedTraces} />
    </div>
  );
}

export default App;
