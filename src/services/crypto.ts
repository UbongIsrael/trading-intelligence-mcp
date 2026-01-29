/**
 * Crypto Price Service
 * Fetches cryptocurrency prices from CoinGecko API
 */

import { PriceData, APIError } from '../types.js';
import { apiConfig } from '../config.js';

/**
 * CoinGecko API configuration
 */
const COINGECKO_BASE_URL = apiConfig.coinGecko.baseUrl;
const COINGECKO_API_KEY = apiConfig.coinGecko.apiKey;
const REQUEST_TIMEOUT = 5000; // 5 seconds
const RATE_LIMIT_DELAY = 2000; // 2 seconds between requests (30 calls/min = one every 2s)

/**
 * Symbol to CoinGecko ID mapping
 * Common crypto symbols → CoinGecko coin IDs
 */
const SYMBOL_TO_ID_MAP: Record<string, string> = {
  // Major cryptocurrencies
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  BNB: 'binancecoin',
  SOL: 'solana',
  USDC: 'usd-coin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  TRX: 'tron',
  TON: 'the-open-network',
  LINK: 'chainlink',
  MATIC: 'matic-network',
  DOT: 'polkadot',
  DAI: 'dai',
  SHIB: 'shiba-inu',
  AVAX: 'avalanche-2',
  WBTC: 'wrapped-bitcoin',
  UNI: 'uniswap',
  ATOM: 'cosmos',
  LTC: 'litecoin',
  ETC: 'ethereum-classic',
  BCH: 'bitcoin-cash',
  XLM: 'stellar',
  FIL: 'filecoin',
  ICP: 'internet-computer',
  APT: 'aptos',
  HBAR: 'hedera-hashgraph',
  ARB: 'arbitrum',
  OP: 'optimism',
  NEAR: 'near',
  VET: 'vechain',
  ALGO: 'algorand',
  GRT: 'the-graph',
  SAND: 'the-sandbox',
  MANA: 'decentraland',
  AAVE: 'aave',
  MKR: 'maker',
  RUNE: 'thorchain',
  FTM: 'fantom',
};

/**
 * CoinGecko API response interface
 */
interface CoinGeckoSimplePrice {
  [coinId: string]: {
    usd: number;
    usd_market_cap?: number;
    usd_24h_vol?: number;
    usd_24h_change?: number;
  };
}


/**
 * Rate limiter state
 */
let lastRequestTime = 0;

/**
 * Apply rate limiting (courtesy delay)
 */
