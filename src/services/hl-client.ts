import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { config } from '../config';

/**
 * Creates a Hyperliquid InfoClient with the given API URL.
 */
export function createInfoClient(apiUrl: string): InfoClient {
  const transport = new HttpTransport({ apiUrl });
  return new InfoClient({ transport });
}

/** Default shared InfoClient — used when DI context is not available. */
export const infoClient = createInfoClient(config.hlApiUrl);
