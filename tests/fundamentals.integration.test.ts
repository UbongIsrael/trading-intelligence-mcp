/**
 * Fundamentals Integration Tests
 * Tests the fundamentals service with cache integration and real API (if configured)
 */

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import {
  fetchCompanyOverview,
  fetchEarnings,
  isFinnhubConfigured,
  SUPPORTED_STOCKS,
} from '../src/services/fundamentals';
import { getCacheService, initializeRedis, shutdownRedis } from '../src/cache/index';

// Increase timeout for API calls
jest.setTimeout(30000);

describe('Fundamentals Integration Tests', () => {
  let cacheService: ReturnType<typeof getCacheService>;
  const isConfigured = isFinnhubConfigured();

  beforeAll(async () => {
    try {
      await initializeRedis();
      cacheService = getCacheService();
    } catch (error) {
      console.log('Redis not available for integration tests');
    }
  }, 30000);

  afterAll(async () => {
    try {
      await shutdownRedis();
    } catch (error) {
      // Ignore shutdown errors
    }
  });

  describe('Cache Integration', () => {
    test('should check if fundamentals cache service exists', () => {
      if (!cacheService) {
        console.log('Cache service not available');
        return;
      }
      expect(cacheService.fundamentals).toBeDefined();
      expect(typeof cacheService.fundamentals.getOrFetch).toBe('function');
    });

    test('should cache and retrieve fundamental data', async () => {
      if (!cacheService) return;

      const testData = {
        symbol: 'TEST',
        companyName: 'Test Company',
        sector: 'Technology',
        timestamp: new Date(),
      };

      const setResult = await cacheService.fundamentals.set('TEST', 'overview', testData as any);
      expect(setResult).toBe(true);

      const cached = await cacheService.fundamentals.get('TEST', 'overview');
      expect(cached).toBeDefined();
      expect(cached?.symbol).toBe('TEST');
    });
  });

  describe('Real API Tests', () => {
    const skipIfNotConfigured = !isConfigured ? test.skip : test;

    skipIfNotConfigured('should fetch real company overview for AAPL', async () => {
      const result = await fetchCompanyOverview('AAPL');
      expect(result.symbol).toBe('AAPL');
      expect(result.name).toBeTruthy();
      expect(result.marketCap).toBeGreaterThan(0);
    });

    skipIfNotConfigured('should fetch real earnings for MSFT', async () => {
      const result = await fetchEarnings('MSFT', 4);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].symbol).toBe('MSFT');
    });
  });

  describe('Supported Stocks Validation', () => {
    test('should have valid stock symbols', () => {
      SUPPORTED_STOCKS.forEach(symbol => {
        expect(symbol).toMatch(/^[A-Z]{1,5}$/);
      });
    });

    test('should have no duplicates', () => {
      const uniqueSymbols = new Set(SUPPORTED_STOCKS);
      expect(uniqueSymbols.size).toBe(SUPPORTED_STOCKS.length);
    });
  });
});
