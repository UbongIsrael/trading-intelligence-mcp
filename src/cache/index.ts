/**
 * Cache Service
 * Main interface for caching operations with domain-specific helpers
 */

import { config } from '../config.js';
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheExists,
  cacheGetTTL,
  cacheDeletePattern,
  cacheAside,
  cacheMGet,
  cacheMSet,
  getCacheStats,
  resetCacheStats,
  cacheFlush,
  buildCacheKey,
  CacheOptions,
  CacheStats,
} from './utils.js';
import {
  getRedisClient,
  initializeRedis,
  shutdownRedis,
  RedisClient,
} from './redis.js';
import {
  getRedisMetrics,
  getRedisMetricsSummary,
  resetRedisMetrics,
  type RedisMetrics,
} from './metrics.js';
import { PriceData, TechnicalAnalysis, FundamentalData, NewsArticle, FundingRate } from '../types.js';

/**
 * Cache service for price data
 */
export class PriceCacheService {
  private readonly ttl: number;
  private readonly prefix: string;

  constructor() {
    this.ttl = config.cache.prices.ttl;
    this.prefix = config.cache.prices.prefix;
  }

  async get(symbol: string): Promise<PriceData | null> {
    return cacheGet<PriceData>(symbol, { prefix: this.prefix });
  }

  async set(symbol: string, data: PriceData): Promise<boolean> {
    return cacheSet(symbol, data, { prefix: this.prefix, ttl: this.ttl });
  }

  async delete(symbol: string): Promise<boolean> {
    return cacheDelete(symbol, { prefix: this.prefix });
  }

  async exists(symbol: string): Promise<boolean> {
    return cacheExists(symbol, { prefix: this.prefix });
  }

  async getTTL(symbol: string): Promise<number | null> {
    return cacheGetTTL(symbol, { prefix: this.prefix });
  }

  async getOrFetch(
    symbol: string,
    fetcher: () => Promise<PriceData>
  ): Promise<{ data: PriceData; cached: boolean; responseTime: number }> {
    return cacheAside(symbol, fetcher, { prefix: this.prefix, ttl: this.ttl });
  }

  async batchGet(symbols: string[]): Promise<Map<string, PriceData>> {
    return cacheMGet<PriceData>(symbols, { prefix: this.prefix });
  }

  async batchSet(prices: Map<string, PriceData>): Promise<boolean> {
    return cacheMSet(prices, { prefix: this.prefix, ttl: this.ttl });
  }

  async invalidate(symbol: string): Promise<boolean> {
    return this.delete(symbol);
  }

  async invalidateAll(): Promise<number> {
    return cacheDeletePattern('*', { prefix: this.prefix });
  }
}

/**
 * Cache service for liquidity/technical analysis data
 */
export class LiquidityCacheService {
  private readonly ttl: number;
  private readonly prefix: string;

  constructor() {
    this.ttl = config.cache.liquidity.ttl;
    this.prefix = config.cache.liquidity.prefix;
  }

  private buildKey(symbol: string, timeframe: string): string {
    return `${symbol}:${timeframe}`;
  }

  async get(symbol: string, timeframe: string): Promise<TechnicalAnalysis | null> {
    return cacheGet<TechnicalAnalysis>(this.buildKey(symbol, timeframe), { prefix: this.prefix });
  }

  async set(symbol: string, timeframe: string, data: TechnicalAnalysis): Promise<boolean> {
    return cacheSet(this.buildKey(symbol, timeframe), data, { prefix: this.prefix, ttl: this.ttl });
  }

  async delete(symbol: string, timeframe: string): Promise<boolean> {
    return cacheDelete(this.buildKey(symbol, timeframe), { prefix: this.prefix });
  }

  async exists(symbol: string, timeframe: string): Promise<boolean> {
    return cacheExists(this.buildKey(symbol, timeframe), { prefix: this.prefix });
  }

