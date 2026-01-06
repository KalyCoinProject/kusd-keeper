import { ethers } from 'ethers';
import { KeeperConfig } from '../types';
import { ContractService } from './ContractService';
import logger from '../utils/logger';

// Minimal ABIs
const PSM_ABI = [
    'function sellGem(address usr, uint256 gemAmt) external returns (uint256)',
    'function buyGem(address usr, uint256 gemAmt) external returns (uint256)',
    'function tin() external view returns (uint256)',
    'function tout() external view returns (uint256)',
    'function gem() external view returns (address)',
    'function kusd() external view returns (address)',
    'function pocket() external view returns (address)'
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function balanceOf(address account) external view returns (uint256)',
    'function decimals() external view returns (uint8)'
];

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
];

const PAIR_ABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)'
];

// Safety constants
const MIN_POOL_LIQUIDITY_USD = 100n * 1000000n; // 100 USDC minimum (6 decimals)
const MAX_TRADE_PERCENT_OF_POOL = 10; // Max 10% of pool per trade



export class PegKeeperService {
    private psm: ethers.Contract;
    private router: ethers.Contract;
    private pair: ethers.Contract;
    private gem: ethers.Contract | null = null;
    private kusd: ethers.Contract | null = null;
    private wallet: ethers.Wallet;
    private config: KeeperConfig;
    private lastArbTime: number = 0;
    private pocketAddress: string | null = null;
    private gemIsToken0: boolean = false;

    constructor(contractService: ContractService, config: KeeperConfig) {
        this.config = config;
        this.wallet = contractService['wallet'];

        if (!config.psmAddress || !config.dexRouterAddress || !config.dexPairAddress) {
            throw new Error('Missing Peg Keeper configuration (PSM, Router, or Pair address)');
        }

        this.psm = new ethers.Contract(config.psmAddress, PSM_ABI, this.wallet);
        this.router = new ethers.Contract(config.dexRouterAddress, ROUTER_ABI, this.wallet);
        this.pair = new ethers.Contract(config.dexPairAddress, PAIR_ABI, this.wallet);

        logger.info('PegKeeperService configured with limits', {
            maxArbAmount: `${Number(config.maxArbAmount) / 1e6} USDC`,
            minProfitPct: `${config.minArbProfitPercentage}%`,
            slippageTolerance: `${config.arbSlippageTolerance * 100}%`,
            cooldownMs: `${config.arbCooldownMs / 1000}s`,
        });
    }

    async initialize() {
        const gemAddress = await this.psm.gem();
        const kusdAddress = await this.psm.kusd();
        this.pocketAddress = await this.psm.pocket();

        this.gem = new ethers.Contract(gemAddress, ERC20_ABI, this.wallet);
        this.kusd = new ethers.Contract(kusdAddress, ERC20_ABI, this.wallet);

        // Determine token ordering in the pair
        const token0 = await this.pair.token0();
        this.gemIsToken0 = token0.toLowerCase() === gemAddress.toLowerCase();

        logger.info('PegKeeperService initialized', {
            gem: gemAddress,
            kusd: kusdAddress,
            pocket: this.pocketAddress,
            gemIsToken0: this.gemIsToken0
        });
    }

