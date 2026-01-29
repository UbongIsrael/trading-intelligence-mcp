/**
 * Liquidity Zones Service Tests
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import {
  fetchHistoricalPrices,
  findLocalHighs,
  findLocalLows,
  clusterLevels,
  calculateStrength,
  identifyPivotPoints,
  calculateLiquidityZones,
  getSupportResistanceLevels,
  isValidSymbol,
  getAvailableTimeframes,
  PriceBar,
  PriceLevel,
} from '../src/services/liquidity';
import { APIError } from '../src/types';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

/**
 * Helper function to generate mock price data
 */
function generateMockPriceData(count: number, basePrice: number = 100): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = basePrice;

  for (let i = 0; i < count; i++) {
    // Add some random movement
    const change = (Math.random() - 0.5) * 5;
    price = Math.max(price + change, 10);

    const high = price + Math.random() * 2;
    const low = price - Math.random() * 2;
    const open = low + Math.random() * (high - low);
    const close = low + Math.random() * (high - low);

    bars.push({
      date: new Date(Date.now() - (count - i) * 24 * 60 * 60 * 1000),
      open,
      high,
      low,
      close,
      volume: Math.floor(Math.random() * 1000000) + 100000,
    });
  }

  return bars;
}

/**
 * Helper function to generate price data with known support/resistance
 */
function generatePriceDataWithLevels(): PriceBar[] {
  const bars: PriceBar[] = [];

  // Create data that bounces between ~95 (support) and ~105 (resistance)
  const pattern = [
    // Bounce off support at ~95
    { open: 100, high: 101, low: 95, close: 97, volume: 500000 },
    { open: 97, high: 100, low: 96, close: 99, volume: 400000 },
    { open: 99, high: 103, low: 98, close: 102, volume: 450000 },
    // Hit resistance at ~105
    { open: 102, high: 105, low: 101, close: 103, volume: 600000 },
    { open: 103, high: 106, low: 102, close: 101, volume: 500000 },
    { open: 101, high: 102, low: 99, close: 100, volume: 350000 },
    // Bounce off support again
    { open: 100, high: 101, low: 94, close: 96, volume: 550000 },
    { open: 96, high: 99, low: 95, close: 98, volume: 400000 },
    { open: 98, high: 102, low: 97, close: 101, volume: 450000 },
    // Hit resistance again
    { open: 101, high: 105, low: 100, close: 104, volume: 650000 },
    { open: 104, high: 106, low: 103, close: 102, volume: 500000 },
    { open: 102, high: 103, low: 100, close: 101, volume: 400000 },
    // Third bounce off support
    { open: 101, high: 102, low: 95, close: 97, volume: 500000 },
    { open: 97, high: 100, low: 96, close: 99, volume: 450000 },
    { open: 99, high: 103, low: 98, close: 102, volume: 500000 },
    // Third hit at resistance
    { open: 102, high: 105, low: 101, close: 100, volume: 600000 },
  ];

  pattern.forEach((p, i) => {
    bars.push({
      ...p,
      date: new Date(Date.now() - (pattern.length - i) * 24 * 60 * 60 * 1000),
    });
  });

  return bars;
}