  async getOrFetch(
    symbol: string,
    timeframe: string,
    fetcher: () => Promise<TechnicalAnalysis>
  ): Promise<{ data: TechnicalAnalysis; cached: boolean; responseTime: number }> {
    return cacheAside(this.buildKey(symbol, timeframe), fetcher, { prefix: this.prefix, ttl: this.ttl });
  }

  async invalidateSymbol(symbol: string): Promise<number> {
    return cacheDeletePattern(`${symbol}:*`, { prefix: this.prefix });
  }

  async invalidateAll(): Promise<number> {
    return cacheDeletePattern('*', { prefix: this.prefix });
  }
}

/**
 * Cache service for fundamental data
 */
export class FundamentalsCacheService {
  private readonly ttl: number;
  private readonly prefix: string;

  constructor() {
    this.ttl = config.cache.fundamentals.ttl;
    this.prefix = config.cache.fundamentals.prefix;
  }

  private buildKey(symbol: string, dataType: string): string {
    return `${symbol}:${dataType}`;
  }

  async get(symbol: string, dataType: string = 'overview'): Promise<FundamentalData | null> {
    return cacheGet<FundamentalData>(this.buildKey(symbol, dataType), { prefix: this.prefix });
  }

  async set(symbol: string, dataType: string, data: FundamentalData): Promise<boolean> {
    return cacheSet(this.buildKey(symbol, dataType), data, { prefix: this.prefix, ttl: this.ttl });
  }

  async delete(symbol: string, dataType: string): Promise<boolean> {
    return cacheDelete(this.buildKey(symbol, dataType), { prefix: this.prefix });
  }

  async getOrFetch(
    symbol: string,
    dataType: string,
    fetcher: () => Promise<FundamentalData>
  ): Promise<{ data: FundamentalData; cached: boolean; responseTime: number }> {
    return cacheAside(this.buildKey(symbol, dataType), fetcher, { prefix: this.prefix, ttl: this.ttl });
  }

  async invalidateSymbol(symbol: string): Promise<number> {
    return cacheDeletePattern(`${symbol}:*`, { prefix: this.prefix });
  }

  async invalidateAll(): Promise<number> {
    return cacheDeletePattern('*', { prefix: this.prefix });
  }
}

/**
 * Cache service for funding rate data
 */
export class FundingCacheService {
  private readonly ttl: number;
  private readonly prefix: string;

  constructor() {
    // Funding rates update every 8 hours, cache for 15 minutes
    this.ttl = 900;
    this.prefix = 'funding:';
  }

  async get(key: string): Promise<FundingRate | null> {
    return cacheGet<FundingRate>(key, { prefix: this.prefix });
  }

  async set(key: string, data: FundingRate): Promise<boolean> {
    return cacheSet(key, data, { prefix: this.prefix, ttl: this.ttl });
  }

  async delete(key: string): Promise<boolean> {
    return cacheDelete(key, { prefix: this.prefix });
  }

  async exists(key: string): Promise<boolean> {
    return cacheExists(key, { prefix: this.prefix });
  }

  async getOrFetch<T extends FundingRate | FundingRate[]>(
    key: string,
    fetcher: () => Promise<T>
  ): Promise<{ data: T; cached: boolean; responseTime: number }> {
    return cacheAside(key, fetcher, { prefix: this.prefix, ttl: this.ttl });
  }

  async invalidateAll(): Promise<number> {
    return cacheDeletePattern('*', { prefix: this.prefix });
  }
}

/**
 * Cache service for news data
 */
export class NewsCacheService {
  private readonly ttl: number;
  private readonly prefix: string;

  constructor() {
    this.ttl = config.cache.news.ttl;
    this.prefix = config.cache.news.prefix;
  }

  private buildKey(symbol: string, timeframe: string = '24h'): string {
    return `${symbol}:${timeframe}`;
  }

