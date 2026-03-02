import 'dotenv/config';

/**
 * Centralised, typed configuration sourced from environment variables.
 * Copy .env.example → .env and fill in values before running.
 */
export const config = {
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/hl-indexer',

  /** HyperEVM JSON-RPC URL (mainnet chain ID 999) */
  hyperEvmRpcUrl: process.env.HYPEREVM_RPC_URL ?? 'https://hyperliquid.drpc.org',

  /** Hyperliquid REST API base */
  hlApiUrl: process.env.HL_API_URL ?? 'https://api.hyperliquid.xyz/info',

  /** Port for the Fastify REST API */
  apiPort: parseInt(process.env.API_PORT ?? '3000', 10),

  /**
   * Wallet addresses to index (lowercased for consistent comparison).
   * Defaults to the four wallets specified in the assessment.
   */
  wallets: (
    process.env.WALLETS ??
    [
      '0x30d83d444E230F652e2c62cb5697C8DaD503987b',
      '0x4F0A01BAdAa24F762CeE620883f16C4460c06Be0',
      '0xFaCC5b022641e9905bA3bac29b26E6d6191f2B8B',
      '0x97e7d0c24d485aa07e8218528f8dfcd00ac63f75',
    ].join(',')
  )
    .split(',')
    .map((w) => w.trim().toLowerCase()),

  /** Indexer: how often to poll Hyperliquid for each wallet (ms) */
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10),

  /** Matcher: how often to attempt resolving pending transfers (ms) */
  matcherIntervalMs: parseInt(process.env.MATCHER_INTERVAL_MS ?? '30000', 10),

  /**
   * How far ahead of the HL timestamp to search for the EVM counterpart.
   * The bridge usually settles in seconds; 10 minutes covers edge cases.
   */
  evmSearchWindowMs: parseInt(process.env.EVM_SEARCH_WINDOW_MS ?? '600000', 10),

  /** Give up matching after this many failed attempts */
  maxRetries: parseInt(process.env.MAX_RETRIES ?? '5', 10),

  /** Minimum wait between matcher retries for the same record (ms) */
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS ?? '120000', 10),
} as const;

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function validateConfig(): void {
  for (const wallet of config.wallets) {
    if (!ETH_ADDRESS_RE.test(wallet)) {
      throw new Error(`[Config] Invalid Ethereum address in WALLETS: "${wallet}"`);
    }
  }

  const numericFields: Array<[string, number]> = [
    ['API_PORT', config.apiPort],
    ['POLL_INTERVAL_MS', config.pollIntervalMs],
    ['MATCHER_INTERVAL_MS', config.matcherIntervalMs],
    ['EVM_SEARCH_WINDOW_MS', config.evmSearchWindowMs],
    ['MAX_RETRIES', config.maxRetries],
    ['RETRY_DELAY_MS', config.retryDelayMs],
  ];

  for (const [name, value] of numericFields) {
    if (isNaN(value)) {
      throw new Error(`[Config] ${name} must be a valid number, got: "${process.env[name]}"`);
    }
  }
}
