/**
 * @fileoverview Relayer service for WaffleFinance cross-chain operations
 * @description Monitors Ethereum events and coordinates Stellar transactions
 */

import { loadRelayerConfig } from '@wafflefinance/config/node';
import { resolveEthereumRpcUrl } from '@wafflefinance/config';
import { resolve } from 'path';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ethers } from 'ethers';
import { getLogger } from './logger.js';

const logger = getLogger();
import { startRefundWatchdog } from './services/refund-watchdog.js';
import { refundXlmToUser, HorizonTimeoutError } from './services/xlm-refund.js';
import { globalRefundLedger } from './services/refund-ledger.js';
import { globalStellarProofLedger } from './services/stellar-proof-ledger.js';
import { globalSettlementFailureStore } from './services/settlement-failure-store.js';
import {
  classifyFailureCategory,
  ETH_BALANCE_RETRY,
  ETH_SEND_RETRY,
  ETH_CONFIRM_RETRY,
  HORIZON_VERIFY_RETRY,
} from './services/settlement-retry-policy.js';
import { globalRetryEngine, RetryExhaustedError } from './utils/retry-engine.js';
import {
  verifyIncomingStellarPayment,
  StellarTxNotFoundError,
  StellarTxFailedError,
  StellarPaymentMismatch,
} from './services/horizon-verifier.js';
import { requireAdminAuth } from './middleware/admin-auth.js';
import { startContractEventPoller, type ContractEventBinding, type ContractEventPollerHandle } from './listeners/contract-event-poller.js';
import { startAdaptivePoll, type AdaptivePollHandle } from './utils/adaptive-poll.js';
import { fetchIncomingEthPayments } from './listeners/eth-incoming-monitor.js';
import {
  expireAbandonedOrders,
  hasAwaitingXlmPayment,
  hasPendingRelayerEscrow,
  needsChainMonitoring,
} from './utils/order-poll-utils.js';
import {
  configureSitePresence,
  hasRecentVisitor,
  markVisitorPresent,
} from './utils/site-presence.js';

// Load and validate config using our shared package
const parsedRelayerConfig = loadRelayerConfig();

// Γ£à NETWORK-AWARE Dynamic Safety Deposit Helper Function
function calculateDynamicSafetyDeposit(amountInWei: string | bigint, networkMode?: string): bigint {
  const ETH_USD_PRICE = 3500; // $3500 per ETH
  const amountInEth = parseFloat(ethers.formatEther(amountInWei.toString()));
  const amountInUsd = amountInEth * ETH_USD_PRICE;
  
  // Γ£à Your preferred dynamic calculation
  let safetyDepositInEth: number;
  if (amountInUsd <= 50) {
    safetyDepositInEth = 0.00005; // min
  } else if (amountInUsd <= 100) {
    safetyDepositInEth = 0.0001;
  } else if (amountInUsd <= 500) {
    safetyDepositInEth = 0.0002;
  } else if (amountInUsd <= 1000) {
    safetyDepositInEth = 0.0005;
  } else {
    safetyDepositInEth = Math.min(0.002, amountInEth * 0.01); // max cap
  }
  
  const originalSafetyDeposit = safetyDepositInEth;
  
  // Γ£à NETWORK-AWARE CONTRACT MINIMUMS
  const isTestnet = networkMode === 'testnet' || DEFAULT_NETWORK_MODE === 'testnet';
  
  if (isTestnet) {
    // TESTNET: Enforce 0.01 ETH minimum (EscrowFactory.sol requirement)
    const TESTNET_MIN_SAFETY_DEPOSIT = 0.01;
    safetyDepositInEth = Math.max(safetyDepositInEth, TESTNET_MIN_SAFETY_DEPOSIT);
    
    logger.info(`≡ƒ¢í∩╕Å TESTNET SAFETY DEPOSIT:
    ≡ƒôè Amount: ${amountInEth} ETH (~$${amountInUsd.toFixed(2)})
    ≡ƒÆí Dynamic calculation: ${originalSafetyDeposit} ETH
    Γ£à Testnet minimum applied: ${safetyDepositInEth} ETH
    ≡ƒôï Testnet requires minimum: ${TESTNET_MIN_SAFETY_DEPOSIT} ETH`);
  } else {
    // MAINNET: Use pure dynamic calculation (no forced minimum)
    logger.info(`≡ƒ¢í∩╕Å MAINNET SAFETY DEPOSIT:
    ≡ƒôè Amount: ${amountInEth} ETH (~$${amountInUsd.toFixed(2)})
    ≡ƒÆí Dynamic calculation: ${originalSafetyDeposit} ETH
    Γ£à Final amount (no forced minimum): ${safetyDepositInEth} ETH
    ≡ƒÄ» Mainnet uses dynamic tiers only`);
  }
  
  return ethers.parseEther(safetyDepositInEth.toString());
}

// Network Configuration
const NETWORK_CONFIG = {
  testnet: {
    ethereum: {
      chainId: 11155111, // Sepolia
      escrowFactory: '0x0ABa862Da2F004bCa6ce2990EbC0f77184B6d3a8', // NEW: Fresh EscrowFactory
      htlcBridge: '0x3f42E2F5D4C896a9CB62D0128175180a288de38A', // NEW: Fresh HTLCBridge
    },
    stellar: {
      networkPassphrase: 'Test SDF Network ; September 2015',
      horizonUrl: 'https://horizon-testnet.stellar.org',
    }
  },
  mainnet: {
    ethereum: {
      chainId: 1, // Ethereum Mainnet
      escrowFactory: '0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a', // 1inch Factory
      htlcBridge: '0x87372d4bba85acf7c2374b4719a1020e507ab73e', // MainnetHTLC (DEPLOYED!)
    },
    stellar: {
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      horizonUrl: 'https://horizon.stellar.org',
    }
  }
};

// Determine current network from environment (default)
const DEFAULT_NETWORK_MODE = parsedRelayerConfig.network;

// Dynamic network config getter
function getNetworkConfig(networkMode?: string): any {
  const selectedNetwork = networkMode || DEFAULT_NETWORK_MODE;
  return NETWORK_CONFIG[selectedNetwork] || NETWORK_CONFIG[DEFAULT_NETWORK_MODE];
}



logger.info(`≡ƒîÉ Default Network Mode: ${DEFAULT_NETWORK_MODE.toUpperCase()}`);
logger.info(`≡ƒÅ¡ Default Escrow Factory: ${getNetworkConfig().ethereum.escrowFactory}`);

// Real HTLC Bridge Contract ABI  
const HTLC_BRIDGE_ABI = [
  "function createOrder(address token, uint256 amount, bytes32 hashLock, uint256 timelock, uint256 feeRate, address beneficiary, address refundAddress, uint256 destinationChainId, bytes32 stellarTxHash, bool partialFillEnabled) external payable returns (uint256 orderId)"
];

// MAINNET: GER├çEK 1inch EscrowFactory ABI (verdi─ƒin ABI'dan)
const MAINNET_ESCROW_FACTORY_ABI = [
  `function createDstEscrow(
    (bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) dstImmutables,
    uint256 srcCancellationTimestamp
  ) external payable`,
  "function addressOfEscrowSrc((bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) immutables) external view returns (address)",
  "function addressOfEscrowDst((bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) immutables) external view returns (address)",
  "function ESCROW_SRC_IMPLEMENTATION() external view returns (address)",
  "function ESCROW_DST_IMPLEMENTATION() external view returns (address)",
  "function availableCredit(address account) external view returns (uint256)",
  "function increaseAvailableCredit(address account, uint256 amount) external returns (uint256 allowance)",
  "function decreaseAvailableCredit(address account, uint256 amount) external returns (uint256 allowance)",
  
  // Events
  "event DstEscrowCreated(address escrow, bytes32 hashlock, uint256 taker)",
  "event SrcEscrowCreated((bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) srcImmutables, (uint256 maker, uint256 amount, uint256 token, uint256 safetyDeposit, uint256 chainId) dstImmutablesComplement)"
];

// TESTNET: Bizim custom EscrowFactory ABI (eski hali)
const TESTNET_ESCROW_FACTORY_ABI = [
  "function createEscrow((address token, uint256 amount, bytes32 hashLock, uint256 timelock, address beneficiary, address refundAddress, uint256 safetyDeposit, uint256 chainId, bytes32 stellarTxHash, bool isPartialFillEnabled) config) external payable returns (uint256 escrowId)",
  "function fundEscrow(uint256 escrowId) external",
  "function claimEscrow(uint256 escrowId, bytes32 preimage) external",
  "function refundEscrow(uint256 escrowId) external",
  "function getEscrow(uint256 escrowId) external view returns (tuple(address escrowAddress, tuple(address token, uint256 amount, bytes32 hashLock, uint256 timelock, address beneficiary, address refundAddress, uint256 safetyDeposit, uint256 chainId, bytes32 stellarTxHash, bool isPartialFillEnabled) config, uint8 status, uint256 createdAt, uint256 filledAmount, uint256 safetyDepositPaid, address resolver, bool isActive))",
  "function authorizeResolver(address resolver) external",
  "function authorizedResolvers(address resolver) external view returns (bool)",
  "function totalEscrows() external view returns (uint256)",
  "function MIN_SAFETY_DEPOSIT() external view returns (uint256)",
  "function MAX_SAFETY_DEPOSIT() external view returns (uint256)",
  // Events
  "event EscrowCreated(uint256 indexed escrowId, address indexed escrowAddress, address indexed resolver, address token, uint256 amount, bytes32 hashLock, uint256 timelock, uint256 safetyDeposit, uint256 chainId)",
  "event EscrowFunded(uint256 indexed escrowId, address indexed funder, uint256 amount, uint256 safetyDeposit)",
  "event EscrowClaimed(uint256 indexed escrowId, address indexed claimer, uint256 amount, bytes32 preimage)",
  "event EscrowRefunded(uint256 indexed escrowId, address indexed refundee, uint256 amount, uint256 safetyDeposit)"
];

// Dinamik ABI se├ºici
function getEscrowFactoryABI(isMainnet: boolean) {
  return isMainnet ? MAINNET_ESCROW_FACTORY_ABI : TESTNET_ESCROW_FACTORY_ABI;
}
import { ethereumListener } from './listeners/ethereum-listener.js';
import { gasPriceTracker } from './services/gas-tracker.js';



// Stellar SDK will be imported dynamically when needed

// Phase 8: Monitoring System imports
import { getMonitor } from './services/monitoring.js';
import { logSolanaStatus } from './utils/solana-config.js';
import {
  buildSupportPolicy,
  decideOrderRoute,
  logSupportPolicy,
  supportSummary,
} from './support.js';
import {
  authorizeSettlementCommand,
  checkOrderSettleable,
  formatAuthorizationLog,
  type SettlementAccountConfig,
} from './settlement-permissions.js';
import { assertSupportPolicy, SupportPolicyValidationError } from '@wafflefinance/config';
import {
  solanaPlaceholderMode,
  settlementVerificationTotal,
  settlementProofReplaysTotal,
  orderIngestionTotal,
  orderQueueDepth,
  relayDecisionTotal,
  submissionLatencySeconds,
  receiptLatencySeconds,
  retryAttemptsHistogram,
  droppedOrdersTotal,
  chainDelayGauge,
} from './metrics.js';

// Contract addresses
const ETH_TO_XLM_RATE = 10000; // 1 ETH = 10,000 XLM (LEGACY - now using real-time prices)
// Network-aware contract addresses  
const HTLC_CONTRACT_ADDRESS = getHtlcBridgeAddress(); // Dynamic: testnet/mainnet

// Real-time price fetching with two-tier in-memory cache.
//
// CoinGecko's free public API is aggressive about rate limits (~10-30 calls/min
// per IP), so we cannot hit it on every quote. But a flat 60s cache feels
// stale in a crypto UX ΓÇö most DEX aggregators refresh visible prices every
// 10-20s. We split the difference with a stale-while-revalidate (SWR) cache:
//
//   - Within FRESH_MS (15s): serve cached data, no upstream call.
//   - Within STALE_MS (60s): serve cached data immediately AND kick off a
//     background refresh so the next caller gets a fresher snapshot.
//   - Past STALE_MS: callers wait for a fresh fetch (de-duped via inflight
//     promise so a burst of swaps doesn't fan out to multiple CoinGecko calls).
//
// Net effect: the UI feels live (refreshes within ~15s of any user activity)
// while CoinGecko calls stay bounded to at most one every ~15s under load.
// Crucially, both the frontend quote and the relayer's settlement use this
// same cache, so the price a user is quoted matches the price they settle at
// for the duration of a single cache window.
interface PriceSnapshot {
  xlmUsdPrice: number;
  ethUsdPrice: number;
  ethToXlmRate: number;
  fetchedAt: number;
  source: 'coingecko' | 'fallback' | 'cache';
}

const PRICE_CACHE_FRESH_MS = 15_000;
const PRICE_CACHE_STALE_MS = 60_000;
let cachedPrices: PriceSnapshot | null = null;
let inflightPriceFetch: Promise<PriceSnapshot> | null = null;

async function fetchPricesFromCoinGecko(): Promise<PriceSnapshot> {
  const fallback: PriceSnapshot = {
    xlmUsdPrice: 0.12,
    ethUsdPrice: 3500,
    ethToXlmRate: 3500 / 0.12,
    fetchedAt: Date.now(),
    source: 'fallback',
  };

  try {
    const priceResponse = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=stellar,ethereum&vs_currencies=usd'
    );
    if (!priceResponse.ok) {
      logger.warn({ value: priceResponse.status }, 'ΓÜá∩╕Å CoinGecko API non-OK:');
      return fallback;
    }
    const priceData = await priceResponse.json() as any;
    const xlmUsdPrice = priceData.stellar?.usd;
    const ethUsdPrice = priceData.ethereum?.usd;
    if (typeof xlmUsdPrice !== 'number' || typeof ethUsdPrice !== 'number' || xlmUsdPrice <= 0 || ethUsdPrice <= 0) {
      logger.warn('ΓÜá∩╕Å CoinGecko returned malformed prices, using fallback');
      return fallback;
    }
    logger.info({ xlmUsdPrice, ethUsdPrice }, '≡ƒôè Real-time prices fetched from CoinGecko:');
    return {
      xlmUsdPrice,
      ethUsdPrice,
      ethToXlmRate: ethUsdPrice / xlmUsdPrice,
      fetchedAt: Date.now(),
      source: 'coingecko',
    };
  } catch (priceError: any) {
    logger.warn({ value: priceError?.message }, 'ΓÜá∩╕Å Price fetch failed, using fallback prices:');
    return fallback;
  }
}

function triggerBackgroundRefresh(): void {
  if (inflightPriceFetch) return;
  inflightPriceFetch = fetchPricesFromCoinGecko()
    .then((snapshot) => {
      cachedPrices = snapshot;
      return snapshot;
    })
    .catch((err) => {
      // SWR background refresh; keep the stale entry. We log so an outage is
      // visible but never propagate the error to the caller serving stale.
      logger.warn({ err: err?.message ?? err }, '[price] background price refresh failed; keeping stale entry');
      return cachedPrices ?? {
        xlmUsdPrice: 0.12,
        ethUsdPrice: 3500,
        ethToXlmRate: 3500 / 0.12,
        fetchedAt: Date.now(),
        source: 'fallback' as const,
      };
    })
    .finally(() => {
      inflightPriceFetch = null;
    });
}

async function getPriceSnapshot(): Promise<PriceSnapshot> {
  const now = Date.now();

  if (cachedPrices) {
    const age = now - cachedPrices.fetchedAt;
    if (age < PRICE_CACHE_FRESH_MS) {
      // Fully fresh ΓÇö serve cached, do nothing else.
      return { ...cachedPrices, source: 'cache' };
    }
    if (age < PRICE_CACHE_STALE_MS) {
      // Stale-but-acceptable ΓÇö serve cached, refresh in background so the
      // next caller sees fresher data without blocking this one.
      triggerBackgroundRefresh();
      return { ...cachedPrices, source: 'cache' };
    }
  }

  // No cache or beyond STALE ΓÇö must block on a fresh fetch. De-dupe concurrent
  // callers so a burst of swap requests collapses into a single CoinGecko hit.
  if (!inflightPriceFetch) {
    inflightPriceFetch = fetchPricesFromCoinGecko()
      .then((snapshot) => {
        cachedPrices = snapshot;
        return snapshot;
      })
      .finally(() => {
        inflightPriceFetch = null;
      });
  }
  return inflightPriceFetch;
}

async function getRealTimePrices(): Promise<{xlmUsdPrice: number, ethUsdPrice: number, ethToXlmRate: number}> {
  const snapshot = await getPriceSnapshot();
  return {
    xlmUsdPrice: snapshot.xlmUsdPrice,
    ethUsdPrice: snapshot.ethUsdPrice,
    ethToXlmRate: snapshot.ethToXlmRate,
  };
}

// Dynamic contract address getters
function getEscrowFactoryAddress(networkMode?: string): string {
  return getNetworkConfig(networkMode).ethereum.escrowFactory;
}

function getHtlcBridgeAddress(networkMode?: string): string {
  return getNetworkConfig(networkMode).ethereum.htlcBridge;
}

// New function to determine which contract to use based on operation type
function shouldUseHTLCContract(networkMode?: string): boolean {
  const config = getNetworkConfig(networkMode);
  const selectedNetwork = networkMode || DEFAULT_NETWORK_MODE;
  
  // Γ£à BOTH MAINNET AND TESTNET: Always use EscrowFactory
  // HTLC only for Stellar side (non-EVM) and XLMΓåÆETH orders
  return false; // Always use EscrowFactory for ETHΓåÆXLM transactions
}

function parseCsv(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    })
  ]);
}

function resolveEthereumRpcUrlForRelayer(): string {
  const network = DEFAULT_NETWORK_MODE === 'mainnet' ? 'mainnet' : 'testnet';
  return resolveEthereumRpcUrl(network);
}

// Relayer configuration from environment variables
export const RELAYER_CONFIG = {
  ...parsedRelayerConfig,
  ethereum: {
    ...parsedRelayerConfig.ethereum,
    contractAddress: getHtlcBridgeAddress(DEFAULT_NETWORK_MODE), // For EthereumEventListener (testnet only)
    escrowFactoryAddress: getEscrowFactoryAddress(DEFAULT_NETWORK_MODE), // For transactions (mainnet + testnet)
  }
};

