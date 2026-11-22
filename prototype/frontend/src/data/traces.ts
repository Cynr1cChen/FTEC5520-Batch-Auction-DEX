import baselineExtensionsRaw from '../../../verification/baseline_extensions.json';
import ruleTraceRaw from '../../../verification/rule_comparison_trace.json';
import verificationResultsRaw from '../../../verification/verification_results.json';
import type { Lang } from '../i18n';
import type {
  GuardrailDefinition,
  HistoricalS1Summary,
  RuleVersion,
  ScenarioTrace,
  TraceBundle,
} from '../types/trace';

export const traceBundle = ruleTraceRaw as unknown as TraceBundle;

export function getTrace(scenarioId: string, ruleVersion: RuleVersion): ScenarioTrace {
  const hit = traceBundle.scenarios.find(
    (s) => s.scenarioId === scenarioId && s.ruleVersion === ruleVersion,
  );
  if (!hit) {
    throw new Error(`Missing replay trace for ${scenarioId} (${ruleVersion})`);
  }
  return hit;
}

export const RULE_ORDER: Array<'v2.2' | 'variant_A' | 'variant_B' | 'variant_AB'> = [
  'v2.2',
  'variant_A',
  'variant_B',
  'variant_AB',
];

export interface View2ScenarioMeta {
  id: 'A_reconsider' | 'B_partial' | 'AB_preserve_payout' | 'AB_compound' | 'S2_no_change';
  title: string;
  badge: string;
  takeaway: string;
  ordersSummary: string;
}

const VIEW2_SCENARIOS_BILINGUAL: Array<{
  id: View2ScenarioMeta['id'];
  en: Omit<View2ScenarioMeta, 'id'>;
  zh: Omit<View2ScenarioMeta, 'id'>;
}> = [
  {
    id: 'A_reconsider',
    en: {
      title: 'A · Limit Reconsideration',
      badge: 'High-Efficiency Gain',
      takeaway:
        'Original v2.2 refunds both buy orders (CoW = 0). Variant A re-admits Alice’s full order, raising CoW to 20,000 USDC for only +3.15% total Gas.',
      ordersSummary: 'Alice Buy 20k (≥9.7E) · Arb Buy 8k (≥4E) · Bob Sell 10E (≥18k)',
    },
    zh: {
      title: 'A 限价二次复核',
      badge: '高性价比改善',
      takeaway:
        '原版全退两买单（CoW=0）；机制 A 恢复 Alice 整笔成交，CoW 升至 20,000 USDC，全流程仅多 +3.15% Gas。',
      ordersSummary: 'Alice 买 20k(≥9.7E) · Arb 买 8k(≥4E) · Bob 卖 10E(≥18k)',
    },
  },
  {
    id: 'B_partial',
    en: {
      title: 'B · Voluntary Partial Fill',
      badge: 'Unlocks CoW (+64% Gas)',
      takeaway:
        'Original v2.2 settles and refunds both orders. Variant B scales Alice down to her declared minFillIn = 20k, filling 10 ETH and refunding 4k USDC (+107.03% settle Gas).',
      ordersSummary: 'Alice Buy 24k (≥12E, minFill 20k) · Bob Sell 10E (≥20k)',
    },
    zh: {
      title: 'B 自愿两档部分成交',
      badge: '缩量解锁 +64% Gas',
      takeaway:
        '原版全额结算后双双退款；机制 B 按 Alice 声明的 minFillIn=20k 成交 10 ETH 并退余款 4k，结算 Gas 增 +107.03%。',
      ordersSummary: 'Alice 买 24k(≥12E, minFill 20k) · Bob 卖 10E(≥20k)',
    },
  },
  {
    id: 'AB_preserve_payout',
    en: {
      title: 'A+B · Payout Protection Trade-off ⭐',
      badge: 'Design Trade-off Highlight',
      takeaway:
        'Variant B alone reaches 23,885.27 USDC CoW by diluting Alice from 10 to 9.9643 ETH; A+B blocks Stage-A payout dilution, preserving Alice’s 10 ETH and 20k CoW.',
      ordersSummary: 'Alice 20k (≥9.85E) · Arb 8k (≥3.93E, minFill 4k) · Bob 10E · Bot 1.9E',
    },
    zh: {
      title: 'A+B 收益保护权衡 ⭐',
      badge: '机制取舍亮点',
      takeaway:
        'B 单跑可直配 23,885.27 USDC 但把 Alice 到账压低到 9.9643 ETH；A+B 拒绝减收保护，守住 10 ETH 与 20k CoW。',
      ordersSummary: 'Alice 20k(≥9.85E) · Arb 8k(≥3.93E, minFill 4k) · Bob 10E · Bot 1.9E',
    },
  },
  {
    id: 'AB_compound',
    en: {
      title: 'A+B · Dual-Stage Firing Control',
      badge: 'Same Output as B, Higher Gas',
      takeaway:
        'A+B triggers both OrderReconsidered and BatchPartialFill, ending with the exact same fills as B alone (24k CoW) while costing +23,315 extra settlement Gas.',
      ordersSummary: 'Alice 20k (≥9.9E) · Arb 8k (≥4E, minFill 4k) · Bob 10E · Bot 2E',
    },
    zh: {
      title: 'A+B 双阶段触发对照',
      badge: '与 B 结果相同但多耗 Gas',
      takeaway:
        'A+B 依次触发 OrderReconsidered 与 BatchPartialFill，最终逐单到账与 B 完全一致（24k CoW），但多花 23,315 结算 Gas。',
      ordersSummary: 'Alice 20k(≥9.9E) · Arb 8k(≥4E, minFill 4k) · Bob 10E · Bot 2E',
    },
  },
  {
    id: 'S2_no_change',
    en: {
      title: 'S2_no_change · Parity Baseline',
      badge: 'Overhead When Already Optimal',
      takeaway:
        'All 4 rules settle identically (20k CoW, UCP = 2,000), honestly measuring baseline Gas overhead when extensions make no improvement: A (+0.07%), B (+29.91%), A+B (+29.97%).',
      ordersSummary: 'Alice Buy 20k (≥9E) · Bob Sell 10E (≥18k)',
    },
    zh: {
      title: 'S2_no_change 持平对照',
      badge: '无改善开销对照',
      takeaway:
        '四套规则经济结果分毫不差（20k CoW, UCP=2,000），诚实展示 A(+0.07%)、B(+29.91%)、A+B(+29.97%) 的基准额外开销。',
      ordersSummary: 'Alice 买 20k(≥9E) · Bob 卖 10E(≥18k)',
    },
  },
];

