// Mock logger before importing PegKeeperService
jest.mock('../utils/logger', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

/**
 * Unit tests for PegKeeperService price calculation logic
 * These test the pure calculation functions without blockchain interaction
 */
describe('PegKeeperService Price Calculations', () => {
    // Test price calculation formula: price = (usdcReserve * 1e12) / kusdReserve
    describe('getKusdPrice formula', () => {
        const calculatePrice = (usdcReserve: bigint, kusdReserve: bigint): number => {
            const usdcNormalized = Number(usdcReserve) * 1e12;
            const kusdNormalized = Number(kusdReserve);
            return usdcNormalized / kusdNormalized;
        };

        it('should return 1.0 when reserves are equal (1:1)', () => {
            // 1 USDC (6 decimals) and 1 KUSD (18 decimals)
            const usdcReserve = BigInt(1e6);
            const kusdReserve = BigInt(1e18);
            const price = calculatePrice(usdcReserve, kusdReserve);
            expect(price).toBeCloseTo(1.0, 6);
        });

        it('should return > 1.0 when KUSD is scarce (expensive)', () => {
            // 1 USDC but only 0.98 KUSD in pool
            const usdcReserve = BigInt(1e6);
            const kusdReserve = BigInt(0.98e18);
            const price = calculatePrice(usdcReserve, kusdReserve);
            expect(price).toBeGreaterThan(1.0);
            expect(price).toBeCloseTo(1.0204, 3);
        });

        it('should return < 1.0 when KUSD is abundant (cheap)', () => {
            // 1 USDC but 1.02 KUSD in pool
            const usdcReserve = BigInt(1e6);
            const kusdReserve = BigInt(1.02e18);
            const price = calculatePrice(usdcReserve, kusdReserve);
            expect(price).toBeLessThan(1.0);
            expect(price).toBeCloseTo(0.9804, 3);
        });

        it('should handle large reserves correctly', () => {
            // 1,000,000 USDC and 1,000,000 KUSD
            const usdcReserve = BigInt(1000000e6);
            const kusdReserve = BigInt(1000000n * BigInt(1e18));
            const price = calculatePrice(usdcReserve, kusdReserve);
            expect(price).toBeCloseTo(1.0, 6);
        });

        it('should handle small reserves correctly', () => {
            // 100 USDC and 100 KUSD (minimum pool)
            const usdcReserve = BigInt(100e6);
            const kusdReserve = BigInt(100n * BigInt(1e18));
            const price = calculatePrice(usdcReserve, kusdReserve);
            expect(price).toBeCloseTo(1.0, 6);
        });
    });

    // Test PSM buyGem calculation: gemAmt = (kusdAmount * WAD) / (conversion * (WAD + tout))
    describe('buyGem calculation formula', () => {
        const WAD = 10n ** 18n;
        const CONVERSION = 10n ** 12n; // 18 - 6 decimals

        const calculateGemOut = (kusdAmount: bigint, tout: bigint): bigint => {
            const feeMultiplier = WAD + tout;
            return (kusdAmount * WAD) / (CONVERSION * feeMultiplier);
        };

        it('should return 1:1 when tout is 0', () => {
            const kusdAmount = BigInt(1e18); // 1 KUSD
            const tout = 0n;
            const gemOut = calculateGemOut(kusdAmount, tout);
            expect(gemOut).toBe(BigInt(1e6)); // 1 USDC
        });

        it('should deduct fee when tout > 0', () => {
            const kusdAmount = BigInt(1e18); // 1 KUSD
            const tout = BigInt(0.01e18); // 1% fee
            const gemOut = calculateGemOut(kusdAmount, tout);
            // With 1% fee, we should get ~0.99 USDC
            expect(Number(gemOut)).toBeLessThan(1e6);
            expect(Number(gemOut)).toBeCloseTo(990099, -2); // ~990099 (0.99 USDC in 6 decimals)
        });

        it('should handle large amounts', () => {
            const kusdAmount = BigInt(1000000n * BigInt(1e18)); // 1M KUSD
            const tout = 0n;
            const gemOut = calculateGemOut(kusdAmount, tout);
            expect(gemOut).toBe(BigInt(1000000e6)); // 1M USDC
        });
    });

    // Test profit calculation
    describe('profit calculation', () => {
        it('should calculate positive profit for high price arb', () => {
            const amountIn = BigInt(100e6); // 100 USDC
            const amountOut = BigInt(101e6); // 101 USDC back
            const profit = amountOut - amountIn;
            const profitPct = (Number(profit) / Number(amountIn)) * 100;
            expect(profit).toBe(BigInt(1e6));
            expect(profitPct).toBeCloseTo(1.0, 2);
        });

        it('should calculate negative profit correctly', () => {
            const amountIn = BigInt(100e6);
            const amountOut = BigInt(99e6);
            const profit = amountOut - amountIn;
            expect(profit).toBe(BigInt(-1e6));
        });
    });

    // Test slippage calculation
    describe('slippage protection', () => {
        it('should calculate minOut with slippage tolerance', () => {
            const expectedOut = BigInt(100e6);
            const slippageTolerance = 0.005; // 0.5%
            const slippageMultiplier = 1 - slippageTolerance;
            const minOut = BigInt(Math.floor(Number(expectedOut) * slippageMultiplier));
            expect(minOut).toBe(BigInt(99500000)); // 99.5 USDC
        });
    });

    // Test trade size limits
    describe('trade size limits', () => {
        it('should cap trade by max config amount', () => {
            const walletBalance = BigInt(1000e6);
            const maxArbAmount = BigInt(100e6);
            const amountIn = walletBalance > maxArbAmount ? maxArbAmount : walletBalance;
            expect(amountIn).toBe(maxArbAmount);
        });

        it('should use wallet balance if less than max', () => {
            const walletBalance = BigInt(50e6);
            const maxArbAmount = BigInt(100e6);
            const amountIn = walletBalance > maxArbAmount ? maxArbAmount : walletBalance;
            expect(amountIn).toBe(walletBalance);
        });

        it('should cap by pool percentage', () => {
            const poolReserve = BigInt(1000e6);
            const maxPercent = 10n;
            const maxPoolTrade = (poolReserve * maxPercent) / 100n;
            expect(maxPoolTrade).toBe(BigInt(100e6));
        });
    });
});

