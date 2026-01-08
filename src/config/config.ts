import dotenv from 'dotenv';
import { KeeperConfig, KeeperMode, CollateralType } from '../types';

// Load environment variables
dotenv.config();

/**
 * Load and validate keeper configuration from environment variables
 */
export function loadConfig(): KeeperConfig {
  // Validate required variables
  const requiredVars = ['PRIVATE_KEY', 'RPC_URL', 'VAT_ADDRESS', 'DOG_ADDRESS'];
  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }

  // Parse mode
  const mode = (process.env.MODE || 'full') as KeeperMode;
  if (!['full', 'kick', 'bid', 'peg'].includes(mode)) {
    throw new Error(`Invalid MODE: ${mode}. Must be 'full', 'kick', 'bid', or 'peg'`);
  }

  // Parse clippers
  const clippers: Record<CollateralType, string> = {
    'WBTC-A': process.env.WBTC_CLIPPER || '',
    'WETH-A': process.env.WETH_CLIPPER || '',
    'USDT-A': process.env.USDT_CLIPPER || '',
    'USDC-A': process.env.USDC_CLIPPER || '',
    'DAI-A': process.env.DAI_CLIPPER || '',
  };

  // Parse tokens
  const tokens: Record<CollateralType, string> = {
    'WBTC-A': process.env.WBTC_ADDRESS || '',
    'WETH-A': process.env.WETH_ADDRESS || '',
    'USDT-A': process.env.USDT_ADDRESS || '',
    'USDC-A': process.env.USDC_ADDRESS || '',
    'DAI-A': process.env.DAI_ADDRESS || '',
  };

  const config: KeeperConfig = {
    // Network
    rpcUrl: process.env.RPC_URL!,
    chainId: parseInt(process.env.CHAIN_ID || '3889'),
    privateKey: process.env.PRIVATE_KEY!,

    // Contracts
    vatAddress: process.env.VAT_ADDRESS!,
    dogAddress: process.env.DOG_ADDRESS!,
    vowAddress: process.env.VOW_ADDRESS || '',
    spotterAddress: process.env.SPOTTER_ADDRESS || '',
    flapperAddress: process.env.FLAPPER_ADDRESS || '',
    flopperAddress: process.env.FLOPPER_ADDRESS || '',
    sklcAddress: process.env.SKLC_ADDRESS || '',
    clippers,
    tokens,

    // Peg Keeper settings
    psmAddress: process.env.PSM_ADDRESS || '',
    dexRouterAddress: process.env.DEX_ROUTER_ADDRESS || '',
    dexPairAddress: process.env.DEX_PAIR_ADDRESS || '',
    pegUpperLimit: parseFloat(process.env.PEG_UPPER_LIMIT || '1.01'),
    pegLowerLimit: parseFloat(process.env.PEG_LOWER_LIMIT || '0.99'),
    pegCheckInterval: parseInt(process.env.PEG_CHECK_INTERVAL || '10000'),

    // Peg Keeper arbitrage limits
    enablePegArb: process.env.ENABLE_PEG_ARB !== 'false',                  // Default: true (enabled)
    maxArbAmount: BigInt(process.env.MAX_ARB_AMOUNT || '10000000'),        // Default: 10 USDC (6 decimals)
    minArbProfitPercentage: parseFloat(process.env.MIN_ARB_PROFIT_PERCENTAGE || '0.5'), // Default: 0.5%
    arbSlippageTolerance: parseFloat(process.env.ARB_SLIPPAGE_TOLERANCE || '0.005'),    // Default: 0.5%
    arbCooldownMs: parseInt(process.env.ARB_COOLDOWN_MS || '300000'),      // Default: 5 minutes
    maxTradePercentOfPool: parseInt(process.env.MAX_TRADE_PERCENT_OF_POOL || '10'),     // Default: 10%

    // Keeper settings
    mode,
    checkInterval: parseInt(process.env.CHECK_INTERVAL || '30000'),
    minProfitPercentage: parseFloat(process.env.MIN_PROFIT_PERCENTAGE || '5'),
    maxGasPrice: BigInt(process.env.MAX_GAS_PRICE || '50000000000'),
    gasLimit: parseInt(process.env.GAS_LIMIT || '3000000'),
    gasPrice: BigInt(process.env.GAS_PRICE || '21000000000'),

    // Safety
    maxCollateralPerAuction: BigInt(process.env.MAX_COLLATERAL_PER_AUCTION || '1000000'),
    emergencyStop: process.env.EMERGENCY_STOP === 'true',

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
    enableAlerts: process.env.ENABLE_ALERTS === 'true',
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
  };

  return config;
}

/**
 * Get collateral types to monitor based on configuration
 */
export function getCollateralTypes(config: KeeperConfig): CollateralType[] {
  const types: CollateralType[] = [];

  for (const [type, address] of Object.entries(config.clippers)) {
    if (address && address !== '') {
      types.push(type as CollateralType);
    }
  }

  return types;
}

/**
 * Convert collateral type to ilk bytes32
 */
export function collateralTypeToIlk(type: CollateralType): string {
  // Convert "WBTC-A" to bytes32
  const hex = Buffer.from(type, 'utf8').toString('hex');
  return '0x' + hex.padEnd(64, '0');
}

/**
 * Convert ilk bytes32 to collateral type
 */
export function ilkToCollateralType(ilk: string): CollateralType | null {
  try {
    // Remove 0x prefix and trailing zeros
    const hex = ilk.replace('0x', '').replace(/0+$/, '');
    const str = Buffer.from(hex, 'hex').toString('utf8');

    if (['WBTC-A', 'WETH-A', 'USDT-A', 'USDC-A', 'DAI-A'].includes(str)) {
      return str as CollateralType;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Validate configuration
 */
export function validateConfig(config: KeeperConfig): void {
  // Check network
  if (!config.rpcUrl.startsWith('http')) {
    throw new Error('Invalid RPC_URL: must start with http or https');
  }

  // Check private key
  if (!config.privateKey.startsWith('0x') || config.privateKey.length !== 66) {
    throw new Error('Invalid PRIVATE_KEY: must be 32 bytes hex string with 0x prefix');
  }

  // Check addresses
  const addressRegex = /^0x[a-fA-F0-9]{40}$/;
  if (!addressRegex.test(config.vatAddress)) {
    throw new Error('Invalid VAT_ADDRESS');
  }
  if (!addressRegex.test(config.dogAddress)) {
    throw new Error('Invalid DOG_ADDRESS');
  }

  // Check intervals
  if (config.checkInterval < 1000) {
    throw new Error('CHECK_INTERVAL must be at least 1000ms');
  }

  // Check profit percentage
  if (config.minProfitPercentage < 0 || config.minProfitPercentage > 100) {
    throw new Error('MIN_PROFIT_PERCENTAGE must be between 0 and 100');
  }

  console.log('✅ Configuration validated successfully');
}

