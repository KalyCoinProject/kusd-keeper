import { loadConfig, validateConfig } from './config/config';
import { ContractService } from './services/ContractService';
import { PriceService } from './services/PriceService';
import { VaultMonitor } from './monitors/VaultMonitor';
import { AuctionMonitor } from './monitors/AuctionMonitor';
import { FlapMonitor } from './monitors/FlapMonitor';
import { FlopMonitor } from './monitors/FlopMonitor';
import { LiquidationExecutor } from './executors/LiquidationExecutor';
import { BiddingExecutor } from './executors/BiddingExecutor';
import { FlapExecutor } from './executors/FlapExecutor';
import { FlopExecutor } from './executors/FlopExecutor';
import { PegKeeperService } from './services/PegKeeperService';
import logger from './utils/logger';
import { KeeperHealth, KeeperConfig } from './types';

/**
 * Main KUSD Keeper class
 */
class KUSDKeeper {
  private config: KeeperConfig;
  private contractService: ContractService;
  private priceService: PriceService;
  private vaultMonitor: VaultMonitor;
  private auctionMonitor: AuctionMonitor;
  private flapMonitor: FlapMonitor;
  private flopMonitor: FlopMonitor;
  private liquidationExecutor: LiquidationExecutor;
  private biddingExecutor: BiddingExecutor;
  private flapExecutor: FlapExecutor;
  private flopExecutor: FlopExecutor;
  private pegKeeperService: PegKeeperService;
  private isRunning: boolean = false;
  private checkIntervalId?: NodeJS.Timeout;
  private health: KeeperHealth;

  constructor() {
    // Load and validate configuration
    this.config = loadConfig();
    validateConfig(this.config);

    // Initialize services
    this.contractService = new ContractService(this.config);
    this.priceService = new PriceService(
      this.contractService['provider'],
      this.config
    );
    this.vaultMonitor = new VaultMonitor(this.contractService, this.config);
    this.auctionMonitor = new AuctionMonitor(
      this.contractService,
      this.priceService,
      this.config
    );
    this.flapMonitor = new FlapMonitor(this.contractService);
    this.flopMonitor = new FlopMonitor(this.contractService);
    this.liquidationExecutor = new LiquidationExecutor(this.contractService, this.config);
    this.biddingExecutor = new BiddingExecutor(this.contractService, this.config);
    this.flapExecutor = new FlapExecutor(this.contractService);
    this.flopExecutor = new FlopExecutor(this.contractService);
    this.pegKeeperService = new PegKeeperService(this.contractService, this.config);

    // Initialize health status
    this.health = {
      isRunning: false,
      mode: this.config.mode,
      lastCheck: new Date(),
      vaultsMonitored: 0,
      activeAuctions: 0,
      liquidationsTriggered: 0,
      bidsExecuted: 0,
      totalProfit: 0n,
      pegArbsExecuted: 0,
      errors: 0,
    };

    logger.info('KUSD Keeper initialized', {
      mode: this.config.mode,
      keeper: this.contractService.getKeeperAddress(),
      checkInterval: this.config.checkInterval,
    });
  }