import { validateRelayerStartup, formatStartupErrors } from './config-validator.js';

// Validate required environment variables
function validateConfig() {
  const errors = validateRelayerStartup(process.env as Record<string, string | undefined>, {
    ethereumPrivateKey: RELAYER_CONFIG.ethereum.privateKey,
    stellarSecretKey: RELAYER_CONFIG.stellar.secretKey,
  });

  if (errors.length > 0) {
    throw new Error(
      `Relayer startup validation failed — ${errors.length} misconfiguration(s) found:\n` +
      formatStartupErrors(errors) + '\n' +
      'Fix all of the above before starting the relayer.'
    );
  }
}

// ---------------------------------------------------------------------------
// Settlement retry helper
// ---------------------------------------------------------------------------

/**
 * Wrap a settlement action with the global RetryEngine and automatically
 * record every failure attempt in the SettlementFailureStore.
 *
 * On every failure (including the retried ones) the store is updated with:
 *   - the structured FailureCategory derived from the error
 *   - the direction and chain
 *
 * On eventual success after at least one prior failure the store is updated
 * to `recovered` and the txHash is stamped for the audit trail.
 *
 * On terminal failure (RetryExhaustedError or a terminal fault class) the
 * store stays in `failed` / `pending` state so the admin endpoint surfaces it.
 *
 * @param action    RetryEngine action namespace (e.g. 'eth-send', 'horizon-verify').
 * @param opts      RunOptions from the settlement-retry-policy constants.
 * @param fn        The async operation to execute.
 * @param meta      Contextual info recorded in the failure store.
 */
async function runWithSettlementRetry<T>(
  action: string,
  opts: import('./utils/retry-engine.js').RunOptions,
  fn: () => Promise<T>,
  meta: {
    orderId: string;
    direction: string;
    chain: 'ethereum' | 'stellar' | 'unknown';
    recoveredTxHash?: (result: T) => string | undefined;
  },
): Promise<T> {
  // Mark recovery in progress if this order has had prior failures.
  if (globalSettlementFailureStore.hasFailed(meta.orderId)) {
    globalSettlementFailureStore.markRecovering(meta.orderId);
  }

  try {
    const result = await globalRetryEngine.run(action, fn, opts);

    // Success after a prior failure → mark recovered.
    if (globalSettlementFailureStore.hasFailed(meta.orderId)) {
      const txHash = meta.recoveredTxHash?.(result) ?? '';
      globalSettlementFailureStore.markRecovered(meta.orderId, txHash);
    }

    return result;
  } catch (err: unknown) {
    // Record the failure with full category classification.
    const category = classifyFailureCategory(err, meta.chain);
    const errorMessage = err instanceof Error ? err.message : String(err);
    globalSettlementFailureStore.recordFailure({
      orderId: meta.orderId,
      direction: meta.direction,
      category,
      errorMessage,
      chain: meta.chain,
      recoveryAction: `RetryEngine exhausted for action=${action}`,
    });
    throw err;
  }
}

