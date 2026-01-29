/**
 * Cache Utilities Tests
 */

import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheExists,
  cacheGetTTL,
  cacheAside,
  cacheMGet,
  cacheMSet,
  getCacheStats,
  resetCacheStats,
  buildCacheKey,
} from '../../src/cache/utils';
import { initializeRedis, shutdownRedis } from '../../src/cache/redis';
import { config } from '../../src/config';

describe('Cache Utilities', () => {
  beforeAll(async () => {
    if (config.features.enableCaching) {
      await initializeRedis();
      resetCacheStats();
    }
  }, 30000);

  afterAll(async () => {
    if (config.features.enableCaching) {
      await shutdownRedis();
    }
  });

  beforeEach(() => {
    resetCacheStats();
  });

  describe('buildCacheKey', () => {
    test('should build key without prefix', () => {
      const key = buildCacheKey('test-key');
      expect(key).toBe('test-key');
    });

    test('should build key with prefix', () => {
      const key = buildCacheKey('test-key', 'prefix:');
      expect(key).toBe('prefix:test-key');
    });

    test('should handle prefix without trailing colon', () => {
      const key = buildCacheKey('test-key', 'prefix');
      expect(key).toBe('prefix:test-key');
    });
  });

  describe('Basic Cache Operations', () => {
    test('should set and get value', async () => {
      if (!config.features.enableCaching) return;

      const key = 'test-key-1';
      const value = { data: 'test-value', timestamp: Date.now() };

      const setResult = await cacheSet(key, value);
      expect(setResult).toBe(true);

      const getValue = await cacheGet(key);
      expect(getValue).toEqual(value);
    });

    test('should return null for non-existent key', async () => {
      if (!config.features.enableCaching) return;

      const value = await cacheGet('non-existent-key');
      expect(value).toBeNull();
    });

    test('should delete value', async () => {
      if (!config.features.enableCaching) return;

      const key = 'test-key-2';
      await cacheSet(key, { data: 'test' });

      const deleteResult = await cacheDelete(key);
      expect(deleteResult).toBe(true);

      const getValue = await cacheGet(key);
      expect(getValue).toBeNull();
    });

    test('should check if key exists', async () => {
      if (!config.features.enableCaching) return;

      const key = 'test-key-3';

      let exists = await cacheExists(key);
      expect(exists).toBe(false);

      await cacheSet(key, { data: 'test' });

      exists = await cacheExists(key);
      expect(exists).toBe(true);
    });
  });

  describe('TTL Management', () => {
    test('should set value with TTL', async () => {
      if (!config.features.enableCaching) return;

      const key = 'test-key-ttl';
      const value = { data: 'expires soon' };
      const ttl = 60; // 60 seconds

      await cacheSet(key, value, { ttl });

      const remainingTTL = await cacheGetTTL(key);
      expect(remainingTTL).toBeLessThanOrEqual(ttl);
      expect(remainingTTL).toBeGreaterThan(0);
    });

    test('should expire after TTL', async () => {
      if (!config.features.enableCaching) return;

      const key = 'test-key-expire';
      const value = { data: 'expires fast' };
      const ttl = 1; // 1 second

      await cacheSet(key, value, { ttl });

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1500));

      const getValue = await cacheGet(key);
      expect(getValue).toBeNull();
    }, 10000);
  });

  describe('Prefix Support', () => {
    test('should use prefix in operations', async () => {
      if (!config.features.enableCaching) return;

      const key = 'symbol-1';
      const prefix = 'price:';
      const value = { price: 100, symbol: 'AAPL' };

      await cacheSet(key, value, { prefix });
      const getValue = await cacheGet(key, { prefix });

      expect(getValue).toEqual(value);
    });
  });

  describe('Cache-Aside Pattern', () => {
    test('should fetch on cache miss', async () => {
      if (!config.features.enableCaching) return;

      const key = 'test-aside-1';
      let fetcherCalled = false;

      const fetcher = async () => {
        fetcherCalled = true;
        return { data: 'fetched-value' };
      };

      const result = await cacheAside(key, fetcher);

      expect(result.data).toEqual({ data: 'fetched-value' });
      expect(result.cached).toBe(false);
      expect(fetcherCalled).toBe(true);
    });

    test('should use cache on cache hit', async () => {
      if (!config.features.enableCaching) return;

      const key = 'test-aside-2';
      const cachedValue = { data: 'cached-value' };

      await cacheSet(key, cachedValue);

      let fetcherCalled = false;
      const fetcher = async () => {
        fetcherCalled = true;
        return { data: 'fetched-value' };
      };

      const result = await cacheAside(key, fetcher);

      expect(result.data).toEqual(cachedValue);
      expect(result.cached).toBe(true);
      expect(fetcherCalled).toBe(false);
    });

    test('should measure response time', async () => {
      if (!config.features.enableCaching) return;

      const key = 'test-aside-3';
      const fetcher = async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { data: 'value' };
      };

      const result = await cacheAside(key, fetcher);

      expect(result.responseTime).toBeGreaterThan(0);
    });
  });

  describe('Batch Operations', () => {
    test('should get multiple keys', async () => {
      if (!config.features.enableCaching) return;

      const data = new Map([
        ['key1', { value: 1 }],
        ['key2', { value: 2 }],
        ['key3', { value: 3 }],
      ]);

      await cacheMSet(data);

      const results = await cacheMGet(['key1', 'key2', 'key3', 'key4']);

      expect(results.get('key1')).toEqual({ value: 1 });
      expect(results.get('key2')).toEqual({ value: 2 });
      expect(results.get('key3')).toEqual({ value: 3 });
      expect(results.has('key4')).toBe(false);
    });

    test('should set multiple keys', async () => {
      if (!config.features.enableCaching) return;

      const data = new Map([
        ['batch-key1', { value: 'a' }],
        ['batch-key2', { value: 'b' }],
      ]);

      const result = await cacheMSet(data);
      expect(result).toBe(true);

      const value1 = await cacheGet('batch-key1');
      const value2 = await cacheGet('batch-key2');

      expect(value1).toEqual({ value: 'a' });
      expect(value2).toEqual({ value: 'b' });
    });
  });

  describe('Cache Statistics', () => {
    test('should track cache hits and misses', async () => {
      if (!config.features.enableCaching) return;

      resetCacheStats();

      // Cache miss
      await cacheGet('miss-key');

      // Cache hit
      await cacheSet('hit-key', { data: 'test' });
      await cacheGet('hit-key');

      const stats = getCacheStats();

      expect(stats.hits).toBeGreaterThan(0);
      expect(stats.misses).toBeGreaterThan(0);
      expect(stats.hitRate).toBeGreaterThan(0);
      expect(stats.hitRate).toBeLessThanOrEqual(1);
    });

    test('should track operations', async () => {
      if (!config.features.enableCaching) return;

      resetCacheStats();

      await cacheSet('ops-key', { data: 'test' });
      await cacheGet('ops-key');
      await cacheDelete('ops-key');

      const stats = getCacheStats();

      expect(stats.operations.get).toBeGreaterThan(0);
      expect(stats.operations.set).toBeGreaterThan(0);
      expect(stats.operations.delete).toBeGreaterThan(0);
    });

    test('should calculate hit rate correctly', async () => {
      if (!config.features.enableCaching) return;

      resetCacheStats();

      // Set up cache
      await cacheSet('rate-key', { data: 'test' });

      // 3 hits
      await cacheGet('rate-key');
      await cacheGet('rate-key');
      await cacheGet('rate-key');

      // 1 miss
      await cacheGet('non-existent');

      const stats = getCacheStats();

      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0.75); // 3/4
    });
  });

  describe('Performance', () => {
    test('should complete cache operations quickly', async () => {
      if (!config.features.enableCaching) return;

      const key = 'perf-key';
      const value = { data: 'performance test' };

      // Set operation
      const setStart = Date.now();
      await cacheSet(key, value);
      const setDuration = Date.now() - setStart;
      expect(setDuration).toBeLessThan(500); // <500ms for networked Redis

      // Get operation
      const getStart = Date.now();
      await cacheGet(key);
      const getDuration = Date.now() - getStart;
      expect(getDuration).toBeLessThan(500); // <500ms for networked Redis
    });

    test('should handle large data efficiently', async () => {
      if (!config.features.enableCaching) return;

      const key = 'large-data';
      const largeValue = {
        items: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          data: `item-${i}`,
          timestamp: Date.now(),
        })),
      };

      const start = Date.now();
      await cacheSet(key, largeValue);
      await cacheGet(key);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(2000); // <2000ms for large data over network
    });
  });
});
