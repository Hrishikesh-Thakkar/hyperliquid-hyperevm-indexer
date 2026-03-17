import type { SpotMetaResponse } from '@nktkas/hyperliquid';
import { infoClient } from './hl-client';
import { logger } from '../logger';

// Re-export the SDK token type so the rest of the codebase can reference it
export type SpotToken = SpotMetaResponse['tokens'][number];

// ---------------------------------------------------------------------------
// In-memory cache with periodic refresh
// ---------------------------------------------------------------------------

/** Keyed by lowercase tokenId AND lowercase symbol for fast lookup by either */
let cache: Map<string, SpotToken> = new Map();

/**
 * Maps lowercase tokenId / lowercase symbol → expected system address on HyperEVM.
 *
 * System address derivation rules (from Hyperliquid docs):
 *   - Regular tokens: 0x20 + token-array-index encoded as big-endian in the
 *     remaining 19 bytes.  e.g. token at index 200 (0xc8) →
 *     0x20000000000000000000000000000000000000c8
 *   - HYPE (native gas token): hardcoded 0x2222222222222222222222222222222222222222
 *
 * This is used by the indexer to distinguish genuine bridge transfers
 * (destination === system address) from plain P2P Hypercore transfers.
 */
let systemAddressMap: Map<string, string> = new Map();

let cacheRefreshedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000 * 24; // refresh every 24 hours

const HYPE_SYSTEM_ADDRESS = '0x2222222222222222222222222222222222222222';

/** Derives the HyperEVM system address for a token at the given spot-meta array index. */
function computeSystemAddress(tokenIndex: number, tokenName: string): string {
  if (tokenName === 'HYPE') return HYPE_SYSTEM_ADDRESS;
  // 0x20 (1 byte) + token index right-aligned in the remaining 19 bytes (38 hex chars)
  return `0x20${tokenIndex.toString(16).padStart(38, '0')}`;
}

async function refreshCache(): Promise<void> {
  const data = await infoClient.spotMeta();
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

  cache = nextCache;
  systemAddressMap = nextSystemAddresses;
  cacheRefreshedAt = Date.now();
  logger.info({ tokenCount: data.tokens.length }, '[TokenCache] Refreshed');
}

/** Call once at startup to pre-warm the cache. */
export async function initTokenCache(): Promise<void> {
  await refreshCache();
}

/**
 * Look up a Hyperliquid spot token by its action token string.
 *
 * @param hlTokenString  e.g. "UETH:0xe1edd30daaf5caac3fe63569e24748da" or just "HYPE"
 * @returns SpotToken metadata or null if not found
 */
export async function getTokenInfo(hlTokenString: string): Promise<SpotToken | null> {
  // Refresh cache if stale
  if (Date.now() - cacheRefreshedAt > CACHE_TTL_MS) {
    try {
      await refreshCache();
    } catch (err) {
      logger.warn({ err }, '[TokenCache] Failed to refresh; using stale cache');
    }
  }

  const colonIdx = hlTokenString.indexOf(':');
  const name = colonIdx > -1 ? hlTokenString.slice(0, colonIdx) : hlTokenString;
  const tokenId = colonIdx > -1 ? hlTokenString.slice(colonIdx + 1) : null;

  // Prefer lookup by tokenId (more specific); fall back to name
  return (
    (tokenId && cache.get(tokenId.toLowerCase())) ||
    cache.get(name.toLowerCase()) ||
    null
  );
}

/**
 * Returns the expected HyperEVM system address for a spot token.
 *
 * Must be called after getTokenInfo() so the cache is guaranteed to be fresh.
 * Returns null if the token is not found in the cache.
 */
export function getSystemAddress(hlTokenString: string): string | null {
  const colonIdx = hlTokenString.indexOf(':');
  const name = colonIdx > -1 ? hlTokenString.slice(0, colonIdx) : hlTokenString;
  const tokenId = colonIdx > -1 ? hlTokenString.slice(colonIdx + 1) : null;

  return (
    (tokenId && systemAddressMap.get(tokenId.toLowerCase())) ||
    systemAddressMap.get(name.toLowerCase()) ||
    null
  );
}

/**
 * Returns the total EVM token decimals for a spot token.
 * For native HYPE (no evmContract) defaults to 18.
 */
export function getEvmDecimals(token: SpotToken): number {
  if (!token.evmContract) return 18; // native HYPE — no ERC-20
  return token.weiDecimals + token.evmContract.evm_extra_wei_decimals;
}
