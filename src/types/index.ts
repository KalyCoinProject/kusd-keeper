// Keeper modes
export type KeeperMode = 'full' | 'kick' | 'bid' | 'peg';

// Collateral types
export type CollateralType = 'WBTC-A' | 'WETH-A' | 'USDT-A' | 'USDC-A' | 'DAI-A';

// Vault (Urn) data
export interface Urn {
  address: string;
  ilk: string;
  ink: bigint;  // Collateral amount (in WAD)
  art: bigint;  // Debt amount (in WAD)
}

// Ilk (collateral type) data
export interface Ilk {
  name: string;
  Art: bigint;   // Total debt
  rate: bigint;  // Accumulated rates (RAY)
  spot: bigint;  // Price with safety margin (RAY)
  line: bigint;  // Debt ceiling (RAD)
  dust: bigint;  // Minimum debt (RAD)
}

// Clipper auction data (collateral auctions)
export interface Auction {
  id: number;
  ilk: string;
  urn: string;
  usr: string;
  tab: bigint;   // Total debt to recover (RAD)
  lot: bigint;   // Collateral amount (WAD)
  top: bigint;   // Starting price (RAY)
  tic: number;      // Auction start time
  pos: bigint;   // Current position in price curve
  active: boolean;
}

// Flapper auction data (surplus auctions)
export interface FlapAuction {
  id: number;
  bid: bigint;   // sKLC paid (WAD)
  lot: bigint;   // KUSD received (RAD)
  guy: string;   // High bidder
  tic: number;   // Bid expiry time
  end: number;   // Auction expiry time
  active: boolean;
}

// Flopper auction data (debt auctions)
export interface FlopAuction {
  id: number;
  bid: bigint;   // KUSD paid (RAD)
  lot: bigint;   // sKLC received (WAD)
  guy: string;   // High bidder
  gal: string;   // Receives KUSD (Vow)
  tic: number;   // Bid expiry time
  end: number;   // Auction expiry time
  active: boolean;
}

// Liquidation opportunity
export interface LiquidationOpportunity {
  urn: Urn;
  ilk: Ilk;
  collateralValue: bigint;
  debtValue: bigint;
  collateralizationRatio: number;
  liquidationRatio: number;
  canLiquidate: boolean;
}

// Bidding opportunity (Clipper auctions)
export interface BiddingOpportunity {
  auction: Auction;
  currentPrice: bigint;
  marketPrice: bigint;
  profitPercentage: number;
  profitable: boolean;
  maxTake: bigint;
}

// Flap bidding opportunity (surplus auctions)
export interface FlapBiddingOpportunity {
  auction: FlapAuction;
  minBid: bigint;        // Minimum bid increase
  profitable: boolean;
  estimatedProfit: bigint;
}

// Flop bidding opportunity (debt auctions)
export interface FlopBiddingOpportunity {
  auction: FlopAuction;
  maxLot: bigint;        // Maximum lot decrease
  profitable: boolean;
  estimatedProfit: bigint;
}

// Configuration
export interface KeeperConfig {
  // Network
  rpcUrl: string;
  chainId: number;
  privateKey: string;

  // Contracts
  vatAddress: string;
  dogAddress: string;
  vowAddress: string;
  spotterAddress: string;
  flapperAddress: string;
  flopperAddress: string;
  sklcAddress: string;
  clippers: Record<CollateralType, string>;
  tokens: Record<CollateralType, string>;

  // Peg Keeper settings
  psmAddress: string;
  dexRouterAddress: string;
  dexPairAddress: string;
  pegUpperLimit: number;
  pegLowerLimit: number;
  pegCheckInterval: number;

  // Peg Keeper arbitrage limits
  enablePegArb: boolean;          // Enable/disable peg arbitrage
  maxArbAmount: bigint;           // Max USDC to trade per cycle (6 decimals)
  minArbProfitPercentage: number; // Minimum profit % to execute arb
  arbSlippageTolerance: number;   // Slippage tolerance (e.g., 0.005 = 0.5%)
  arbCooldownMs: number;          // Cooldown between arb trades in milliseconds
  maxTradePercentOfPool: number;  // Max % of pool to trade per arb (e.g., 10 = 10%)

  // Keeper settings
  mode: KeeperMode;
  checkInterval: number;
  minProfitPercentage: number;
  maxGasPrice: bigint;
  gasLimit: number;
  gasPrice: bigint;

  // Safety
  maxCollateralPerAuction: bigint;
  emergencyStop: boolean;

  // Logging
  logLevel: string;
  enableAlerts: boolean;
  alertWebhookUrl?: string;
}

// Events
export interface VatFrobEvent {
  ilk: string;
  urn: string;
  dink: bigint;
  dart: bigint;
  blockNumber: number;
  transactionHash: string;
}

export interface DogBarkEvent {
  ilk: string;
  urn: string;
  ink: bigint;
  art: bigint;
  due: bigint;
  clip: string;
  id: number;
  blockNumber: number;
  transactionHash: string;
}

export interface ClipperKickEvent {
  id: number;
  top: bigint;
  tab: bigint;
  lot: bigint;
  usr: string;
  kpr: string;
  coin: bigint;
  blockNumber: number;
  transactionHash: string;
}

export interface ClipperTakeEvent {
  id: number;
  max: bigint;
  price: bigint;
  owe: bigint;
  tab: bigint;
  lot: bigint;
  usr: string;
  blockNumber: number;
  transactionHash: string;
}

export interface FlapperKickEvent {
  id: number;
  lot: bigint;
  bid: bigint;
  blockNumber: number;
  transactionHash: string;
}

export interface FlapperTendEvent {
  id: number;
  lot: bigint;
  bid: bigint;
  blockNumber: number;
  transactionHash: string;
}

export interface FlopperKickEvent {
  id: number;
  lot: bigint;
  bid: bigint;
  gal: string;
  blockNumber: number;
  transactionHash: string;
}

export interface FlopperDentEvent {
  id: number;
  lot: bigint;
  bid: bigint;
  blockNumber: number;
  transactionHash: string;
}

// Transaction result
export interface TransactionResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  gasUsed?: bigint;
}

// Health status
export interface KeeperHealth {
  isRunning: boolean;
  mode: KeeperMode;
  lastCheck: Date;
  vaultsMonitored: number;
  activeAuctions: number;
  liquidationsTriggered: number;
  bidsExecuted: number;
  totalProfit: bigint;
  pegArbsExecuted: number;
  errors: number;
}

