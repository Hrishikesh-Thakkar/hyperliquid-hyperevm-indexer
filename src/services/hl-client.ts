import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { config } from '../config';

/**
 * Shared Hyperliquid InfoClient instance.
 *
 * HttpTransport uses the Hyperliquid REST API under the hood.
 * The apiUrl is sourced from config so it can be overridden for testnet.
 */
const transport = new HttpTransport({
  apiUrl: config.hlApiUrl,
});

export const infoClient = new InfoClient({ transport });