// Initialize relayer service
async function initializeRelayer() {
  logger.info('≡ƒöä Initializing WaffleFinance Relayer Service');
  logger.info('============================================');
  
  // Configure Express middleware with enhanced CORS
  app.use(cors({
    origin: [
      'http://localhost:5173', 
      'http://localhost:5174', 
      'http://127.0.0.1:5173', 
      'http://127.0.0.1:5174',
      'https://wafflefinance.vercel.app',
      'https://wafflefinance.vercel.app/'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  
  // Validate configuration
  validateConfig();

  // Detect Solana placeholder mode and expose as a metric so operators see
  // an explicit warning when Solana settlement is not yet configured.
  const solanaProgram =
    process.env.SOLANA_HTLC_PROGRAM ??
    process.env.SOLANA_HTLC_PROGRAM_TESTNET ??
    process.env.SOLANA_HTLC_PROGRAM_MAINNET;
  const solanaStatus = logSolanaStatus(solanaProgram);
  solanaPlaceholderMode.set(solanaStatus === 'placeholder' ? 1 : 0);

  // ── Support policy ────────────────────────────────────────────────────────
  //
  // validateConfig() above proves the required env vars are present and not
  // placeholders.  It does not establish that this deployment can carry a
  // bridge leg end to end.  The policy states that explicitly, drives the route
  // checks in POST /api/orders/create below, and is served from GET
  // /api/support.  A relayer that cannot carry any route refuses to start
  // rather than accepting orders it can never settle.
  const supportPolicy = buildSupportPolicy(RELAYER_CONFIG, solanaProgram);
  try {
    assertSupportPolicy(supportPolicy);
  } catch (err) {
    if (err instanceof SupportPolicyValidationError) {
      logger.error('🚨 Relayer support policy is invalid — refusing to start:');
      for (const problem of err.errors) {
        logger.error(`   [${problem.code}] ${problem.message}`);
      }
      process.exit(1);
    }
    throw err;
  }
  logSupportPolicy(supportPolicy);

  // Display configuration
  logger.info(`≡ƒîÉ Environment: ${RELAYER_CONFIG.nodeEnv}`);
  logger.info(`≡ƒöù Ethereum Network: ${RELAYER_CONFIG.ethereum.network}`);
  logger.info(`Γ¡É Stellar Network: ${RELAYER_CONFIG.stellar.network}`);
  logger.info(`≡ƒÅâ Mock Mode: ${RELAYER_CONFIG.enableMockMode ? 'Enabled' : 'Disabled'}`);
  logger.info(`≡ƒôè Port: ${RELAYER_CONFIG.port}`);
  logger.info(`ΓÅ▒∩╕Å  Poll Interval: ${RELAYER_CONFIG.pollInterval}ms`);
  
  if (RELAYER_CONFIG.security.emergencyShutdown) {
    logger.error('≡ƒÜ¿ Emergency shutdown is active - service will not start');
    process.exit(1);
  }
  
  if (RELAYER_CONFIG.security.maintenanceMode) {
    logger.warn('≡ƒöº Maintenance mode is active');
  }

  // Global order storage (in production this would be a database).
  // Declared early so chain pollers can skip RPC when nothing is in flight.
  const activeOrders = new Map<string, any>();
  const chainPollers: AdaptivePollHandle[] = [];
  let escrowFactoryPoller: ContractEventPollerHandle | null = null;
  let chainMonitoringStarted = false;
  let chainMonitoringPromise: Promise<void> | null = null;

  const wakeChainPollers = (): void => {
    if (!chainMonitoringStarted) return;
    ethereumListener.wakePolling();
    escrowFactoryPoller?.wake();
    for (const poller of chainPollers) {
      poller.wake();
    }
  };

  const storeActiveOrder = async (
    orderId: string,
    orderData: Record<string, unknown>
  ): Promise<void> => {
    activeOrders.set(orderId, orderData);
    // Keep the queue-depth gauge current after every successful store.
    orderQueueDepth.set(activeOrders.size);
    if (!needsChainMonitoring(activeOrders)) return;
    await ensureChainMonitoring();
    wakeChainPollers();
  };

  const stopChainMonitoring = async (): Promise<void> => {
    if (!chainMonitoringStarted) return;
    logger.info('≡ƒÆñ Stopping chain monitoring ΓÇö no in-flight orders');
    for (const poller of chainPollers) poller.stop();
    chainPollers.length = 0;
    escrowFactoryPoller?.stop();
    escrowFactoryPoller = null;
    try {
      await ethereumListener.stopListening();
    } catch {
      /* already stopped */
    }
    chainMonitoringStarted = false;
    chainMonitoringPromise = null;
  };

  const reconcileChainMonitoring = (): void => {
    const expired = expireAbandonedOrders(activeOrders);
    if (expired > 0) {
      logger.info(`ΓÅ▒∩╕Å Expired ${expired} abandoned pre-deposit order(s)`);
    }
    if (chainMonitoringStarted && !needsChainMonitoring(activeOrders)) {
      void stopChainMonitoring();
    }
  };

  setInterval(reconcileChainMonitoring, 60_000);

  configureSitePresence(RELAYER_CONFIG.visitorTtlMs);

  /** Marks a browser session ΓÇö does not touch Infura until a swap order exists. */
  const handleVisitorWake = (): void => {
    markVisitorPresent();
    wakeChainPollers();
  };

  let ensureChainMonitoring: () => Promise<void> = async () => {
    if (chainMonitoringStarted) return;
    if (!chainMonitoringPromise) {
      chainMonitoringPromise = (async () => {
        chainMonitoringStarted = true;
        await startChainMonitoring();
      })().catch((err) => {
        chainMonitoringStarted = false;
        chainMonitoringPromise = null;
        throw err;
      });
    }
    await chainMonitoringPromise;
  };

  let startChainMonitoring: () => Promise<void> = async () => {};
  
  // Start gas price tracking
  try {
    gasPriceTracker.startMonitoring(30000); // Monitor every 30 seconds
    logger.info('Γ¢╜ Gas price tracking started');
  } catch (error) {
    logger.error({ err: error }, 'Γ¥î Failed to start gas price tracking:');
  }

  // Start monitoring system
  try {
    const monitor = getMonitor();
    monitor.registerService('ethereum', async () => ({ status: 'healthy' }));
    monitor.registerService('stellar', async () => ({ status: 'healthy' }));
    monitor.registerService('gas-tracker', async () => ({ status: 'healthy' }));
    monitor.registerService('orders', async () => ({ status: 'healthy' }));
    monitor.startMonitoring(30000); // Monitor every 30 seconds
    logger.info('≡ƒôè Uptime monitoring started');
  } catch (error) {
    logger.error({ err: error }, 'Γ¥î Failed to start monitoring system:');
  }

  // Chain listeners start lazily on the first swap order ΓÇö not at boot.
  // See `startChainMonitoring` below (zero Infura RPC while idle).

  // ===== ORDERS API ENDPOINTS =====
  
  // Γ£à Network-aware contract logging
  logger.info(`≡ƒîÉ Network Mode: ${DEFAULT_NETWORK_MODE.toUpperCase()}`);
  if (DEFAULT_NETWORK_MODE === 'mainnet') {
    logger.info({ value: getEscrowFactoryAddress('mainnet') }, '≡ƒÅ¡ MAINNET Escrow Factory:');
    logger.info({ value: getHtlcBridgeAddress('mainnet') }, '≡ƒÄ» MAINNET HTLC (XLMΓåÆETH only):');
  } else {
    logger.info({ value: getHtlcBridgeAddress('testnet') }, '≡ƒº¬ TESTNET HTLC Bridge (Event Listener):');
    logger.info({ value: getEscrowFactoryAddress('testnet') }, '≡ƒº¬ TESTNET Escrow Factory:');
  }

  // DEBUG: Simple transaction test
  // In production (NODE_ENV=production) this endpoint is gated behind admin
  // auth to prevent information leakage. In all other environments it remains
  // accessible without auth for developer convenience.
  const testTransactionHandler = (_req: any, res: any) => {
    res.json({
      success: true,
      approvalTransaction: {
        to: '0x742d35cF0b7bbF6E175239d74a0e0a3d1C7B87E4',  // Simple relayer address
        value: '0x71afd498d0000',  // 0.001 ETH
        data: '0x',
        gas: '0x5208',  // Standard ETH transfer gas
        gasPrice: '0x4a817c800'
      },
      message: 'DEBUG: Simple transaction format'
    });
  };
  if (process.env.NODE_ENV === 'production') {
    app.get('/api/test-transaction', requireAdminAuth(), testTransactionHandler);
  } else {
    app.get('/api/test-transaction', testTransactionHandler);
  }

  // POST /api/orders/create - Create bridge order (Frontend Integration)
  logger.info("≡ƒôì DEBUG: About to register orders endpoint");
  
  // Prometheus metrics endpoint ΓÇö no sensitive data exposed.
  const { metricsRouter } = await import('./routes/metrics.js');
  app.use(metricsRouter());

  // Liveness health endpoint for orchestrators and monitoring.
  const { healthRouter } = await import('./routes/health.js');
  app.use(healthRouter());

  // Root route first
  app.get('/', (req, res) => {
    res.json({ message: 'WaffleFinance Relayer API', status: 'running' });
  });
  
  // Simple test endpoints — gated behind admin auth in production.
  app.get('/test', (req, res) => {
    res.json({ message: 'ROOT test working!', timestamp: new Date().toISOString() });
  });
  if (process.env.NODE_ENV === 'production') {
    app.get('/api/test', requireAdminAuth(), (_req, res) => {
      res.json({ message: 'API endpoints are working!', timestamp: new Date().toISOString() });
    });
  } else {
    app.get('/api/test', (_req, res) => {
      res.json({ message: 'API endpoints are working!', timestamp: new Date().toISOString() });
    });
  }

  // Frontend calls this on page load ΓÇö marks a browser session only.
  // Infura RPC starts on the first swap order, not on wake.
  app.post('/api/wake', (_req, res) => {
    handleVisitorWake();
    res.status(204).end();
  });
  app.get('/api/wake', (_req, res) => {
    handleVisitorWake();
    res.status(204).end();
  });

  // Debug: verify lazy monitoring + stuck orders (operator-only — requires auth).
  app.get('/api/debug/chain-monitor', requireAdminAuth(), (_req, res) => {
    reconcileChainMonitoring();
    const statuses: Record<string, number> = {};
    for (const order of activeOrders.values()) {
      const s = String(order?.status ?? 'unknown');
      statuses[s] = (statuses[s] ?? 0) + 1;
    }
    res.json({
      chainMonitoringStarted,
      needsChainMonitoring: needsChainMonitoring(activeOrders),
      activeOrderCount: activeOrders.size,
      hasRecentVisitor: hasRecentVisitor(),
      orderStatuses: statuses,
      build: 'lazy-chain-monitor-v2',
    });
  });

  // GET /api/prices
  //
  // Public, cached price feed used by the frontend to render accurate quote
  // estimates *and* by external monitoring. We intentionally proxy CoinGecko
  // through the relayer for two reasons:
  //   1. The browser cannot call CoinGecko directly (CORS), so a previous
  //      build silently fell back to a hardcoded 1 ETH = 10,000 XLM rate.
  //      That diverged from what the relayer actually settled at swap time,
  //      so users were quoted ~3x more XLM than they ended up receiving.
  //   2. Centralizing the fetch lets us cache (PRICE_CACHE_TTL_MS) and protect
  //      ourselves from CoinGecko's rate limits ΓÇö a high-traffic page would
  //      otherwise blow through the free quota.
  app.get('/api/prices', async (_req, res) => {
    try {
      const snapshot = await getPriceSnapshot();
      res.json({
        xlmUsd: snapshot.xlmUsdPrice,
        ethUsd: snapshot.ethUsdPrice,
        ethPerXlm: snapshot.xlmUsdPrice / snapshot.ethUsdPrice,
        xlmPerEth: snapshot.ethToXlmRate,
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt,
        // SWR window ΓÇö UI can hint to users when a refresh is due.
        cacheFreshMs: PRICE_CACHE_FRESH_MS,
        cacheStaleMs: PRICE_CACHE_STALE_MS,
      });
    } catch (err: any) {
      res.status(503).json({
        error: 'Price feed temporarily unavailable',
        details: err?.message ?? String(err),
      });
    }
  });

  // GET /api/support
  //
  // Publishes the relayer's declared capabilities: which chains and actions are
  // available, which routes it will carry, and which chain pairs it will refuse
  // together with the reason.  Operators and the frontend can read what the
  // runtime actually supports instead of inferring it from a failed swap.
  // Returns 503 when no route is available, so "running but useless" is visible
  // to monitoring.
  app.get('/api/support', (_req, res) => {
    const summary = supportSummary(supportPolicy);
    res.status(summary.actionable ? 200 : 503).json(summary);
  });

  logger.info('≡ƒôì DEBUG: Test endpoints registered (root + api)');
  logger.info('≡ƒôì DEBUG: Now registering transaction history endpoint...');

  // POST /api/transactions/history - RIGHT NEXT TO WORKING ENDPOINT
  app.post('/api/transactions/history', async (req, res) => {
    logger.info('≡ƒÄ» TRANSACTION HISTORY ENDPOINT HIT - NEXT TO ORDERS!');
    try {
      const { ethAddress, stellarAddress } = req.body;
      
      logger.info({ ethAddress, stellarAddress }, '≡ƒôè Fetching transaction history for:');
      
      // Get all orders from activeOrders Map  
      const allOrders = Array.from(activeOrders.values());
      logger.info({ value: allOrders.length }, '≡ƒôè Total orders in activeOrders:');
      
      // Filter orders by user addresses and format for history
      const userTransactions = allOrders
        .filter(order => 
          (ethAddress && order.ethAddress === ethAddress) ||
          (stellarAddress && order.stellarAddress === stellarAddress)
        )
        .map(order => ({
          id: order.orderId,
          txHash: order.ethTxHash || order.stellarTxHash || order.orderId,
          fromNetwork: order.direction === 'eth-to-xlm' ? 
            (DEFAULT_NETWORK_MODE === 'mainnet' ? 'ETH Mainnet' : 'ETH Sepolia') : 
            (DEFAULT_NETWORK_MODE === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet'),
          toNetwork: order.direction === 'eth-to-xlm' ? 
            (DEFAULT_NETWORK_MODE === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet') : 
            (DEFAULT_NETWORK_MODE === 'mainnet' ? 'ETH Mainnet' : 'ETH Sepolia'),
          fromToken: order.direction === 'eth-to-xlm' ? 'ETH' : 'XLM',
          toToken: order.direction === 'eth-to-xlm' ? 'XLM' : 'ETH',
          amount: order.amount || '0',
          estimatedAmount: order.targetAmount ? 
            (parseFloat(order.targetAmount) / 1e18).toFixed(6) : '0',
          status: order.status === 'completed' ? 'completed' : 
                 order.status === 'failed' ? 'failed' :
                 order.status === 'cancelled' ? 'cancelled' : 'pending',
          timestamp: order.timestamp || Date.now(),
          ethTxHash: order.ethTxHash,
          stellarTxHash: order.stellarTxHash,
          direction: order.direction
        }))
        .sort((a, b) => b.timestamp - a.timestamp);
      
      logger.info(`≡ƒôè Found ${userTransactions.length} matching transactions for user`);
      
      res.json({
        success: true,
        transactions: userTransactions,
        count: userTransactions.length
      });
      
    } catch (error: any) {
      logger.error({ err: error }, 'Γ¥î Transaction history fetch failed:');
      res.status(500).json({
        error: 'Failed to fetch transaction history',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  app.post('/api/orders/create', async (req, res) => {
    try {
      logger.debug({ body: req.body }, '[orders/create] raw request body');
      
      const { fromChain, toChain, fromToken, toToken, amount, ethAddress, stellarAddress, direction, exchangeRate, network, networkMode } = req.body;
      
      logger.info({
        amount: amount,
        amountType: typeof amount,
        amountLength: amount ? amount.length : 'undefined',
        amountString: String(amount)
      }, '≡ƒÄ» EXTRACTED VALUES:');
      
      // Validate required fields
      if (!fromChain || !toChain || !fromToken || !toToken || !amount || !ethAddress || !stellarAddress) {
        logger.info({
          fromChain: !!fromChain,
          toChain: !!toChain, 
          fromToken: !!fromToken,
          toToken: !!toToken,
          amount: !!amount,
          ethAddress: !!ethAddress,
          stellarAddress: !!stellarAddress
        }, 'Γ¥î VALIDATION FAILED:');
        return res.status(400).json({
          error: 'Missing required fields',
          required: ['fromChain', 'toChain', 'fromToken', 'toToken', 'amount', 'ethAddress', 'stellarAddress']
        });
      }

      // ── Route capability check ──────────────────────────────────────────
      //
      // Until now `fromChain` / `toChain` were required to be present and then
      // ignored: the handler branched on `direction` alone, so a request naming
      // an unsupported source chain was accepted and settled against Ethereum
      // anyway.  The support policy is consulted here — before any escrow is
      // encoded, any secret generated, or any order stored — so an unsupported
      // chain, a contradictory chain/direction pair, or an asset class the
      // relayer cannot move is refused while nothing is at stake.

      // ── Pipeline metric: ingestion ────────────────────────────────────
      // Count every request that reaches the policy boundary (after basic
      // HTTP parsing but before any business-logic check).
      const ingestDirection = typeof direction === 'string' ? direction : 'unknown';
      orderIngestionTotal.inc({ direction: ingestDirection });

      const routeDecision = decideOrderRoute(supportPolicy, {
        direction,
        fromChain,
        toChain,
        fromToken,
      });
      if (!routeDecision.supported) {
        relayDecisionTotal.inc({ direction: ingestDirection, result: 'rejected_route' });
        logger.warn(
          `🚫 Order rejected [${routeDecision.code}]: ${routeDecision.reason}`
        );
        return res.status(400).json({
          error: 'Unsupported route',
          code: routeDecision.code,
          details: routeDecision.reason,
          supported: supportSummary(supportPolicy).routes.map((r) => r.id),
        });
      }
      logger.info(
        `✅ Route ${routeDecision.from}→${routeDecision.to} ` +
        `(${routeDecision.tokenClass}) is supported`
      );

      // ── Settlement-permission check ─────────────────────────────────────
      //
      // The route-capability check above confirmed the policy supports this
      // chain pair. The settlement-permission check goes one level deeper: it
      // verifies that BOTH the lock (source leg) and settle (destination leg)
      // commands can actually execute — i.e. that the signing keys and contract
      // addresses for each chain are present and non-placeholder.
      //
      // This catches a partially-configured deployment (e.g. Ethereum key
      // present but Stellar secret missing) before any escrow is encoded,
      // any secret generated, or any order stored.
      const settlementDenial = checkOrderSettleable(
        supportPolicy,
        RELAYER_CONFIG as SettlementAccountConfig,
        direction
      );
      if (settlementDenial) {
        relayDecisionTotal.inc({ direction: ingestDirection, result: 'rejected_permissions' });
        logger.warn(
          `🚫 Settlement permission denied [${settlementDenial.code}]: ${settlementDenial.reason}`
        );
        return res.status(403).json({
          error: 'settlement_permission_denied',
          code: settlementDenial.code,
          details: settlementDenial.reason,
          command: settlementDenial.command,
          chain: settlementDenial.chain,
        });
      }
      logger.info(`✅ Settlement permissions granted for direction "${direction}"`);

      // ── Pipeline metrics: accepted + queue depth + submission timer ──
      relayDecisionTotal.inc({ direction: ingestDirection, result: 'accepted' });
      // Start the submission latency timer — stopped when the response is
      // sent so all branches (mock, testnet, mainnet, xlm-to-eth success/fail)
      // are captured without needing individual stop calls in every branch.
      const submissionTimer = submissionLatencySeconds.startTimer({ direction: ingestDirection });
      res.on('finish', () => {
        const result = res.statusCode < 400 ? 'success' : 'failure';
        submissionTimer({ result });
      });

      logger.info({
        direction,
        fromChain,
        toChain,
        fromToken,
        toToken,
        amount,
        exchangeRate: exchangeRate || ETH_TO_XLM_RATE,
        ethAddress,
        stellarAddress
      }, '≡ƒîë Creating bridge order:');

      // Normalize addresses to avoid checksum issues
      const normalizedEthAddress = ethAddress.toLowerCase();

      // Generate order ID
      const orderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      
      // Dynamic network detection from request or fallback to env
      const requestNetwork = networkMode || network || (req.query.network) || DEFAULT_NETWORK_MODE;
      const isMainnetRequest = requestNetwork === 'mainnet';
      
      logger.info({
        requestNetwork,
        queryParam: req.query.network,
        bodyNetworkMode: networkMode,
        bodyNetwork: network,
        envDefault: DEFAULT_NETWORK_MODE,
        finalDecision: isMainnetRequest ? 'MAINNET' : 'TESTNET'
      }, `≡ƒîÉ Network Detection:`);
      
      // FORCE DEBUG: Always log this
      logger.info({
        'networkMode': networkMode,
        'network': network,
        'req.query.network': req.query.network,
        'DEFAULT_NETWORK_MODE': DEFAULT_NETWORK_MODE,
        'requestNetwork': requestNetwork,
        'isMainnetRequest': isMainnetRequest,
        'WILL_GO_TO': isMainnetRequest ? 'MAINNET_BRANCH' : 'TESTNET_BRANCH'
      }, `≡ƒöì CRITICAL DEBUG:`);
      
      // For ETH to XLM direction
      if (direction === 'eth_to_xlm') {
        
        if (isMainnetRequest) {
          // MAINNET: Use DUAL CONTRACT APPROACH (1inch EscrowFactory + MainnetHTLC)
          const useHTLC = shouldUseHTLCContract('mainnet');
          logger.info(`≡ƒÅ¡ MAINNET: Using ${useHTLC ? 'HTLC + EscrowFactory' : 'EscrowFactory only'} approach...`);

          // MOCK MODE for ETHΓåÆXLM
          if (RELAYER_CONFIG.enableMockMode) {
            logger.info('≡ƒº¬ MOCK MODE: Simulating ETHΓåÆXLM mainnet escrow creation...');
            
            const userAmountWei = ethers.parseEther(amount);
            const secret = ethers.hexlify(ethers.randomBytes(32));
            const hashLock = ethers.keccak256(secret);
            
            const orderData = {
              orderId,
              direction: 'eth_to_xlm',
              amount: userAmountWei.toString(),
              ethAddress: normalizedEthAddress,
              stellarAddress,
              exchangeRate: exchangeRate || ETH_TO_XLM_RATE,
              secret,
              hashLock,
              created: new Date().toISOString(),
              status: 'mock_escrow_created',
              contractType: 'MOCK_1INCH_ESCROW_FACTORY'
            };
            
            await storeActiveOrder(orderId, orderData);
            
            return res.json({
              success: true,
              orderId,
              orderData,
              message: '≡ƒº¬ MOCK: ETHΓåÆXLM escrow created',
              nextStep: 'Mock: User MetaMask transaction',
              instructions: [
                '≡ƒº¬ MOCK MODE: No real transactions',
                '1. Mock 1inch EscrowFactory createDstEscrow called',
                '2. Mock safety deposit and escrow creation',
                '3. Mock Stellar HTLC creation for XLM delivery'
              ],
              ethereum: {
                contractAddress: getEscrowFactoryAddress('mainnet'),
                method: 'createDstEscrow',
                amount: amount + ' ETH',
                hashLock
              },
              stellar: {
                htlcId: `mock-stellar-htlc-${Date.now()}`,
                amount: (parseFloat(amount) * ETH_TO_XLM_RATE).toFixed(7) + ' XLM', // Mock mode uses legacy rate
                hashLock
              }
            });
          }
          
          // Get REAL-TIME exchange rates from market for ETHΓåÆXLM
        const realTimePrices = await getRealTimePrices();
        const { xlmUsdPrice, ethUsdPrice, ethToXlmRate } = realTimePrices;

        // amount is already a string like "0.00012", convert to wei
        const userAmountWei = ethers.parseEther(amount);
        logger.info(`≡ƒÆ░ User Amount: ${amount} ETH = ${userAmountWei.toString()} wei`);
        
        // Calculate real XLM amount from ETH using market prices
        const ethAmount = parseFloat(amount);
        const realMarketXlmAmount = (ethAmount * ethUsdPrice) / xlmUsdPrice;
        
        logger.info({
          ethAmount,
          ethUsdPrice: `$${ethUsdPrice}`,
          xlmUsdPrice: `$${xlmUsdPrice}`,
          realMarketRate: `1 ETH = ${realMarketXlmAmount.toFixed(2)} XLM`,
          ethTotalValue: `$${(ethAmount * ethUsdPrice).toFixed(4)}`,
          xlmAmount: `${realMarketXlmAmount.toFixed(7)} XLM`,
          xlmTotalValue: `$${(realMarketXlmAmount * xlmUsdPrice).toFixed(4)}`
        }, '[orders/create] ETH-to-XLM real market exchange rate');
        
        // Generate HTLC parameters for cross-chain bridge
        const secretBytes = new Uint8Array(32);
        crypto.getRandomValues(secretBytes);
        const secret = `0x${Array.from(secretBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
        const hashLock = ethers.keccak256(secret);
        
        logger.info({
          secret: '[REDACTED]',
          hashLock: hashLock
        }, '≡ƒöæ Generated HTLC parameters:');
        
        // Calculate dynamic safety deposit with network awareness
        const actualSafetyDeposit = calculateDynamicSafetyDeposit(userAmountWei, requestNetwork);
        
        const amountInEth = parseFloat(ethers.formatEther(userAmountWei));
        const amountInUsd = amountInEth * ethUsdPrice; // Use real ETH price
          const safetyDepositInEth = parseFloat(ethers.formatEther(actualSafetyDeposit));
          
          logger.info({
            amountInEth,
            amountInUsd: amountInUsd.toFixed(2),
            safetyDepositInEth,
            chain: 'ethereum',
          }, '[orders/create] dynamic safety deposit calculated');

          logger.info({ safetyDeposit: ethers.formatEther(actualSafetyDeposit), chain: 'ethereum' }, '[orders/create] safety deposit');
          
          // Generate order hash for 1inch protocol
          const orderHash = ethers.keccak256(
            ethers.solidityPacked(
              ['address', 'uint256', 'bytes32', 'uint256'],
              [normalizedEthAddress, userAmountWei, hashLock, Math.floor(Date.now() / 1000)]
            )
          );
          
          // Store order with HTLC details 
          const orderData = {
            orderId,
            orderHash,
            hashLock: hashLock,
            secret: secret,
            ethAddress: normalizedEthAddress,
            stellarAddress,
            amount: userAmountWei.toString(),
            safetyDeposit: actualSafetyDeposit.toString(),
            exchangeRate: ethToXlmRate, // Use real-time rate
            contractType: 'ONEINCH_ESCROW_FACTORY_MAINNET_DST',
            status: 'pending_dst_escrow_deployment',
            network: 'ethereum',
            chainId: 1,
            created: new Date().toISOString()
          };
          
          // Γ£à Add networkMode for XLMΓåÆETH processing
          await storeActiveOrder(orderId, {
            ...orderData,
            networkMode: requestNetwork
          });
          
          const totalCost = userAmountWei + actualSafetyDeposit;
          
          // Create IBaseEscrow.Immutables struct for createDstEscrow
          const dstImmutables = {
            orderHash: orderHash,
            hashlock: hashLock,
            maker: normalizedEthAddress, // Will be converted to uint256 by ethers
            taker: '0x0000000000000000000000000000000000000000', // Zero address as uint256
            token: '0x0000000000000000000000000000000000000000', // ETH as uint256
            amount: userAmountWei.toString(),
            safetyDeposit: actualSafetyDeposit.toString(),
            timelocks: Math.floor(Date.now() / 1000) + (2 * 60 * 60) // 2 hours
          };
          
          const srcCancellationTimestamp = Math.floor(Date.now() / 1000) + (4 * 60 * 60); // 4 hours
          
          // Encode EscrowFactory createDstEscrow call (DO─₧RU MAINNET ABI!)
          logger.info({
            dstImmutables,
            srcCancellationTimestamp,
            abiLength: getEscrowFactoryABI(true).length
          }, '≡ƒöì DEBUG: About to encode createDstEscrow with:');
          
          const escrowInterface = new ethers.Interface(getEscrowFactoryABI(true)); // true = mainnet
          logger.debug({ functions: escrowInterface.fragments.map(f => f.type === 'function' ? (f as any).name : f.type) }, '[escrow] interface created');
          
          const encodedData = escrowInterface.encodeFunctionData("createDstEscrow", [
            dstImmutables,
            srcCancellationTimestamp
          ]);
          
          logger.info({ value: encodedData.length }, '≡ƒöì DEBUG: Encoded data length:');

          // Return direct EscrowFactory contract interaction
          res.json({
            success: true,
            orderId,
            orderData,
            dstImmutables,
            srcCancellationTimestamp,
            approvalTransaction: {
              to: useHTLC ? getHtlcBridgeAddress('mainnet') : getEscrowFactoryAddress('mainnet'),       // Dynamic contract selection
              value: `0x${totalCost.toString(16)}`,  // Order amount + safety deposit
              data: encodedData,                // Contract call data
              gas: '0x30D40'                    // 200000 gas limit for contract call (reduced from 500k)
            },
            message: `≡ƒÅ¡ Mainnet: ${useHTLC ? 'HTLC + EscrowFactory' : 'EscrowFactory only'}`,
            nextStep: useHTLC ? 'HTLC Contract ├ºa─ƒ─▒r─▒n' : '1inch EscrowFactory ├ºa─ƒ─▒r─▒n',
            instructions: useHTLC ? [
              '1. User MetaMask ile MainnetHTLC contract\'─▒n─▒ ├ºa─ƒ─▒racak',
              '2. HTLC atomic swap ba┼ƒlayacak',
              '3. Cross-chain bridge tamamlanacak'
            ] : [
              '1. User MetaMask ile 1inch EscrowFactory ├ºa─ƒ─▒racak',
              '2. Escrow yarat─▒lacak ve safety deposit ├╢denecek',
              '3. Cross-chain transfer ba┼ƒlayacak'
            ],
            safetyDeposit: ethers.formatEther(actualSafetyDeposit.toString()),
            totalCost: ethers.formatEther(totalCost.toString()),
            contractType: 'ONEINCH_ESCROW_FACTORY_MAINNET',
            contractAddress: useHTLC ? getHtlcBridgeAddress('mainnet') : getEscrowFactoryAddress('mainnet'),
            note: 'Γ£à 1inch EscrowFactory createDstEscrow - Resmi cross-chain pattern!'
          });
          return;
        }
        
        // TESTNET: Use ESK─░ custom EscrowFactory createEscrow (bizim testnet contract'─▒m─▒z)
        
        // Generate HTLC parameters
        const secretBytes = new Uint8Array(32);
        crypto.getRandomValues(secretBytes);
        const secret = `0x${Array.from(secretBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
        const hashLock = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')}`;
        
        const orderData = {
          orderId,
          token: '0x0000000000000000000000000000000000000000', // ETH
          amount: (parseFloat(amount) * 1e18).toString(),
          hashLock,
          timelock: Math.floor(Date.now() / 1000) + 7201, // 2+ hours
          feeRate: 100, // 1%
          beneficiary: stellarAddress,
          refundAddress: normalizedEthAddress,
          destinationChainId: 1, // Stellar
          // stellarTxHash will be set ONLY after the Stellar leg actually lands on-ledger.
          // We never persist a zero/placeholder hash that could be confused with a real one.
          stellarTxHash: null as string | null,
          partialFillEnabled: false,
          secret: secret,
          created: new Date().toISOString(),
          status: 'pending_direct_escrow'
        };

        // Store order
        await storeActiveOrder(orderId, {
          ...orderData,
          ethAddress: normalizedEthAddress,
          stellarAddress,
          amount: orderData.amount,  // Γ£à Use wei format, not decimal string
          exchangeRate: exchangeRate || ETH_TO_XLM_RATE,
          networkMode: requestNetwork  // Γ£à Store network for XLMΓåÆETH processing
        });

        logger.info({ value: orderId }, 'Γ£à TESTNET ETHΓåÆXLM Order created:');
        logger.info('≡ƒÅ¡ TESTNET ESK─░ ESCROW MODE: User ΓåÆ createEscrow (bizim custom contract)');
        
        // Calculate dynamic safety deposit based on USD value with network awareness
        const orderAmountBigInt = BigInt(orderData.amount);
        const actualSafetyDeposit = calculateDynamicSafetyDeposit(orderData.amount, requestNetwork);
        // Γ£à CORRECT: msg.value = user amount + safety deposit (user's ETH gets locked + safety deposit)
        const totalCost = orderAmountBigInt + actualSafetyDeposit;
        
        // Create EscrowConfig struct (ESK─░ testnet yap─▒s─▒)
        const escrowConfig = {
          token: '0x0000000000000000000000000000000000000000', // ETH
          amount: orderData.amount,
          hashLock: orderData.hashLock,
          timelock: orderData.timelock,
          beneficiary: normalizedEthAddress,
          refundAddress: normalizedEthAddress,
          safetyDeposit: actualSafetyDeposit.toString(),
          chainId: 11155111, // Sepolia testnet
          stellarTxHash: ethers.ZeroHash,
          isPartialFillEnabled: orderData.partialFillEnabled || false
        };
        
        // Encode EscrowFactory createEscrow call (ESK─░ testnet ABI!)
        const escrowInterface = new ethers.Interface(getEscrowFactoryABI(false)); // false = testnet
        const encodedData = escrowInterface.encodeFunctionData("createEscrow", [escrowConfig]);

        // Return direct EscrowFactory contract interaction
        res.json({
          success: true,
          orderId,
          orderData,
          escrowConfig,
          approvalTransaction: {
            to: getEscrowFactoryAddress(requestNetwork),       // Dynamic EscrowFactory (testnet)
            value: `0x${totalCost.toString(16)}`,  // Order amount + safety deposit
            data: encodedData,                // createEscrow call with config
            gas: '0x2DC6C0'                   // 3000000 gas limit for large contract deployment (HTLCBridge ~639 lines)
          },
          message: '≡ƒÅ¡ TESTNET: ESK─░ custom EscrowFactory createEscrow',
          nextStep: 'EscrowFactory createEscrow ├ºa─ƒ─▒r─▒n',
          instructions: [
            '1. User MetaMask ile bizim custom EscrowFactory contract\'─▒n─▒ ├ºa─ƒ─▒racak',
            '2. createEscrow fonksiyonu ├ºal─▒┼ƒacak (ESK─░ testnet ABI ile!)',
            '3. Cross-chain bridge i├ºin escrow olu┼ƒacak'
          ],
          safetyDeposit: ethers.formatEther(actualSafetyDeposit.toString()),
          totalCost: ethers.formatEther(totalCost.toString()),
          contractType: 'ESCROW_FACTORY_DIRECT_TESTNET',
          contractAddress: getEscrowFactoryAddress(requestNetwork),
          note: 'Γ£à TESTNET: ESK─░ createEscrow metodu - bizim custom contract!'
        });
        
      } else if (direction === 'xlm_to_eth') {
        // XLMΓåÆETH: Create HTLC on both Stellar and Ethereum (MainnetHTLC)

        logger.info('≡ƒîƒ XLMΓåÆETH: Creating dual HTLC setup...');
        
        // Get REAL-TIME exchange rates from market
        const realTimePrices = await getRealTimePrices();
        const { xlmUsdPrice, ethUsdPrice, ethToXlmRate } = realTimePrices;
        
        const xlmAmount = parseFloat(amount);
        
        // Calculate REAL market rate: XLM USD value / ETH USD value
        const realMarketRate = xlmUsdPrice / ethUsdPrice;
        const ethAmount = xlmAmount * realMarketRate;
        
        logger.info({
          xlmAmount,
          xlmUsdPrice: `$${xlmUsdPrice}`,
          ethUsdPrice: `$${ethUsdPrice}`,
          realMarketRate: `1 XLM = ${realMarketRate.toFixed(8)} ETH`,
          xlmTotalValue: `$${(xlmAmount * xlmUsdPrice).toFixed(4)}`,
          ethAmount: `${ethAmount.toFixed(8)} ETH`,
          ethTotalValue: `$${(ethAmount * ethUsdPrice).toFixed(4)}`
        }, '[orders/create] XLM-to-ETH real market exchange rate');
        
        // Generate HTLC parameters
        const secret = ethers.hexlify(ethers.randomBytes(32));
        const hashLock = ethers.keccak256(secret).substring(2); // Remove 0x prefix for Stellar
        
        logger.info({
          secret: '[REDACTED]',
          hashLock
        }, '≡ƒöæ Generated HTLC parameters for XLMΓåÆETH:');

        if (RELAYER_CONFIG.enableMockMode) {
          logger.info('≡ƒº¬ MOCK MODE: Simulating XLMΓåÆETH HTLC creation...');
          
          const orderData = {
            orderId,
            direction: 'xlm_to_eth',
            stellarAmount: (xlmAmount * 1e7).toString(),
            ethAmount: (ethAmount * 1e18).toString(),
            ethAddress,
            stellarAddress,
            exchangeRate: ethToXlmRate,
            secret,
            hashLock,
            created: new Date().toISOString(),
            status: 'mock_htlc_created',
            contractType: 'MOCK_DUAL_HTLC'
          };
          
          await storeActiveOrder(orderId, orderData);

          return res.json({
            success: true,
            orderId,
            orderData,
            message: '≡ƒº¬ MOCK: XLMΓåÆETH HTLCs created',
            nextStep: 'Mock: User deposits XLM to Stellar HTLC',
            instructions: [
              '≡ƒº¬ MOCK MODE: No real transactions',
              '1. Mock Stellar HTLC created for XLM lock',
              '2. Mock MainnetHTLC created for ETH unlock',
              '3. User would deposit XLM and trigger ETH release'
            ],
            stellar: {
              htlcId: `mock-stellar-htlc-${Date.now()}`,
              amount: xlmAmount.toString() + ' XLM',
              hashLock: hashLock // Already without 0x for Stellar
            },
            ethereum: {
              contractAddress: getHtlcBridgeAddress('mainnet'),
              ethAmount: ethAmount.toFixed(6) + ' ETH',
              hashLock: '0x' + hashLock // With 0x for Ethereum display
            }
          });
        }

        // FIXED: Create pending order ONLY - NO ETH HTLC YET!
        logger.info('≡ƒîƒ XLMΓåÆETH: Creating pending order (awaiting XLM payment)...');
        logger.info('≡ƒô¥ User will send XLM first, then relayer will create ETH HTLC');

        // Safe ETH amount conversion with decimal limit
        const safeEthAmount = Math.min(Math.max(ethAmount, 0.000001), 10.0); // Min 0.000001, Max 10 ETH
        const roundedEthAmount = Math.round(safeEthAmount * 1e6) / 1e6; // 6 decimal places
        
        let ethAmountWei;
        try {
          ethAmountWei = ethers.parseEther(roundedEthAmount.toString());
        } catch (parseError: any) {
          logger.warn({ value: parseError.message }, 'ΓÜá∩╕Å parseEther failed in create endpoint, using minimum amount:');
          ethAmountWei = ethers.parseEther("0.001"); // 0.001 ETH minimum
        }
        
        logger.info({ ethAmount: roundedEthAmount, chain: 'ethereum', direction: 'xlm_to_eth' }, '[orders/create] XLM-to-ETH pending ETH amount');

        // Store pending order data (NO ETH HTLC YET!)
        const relayerStellarAddress = process.env.RELAYER_STELLAR_PUBLIC || 'YOUR_STELLAR_PUBLIC_KEY_HERE';
        
        const orderData = {
          orderId,
          direction: 'xlm_to_eth',
          stellarAmount: (xlmAmount * 1e7).toString(),
          ethAmount: ethAmountWei.toString(),
          ethAddress,
          stellarAddress,
          exchangeRate: ethToXlmRate,
          secret,
          hashLock,
          created: new Date().toISOString(),
          status: 'awaiting_xlm_payment', // PENDING STATUS
          contractType: 'XLM_TO_ETH_PENDING',
          stellar: {
            paymentAddress: relayerStellarAddress,
            amount: xlmAmount.toString(),
            memo: `XLM-ETH-${orderId.substring(0, 8)}`
          },
          ethereum: {
            pendingAmount: ethAmountWei.toString(),
            beneficiary: ethAddress
          }
        };
        
        await storeActiveOrder(orderId, orderData);

        res.json({
          success: true,
          orderId,
          message: 'ΓÅ│ XLMΓåÆETH: Order created - Please send XLM to complete swap',
          orderData: {
            stellarAmount: (xlmAmount * 1e7).toString(),
            stellarAddress: relayerStellarAddress,
            memo: `XLM-ETH-${orderId.substring(0, 8)}`,
            expectedEthAmount: ethAmountWei.toString(),
            status: 'awaiting_xlm_payment',
            instructions: `Send ${xlmAmount} XLM to ${relayerStellarAddress} with memo: XLM-ETH-${orderId.substring(0, 8)}`
          }
        });
        
      } else {
        throw new Error('Invalid direction specified');
      }

    } catch (error) {
      logger.error({ err: error }, 'Γ¥î Bridge order creation failed:');
      res.status(500).json({
        error: 'Bridge order creation failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // POST /api/orders/process - Process approved order (ETHΓåÆXLM: Send XLM, XLMΓåÆETH: Send ETH)
  app.post('/api/orders/process', async (req, res) => {
    try {
      const { orderId, txHash, stellarTxHash, stellarAddress, ethAddress } = req.body;
      
      if (!orderId) {
        return res.status(400).json({
          error: 'Order ID is required'
        });
      }

      // ── Pipeline metric: submission latency for the settlement path ───
      const processSubmissionTimer = submissionLatencySeconds.startTimer({ direction: 'xlm_to_eth' });
      res.on('finish', () => {
        processSubmissionTimer({ result: res.statusCode < 400 ? 'success' : 'failure' });
      });

      logger.info({ orderId, txHash, stellarTxHash }, '≡ƒîƒ Processing approved order:');
      
      // Get stored order
      const storedOrder = activeOrders.get(orderId);
      if (!storedOrder) {
        return res.status(404).json({
          error: 'Order not found',
          orderId
        });
      }

      // Use stored addresses
      const userStellarAddress = storedOrder.stellarAddress || stellarAddress;
      const userEthAddress = storedOrder.ethAddress || ethAddress;
      const orderAmount = storedOrder.amount;

      logger.info({
        userStellarAddress,
        userEthAddress, 
        orderAmount,
        contractType: storedOrder.contractType
      }, '≡ƒôï Processing order with stored data:');

      // Handle 1inch Escrow Factory orders first
      if (storedOrder.contractType === 'ONEINCH_ESCROW_FACTORY' && storedOrder.status === 'pending_escrow_deployment') {
        logger.info('≡ƒÅ¡ Processing 1inch Escrow Factory deployment...');
        
        try {
          // Escrow was deployed when user called createDstEscrow
          // Now we need to create corresponding escrow on Stellar
          logger.info('≡ƒîƒ Creating corresponding escrow on Stellar...');
          
          // Update order status to indicate escrow deployment success
          storedOrder.status = 'escrow_deployed';
          storedOrder.ethTxHash = txHash;
          
          // Process cross-chain transfer to Stellar
          await processEscrowToStellar(orderId, storedOrder);
          
          return res.json({
            success: true,
            orderId,
            message: '≡ƒÅ¡ Escrow deployed and Stellar transfer initiated',
            status: 'processing_stellar_transfer'
          });
          
        } catch (escrowError: any) {
          logger.error({ err: escrowError }, 'Γ¥î Escrow processing failed:');
          storedOrder.status = 'escrow_failed';
          
          return res.status(500).json({
            error: 'Escrow processing failed',
            details: escrowError.message
          });
        }
      }

      logger.info({ stellarTxHash, txHash }, '≡ƒÜ¿ DEBUG: About to determine direction...');

      // Determine direction based on incoming data
      const isXlmToEth = stellarTxHash && !txHash; // XLMΓåÆETH: Has stellarTxHash but no txHash
      const isEthToXlm = txHash && !stellarTxHash; // ETHΓåÆXLM: Has txHash but no stellarTxHash

      logger.info({ isXlmToEth, isEthToXlm }, '≡ƒÜ¿ DEBUG: Direction variables computed:');

      logger.info({
        isXlmToEth,
        isEthToXlm,
        stellarTxHash: stellarTxHash || 'none',
        ethTxHash: txHash || 'none'
      }, '≡ƒöä Direction detected:');

      // XLMΓåÆETH: Send ETH to user
      if (isXlmToEth) {
        try {
          // ── Network resolution ─────────────────────────────────────────────
          const orderNetworkMode = (storedOrder.networkMode as string) || 'mainnet';
          const rpcUrl = resolveEthereumRpcUrl(orderNetworkMode === 'testnet' ? 'testnet' : 'mainnet');
          const privateKey = process.env.RELAYER_PRIVATE_KEY;

          if (!privateKey) {
            throw new Error('RELAYER_PRIVATE_KEY environment variable is required');
          }

          // ── Replay protection fast-path ───────────────────────────────────
          if (globalStellarProofLedger.isConsumed(stellarTxHash)) {
            const existing = globalStellarProofLedger.getEntry(stellarTxHash);
            settlementProofReplaysTotal.inc({ network_mode: orderNetworkMode });
            return res.status(409).json({
              error: 'Stellar transaction already consumed',
              details: `stellarTxHash ${stellarTxHash} was already used to settle order ${existing?.orderId ?? '(unknown)'}.`,
              stellarTxHash,
            });
          }

          // ── Horizon proof verification ────────────────────────────────────
          // No ETH is released without a confirmed Stellar payment to the
          // relayer's own address on the correct network.
          const processHorizonUrl = NETWORK_CONFIG[orderNetworkMode as 'mainnet' | 'testnet']?.stellar?.horizonUrl;
          const processRelayerSecret = orderNetworkMode === 'mainnet'
            ? (process.env.RELAYER_STELLAR_SECRET_MAINNET || process.env.RELAYER_STELLAR_SECRET)
            : (process.env.RELAYER_STELLAR_SECRET_TESTNET || process.env.RELAYER_STELLAR_SECRET);

          if (!processRelayerSecret || !processHorizonUrl) {
            return res.status(500).json({ error: 'Relayer Stellar config not available', network: orderNetworkMode });
          }

          const { Keypair: ProcessKeypair } = await import('@stellar/stellar-sdk');
          const processRelayerPubkey = ProcessKeypair.fromSecret(processRelayerSecret).publicKey();

          let processVerifiedPayment: Awaited<ReturnType<typeof verifyIncomingStellarPayment>>;
          try {
            const receiptTimer = receiptLatencySeconds.startTimer();
            processVerifiedPayment = await verifyIncomingStellarPayment(stellarTxHash, {
              horizonUrl: processHorizonUrl,
              relayerPublicKey: processRelayerPubkey,
              expectedSourceAccount: userStellarAddress || undefined,
            });
            receiptTimer({ result: 'success' });
            settlementVerificationTotal.inc({ result: 'success', network_mode: orderNetworkMode });
          } catch (verifyErr: unknown) {
            if (verifyErr instanceof StellarTxNotFoundError) {
              receiptLatencySeconds.observe({ result: 'tx_not_found' }, 0);
              settlementVerificationTotal.inc({ result: 'tx_not_found', network_mode: orderNetworkMode });
              return res.status(404).json({ error: 'Stellar transaction not found on Horizon', stellarTxHash });
            }
            if (verifyErr instanceof StellarTxFailedError) {
              receiptLatencySeconds.observe({ result: 'tx_failed' }, 0);
              settlementVerificationTotal.inc({ result: 'tx_failed', network_mode: orderNetworkMode });
              return res.status(400).json({ error: 'Stellar transaction failed on-chain', stellarTxHash });
            }
            if (verifyErr instanceof StellarPaymentMismatch) {
              receiptLatencySeconds.observe({ result: 'payment_mismatch' }, 0);
              settlementVerificationTotal.inc({ result: 'payment_mismatch', network_mode: orderNetworkMode });
              return res.status(400).json({ error: 'Stellar payment verification failed', details: (verifyErr as Error).message, stellarTxHash });
            }
            receiptLatencySeconds.observe({ result: 'horizon_error' }, 0);
            settlementVerificationTotal.inc({ result: 'horizon_error', network_mode: orderNetworkMode });
            return res.status(503).json({ error: 'Horizon verification temporarily unavailable' });
          }

          // ── Consume the proof atomically ──────────────────────────────────
          const processConsumed = globalStellarProofLedger.consume(stellarTxHash, {
            orderId,
            verifiedAmount: processVerifiedPayment.amount,
            ledgerSequence: processVerifiedPayment.ledgerSequence,
          });
          if (!processConsumed) {
            settlementProofReplaysTotal.inc({ network_mode: orderNetworkMode });
            const existing = globalStellarProofLedger.getEntry(stellarTxHash);
            return res.status(409).json({
              error: 'Stellar transaction already consumed by a concurrent request',
              stellarTxHash,
              existingOrder: existing?.orderId,
            });
          }

          // ── Bigint amount derivation from verified XLM ────────────────────
          // No parseFloat, no toFixed, no fallback constants.
          const processExchangeRate = storedOrder?.exchangeRate;
          if (!processExchangeRate || isNaN(Number(processExchangeRate)) || Number(processExchangeRate) <= 0) {
            return res.status(400).json({ error: 'Order is missing a valid exchange rate', orderId });
          }

          const procParts = processVerifiedPayment.amount.split('.');
          const procInt = BigInt(procParts[0] ?? '0');
          const procFrac = BigInt((procParts[1] ?? '').padEnd(7, '0').substring(0, 7));
          const procXlmStroops = procInt * 10_000_000n + procFrac;
          const procRateBigInt = BigInt(Math.round(Number(processExchangeRate)));
          if (procRateBigInt === 0n) {
            return res.status(400).json({ error: 'Exchange rate rounds to zero', orderId });
          }
          const ethAmountWei = (procXlmStroops * 1_000_000_000_000_000_000n) / (procRateBigInt * 10_000_000n);
          if (ethAmountWei === 0n) {
            return res.status(400).json({ error: 'Verified XLM amount is too small to release any ETH', orderId });
          }

          logger.info({
            orderId, verifiedXlmAmount: processVerifiedPayment.amount,
            xlmStroops: procXlmStroops.toString(), exchangeRate: processExchangeRate,
            ethAmountWei: ethAmountWei.toString(), ethFormatted: ethers.formatEther(ethAmountWei),
            chain: 'ethereum', direction: 'xlm_to_eth',
          }, '[process/xlm-to-eth] amount calculation');

          // ── Settlement-permission check (settle / ethereum) ──────────────
          //
          // Before building the provider or wallet, confirm the relayer is
          // authorized to execute a `settle` command on Ethereum for this
          // direction. This catches a missing key or factory address with a
          // clear structured error rather than a cryptic ethers exception.
          {
            const procSettleAuth = authorizeSettlementCommand(
              supportPolicy,
              RELAYER_CONFIG as SettlementAccountConfig,
              { command: 'settle', direction: storedOrder?.direction ?? 'xlm_to_eth', chain: 'ethereum' }
            );
            if (!procSettleAuth.authorized) {
              logger.warn(
                `🚫 Settlement permission denied [${procSettleAuth.code}]: ${procSettleAuth.reason}`,
                formatAuthorizationLog(procSettleAuth)
              );
              return res.status(403).json({
                error: 'settlement_permission_denied',
                code: procSettleAuth.code,
                details: procSettleAuth.reason,
                command: procSettleAuth.command,
                chain: procSettleAuth.chain,
              });
            }
            logger.info(
              '✅ Settlement permission granted (process)',
              formatAuthorizationLog(procSettleAuth)
            );
          }

          // ── ETH provider + wallet ─────────────────────────────────────────
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const relayerWallet = new ethers.Wallet(privateKey, provider);

          // ── Balance check (retried via RetryEngine) ───────────────────────
          const balance = await runWithSettlementRetry(
            'eth-balance',
            ETH_BALANCE_RETRY,
            () => provider.getBalance(relayerWallet.address),
            { orderId, direction: storedOrder?.direction ?? 'xlm_to_eth', chain: 'ethereum' },
          );

          const gasCost = 21000n * ethers.parseUnits('20', 'gwei');
          if (balance < ethAmountWei + gasCost) {
            return res.status(400).json({
              error: 'Insufficient relayer balance',
              balance: ethers.formatEther(balance),
              required: ethers.formatEther(ethAmountWei + gasCost),
            });
          }

          // Create ETH transfer transaction
          const tx = {
            to: userEthAddress,
            value: ethAmountWei,
            gasLimit: 21000,
            gasPrice: ethers.parseUnits('20', 'gwei'),
          };

          // ── ETH send (retried via RetryEngine + SettlementFailureStore) ───
          const ethTxResponse = await runWithSettlementRetry(
            'eth-send',
            ETH_SEND_RETRY,
            () => relayerWallet.sendTransaction(tx),
            {
              orderId,
              direction: storedOrder?.direction ?? 'xlm_to_eth',
              chain: 'ethereum',
              recoveredTxHash: (r) => r.hash,
            },
          );
          retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'success' }, 0);
          logger.info({ value: ethTxResponse.hash }, '≡ƒôñ ETH transaction sent:');

          // ── Wait for confirmation (retried via RetryEngine) ───────────────
          const ethTxReceipt = await runWithSettlementRetry(
            'eth-confirm',
            ETH_CONFIRM_RETRY,
            () => ethTxResponse.wait(),
            { orderId, direction: storedOrder?.direction ?? 'xlm_to_eth', chain: 'ethereum' },
          );
          logger.info('Γ£à ETH transaction confirmed!');
          logger.info({ value: ethTxReceipt?.hash }, '≡ƒöì ETH tx hash:');
          logger.info('≡ƒîÉ View on Etherscan: https://sepolia.etherscan.io/tx/' + ethTxReceipt?.hash);

          // Update order status
          storedOrder.status = 'completed';
          storedOrder.ethTxHash = ethTxReceipt?.hash;

          // Success response
          res.json({
            success: true,
            orderId,
            ethTxId: ethTxReceipt?.hash,
            message: 'Cross-chain swap completed successfully!',
            details: {
              stellar: {
                txHash: stellarTxHash,
                verifiedAmount: processVerifiedPayment.amount,
                status: 'confirmed'
              },
              ethereum: {
                txId: ethTxReceipt?.hash,
                amount: `${ethers.formatEther(ethAmountWei)} ETH`,
                destination: userEthAddress,
                status: 'completed'
              }
            }
          });
          
        } catch (ethError: any) {
          logger.error({ err: ethError }, 'Γ¥î ETH transaction failed:');
          // ── Failure store + pipeline metrics ─────────────────────────────
          retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'failure' }, 0);
          droppedOrdersTotal.inc({ direction: 'xlm_to_eth', reason: 'eth_tx_failed' });
          const procFailCategory = classifyFailureCategory(ethError, 'ethereum');
          globalSettlementFailureStore.recordFailure({
            orderId,
            direction: storedOrder?.direction ?? 'xlm_to_eth',
            category: procFailCategory,
            errorMessage: ethError.message,
            chain: 'ethereum',
            recoveryAction: 'ETH send exhausted all retries in /api/orders/process',
          });
          res.status(500).json({
            error: 'ETH release failed',
            details: ethError.message,
            orderId,
            recoveryHint: 'Check /api/admin/settlement-failures for recovery status.',
          });
        }
        
        return; // Exit here for XLMΓåÆETH
      }

      // ETHΓåÆXLM: Send XLM to user
      if (isEthToXlm) {
        logger.info('≡ƒÆ░ ETHΓåÆXLM: Sending XLM to user...');
      
        // Dynamic import Stellar SDK with better error handling
        try {
        logger.info('≡ƒöù Loading Stellar SDK...');
        const { Horizon, Keypair, Asset, Operation, TransactionBuilder, Networks, BASE_FEE, Memo } = await import('@stellar/stellar-sdk');
        
        // Setup Stellar server (dynamic network based on stored order)
        const dynamicNetwork = storedOrder.contractType?.includes('ONEINCH') ? 'mainnet' : 'testnet';
        const stellarConfig = NETWORK_CONFIG[dynamicNetwork].stellar;
        const server = new Horizon.Server(stellarConfig.horizonUrl);
        
        logger.info({
          horizonUrl: stellarConfig.horizonUrl,
          detectedFrom: storedOrder.contractType
        }, `≡ƒöù Using Stellar ${dynamicNetwork}:`);
        
        // Relayer Stellar keys (from environment - network specific)
        const relayerSecretKey = dynamicNetwork === 'mainnet' 
          ? (process.env.RELAYER_STELLAR_SECRET_MAINNET || process.env.RELAYER_STELLAR_SECRET)
          : (process.env.RELAYER_STELLAR_SECRET_TESTNET || process.env.RELAYER_STELLAR_SECRET);
        
        if (!relayerSecretKey || relayerSecretKey === 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') {
          throw new Error(`Γ¥î CRITICAL: Relayer Stellar secret key not configured for ${dynamicNetwork}! Set RELAYER_STELLAR_SECRET_${dynamicNetwork.toUpperCase()} in environment variables.`);
        }
        
        const relayerKeypair = Keypair.fromSecret(relayerSecretKey);
        
        logger.info(`≡ƒöù Connecting to Stellar ${dynamicNetwork}...`);
        logger.info(`≡ƒöæ Using relayer public key: ${relayerKeypair.publicKey()}`);
        const relayerAccount = await server.loadAccount(relayerKeypair.publicKey());
        
        const relayerBalance = relayerAccount.balances.find(b => b.asset_type === 'native')?.balance || '0';
        logger.info({ value: relayerBalance }, '≡ƒÆ░ Relayer XLM balance:');

        // Calculate XLM amount to send using real-time rate from frontend
        const exchangeRate = storedOrder?.exchangeRate || ETH_TO_XLM_RATE; // Use real rate if available
        // Convert wei to ETH first, then calculate XLM amount
        const ethAmount = parseFloat(ethers.formatEther(orderAmount || '1000000000000000')); // Convert wei to ETH
        const xlmAmount = (ethAmount * exchangeRate).toFixed(7);
        logger.info({ exchangeRate, direction: 'eth_to_xlm' }, '[orders/process] using exchange rate');
        logger.info({ value: userStellarAddress }, '≡ƒÄ» Sending to user address:');
        logger.info({ value: xlmAmount }, '≡ƒÆ░ XLM amount to send:');
        
        // Check if relayer has sufficient balance
        if (parseFloat(relayerBalance) < parseFloat(xlmAmount)) {
          throw new Error(`Γ¥î INSUFFICIENT FUNDS: Relayer has ${relayerBalance} XLM but needs ${xlmAmount} XLM. Please fund relayer wallet: ${relayerKeypair.publicKey()}`);
        }
        
        // Create payment transaction
        const payment = Operation.payment({
          destination: userStellarAddress,
          asset: Asset.native(), // XLM
          amount: xlmAmount
        });
        
        // Build transaction with dynamic network
        const networkPassphrase = dynamicNetwork === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
        const transaction = new TransactionBuilder(relayerAccount, {
          fee: BASE_FEE,
          networkPassphrase: networkPassphrase
        })
          .addOperation(payment)
          .addMemo(Memo.text(`Bridge:${orderId.substring(0, 20)}`))
          .setTimeout(300)
          .build();
        
        // Sign transaction
        transaction.sign(relayerKeypair);
        logger.info('≡ƒô¥ Transaction signed');
        logger.info({ value: userStellarAddress }, '≡ƒÆ½ Sending XLM to:');
        
        // Submit to network
        const result = await server.submitTransaction(transaction);
        logger.info('Γ£à Stellar transaction successful!');
        logger.info({ value: result.hash }, '≡ƒöì Transaction hash:');
        logger.info('≡ƒîÉ View on StellarExpert: https://stellar.expert/explorer/' + 
          (DEFAULT_NETWORK_MODE === 'mainnet' ? 'public' : 'testnet') + '/tx/' + result.hash);
        
        // Update order status
        storedOrder.status = 'completed';
        storedOrder.stellarTxHash = result.hash;
        
        // Successful response
        res.json({
          success: true,
          orderId,
          stellarTxId: result.hash,
          message: 'Cross-chain swap completed successfully!',
          details: {
            ethereum: {
              txHash: txHash,
              status: 'confirmed'
            },
            stellar: {
              txId: result.hash,
              amount: `${xlmAmount} XLM`,
              destination: userStellarAddress,
              status: 'completed'
            }
          }
        });

      } catch (stellarError: any) {
        logger.error({ err: stellarError }, 'Γ¥î Stellar transaction failed:');
        logger.info({ value: stellarError.message }, 'Error details:');

        // Never fabricate a Stellar tx hash. Surface the real error so the
        // frontend can show "swap failed" and the user can initiate a
        // permissionless refund on Ethereum once the timelock expires.
        res.status(502).json({
          success: false,
          orderId,
          error: 'Stellar transaction failed',
          details: {
            ethereum: { status: 'confirmed' },
            stellar: {
              status: 'failed',
              message: stellarError.message
            }
          },
          refundHint: 'Funds remain locked on Ethereum. After the timelock you can call refundOrder() to recover them.'
        });
        }
      } // End of ETHΓåÆXLM processing

    } catch (error: any) {
      logger.error({ err: error }, 'Γ¥î Order processing failed:');
      res.status(500).json({
        error: 'Order processing failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // POST /api/orders/xlm-to-eth - Dedicated XLMΓåÆETH processing endpoint  
  app.post('/api/orders/xlm-to-eth', async (req, res) => {
    try {
      logger.debug({ body: req.body }, '[xlm-to-eth] request body');
      logger.debug({ headers: req.headers }, '[xlm-to-eth] request headers');
      logger.debug({ envSet: !!process.env.ETHEREUM_RPC_URL }, '[xlm-to-eth] ETHEREUM_RPC_URL env check');
      logger.debug({ envSet: !!process.env.RELAYER_PRIVATE_KEY }, '[xlm-to-eth] RELAYER_PRIVATE_KEY env check');
      
      // ── Pipeline metric: submission latency for xlm-to-eth ────────────
      const xlmToEthTimer = submissionLatencySeconds.startTimer({ direction: 'xlm_to_eth' });
      res.on('finish', () => {
        xlmToEthTimer({ result: res.statusCode < 400 ? 'success' : 'failure' });
      });

      const { orderId, stellarTxHash, stellarAddress, ethAddress, networkMode } = req.body;
      
      // Γ£à NETWORK DETECTION: Check request body first, then stored order, then default
      const requestNetwork = networkMode || 
                            (req.query.network as string) || 
                            DEFAULT_NETWORK_MODE;
      
      logger.info({
        bodyNetworkMode: networkMode,
        queryNetwork: req.query.network,
        defaultMode: DEFAULT_NETWORK_MODE,
        finalDecision: requestNetwork.toUpperCase()
      }, '≡ƒîÉ XLMΓåÆETH Endpoint Network Detection:');
      
      if (!orderId || !stellarTxHash || !ethAddress) {
        logger.info({ orderId: !!orderId, stellarTxHash: !!stellarTxHash, ethAddress: !!ethAddress }, 'Γ¥î Missing required fields:');
        return res.status(400).json({
          error: 'Missing required fields: orderId, stellarTxHash, ethAddress, stellarAddress',
        });
      }

      // ── 2. Replay protection fast-path — reject already-consumed proofs ──
      if (globalStellarProofLedger.isConsumed(stellarTxHash)) {
        const existing = globalStellarProofLedger.getEntry(stellarTxHash);
        const networkForMetric = (networkMode === 'mainnet' ? 'mainnet' : 'testnet') as string;
        settlementProofReplaysTotal.inc({ network_mode: networkForMetric });
        return res.status(409).json({
          error: 'Stellar transaction already consumed',
          details: `stellarTxHash ${stellarTxHash} was already used to settle order ${existing?.orderId ?? '(unknown)'}. Replaying the same proof is not permitted.`,
          stellarTxHash,
        });
      }

      logger.info({ orderId, stellarTxHash, stellarAddress, ethAddress }, '≡ƒÆ░ XLMΓåÆETH: Processing dedicated endpoint...');
      
      // Get stored order - BYPASSED FOR NOW (in-memory data lost on restart)
      let storedOrder = activeOrders.get(orderId);
      // if (!storedOrder) {
      //   return res.status(404).json({
      //     error: 'Order not found',
      //     orderId
      //   });
      // }

      // Use provided data or defaults if order not found in memory
      const userEthAddress = storedOrder?.ethAddress || ethAddress;
      const orderAmount = storedOrder?.amount || '10'; // Default for testing

      // ≡ƒ¢í∩╕Å Refund watchdog bookkeeping. We need:
      //   - `xlmReceivedAt`: when the user committed XLM (used to compute staleness)
      //   - `stellarTxHash`: the original payment, so the watchdog can size the refund
      //   - `stellarAddress`: where to send the refund
      // If the in-memory order was lost (relayer restart, etc.) we
      // synthesize a minimal entry so the watchdog can still rescue it.
      if (!storedOrder) {
        return res.status(404).json({
          error: 'Order not found',
          orderId,
          details: 'The order must be created via /api/orders/create before settlement can proceed.',
        });
      }
      storedOrder.xlmReceivedAt = storedOrder.xlmReceivedAt ?? Date.now();
      storedOrder.stellarTxHash = stellarTxHash;
      if (stellarAddress) storedOrder.stellarAddress = stellarAddress;
      storedOrder.networkMode = storedOrder.networkMode ?? requestNetwork;
      
      logger.info({ userEthAddress, orderAmount }, '≡ƒÄ» XLMΓåÆETH: Sending ETH to user...');
      
      {
        // Γ£à NETWORK-AWARE: Use request network first, fallback to stored order
        const orderNetworkMode = requestNetwork || storedOrder?.networkMode || 'mainnet';
        const rpcUrl = resolveEthereumRpcUrl(orderNetworkMode === 'testnet' ? 'testnet' : 'mainnet');
        const privateKey = process.env.RELAYER_PRIVATE_KEY;
        
        logger.info(`≡ƒîÉ XLMΓåÆETH Network Detection (2nd endpoint): ${orderNetworkMode.toUpperCase()}`);
        
        if (!privateKey) {
          throw new Error('RELAYER_PRIVATE_KEY environment variable is required');
        }

      if (storedOrder.direction && storedOrder.direction !== 'xlm_to_eth') {
        return res.status(400).json({ error: 'Order direction mismatch', orderId, direction: storedOrder.direction });
      }

      // Idempotent re-submission: already settled → return cached result
      if (storedOrder.status === 'eth_tx_sent' || storedOrder.status === 'completed') {
        return res.status(200).json({
          success: true,
          orderId,
          ethTxId: storedOrder.ethTxHash,
          message: 'Order already settled — returning committed ETH tx hash.',
          fromCache: true,
        });
      }

      if (storedOrder.status === 'refunded' || storedOrder.status === 'stellar_transfer_failed') {
        return res.status(409).json({
          error: 'Order is in a terminal state and cannot be settled',
          orderId,
          status: storedOrder.status,
        });
      }

      // ── 5. Horizon proof verification ─────────────────────────────────────
      const horizonUrl = NETWORK_CONFIG[orderNetworkMode].stellar.horizonUrl;
      const relayerSecretKey = orderNetworkMode === 'mainnet'
        ? (process.env.RELAYER_STELLAR_SECRET_MAINNET || process.env.RELAYER_STELLAR_SECRET)
        : (process.env.RELAYER_STELLAR_SECRET_TESTNET || process.env.RELAYER_STELLAR_SECRET);

      if (!relayerSecretKey) {
        return res.status(500).json({ error: 'Relayer Stellar secret not configured', network: orderNetworkMode });
      }

      const { Keypair } = await import('@stellar/stellar-sdk');
      const relayerPublicKey = Keypair.fromSecret(relayerSecretKey).publicKey();

      let verifiedPayment: Awaited<ReturnType<typeof verifyIncomingStellarPayment>>;
      try {
        const receiptTimer = receiptLatencySeconds.startTimer();
        verifiedPayment = await verifyIncomingStellarPayment(stellarTxHash, {
          horizonUrl,
          relayerPublicKey,
          expectedSourceAccount: stellarAddress,
        });
        receiptTimer({ result: 'success' });
        settlementVerificationTotal.inc({ result: 'success', network_mode: orderNetworkMode });
      } catch (verifyErr: unknown) {
        if (verifyErr instanceof StellarTxNotFoundError) {
          receiptLatencySeconds.observe({ result: 'tx_not_found' }, 0);
          settlementVerificationTotal.inc({ result: 'tx_not_found', network_mode: orderNetworkMode });
          return res.status(404).json({
            error: 'Stellar transaction not found on Horizon',
            details: (verifyErr as Error).message,
            stellarTxHash,
          });
        }
        if (verifyErr instanceof StellarTxFailedError) {
          receiptLatencySeconds.observe({ result: 'tx_failed' }, 0);
          settlementVerificationTotal.inc({ result: 'tx_failed', network_mode: orderNetworkMode });
          return res.status(400).json({
            error: 'Stellar transaction failed on-chain',
            details: (verifyErr as Error).message,
            stellarTxHash,
          });
        }
        if (verifyErr instanceof StellarPaymentMismatch) {
          receiptLatencySeconds.observe({ result: 'payment_mismatch' }, 0);
          settlementVerificationTotal.inc({ result: 'payment_mismatch', network_mode: orderNetworkMode });
          return res.status(400).json({
            error: 'Stellar payment verification failed',
            details: (verifyErr as Error).message,
            stellarTxHash,
          });
        }
        receiptLatencySeconds.observe({ result: 'horizon_error' }, 0);
        settlementVerificationTotal.inc({ result: 'horizon_error', network_mode: orderNetworkMode });
        return res.status(503).json({
          error: 'Horizon verification temporarily unavailable',
          details: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
        });
      }

      // ── Consume the proof atomically (before any ETH work) ────────────────
      // This is the replay-protection gate. If two concurrent requests arrive
      // with the same stellarTxHash the second one lands here after the first
      // has already set the entry, and is rejected with 409.
      const consumed = globalStellarProofLedger.consume(stellarTxHash, {
        orderId,
        verifiedAmount: verifiedPayment.amount,
        ledgerSequence: verifiedPayment.ledgerSequence,
      });
      if (!consumed) {
        settlementProofReplaysTotal.inc({ network_mode: orderNetworkMode });
        const existing = globalStellarProofLedger.getEntry(stellarTxHash);
        return res.status(409).json({
          error: 'Stellar transaction already consumed',
          details: `stellarTxHash ${stellarTxHash} was already used to settle order ${existing?.orderId ?? '(unknown)'}. Replaying the same proof is not permitted.`,
          stellarTxHash,
        });
      }

      try {
        logger.info('≡ƒÆ░ REAL MODE: Sending actual ETH transaction');
        logger.info({ value: rpcUrl }, '≡ƒöù RPC URL:');
        logger.info('≡ƒöæ Using relayer key: [REDACTED]');

        // ── Settlement-permission check (settle / ethereum) ───────────────
        //
        // We are about to release ETH to the beneficiary. Verify the settle
        // command is authorized for this direction and that the Ethereum
        // account (key + factory address) is ready before building the
        // transaction, so a config regression is caught here with a clear
        // error rather than a cryptic ethers exception mid-flight.
        const settleAuth = authorizeSettlementCommand(
          supportPolicy,
          RELAYER_CONFIG as SettlementAccountConfig,
          { command: 'settle', direction: storedOrder?.direction ?? 'xlm_to_eth', chain: 'ethereum' }
        );
        if (!settleAuth.authorized) {
          logger.warn(
            `🚫 Settlement permission denied [${settleAuth.code}]: ${settleAuth.reason}`,
            formatAuthorizationLog(settleAuth)
          );
          return res.status(403).json({
            error: 'settlement_permission_denied',
            code: settleAuth.code,
            details: settleAuth.reason,
            command: settleAuth.command,
            chain: settleAuth.chain,
          });
        }
        logger.info(
          '✅ Settlement permission granted',
          formatAuthorizationLog(settleAuth)
        );

        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const relayerWallet = new ethers.Wallet(privateKey, provider);

        logger.info({ value: relayerWallet.address }, '≡ƒöæ Relayer ETH address:');

        // ── Balance check (retried via RetryEngine) ───────────────────────
        logger.info('≡ƒöì Getting relayer balance...');
        const balance = await runWithSettlementRetry(
          'eth-balance',
          ETH_BALANCE_RETRY,
          () => withTimeout(
            provider.getBalance(relayerWallet.address),
            RELAYER_CONFIG.rpcTimeoutMs,
            'RPC getBalance timeout',
          ),
          { orderId, direction: storedOrder?.direction ?? 'xlm_to_eth', chain: 'ethereum' },
        );
        logger.info({ balance: ethers.formatEther(balance), chain: 'ethereum' }, '[xlm-to-eth] relayer ETH balance');
        
        // ── Derive ETH amount from the Horizon-verified XLM amount ────────────
        // All arithmetic is integer-based (bigint stroops → bigint wei).
        // No parseFloat, no toFixed, no fallback constants.
        //
        // Formula (bigint throughout):
        //   xlmStroops = verifiedPayment.amount parsed as 7-decimal fixed-point
        //   ethWei     = xlmStroops * 1e11 / exchangeRateStroopsPerEth
        //
        // exchangeRate is stored as XLM-per-ETH (e.g. 8000 means 8000 XLM = 1 ETH).
        // We need stroops-per-wei for integer division:
        //   exchangeRateSPE = exchangeRate(XLM/ETH) * 10_000_000 (stroops/XLM)
        //                                            / 1_000_000_000_000_000_000 (wei/ETH)
        // Rearranging to avoid losing precision:
        //   ethWei = xlmStroops * 1e18 / (exchangeRate * 1e7)
        const exchangeRate = storedOrder?.exchangeRate;
        if (!exchangeRate || isNaN(Number(exchangeRate)) || Number(exchangeRate) <= 0) {
          return res.status(400).json({
            error: 'Order is missing a valid exchange rate — cannot derive ETH payout',
            orderId,
          });
        }

        // xlmStringToStroops: integer parse of "12.3456789" → 123456789n
        const xlmParts = verifiedPayment.amount.split('.');
        const xlmInt = BigInt(xlmParts[0] ?? '0');
        const xlmFrac = BigInt((xlmParts[1] ?? '').padEnd(7, '0').substring(0, 7));
        const xlmStroops = xlmInt * 10_000_000n + xlmFrac;

        // exchangeRate is XLM-per-ETH as a number; round to nearest integer.
        const exchangeRateBigInt = BigInt(Math.round(Number(exchangeRate)));
        if (exchangeRateBigInt === 0n) {
          return res.status(400).json({ error: 'Exchange rate rounds to zero', orderId });
        }

        // ethWei = xlmStroops * 1e18 / (exchangeRate * 1e7)
        const ethAmountWei = (xlmStroops * 1_000_000_000_000_000_000n) / (exchangeRateBigInt * 10_000_000n);

        if (ethAmountWei === 0n) {
          return res.status(400).json({
            error: 'Verified XLM amount is too small to release any ETH',
            verifiedXlmAmount: verifiedPayment.amount,
            orderId,
          });
        }

        logger.info({
          orderId,
          verifiedXlmAmount: verifiedPayment.amount,
          xlmStroops: xlmStroops.toString(),
          exchangeRate,
          ethAmountWei: ethAmountWei.toString(),
          ethAmountFormatted: ethers.formatEther(ethAmountWei),
          chain: 'ethereum', direction: 'xlm_to_eth',
        }, '[xlm-to-eth] amount calculation');
        const tx = {
          to: userEthAddress,
          value: ethAmountWei,
          gasLimit: 21000,
          gasPrice: ethers.parseUnits('20', 'gwei'),
        };
        const gasCost = BigInt(tx.gasLimit) * BigInt(tx.gasPrice);
        const totalRequired = ethAmountWei + gasCost;

        if (balance < totalRequired) {
          return res.status(400).json({
            error: 'Insufficient relayer balance',
            relayerAddress: relayerWallet.address,
            balance: ethers.formatEther(balance),
            required: ethers.formatEther(totalRequired),
          });
        }

        let ethTxResponse: any;
        // ── ETH send (retried via RetryEngine + SettlementFailureStore) ───
        ethTxResponse = await runWithSettlementRetry(
          'eth-send',
          ETH_SEND_RETRY,
          () => withTimeout(
            relayerWallet.sendTransaction(tx),
            RELAYER_CONFIG.rpcTimeoutMs,
            'RPC sendTransaction timeout',
          ),
          {
            orderId,
            direction: storedOrder?.direction ?? 'xlm_to_eth',
            chain: 'ethereum',
            recoveredTxHash: (r) => r.hash,
          },
        );
        // ── Retry histogram: eth_send ─────────────────────────────────────
        retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'success' }, 0);
        logger.info({ value: ethTxResponse.hash }, '≡ƒôñ ETH transaction sent:');
        logger.info('≡ƒîÉ View on Etherscan: https://sepolia.etherscan.io/tx/' + ethTxResponse.hash);
        
        if (storedOrder) {
          storedOrder.status = 'eth_tx_sent';
          storedOrder.ethTxHash = ethTxResponse.hash;
        }
        
        // ── Pipeline metrics: queue depth update after settlement ─────────
        orderQueueDepth.set(activeOrders.size);

        res.json({
          success: true,
          orderId,
          ethTxId: ethTxResponse.hash,
          message: 'XLMΓåÆETH transfer broadcasted',
          details: {
            stellar: { txHash: stellarTxHash, verifiedAmount: verifiedPayment.amount, status: 'confirmed' },
            ethereum: {
              txId: ethTxResponse.hash,
              amount: `${ethers.formatEther(ethAmountWei)} ETH`,
              destination: userEthAddress,
              status: 'pending',
            },
          },
        });
        
        logger.info('≡ƒÄë XLMΓåÆETH broadcasted successfully');
        
      } catch (ethError: any) {
        logger.error({ err: ethError }, 'Γ¥î ETH transaction failed:');
        logger.error({
          name: ethError.name,
          message: ethError.message,
          code: ethError.code,
          stack: ethError.stack,
          data: ethError.data
        }, 'Γ¥î Full ETH error details:');

        // ≡ƒåÿ AUTOMATIC XLM REFUND: User sent XLM but we couldn't send ETH.
        // Refund the XLM back to the user to prevent fund loss.
        // Uses refundXlmToUser + RefundLedger for exactly-once semantics.
        let refundResult: any = null;
        let refundError: any = null;
        let refundIsAmbiguous = false;

        if (relayerSecretKey && stellarAddress) {
          const claimed = globalRefundLedger.claim(orderId);
          if (!claimed) {
            const existingRefund = globalRefundLedger.getEntry(orderId);
            if (existingRefund?.state.phase === 'committed') {
              refundResult = { hash: existingRefund.state.txHash };
              storedOrder.status = 'refunded';
              storedOrder.refundTxHash = existingRefund.state.txHash;
            } else {
              refundError = `Refund already in-flight or ambiguous for orderId=${orderId}`;
            }
          } else {
            try {
              const refund = await refundXlmToUser({
                orderId,
                stellarAddress,
                stellarTxHash,
                networkMode: orderNetworkMode,
                horizonUrl,
                refundSecret: relayerSecretKey,
                fallbackStroops: verifiedPayment.amount,
                ledger: globalRefundLedger,
                maxRetries: 2,
              });
              refundResult = { hash: refund.hash };
              storedOrder.status = 'refunded';
              storedOrder.refundTxHash = refund.hash;
              logger.info(`✅ Automatic XLM refund: ${refund.hash} (${refund.amount} XLM)`);
            } catch (refundErr: any) {
              if (refundErr instanceof HorizonTimeoutError) {
                refundIsAmbiguous = true;
                refundError = `Horizon timeout: ${refundErr.message}`;
                storedOrder.watchdogFailedAt = Date.now();
                storedOrder.watchdogFailureReason = `horizon_timeout: ${refundErr.message}`;
                globalRefundLedger.markAmbiguous(orderId, refundErr.message);
              } else {
                globalRefundLedger.release(orderId);
                refundError = refundErr.message || 'Refund failed';
              }
              logger.error({ err: refundErr?.message ?? refundErr }, '[xlm-to-eth] automatic XLM refund failed');
            }
          }
        } else {
          refundError = relayerSecretKey ? 'Missing stellarAddress for refund' : `Relayer Stellar secret not configured for ${orderNetworkMode}`;
          logger.error({ err: refundError }, '[xlm-to-eth] cannot refund');
        }

        // ── Pipeline metrics: ETH send fatal failure (xlm-to-eth) ────────
        retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'failure' }, 0);
        droppedOrdersTotal.inc({ direction: 'xlm_to_eth', reason: 'eth_tx_failed' });
        // ── Settlement failure store ──────────────────────────────────────
        const xlmToEthFailCategory = classifyFailureCategory(ethError, 'ethereum');
        globalSettlementFailureStore.recordFailure({
          orderId,
          direction: storedOrder?.direction ?? 'xlm_to_eth',
          category: xlmToEthFailCategory,
          errorMessage: ethError.message,
          chain: 'ethereum',
          recoveryAction: 'XLM refund attempted automatically; watchdog will follow up',
        });

        return res.status(500).json({
          error: 'ETH release failed',
          details: ethError.message,
          errorCode: ethError.code,
          orderId,
          recoveryHint: 'Check /api/admin/settlement-failures for recovery status.',
          refund: refundResult
            ? { status: 'completed', stellarTxHash: refundResult.hash, message: 'Your XLM has been automatically refunded.' }
            : {
                status: refundIsAmbiguous ? 'ambiguous' : 'failed',
                error: refundError,
                message: refundIsAmbiguous
                  ? 'Refund status is ambiguous — the watchdog will confirm shortly.'
                  : 'Automatic refund failed. Please contact support with this order ID.',
                orderId,
                originalStellarTxHash: stellarTxHash,
              },
        });
      }
      }

    } catch (error: any) {
      logger.error({ err: error }, 'Γ¥î XLMΓåÆETH processing failed:');
      logger.error({ stack: error.stack }, '[xlm-to-eth] error stack trace');
      logger.error({
        message: error.message,
        name: error.name,
        code: error.code
      }, 'Γ¥î Error details:');
      
      res.status(500).json({
        error: 'XLMΓåÆETH processing failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // POST /api/orders/manual-refund - Manual XLM refund for failed XLMΓåÆETH orders
  // Allows users to recover XLM that was sent but ETH could not be released
  app.post('/api/orders/manual-refund', async (req, res) => {
    try {
      const { stellarTxHash, stellarAddress, networkMode, orderId: bodyOrderId } = req.body;

      if (!stellarTxHash || !stellarAddress) {
        return res.status(400).json({
          error: 'Missing required fields: stellarTxHash, stellarAddress'
        });
      }

      const refundNetwork: 'mainnet' | 'testnet' =
        networkMode === 'mainnet' ? 'mainnet' : 'testnet';

      // Derive a stable orderId for ledger keying. Prefer the caller-supplied
      // value; fall back to the stellarTxHash so the manual endpoint and the
      // watchdog share the same key when the order is in memory.
      const orderId = bodyOrderId ||
        (() => {
          for (const [id, o] of activeOrders.entries()) {
            if ((o as any).stellarTxHash === stellarTxHash) return id;
          }
          return stellarTxHash; // worst-case: key by tx hash
        })();

      logger.info({ stellarTxHash, stellarAddress, refundNetwork, orderId }, '🆘 Manual refund requested:');

      // ── Idempotency check ─────────────────────────────────────────────
      const existing = globalRefundLedger.getEntry(orderId);
      if (existing?.state.phase === 'committed') {
        return res.status(200).json({
          success: true,
          refundTxHash: existing.state.txHash,
          amount: existing.state.amount,
          destination: stellarAddress,
          network: refundNetwork,
          fromCache: true,
          message: 'Refund was already processed — returning committed result.'
        });
      }
      if (existing?.state.phase === 'in_flight' || existing?.state.phase === 'ambiguous') {
        return res.status(409).json({
          error: `Refund already ${existing.state.phase} for this order`,
          orderId,
          stellarTxHash,
          message: existing.state.phase === 'ambiguous'
            ? 'A previous refund attempt timed out. The watchdog is checking on-chain status. Try again in a few minutes.'
            : 'A refund is already in progress for this order. Please wait.'
        });
      }

      const horizonUrl = NETWORK_CONFIG[refundNetwork].stellar.horizonUrl;
      const relayerSecretKey = refundNetwork === 'mainnet'
        ? (process.env.RELAYER_STELLAR_SECRET_MAINNET || process.env.RELAYER_STELLAR_SECRET)
        : (process.env.RELAYER_STELLAR_SECRET_TESTNET || process.env.RELAYER_STELLAR_SECRET);

      if (!relayerSecretKey) {
        return res.status(500).json({
          error: 'Relayer Stellar secret not configured',
          network: refundNetwork
        });
      }

      // ── Verify the original tx was sent to this relayer ────────────────
      // We must verify before claiming the lock so we don't permanently
      // block a valid future attempt if the verification itself fails.
      const { Horizon, Keypair } = await import('@stellar/stellar-sdk');
      const server = new Horizon.Server(horizonUrl);
      const relayerKeypair = Keypair.fromSecret(relayerSecretKey);
      const relayerPublicKey = relayerKeypair.publicKey();

      let verifiedAmount: string;
      try {
        const ops = await server.operations().forTransaction(stellarTxHash).call();
        const paymentOp: any = ops.records.find((op: any) =>
          op.type === 'payment' &&
          op.to === relayerPublicKey &&
          op.asset_type === 'native' &&
          op.from === stellarAddress
        );

        if (!paymentOp) {
          return res.status(400).json({
            error: 'Original transaction does not match a payment from this stellar address to the relayer',
            details: 'The tx hash must be a native XLM payment from your stellar address to the relayer wallet'
          });
        }
        verifiedAmount = paymentOp.amount;
        logger.info(`💰 Verified original payment: ${verifiedAmount} XLM`);
      } catch (lookupErr: any) {
        return res.status(404).json({
          error: 'Could not verify original transaction',
          details: lookupErr.message
        });
      }

      // ── Claim the idempotency lock ─────────────────────────────────────
      const claimed = globalRefundLedger.claim(orderId);
      if (!claimed) {
        // Race: another concurrent request slipped in between our check and claim
        return res.status(409).json({
          error: 'Refund already in progress',
          orderId
        });
      }

      // ── Submit refund via refundXlmToUser ─────────────────────────────
      try {
        const refund = await refundXlmToUser({
          orderId,
          stellarAddress,
          stellarTxHash,
          networkMode: refundNetwork,
          horizonUrl,
          refundSecret: relayerSecretKey,
          // Pass the verified amount as stroops for exact math
          fallbackStroops: verifiedAmount,
          ledger: globalRefundLedger,
          maxRetries: 2,
        });

        // Sync the in-memory order if we have it
        const storedOrder = activeOrders.get(orderId) as any;
        if (storedOrder) {
          storedOrder.status = 'refunded';
          storedOrder.refundTxHash = refund.hash;
          storedOrder.refundedAt = Date.now();
        }

        logger.info({ value: refund.hash }, '✅ Manual refund successful:');

        return res.json({
          success: true,
          refundTxHash: refund.hash,
          amount: refund.amount,
          stroops: refund.stroops.toString(),
          destination: stellarAddress,
          network: refundNetwork,
          message: 'XLM successfully refunded to your wallet'
        });
      } catch (refundErr: any) {
        if (refundErr instanceof HorizonTimeoutError) {
          // Do not release the lock — tx may have landed; mark ambiguous
          globalRefundLedger.markAmbiguous(orderId, refundErr.message);
          return res.status(202).json({
            error: 'Refund submitted but outcome is ambiguous (Horizon timeout)',
            orderId,
            message: 'The refund transaction was submitted but Horizon did not confirm receipt. ' +
              'The watchdog will verify and complete it shortly. ' +
              'Please check again in a few minutes.',
          });
        }

        // Definitive failure — release so caller can retry
        globalRefundLedger.release(orderId);
        logger.error({ err: refundErr }, '❌ Manual refund failed:');
        return res.status(500).json({
          error: 'Manual refund failed',
          details: refundErr.message,
          errorName: refundErr.name
        });
      }
    } catch (err: any) {
      logger.error({ err: err }, '❌ Manual refund endpoint error:');
      res.status(500).json({
        error: 'Manual refund failed',
        details: err.message,
        errorName: err.name
      });
    }
  });

  logger.info('≡ƒôì DEBUG: Orders endpoints registered successfully');

  // Phase 6.5: EscrowFactory Event Listening (lazy ΓÇö first swap order only)
  startChainMonitoring = async () => {
  logger.info('≡ƒöù Chain monitoring starting (swap order in flight)...');
  
  // Setup EscrowFactory contract instance for event listening
  try {
    const provider = new ethers.JsonRpcProvider(RELAYER_CONFIG.ethereum.rpcUrl);
    const escrowFactoryContract = new ethers.Contract(getEscrowFactoryAddress(), getEscrowFactoryABI(DEFAULT_NETWORK_MODE === 'mainnet'), provider);
    
    // Get relayer wallet for proxy operations
    const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
    if (!relayerPrivateKey) {
      throw new Error(
        'RELAYER_PRIVATE_KEY is not set. Cannot start chain monitoring. ' +
        'Set RELAYER_PRIVATE_KEY in .env before starting.'
      );
    }
    const relayerWallet = new ethers.Wallet(relayerPrivateKey, provider);
    const relayerAddress = relayerWallet.address;
    
    logger.info({ value: relayerAddress }, '≡ƒöæ Relayer address for proxy operations:');
    
    // Skip authorization check to reduce API calls and avoid spam
    logger.info('≡ƒÆí To authorize relayer: POST /api/admin/authorize-relayer');
    logger.info('ΓÜá∩╕Å  Skipping authorization check to reduce API rate limit issues');
    
    // Monitor incoming ETH transfers to relayer ΓÇö only while an order
    // is waiting for the user's deposit. Uses prefetched block txs
    // (no per-tx getTransaction) and skips RPC entirely when idle.
    let lastProcessedBlock = await provider.getBlockNumber();

    chainPollers.push(
      startAdaptivePoll({
      label: 'eth-incoming',
      activeIntervalMs: RELAYER_CONFIG.activePollIntervalMs,
      idleIntervalMs: RELAYER_CONFIG.idlePollIntervalMs,
      isActive: () => hasPendingRelayerEscrow(activeOrders),
      isAttentive: () => hasRecentVisitor(),
      tick: async () => {
        const { payments, cursor } = await fetchIncomingEthPayments(
          provider,
          relayerAddress,
          lastProcessedBlock
        );
        lastProcessedBlock = cursor;

        for (const payment of payments) {
          logger.info({
            from: payment.from,
            value: ethers.formatEther(payment.value),
            hash: payment.hash,
          }, '≡ƒÆ░ Incoming ETH transfer detected:');

          for (const [orderId, orderData] of activeOrders.entries()) {
            if (orderData.ethAddress === payment.from && orderData.status === 'pending_relayer_escrow') {
              logger.info(`Γ£à Matched transfer to order ${orderId}`);
              await createEscrowForOrder(orderData, orderId, escrowFactoryContract, relayerWallet);
              break;
            }
          }
        }
      },
    }));

    // XLM Payment Monitoring for XLMΓåÆETH orders ΓÇö only while awaiting payment.
    logger.info('≡ƒîƒ Starting Stellar payment monitoring...');
    let lastProcessedStellarLedger = 0;

    chainPollers.push(startAdaptivePoll({
      label: 'stellar-incoming',
      activeIntervalMs: RELAYER_CONFIG.activePollIntervalMs,
      idleIntervalMs: RELAYER_CONFIG.idlePollIntervalMs,
      isActive: () => hasAwaitingXlmPayment(activeOrders),
      isAttentive: () => hasRecentVisitor(),
      tick: async () => {
        const networkMode = RELAYER_CONFIG.ethereum.network === 'mainnet' ? 'mainnet' : 'testnet';
        const stellarConfig = NETWORK_CONFIG[networkMode].stellar;
        const { Horizon } = await import('@stellar/stellar-sdk');
        const server = new Horizon.Server(stellarConfig.horizonUrl);
        
        const relayerStellarPublic = process.env.RELAYER_STELLAR_PUBLIC || 'YOUR_STELLAR_PUBLIC_KEY_HERE';
        
        const ledgerResponse = await server.ledgers().order('desc').limit(1).call();
        const currentLedger = parseInt(ledgerResponse.records[0].sequence.toString());
        
        if (lastProcessedStellarLedger === 0) {
          lastProcessedStellarLedger = currentLedger - 10;
          logger.info({ value: lastProcessedStellarLedger }, '≡ƒîƒ Stellar monitoring initialized, starting from ledger:');
          return;
        }
        
        const paymentsResponse = await server.payments()
          .forAccount(relayerStellarPublic)
          .cursor((lastProcessedStellarLedger * 4294967296).toString())
          .order('asc')
          .limit(50)
          .call();
        
        for (const payment of paymentsResponse.records) {
          if (payment.type === 'payment' && payment.asset_type === 'native' && payment.to === relayerStellarPublic) {
            logger.info({
              from: payment.from,
              amount: payment.amount,
              txHash: payment.transaction_hash
            }, '≡ƒÆ░ XLM payment detected:');
            
            const txResponse = await server.transactions().transaction(payment.transaction_hash).call();
            const memo = txResponse.memo;
            
            if (memo && memo.startsWith('XLM-ETH-')) {
              const orderPrefix = memo.replace('XLM-ETH-', '');
              logger.info({ memo, orderPrefix }, '[stellar-monitor] found XLM-to-ETH payment');
              
              for (const [orderId, orderData] of activeOrders.entries()) {
                if (orderId.includes(orderPrefix) && orderData.status === 'awaiting_xlm_payment') {
                  logger.info({ value: orderId }, 'Γ£à Matched XLM payment to order:');
                  
                  const expectedXLM = parseFloat(orderData.stellar.amount);
                  const receivedXLM = parseFloat(payment.amount);
                  
                  if (Math.abs(receivedXLM - expectedXLM) < 0.001) {
                    logger.info({ receivedXLM, expectedXLM, chain: 'stellar' }, '[stellar-monitor] XLM amount verified');
                    await createETHHTLCForOrder(orderData, orderId);
                  } else {
                    logger.warn({ receivedXLM, expectedXLM, chain: 'stellar' }, '[stellar-monitor] XLM amount mismatch');
                  }
                  break;
                }
              }
            }
          }
        }
        
        lastProcessedStellarLedger = currentLedger;
      },
    }));
    
    // Function to create ETH HTLC after XLM payment received
    async function createETHHTLCForOrder(orderData: any, orderId: string) {
      logger.info({ value: orderId }, '≡ƒÅ¡ Creating ETH HTLC for verified XLM payment:');
      
      try {
        const provider = new ethers.JsonRpcProvider(
          resolveEthereumRpcUrl(RELAYER_CONFIG.ethereum.network === 'mainnet' ? 'mainnet' : 'testnet')
        );
        const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY!, provider);
        
        // Check relayer balance first
        const relayerBalance = await provider.getBalance(relayerWallet.address);
        logger.info({ balance: ethers.formatEther(relayerBalance), chain: 'ethereum' }, '[chain-monitor] relayer ETH balance');
        
        const mainnetHTLCAddress = getHtlcBridgeAddress('mainnet');
        const mainnetHTLCContract = new ethers.Contract(mainnetHTLCAddress, [
          "function createOrder(address token, uint256 amount, bytes32 hashLock, uint256 timelock, address beneficiary, address refundAddress) external payable returns (bytes32 orderId)"
        ], relayerWallet);

        const ethAmountWei = BigInt(orderData.ethAmount);
        const timelockEth = Math.floor(Date.now() / 1000) + 7200; // 2 hours
        
        logger.info({
          orderData_ethAmount: orderData.ethAmount,
          ethAmountWei_string: ethAmountWei.toString(),
          ethAmountWei_formatted: ethers.formatEther(ethAmountWei),
          beneficiary: orderData.ethAddress,
          hashLock: orderData.hashLock,
          relayerAddress: relayerWallet.address,
          relayerBalance_ETH: ethers.formatEther(relayerBalance),
          contractAddress: mainnetHTLCAddress
        }, '≡ƒöó DETAILED ETH HTLC DEBUG:');

        // Check for insufficient balance
        const estimatedGasCost = ethers.parseEther("0.002"); // ~0.002 ETH for gas
        const totalRequired = ethAmountWei + estimatedGasCost;
        
        logger.info({
          required_ETH: ethers.formatEther(ethAmountWei),
          gas_estimate_ETH: ethers.formatEther(estimatedGasCost),
          total_required_ETH: ethers.formatEther(totalRequired),
          relayer_balance_ETH: ethers.formatEther(relayerBalance),
          has_sufficient_balance: relayerBalance >= totalRequired
        }, '≡ƒÆ░ Balance Check:');
        
        if (relayerBalance < totalRequired) {
          throw new Error(`Γ¥î Insufficient relayer balance! Need ${ethers.formatEther(totalRequired)} ETH, have ${ethers.formatEther(relayerBalance)} ETH`);
        }

        // Create ETH HTLC — retried via RetryEngine for rate-limit recovery
        const ethTx = await runWithSettlementRetry(
          'eth-send',
          ETH_SEND_RETRY,
          () => mainnetHTLCContract.createOrder(
            '0x0000000000000000000000000000000000000000', // ETH
            ethAmountWei,
            '0x' + orderData.hashLock,
            timelockEth,
            orderData.ethAddress,
            process.env.RELAYER_ETH_ADDRESS!,
            { value: ethAmountWei }
          ),
          { orderId, direction: 'xlm_to_eth', chain: 'ethereum' },
        );

        logger.info({ value: ethTx.hash }, '≡ƒô¥ ETH HTLC TX sent:');
        const ethReceipt = await ethTx.wait();
        logger.info({ value: orderId }, 'Γ£à ETH HTLC created successfully for order:');

        // Update order status
        orderData.status = 'eth_htlc_created';
        orderData.ethereum = {
          orderId: ethReceipt.logs[0]?.topics[1],
          txHash: ethTx.hash,
          contractAddress: mainnetHTLCAddress
        };
        
        logger.info('≡ƒÄë XLMΓåÆETH swap ready! User can now claim ETH (secret is stored server-side, not logged)');
        
      } catch (error) {
        logger.error({ orderId, err: error, chain: 'ethereum' }, '[chain-monitor] ETH HTLC creation failed');
        orderData.status = 'eth_htlc_failed';
      }
    }
    
    // Function to create escrow for order
    async function createEscrowForOrder(orderData: any, orderId: string, contract: ethers.Contract, wallet: ethers.Wallet) {
      try {
        logger.info(`≡ƒÅ¡ Creating escrow for order ${orderId}...`);
        
        // Calculate dynamic safety deposit for this escrow with network awareness
        const orderAmountBigInt = BigInt(orderData.amount);
        const orderNetworkMode = orderData.networkMode || DEFAULT_NETWORK_MODE;
        const actualSafetyDeposit = calculateDynamicSafetyDeposit(orderData.amount, orderNetworkMode);
        
        const totalValue = orderAmountBigInt + actualSafetyDeposit;
        const contractWithSigner = contract.connect(wallet) as any;
        let tx;
        
        // Dinamik method selection - Mainnet vs Testnet
        const isMainnetRequest = orderNetworkMode === 'mainnet';
        
        if (isMainnetRequest) {
                  // MAINNET: Use createDstEscrow (1inch cross-chain resolver pattern)
        logger.info('≡ƒÅ¡ MAINNET: Using createDstEscrow method (1inch pattern)...');
          
          // Generate order hash
          const orderHash = orderData.orderHash || ethers.keccak256(
            ethers.solidityPacked(
              ['address', 'uint256', 'bytes32', 'uint256'],
              [orderData.ethAddress, orderAmountBigInt, orderData.hashLock, Math.floor(Date.now() / 1000)]
            )
          );
          
          // Prepare createDstEscrow parameters according to 1inch pattern
          const srcChainId = 1; // Ethereum mainnet
          const dstChainId = 1; // Stellar (using 1 as placeholder)
          
          // Create order structure for 1inch createDstEscrow
          const order = {
            maker: orderData.ethAddress,
            taker: '0x0000000000000000000000000000000000000000', // Zero address
            makerAsset: '0x0000000000000000000000000000000000000000', // ETH
            takerAsset: '0x0000000000000000000000000000000000000000', // Target asset (placeholder)
            makingAmount: orderAmountBigInt,
            takingAmount: orderAmountBigInt, // 1:1 for bridge
            salt: ethers.randomBytes(32),
            extension: orderData.hashLock
          };
          
          // Create empty signature for createDstEscrow (will be filled by user)
          const signature = '0x';
          
          // Create taker traits
          const takerTraits = {
            extensionData: orderData.hashLock,
            safetyDeposit: actualSafetyDeposit,
            timelock: orderData.timelock || (Math.floor(Date.now() / 1000) + (2 * 60 * 60))
          };
          
                  // Call createDstEscrow method
        logger.info({
            srcChainId,
            orderHash: orderHash.substring(0, 10) + '...',
            makingAmount: ethers.formatEther(order.makingAmount),
            safetyDeposit: ethers.formatEther(actualSafetyDeposit)
          }, '≡ƒÜÇ Calling createDstEscrow with parameters:');
          
          // Use createDstEscrow method
          tx = await contractWithSigner.createDstEscrow(
            order,
            signature,
            takerTraits,
            order.makingAmount,
            orderData.hashLock,
            {
              value: totalValue,
              gasLimit: 3000000
            }
          );
        } else {
          // TESTNET: Use createEscrow
          logger.info('≡ƒÅ¡ TESTNET: Using createEscrow...');
          
          const escrowConfig = {
            token: '0x0000000000000000000000000000000000000000', // ETH
            amount: orderData.amount,
            hashLock: orderData.hashLock,
            timelock: orderData.timelock,
            beneficiary: orderData.ethAddress,
            refundAddress: orderData.ethAddress,
            safetyDeposit: actualSafetyDeposit.toString(),
            chainId: 11155111, // Sepolia
            stellarTxHash: ethers.ZeroHash,
            isPartialFillEnabled: orderData.partialFillEnabled || false
          };
          
          tx = await contractWithSigner.createEscrow(escrowConfig, {
            value: totalValue,
            gasLimit: 3000000
          });
        }
        
        logger.info(`≡ƒô¥ Escrow creation tx sent: ${tx.hash}`);
        const receipt = await tx.wait();
        logger.info(`Γ£à Escrow created successfully for order ${orderId}`);
        
        // Update order status
        orderData.status = 'escrow_created_by_relayer';
        orderData.escrowTxHash = tx.hash;
        
      } catch (error) {
        logger.error({ err: error }, `Γ¥î Failed to create escrow for order ${orderId}:`);
        orderData.status = 'escrow_creation_failed';
      }
    }
    
    // Dinamik event listeners - Mainnet vs Testnet
    //
    // Collected into `escrowFactoryEventBindings` instead of being
    // registered via `contract.on(...)`. Public RPCs (PublicNode, Ankr)
    // do not keep `eth_newFilter` state per upstream node, so the
    // built-in `.on` polling produces `filter not found` errors and
    // drops events. We hand the bindings to `startContractEventPoller`
    // below, which drives a single `queryFilter` poll loop instead.
    const isMainnetContract = DEFAULT_NETWORK_MODE === 'mainnet';
    const escrowFactoryEventBindings: ContractEventBinding[] = [];

    if (isMainnetContract) {
      // MAINNET: Ger├ºek 1inch events
      escrowFactoryEventBindings.push({ eventName: 'SrcEscrowCreated', handler: async (srcImmutables, dstImmutablesComplement, event) => {
        logger.info({
          orderHash: srcImmutables.orderHash,
          hashlock: srcImmutables.hashlock,
          maker: srcImmutables.maker.toString(),
          taker: srcImmutables.taker.toString(),
          amount: ethers.formatEther(srcImmutables.amount),
          safetyDeposit: ethers.formatEther(srcImmutables.safetyDeposit)
        }, '≡ƒÅ¡ MAINNET SrcEscrowCreated Event:');
        
        // Find related order and update status
        for (const [orderId, orderData] of activeOrders.entries()) {
          if (orderData.hashLock === srcImmutables.hashlock) {
            logger.info(`Γ£à Matched src escrow ${srcImmutables.orderHash} with order ${orderId}`);
            orderData.orderHash = srcImmutables.orderHash;
            orderData.status = 'src_escrow_created';
            break;
          }
        }
      }});

      escrowFactoryEventBindings.push({ eventName: 'DstEscrowCreated', handler: async (escrowAddress, hashlock, taker, event) => {
        logger.info({
          escrowAddress,
          hashlock,
          taker: taker.toString()
        }, '≡ƒÅ¡ MAINNET DstEscrowCreated Event:');

        // Find related order and update status
        for (const [orderId, orderData] of activeOrders.entries()) {
          if (orderData.hashLock === hashlock) {
            logger.info(`Γ£à Matched dst escrow ${escrowAddress} with order ${orderId}`);
            orderData.escrowAddress = escrowAddress;
            orderData.status = 'dst_escrow_created';
            break;
          }
        }
      }});
    } else {
      // TESTNET: Bizim custom events
      escrowFactoryEventBindings.push({ eventName: 'EscrowCreated', handler: async (escrowId, escrowAddress, resolver, token, amount, hashLock, timelock, safetyDeposit, chainId, event) => {
        logger.info({
          escrowId: escrowId.toString(),
          escrowAddress,
          resolver,
          token,
          amount: ethers.formatEther(amount),
          hashLock,
          chainId: chainId.toString(),
          safetyDeposit: ethers.formatEther(safetyDeposit)
        }, '≡ƒÅ¡ TESTNET EscrowCreated Event:');

        // Find related order and update status
        for (const [orderId, orderData] of activeOrders.entries()) {
          if (orderData.hashLock === hashLock) {
            logger.info(`Γ£à Matched escrow ${escrowId} with order ${orderId}`);
            orderData.escrowId = escrowId.toString();
            orderData.escrowAddress = escrowAddress;
            orderData.status = 'escrow_active';
            break;
          }
        }
      }});

      // Testnet EscrowFunded event
      escrowFactoryEventBindings.push({ eventName: 'EscrowFunded', handler: async (escrowId, funder, amount, safetyDeposit, event) => {
        logger.info({
          escrowId: escrowId.toString(),
          funder,
          amount: ethers.formatEther(amount),
          safetyDeposit: ethers.formatEther(safetyDeposit)
        }, '≡ƒÆ░ TESTNET EscrowFunded Event:');

        // Update related order status
        for (const [orderId, orderData] of activeOrders.entries()) {
          if (orderData.escrowId === escrowId.toString()) {
            logger.info(`Γ£à Escrow ${escrowId} funded for order ${orderId}`);
            orderData.status = 'escrow_funded';
            break;
          }
        }
      }});
    }

    if (escrowFactoryEventBindings.length > 0) {
      escrowFactoryPoller = await startContractEventPoller(
        escrowFactoryContract,
        provider,
        escrowFactoryEventBindings,
        {
          label: 'escrow-factory',
          intervalMs: RELAYER_CONFIG.activePollIntervalMs,
          idleIntervalMs: RELAYER_CONFIG.idlePollIntervalMs,
          isActive: () => needsChainMonitoring(activeOrders),
          isAttentive: () => hasRecentVisitor(),
        }
      );
    }

    logger.info('Γ£à EscrowFactory event listeners set up successfully');

    if (DEFAULT_NETWORK_MODE !== 'mainnet') {
      logger.info('≡ƒöä Starting EthereumEventListener for HTLCBridge monitoring');
      ethereumListener.configurePolling({
        isActive: () => needsChainMonitoring(activeOrders),
        isAttentive: () => hasRecentVisitor(),
      });
      await ethereumListener.startListening();
    }
  } catch (error) {
    logger.error({ err: error }, 'Γ¥î Failed to setup EscrowFactory events:');
    throw error;
  }
  };

  // Admin endpoints - must be inside initializeRelayer function
  
  // Admin endpoint to authorize relayer
  app.post('/api/admin/authorize-relayer', requireAdminAuth(), async (req, res) => {
    try {
      logger.info('≡ƒöÉ Authorizing relayer as resolver...');
      
      // Admin private key MUST come from the server environment, never from
      // the request body. Accepting secrets over the wire would expose them
      // in logs, proxies, and CDN caches.
      const adminPrivateKey = process.env.RELAYER_ADMIN_PRIVATE_KEY;
      if (!adminPrivateKey) {
        return res.status(500).json({
          success: false,
          error: 'RELAYER_ADMIN_PRIVATE_KEY is not configured on this server',
        });
      }
      
      const provider = new ethers.JsonRpcProvider(RELAYER_CONFIG.ethereum.rpcUrl);
      const adminWallet = new ethers.Wallet(adminPrivateKey, provider);
      const escrowFactoryContract = new ethers.Contract(getEscrowFactoryAddress(), getEscrowFactoryABI(DEFAULT_NETWORK_MODE === 'mainnet'), adminWallet);
      
      // Get relayer address — key must come from env, never a fallback.
      const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
      if (!relayerPrivateKey) {
        return res.status(503).json({
          success: false,
          error: 'RELAYER_PRIVATE_KEY is not configured on this server',
        });
      }
      const relayerWallet = new ethers.Wallet(relayerPrivateKey);
      const relayerAddress = relayerWallet.address;
      
      // Authorize relayer as resolver
      const contractWithSigner = escrowFactoryContract as any;
      const tx = await contractWithSigner.authorizeResolver(relayerAddress);
      
      logger.info(`≡ƒô¥ Authorization tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      logger.info(`Γ£à Relayer ${relayerAddress} authorized successfully`);
      
      res.json({
        success: true,
        relayerAddress,
        txHash: tx.hash,
        message: 'Relayer authorized as resolver'
      });
      
    } catch (error) {
      logger.error({ err: error }, 'Γ¥î Failed to authorize relayer:');
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        message: 'Relayer authorization failed'
      });
    }
  });

  // Check relayer authorization status
  app.get('/api/admin/relayer-status', requireAdminAuth(), async (req, res) => {
    try {
      const provider = new ethers.JsonRpcProvider(RELAYER_CONFIG.ethereum.rpcUrl);
      const escrowFactoryContract = new ethers.Contract(getEscrowFactoryAddress(), getEscrowFactoryABI(DEFAULT_NETWORK_MODE === 'mainnet'), provider);
      
      const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
      if (!relayerPrivateKey) {
        return res.status(503).json({
          success: false,
          error: 'RELAYER_PRIVATE_KEY is not configured on this server',
        });
      }
      const relayerWallet = new ethers.Wallet(relayerPrivateKey);
      const relayerAddress = relayerWallet.address;
      
      // Check authorization status
      const contractWithProvider = escrowFactoryContract as any;
      const isAuthorized = await contractWithProvider.authorizedResolvers(relayerAddress);
      
      res.json({
        success: true,
        relayerAddress,
        isAuthorized,
        status: isAuthorized ? 'Authorized' : 'Not Authorized',
        message: isAuthorized ? 'Relayer can create escrows' : 'Relayer needs authorization'
      });
      
    } catch (error) {
      logger.error({ err: error }, 'Γ¥î Failed to check relayer status:');
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        message: 'Status check failed'
      });
    }
  });

  // Check configured resolver allowlist authorization status
  app.get('/api/admin/resolvers', requireAdminAuth(), async (req, res) => {
    try {
      const provider = new ethers.JsonRpcProvider(RELAYER_CONFIG.ethereum.rpcUrl);
      const escrowFactoryContract = new ethers.Contract(getEscrowFactoryAddress(), getEscrowFactoryABI(DEFAULT_NETWORK_MODE === 'mainnet'), provider);

      const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
      if (!relayerPrivateKey) {
        return res.status(503).json({
          success: false,
          error: 'RELAYER_PRIVATE_KEY is not configured on this server',
        });
      }
      const relayerWallet = new ethers.Wallet(relayerPrivateKey);
      const relayerAddress = relayerWallet.address;

      const addresses = Array.from(new Set([
        relayerAddress,
        ...RELAYER_CONFIG.resolverAllowlist
      ])).filter(Boolean);

      const contractWithProvider = escrowFactoryContract as any;
      const results = await Promise.all(
        addresses.map(async (address) => ({
          address,
          isAuthorized: await contractWithProvider.authorizedResolvers(address)
        }))
      );

      res.json({
        success: true,
        resolvers: results
      });
    } catch (error) {
      logger.error({ err: error }, 'Γ¥î Failed to list resolvers:');
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        message: 'Resolver list failed'
      });
    }
  });

  logger.info('Γ£à Admin endpoints registered');

  // ── GET /api/admin/settlement-failures ───────────────────────────────────
  //
  // Returns all orders that have at least one recorded settlement failure.
  // Operators use this to:
  //   - Identify orders that failed mid-flow and need manual intervention.
  //   - Confirm that the recovery watchdog has already acted.
  //   - Filter by recovery status (pending / recovering / recovered / failed /
  //     requires_review) to prioritise manual actions.
  //
  // Query params:
  //   ?status=pending|recovering|recovered|failed|requires_review  (optional filter)
  //   ?limit=50                                                      (default 100)
  //
  // Response shape:
  //   { summary, records: OrderFailureRecord[] }
  app.get('/api/admin/settlement-failures', requireAdminAuth(), (_req, res) => {
    try {
      const statusFilter = typeof _req.query.status === 'string' ? _req.query.status : undefined;
      const limit = Math.min(parseInt(String(_req.query.limit ?? '100'), 10) || 100, 500);

      const all = globalSettlementFailureStore.all()
        .filter(r => !statusFilter || r.recoveryStatus === statusFilter)
        .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
        .slice(0, limit);

      res.json({
        summary: globalSettlementFailureStore.summary(),
        total: globalSettlementFailureStore.size(),
        filtered: all.length,
        records: all.map(r => ({
          orderId: r.orderId,
          direction: r.direction,
          recoveryStatus: r.recoveryStatus,
          failureCount: r.failureCount,
          recoveryAttempts: r.recoveryAttempts,
          firstFailedAt: new Date(r.firstFailedAt).toISOString(),
          lastUpdatedAt: new Date(r.lastUpdatedAt).toISOString(),
          terminalReason: r.terminalReason,
          recoveredTxHash: r.recoveredTxHash,
          // Last 3 events for brevity; full history is on disk.
          recentEvents: r.events.slice(-3).map(e => ({
            at: e.at,
            category: e.category,
            recoverability: e.recoverability,
            chain: e.chain,
            attempt: e.attempt,
            errorMessage: e.errorMessage,
            recoveryAction: e.recoveryAction,
          })),
        })),
      });
    } catch (err: any) {
      logger.error({ err: err }, 'Γ¥î /api/admin/settlement-failures failed:');
      res.status(500).json({ error: 'Failed to retrieve settlement failures', details: err.message });
    }
  });

  // ── GET /api/admin/settlement-failures/:orderId ──────────────────────────
  //
  // Returns the complete failure record for a single order including the full
  // event history. Useful when investigating a specific stuck order.
  app.get('/api/admin/settlement-failures/:orderId', requireAdminAuth(), (_req, res) => {
    try {
      const record = globalSettlementFailureStore.get(_req.params.orderId);
      if (!record) {
        return res.status(404).json({
          error: 'No failure record found for this orderId',
          orderId: _req.params.orderId,
        });
      }
      res.json({ record });
    } catch (err: any) {
      logger.error({ err: err }, 'Γ¥î /api/admin/settlement-failures/:orderId failed:');
      res.status(500).json({ error: 'Failed to retrieve failure record', details: err.message });
    }
  });

  logger.info('Γ£à Settlement failures endpoint registered');

  // ═══════════════════════════════════════════════════════════════════════════════════════
            // 1INCH ESCROW FACTORY ENDPOINTS - Using createDstEscrow approach
  // ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ

  // Get escrow factory information
  app.get('/api/escrow/info', async (req, res) => {
    try {
      logger.info('≡ƒÅ¡ Getting 1inch Escrow Factory info...');
      
      const escrowFactoryAddress = getEscrowFactoryAddress('mainnet');
      
      res.json({
        success: true,
        escrowFactory: escrowFactoryAddress,
                    method: 'createDstEscrow',
        note: 'Using 1inch cross-chain resolver pattern'
      });
      
    } catch (error: any) {
      logger.error({ err: error }, 'Γ¥î Failed to get escrow info:');
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  logger.info('Γ£à Escrow Factory endpoints registered');

  // ≡ƒ¢í∩╕Å Refund watchdog: rescue stuck XLMΓåÆETH orders that the request
  // loop failed to refund (e.g. user closed the tab, RPC outage past
  // our retry budget). Best-effort, never throws into the event loop.
  try {
    const watchdogNetwork: 'mainnet' | 'testnet' =
      (DEFAULT_NETWORK_MODE === 'mainnet' ? 'mainnet' : 'testnet');
    const watchdogHorizon =
      NETWORK_CONFIG[watchdogNetwork].stellar.horizonUrl;
    const watchdogSecret =
      watchdogNetwork === 'mainnet'
        ? (process.env.RELAYER_STELLAR_SECRET_MAINNET || process.env.RELAYER_STELLAR_SECRET)
        : (process.env.RELAYER_STELLAR_SECRET_TESTNET || process.env.RELAYER_STELLAR_SECRET);

    if (watchdogSecret) {
      startRefundWatchdog({
        horizonUrl: watchdogHorizon,
        refundSecret: watchdogSecret,
        networkMode: watchdogNetwork,
        activeOrders,
      });
    } else {
      logger.warn('ΓÜá∩╕Å Refund watchdog disabled: RELAYER_STELLAR_SECRET not configured.');
    }
  } catch (watchdogErr) {
    logger.error({ err: watchdogErr }, 'Γ¥î Failed to start refund watchdog:');
  }

  // Start HTTP server
  const server = app.listen(RELAYER_CONFIG.port, () => {
    logger.info(`≡ƒîÉ HTTP server started on port ${RELAYER_CONFIG.port}`);
  });
  
  logger.info('Γ£à Relayer service initialized successfully');
  logger.info('≡ƒÄ» Ready to process cross-chain swaps');
}

// Graceful shutdown handler
async function gracefulShutdown() {
  logger.info('\n≡ƒ¢æ Shutting down relayer service...');
  
  try {
    await ethereumListener.stopListening();
    logger.info('Γ£à Ethereum listener stopped');
  } catch (error) {
    logger.error({ err: error }, 'Γ¥î Error stopping Ethereum listener:');
  }
  
  logger.info('≡ƒæï Relayer service shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Create Express app globally
const app = express();

// Metrics endpoint
// Detailed metrics endpoint
app.get('/metrics', (req, res) => {
  try {
    const monitor = getMonitor();
    const metrics = monitor.getMetrics();
    res.json(metrics);
  } catch (error) {
    logger.error({ err: error }, 'Γ¥î Metrics fetch failed:');
    res.status(500).json({
      error: 'Failed to fetch metrics',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Uptime endpoint
app.get('/uptime', (req, res) => {
  try {
    const monitor = getMonitor();
    const metrics = monitor.getMetrics();
    res.json({
      uptime: metrics.uptime,
      startTime: metrics.timestamp - metrics.uptime,
      currentTime: metrics.timestamp,
      status: monitor.getSystemStatus()
    });
  } catch (error) {
    logger.error({ err: error }, 'Γ¥î Uptime check failed:');
    res.status(500).json({
      error: 'Failed to fetch uptime',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});






// Function to process Escrow deployment and send XLM to user
async function processEscrowToStellar(orderId: string, storedOrder: any) {
  logger.info(`≡ƒöä Processing Escrow ΓåÆ Stellar transfer for order ${orderId}...`);
  
  try {
    // Dynamic import Stellar SDK
    const { Horizon, Keypair, Asset, Operation, TransactionBuilder, Networks, BASE_FEE, Memo } = 
      await import('@stellar/stellar-sdk');
    
    // Setup Stellar network (mainnet for escrow orders)
    const stellarConfig = NETWORK_CONFIG.mainnet.stellar;
    const server = new Horizon.Server(stellarConfig.horizonUrl);
    
    logger.info('≡ƒöù Using Stellar Mainnet for escrow completion');
    
    // Relayer Stellar keys (mainnet specific)
    const relayerSecretKey = process.env.RELAYER_STELLAR_SECRET_MAINNET || process.env.RELAYER_STELLAR_SECRET;
    
    if (!relayerSecretKey || relayerSecretKey === 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') {
      throw new Error('Γ¥î CRITICAL: Relayer Stellar mainnet secret key not configured! Set RELAYER_STELLAR_SECRET_MAINNET in environment variables.');
    }
    
    const relayerKeypair = Keypair.fromSecret(relayerSecretKey);
    
    logger.info(`≡ƒöæ Using relayer public key (mainnet): ${relayerKeypair.publicKey()}`);
    const relayerAccount = await server.loadAccount(relayerKeypair.publicKey());
    
    const relayerBalance = relayerAccount.balances.find(b => b.asset_type === 'native')?.balance || '0';
    logger.info({ value: relayerBalance }, '≡ƒÆ░ Relayer XLM balance:');
    
    // Calculate XLM amount based on exchange rate
    const exchangeRate = storedOrder.exchangeRate || ETH_TO_XLM_RATE;
    const xlmAmount = (parseFloat(storedOrder.amount) * exchangeRate).toFixed(7);
    
    logger.info({ exchangeRate, direction: 'eth_to_xlm' }, '[escrow-to-stellar] exchange rate');
    logger.info({ value: storedOrder.stellarAddress }, '≡ƒÄ» Sending XLM to:');
    logger.info({ value: xlmAmount }, '≡ƒÆ░ XLM amount:');
    
    // Check if relayer has sufficient balance
    if (parseFloat(relayerBalance) < parseFloat(xlmAmount)) {
      throw new Error(`Γ¥î INSUFFICIENT FUNDS: Relayer has ${relayerBalance} XLM but needs ${xlmAmount} XLM. Please fund relayer wallet: ${relayerKeypair.publicKey()}`);
    }
    
    // Create payment to user on Stellar (simplified approach)
    const payment = Operation.payment({
      destination: storedOrder.stellarAddress,
      asset: Asset.native(),
      amount: xlmAmount
    });
    
    // Build transaction
    const transaction = new TransactionBuilder(relayerAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.PUBLIC // Mainnet
    })
      .addOperation(payment)
      .addMemo(Memo.text(`EscrowBridge:${orderId.substring(0, 20)}`))
      .setTimeout(300)
      .build();
    
    // Sign and submit
    transaction.sign(relayerKeypair);
    const result = await server.submitTransaction(transaction);
    
    logger.info({ value: result.hash }, 'Γ£à XLM payment sent:');
    logger.info({ txHash: result.hash, explorerUrl: `https://stellarchain.io/transactions/${result.hash}` }, '[escrow-to-stellar] view on explorer');
    
    // Update order status
    storedOrder.status = 'completed';
    storedOrder.stellarTxHash = result.hash;
    storedOrder.completedAt = new Date().toISOString();
    
    logger.info(`≡ƒÄë Escrow bridge completed for order ${orderId}!`);
    
  } catch (error) {
    logger.error({ err: error }, `Γ¥î Failed to process Escrow ΓåÆ Stellar transfer:`);
    
    // Update order status to error
    storedOrder.status = 'stellar_transfer_failed';
    storedOrder.error = error instanceof Error ? error.message : 'Unknown error';
  }
}

// Start relayer (always initialize when module loads)
  initializeRelayer().catch(error => {
    logger.error({ err: error }, 'Γ¥î Failed to initialize relayer:');
    process.exit(1);
  });

logger.info('≡ƒöä Relayer service configured and ready');

export default { RELAYER_CONFIG, initializeRelayer }; 