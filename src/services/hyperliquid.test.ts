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

  it('returns false when delta type is not "send"', () => {
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
