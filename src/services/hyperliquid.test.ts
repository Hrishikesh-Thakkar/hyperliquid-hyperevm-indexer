import { describe, it, expect, vi } from 'vitest';

// Prevent the module from trying to connect to the Hyperliquid API at import time
vi.mock('./hl-client', () => ({ infoClient: {} }));

import { isBridgeSend } from './hyperliquid';

// ---------------------------------------------------------------------------
// Minimal fixture builder — only the fields isBridgeSend actually inspects
// ---------------------------------------------------------------------------

function makeEntry(deltaOverrides: Record<string, unknown> = {}): Parameters<typeof isBridgeSend>[0] {
  return {
    time: 1_700_000_000_000,
    hash: '0xabcdef',
    delta: {
      type: 'send',
      sourceDex: 'spot',
      destinationDex: 'spot',
      user: '0x1234',
      destination: '0x2020',
      token: 'UETH:0xabc',
      amount: '1.0',
      startPosition: null,
      fee: '0',
      ...deltaOverrides,
    },
  } as Parameters<typeof isBridgeSend>[0];
}

describe('isBridgeSend', () => {
  it('returns true for a valid spot → spot bridge send', () => {
    expect(isBridgeSend(makeEntry())).toBe(true);
  });

  it('returns true for spotTransfer with token USDC (USDC bridge)', () => {
    expect(
      isBridgeSend({
        time: 1_700_000_000_000,
        hash: '0xabcdef',
        delta: {
          type: 'spotTransfer',
          token: 'USDC',
          amount: '10.0',
          usdcValue: '10.0',
          user: '0xcf03287a85298166522002c97ae4b1556ff026b3',
          destination: '0x2000000000000000000000000000000000000000',
          fee: '0.000607',
          nativeTokenFee: '0.0',
          nonce: 1772441118196,
          feeToken: 'USDC',
        },
      } as Parameters<typeof isBridgeSend>[0]),
    ).toBe(true);
  });

  it('returns false for spotTransfer when token is not USDC', () => {
    expect(
      isBridgeSend({
        time: 1_700_000_000_000,
        hash: '0xabcdef',
        delta: {
          type: 'spotTransfer',
          token: 'UETH',
          amount: '1.0',
          usdcValue: '1.0',
          user: '0x1234',
          destination: '0x2000000000000000000000000000000000000000',
          fee: '0',
          nativeTokenFee: '0.0',
          nonce: null,
          feeToken: 'USDC',
        },
      } as Parameters<typeof isBridgeSend>[0]),
    ).toBe(false);
  });

  it('returns false when delta type is neither "send" nor "spotTransfer"', () => {
    expect(isBridgeSend(makeEntry({ type: 'deposit' }))).toBe(false);
  });

  it('returns false when sourceDex is not "spot"', () => {
    expect(isBridgeSend(makeEntry({ sourceDex: 'perp' }))).toBe(false);
  });

  it('returns false when destinationDex is not "spot"', () => {
    expect(isBridgeSend(makeEntry({ destinationDex: 'perp' }))).toBe(false);
  });

  it('returns false when both dexes are wrong', () => {
    expect(isBridgeSend(makeEntry({ sourceDex: 'perp', destinationDex: 'perp' }))).toBe(false);
  });
});