    async checkAndArbitrage(): Promise<{ executed: boolean; profit: bigint }> {
        if (!this.gem || !this.kusd) await this.initialize();

        try {
            // Check cooldown
            const now = Date.now();
            const timeSinceLastArb = now - this.lastArbTime;
            if (this.lastArbTime > 0 && timeSinceLastArb < this.config.arbCooldownMs) {
                const remainingCooldown = Math.ceil((this.config.arbCooldownMs - timeSinceLastArb) / 1000);
                logger.debug(`Arb cooldown active, ${remainingCooldown}s remaining`);
                return { executed: false, profit: 0n };
            }

            // Check pool liquidity first
            const liquidity = await this.getPoolLiquidity();
            if (liquidity.usdcReserve < MIN_POOL_LIQUIDITY_USD) {
                logger.warn(`Pool liquidity too low: ${ethers.formatUnits(liquidity.usdcReserve, 6)} USDC < minimum ${ethers.formatUnits(MIN_POOL_LIQUIDITY_USD, 6)} USDC. Skipping arb.`);
                return { executed: false, profit: 0n };
            }

            const price = await this.getKusdPrice();
            if (price === null) {
                logger.warn('Could not determine KUSD price, skipping arb');
                return { executed: false, profit: 0n };
            }

            logger.debug(`Current KUSD Price: $${price.toFixed(4)} (Pool: ${ethers.formatUnits(liquidity.usdcReserve, 6)} USDC, ${ethers.formatUnits(liquidity.kusdReserve, 18)} KUSD)`);

            // Calculate price deviation from peg
            const deviation = Math.abs(price - 1.0);
            const deviationPct = deviation * 100;

            // Check if deviation is worth arbitraging (must exceed minArbProfitPercentage)
            if (deviationPct < this.config.minArbProfitPercentage) {
                logger.debug(`Price deviation ${deviationPct.toFixed(3)}% < min profit threshold ${this.config.minArbProfitPercentage}%, skipping`);
                return { executed: false, profit: 0n };
            }

            // Calculate max safe trade size (% of pool)
            const maxSafeTradeSize = (liquidity.usdcReserve * BigInt(MAX_TRADE_PERCENT_OF_POOL)) / 100n;

            if (price > this.config.pegUpperLimit) {
                logger.info(`Price $${price.toFixed(4)} > ${this.config.pegUpperLimit}, deviation ${deviationPct.toFixed(2)}%, attempting arb (Mint KUSD -> Sell on DEX)`);
                return await this.arbHighPrice(price, maxSafeTradeSize);
            } else if (price < this.config.pegLowerLimit) {
                // Check if pocket has USDC for buyGem
                const pocketBalance = await this.getPocketBalance();
                if (pocketBalance === 0n) {
                    logger.warn('Cannot arb low price: PSM pocket has no USDC for buyGem redemption');
                    return { executed: false, profit: 0n };
                }
                logger.info(`Price $${price.toFixed(4)} < ${this.config.pegLowerLimit}, deviation ${deviationPct.toFixed(2)}%, attempting arb (Buy KUSD -> Redeem USDC). Pocket balance: ${ethers.formatUnits(pocketBalance, 6)} USDC`);
                return await this.arbLowPrice(price, maxSafeTradeSize, pocketBalance);
            }

            return { executed: false, profit: 0n };
        } catch (error: any) {
            logger.error('Error in PegKeeper check', { error: error.message, stack: error.stack });
            return { executed: false, profit: 0n };
        }
    }

    /**
     * Get pool reserves
     */
    private async getPoolLiquidity(): Promise<{ usdcReserve: bigint; kusdReserve: bigint }> {
        const reserves = await this.pair.getReserves();
        const reserve0 = BigInt(reserves[0]);
        const reserve1 = BigInt(reserves[1]);

        // gemIsToken0 tells us which reserve is USDC
        const usdcReserve = this.gemIsToken0 ? reserve0 : reserve1;
        const kusdReserve = this.gemIsToken0 ? reserve1 : reserve0;

        return { usdcReserve, kusdReserve };
    }

    /**
     * Get USDC balance in PSM pocket
     */
    private async getPocketBalance(): Promise<bigint> {
        if (!this.pocketAddress) return 0n;
        return BigInt(await this.gem!.balanceOf(this.pocketAddress));
    }

    /**
     * Get KUSD price using reserves directly (more accurate for small pools)
     */
    private async getKusdPrice(): Promise<number | null> {
        try {
            const liquidity = await this.getPoolLiquidity();

            if (liquidity.usdcReserve === 0n || liquidity.kusdReserve === 0n) {
                logger.warn('Pool has zero reserves, cannot determine price');
                return null;
            }

            // Normalize to same decimals for price calculation
            // USDC has 6 decimals, KUSD has 18 decimals
            // Price = USDC_reserve / KUSD_reserve (after normalizing)
            const usdcNormalized = Number(liquidity.usdcReserve) * 1e12; // Convert to 18 decimals
            const kusdNormalized = Number(liquidity.kusdReserve);

            const price = usdcNormalized / kusdNormalized;

            return price;
        } catch (error: any) {
            logger.error('Error getting KUSD price', { error: error.message });
            return null;
        }
    }