  async get(symbol: string, timeframe: string = '24h'): Promise<NewsArticle[] | null> {
    return cacheGet<NewsArticle[]>(this.buildKey(symbol, timeframe), { prefix: this.prefix });
  }

  async set(symbol: string, timeframe: string, data: NewsArticle[]): Promise<boolean> {
    return cacheSet(this.buildKey(symbol, timeframe), data, { prefix: this.prefix, ttl: this.ttl });
  }

  async delete(symbol: string, timeframe: string = '24h'): Promise<boolean> {
    return cacheDelete(this.buildKey(symbol, timeframe), { prefix: this.prefix });
  }

  async getOrFetch(
    symbol: string,
    timeframe: string,
    fetcher: () => Promise<NewsArticle[]>
  ): Promise<{ data: NewsArticle[]; cached: boolean; responseTime: number }> {
    return cacheAside(this.buildKey(symbol, timeframe), fetcher, { prefix: this.prefix, ttl: this.ttl });
  }

  async invalidateSymbol(symbol: string): Promise<number> {
    return cacheDeletePattern(`${symbol}:*`, { prefix: this.prefix });
  }

  async invalidateAll(): Promise<number> {
    return cacheDeletePattern('*', { prefix: this.prefix });
  }
}

/**
 * Main cache service aggregator
 */
export class CacheService {
  public readonly prices: PriceCacheService;
  public readonly liquidity: LiquidityCacheService;
  public readonly fundamentals: FundamentalsCacheService;
  public readonly news: NewsCacheService;
  public readonly funding: FundingCacheService;

  constructor() {
    this.prices = new PriceCacheService();
    this.liquidity = new LiquidityCacheService();
    this.fundamentals = new FundamentalsCacheService();
    this.news = new NewsCacheService();
    this.funding = new FundingCacheService();
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return getCacheStats();
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    resetCacheStats();
  }

  /**
   * Flush entire cache
   */
  async flush(): Promise<boolean> {
    return cacheFlush();
  }

  /**
   * Get Redis client for custom operations
   */
  getRedisClient(): RedisClient {
    return getRedisClient();
  }

  /**
   * Check if caching is enabled
   */
  isEnabled(): boolean {
    return config.features.enableCaching;
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<{
    enabled: boolean;
    connected: boolean;
    latency?: number;
    error?: string;
    stats: CacheStats;
  }> {
    const stats = this.getStats();

    if (!this.isEnabled()) {
      return {
        enabled: false,
        connected: false,
        stats,
      };
    }

    const redisClient = getRedisClient();
    const health = await redisClient.healthCheck();

    return {
      enabled: true,
      connected: health.connected,
      latency: health.latency,
      error: health.error,
      stats,
    };
  }

  /**
   * Get Redis performance metrics for production monitoring
   */
  getMetrics(): RedisMetrics {
    return getRedisMetrics();
  }

  /**
   * Get formatted metrics summary for logging
   */
  getMetricsSummary(): string {
    return getRedisMetricsSummary();
  }

  /**
   * Reset metrics (typically called after logging/reporting)
   */
  resetMetrics(): void {
    resetRedisMetrics();
  }
}

// Singleton instance
let cacheServiceInstance: CacheService | null = null;

/**
 * Get the singleton cache service instance
 */
export function getCacheService(): CacheService {
  if (!cacheServiceInstance) {
    cacheServiceInstance = new CacheService();
  }
  return cacheServiceInstance;
}

// Re-export utilities for convenience
export {
  initializeRedis,
  shutdownRedis,
  getRedisClient,
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheExists,
  cacheGetTTL,
  cacheDeletePattern,
  cacheAside,
  cacheMGet,
  cacheMSet,
  getCacheStats,
  resetCacheStats,
  cacheFlush,
  buildCacheKey,
};

export type { CacheOptions, CacheStats };
export type { RedisMetrics };
export { getRedisMetrics, getRedisMetricsSummary, resetRedisMetrics };