export function getView2Scenarios(lang: Lang): View2ScenarioMeta[] {
  return VIEW2_SCENARIOS_BILINGUAL.map((item) => ({
    id: item.id,
    ...item[lang],
  }));
}

export const VIEW2_SCENARIOS: View2ScenarioMeta[] = getView2Scenarios('zh');

const GUARDRAILS_BILINGUAL: Array<{
  id: GuardrailDefinition['id'];
  errorName: string;
  selector: string;
  en: Pick<GuardrailDefinition, 'title' | 'actorAction' | 'whyItMatters'>;
  zh: Pick<GuardrailDefinition, 'title' | 'actorAction' | 'whyItMatters'>;
}> = [
  {
    id: 'early_settle',
    errorName: 'BatchWindowNotClosed',
    selector: '0x25abfb0c',
    en: {
      title: 'Premature Batch Settlement',
      actorAction: 'Call settleBatch() before 120s window closes',
      whyItMatters: 'Prevents anyone from closing a batch early to truncate competing orders.',
    },
    zh: {
      title: '批次未到期强行结算',
      actorAction: '未满 120s 时调用 settleBatch()',
      whyItMatters: '防止任何节点或攻击者提前截胡关闭窗口，保障批收集公平期。',
    },
  },
  {
    id: 'claim_before_settle',
    errorName: 'OrderNotSettled',
    selector: '0x69348f71',
    en: {
      title: 'Early Claim Before Settlement',
      actorAction: 'Call claim(0) while Batch 0 is still Pending',
      whyItMatters: 'Keeps funds escrowed until the Uniform Clearing Price is finalized.',
    },
    zh: {
      title: '未结算提前领币',
      actorAction: 'Batch 0 仍 Pending 时调用 claim(0)',
      whyItMatters: '强制资金在统一清算价确定前锁定托管，防止抢领。',
    },
  },
  {
    id: 'late_submit',
    errorName: 'BatchWindowClosed',
    selector: '0x8279dd65',
    en: {
      title: 'Late Order After Cutoff',
      actorAction: 'Call submitOrder() after block.timestamp ≥ endTime',
      whyItMatters: 'Rejects late arrivals after cutoff; the batch must settle before the next opens.',
    },
    zh: {
      title: '关窗后插单抢入',
      actorAction: 'block.timestamp ≥ endTime 后调用 submitOrder()',
      whyItMatters: '截单后严格拒收迟到订单，必须先结算开启下一批。',
    },
  },
  {
    id: 'wrong_owner',
    errorName: 'NotOrderOwner',
    selector: '0xaa082d80',
    en: {
      title: 'Cross-Account Unauthorized Claim',
      actorAction: 'Bob tries to call claim(0) for Alice’s order',
      whyItMatters: 'Pull-payment strictly checks msg.sender == orders[id].trader.',
    },
    zh: {
      title: '冒领他人成交额',
      actorAction: 'Bob 尝试调用 claim(0) 领取 Alice 的订单',
      whyItMatters: 'Pull-Payment 严格校验 msg.sender == orders[id].trader。',
    },
  },
  {
    id: 'double_claim',
    errorName: 'AlreadyClaimed',
    selector: '0xb3167bfa',
    en: {
      title: 'Duplicate Claim / Double-Spend',
      actorAction: 'Alice calls claim(0) a second time after payout',
      whyItMatters: 'CEI pattern flips Claimed state before ERC-20 transfers, blocking double-claims.',
    },
    zh: {
      title: '重复领取资金',
      actorAction: 'Alice 已领完再次调用 claim(0)',
      whyItMatters: 'Claimed 状态先改写后转账（CEI 防重入），杜绝双花。',
    },
  },
];

