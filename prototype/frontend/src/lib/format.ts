import type { Lang } from '../i18n';
import type { OrderRecord, RuleVersion } from '../types/trace';

const TEN = 10n;

export function assetLabel(asset: OrderRecord['assetIn']): 'ETH' | 'USDC' {
  const labels = { mETH: 'ETH', mUSDC: 'USDC' } as const;
  return labels[asset];
}

function insertThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a 18-decimal integer wei string (or bigint) cleanly without floating-point loss.
 */
export function formatUnitsExact(
  raw: string | bigint | null | undefined,
  maxFrac = 4,
  options?: { signed?: boolean; decimals?: number; trimTrailingZeros?: boolean },
): string {
  if (raw === null || raw === undefined || raw === '') return '—';
  const decimals = options?.decimals ?? 18;
  const trimZeros = options?.trimTrailingZeros ?? true;
  const val = typeof raw === 'bigint' ? raw : BigInt(raw);
  const negative = val < 0n;
  const abs = negative ? -val : val;
  const scale = TEN ** BigInt(decimals);
  const whole = abs / scale;
  const rem = abs % scale;

  const sign = negative ? '−' : options?.signed && val > 0n ? '+' : '';
  if (maxFrac <= 0) {
    return `${sign}${insertThousands(whole.toString())}`;
  }

  // Round to maxFrac places using BigInt arithmetic
  const shift = decimals - maxFrac;
  let roundedWhole = whole;
  let fracVal: bigint;
  if (shift > 0) {
    const div = TEN ** BigInt(shift);
    fracVal = (rem + div / 2n) / div;
    const maxFracScale = TEN ** BigInt(maxFrac);
    if (fracVal >= maxFracScale) {
      roundedWhole += 1n;
      fracVal -= maxFracScale;
    }
  } else {
    fracVal = rem * TEN ** BigInt(-shift);
  }

  let fracStr = fracVal.toString().padStart(maxFrac, '0');
  if (trimZeros) {
    fracStr = fracStr.replace(/0+$/, '');
  }
  const intFormatted = insertThousands(roundedWhole.toString());
  return fracStr.length > 0 ? `${sign}${intFormatted}.${fracStr}` : `${sign}${intFormatted}`;
}

export function formatPrice(raw: string | bigint | null | undefined, maxFrac = 2): string {
  return formatUnitsExact(raw, maxFrac, { trimTrailingZeros: true });
}

export function formatGas(gas: number | bigint | null | undefined): string {
  if (gas === null || gas === undefined) return '—';
  return gas.toLocaleString('en-US');
}

export function formatPctDelta(current: number | null | undefined, baseline: number | null | undefined): string {
  if (current === null || current === undefined || baseline === null || baseline === undefined || baseline === 0) {
    return '—';
  }
  const pct = ((current - baseline) / baseline) * 100;
  const prefix = pct > 0 ? '+' : '';
  return `${prefix}${pct.toFixed(2)}%`;
}