async function applyRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
    const delay = RATE_LIMIT_DELAY - timeSinceLastRequest;
    console.log(`[Crypto Service] Rate limit: waiting ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  lastRequestTime = Date.now();
}

/**
 * Convert symbol to CoinGecko ID
 */
function symbolToCoinGeckoId(symbol: string): string {
  const normalized = symbol.toUpperCase().trim();
  const coinId = SYMBOL_TO_ID_MAP[normalized];

  if (!coinId) {
    throw new APIError(
      `Unknown crypto symbol: ${symbol}`,
      {
        symbol,
        suggestion: 'Supported symbols: ' + Object.keys(SYMBOL_TO_ID_MAP).slice(0, 10).join(', ') + ', ...',
        availableSymbols: Object.keys(SYMBOL_TO_ID_MAP),
      }
    );
  }

  return coinId;
}

/**
 * Build request headers with optional API key
 */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  if (COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
  }

  return headers;
}

/**
 * Fetch crypto price from CoinGecko (simple price endpoint)
 */
export async function fetchCryptoPrice(symbol: string): Promise<PriceData> {
  const startTime = Date.now();

  // Validate symbol format
  if (!symbol || typeof symbol !== 'string') {
    throw new APIError('Invalid symbol format');
  }

  const normalizedSymbol = symbol.toUpperCase().trim();

  try {
    // Convert symbol to CoinGecko ID
    const coinId = symbolToCoinGeckoId(normalizedSymbol);

    // Apply rate limiting
    await applyRateLimit();

    // Build URL for simple price endpoint
    const url = new URL(`${COINGECKO_BASE_URL}/simple/price`);
    url.searchParams.append('ids', coinId);
    url.searchParams.append('vs_currencies', 'usd');
    url.searchParams.append('include_market_cap', 'true');
    url.searchParams.append('include_24hr_vol', 'true');
    url.searchParams.append('include_24hr_change', 'true');

    // Make request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: buildHeaders(),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Handle rate limit specifically
      if (response.status === 429) {
        throw new APIError(
          'CoinGecko rate limit exceeded',
          {
            status: 429,
            retryAfter: response.headers.get('Retry-After'),
            suggestion: 'Consider adding COINGECKO_API_KEY for higher limits'
          }
        );
      }

      throw new APIError(
        `CoinGecko API error: ${response.status} ${response.statusText}`,
        { status: response.status }
      );
    }

    const data = await response.json() as CoinGeckoSimplePrice;

    // Check if coin data exists
    if (!data[coinId]) {
      throw new APIError(
        `No data found for symbol: ${normalizedSymbol}`,
        { symbol: normalizedSymbol, coinId }
      );
    }

    const coinData = data[coinId];

    // Validate price
    if (typeof coinData.usd !== 'number') {
      throw new APIError(
        `Invalid price data for symbol: ${normalizedSymbol}`,
        { symbol: normalizedSymbol, coinId }
      );
    }

    // Build PriceData object
    const priceData: PriceData = {
      symbol: normalizedSymbol,
      price: coinData.usd,
      currency: 'USD',
      timestamp: new Date(),
      source: 'coingecko',
      volume24h: coinData.usd_24h_vol,
      change24h: coinData.usd_24h_change ? (coinData.usd_24h_change / 100) * coinData.usd : undefined,
      changePercent24h: coinData.usd_24h_change,
      marketCap: coinData.usd_market_cap,
    };

    const responseTime = Date.now() - startTime;
    console.log(`[Crypto Service] Fetched ${normalizedSymbol} in ${responseTime}ms`);

    return priceData;

  } catch (error: any) {
    // Handle AbortController timeout
    if (error.name === 'AbortError') {
      throw new APIError(
        `Request timeout for symbol: ${normalizedSymbol}`,
        { symbol: normalizedSymbol, timeout: REQUEST_TIMEOUT }
      );
    }

    // Handle network errors
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new APIError(
        'Network error: Unable to reach CoinGecko',
        { originalError: error.message }
      );
    }

    // Re-throw APIError as-is
    if (error instanceof APIError) {
      throw error;
    }

    // Wrap unknown errors
    throw new APIError(
      `Failed to fetch crypto price for ${normalizedSymbol}: ${error.message}`,
      { symbol: normalizedSymbol, originalError: error }
    );
  }
}

/**
 * Fetch multiple crypto prices in batch
 * CoinGecko supports multiple IDs in a single request
 */
export async function fetchMultipleCryptoPrices(
  symbols: string[]
): Promise<Map<string, PriceData>> {
  const results = new Map<string, PriceData>();
  const startTime = Date.now();

  // Convert symbols to CoinGecko IDs
  const coinIds: string[] = [];
  const symbolToCoinId: Record<string, string> = {};

  for (const symbol of symbols) {
    try {
      const normalized = symbol.toUpperCase().trim();
      const coinId = symbolToCoinGeckoId(normalized);
      coinIds.push(coinId);
      symbolToCoinId[coinId] = normalized;
    } catch (error: any) {
      console.error(`[Crypto Service] Failed to map symbol ${symbol}:`, error.message);
    }
  }

  if (coinIds.length === 0) {
    return results;
  }

  try {
    // Apply rate limiting
    await applyRateLimit();

    // Build URL for batch request
    const url = new URL(`${COINGECKO_BASE_URL}/simple/price`);
    url.searchParams.append('ids', coinIds.join(','));
    url.searchParams.append('vs_currencies', 'usd');
    url.searchParams.append('include_market_cap', 'true');
    url.searchParams.append('include_24hr_vol', 'true');
    url.searchParams.append('include_24hr_change', 'true');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: buildHeaders(),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new APIError(
        `CoinGecko API error: ${response.status} ${response.statusText}`,
        { status: response.status }
      );
    }

    const data = await response.json() as CoinGeckoSimplePrice;

    // Parse results
    for (const [coinId, coinData] of Object.entries(data)) {
      const symbol = symbolToCoinId[coinId];

      if (!symbol || typeof coinData.usd !== 'number') {
        continue;
      }

      const priceData: PriceData = {
        symbol,
        price: coinData.usd,
        currency: 'USD',
        timestamp: new Date(),
        source: 'coingecko',
        volume24h: coinData.usd_24h_vol,
        change24h: coinData.usd_24h_change ? (coinData.usd_24h_change / 100) * coinData.usd : undefined,
        changePercent24h: coinData.usd_24h_change,
        marketCap: coinData.usd_market_cap,
      };

      results.set(symbol, priceData);
    }

    const responseTime = Date.now() - startTime;
    console.log(`[Crypto Service] Fetched ${results.size}/${symbols.length} prices in ${responseTime}ms`);

  } catch (error: any) {
    console.error('[Crypto Service] Batch fetch failed:', error.message);
  }

  return results;
}

/**
 * Check if a symbol is likely a crypto symbol
 */
export function isLikelyCryptoSymbol(symbol: string): boolean {
  const normalized = symbol.toUpperCase().trim();
  return normalized in SYMBOL_TO_ID_MAP;
}

/**
 * Get list of supported crypto symbols
 */
export function getSupportedCryptoSymbols(): string[] {
  return Object.keys(SYMBOL_TO_ID_MAP);
}
