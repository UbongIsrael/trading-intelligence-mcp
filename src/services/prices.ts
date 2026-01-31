/**
 * Unified Price Service
 * Auto-detects asset type and routes to appropriate service
 */

import { PriceData, AssetType, PriceQuery, APIError } from '../types.js';
import { getCacheService } from '../cache/index.js';
import { fetchStockPrice, isLikelyStockSymbol } from './stocks.js';
import { fetchCryptoPrice, fetchMultipleCryptoPrices, isLikelyCryptoSymbol } from './crypto.js';

/**
 * Detect asset type from symbol
 */
export function detectAssetType(symbol: string): AssetType {
  const normalized = symbol.toUpperCase().trim();

  // Check crypto first (more definitive mapping)
  if (isLikelyCryptoSymbol(normalized)) {
    return 'crypto';
  }

  // Default to stock if it matches stock pattern
  if (isLikelyStockSymbol(normalized)) {
    return 'stock';
  }

  // If we can't determine, default to stock and let the API fail gracefully
  return 'stock';
}

/**
 * Fetch price with caching
 * This is the main entry point for getting prices
 */
export async function getPrice(query: PriceQuery): Promise<{
  data: PriceData;
  cached: boolean;
  responseTime: number;
}> {
  const { symbol, assetType: providedType } = query;
  const normalizedSymbol = symbol.toUpperCase().trim();
  const startTime = Date.now();

  // Determine asset type (use provided or auto-detect)
  const assetType = providedType || detectAssetType(normalizedSymbol);

  console.log(`[Price Service] Getting price for ${normalizedSymbol} (type: ${assetType})`);

  // Get cache service
  const cacheService = getCacheService();

  try {
    // Use cache-aside pattern
    const result = await cacheService.prices.getOrFetch(
      normalizedSymbol,
      async () => {
        // Fetch from appropriate service
        if (assetType === 'crypto') {
          return await fetchCryptoPrice(normalizedSymbol);
        } else if (assetType === 'stock') {
          return await fetchStockPrice(normalizedSymbol);
        } else {
          throw new APIError(
            `Unsupported asset type: ${assetType}`,
            { symbol: normalizedSymbol, assetType }
          );
        }
      }
    );

    const totalTime = Date.now() - startTime;
    console.log(
      `[Price Service] ${result.cached ? 'Cache hit' : 'Cache miss'} for ${normalizedSymbol} (${totalTime}ms)`
    );

    return result;

  } catch (error: any) {
    // If primary fetch fails and we have a cache entry (even expired), use it
    const cachedData = await cacheService.prices.get(normalizedSymbol);

    if (cachedData) {
      console.warn(
        `[Price Service] Using stale cache for ${normalizedSymbol} due to error:`,
        error.message
      );

      // Hydrate timestamp if it's a string (Redis serialization)
      if (cachedData.timestamp && typeof cachedData.timestamp === 'string') {
        cachedData.timestamp = new Date(cachedData.timestamp);
      }

      return {
        data: cachedData,
        cached: true,
        responseTime: Date.now() - startTime,
      };
    }

    // No cache available, re-throw error
    throw error;
  }
}

/**
 * Fetch multiple prices (batch operation)
 */
export async function getMultiplePrices(
  queries: PriceQuery[]
): Promise<Map<string, { data: PriceData; cached: boolean; responseTime: number }>> {
  const results = new Map<string, { data: PriceData; cached: boolean; responseTime: number }>();

  // Group queries by asset type
  const stockSymbols: string[] = [];
  const cryptoSymbols: string[] = [];

  for (const query of queries) {
    const normalized = query.symbol.toUpperCase().trim();
    const assetType = query.assetType || detectAssetType(normalized);

    if (assetType === 'crypto') {
      cryptoSymbols.push(normalized);
    } else if (assetType === 'stock') {
      stockSymbols.push(normalized);
    }
  }

  // Process each group
  if (stockSymbols.length > 0) {
    for (const symbol of stockSymbols) {
      try {
        const result = await getPrice({ symbol, assetType: 'stock' });
        results.set(symbol, result);
      } catch (error: any) {
        console.error(`[Price Service] Failed to get price for ${symbol}:`, error.message);
      }
    }
  }

  if (cryptoSymbols.length > 0) {
    // Crypto can be batched efficiently
    const cacheService = getCacheService();
    const uncachedSymbols: string[] = [];

    // Check cache first
    for (const symbol of cryptoSymbols) {
      const startTime = Date.now();
      const cached = await cacheService.prices.get(symbol);

      if (cached) {
        results.set(symbol, {
          data: cached,
          cached: true,
          responseTime: Date.now() - startTime,
        });
      } else {
        uncachedSymbols.push(symbol);
      }
    }

    // Fetch uncached prices in batch
    if (uncachedSymbols.length > 0) {
      try {
        const startTime = Date.now();
        const prices = await fetchMultipleCryptoPrices(uncachedSymbols);
        const responseTime = Date.now() - startTime;

        // Cache and add to results
        for (const [symbol, priceData] of prices.entries()) {
          await cacheService.prices.set(symbol, priceData);
          results.set(symbol, {
            data: priceData,
            cached: false,
            responseTime,
          });
        }
      } catch (error: any) {
        console.error('[Price Service] Batch crypto fetch failed:', error.message);
      }
    }
  }

  return results;
}

/**
 * Invalidate price cache for a symbol
 */
export async function invalidatePrice(symbol: string): Promise<boolean> {
  const cacheService = getCacheService();
  const normalized = symbol.toUpperCase().trim();
  return await cacheService.prices.invalidate(normalized);
}

/**
 * Invalidate all price caches
 */
export async function invalidateAllPrices(): Promise<number> {
  const cacheService = getCacheService();
  return await cacheService.prices.invalidateAll();
}

/**
 * Get price with enhanced error handling
 * Returns null on error instead of throwing
 */
export async function getPriceSafe(
  query: PriceQuery
): Promise<{ data: PriceData; cached: boolean; responseTime: number } | null> {
  try {
    return await getPrice(query);
  } catch (error: any) {
    console.error(
      `[Price Service] Safe fetch failed for ${query.symbol}:`,
      error.message
    );
    return null;
  }
}

/**
 * Health check for price services
 */
export async function priceServiceHealthCheck(): Promise<{
  stock: { available: boolean; message?: string };
  crypto: { available: boolean; message?: string };
  cache: { available: boolean; hitRate: number };
}> {
  const results = {
    stock: { available: false, message: '' },
    crypto: { available: false, message: '' },
    cache: { available: false, hitRate: 0 },
  };

  // Test stock service
  try {
    await fetchStockPrice('AAPL');
    results.stock.available = true;
  } catch (error: any) {
    results.stock.message = error.message;
  }

  // Test crypto service
  try {
    await fetchCryptoPrice('BTC');
    results.crypto.available = true;
  } catch (error: any) {
    results.crypto.message = error.message;
  }

  // Check cache
  const cacheService = getCacheService();
  const cacheHealth = await cacheService.healthCheck();
  results.cache.available = cacheHealth.connected;
  results.cache.hitRate = cacheHealth.stats.hitRate;

  return results;
}