    private async arbHighPrice(_currentPrice: number, maxPoolTradeSize: bigint): Promise<{ executed: boolean; profit: bigint }> {
        // KUSD is expensive (> upper limit).
        // Strategy: Mint KUSD using USDC (PSM at 1:1) -> Sell KUSD for USDC on DEX (at premium)

        const gemBalance = BigInt(await this.gem!.balanceOf(this.wallet.address));
        if (gemBalance === 0n) {
            logger.warn('No USDC balance to perform arb');
            return { executed: false, profit: 0n };
        }

        // Use configurable max amount, capped by wallet balance and pool size limit
        const maxArbAmount = this.config.maxArbAmount;
        let amountIn = gemBalance > maxArbAmount ? maxArbAmount : gemBalance;

        // Also cap by pool liquidity limit
        if (amountIn > maxPoolTradeSize) {
            logger.info(`Capping trade to ${ethers.formatUnits(maxPoolTradeSize, 6)} USDC (${MAX_TRADE_PERCENT_OF_POOL}% of pool)`);
            amountIn = maxPoolTradeSize;
        }

        logger.info(`Arb HIGH: Using ${ethers.formatUnits(amountIn, 6)} USDC (max config: ${ethers.formatUnits(maxArbAmount, 6)}, max pool: ${ethers.formatUnits(maxPoolTradeSize, 6)}, balance: ${ethers.formatUnits(gemBalance, 6)})`);

        // Simulate the trade first to check profitability
        const kusdExpected = amountIn * BigInt(1e12); // 1:1 from PSM (USDC 6 decimals -> KUSD 18 decimals)

        // Get expected USDC out from DEX
        const path = [this.kusd!.target, this.gem!.target];
        const amountsOut = await this.router.getAmountsOut(kusdExpected, path);
        const expectedUsdcOut = BigInt(amountsOut[1]);

        // Calculate expected profit
        const expectedProfit = expectedUsdcOut - amountIn;
        const profitPct = (Number(expectedProfit) / Number(amountIn)) * 100;

        logger.info(`Simulated arb: ${ethers.formatUnits(amountIn, 6)} USDC -> ${ethers.formatUnits(kusdExpected, 18)} KUSD -> ${ethers.formatUnits(expectedUsdcOut, 6)} USDC (profit: ${profitPct.toFixed(3)}%)`);

        // Check if profit meets minimum threshold
        if (profitPct < this.config.minArbProfitPercentage) {
            logger.warn(`Expected profit ${profitPct.toFixed(3)}% < min threshold ${this.config.minArbProfitPercentage}%, skipping arb`);
            return { executed: false, profit: 0n };
        }

        if (expectedProfit <= 0n) {
            logger.warn('Arb would result in loss, skipping');
            return { executed: false, profit: 0n };
        }

        // Calculate minOut with slippage protection
        const slippageMultiplier = 1 - this.config.arbSlippageTolerance;
        const minOut = BigInt(Math.floor(Number(expectedUsdcOut) * slippageMultiplier));

        logger.info(`Executing arb with slippage protection: minOut = ${ethers.formatUnits(minOut, 6)} USDC`);

        // 1. Approve PSM to spend USDC
        await (await this.gem!.approve(this.psm.target, amountIn)).wait();

        // Get KUSD balance before minting
        const kusdBalanceBefore = BigInt(await this.kusd!.balanceOf(this.wallet.address));

        // 2. Sell Gem to PSM (Mint KUSD)
        const tx1 = await this.psm.sellGem(this.wallet.address, amountIn);
        await tx1.wait();

        // Get KUSD received (not total balance, in case wallet had pre-existing KUSD)
        const kusdBalanceAfter = BigInt(await this.kusd!.balanceOf(this.wallet.address));
        const kusdReceived = kusdBalanceAfter - kusdBalanceBefore;

        // 3. Approve Router to spend only what we received
        await (await this.kusd!.approve(this.router.target, kusdReceived)).wait();

        // 4. Swap KUSD -> USDC on DEX with slippage protection
        const tx2 = await this.router.swapExactTokensForTokens(
            kusdReceived,
            minOut,
            path,
            this.wallet.address,
            Math.floor(Date.now() / 1000) + 60
        );
        await tx2.wait();

        const newGemBalance = BigInt(await this.gem!.balanceOf(this.wallet.address));
        const actualProfit = newGemBalance - gemBalance;

        // Update cooldown timestamp
        this.lastArbTime = Date.now();

        logger.info(`✅ Arb HIGH executed. Profit: ${ethers.formatUnits(actualProfit, 6)} USDC. Cooldown started.`);
        return { executed: true, profit: actualProfit };
    }

