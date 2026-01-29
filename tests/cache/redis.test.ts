/**
 * Redis Client Tests
 */

import { RedisClient, getRedisClient, initializeRedis, shutdownRedis } from '../../src/cache/redis';
import { config } from '../../src/config';

describe('RedisClient', () => {
  let redisClient: RedisClient;

  beforeAll(async () => {
    if (config.features.enableCaching) {
      redisClient = await initializeRedis();
    }
  });

  afterAll(async () => {
    if (config.features.enableCaching) {
      await shutdownRedis();
    }
  });

  describe('Connection Management', () => {
    test('should connect to Redis successfully', async () => {
      if (!config.features.enableCaching) {
        console.log('Skipping: Caching disabled');
        return;
      }

      expect(redisClient).toBeDefined();
      expect(redisClient.isHealthy()).toBe(true);
    });

    test('should handle health check', async () => {
      if (!config.features.enableCaching) {
        return;
      }

      const health = await redisClient.healthCheck();

      expect(health).toBeDefined();
      expect(health.connected).toBe(true);
      expect(health.latency).toBeGreaterThan(0);
      expect(health.latency).toBeLessThan(1000); // Should be fast
    });

    test('should get client instance', () => {
      if (!config.features.enableCaching) {
        return;
      }

      const client = redisClient.getClient();
      expect(client).toBeDefined();
      expect(typeof client.get).toBe('function');
      expect(typeof client.set).toBe('function');
    });

    test('should return singleton instance', () => {
      const client1 = getRedisClient();
      const client2 = getRedisClient();

      expect(client1).toBe(client2);
    });
  });

  describe('Error Handling', () => {
    test('should throw error when getting client if not connected', () => {
      const disconnectedClient = new RedisClient();

      expect(() => disconnectedClient.getClient()).toThrow('Redis client not connected');
    });

    test('should handle connection errors gracefully', async () => {
      const badClient = new RedisClient();
      const originalUrl = config.redis.url;

      // Temporarily set bad URL
      config.redis.url = 'redis://invalid-host:9999';

      try {
        await badClient.connect();
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.code).toBe('CACHE_ERROR');
      } finally {
        config.redis.url = originalUrl;
      }
    });
  });

  describe('Disconnect', () => {
    test('should disconnect gracefully', async () => {
      if (!config.features.enableCaching) {
        return;
      }

      const testClient = new RedisClient();
      await testClient.connect();

      expect(testClient.isHealthy()).toBe(true);

      await testClient.disconnect();

      expect(testClient.isHealthy()).toBe(false);
    }, 10000);
  },);
});