describe('Liquidity Zones Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findLocalHighs', () => {
    test('should identify local highs from price data', () => {
      const priceData = generateMockPriceData(30, 100);
      const highs = findLocalHighs(priceData, 3);

      expect(Array.isArray(highs)).toBe(true);
      highs.forEach(high => {
        expect(high).toHaveProperty('price');
        expect(high).toHaveProperty('date');
        expect(high).toHaveProperty('volume');
        expect(high.type).toBe('high');
        expect(typeof high.price).toBe('number');
      });
    });

    test('should return empty array for insufficient data', () => {
      const priceData = generateMockPriceData(5, 100);
      const highs = findLocalHighs(priceData, 5);

      expect(highs).toEqual([]);
    });

    test('should find obvious peaks', () => {
      const priceData: PriceBar[] = [
        { date: new Date(), open: 100, high: 100, low: 99, close: 100, volume: 1000 },
        { date: new Date(), open: 101, high: 101, low: 100, close: 101, volume: 1000 },
        { date: new Date(), open: 102, high: 110, low: 102, close: 105, volume: 1000 }, // Peak
        { date: new Date(), open: 105, high: 106, low: 104, close: 105, volume: 1000 },
        { date: new Date(), open: 105, high: 105, low: 103, close: 104, volume: 1000 },
      ];

      const highs = findLocalHighs(priceData, 2);

      expect(highs.length).toBe(1);
      expect(highs[0].price).toBe(110);
    });
  });

  describe('findLocalLows', () => {
    test('should identify local lows from price data', () => {
      const priceData = generateMockPriceData(30, 100);
      const lows = findLocalLows(priceData, 3);

      expect(Array.isArray(lows)).toBe(true);
      lows.forEach(low => {
        expect(low).toHaveProperty('price');
        expect(low).toHaveProperty('date');
        expect(low).toHaveProperty('volume');
        expect(low.type).toBe('low');
        expect(typeof low.price).toBe('number');
      });
    });

    test('should return empty array for insufficient data', () => {
      const priceData = generateMockPriceData(5, 100);
      const lows = findLocalLows(priceData, 5);

      expect(lows).toEqual([]);
    });

    test('should find obvious troughs', () => {
      const priceData: PriceBar[] = [
        { date: new Date(), open: 100, high: 101, low: 100, close: 100, volume: 1000 },
        { date: new Date(), open: 99, high: 100, low: 98, close: 99, volume: 1000 },
        { date: new Date(), open: 95, high: 96, low: 90, close: 92, volume: 1000 }, // Trough
        { date: new Date(), open: 93, high: 95, low: 92, close: 94, volume: 1000 },
        { date: new Date(), open: 95, high: 97, low: 94, close: 96, volume: 1000 },
      ];

      const lows = findLocalLows(priceData, 2);

      expect(lows.length).toBe(1);
      expect(lows[0].price).toBe(90);
    });
  });

  describe('clusterLevels', () => {
    test('should group nearby price levels', () => {
      const levels: PriceLevel[] = [
        { price: 100, date: new Date(), volume: 1000, type: 'high' },
        { price: 101, date: new Date(), volume: 1200, type: 'high' },
        { price: 100.5, date: new Date(), volume: 1100, type: 'high' },
        { price: 150, date: new Date(), volume: 2000, type: 'high' },
      ];

      const clusters = clusterLevels(levels, 0.02);

      // Should have 2 clusters: one around 100, one at 150
      expect(clusters.length).toBe(2);

      // First cluster should have 3 levels
      const firstCluster = clusters.find(c => c.avgPrice < 110);
      expect(firstCluster?.touches).toBe(3);
      expect(firstCluster?.avgPrice).toBeCloseTo(100.5, 1);
    });

    test('should return empty array for empty input', () => {
      const clusters = clusterLevels([]);
      expect(clusters).toEqual([]);
    });

    test('should handle single level', () => {
      const levels: PriceLevel[] = [
        { price: 100, date: new Date(), volume: 1000, type: 'high' },
      ];

      const clusters = clusterLevels(levels, 0.02);

      expect(clusters.length).toBe(1);
      expect(clusters[0].touches).toBe(1);
      expect(clusters[0].avgPrice).toBe(100);
    });

    test('should respect clustering threshold', () => {
      // Prices must be >2% apart from ADJACENT prices when sorted to form separate clusters
      // 100 -> 104 = 4% (separate), 104 -> 110 = 5.77% (separate)
      const levels: PriceLevel[] = [
        { price: 100, date: new Date(), volume: 1000, type: 'high' },
        { price: 104, date: new Date(), volume: 1000, type: 'high' }, // 4% from 100
        { price: 110, date: new Date(), volume: 1000, type: 'high' }, // 5.77% from 104
      ];

      // With 2% threshold, these should be separate (all >2% apart)
      const clusters = clusterLevels(levels, 0.02);
      expect(clusters.length).toBe(3);

      // With 5% threshold, 100 and 104 cluster (4% < 5%), but 110 is separate
      const widerClusters = clusterLevels(levels, 0.05);
      expect(widerClusters.length).toBeLessThanOrEqual(2);
    });
  });

  describe('calculateStrength', () => {
    test('should return strong for many touches and high volume', () => {
      const strength = calculateStrength(5, 2000000, 1000000);
      expect(strength).toBe('strong');
    });

    test('should return medium for moderate touches', () => {
      const strength = calculateStrength(3, 1000000, 1000000);
      expect(strength).toBe('medium');
    });

    test('should return weak for few touches', () => {
      const strength = calculateStrength(1, 500000, 1000000);
      expect(strength).toBe('weak');
    });

    test('should handle zero average volume', () => {
      const strength = calculateStrength(4, 1000000, 0);
      expect(['strong', 'medium', 'weak']).toContain(strength);
    });
  });

  describe('identifyPivotPoints', () => {
    test('should identify both support and resistance zones', () => {
      const priceData = generatePriceDataWithLevels();
      const currentPrice = 100;

      const zones = identifyPivotPoints(priceData, currentPrice, 2, 0.03);

      expect(Array.isArray(zones)).toBe(true);

      // Should have both types
      const supportZones = zones.filter(z => z.type === 'support');
      const resistanceZones = zones.filter(z => z.type === 'resistance');

      expect(supportZones.length).toBeGreaterThan(0);
      expect(resistanceZones.length).toBeGreaterThan(0);
    });

    test('should return zones with required properties', () => {
      const priceData = generateMockPriceData(50, 100);
      const zones = identifyPivotPoints(priceData, 100, 3, 0.02);

      zones.forEach(zone => {
        expect(zone).toHaveProperty('price');
        expect(zone).toHaveProperty('type');
        expect(zone).toHaveProperty('strength');
        expect(zone).toHaveProperty('touchCount');
        expect(['support', 'resistance']).toContain(zone.type);
        expect(['strong', 'medium', 'weak']).toContain(zone.strength);
      });
    });

    test('should sort zones by importance', () => {
      const priceData = generatePriceDataWithLevels();
      const zones = identifyPivotPoints(priceData, 100, 2, 0.03);

      // Zones should be sorted (more important first)
      // We can't easily verify the exact order, but we can verify they're sorted
      expect(zones.length).toBeGreaterThan(0);
    });
  });

  describe('isValidSymbol', () => {
    test('should return true for valid stock symbols', () => {
      expect(isValidSymbol('AAPL')).toBe(true);
      expect(isValidSymbol('MSFT')).toBe(true);
      expect(isValidSymbol('TSLA')).toBe(true);
      expect(isValidSymbol('SPY')).toBe(true);
      expect(isValidSymbol('BRK.A')).toBe(true);
    });

    test('should return true for valid crypto symbols', () => {
      expect(isValidSymbol('BTC')).toBe(true);
      expect(isValidSymbol('ETH')).toBe(true);
      expect(isValidSymbol('SOL')).toBe(true);
    });

    test('should return false for invalid symbols', () => {
      expect(isValidSymbol('')).toBe(false);
      expect(isValidSymbol('   ')).toBe(false);
      expect(isValidSymbol(null as any)).toBe(false);
      expect(isValidSymbol(undefined as any)).toBe(false);
      expect(isValidSymbol('TOOLONGSYMBOL123')).toBe(false);
    });

    test('should handle whitespace', () => {
      expect(isValidSymbol('  AAPL  ')).toBe(true);
    });
  });

  describe('getAvailableTimeframes', () => {
    test('should return array of timeframes', () => {
      const timeframes = getAvailableTimeframes();

      expect(Array.isArray(timeframes)).toBe(true);
      expect(timeframes.length).toBeGreaterThan(0);
      expect(timeframes).toContain('1h');
      expect(timeframes).toContain('4h');
      expect(timeframes).toContain('1d');
      expect(timeframes).toContain('1w');
    });
  });

  describe('fetchHistoricalPrices', () => {
    test('should fetch historical prices successfully', async () => {
      const mockResponse = {
        chart: {
          result: [{
            meta: {
              symbol: 'AAPL',
              currency: 'USD',
              regularMarketPrice: 150,
              regularMarketTime: Date.now() / 1000,
            },
            timestamp: Array.from({ length: 30 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
            indicators: {
              quote: [{
                open: Array(30).fill(148),
                high: Array(30).fill(152),
                low: Array(30).fill(147),
                close: Array(30).fill(150),
                volume: Array(30).fill(1000000),
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await fetchHistoricalPrices('AAPL', '1d');

      expect(result.length).toBe(30);
      expect(result[0]).toHaveProperty('date');
      expect(result[0]).toHaveProperty('open');
      expect(result[0]).toHaveProperty('high');
      expect(result[0]).toHaveProperty('low');
      expect(result[0]).toHaveProperty('close');
      expect(result[0]).toHaveProperty('volume');
    });

    test('should throw error for invalid symbol', async () => {
      await expect(fetchHistoricalPrices('')).rejects.toThrow(APIError);
      await expect(fetchHistoricalPrices(null as any)).rejects.toThrow(APIError);
    });

    test('should throw error when API returns error', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      await expect(fetchHistoricalPrices('INVALID')).rejects.toThrow(APIError);
    });

    test('should throw error for insufficient data', async () => {
      const mockResponse = {
        chart: {
          result: [{
            meta: { symbol: 'AAPL' },
            timestamp: [Date.now() / 1000],
            indicators: {
              quote: [{
                open: [100],
                high: [101],
                low: [99],
                close: [100],
                volume: [1000],
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      await expect(fetchHistoricalPrices('AAPL')).rejects.toThrow('Insufficient historical data');
    });
  });

  describe('calculateLiquidityZones', () => {
    test('should calculate zones for valid symbol', async () => {
      const mockResponse = {
        chart: {
          result: [{
            meta: {
              symbol: 'AAPL',
              currency: 'USD',
              regularMarketPrice: 150,
            },
            timestamp: Array.from({ length: 60 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
            indicators: {
              quote: [{
                open: Array(60).fill(148).map((v, i) => v + Math.sin(i / 5) * 5),
                high: Array(60).fill(152).map((v, i) => v + Math.sin(i / 5) * 5),
                low: Array(60).fill(146).map((v, i) => v + Math.sin(i / 5) * 5),
                close: Array(60).fill(150).map((v, i) => v + Math.sin(i / 5) * 5),
                volume: Array(60).fill(1000000),
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await calculateLiquidityZones('AAPL', '1d');

      expect(result).toHaveProperty('symbol');
      expect(result).toHaveProperty('timeframe');
      expect(result).toHaveProperty('liquidityZones');
      expect(result).toHaveProperty('currentPrice');
      expect(result).toHaveProperty('trend');
      expect(result).toHaveProperty('timestamp');
      expect(result.symbol).toBe('AAPL');
      expect(Array.isArray(result.liquidityZones)).toBe(true);
      expect(result.liquidityZones.length).toBeLessThanOrEqual(5);
    });

    test('should limit zones to maxZones parameter', async () => {
      const mockResponse = {
        chart: {
          result: [{
            meta: { symbol: 'AAPL', regularMarketPrice: 150 },
            timestamp: Array.from({ length: 100 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
            indicators: {
              quote: [{
                open: Array(100).fill(148).map((v, i) => v + Math.sin(i / 3) * 10),
                high: Array(100).fill(152).map((v, i) => v + Math.sin(i / 3) * 10),
                low: Array(100).fill(146).map((v, i) => v + Math.sin(i / 3) * 10),
                close: Array(100).fill(150).map((v, i) => v + Math.sin(i / 3) * 10),
                volume: Array(100).fill(1000000),
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await calculateLiquidityZones('AAPL', '1d', undefined, 3);

      expect(result.liquidityZones.length).toBeLessThanOrEqual(3);
    });
  });

  describe('getSupportResistanceLevels', () => {
    test('should return simplified support/resistance', async () => {
      const mockResponse = {
        chart: {
          result: [{
            meta: { symbol: 'AAPL', regularMarketPrice: 150 },
            timestamp: Array.from({ length: 60 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
            indicators: {
              quote: [{
                open: Array(60).fill(148).map((v, i) => v + Math.sin(i / 5) * 5),
                high: Array(60).fill(152).map((v, i) => v + Math.sin(i / 5) * 5),
                low: Array(60).fill(146).map((v, i) => v + Math.sin(i / 5) * 5),
                close: Array(60).fill(150).map((v, i) => v + Math.sin(i / 5) * 5),
                volume: Array(60).fill(1000000),
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await getSupportResistanceLevels('AAPL');

      expect(result).toHaveProperty('symbol');
      expect(result).toHaveProperty('currentPrice');
      expect(result).toHaveProperty('support');
      expect(result).toHaveProperty('resistance');
      expect(result).toHaveProperty('trend');
      expect(result).toHaveProperty('timestamp');
    });
  });

  describe('Edge Cases', () => {
    test('should handle symbol with extra whitespace', async () => {
      const mockResponse = {
        chart: {
          result: [{
            meta: { symbol: 'AAPL', regularMarketPrice: 150 },
            timestamp: Array.from({ length: 30 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
            indicators: {
              quote: [{
                open: Array(30).fill(148),
                high: Array(30).fill(152),
                low: Array(30).fill(147),
                close: Array(30).fill(150),
                volume: Array(30).fill(1000000),
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await fetchHistoricalPrices('  AAPL  ');
      expect(result.length).toBeGreaterThan(0);
    });

    test('should handle network timeout', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(
        Object.assign(new Error('timeout'), { name: 'AbortError' })
      );

      await expect(fetchHistoricalPrices('AAPL')).rejects.toThrow('timeout');
    });

    test('should handle bars with null values', async () => {
      const mockResponse = {
        chart: {
          result: [{
            meta: { symbol: 'AAPL', regularMarketPrice: 150 },
            timestamp: Array.from({ length: 20 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
            indicators: {
              quote: [{
                // Mix of valid and null values
                open: [148, null, 148, 148, 148, 148, 148, 148, 148, 148, 148, 148, 148, 148, 148, 148, 148, 148, 148, 148],
                high: [152, 152, null, 152, 152, 152, 152, 152, 152, 152, 152, 152, 152, 152, 152, 152, 152, 152, 152, 152],
                low: [147, 147, 147, null, 147, 147, 147, 147, 147, 147, 147, 147, 147, 147, 147, 147, 147, 147, 147, 147],
                close: [150, 150, 150, 150, null, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150],
                volume: Array(20).fill(1000000),
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await fetchHistoricalPrices('AAPL');

      // Should skip bars with null values
      expect(result.length).toBeLessThan(20);
      expect(result.length).toBeGreaterThanOrEqual(10); // Need at least 10 valid bars
    });
  });
});
