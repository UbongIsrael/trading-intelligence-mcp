/**
 * Funding Rates Service Tests
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import {
  fetchFundingRate,
  fetchMultipleFundingRates,
  fetchAllFundingRates,
  calculateFundingRateStats,
  isPerpetualAvailable,
  getSupportedPerpetualSymbols,
} from '../src/services/funding';
import { APIError } from '../src/types';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('Funding Rates Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchFundingRate', () => {
    test('should fetch funding rate for BTC', async () => {
      const mockResponse = {
        symbol: 'BTCUSDT',
        markPrice: '45325.12',
        indexPrice: '45321.35',
        lastFundingRate: '0.0001',
        interestRate: '0.00005',
        nextFundingTime: 1708329600000,
        time: 1708301234567,
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await fetchFundingRate('BTC');

      expect(result).toBeDefined();
      expect(result.symbol).toBe('BTC');
      expect(result.exchange).toBe('binance');
      expect(result.rate).toBe(0.0001);
      expect(result.predictedRate).toBe(0.00005);
      expect(result.nextFundingTime).toBeInstanceOf(Date);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    test('should handle USDT suffix correctly', async () => {
      const mockResponse = {
        symbol: 'ETHUSDT',
        markPrice: '2500.00',
        lastFundingRate: '0.00015',
        interestRate: '0.0001',
        nextFundingTime: 1708329600000,
        time: 1708301234567,
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await fetchFundingRate('ETHUSDT');

      expect(result.symbol).toBe('ETH');
      expect(result.rate).toBe(0.00015);
    });

    test('should throw error for invalid symbol', async () => {
      await expect(fetchFundingRate('INVALID')).rejects.toThrow(APIError);
      await expect(fetchFundingRate('INVALID')).rejects.toThrow('Unknown perpetual symbol');
    });

    test('should throw error on API failure', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(fetchFundingRate('BTC')).rejects.toThrow(APIError);
    });

    test('should handle rate limit error', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'Retry-After': '60' }),
      } as Response);

      await expect(fetchFundingRate('BTC')).rejects.toThrow('rate limit');
    });

    test('should handle network timeout', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(
        Object.assign(new Error('timeout'), { name: 'AbortError' })
      );

      await expect(fetchFundingRate('BTC')).rejects.toThrow('timeout');
    });

    test('should parse negative funding rate', async () => {
      const mockResponse = {
        symbol: 'BTCUSDT',
        markPrice: '45325.12',
        lastFundingRate: '-0.0002',
        interestRate: '-0.00015',
        nextFundingTime: 1708329600000,
        time: 1708301234567,
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await fetchFundingRate('BTC');

      expect(result.rate).toBe(-0.0002);
      expect(result.predictedRate).toBe(-0.00015);
    });
  });

  describe('fetchMultipleFundingRates', () => {
    test('should fetch funding rates for multiple symbols', async () => {
      const mockResponse = [
        {
          symbol: 'BTCUSDT',
          markPrice: '45325.12',
          lastFundingRate: '0.0001',
          interestRate: '0.00005',
          nextFundingTime: 1708329600000,
          time: 1708301234567,
        },
        {
          symbol: 'ETHUSDT',
          markPrice: '2500.00',
          lastFundingRate: '0.00015',
          interestRate: '0.0001',
          nextFundingTime: 1708329600000,
          time: 1708301234567,
        },
        {
          symbol: 'SOLUSDT',
          markPrice: '100.00',
          lastFundingRate: '0.0002',
          interestRate: '0.00015',
          nextFundingTime: 1708329600000,
          time: 1708301234567,
        },
      ];

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const symbols = ['BTC', 'ETH', 'SOL'];
      const results = await fetchMultipleFundingRates(symbols);

      expect(results.size).toBe(3);
      expect(results.has('BTC')).toBe(true);
      expect(results.has('ETH')).toBe(true);
      expect(results.has('SOL')).toBe(true);

      const btcRate = results.get('BTC');
      expect(btcRate?.rate).toBe(0.0001);
    });

    test('should handle partial failures gracefully', async () => {
      const mockResponse = [
        {
          symbol: 'BTCUSDT',
          markPrice: '45325.12',
          lastFundingRate: '0.0001',
          interestRate: '0.00005',
          nextFundingTime: 1708329600000,
          time: 1708301234567,
        },
      ];

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const symbols = ['BTC', 'INVALID_SYMBOL'];
      const results = await fetchMultipleFundingRates(symbols);

      // Should still return BTC even though INVALID_SYMBOL fails
      expect(results.size).toBe(1);
      expect(results.has('BTC')).toBe(true);
    });

    test('should return empty map when all symbols are invalid', async () => {
      const results = await fetchMultipleFundingRates(['INVALID1', 'INVALID2']);
      expect(results.size).toBe(0);
    });
  });

  describe('fetchAllFundingRates', () => {
    test('should fetch all available funding rates', async () => {
      const mockResponse = Array.from({ length: 50 }, (_, i) => ({
        symbol: `SYMBOL${i}USDT`,
        markPrice: '100.00',
        lastFundingRate: (i * 0.00001).toString(),
        interestRate: '0.00005',
        nextFundingTime: 1708329600000,
        time: 1708301234567,
      }));

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const results = await fetchAllFundingRates();

      expect(results.length).toBe(50);
      expect(results[0]).toHaveProperty('symbol');
      expect(results[0]).toHaveProperty('rate');
      expect(results[0]).toHaveProperty('exchange');
    });

    test('should handle API errors gracefully', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(
        new Error('Network error')
      );

      const results = await fetchAllFundingRates();
      expect(results.length).toBe(0);
    });
  });

  describe('calculateFundingRateStats', () => {
    test('should calculate statistics from historical data', async () => {
      const mockHistorical = [
        { symbol: 'BTCUSDT', fundingRate: '0.0001', fundingTime: 1708329600000 },
        { symbol: 'BTCUSDT', fundingRate: '0.0002', fundingTime: 1708300800000 },
        { symbol: 'BTCUSDT', fundingRate: '0.00015', fundingTime: 1708272000000 },
        { symbol: 'BTCUSDT', fundingRate: '0.00005', fundingTime: 1708243200000 },
      ];

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockHistorical,
      } as Response);

      const stats = await calculateFundingRateStats('BTC', 4);

      expect(stats.symbol).toBe('BTC');
      expect(stats.current).toBe(0.0001);
      expect(stats.high).toBe(0.0002);
      expect(stats.low).toBe(0.00005);
      expect(stats.count).toBe(4);
      
      // Average should be (0.0001 + 0.0002 + 0.00015 + 0.00005) / 4 = 0.000125
      expect(stats.average).toBeCloseTo(0.000125, 6);
    });

    test('should throw error when no historical data available', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

      await expect(calculateFundingRateStats('BTC')).rejects.toThrow(APIError);
    });
  });

  describe('isPerpetualAvailable', () => {
    test('should return true for supported symbols', () => {
      expect(isPerpetualAvailable('BTC')).toBe(true);
      expect(isPerpetualAvailable('ETH')).toBe(true);
      expect(isPerpetualAvailable('SOL')).toBe(true);
      expect(isPerpetualAvailable('BTCUSDT')).toBe(true);
    });

    test('should return false for unsupported symbols', () => {
      expect(isPerpetualAvailable('INVALID')).toBe(false);
      expect(isPerpetualAvailable('UNKNOWN')).toBe(false);
    });

    test('should be case-insensitive', () => {
      expect(isPerpetualAvailable('btc')).toBe(true);
      expect(isPerpetualAvailable('Eth')).toBe(true);
      expect(isPerpetualAvailable('ETHUSDT')).toBe(true);
    });
  });

  describe('getSupportedPerpetualSymbols', () => {
    test('should return array of supported symbols', () => {
      const symbols = getSupportedPerpetualSymbols();

      expect(Array.isArray(symbols)).toBe(true);
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols).toContain('BTC');
      expect(symbols).toContain('ETH');
      expect(symbols).toContain('SOL');
    });

    test('should return symbols in uppercase', () => {
      const symbols = getSupportedPerpetualSymbols();

      symbols.forEach(symbol => {
        expect(symbol).toBe(symbol.toUpperCase());
      });
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty string symbol', async () => {
      await expect(fetchFundingRate('')).rejects.toThrow(APIError);
    });

    test('should handle null/undefined symbol', async () => {
      await expect(fetchFundingRate(null as any)).rejects.toThrow(APIError);
      await expect(fetchFundingRate(undefined as any)).rejects.toThrow(APIError);
    });

    test('should handle symbols with extra whitespace', async () => {
      const mockResponse = {
        symbol: 'BTCUSDT',
        markPrice: '45325.12',
        lastFundingRate: '0.0001',
        interestRate: '0.00005',
        nextFundingTime: 1708329600000,
        time: 1708301234567,
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await fetchFundingRate('  BTC  ');
      expect(result.symbol).toBe('BTC');
    });

    test('should handle very large and very small funding rates', async () => {
      const mockResponse = {
        symbol: 'BTCUSDT',
        markPrice: '45325.12',
        lastFundingRate: '0.01', // 1% - very high
        interestRate: '0.00005',
        nextFundingTime: 1708329600000,
        time: 1708301234567,
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await fetchFundingRate('BTC');
      expect(result.rate).toBe(0.01);
    });

    test('should handle zero funding rate', async () => {
      const mockResponse = {
        symbol: 'BTCUSDT',
        markPrice: '45325.12',
        lastFundingRate: '0',
        interestRate: '0',
        nextFundingTime: 1708329600000,
        time: 1708301234567,
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await fetchFundingRate('BTC');
      expect(result.rate).toBe(0);
    });
  });
});
