import type { SpotMetaResponse } from '@nktkas/hyperliquid';
import { infoClient } from './hl-client';

// Re-export the SDK token type so the rest of the codebase can reference it
export type SpotToken = SpotMetaResponse['tokens'][number];

// ---------------------------------------------------------------------------
// In-memory cache with periodic refresh
// ---------------------------------------------------------------------------

/** Keyed by lowercase tokenId AND lowercase symbol for fast lookup by either */
let cache: Map<string, SpotToken> = new Map();
let cacheRefreshedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000 * 24; // refresh every 24 hours

async function refreshCache(): Promise<void> {
  const data = await infoClient.spotMeta();
  const next = new Map<string, SpotToken>();

  for (const token of data.tokens) {
    next.set(token.tokenId.toLowerCase(), token);
    next.set(token.name.toLowerCase(), token);
  }

  cache = next;
  cacheRefreshedAt = Date.now();
  console.log(`[TokenCache] Refreshed — ${data.tokens.length} tokens loaded`);
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
      console.warn('[TokenCache] Failed to refresh; using stale cache:', err);
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
 * Returns the total EVM token decimals for a spot token.
 * For native HYPE (no evmContract) defaults to 18.
 */
export function getEvmDecimals(token: SpotToken): number {
  if (!token.evmContract) return 18; // native HYPE — no ERC-20
  return token.weiDecimals + token.evmContract.evm_extra_wei_decimals;
}
