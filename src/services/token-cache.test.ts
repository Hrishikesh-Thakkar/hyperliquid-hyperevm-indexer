import { describe, it, expect, beforeAll, vi } from 'vitest';
import { TokenCache, type SpotToken } from './token-cache';

// ---------------------------------------------------------------------------
// Mock Hyperliquid client
// ---------------------------------------------------------------------------

const MOCK_SPOT_META = {
  tokens: [
    {
      name: 'UETH',
      tokenId: '0xe1edd30daaf5caac3fe63569e24748da',
      szDecimals: 8,
      weiDecimals: 8,
      maxSupply: '0',
      totalSupply: '0',
      deployGas: '0',
      deployState: 'genesis',
      evmContract: {
        address: '0xBe6727B535545C67d5cAa73dEA6A861ac28A3540',
        evm_extra_wei_decimals: 10,
      },
      fullName: null,
      isCanonical: true,
      spots: [],
    },
    {
      name: 'HYPE',
      tokenId: '0xhypetoken',
      szDecimals: 8,
      weiDecimals: 8,
      maxSupply: '0',
      totalSupply: '0',
      deployGas: '0',
      deployState: 'genesis',
      evmContract: null,
      fullName: null,
      isCanonical: true,
      spots: [],
    },
    {
      name: 'USDC',
      tokenId: '0xusdctoken',
      szDecimals: 6,
      weiDecimals: 6,
      maxSupply: '0',
      totalSupply: '0',
      deployGas: '0',
      deployState: 'genesis',
      evmContract: {
        address: '0xusdc',
        evm_extra_wei_decimals: 0,
      },
      fullName: null,
      isCanonical: true,
      spots: [],
    },
  ],
  universe: [],
};

const mockHlClient = {
  spotMeta: vi.fn().mockResolvedValue(MOCK_SPOT_META),
} as any;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

// ---------------------------------------------------------------------------
// Constants for getEvmDecimals assertions
// ---------------------------------------------------------------------------

const UETH_TOKEN: SpotToken = MOCK_SPOT_META.tokens[0] as any;
const HYPE_TOKEN: SpotToken = MOCK_SPOT_META.tokens[1] as any;
const USDC_TOKEN: SpotToken = MOCK_SPOT_META.tokens[2] as any;

// ---------------------------------------------------------------------------
// Shared instance
// ---------------------------------------------------------------------------

let tokenCache: TokenCache;

beforeAll(async () => {
  tokenCache = new TokenCache(mockHlClient, mockLogger);
  await tokenCache.init();
});

// ---------------------------------------------------------------------------
// getEvmDecimals — pure function, no cache needed
// ---------------------------------------------------------------------------

describe('getEvmDecimals', () => {
  it('returns 18 for native HYPE which has no evmContract', () => {
    expect(tokenCache.getEvmDecimals(HYPE_TOKEN)).toBe(18);
  });

  it('adds weiDecimals + evm_extra_wei_decimals for an ERC-20 token', () => {
    expect(tokenCache.getEvmDecimals(UETH_TOKEN)).toBe(18);
  });

  it('returns just weiDecimals when evm_extra_wei_decimals is 0', () => {
    expect(tokenCache.getEvmDecimals(USDC_TOKEN)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// getTokenInfo — requires an initialised cache
// ---------------------------------------------------------------------------

describe('getTokenInfo', () => {
  it('returns token metadata when looked up by "name:tokenId" format', async () => {
    const token = await tokenCache.getTokenInfo('UETH:0xe1edd30daaf5caac3fe63569e24748da');
    expect(token?.name).toBe('UETH');
    expect(token?.evmContract?.evm_extra_wei_decimals).toBe(10);
  });

  it('finds a token by name alone when no tokenId is provided', async () => {
    const token = await tokenCache.getTokenInfo('HYPE');
    expect(token?.name).toBe('HYPE');
    expect(token?.evmContract).toBeNull();
  });

  it('prefers tokenId lookup over name lookup', async () => {
    const token = await tokenCache.getTokenInfo('ANYTHING:0xe1edd30daaf5caac3fe63569e24748da');
    expect(token?.name).toBe('UETH');
  });

  it('returns null for an unknown token', async () => {
    const token = await tokenCache.getTokenInfo('DOESNOTEXIST:0xdeadbeef');
    expect(token).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSystemAddress — synchronous, requires initialised cache
// ---------------------------------------------------------------------------

describe('getSystemAddress', () => {
  it('returns 0x20 + zero-padded index for a regular ERC-20 token at index 0', () => {
    const addr = tokenCache.getSystemAddress('UETH:0xe1edd30daaf5caac3fe63569e24748da');
    expect(addr).toBe('0x2000000000000000000000000000000000000000');
  });

  it('returns the hardcoded HYPE system address regardless of array index', () => {
    const addr = tokenCache.getSystemAddress('HYPE');
    expect(addr).toBe('0x2222222222222222222222222222222222222222');
  });

  it('returns the correct index-derived address for a token at index 2', () => {
    const addr = tokenCache.getSystemAddress('USDC:0xusdctoken');
    expect(addr).toBe('0x2000000000000000000000000000000000000002');
  });

  it('resolves by name alone when no tokenId suffix is present', () => {
    const byName = tokenCache.getSystemAddress('UETH');
    const byFull = tokenCache.getSystemAddress('UETH:0xe1edd30daaf5caac3fe63569e24748da');
    expect(byName).toBe(byFull);
  });

  it('returns null for an unknown token', () => {
    expect(tokenCache.getSystemAddress('UNKNOWN:0xdeadbeef')).toBeNull();
  });
});
