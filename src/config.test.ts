import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * validateConfig() reads from the module-level `config` object which is
 * computed at import time from process.env.  To test different values we
 * reset the module cache (vi.resetModules) and use vi.stubEnv to inject
 * specific env vars before each dynamic import.
 */

describe('validateConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('passes with all valid default addresses', async () => {
    const { validateConfig } = await import('./config');
    expect(() => validateConfig()).not.toThrow();
  });

  it('passes with a single valid checksummed address', async () => {
    vi.stubEnv('WALLETS', '0x30d83d444E230F652e2c62cb5697C8DaD503987b');
    const { validateConfig } = await import('./config');
    expect(() => validateConfig()).not.toThrow();
  });

  it('passes with multiple valid addresses', async () => {
    vi.stubEnv(
      'WALLETS',
      '0x30d83d444E230F652e2c62cb5697C8DaD503987b,0x4F0A01BAdAa24F762CeE620883f16C4460c06Be0',
    );
    const { validateConfig } = await import('./config');
    expect(() => validateConfig()).not.toThrow();
  });

  it('throws when WALLETS contains a plain string', async () => {
    vi.stubEnv('WALLETS', 'not-an-address');
    const { validateConfig } = await import('./config');
    expect(() => validateConfig()).toThrow('Invalid Ethereum address');
    expect(() => validateConfig()).toThrow('"not-an-address"');
  });

  it('throws when WALLETS contains an address that is too short', async () => {
    vi.stubEnv('WALLETS', '0x1234');
    const { validateConfig } = await import('./config');
    expect(() => validateConfig()).toThrow('Invalid Ethereum address');
  });

  it('throws when WALLETS contains an address missing the 0x prefix', async () => {
    vi.stubEnv('WALLETS', '30d83d444E230F652e2c62cb5697C8DaD503987b');
    const { validateConfig } = await import('./config');
    expect(() => validateConfig()).toThrow('Invalid Ethereum address');
  });

  it('throws when API_PORT is not a number', async () => {
    vi.stubEnv('API_PORT', 'not-a-port');
    const { validateConfig } = await import('./config');
    expect(() => validateConfig()).toThrow('API_PORT');
  });

  it('throws when POLL_INTERVAL_MS is not a number', async () => {
    vi.stubEnv('POLL_INTERVAL_MS', 'fast');
    const { validateConfig } = await import('./config');
    expect(() => validateConfig()).toThrow('POLL_INTERVAL_MS');
  });

  it('throws when MAX_RETRIES is not a number', async () => {
    vi.stubEnv('MAX_RETRIES', 'many');
    const { validateConfig } = await import('./config');
    expect(() => validateConfig()).toThrow('MAX_RETRIES');
  });
});
