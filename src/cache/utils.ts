/**
 * Cache Utilities
 * Provides cache operations with TTL management and cache-aside pattern
 */

import { getRedisClient } from './redis.js';
import { config } from '../config.js';
import { recordRedisOperation, recordRedisError } from './metrics.js';

export interface CacheOptions {
  ttl?: number; // Time to live in seconds
  prefix?: string; // Key prefix
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  operations: {
    get: number;
    set: number;
    delete: number;
  };
}

// Cache statistics tracker
class CacheStatsTracker {
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    hitRate: 0,
    operations: {
      get: 0,
      set: 0,
      delete: 0,
    },
  };

  recordHit(): void {
    this.stats.hits++;
    this.updateHitRate();
  }

  recordMiss(): void {
    this.stats.misses++;
    this.updateHitRate();
  }

  recordOperation(operation: 'get' | 'set' | 'delete'): void {
    this.stats.operations[operation]++;
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  reset(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      hitRate: 0,
      operations: {
        get: 0,
        set: 0,
        delete: 0,
      },
    };
  }
}

const statsTracker = new CacheStatsTracker();

/**
 * Build cache key with prefix
 */
export function buildCacheKey(key: string, prefix?: string): string {
  if (!prefix) {
    return key;
  }
  // Remove trailing colon from prefix if present
  const cleanPrefix = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
  return `${cleanPrefix}:${key}`;
}

/**
 * Get value from cache
 */
export async function cacheGet<T = any>(
  key: string,
  options: CacheOptions = {}
): Promise<T | null> {
  if (!config.features.enableCaching) {
    return null;
  }

  statsTracker.recordOperation('get');
  const startTime = Date.now();

  try {
    const redisClient = getRedisClient();
    if (!redisClient.isHealthy()) {
      console.warn('⚠️  Redis not healthy, skipping cache get');
      return null;
    }

    const client = redisClient.getClient();
    const cacheKey = buildCacheKey(key, options.prefix);

    const value = await client.get(cacheKey);

    // Record successful operation with latency
    recordRedisOperation(true, Date.now() - startTime);

    if (value === null) {
      statsTracker.recordMiss();
      return null;
    }

    statsTracker.recordHit();
    return JSON.parse(value) as T;
  } catch (error) {
    // Record failed operation
    recordRedisOperation(false, Date.now() - startTime);
    recordRedisError(error as Error);
    console.error('Cache get error:', error);
    // Fail gracefully - return null instead of throwing
    return null;
  }
}

/**
 * Set value in cache with TTL
 */
export async function cacheSet<T = any>(
  key: string,
  value: T,
  options: CacheOptions = {}
): Promise<boolean> {
  if (!config.features.enableCaching) {
    return false;
  }

  statsTracker.recordOperation('set');
  const startTime = Date.now();

  try {
    const redisClient = getRedisClient();
    if (!redisClient.isHealthy()) {
      console.warn('⚠️  Redis not healthy, skipping cache set');
      return false;
    }

    const client = redisClient.getClient();
    const cacheKey = buildCacheKey(key, options.prefix);
    const serialized = JSON.stringify(value);

    if (options.ttl) {
      await client.setex(cacheKey, options.ttl, serialized);
    } else {
      await client.set(cacheKey, serialized);
    }

    // Record successful operation with latency
    recordRedisOperation(true, Date.now() - startTime);
    return true;
  } catch (error) {
    // Record failed operation
    recordRedisOperation(false, Date.now() - startTime);
    recordRedisError(error as Error);
    console.error('Cache set error:', error);
    // Fail gracefully
    return false;
  }
}

/**
 * Delete value from cache
 */
export async function cacheDelete(
  key: string,
  options: CacheOptions = {}
): Promise<boolean> {
  if (!config.features.enableCaching) {
    return false;
  }

  statsTracker.recordOperation('delete');

  try {
    const redisClient = getRedisClient();
    if (!redisClient.isHealthy()) {
      console.warn('⚠️  Redis not healthy, skipping cache delete');
      return false;
    }

    const client = redisClient.getClient();
    const cacheKey = buildCacheKey(key, options.prefix);

    const result = await client.del(cacheKey);
    return result > 0;
  } catch (error) {
    console.error('Cache delete error:', error);
    return false;
  }
}

/**
 * Check if key exists in cache
 */
export async function cacheExists(
  key: string,
  options: CacheOptions = {}
): Promise<boolean> {
  if (!config.features.enableCaching) {
    return false;
  }

  try {
    const redisClient = getRedisClient();
    if (!redisClient.isHealthy()) {
      return false;
    }

    const client = redisClient.getClient();
    const cacheKey = buildCacheKey(key, options.prefix);

    const result = await client.exists(cacheKey);
    return result === 1;
  } catch (error) {
    console.error('Cache exists error:', error);
    return false;
  }
}

/**
 * Get TTL for a key
 */