export function getGuardrails(lang: Lang): GuardrailDefinition[] {
  return GUARDRAILS_BILINGUAL.map((g) => ({
    id: g.id,
    errorName: g.errorName,
    selector: g.selector,
    ...g[lang],
  }));
}

export const GUARDRAILS: GuardrailDefinition[] = getGuardrails('zh');

export interface LiveOrderSpec {
  role: 'alice' | 'bob' | 'bot' | 'arb';
  buy: boolean;
  amount: string;
  minimum: string;
  partialMinimum?: string;
}

export interface LiveSceneSpec {
  id: string;
  orders: LiveOrderSpec[];
  showRounds?: boolean;
  inventoryRole?: 'bot';
  nextBatch?: Array<{
    role: 'bot' | 'arb';
    buy: boolean;
    amount?: string;
    amountFromOrder?: number;
    minimum: string;
  }>;
}

export const LIVE_SCENE_SPECS: Record<string, LiveSceneSpec> = {
  S1_ordinary_buy_first: {
    id: 'S1_ordinary_buy_first',
    orders: [
      { role: 'alice', buy: true, amount: '20000', minimum: '0' },
      { role: 'bob', buy: false, amount: '10', minimum: '0' },
    ],
  },
  S1_ordinary_sell_first: {
    id: 'S1_ordinary_sell_first',
    orders: [
      { role: 'bob', buy: false, amount: '10', minimum: '0' },
      { role: 'alice', buy: true, amount: '20000', minimum: '0' },
    ],
  },
  S2_sell_0: {
    id: 'S2_sell_0',
    orders: [{ role: 'alice', buy: true, amount: '20000', minimum: '0' }],
  },
  S2_sell_5: {
    id: 'S2_sell_5',
    orders: [
      { role: 'alice', buy: true, amount: '20000', minimum: '0' },
      { role: 'bob', buy: false, amount: '5', minimum: '0' },
    ],
  },
  S2_sell_10: {
    id: 'S2_sell_10',
    orders: [
      { role: 'alice', buy: true, amount: '20000', minimum: '0' },
      { role: 'bob', buy: false, amount: '10', minimum: '0' },
    ],
  },
  T06_single_exclusion: {
    id: 'T06_single_exclusion',
    showRounds: true,
    orders: [
      { role: 'alice', buy: true, amount: '20000', minimum: '0' },
      { role: 'bob', buy: false, amount: '10', minimum: '0' },
      { role: 'arb', buy: true, amount: '2000', minimum: '5' },
    ],
  },
  T06b_cascading_exclusion: {
    id: 'T06b_cascading_exclusion',
    showRounds: true,
    orders: [
      { role: 'alice', buy: true, amount: '20000', minimum: '0' },
      { role: 'bob', buy: false, amount: '10', minimum: '0' },
      { role: 'bot', buy: true, amount: '60000', minimum: '30' },
      { role: 'arb', buy: false, amount: '10', minimum: '23000' },
    ],
  },
  S3_inventory_alone: {
    id: 'S3_inventory_alone',
    inventoryRole: 'bot',
    orders: [
      { role: 'bot', buy: true, amount: '30000', minimum: '0' },
      { role: 'alice', buy: true, amount: '20000', minimum: '0' },
    ],
    nextBatch: [{ role: 'bot', buy: false, amountFromOrder: 0, minimum: '0' }],
  },
  S3_inventory_with_additional_seller: {
    id: 'S3_inventory_with_additional_seller',
    inventoryRole: 'bot',
    orders: [
      { role: 'bot', buy: true, amount: '30000', minimum: '0' },
      { role: 'alice', buy: true, amount: '20000', minimum: '0' },
    ],
    nextBatch: [
      { role: 'bot', buy: false, amountFromOrder: 0, minimum: '0' },
      { role: 'arb', buy: false, amount: '15', minimum: '0' },
    ],
  },
  A_reconsider: {
    id: 'A_reconsider',
    orders: [
      { role: 'alice', buy: true, amount: '20000', minimum: '9.7' },
      { role: 'arb', buy: true, amount: '8000', minimum: '4' },
      { role: 'bob', buy: false, amount: '10', minimum: '18000' },
    ],
  },
  B_partial: {
    id: 'B_partial',
    orders: [
      { role: 'alice', buy: true, amount: '24000', minimum: '12', partialMinimum: '20000' },
      { role: 'bob', buy: false, amount: '10', minimum: '20000' },
    ],
  },
  AB_compound: {
    id: 'AB_compound',
    orders: [
      { role: 'alice', buy: true, amount: '20000', minimum: '9.9' },
      { role: 'arb', buy: true, amount: '8000', minimum: '4', partialMinimum: '4000' },
      { role: 'bob', buy: false, amount: '10', minimum: '17000' },
      { role: 'bot', buy: false, amount: '2', minimum: '4000' },
    ],
  },
  AB_preserve_payout: {
    id: 'AB_preserve_payout',
    orders: [
      { role: 'alice', buy: true, amount: '20000', minimum: '9.85' },
      { role: 'arb', buy: true, amount: '8000', minimum: '3.93', partialMinimum: '4000' },
      { role: 'bob', buy: false, amount: '10', minimum: '17000' },
      { role: 'bot', buy: false, amount: '1.9', minimum: '3800' },
    ],
  },
  S2_no_change: {
    id: 'S2_no_change',
    orders: [
      { role: 'alice', buy: true, amount: '20000', minimum: '9' },
      { role: 'bob', buy: false, amount: '10', minimum: '18000' },
    ],
  },
};

