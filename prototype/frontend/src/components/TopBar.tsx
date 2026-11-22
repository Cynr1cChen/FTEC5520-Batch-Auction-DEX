import { Activity, AlertTriangle, Database, Languages, Layers, RefreshCw, ShieldCheck } from 'lucide-react';
import { useLang } from '../i18n';
import { shortHash } from '../lib/format';
import type { LiveConnectionInfo } from '../lib/liveClient';

export type ActiveView = 'core_arena' | 'rule_lab';
export type ExecMode = 'replay' | 'live';

interface TopBarProps {
  activeView: ActiveView;
  onViewChange: (view: ActiveView) => void;
  mode: ExecMode;
  onModeChange: (mode: ExecMode) => void;
  liveInfo: LiveConnectionInfo;
  busyMessage: string | null;
  onReset: () => void;
  onRedeploy: () => void;
  onRefreshLive: () => void;
}

export function TopBar({
  activeView,
  onViewChange,
  mode,
  onModeChange,
  liveInfo,
  busyMessage,
  onReset,
  onRedeploy,
  onRefreshLive,
}: TopBarProps) {
  const { lang, setLang, t } = useLang();
  const buildShort = liveInfo.manifest ? shortHash(liveInfo.manifest.buildVersion.replace('sha256:', '0x')) : null;

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800 bg-[#0B1426] text-white shadow-md">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2.5 px-4 py-2.5 sm:px-6">
        {/* Left: Brand & Dual-View Segmented Switch */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/90 text-white shadow-inner">
              <ShieldCheck className="h-4.5 w-4.5" />
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-blue-300 uppercase">
                <span>CUHK FTEC5520A · Group 9</span>
              </div>
              <div className="text-sm font-bold tracking-tight text-white">
                {t('Anti-MEV Batch Auction DEX Workbench', '抗抢跑批处理 DEX 交互实证控制台')}
              </div>
              <div className="text-[11px] text-slate-300">
                {t('ETH / USDC are local test tokens', 'ETH / USDC 为本地测试代币')}
              </div>
            </div>
          </div>

          <nav className="flex items-center rounded-lg bg-slate-900/90 p-1 ring-1 ring-slate-700/80">
            <button
              type="button"
              onClick={() => onViewChange('core_arena')}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${
                activeView === 'core_arena'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>{t('View 1 · Core Arena (Act 1–4)', '视角一 · 核心攻防台 (Act 1–4)')}</span>
            </button>
            <button
              type="button"
              onClick={() => onViewChange('rule_lab')}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${
                activeView === 'rule_lab'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>{t('View 2 · Rule Lab (Act 5)', '视角二 · 清算规则实验室 (Act 5)')}</span>
            </button>
          </nav>
        </div>

        {/* Right: Busy + Status + Language + Mode Toggle + Reset */}
        <div className="flex flex-wrap items-center gap-2">
          {busyMessage && (
            <div className="flex items-center gap-1.5 rounded-md border border-blue-500/40 bg-blue-950/80 px-2.5 py-1 text-xs text-blue-200">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>{busyMessage}</span>
            </div>
          )}

          {/* Connection status chip */}
          <button
            type="button"
            onClick={onRefreshLive}
            title={t(
              'Click to refresh local Hardhat node & deployment manifest',
              '点击刷新本地 Hardhat 节点与部署清单状态',
            )}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-xs font-medium transition ${
              liveInfo.connected
                ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-300 hover:bg-emerald-950'
                : liveInfo.staleNodeMismatch
                  ? 'border-amber-500/50 bg-amber-950/70 text-amber-200 hover:bg-amber-950'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                liveInfo.connected
                  ? 'bg-emerald-400'
                  : liveInfo.staleNodeMismatch
                    ? 'bg-amber-400'
                    : 'bg-slate-500'
              }`}
            />
            {liveInfo.connected && liveInfo.manifest ? (
              <span className="tabular-nums">
                Chain {liveInfo.manifest.chainId} · {t('Build', '构建')} {buildShort}
                {liveInfo.hasVariants ? t(' · +A/B/AB', ' · 含 A/B/AB') : t(' · v2.2 only', ' · 仅原版')}
              </span>
            ) : liveInfo.staleNodeMismatch ? (
              <span>{t('Node Restarted · Redeploy', '节点已重启 · 需重新部署')}</span>
            ) : (
              <span>{t('Hardhat Disconnected', 'Hardhat 节点未连接')}</span>
            )}
          </button>

          {liveInfo.staleNodeMismatch && (
            <button
              type="button"
              disabled={Boolean(busyMessage)}
              onClick={onRedeploy}
              className="flex items-center gap-1 whitespace-nowrap rounded-md border border-amber-400/60 bg-amber-500 px-2.5 py-1 text-xs font-bold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>{t('Redeploy (--variants)', '重新部署 (--variants)')}</span>
            </button>
          )}

          {/* Language Switcher: EN (Default) | 中文 */}
          <div
            className="flex items-center rounded-lg bg-slate-900/90 p-1 ring-1 ring-slate-700/80"
            title={t('Switch interface language', '切换中英文界面')}
          >
            <Languages className="ml-1 mr-1 h-3.5 w-3.5 text-slate-400" />
            <button
              type="button"
              onClick={() => setLang('en')}
              className={`rounded-md px-2 py-1 text-xs font-bold transition ${
                lang === 'en' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-300 hover:text-white'
              }`}
            >
              EN
            </button>
            <button
              type="button"
              onClick={() => setLang('zh')}
              className={`rounded-md px-2 py-1 text-xs font-bold transition ${
                lang === 'zh' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-300 hover:text-white'
              }`}
            >
              中文
            </button>
          </div>

          {/* Replay vs Live Switcher */}
          <div className="flex items-center rounded-lg bg-slate-900/90 p-1 ring-1 ring-slate-700/80">
            <button
              type="button"
              onClick={() => onModeChange('replay')}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold transition ${
                mode === 'replay'
                  ? 'bg-slate-100 text-slate-900 shadow-sm'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Database className="h-3.5 w-3.5" />
              <span>{t('Replay (31)', 'Replay 确定性回放 (31)')}</span>
            </button>
            <button
              type="button"
              onClick={() => onModeChange('live')}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold transition ${
                mode === 'live'
                  ? 'bg-emerald-500 text-slate-950 shadow-sm'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <span className="h-2 w-2 rounded-full bg-current" />
              <span>{t('Live (Zero-Popup)', 'Live 本地实链 (零弹窗)')}</span>
            </button>
          </div>

          <button
            type="button"
            disabled={mode !== 'live' || !liveInfo.connected || Boolean(busyMessage)}
            onClick={onReset}
            title={
              mode === 'live'
                ? t(
                    'Call evm_revert to restore 100 ETH / 200,000 USDC initial snapshot',
                    '调用 evm_revert 恢复 100 ETH / 200,000 USDC 初始快照',
                  )
                : t('Switch to Live mode to reset EVM snapshot', '切换到 Live 模式后可重置链上快照')
            }
            className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{t('Reset', 'Reset 快照')}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
