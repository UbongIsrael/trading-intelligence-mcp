/**
 * Stock Price Service
 * Fetches stock prices from Yahoo Finance
 */

import { PriceData, APIError } from '../types.js';

/**
 * Yahoo Finance API configuration
 */
const YAHOO_FINANCE_BASE_URL = 'https://query2.finance.yahoo.com';
const REQUEST_TIMEOUT = 5000; // 5 seconds
const COURTESY_DELAY = 100; // 100ms between requests

/**
 * Yahoo Finance quote response interface
 */
interface YahooQuoteResponse {
  chart: {
    result: Array<{
      meta: {
        symbol: string;
        currency: string;
        regularMarketPrice: number;
        regularMarketTime: number;
        previousClose?: number;
        regularMarketVolume?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        marketCap?: number;
      };
      timestamp: number[];
      indicators: {
        quote: Array<{
          close: number[];
          volume: number[];
          high: number[];
          low: number[];
        }>;
      };
    }>;
    error: any;
  };
}

/**
 * Fetch stock price from Yahoo Finance
 */
export async function fetchStockPrice(symbol: string): Promise<PriceData> {
  const startTime = Date.now();

  // Validate symbol format
  if (!symbol || typeof symbol !== 'string') {
    throw new APIError('Invalid symbol format');
  }

  const normalizedSymbol = symbol.toUpperCase().trim();

  try {
    // Build URL for Yahoo Finance chart API
    const url = new URL(`${YAHOO_FINANCE_BASE_URL}/v8/finance/chart/${normalizedSymbol}`);
    url.searchParams.append('interval', '1d');
    url.searchParams.append('range', '1d');

    // Make request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new APIError(
        `Yahoo Finance API error: ${response.status} ${response.statusText}`,
        { status: response.status }
      );
    }

    const data = await response.json() as YahooQuoteResponse;

    // Check for API errors
    if (data.chart.error) {
      throw new APIError(
        data.chart.error.description || 'Yahoo Finance API error',
        { code: data.chart.error.code }
      );
    }

    // Check for valid result
    if (!data.chart.result || data.chart.result.length === 0) {
      throw new APIError(
        `No data found for symbol: ${normalizedSymbol}`,
        { symbol: normalizedSymbol, suggestion: 'Verify the stock symbol is correct' }
      );
    }

    const result = data.chart.result[0];
    const meta = result.meta;

    // Validate required fields
    if (typeof meta.regularMarketPrice !== 'number') {
      throw new APIError(
        `Invalid price data for symbol: ${normalizedSymbol}`,
        { symbol: normalizedSymbol }
      );
    }

    // Calculate 24h change if previous close is available
    const change24h = meta.previousClose
      ? meta.regularMarketPrice - meta.previousClose
      : undefined;

    const changePercent24h = meta.previousClose && change24h !== undefined
      ? (change24h / meta.previousClose) * 100
      : undefined;

    // Build PriceData object
    const priceData: PriceData = {
      symbol: normalizedSymbol,
      price: meta.regularMarketPrice,
      currency: meta.currency || 'USD',
      timestamp: new Date(meta.regularMarketTime * 1000 || Date.now()),
      source: 'yahoo_finance',
      volume24h: meta.regularMarketVolume,
      change24h,
      changePercent24h,
      high24h: meta.regularMarketDayHigh,
      low24h: meta.regularMarketDayLow,
      marketCap: meta.marketCap,
    };

    const responseTime = Date.now() - startTime;
    console.log(`[Stock Service] Fetched ${normalizedSymbol} in ${responseTime}ms`);

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
        'Network error: Unable to reach Yahoo Finance',
        { originalError: error.message }
      );
    }

    // Re-throw APIError as-is
    if (error instanceof APIError) {
      throw error;
    }

    // Wrap unknown errors
    throw new APIError(
      `Failed to fetch stock price for ${normalizedSymbol}: ${error.message}`,
      { symbol: normalizedSymbol, originalError: error }
    );
  }
}

/**
 * Fetch multiple stock prices in batch
 * Note: Yahoo Finance doesn't have a native batch endpoint,
 * so we fetch sequentially with courtesy delays
 */
export async function fetchMultipleStockPrices(
  symbols: string[]
): Promise<Map<string, PriceData>> {
  const results = new Map<string, PriceData>();
  const errors: Array<{ symbol: string; error: string }> = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];

    try {
      const priceData = await fetchStockPrice(symbol);
      results.set(symbol.toUpperCase(), priceData);
    } catch (error: any) {
      console.error(`[Stock Service] Failed to fetch ${symbol}:`, error.message);
      errors.push({
        symbol,
        error: error.message,
      });
    }

    // Add courtesy delay between requests (except for last one)
    if (i < symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, COURTESY_DELAY));
    }
  }

  if (errors.length > 0) {
    console.warn(`[Stock Service] ${errors.length}/${symbols.length} requests failed:`, errors);
  }

  return results;
}

/**
 * Check if a symbol is likely a stock symbol
 * This is a heuristic check, not definitive
 */
export function isLikelyStockSymbol(symbol: string): boolean {
  const normalized = symbol.toUpperCase().trim();

  // Stock symbols are typically:
  // - 1-5 characters for US stocks (e.g., AAPL, MSFT, SPY)
  // - May have a dot for international (e.g., BRK.A)
  // - May have a dash for preferred shares (e.g., BRK-A)
  const stockPattern = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;

  // Common crypto symbols to exclude
  const cryptoSymbols = ['BTC', 'ETH', 'SOL', 'BNB', 'USDT', 'USDC', 'XRP', 'ADA', 'DOGE', 'DOT', 'MATIC', 'AVAX', 'LINK'];

  if (cryptoSymbols.includes(normalized)) {
    return false;
  }

  return stockPattern.test(normalized);
}
