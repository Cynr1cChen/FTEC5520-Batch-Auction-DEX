export type RuleVersion =
  | 'traditional_amm'
  | 'v2.2'
  | 'variant_A'
  | 'variant_B'
  | 'variant_AB';

export type OrderStatusName = 'Settled' | 'PartialFilled' | 'Refunded';

export type ActorRole = 'alice' | 'bob' | 'bot' | 'arb' | 'deployer';

export interface AssetPairStrings {
  eth: string;
  usdc: string;
  ucp?: string | null;
  cowUSDC?: string | null;
}

export interface DustStrings {
  mETH: string;
  mUSDC: string;
}

export interface OrderRecord {
  id: string;
  orderId: number;
  batchId: number | null;
  trader: ActorRole | string;
  side: 'buyETH' | 'sellETH';
  assetIn: 'mETH' | 'mUSDC';
  assetOut: 'mETH' | 'mUSDC';
  submittedIn: string;
  minOut: string;
  partialFillMinimum: string | null;
  partialFillEnabled: boolean;
  filledIn: string;
  receivedOut: string;
  refundedIn: string;
  status: OrderStatusName;
}

export interface StepRecord {
  label: string;
  action: 'submitOrder' | 'settleBatch' | 'claim' | 'swap' | string;
  actor: string;
  orderId: number | null;
  batchId: number | null;
  txHash: string;
  blockNumber: number;
  transactionIndex: number;
  timestamp: number;
  gasUsed: number;
  poolStateAfter: {
    eth: string;
    usdc: string;
    ucp: string | null;
    cowUSDC: string | null;
  };
}

export interface RoundCheck {
  orderId: number;
  quotedOut: string;
  minOut: string;
  excluded: boolean;
}

export interface RoundRecord {
  round: number;
  clearingPrice: string;
  buyTotal: string;
  sellTotal: string;
  checks: RoundCheck[];
  excludedOrderIds: number[];
}

export interface BatchRecord {
  batchId: number;
  endTime: number;
  initialPool: { eth: string; usdc: string };
  finalPool: { eth: string; usdc: string };
  clearingPrice: string;
  cowUSDC: string;
  refundedCount: number;
  dustWei: DustStrings;
  roundEvidenceSource?: string;
  rounds?: RoundRecord[];
}

export interface SettlementEvent {
  name: 'OrderReconsidered' | 'BatchPartialFill' | string;
  args: Record<string, string>;
}

export interface InventoryOutcome {
  inventoryRole: string;
  cashDeltaMUSDCBeforeNativeGas: string;
  inventoryDeltaMETH: string;
}

export interface ScenarioTrace {
  scenarioId: string;
  ruleVersion: RuleVersion;
  buildVersion: string;
  evidenceSource: string;
  chainId: number;
  addresses: {
    mockETH: string;
    mockUSDC: string;
    traditionalAMM?: string;
    batchAuctionDEX: string;
  };
  roles: Record<string, string>;
  initialState: {
    pool: AssetPairStrings;
    feeBps: number;
    batchId?: number;
    batchEndTime?: number;
    batchDurationSeconds?: number;
  };
  clearingPrice: string | null;
  cowUSDC: string | null;
  dustWei: DustStrings;
  settleGas: number | null;
  gas: {
    byAction: Record<string, number>;
    total: number;
    orderCount: number;
    includesApproval: boolean;
  };
  orders: OrderRecord[];
  steps: StepRecord[];
  settlementEvents: SettlementEvent[];
  batches: BatchRecord[];
  outcome?: InventoryOutcome;
}

export interface TraceBundle {
  schemaVersion: number;
  assetUnits: { mETH: number; mUSDC: number };
  clearingPriceDecimals: number;
  scenarios: ScenarioTrace[];
}

export interface VariantDeploymentInfo {
  address: string;
  abi: unknown[];
  buildVersion: string;
  batchEndTime: number;
}

export interface DeploymentManifest {
  schemaVersion: number;
  chainId: number;
  nodeInstanceId: string;
  ruleVersion: string;
  buildVersion: string;
  traditionalAMMBuildVersion?: string;
  assetUnits: { mETH: number; mUSDC: number };
  batchDurationSeconds: number;
  initialSnapshotId: string;
  snapshotBlockHash: string;
  addresses: {
    mockETH: string;
    mockUSDC: string;
    traditionalAMM: string;
    batchAuctionDEX: string;
  };
  roles: Record<ActorRole, string>;
  abis: {
    MockToken: unknown[];
    TraditionalAMM: unknown[];
    BatchAuctionDEX: unknown[];
  };
  variants?: Partial<Record<'variant_A' | 'variant_B' | 'variant_AB', VariantDeploymentInfo>>;
  initialState: {
    pool: { eth: string; usdc: string };
    feeBps: number;
    batchId: number;
    batchEndTime: number;
  };
}

export interface ReconciliationCheck {
  label: string;
  passed: boolean;
  liveVal: string;
  replayVal: string;
}

export interface ReconciliationReport {
  matched: boolean;
  checks: ReconciliationCheck[];
  gasDelta: number;
}

export interface GuardrailDefinition {
  id: 'early_settle' | 'claim_before_settle' | 'late_submit' | 'wrong_owner' | 'double_claim';
  errorName: string;
  selector: string;
  title: string;
  actorAction: string;
  whyItMatters: string;
}

export interface GuardrailResult {
  id: GuardrailDefinition['id'];
  passed: boolean;
  errorName: string;
  expectedSelector: string;
  actualSelector: string | null;
  detail: string;
}

export interface HistoricalS1Summary {
  fairEth: string;
  sandwichedEth: string;
  lossPct: string;
  botCashProfitUsdc: string;
  ammPostEth: string;
  ammPostUsdc: string;
  batchUcp: string;
  batchAliceEth: string;
  batchCowUsdc: string;
  botDeltaUsdc: string;
  botDeltaEth: string;
  botMarkedPnl: string;
  batchPostEth: string;
  batchPostUsdc: string;
  permutationInvariant: boolean;
}
