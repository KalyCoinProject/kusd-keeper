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
    'function kusd() external view returns (address)'
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



export class PegKeeperService {
    private psm: ethers.Contract;
    private router: ethers.Contract;
    private gem: ethers.Contract | null = null;
    private kusd: ethers.Contract | null = null;
    private wallet: ethers.Wallet;
    private config: KeeperConfig;
    private lastArbTime: number = 0; // Track last arb execution time for cooldown

    constructor(contractService: ContractService, config: KeeperConfig) {
        this.config = config;
        this.wallet = contractService['wallet']; // Accessing protected wallet

        if (!config.psmAddress || !config.dexRouterAddress || !config.dexPairAddress) {
            throw new Error('Missing Peg Keeper configuration (PSM, Router, or Pair address)');
        }

        this.psm = new ethers.Contract(config.psmAddress, PSM_ABI, this.wallet);
        this.router = new ethers.Contract(config.dexRouterAddress, ROUTER_ABI, this.wallet);

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
        this.gem = new ethers.Contract(gemAddress, ERC20_ABI, this.wallet);
        this.kusd = new ethers.Contract(kusdAddress, ERC20_ABI, this.wallet);
        logger.info('PegKeeperService initialized', { gem: gemAddress, kusd: kusdAddress });
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

            const price = await this.getKusdPrice();
            logger.debug(`Current KUSD Price: $${price.toFixed(4)}`);

            // Calculate price deviation from peg
            const deviation = Math.abs(price - 1.0);
            const deviationPct = deviation * 100;

            // Check if deviation is worth arbitraging (must exceed minArbProfitPercentage)
            if (deviationPct < this.config.minArbProfitPercentage) {
                logger.debug(`Price deviation ${deviationPct.toFixed(3)}% < min profit threshold ${this.config.minArbProfitPercentage}%, skipping`);
                return { executed: false, profit: 0n };
            }

            if (price > this.config.pegUpperLimit) {
                logger.info(`Price $${price.toFixed(4)} > ${this.config.pegUpperLimit}, deviation ${deviationPct.toFixed(2)}%, attempting arb (Mint KUSD -> Sell on DEX)`);
                return await this.arbHighPrice(price);
            } else if (price < this.config.pegLowerLimit) {
                logger.info(`Price $${price.toFixed(4)} < ${this.config.pegLowerLimit}, deviation ${deviationPct.toFixed(2)}%, attempting arb (Buy KUSD -> Redeem USDC)`);
                return await this.arbLowPrice(price);
            }

            return { executed: false, profit: 0n };
        } catch (error: any) {
            logger.error('Error in PegKeeper check', { error: error.message });
            return { executed: false, profit: 0n };
        }
    }

    private async getKusdPrice(): Promise<number> {
        // Determine which token is KUSD in the pair
        // const token0 = await this.pair.token0();
        // const reserves = await this.pair.getReserves();

        // Assuming 18 decimals for both for simplicity in this calculation, 
        // but strictly we should check decimals. 
        // KUSD is 18 decimals. USDC is usually 6.

        // const kusdIsToken0 = token0.toLowerCase() === this.kusd!.target.toString().toLowerCase();

        // const r0 = BigInt(reserves[0]);
        // const r1 = BigInt(reserves[1]);

        // We need to normalize decimals to get a price.
        // Let's use the router to get a more accurate "market price" for 1 USDC
        const gemDecimals = await this.gem!.decimals();
        const oneGem = ethers.parseUnits('1', gemDecimals);

        // Path: GEM -> KUSD
        const path = [this.gem!.target, this.kusd!.target];
        const amounts = await this.router.getAmountsOut(oneGem, path);
        const kusdOut = amounts[1]; // Amount of KUSD for 1 GEM (USDC)

        // If 1 USDC buys 1.02 KUSD, then KUSD price is ~ $0.98 (Low)
        // If 1 USDC buys 0.98 KUSD, then KUSD price is ~ $1.02 (High)

        // Price of KUSD in USDC = 1 / (KUSD received for 1 USDC)
        const kusdReceived = parseFloat(ethers.formatUnits(kusdOut, 18));
        const price = 1 / kusdReceived;

        return price;
    }

    private async arbHighPrice(_currentPrice: number): Promise<{ executed: boolean; profit: bigint }> {
        // KUSD is expensive (> upper limit).
        // Strategy: Mint KUSD using USDC (PSM at 1:1) -> Sell KUSD for USDC on DEX (at premium)

        const gemBalance = BigInt(await this.gem!.balanceOf(this.wallet.address));
        if (gemBalance === 0n) {
            logger.warn('No USDC balance to perform arb');
            return { executed: false, profit: 0n };
        }

        // Use configurable max amount, capped by wallet balance
        const maxArbAmount = this.config.maxArbAmount;
        const amountIn = gemBalance > maxArbAmount ? maxArbAmount : gemBalance;

        logger.info(`Arb HIGH: Using ${ethers.formatUnits(amountIn, 6)} USDC (max: ${ethers.formatUnits(maxArbAmount, 6)}, balance: ${ethers.formatUnits(gemBalance, 6)})`);

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

        // 2. Sell Gem to PSM (Mint KUSD)
        const tx1 = await this.psm.sellGem(this.wallet.address, amountIn);
        await tx1.wait();

        // Get actual KUSD balance after minting
        const kusdBalance = BigInt(await this.kusd!.balanceOf(this.wallet.address));

        // 3. Approve Router to spend KUSD
        await (await this.kusd!.approve(this.router.target, kusdBalance)).wait();

        // 4. Swap KUSD -> USDC on DEX with slippage protection
        const tx2 = await this.router.swapExactTokensForTokens(
            kusdBalance,
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

    private async arbLowPrice(_currentPrice: number): Promise<{ executed: boolean; profit: bigint }> {
        // KUSD is cheap (< lower limit).
        // Strategy: Buy cheap KUSD on DEX -> Redeem for USDC at PSM (1:1)

        const gemBalance = BigInt(await this.gem!.balanceOf(this.wallet.address));
        if (gemBalance === 0n) {
            logger.warn('No USDC balance to perform arb');
            return { executed: false, profit: 0n };
        }

        // Use configurable max amount, capped by wallet balance
        const maxArbAmount = this.config.maxArbAmount;
        const amountIn = gemBalance > maxArbAmount ? maxArbAmount : gemBalance;

        logger.info(`Arb LOW: Using ${ethers.formatUnits(amountIn, 6)} USDC (max: ${ethers.formatUnits(maxArbAmount, 6)}, balance: ${ethers.formatUnits(gemBalance, 6)})`);

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

        // 2. Swap USDC -> KUSD on DEX with slippage protection
        const tx1 = await this.router.swapExactTokensForTokens(
            amountIn,
            minKusdOut,
            pathBuy,
            this.wallet.address,
            Math.floor(Date.now() / 1000) + 60
        );
        await tx1.wait();

        // Get actual KUSD balance
        const kusdBalance = BigInt(await this.kusd!.balanceOf(this.wallet.address));

        // 3. Approve PSM to spend KUSD
        await (await this.kusd!.approve(this.psm.target, kusdBalance)).wait();

        // 4. Calculate gem amount to redeem (accounting for fees)
        const gemAmtWithFee = (kusdBalance * WAD) / (conversion * feeMultiplier);

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
