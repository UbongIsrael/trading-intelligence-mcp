/**
 * Funding Rates Service
 * Fetches perpetual futures funding rates from Binance and other exchanges
 */

import { FundingRate, APIError } from '../types.js';

/**
 * Binance Futures API configuration
 */
const BINANCE_FUTURES_BASE_URL = 'https://fapi.binance.com';
const REQUEST_TIMEOUT = 5000; // 5 seconds
const RATE_LIMIT_DELAY = 1000; // 1 second between requests (conservative)

/**
 * Symbol to Binance perpetual mapping
 * Maps common symbols to Binance USDT perpetual contract names
 */
const SYMBOL_TO_PERPETUAL_MAP: Record<string, string> = {
  // Major cryptocurrencies
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  BNB: 'BNBUSDT',
  
  // Top altcoins
  XRP: 'XRPUSDT',
  ADA: 'ADAUSDT',
  DOGE: 'DOGEUSDT',
  MATIC: 'MATICUSDT',
  DOT: 'DOTUSDT',
  AVAX: 'AVAXUSDT',
  LINK: 'LINKUSDT',
  UNI: 'UNIUSDT',
  ATOM: 'ATOMUSDT',
  LTC: 'LTCUSDT',
  TRX: 'TRXUSDT',
  TON: 'TONUSDT',
  SHIB: 'SHIBUSDT',
  BCH: 'BCHUSDT',
  XLM: 'XLMUSDT',
  FIL: 'FILUSDT',
  ICP: 'ICPUSDT',
  APT: 'APTUSDT',
  ARB: 'ARBUSDT',
  OP: 'OPUSDT',
  NEAR: 'NEARUSDT',
  VET: 'VETUSDT',
  ALGO: 'ALGOUSDT',
  GRT: 'GRTUSDT',
  SAND: 'SANDUSDT',
  MANA: 'MANAUSDT',
  AAVE: 'AAVEUSDT',
  MKR: 'MKRUSDT',
  FTM: 'FTMUSDT',
  ETC: 'ETCUSDT',
  HBAR: 'HBARUSDT',
  RUNE: 'RUNEUSDT',
};

/**
 * Binance Premium Index API response
 */
interface BinancePremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  interestRate: string;
  nextFundingTime: number;
  time: number;
}

/**
 * Rate limiter state
 */
let lastRequestTime = 0;

/**
 * Apply rate limiting
 */
async function applyRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
    const delay = RATE_LIMIT_DELAY - timeSinceLastRequest;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  lastRequestTime = Date.now();
}

/**
 * Normalize symbol to Binance perpetual contract name
 */
function symbolToPerpetual(symbol: string): string {
  const normalized = symbol.toUpperCase().trim();
  
  // If already in perpetual format (ends with USDT), return as-is
  if (normalized.endsWith('USDT')) {
    return normalized;
  }
  
  const perpetual = SYMBOL_TO_PERPETUAL_MAP[normalized];

  if (!perpetual) {
    throw new APIError(
      `Unknown perpetual symbol: ${symbol}`,
      {
        symbol,
        suggestion: 'Supported symbols: ' + Object.keys(SYMBOL_TO_PERPETUAL_MAP).slice(0, 10).join(', ') + ', ...',
        availableSymbols: Object.keys(SYMBOL_TO_PERPETUAL_MAP),
      }
    );
  }

  return perpetual;
}

/**
 * Parse funding rate from Binance response
 */
function parseFundingRate(data: BinancePremiumIndex): FundingRate {
  // Extract base symbol (e.g., BTCUSDT → BTC)
  const baseSymbol = data.symbol.replace('USDT', '').replace('BUSD', '');
  
  return {
    symbol: baseSymbol,
    exchange: 'binance',
    rate: parseFloat(data.lastFundingRate),
    nextFundingTime: new Date(data.nextFundingTime),
    predictedRate: parseFloat(data.interestRate), // Interest rate is used as prediction
    timestamp: new Date(data.time),
  };
}

/**
 * Fetch funding rate for a single symbol from Binance
 */