export function getHistoricalS1(): HistoricalS1Summary {
  const amm = verificationResultsRaw.scenarios.S1_TraditionalAMM;
  const dex = verificationResultsRaw.scenarios.S1_BatchAuctionDEX;
  return {
    fairEth: amm.alice_fair_eth,
    sandwichedEth: amm.alice_sandwiched_eth,
    lossPct: amm.alice_loss_pct,
    botCashProfitUsdc: amm.bot_net_profit_usdc,
    ammPostEth: amm.amm_post_reserve_eth,
    ammPostUsdc: amm.amm_post_reserve_usdc,
    batchUcp: dex.ucp_usdc_per_eth,
    batchAliceEth: dex.alice_eth_out,
    batchCowUsdc: dex.cow_usdc,
    botDeltaUsdc: dex.bot_delta_usdc,
    botDeltaEth: dex.bot_delta_eth,
    botMarkedPnl: dex.bot_pnl_marked_at_ucp,
    batchPostEth: dex.dex_post_reserve_eth,
    batchPostUsdc: dex.dex_post_reserve_usdc,
    permutationInvariant: dex.permutation_invariance_3_orders_identical,
  };
}

export function getSameFlowGasBenchmark() {
  const list = baselineExtensionsRaw.same_flow_gas;
  return list.map((item) => ({
    orderCount: item.order_count,
    batchPerOrder: item.batch.gas_per_order,
    ammPerOrder: item.amm.gas_per_order,
    ratio: item.batch_to_amm_gas_ratio,
  }));
}
