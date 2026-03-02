import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { SpotToken } from './token-cache';

// ---------------------------------------------------------------------------
// vi.mock factories are hoisted to the top of the file before any variable
// declarations, so the token fixtures cannot be referenced inside the factory.
// The mock data is inlined here; equivalent constants are declared below for
// use in test assertions (getEvmDecimals is a pure function so this is safe).
// ---------------------------------------------------------------------------

vi.mock('./hl-client', () => ({
  infoClient: {
    spotMeta: vi.fn().mockResolvedValue({
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
    }),
  },
}));

import { initTokenCache, getTokenInfo, getEvmDecimals, getSystemAddress } from './token-cache';

// ---------------------------------------------------------------------------
// Constants for getEvmDecimals assertions (not referenced in vi.mock factory)
// ---------------------------------------------------------------------------

const UETH_TOKEN: SpotToken = {
  name: 'UETH',
  tokenId: '0xe1edd30daaf5caac3fe63569e24748da',
  szDecimals: 8,
  weiDecimals: 8,
  maxSupply: '0',
  totalSupply: '0',
  deployGas: '0',
  deployState: 'genesis',
  evmContract: { address: '0xBe6727B535545C67d5cAa73dEA6A861ac28A3540', evm_extra_wei_decimals: 10 },
  fullName: null,
  isCanonical: true,
  spots: [],
};

const HYPE_TOKEN: SpotToken = {
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
};

const USDC_TOKEN: SpotToken = {
  name: 'USDC',
  tokenId: '0xusdctoken',
  szDecimals: 6,
  weiDecimals: 6,
  maxSupply: '0',
  totalSupply: '0',
  deployGas: '0',
  deployState: 'genesis',
  evmContract: { address: '0xusdc', evm_extra_wei_decimals: 0 },
  fullName: null,
  isCanonical: true,
  spots: [],
};

// ---------------------------------------------------------------------------
// getEvmDecimals — pure function, no cache needed
// ---------------------------------------------------------------------------

describe('getEvmDecimals', () => {
  it('returns 18 for native HYPE which has no evmContract', () => {
    expect(getEvmDecimals(HYPE_TOKEN)).toBe(18);
  });

  it('adds weiDecimals + evm_extra_wei_decimals for an ERC-20 token', () => {
    // UETH: weiDecimals(8) + evm_extra_wei_decimals(10) = 18
    expect(getEvmDecimals(UETH_TOKEN)).toBe(18);
  });

  it('returns just weiDecimals when evm_extra_wei_decimals is 0', () => {
    // USDC: weiDecimals(6) + 0 = 6
    expect(getEvmDecimals(USDC_TOKEN)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// getTokenInfo — requires an initialised cache
// ---------------------------------------------------------------------------

describe('getTokenInfo', () => {
  beforeAll(async () => {
    await initTokenCache();
  });

  it('returns token metadata when looked up by "name:tokenId" format', async () => {
    const token = await getTokenInfo('UETH:0xe1edd30daaf5caac3fe63569e24748da');
    expect(token?.name).toBe('UETH');
    expect(token?.evmContract?.evm_extra_wei_decimals).toBe(10);
  });

  it('finds a token by name alone when no tokenId is provided', async () => {
    const token = await getTokenInfo('HYPE');
    expect(token?.name).toBe('HYPE');
    expect(token?.evmContract).toBeNull();
  });

  it('prefers tokenId lookup over name lookup', async () => {
    // Providing the correct tokenId for UETH should return UETH regardless of the name prefix
    const token = await getTokenInfo('ANYTHING:0xe1edd30daaf5caac3fe63569e24748da');
    expect(token?.name).toBe('UETH');
  });

  it('returns null for an unknown token', async () => {
    const token = await getTokenInfo('DOESNOTEXIST:0xdeadbeef');
    expect(token).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSystemAddress — synchronous, requires initialised cache
// ---------------------------------------------------------------------------

describe('getSystemAddress', () => {
  // Cache is already warm from the getTokenInfo beforeAll above.
  // Token order in the mock: index 0 = UETH, index 1 = HYPE, index 2 = USDC

  it('returns 0x20 + zero-padded index for a regular ERC-20 token at index 0', () => {
    const addr = getSystemAddress('UETH:0xe1edd30daaf5caac3fe63569e24748da');
    expect(addr).toBe('0x2000000000000000000000000000000000000000');
  });

  it('returns the hardcoded HYPE system address regardless of array index', () => {
    const addr = getSystemAddress('HYPE');
    expect(addr).toBe('0x2222222222222222222222222222222222222222');
  });

  it('returns the correct index-derived address for a token at index 2', () => {
    // USDC is the third token (index 2 → 0x02)
    const addr = getSystemAddress('USDC:0xusdctoken');
    expect(addr).toBe('0x2000000000000000000000000000000000000002');
  });

  it('resolves by name alone when no tokenId suffix is present', () => {
    const byName = getSystemAddress('UETH');
    const byFull = getSystemAddress('UETH:0xe1edd30daaf5caac3fe63569e24748da');
    expect(byName).toBe(byFull);
  });

  it('returns null for an unknown token', () => {
    expect(getSystemAddress('UNKNOWN:0xdeadbeef')).toBeNull();
  });
});
