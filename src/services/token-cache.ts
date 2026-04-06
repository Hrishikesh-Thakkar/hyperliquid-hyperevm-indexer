import type { SpotMetaResponse, InfoClient } from '@nktkas/hyperliquid';
import type { Logger } from '../logger';

// Re-export the SDK token type so the rest of the codebase can reference it
export type SpotToken = SpotMetaResponse['tokens'][number];

const CACHE_TTL_MS = 60 * 60 * 1000 * 24; // refresh every 24 hours
const HYPE_SYSTEM_ADDRESS = '0x2222222222222222222222222222222222222222';

/** Derives the HyperEVM system address for a token at the given spot-meta array index. */
function computeSystemAddress(tokenIndex: number, tokenName: string): string {
  if (tokenName === 'HYPE') return HYPE_SYSTEM_ADDRESS;
  // 0x20 (1 byte) + token index right-aligned in the remaining 19 bytes (38 hex chars)
  return `0x20${tokenIndex.toString(16).padStart(38, '0')}`;
}

/**
 * In-memory token metadata cache with periodic refresh.
 *
 * Holds spotMeta data from the Hyperliquid API and derives system addresses
 * for bridge transfer validation.
 */
export class TokenCache {
  /** Keyed by lowercase tokenId AND lowercase symbol for fast lookup by either */
  private cache: Map<string, SpotToken> = new Map();
  private systemAddressMap: Map<string, string> = new Map();
  private cacheRefreshedAt = 0;

  constructor(
    private hlClient: InfoClient,
    private logger: Logger,
  ) {}

  /** Call once at startup to pre-warm the cache. */
  async init(): Promise<void> {
    await this.refreshCache();
  }

  /**
   * Look up a Hyperliquid spot token by its action token string.
   *
   * @param hlTokenString  e.g. "UETH:0xe1edd30daaf5caac3fe63569e24748da" or just "HYPE"
   * @returns SpotToken metadata or null if not found
   */
  async getTokenInfo(hlTokenString: string): Promise<SpotToken | null> {
    // Refresh cache if stale
    if (Date.now() - this.cacheRefreshedAt > CACHE_TTL_MS) {
      try {
        await this.refreshCache();
      } catch (err) {
        this.logger.warn({ err }, '[TokenCache] Failed to refresh; using stale cache');
      }
    }

    const colonIdx = hlTokenString.indexOf(':');
    const name = colonIdx > -1 ? hlTokenString.slice(0, colonIdx) : hlTokenString;
    const tokenId = colonIdx > -1 ? hlTokenString.slice(colonIdx + 1) : null;

    return (
      (tokenId && this.cache.get(tokenId.toLowerCase())) ||
      this.cache.get(name.toLowerCase()) ||
      null
    );
  }

  /**
   * Returns the expected HyperEVM system address for a spot token.
   * Returns null if the token is not found in the cache.
   */
  getSystemAddress(hlTokenString: string): string | null {
    const colonIdx = hlTokenString.indexOf(':');
    const name = colonIdx > -1 ? hlTokenString.slice(0, colonIdx) : hlTokenString;
    const tokenId = colonIdx > -1 ? hlTokenString.slice(colonIdx + 1) : null;

    return (
      (tokenId && this.systemAddressMap.get(tokenId.toLowerCase())) ||
      this.systemAddressMap.get(name.toLowerCase()) ||
      null
    );
  }

  /**
   * Returns the total EVM token decimals for a spot token.
   * For native HYPE (no evmContract) defaults to 18.
   */
  getEvmDecimals(token: SpotToken): number {
    if (!token.evmContract) return 18; // native HYPE — no ERC-20
    return token.weiDecimals + token.evmContract.evm_extra_wei_decimals;
  }

  private async refreshCache(): Promise<void> {
    const data = await this.hlClient.spotMeta();
    const nextCache = new Map<string, SpotToken>();
    const nextSystemAddresses = new Map<string, string>();

    for (let i = 0; i < data.tokens.length; i++) {
      const token = data.tokens[i];
      const systemAddress = computeSystemAddress(i, token.name);

      nextCache.set(token.tokenId.toLowerCase(), token);
      nextCache.set(token.name.toLowerCase(), token);

      nextSystemAddresses.set(token.tokenId.toLowerCase(), systemAddress);
      nextSystemAddresses.set(token.name.toLowerCase(), systemAddress);
    }

    this.cache = nextCache;
    this.systemAddressMap = nextSystemAddresses;
    this.cacheRefreshedAt = Date.now();
    this.logger.info({ tokenCount: data.tokens.length }, '[TokenCache] Refreshed');
  }
}