  /**
   * Start the keeper
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Keeper is already running');
      return;
    }

    logger.info('🚀 Starting KUSD Keeper...');

    try {
      // Start vault monitor
      await this.vaultMonitor.start();

      // Start auction monitor (if mode is 'full' or 'bid')
      if (this.config.mode === 'full' || this.config.mode === 'bid') {
        await this.auctionMonitor.start();
      }

      // Start Flap/Flop monitors
      await this.flapMonitor.start();
      await this.flopMonitor.start();

      // Initialize Peg Keeper (if mode is 'full' or 'peg' AND peg arb is enabled)
      if ((this.config.mode === 'full' || this.config.mode === 'peg') && this.config.enablePegArb) {
        await this.pegKeeperService.initialize();
        logger.info('Peg arbitrage enabled');
      } else if (this.config.mode === 'full' || this.config.mode === 'peg') {
        logger.info('Peg arbitrage disabled via ENABLE_PEG_ARB=false');
      }

      // Start periodic checks
      this.checkIntervalId = setInterval(async () => {
        await this.performCheck();
      }, this.config.checkInterval);

      // Perform initial check
      await this.performCheck();

      this.isRunning = true;
      this.health.isRunning = true;

      logger.info('✅ KUSD Keeper started successfully');
      logger.info(`Mode: ${this.config.mode}`);
      if (this.config.mode === 'full' || this.config.mode === 'kick') {
        logger.info('Monitoring vaults for liquidation opportunities...');
      }
      if (this.config.mode === 'full' || this.config.mode === 'bid') {
        logger.info('Monitoring auctions for bidding opportunities...');
      }
      logger.info('Monitoring Flap auctions (surplus)...');
      logger.info('Monitoring Flop auctions (debt)...');
      if (this.config.mode === 'full' || this.config.mode === 'peg') {
        logger.info('Monitoring KUSD Peg...');
      }
    } catch (error: any) {
      logger.error('Failed to start keeper', { error: error.message });
      throw error;
    }
  }

  /**
   * Stop the keeper
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn('Keeper is not running');
      return;
    }

    logger.info('Stopping KUSD Keeper...');

    // Stop periodic checks
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
    }

    // Stop monitors
    this.vaultMonitor.stop();
    if (this.config.mode === 'full' || this.config.mode === 'bid') {
      this.auctionMonitor.stop();
    }
    this.flapMonitor.stop();
    this.flopMonitor.stop();

    this.isRunning = false;
    this.health.isRunning = false;

    logger.info('KUSD Keeper stopped');
  }

  /**
   * Perform periodic check for liquidation and auction opportunities
   */
  private async performCheck(): Promise<void> {
    try {
      this.health.lastCheck = new Date();

      // Check for unsafe vaults (if mode is 'full' or 'kick')
      if (this.config.mode === 'full' || this.config.mode === 'kick') {
        logger.debug('Performing vault check...');

        const opportunities = await this.vaultMonitor.checkVaults();

        if (opportunities.length > 0) {
          logger.info(`Found ${opportunities.length} liquidation opportunities`);

          // Execute liquidations
          const results = await this.liquidationExecutor.executeLiquidations(opportunities);

          const successful = results.filter(r => r.success).length;
          logger.info(`Executed ${successful}/${opportunities.length} liquidations`);

          this.health.liquidationsTriggered = this.liquidationExecutor.getTotalLiquidations();
        } else {
          logger.debug('No liquidation opportunities found');
        }
      }

      // Check for auction opportunities (if mode is 'full' or 'bid')
      if (this.config.mode === 'full' || this.config.mode === 'bid') {
        logger.debug('Performing auction check...');

        const auctionOpportunities = await this.auctionMonitor.checkAuctions();

        if (auctionOpportunities.length > 0) {
          logger.info(`Found ${auctionOpportunities.length} profitable auctions`);

          // Execute bids
          const results = await this.biddingExecutor.executeBids(auctionOpportunities);

          const successful = results.filter(r => r.success).length;
          logger.info(`Executed ${successful}/${auctionOpportunities.length} bids`);

          this.health.bidsExecuted = this.biddingExecutor.getTotalBids();
          this.health.totalProfit = this.biddingExecutor.getTotalProfit();
        } else {
          logger.debug('No profitable auctions found');
        }

        this.health.activeAuctions = this.auctionMonitor.getActiveAuctionsCount();
      }

      // Check for Flap auction opportunities (surplus auctions)
      logger.debug('Checking Flap auctions...');
      const flapOpportunities = await this.flapMonitor.checkOpportunities();

      if (flapOpportunities.length > 0) {
        logger.info(`Found ${flapOpportunities.length} Flap auction opportunities`);

        // Execute profitable Flap bids
        for (const opportunity of flapOpportunities) {
          if (opportunity.profitable) {
            const result = await this.flapExecutor.executeBid(opportunity);
            if (result.success) {
              logger.info('Flap bid executed successfully', {
                id: opportunity.auction.id,
                txHash: result.transactionHash
              });
            }
          }
        }
      }

      // Check for Flop auction opportunities (debt auctions)
      logger.debug('Checking Flop auctions...');
      const flopOpportunities = await this.flopMonitor.checkOpportunities();

      if (flopOpportunities.length > 0) {
        logger.info(`Found ${flopOpportunities.length} Flop auction opportunities`);

        // Execute profitable Flop bids
        for (const opportunity of flopOpportunities) {
          if (opportunity.profitable) {
            const result = await this.flopExecutor.executeBid(opportunity);
            if (result.success) {
              logger.info('Flop bid executed successfully', {
                id: opportunity.auction.id,
                txHash: result.transactionHash
              });
            }
          }
        }
      }

      // Check Peg (if mode is 'full' or 'peg' AND peg arb is enabled)
      if ((this.config.mode === 'full' || this.config.mode === 'peg') && this.config.enablePegArb) {
        const result = await this.pegKeeperService.checkAndArbitrage();
        if (result.executed) {
          this.health.pegArbsExecuted++;
          this.health.totalProfit += result.profit;
        }
      }
    } catch (error: any) {
      this.health.errors++;
      logger.error('Error during check', { error: error.message });
    }
  }

  /**
   * Get keeper health status
   */
  getHealth(): KeeperHealth {
    return { ...this.health };
  }
}

/**
 * Main entry point
 */
async function main() {
  logger.info('='.repeat(60));
  logger.info('KUSD Keeper - Liquidation and Auction Bot');
  logger.info('='.repeat(60));

  const keeper = new KUSDKeeper();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    keeper.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    keeper.stop();
    process.exit(0);
  });

  // Start keeper
  await keeper.start();
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    logger.error('Fatal error', { error: error.message });
    process.exit(1);
  });
}

export default KUSDKeeper;