export function percentOfBigInt(part: string | bigint, whole: string | bigint): number {
  const p = typeof part === 'bigint' ? part : BigInt(part);
  const w = typeof whole === 'bigint' ? whole : BigInt(whole);
  if (w <= 0n || p <= 0n) return 0;
  if (p >= w) return 100;
  return Number((p * 10000n) / w) / 100;
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return '—';
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export const ROLE_META: Record<string, { label: string; tag: string; tagEn: string; badgeClass: string }> = {
  alice: { label: 'Alice', tag: '普通买家', tagEn: 'Retail Buyer', badgeClass: 'bg-blue-50 text-blue-700 border-blue-200' },
  bob: { label: 'Bob', tag: '对手卖家', tagEn: 'Counterparty Seller', badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  bot: { label: 'Bot', tag: '套利/持仓者', tagEn: 'Arb / Inventory Bot', badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
  arb: { label: 'Arb', tag: '市场参与者', tagEn: 'Market Participant', badgeClass: 'bg-amber-50 text-amber-800 border-amber-200' },
  deployer: { label: 'Deployer', tag: '结算触发者', tagEn: 'Settler', badgeClass: 'bg-slate-100 text-slate-700 border-slate-300' },
};

export function getRoleMeta(role: string, lang: Lang) {
  const hit = ROLE_META[role];
  if (!hit) {
    return {
      label: role,
      tag: lang === 'en' ? 'Participant' : '参与者',
      badgeClass: 'bg-slate-100 text-slate-700 border-slate-200',
    };
  }
  return {
    label: hit.label,
    tag: lang === 'en' ? hit.tagEn : hit.tag,
    badgeClass: hit.badgeClass,
  };
}

export const RULE_META: Record<
  RuleVersion,
  {
    name: string;
    nameEn: string;
    shortName: string;
    shortNameEn: string;
    subtitle: string;
    subtitleEn: string;
    chipClass: string;
    borderClass: string;
    barColor: string;
  }
> = {
  traditional_amm: {
    name: 'TraditionalAMM',
    nameEn: 'TraditionalAMM',
    shortName: '传统 AMM',
    shortNameEn: 'Traditional AMM',
    subtitle: 'x·y = k 即时顺序成交',
    subtitleEn: 'x·y = k sequential instant swaps',
    chipClass: 'bg-rose-100 text-rose-800 border-rose-300',
    borderClass: 'border-rose-300',
    barColor: '#e11d48',
  },
  'v2.2': {
    name: '原版 BatchDEX v2.2',
    nameEn: 'Original BatchDEX v2.2',
    shortName: '原版 v2.2',
    shortNameEn: 'Original v2.2',
    subtitle: '同步整单剔除 · CoW + UCP',
    subtitleEn: 'Iterative whole-order exclusion · CoW + UCP',
    chipClass: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    borderClass: 'border-emerald-300',
    barColor: '#059669',
  },
  variant_A: {
    name: '机制 A · 限价复核',
    nameEn: 'Variant A · Reconsideration',
    shortName: '机制 A',
    shortNameEn: 'Variant A',
    subtitle: '至多恢复 1 整单（无序键平手）',
    subtitleEn: 'Re-admit ≤1 whole order (order-independent tie-break)',
    chipClass: 'bg-indigo-100 text-indigo-800 border-indigo-300',
    borderClass: 'border-indigo-300',
    barColor: '#4f46e5',
  },
  variant_B: {
    name: '机制 B · 指定部分成交',
    nameEn: 'Variant B · Partial Fill',
    shortName: '机制 B',
    shortNameEn: 'Variant B',
    subtitle: '全额 / minFillIn 两档回退（≤4单）',
    subtitleEn: '2-tier full / minFillIn fallback (≤4 candidates)',
    chipClass: 'bg-violet-100 text-violet-800 border-violet-300',
    borderClass: 'border-violet-300',
    barColor: '#7c3aed',
  },
  variant_AB: {
    name: '组合 A+B · 顺序组合',
    nameEn: 'Variant A+B · Combined',
    shortName: 'A+B 组合',
    shortNameEn: 'A+B Combined',
    subtitle: '先 A 定整单，再 B 缩量且不降 A 收益',
    subtitleEn: 'Stage A whole-order first, Stage B protects A payouts',
    chipClass: 'bg-sky-100 text-sky-800 border-sky-300',
    borderClass: 'border-sky-300',
    barColor: '#0284c7',
  },
};

export function getRuleMeta(rule: RuleVersion, lang: Lang) {
  const m = RULE_META[rule];
  return {
    name: lang === 'en' ? m.nameEn : m.name,
    shortName: lang === 'en' ? m.shortNameEn : m.shortName,
    subtitle: lang === 'en' ? m.subtitleEn : m.subtitle,
    chipClass: m.chipClass,
    borderClass: m.borderClass,
    barColor: m.barColor,
  };
}