export async function fetchFundingRate(symbol: string): Promise<FundingRate> {
  const startTime = Date.now();

  // Validate symbol format
  if (!symbol || typeof symbol !== 'string') {
    throw new APIError('Invalid symbol format');
  }

  try {
    // Convert symbol to Binance perpetual contract
    const perpetual = symbolToPerpetual(symbol);

    // Apply rate limiting
    await applyRateLimit();

    // Build URL for premium index endpoint
    const url = new URL(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/premiumIndex`);
    url.searchParams.append('symbol', perpetual);

    // Make request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Handle rate limit
      if (response.status === 429) {
        throw new APIError(
          'Binance rate limit exceeded',
          {
            status: 429,
            retryAfter: response.headers.get('Retry-After'),
          }
        );
      }

      // Handle other errors
      throw new APIError(
        `Binance API error: ${response.status} ${response.statusText}`,
        { status: response.status }
      );
    }

    const data = await response.json() as BinancePremiumIndex;

    // Validate response
    if (!data.symbol || !data.lastFundingRate) {
      throw new APIError(
        `Invalid funding rate data for symbol: ${symbol}`,
        { symbol, perpetual }
      );
    }

    const fundingRate = parseFundingRate(data);

    const responseTime = Date.now() - startTime;
    console.log(`[Funding Service] Fetched ${symbol} funding rate in ${responseTime}ms`);

    return fundingRate;

  } catch (error: any) {
    // Handle AbortController timeout
    if (error.name === 'AbortError') {
      throw new APIError(
        `Request timeout for symbol: ${symbol}`,
        { symbol, timeout: REQUEST_TIMEOUT }
      );
    }

    // Handle network errors
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new APIError(
        'Network error: Unable to reach Binance',
        { originalError: error.message }
      );
    }

    // Re-throw APIError as-is
    if (error instanceof APIError) {
      throw error;
    }

    // Wrap unknown errors
    throw new APIError(
      `Failed to fetch funding rate for ${symbol}: ${error.message}`,
      { symbol, originalError: error }
    );
  }
}

/**
 * Fetch funding rates for multiple symbols in batch
 * Uses single API call to get all symbols at once for efficiency
 */
export async function fetchMultipleFundingRates(
  symbols: string[]
): Promise<Map<string, FundingRate>> {
  const results = new Map<string, FundingRate>();
  const startTime = Date.now();

  // Convert symbols to perpetuals
  const perpetuals: Set<string> = new Set();
  const perpetualToSymbol: Record<string, string> = {};

  for (const symbol of symbols) {
    try {
      const normalized = symbol.toUpperCase().trim();
      const perpetual = symbolToPerpetual(normalized);
      perpetuals.add(perpetual);
      perpetualToSymbol[perpetual] = normalized;
    } catch (error: any) {
      console.error(`[Funding Service] Failed to map symbol ${symbol}:`, error.message);
    }
  }

  if (perpetuals.size === 0) {
    return results;
  }

  try {
    // Apply rate limiting
    await applyRateLimit();

    // Fetch all funding rates in one request (no symbol parameter)
    const url = new URL(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/premiumIndex`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT * 2); // Longer timeout for batch

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new APIError(
        `Binance API error: ${response.status} ${response.statusText}`,
        { status: response.status }
      );
    }

    const data = await response.json() as BinancePremiumIndex[];

    // Parse results for requested symbols
    for (const item of data) {
      if (perpetuals.has(item.symbol)) {
        const fundingRate = parseFundingRate(item);
        const originalSymbol = perpetualToSymbol[item.symbol];
        results.set(originalSymbol, fundingRate);
      }
    }

    const responseTime = Date.now() - startTime;
    console.log(`[Funding Service] Fetched ${results.size}/${symbols.length} funding rates in ${responseTime}ms`);

  } catch (error: any) {
    console.error('[Funding Service] Batch fetch failed:', error.message);
  }

  return results;
}

/**
 * Fetch all available funding rates from Binance
 * Useful for scanning the entire market
 */
export async function fetchAllFundingRates(): Promise<FundingRate[]> {
  const startTime = Date.now();
  const results: FundingRate[] = [];

  try {
    await applyRateLimit();

    const url = new URL(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/premiumIndex`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT * 3);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new APIError(
        `Binance API error: ${response.status} ${response.statusText}`,
        { status: response.status }
      );
    }

    const data = await response.json() as BinancePremiumIndex[];

    for (const item of data) {
      try {
        results.push(parseFundingRate(item));
      } catch (error: any) {
        // Skip invalid entries
        continue;
      }
    }

    const responseTime = Date.now() - startTime;
    console.log(`[Funding Service] Fetched all ${results.length} funding rates in ${responseTime}ms`);

  } catch (error: any) {
    console.error('[Funding Service] Failed to fetch all funding rates:', error.message);
  }

  return results;
}

/**
 * Check if a symbol has a perpetual contract available
 */
export function isPerpetualAvailable(symbol: string): boolean {
  const normalized = symbol.toUpperCase().trim();
  return normalized in SYMBOL_TO_PERPETUAL_MAP || normalized.endsWith('USDT');
}

/**
 * Get list of supported perpetual symbols
 */
export function getSupportedPerpetualSymbols(): string[] {
  return Object.keys(SYMBOL_TO_PERPETUAL_MAP);
}

/**
 * Get funding rate statistics for a symbol
 * Returns high/low/average from recent funding rates
 */
export interface FundingRateStats {
  symbol: string;
  current: number;
  average: number;
  high: number;
  low: number;
  count: number;
}

/**
 * Fetch historical funding rates from Binance
 */
export async function fetchHistoricalFundingRates(
  symbol: string,
  limit: number = 100
): Promise<Array<{ rate: number; time: Date }>> {
  try {
    const perpetual = symbolToPerpetual(symbol);
    await applyRateLimit();

    const url = new URL(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/fundingRate`);
    url.searchParams.append('symbol', perpetual);
    url.searchParams.append('limit', Math.min(limit, 1000).toString());

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new APIError(
        `Binance API error: ${response.status} ${response.statusText}`,
        { status: response.status }
      );
    }

    const data = await response.json() as Array<{
      symbol: string;
      fundingRate: string;
      fundingTime: number;
    }>;

    return data.map(item => ({
      rate: parseFloat(item.fundingRate),
      time: new Date(item.fundingTime),
    }));

  } catch (error: any) {
    throw new APIError(
      `Failed to fetch historical funding rates for ${symbol}: ${error.message}`,
      { symbol, originalError: error }
    );
  }
}

/**
 * Calculate funding rate statistics from historical data
 */
export async function calculateFundingRateStats(
  symbol: string,
  limit: number = 100
): Promise<FundingRateStats> {
  const historical = await fetchHistoricalFundingRates(symbol, limit);

  if (historical.length === 0) {
    throw new APIError(`No historical funding rate data for ${symbol}`, { symbol });
  }

  const rates = historical.map(h => h.rate);
  const sum = rates.reduce((a, b) => a + b, 0);

  return {
    symbol: symbol.toUpperCase(),
    current: rates[0], // Most recent
    average: sum / rates.length,
    high: Math.max(...rates),
    low: Math.min(...rates),
    count: rates.length,
  };
}