    private async arbLowPrice(_currentPrice: number, maxPoolTradeSize: bigint, pocketBalance: bigint): Promise<{ executed: boolean; profit: bigint }> {
        // KUSD is cheap (< lower limit).
        // Strategy: Buy cheap KUSD on DEX -> Redeem for USDC at PSM (1:1)

        const gemBalance = BigInt(await this.gem!.balanceOf(this.wallet.address));
        if (gemBalance === 0n) {
            logger.warn('No USDC balance to perform arb');
            return { executed: false, profit: 0n };
        }

        // Use configurable max amount, capped by wallet balance, pool size, and pocket balance
        const maxArbAmount = this.config.maxArbAmount;
        let amountIn = gemBalance > maxArbAmount ? maxArbAmount : gemBalance;

        // Cap by pool liquidity limit
        if (amountIn > maxPoolTradeSize) {
            logger.info(`Capping trade to ${ethers.formatUnits(maxPoolTradeSize, 6)} USDC (${MAX_TRADE_PERCENT_OF_POOL}% of pool)`);
            amountIn = maxPoolTradeSize;
        }

        // Cap by pocket balance (we can only redeem what pocket has)
        if (amountIn > pocketBalance) {
            logger.info(`Capping trade to ${ethers.formatUnits(pocketBalance, 6)} USDC (pocket balance limit)`);
            amountIn = pocketBalance;
        }

        if (amountIn === 0n) {
            logger.warn('Trade amount reduced to 0 due to limits, skipping');
            return { executed: false, profit: 0n };
        }

        logger.info(`Arb LOW: Using ${ethers.formatUnits(amountIn, 6)} USDC (max config: ${ethers.formatUnits(maxArbAmount, 6)}, max pool: ${ethers.formatUnits(maxPoolTradeSize, 6)}, pocket: ${ethers.formatUnits(pocketBalance, 6)}, balance: ${ethers.formatUnits(gemBalance, 6)})`);

        // Simulate the trade first
        const pathBuy = [this.gem!.target, this.kusd!.target];
        const amountsOut = await this.router.getAmountsOut(amountIn, pathBuy);
        const expectedKusdOut = BigInt(amountsOut[1]);

        // Calculate how much USDC we can redeem from PSM
        const gemDecimals = await this.gem!.decimals();
        const conversion = 10n ** (18n - BigInt(gemDecimals));
        const tout = await this.psm.tout();
        const WAD = 10n ** 18n;
        const feeMultiplier = WAD + tout;
        const expectedGemOut = (expectedKusdOut * WAD) / (conversion * feeMultiplier);

        // Calculate expected profit
        const expectedProfit = expectedGemOut - amountIn;
        const profitPct = (Number(expectedProfit) / Number(amountIn)) * 100;

        logger.info(`Simulated arb: ${ethers.formatUnits(amountIn, 6)} USDC -> ${ethers.formatUnits(expectedKusdOut, 18)} KUSD -> ${ethers.formatUnits(expectedGemOut, 6)} USDC (profit: ${profitPct.toFixed(3)}%)`);

        // Check if profit meets minimum threshold
        if (profitPct < this.config.minArbProfitPercentage) {
            logger.warn(`Expected profit ${profitPct.toFixed(3)}% < min threshold ${this.config.minArbProfitPercentage}%, skipping arb`);
            return { executed: false, profit: 0n };
        }

        if (expectedProfit <= 0n) {
            logger.warn('Arb would result in loss, skipping');
            return { executed: false, profit: 0n };
        }

        // Calculate minOut for DEX swap with slippage protection
        const slippageMultiplier = 1 - this.config.arbSlippageTolerance;
        const minKusdOut = BigInt(Math.floor(Number(expectedKusdOut) * slippageMultiplier));

        logger.info(`Executing arb with slippage protection: minKusdOut = ${ethers.formatUnits(minKusdOut, 18)} KUSD`);

        // 1. Approve Router to spend USDC
        await (await this.gem!.approve(this.router.target, amountIn)).wait();

        // Get KUSD balance before swap
        const kusdBalanceBefore = BigInt(await this.kusd!.balanceOf(this.wallet.address));

        // 2. Swap USDC -> KUSD on DEX with slippage protection
        const tx1 = await this.router.swapExactTokensForTokens(
            amountIn,
            minKusdOut,
            pathBuy,
            this.wallet.address,
            Math.floor(Date.now() / 1000) + 60
        );
        await tx1.wait();

        // Get KUSD received (not total balance, in case wallet had pre-existing KUSD)
        const kusdBalanceAfter = BigInt(await this.kusd!.balanceOf(this.wallet.address));
        const kusdReceived = kusdBalanceAfter - kusdBalanceBefore;

        // 3. Approve PSM to spend only what we received
        await (await this.kusd!.approve(this.psm.target, kusdReceived)).wait();

        // 4. Calculate gem amount to redeem (accounting for fees)
        const gemAmtWithFee = (kusdReceived * WAD) / (conversion * feeMultiplier);

        // 5. Redeem KUSD for USDC via PSM
        const tx2 = await this.psm.buyGem(this.wallet.address, gemAmtWithFee);
        await tx2.wait();

        const newGemBalance = BigInt(await this.gem!.balanceOf(this.wallet.address));
        const actualProfit = newGemBalance - gemBalance;

        // Update cooldown timestamp
        this.lastArbTime = Date.now();

        logger.info(`✅ Arb LOW executed. Profit: ${ethers.formatUnits(actualProfit, 6)} USDC. Cooldown started.`);
        return { executed: true, profit: actualProfit };
    }
}