export async function cacheGetTTL(
  key: string,
  options: CacheOptions = {}
): Promise<number | null> {
  if (!config.features.enableCaching) {
    return null;
  }

  try {
    const redisClient = getRedisClient();
    if (!redisClient.isHealthy()) {
      return null;
    }

    const client = redisClient.getClient();
    const cacheKey = buildCacheKey(key, options.prefix);

    const ttl = await client.ttl(cacheKey);

    // -2 means key doesn't exist, -1 means no expiration
    if (ttl === -2 || ttl === -1) {
      return null;
    }

    return ttl;
  } catch (error) {
    console.error('Cache get TTL error:', error);
    return null;
  }
}

/**
 * Delete multiple keys matching a pattern
 */
export async function cacheDeletePattern(
  pattern: string,
  options: CacheOptions = {}
): Promise<number> {
  if (!config.features.enableCaching) {
    return 0;
  }

  try {
    const redisClient = getRedisClient();
    if (!redisClient.isHealthy()) {
      return 0;
    }

    const client = redisClient.getClient();
    const searchPattern = buildCacheKey(pattern, options.prefix);

    const keys = await client.keys(searchPattern);

    if (keys.length === 0) {
      return 0;
    }

    const result = await client.del(...keys);
    return result;
  } catch (error) {
    console.error('Cache delete pattern error:', error);
    return 0;
  }
}

/**
 * Cache-aside pattern helper
 * Attempts to get from cache, if miss, executes fetcher and caches result
 */
export async function cacheAside<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions = {}
): Promise<{ data: T; cached: boolean; responseTime: number }> {
  const startTime = Date.now();

  // Try to get from cache
  const cached = await cacheGet<T>(key, options);

  if (cached !== null) {
    return {
      data: cached,
      cached: true,
      responseTime: Date.now() - startTime,
    };
  }

  // Cache miss - fetch data
  const data = await fetcher();

  // Store in cache and await to ensure it completes before returning
  try {
    await cacheSet(key, data, options);
  } catch (err) {
    console.error('Failed to cache data:', err);
  }

  return {
    data,
    cached: false,
    responseTime: Date.now() - startTime,
  };
}

/**
 * Batch get multiple keys
 */
export async function cacheMGet<T = any>(
  keys: string[],
  options: CacheOptions = {}
): Promise<Map<string, T>> {
  const result = new Map<string, T>();

  if (!config.features.enableCaching || keys.length === 0) {
    return result;
  }

  try {
    const redisClient = getRedisClient();
    if (!redisClient.isHealthy()) {
      return result;
    }

    const client = redisClient.getClient();
    const cacheKeys = keys.map(k => buildCacheKey(k, options.prefix));

    const values = await client.mget(...cacheKeys);

    values.forEach((value, index) => {
      if (value !== null) {
        try {
          result.set(keys[index], JSON.parse(value) as T);
          statsTracker.recordHit();
        } catch (error) {
          console.error(`Failed to parse cached value for key ${keys[index]}:`, error);
          statsTracker.recordMiss();
        }
      } else {
        statsTracker.recordMiss();
      }
    });

    statsTracker.recordOperation('get');
    return result;
  } catch (error) {
    console.error('Cache mget error:', error);
    return result;
  }
}

/**
 * Batch set multiple keys
 */
export async function cacheMSet(
  entries: Map<string, any>,
  options: CacheOptions = {}
): Promise<boolean> {
  if (!config.features.enableCaching || entries.size === 0) {
    return false;
  }

  try {
    const redisClient = getRedisClient();
    if (!redisClient.isHealthy()) {
      return false;
    }

    const client = redisClient.getClient();
    const pipeline = client.pipeline();

    for (const [key, value] of entries) {
      const cacheKey = buildCacheKey(key, options.prefix);
      const serialized = JSON.stringify(value);

      if (options.ttl) {
        pipeline.setex(cacheKey, options.ttl, serialized);
      } else {
        pipeline.set(cacheKey, serialized);
      }
    }

    await pipeline.exec();
    statsTracker.recordOperation('set');
    return true;
  } catch (error) {
    console.error('Cache mset error:', error);
    return false;
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats(): CacheStats {
  return statsTracker.getStats();
}

/**
 * Reset cache statistics
 */
export function resetCacheStats(): void {
  statsTracker.reset();
}

/**
 * Flush entire cache (use with caution!)
 */
export async function cacheFlush(): Promise<boolean> {
  if (!config.features.enableCaching) {
    return false;
  }

  try {
    const redisClient = getRedisClient();
    if (!redisClient.isHealthy()) {
      return false;
    }

    const client = redisClient.getClient();
    await client.flushdb();

    console.log('🗑️  Cache flushed successfully');
    statsTracker.reset();
    return true;
  } catch (error) {
    console.error('Cache flush error:', error);
    return false;
  }
}
