# KUSD Keeper Setup Guide

Complete guide to set up and run the KUSD Keeper on KalyChain. Follow these steps to start earning by helping maintain the KUSD stablecoin system.

## Prerequisites

- **Node.js** >= 18.0.0 (recommended: use [nvm](https://github.com/nvm-sh/nvm))
- **npm** (comes with Node.js)
- **A dedicated wallet** with private key (never use your main wallet!)
- **Capital** depending on what services you run (see below)

## Step 1: Clone the Repository

```bash
git clone https://github.com/KalyCoinProject/kusd-keeper.git
cd kusd-keeper
```

## Step 2: Install Dependencies

```bash
npm install
```

## Step 3: Create Your Keeper Wallet

**Important:** Create a NEW wallet specifically for keeper operations. Never use your main wallet.

```bash
# Generate a new wallet (or use your preferred method)
# Save the private key securely!
```

Fund your keeper wallet with:
- **KLC** — for gas fees (0.1+ KLC recommended)
- **USDC** — for peg arbitrage (if enabled)
- **KUSD** — for peg arbitrage and auction bidding (if needed)

## Step 4: Configure Environment

```bash
cp .env.example .env
nano .env  # or use your preferred editor
```

### Required Settings

```env
# Your keeper wallet private key (WITHOUT 0x prefix)
PRIVATE_KEY=your_64_character_hex_private_key

# Network (testnet or mainnet)
RPC_URL=https://testnetrpc.kalychain.io/rpc
CHAIN_ID=3889
NETWORK=testnet
```

### Peg Arbitrage Settings (Main Earning Opportunity)

```env
# Enable/disable peg arbitrage
ENABLE_PEG_ARB=true

# DEX addresses (KalySwap)
DEX_ROUTER_ADDRESS=0x...  # KalySwap router
DEX_PAIR_ADDRESS=0x...    # KUSD/USDC pair on KalySwap

# PSM address
PSM_ADDRESS=0x3c7cd619652181560169321c94a7ade274b60e38

# Trading limits
MAX_ARB_AMOUNT=10000000          # Max USDC per trade (6 decimals = 10 USDC)
MIN_ARB_PROFIT_PERCENTAGE=0.5    # Only trade if profit > 0.5%
ARB_SLIPPAGE_TOLERANCE=0.005     # 0.5% slippage protection
ARB_COOLDOWN_MS=300000           # 5 min cooldown between trades
MAX_TRADE_PERCENT_OF_POOL=10     # Max 10% of pool per trade
```

### Peg Limits (When to Arbitrage)

```env
PEG_LOWER_LIMIT=0.995   # Below this = KUSD is cheap, buy and redeem
PEG_UPPER_LIMIT=1.005   # Above this = KUSD is expensive, mint and sell
```

### Liquidation & Auction Settings

```env
MODE=full                        # full, kick, or bid
MIN_PROFIT_PERCENTAGE=5          # Min profit for auction bids
CHECK_INTERVAL=30000             # Check every 30 seconds
MAX_COLLATERAL_PER_AUCTION=1000000  # Max USD exposure per auction
```

## Step 5: Test Your Configuration

```bash
npm run monitor
```

This checks:
- ✅ RPC connection to KalyChain
- ✅ Wallet balance (KLC, USDC, KUSD)
- ✅ Contract connectivity
- ✅ Configuration validity

## Step 6: Run in Development (Testing)

```bash
npm run dev
```

Watch the logs to ensure everything works. You should see:
- Connection to RPC
- Wallet address and balances
- Monitoring for opportunities

## Step 7: Build for Production

```bash
npm run build
```

## Step 8: Deploy with PM2 (Production)

PM2 keeps your keeper running 24/7 and auto-restarts on crashes.

### Install PM2

```bash
npm install -g pm2
```

### Start Keeper

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Auto-start on system boot
```

### Monitor

```bash
pm2 status              # Check status
pm2 logs kusd-keeper    # View logs
pm2 monit               # Real-time monitoring
```

### Manage

```bash
pm2 restart kusd-keeper   # Restart after config changes
pm2 stop kusd-keeper      # Stop keeper
pm2 delete kusd-keeper    # Remove from PM2
```

---

## Understanding the Keeper Modes

### Full Mode (Recommended)
```env
MODE=full
```
Runs all keeper services: liquidations, auction bidding, and peg arbitrage.

### Kick Only Mode
```env
MODE=kick
```
Only triggers liquidations. Requires only KLC for gas.

### Bid Only Mode
```env
MODE=bid
```
Only bids on existing auctions. Requires KUSD in Vat.

---

## Capital Requirements by Service

### Peg Arbitrage (Easiest to Start)

| Asset | Purpose | Recommended |
|-------|---------|-------------|
| KLC | Gas fees | 0.1+ KLC |
| USDC | Buy KUSD when cheap | 100+ USDC |
| KUSD | Sell when expensive | 100+ KUSD |

The keeper needs both USDC and KUSD because it trades in both directions:
- **KUSD < $1**: Buy KUSD on DEX → Redeem at PSM for USDC
- **KUSD > $1**: Mint KUSD at PSM with USDC → Sell on DEX

### Liquidation Triggering

| Asset | Purpose | Recommended |
|-------|---------|-------------|
| KLC | Gas fees | 0.1+ KLC |

Each liquidation costs ~0.001 KLC and earns 100 KUSD + 2% of debt.

### Auction Bidding

| Asset | Purpose | Recommended |
|-------|---------|-------------|
| KLC | Gas fees | 0.1+ KLC |
| KUSD | Bid on auctions | 10,000+ KUSD |

KUSD must be deposited into the Vat (internal accounting system).

---

## How the PSM Pocket Works

The PSM (Peg Stability Module) uses a **shared pocket** controlled by the DAO:

```
┌─────────────────────────────────────────────────────────────────┐
│                    PSM Pocket (DAO Treasury)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   sellGem (USDC → KUSD):                                        │
│   Your USDC ────────────────────────► Pocket gets USDC          │
│   You get KUSD ◄───────────────────── PSM mints KUSD            │
│                                                                  │
│   buyGem (KUSD → USDC):                                         │
│   Your KUSD ────────────────────────► PSM burns KUSD            │
│   You get USDC ◄───────────────────── Pocket sends USDC         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key points:**
- All keepers share the same PSM pocket
- You don't need to fund the pocket yourself
- Competition is expected — first transaction wins
- If your tx fails, another keeper probably beat you (this is normal)

---

## Troubleshooting

### Peg arbitrage not executing

**Check pool liquidity:**
- The DEX pool needs sufficient KUSD/USDC liquidity
- `MAX_TRADE_PERCENT_OF_POOL` limits trade size relative to pool

**Check your balances:**
- Need both USDC and KUSD for bidirectional trading
- Need KLC for gas

**Check profit threshold:**
```env
MIN_ARB_PROFIT_PERCENTAGE=0.5  # Lower if needed (but watch for fees)
```

### "Insufficient pocket balance" error

The PSM pocket doesn't have enough USDC for `buyGem`. This means:
- Many keepers have been redeeming KUSD → USDC
- Wait for `sellGem` activity to refill the pocket
- Or the DAO needs to deposit more USDC

### Transaction reverts with "slippage"

Price moved between simulation and execution. Increase tolerance:
```env
ARB_SLIPPAGE_TOLERANCE=0.01  # 1% instead of 0.5%
```

### "Another keeper beat me"

This is normal and expected! The system is designed for competition.
- First transaction wins
- Your simulation was correct, but someone was faster
- Keep running — you'll win some, lose some

### Keeper not detecting opportunities

**Check price feed:**
- Verify DEX pair address is correct
- Check that the pool has liquidity

**Check peg limits:**
```env
PEG_LOWER_LIMIT=0.995   # Trigger when KUSD < $0.995
PEG_UPPER_LIMIT=1.005   # Trigger when KUSD > $1.005
```

### RPC connection issues

```bash
# Test RPC
curl -X POST https://testnetrpc.kalychain.io/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

---

## Security Best Practices

1. **Use a dedicated keeper wallet** — Never your main wallet
2. **Never commit `.env`** — It contains your private key
3. **Start small** — Test with small amounts first
4. **Monitor logs** — Watch for errors and unexpected behavior
5. **Keep dependencies updated** — Run `npm audit` periodically
6. **Secure your server** — Use SSH keys, firewall, fail2ban

---

## Mainnet Deployment Checklist

Before moving to mainnet:

- [ ] Tested successfully on testnet for 24+ hours
- [ ] Verified all contract addresses for mainnet
- [ ] Funded keeper wallet with appropriate capital
- [ ] Set conservative limits (lower trade sizes initially)
- [ ] Configured monitoring/alerts
- [ ] Have a plan for emergency stop if needed

**Mainnet RPC:**
```env
RPC_URL=https://rpc.kalychain.io/rpc
CHAIN_ID=3888
NETWORK=mainnet
```

---

## Getting Help

- **Logs:** `pm2 logs kusd-keeper`
- **Health check:** `npm run monitor`
- **GitHub Issues:** Report bugs or ask questions
- **Documentation:** [docs.kalychain.io/kusd](https://docs.kalychain.io/kusd)

