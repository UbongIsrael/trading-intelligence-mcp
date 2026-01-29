/**
 * Cache Service Tests
 */

import { getCacheService, CacheService } from '../../src/cache/index';
import { initializeRedis, shutdownRedis } from '../../src/cache/redis';
import { config } from '../../src/config';
import { PriceData, TechnicalAnalysis, FundamentalData } from '../../src/types';

describe('CacheService', () => {
  let cacheService: CacheService;

  beforeAll(async () => {
    if (config.features.enableCaching) {
      await initializeRedis();
    }
    cacheService = getCacheService();
  });

  afterAll(async () => {
    if (config.features.enableCaching) {
      await shutdownRedis();
    }
  });

  beforeEach(async () => {
    if (config.features.enableCaching) {
      await cacheService.flush();
      cacheService.resetStats();
    }
  });

  describe('Singleton Pattern', () => {
    test('should return same instance', () => {
      const service1 = getCacheService();
      const service2 = getCacheService();
      
      expect(service1).toBe(service2);
    });
  });

  describe('PriceCacheService', () => {
    test('should cache price data', async () => {
      if (!config.features.enableCaching) return;

      const priceData: PriceData = {
        symbol: 'AAPL',
        price: 150.5,
        currency: 'USD',
        timestamp: new Date(),
        source: 'test',
        volume24h: 1000000,
      };

      await cacheService.prices.set('AAPL', priceData);
      const cached = await cacheService.prices.get('AAPL');

      expect(cached).toBeDefined();
      expect(cached?.symbol).toBe('AAPL');
      expect(cached?.price).toBe(150.5);
    });

    test('should use getOrFetch pattern', async () => {
      if (!config.features.enableCaching) return;

      let fetcherCalled = false;
      const fetcher = async (): Promise<PriceData> => {
        fetcherCalled = true;
        return {
          symbol: 'TSLA',
          price: 200.0,
          currency: 'USD',
          timestamp: new Date(),
          source: 'test',
        };
      };

      // First call - cache miss, should fetch
      const result1 = await cacheService.prices.getOrFetch('TSLA', fetcher);
      expect(result1.cached).toBe(false);
      expect(fetcherCalled).toBe(true);

      // Second call - cache hit, should not fetch
      fetcherCalled = false;
      const result2 = await cacheService.prices.getOrFetch('TSLA', fetcher);
      expect(result2.cached).toBe(true);
      expect(fetcherCalled).toBe(false);
    });

    test('should batch get prices', async () => {
      if (!config.features.enableCaching) return;

      const prices = new Map<string, PriceData>([
        ['AAPL', { symbol: 'AAPL', price: 150, currency: 'USD', timestamp: new Date(), source: 'test' }],
        ['GOOGL', { symbol: 'GOOGL', price: 2800, currency: 'USD', timestamp: new Date(), source: 'test' }],
      ]);

      await cacheService.prices.batchSet(prices);

      const results = await cacheService.prices.batchGet(['AAPL', 'GOOGL', 'MSFT']);

      expect(results.size).toBe(2);
      expect(results.get('AAPL')?.price).toBe(150);
      expect(results.get('GOOGL')?.price).toBe(2800);
      expect(results.has('MSFT')).toBe(false);
    });

    test('should invalidate price cache', async () => {
      if (!config.features.enableCaching) return;

      const priceData: PriceData = {
        symbol: 'AAPL',
        price: 150,
        currency: 'USD',
        timestamp: new Date(),
        source: 'test',
      };

      await cacheService.prices.set('AAPL', priceData);
      expect(await cacheService.prices.exists('AAPL')).toBe(true);

      await cacheService.prices.invalidate('AAPL');
      expect(await cacheService.prices.exists('AAPL')).toBe(false);
    });
  });

  describe('LiquidityCacheService', () => {
    test('should cache liquidity data with timeframe', async () => {
      if (!config.features.enableCaching) return;

      const liquidityData: TechnicalAnalysis = {
        symbol: 'BTC',
        timeframe: '1h',
        liquidityZones: [
          { price: 50000, strength: 'strong', type: 'support', touchCount: 5 },
        ],
        trend: 'bullish',
        timestamp: new Date(),
      };

      await cacheService.liquidity.set('BTC', '1h', liquidityData);
      const cached = await cacheService.liquidity.get('BTC', '1h');

      expect(cached).toBeDefined();
      expect(cached?.symbol).toBe('BTC');
      expect(cached?.timeframe).toBe('1h');
    });

    test('should separate different timeframes', async () => {
      if (!config.features.enableCaching) return;

      const data1h: TechnicalAnalysis = {
        symbol: 'ETH',
        timeframe: '1h',
        liquidityZones: [],
        timestamp: new Date(),
      };

      const data4h: TechnicalAnalysis = {
        symbol: 'ETH',
        timeframe: '4h',
        liquidityZones: [],
        timestamp: new Date(),
      };

      await cacheService.liquidity.set('ETH', '1h', data1h);
      await cacheService.liquidity.set('ETH', '4h', data4h);

      const cached1h = await cacheService.liquidity.get('ETH', '1h');
      const cached4h = await cacheService.liquidity.get('ETH', '4h');

      expect(cached1h?.timeframe).toBe('1h');
      expect(cached4h?.timeframe).toBe('4h');
    });

    test('should invalidate all timeframes for symbol', async () => {
      if (!config.features.enableCaching) return;

      const data: TechnicalAnalysis = {
        symbol: 'BTC',
        timeframe: '1h',
        liquidityZones: [],
        timestamp: new Date(),
      };

      await cacheService.liquidity.set('BTC', '1h', data);
      await cacheService.liquidity.set('BTC', '4h', data);

      const deleted = await cacheService.liquidity.invalidateSymbol('BTC');

      expect(deleted).toBeGreaterThan(0);
      expect(await cacheService.liquidity.exists('BTC', '1h')).toBe(false);
      expect(await cacheService.liquidity.exists('BTC', '4h')).toBe(false);
    });
  });

  describe('FundamentalsCacheService', () => {
    test('should cache fundamental data', async () => {
      if (!config.features.enableCaching) return;

      const fundamentals: FundamentalData = {
        symbol: 'AAPL',
        companyName: 'Apple Inc.',
        sector: 'Technology',
        marketCap: 2800000000000,
        peRatio: 28.5,
        timestamp: new Date(),
      };

      await cacheService.fundamentals.set('AAPL', 'overview', fundamentals);
      const cached = await cacheService.fundamentals.get('AAPL', 'overview');

      expect(cached).toBeDefined();
      expect(cached?.companyName).toBe('Apple Inc.');
    });

    test('should separate different data types', async () => {
      if (!config.features.enableCaching) return;

      const overview: FundamentalData = {
        symbol: 'GOOGL',
        companyName: 'Alphabet Inc.',
        timestamp: new Date(),
      };

      const earnings: FundamentalData = {
        symbol: 'GOOGL',
        companyName: 'Alphabet Inc.',
        eps: 5.5,
        timestamp: new Date(),
      };

      await cacheService.fundamentals.set('GOOGL', 'overview', overview);
      await cacheService.fundamentals.set('GOOGL', 'earnings', earnings);

      const cachedOverview = await cacheService.fundamentals.get('GOOGL', 'overview');
      const cachedEarnings = await cacheService.fundamentals.get('GOOGL', 'earnings');

      expect(cachedOverview?.eps).toBeUndefined();
      expect(cachedEarnings?.eps).toBe(5.5);
    });
  });

  describe('Health Check', () => {
    test('should provide health status', async () => {
      const health = await cacheService.healthCheck();

      expect(health).toBeDefined();
      expect(health.enabled).toBe(config.features.enableCaching);
      expect(health.stats).toBeDefined();
      
      if (config.features.enableCaching) {
        expect(health.connected).toBe(true);
        expect(health.latency).toBeGreaterThan(0);
      }
    });
  });

  describe('Statistics', () => {
    test('should track cache statistics', async () => {
      if (!config.features.enableCaching) return;

      cacheService.resetStats();

      // Generate some cache activity
      await cacheService.prices.set('TEST', {
        symbol: 'TEST',
        price: 100,
        currency: 'USD',
        timestamp: new Date(),
        source: 'test',
      });
      await cacheService.prices.get('TEST'); // hit
      await cacheService.prices.get('MISS'); // miss

      const stats = cacheService.getStats();

      expect(stats.hits).toBeGreaterThan(0);
      expect(stats.misses).toBeGreaterThan(0);
      expect(stats.operations.get).toBeGreaterThan(0);
      expect(stats.operations.set).toBeGreaterThan(0);
    });
  });
});
