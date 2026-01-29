/**
 * Fundamentals Service Tests
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import {
  fetchCompanyOverview,
  fetchEarnings,
  fetchFinancialStatements,
  fetchFullFundamentals,
  isSupportedStock,
  SUPPORTED_STOCKS,
} from '../src/services/fundamentals';
import { APIError } from '../src/types';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

// Mock config to provide API key
jest.mock('../src/config.js', () => ({
  config: {
    cache: {
      fundamentals: {
        ttl: 3600,
        prefix: 'fundamentals:',
      },
    },
  },
  apiConfig: {
    finnhub: {
      apiKey: 'test-api-key',
      baseUrl: 'https://finnhub.io/api/v1',
    },
  },
}));

describe('Fundamentals Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchCompanyOverview', () => {
    test('should fetch company overview for AAPL', async () => {
      const mockProfile = {
        country: 'US',
        currency: 'USD',
        exchange: 'NASDAQ',
        ipo: '1980-12-12',
        marketCapitalization: 2500000, // In millions
        name: 'Apple Inc',
        phone: '14089961010',
        shareOutstanding: 15500000000,
        ticker: 'AAPL',
        weburl: 'https://www.apple.com/',
        logo: 'https://finnhub.io/api/logo?symbol=AAPL',
        finnhubIndustry: 'Technology',
      };

      const mockMetrics = {
        metric: {
          '52WeekHigh': 199.62,
          '52WeekLow': 124.17,
          'peBasicExclExtraTTM': 28.5,
          'epsAnnual': 6.43,
          'dividendYieldIndicatedAnnual': 0.55,
          'beta': 1.29,
          '10DayAverageTradingVolume': 65.5, // In millions
        },
      };

      // First call for profile, second for metrics
      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockProfile,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockMetrics,
        } as Response);

      const result = await fetchCompanyOverview('AAPL');

      expect(result).toBeDefined();
      expect(result.symbol).toBe('AAPL');
      expect(result.name).toBe('Apple Inc');
      expect(result.sector).toBe('Technology');
      expect(result.marketCap).toBe(2500000000000); // Converted from millions
      expect(result.peRatio).toBe(28.5);
      expect(result.eps).toBe(6.43);
      expect(result.week52High).toBe(199.62);
      expect(result.week52Low).toBe(124.17);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    test('should handle company not found', async () => {
      // Set up mocks for BOTH calls - each call needs 2 mocks (profile + metrics)
      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}), // Empty response for first call
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ metric: {} }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}), // Empty response for second call
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ metric: {} }),
        } as Response);

      // Use 'FAKE' (4 chars) instead of 'INVALID' (7 chars) to pass symbol format validation
      await expect(fetchCompanyOverview('FAKE')).rejects.toThrow(APIError);
      await expect(fetchCompanyOverview('FAKE')).rejects.toThrow('Company not found');
    });

    test('should throw error for invalid symbol format', async () => {
      await expect(fetchCompanyOverview('')).rejects.toThrow(APIError);
      await expect(fetchCompanyOverview('TOOLONG')).rejects.toThrow(APIError);
      await expect(fetchCompanyOverview('123')).rejects.toThrow(APIError);
    });

    test('should handle API rate limit error', async () => {
      // fetchCompanyOverview makes 2 parallel API calls, so we need 2 mock responses
      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers({ 'Retry-After': '60' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers({ 'Retry-After': '60' }),
        } as Response);

      await expect(fetchCompanyOverview('AAPL')).rejects.toThrow('rate limit');
    });

    test('should handle API authentication error', async () => {
      // fetchCompanyOverview makes 2 parallel API calls, so we need 2 mock responses
      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        } as Response);

      // The actual error message is 'Finnhub API key is invalid or expired'
      await expect(fetchCompanyOverview('AAPL')).rejects.toThrow(/invalid|expired|API key/i);
    });

    test('should handle network timeout', async () => {
      // fetchCompanyOverview makes 2 parallel API calls, so we need 2 mock responses
      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockRejectedValueOnce(
          Object.assign(new Error('timeout'), { name: 'AbortError' })
        )
        .mockRejectedValueOnce(
          Object.assign(new Error('timeout'), { name: 'AbortError' })
        );

      await expect(fetchCompanyOverview('AAPL')).rejects.toThrow('timeout');
    });

    test('should normalize symbol to uppercase', async () => {
      const mockProfile = {
        country: 'US',
        currency: 'USD',
        exchange: 'NASDAQ',
        marketCapitalization: 2500000,
        name: 'Apple Inc',
        ticker: 'AAPL',
        finnhubIndustry: 'Technology',
      };

      const mockMetrics = {
        metric: {},
      };

      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockProfile,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockMetrics,
        } as Response);

      const result = await fetchCompanyOverview('aapl');
      expect(result.symbol).toBe('AAPL');
    });
  });

  describe('fetchEarnings', () => {
    test('should fetch earnings data for AAPL', async () => {
      const mockEarnings = [
        {
          actual: 1.52,
          estimate: 1.43,
          period: '2024-03-31',
          quarter: 1,
          surprise: 0.09,
          surprisePercent: 6.29,
          symbol: 'AAPL',
          year: 2024,
        },
        {
          actual: 2.18,
          estimate: 2.10,
          period: '2023-12-31',
          quarter: 4,
          surprise: 0.08,
          surprisePercent: 3.81,
          symbol: 'AAPL',
          year: 2023,
        },
      ];

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEarnings,
      } as Response);

      const result = await fetchEarnings('AAPL', 2);

      expect(result).toBeDefined();
      expect(result.length).toBe(2);
      expect(result[0].symbol).toBe('AAPL');
      expect(result[0].epsActual).toBe(1.52);
      expect(result[0].epsEstimate).toBe(1.43);
      expect(result[0].surprisePercent).toBe(6.29);
      expect(result[0].year).toBe(2024);
      expect(result[0].quarter).toBe('Q1');
    });

    test('should return empty array when no earnings data', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

      const result = await fetchEarnings('AAPL');
      expect(result).toEqual([]);
    });

    test('should sort earnings by date descending', async () => {
      const mockEarnings = [
        { actual: 1.0, estimate: 1.0, period: '2023-03-31', quarter: 1, year: 2023, surprise: 0, surprisePercent: 0, symbol: 'AAPL' },
        { actual: 1.5, estimate: 1.4, period: '2024-03-31', quarter: 1, year: 2024, surprise: 0.1, surprisePercent: 7.14, symbol: 'AAPL' },
        { actual: 1.2, estimate: 1.1, period: '2023-06-30', quarter: 2, year: 2023, surprise: 0.1, surprisePercent: 9.09, symbol: 'AAPL' },
      ];

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEarnings,
      } as Response);

      const result = await fetchEarnings('AAPL', 3);

      expect(result[0].year).toBe(2024);
      expect(result[1].year).toBe(2023);
      expect(result[1].quarter).toBe('Q2');
      expect(result[2].year).toBe(2023);
      expect(result[2].quarter).toBe('Q1');
    });

    test('should respect limit parameter', async () => {
      const mockEarnings = Array.from({ length: 10 }, (_, i) => ({
        actual: 1.0 + i * 0.1,
        estimate: 1.0,
        period: `2024-0${(i % 4) + 1}-30`,
        quarter: (i % 4) + 1,
        year: 2024 - Math.floor(i / 4),
        surprise: i * 0.1,
        surprisePercent: i * 10,
        symbol: 'AAPL',
      }));

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEarnings,
      } as Response);

      const result = await fetchEarnings('AAPL', 4);
      expect(result.length).toBe(4);
    });
  });

  describe('fetchFinancialStatements', () => {
    test('should fetch annual financial statements', async () => {
      const mockReports = {
        data: [
          {
            accessNumber: '0000320193-23-000077',
            symbol: 'AAPL',
            year: 2023,
            quarter: 0,
            form: '10-K',
            endDate: '2023-09-30',
            filedDate: '2023-11-03',
            report: {
              bs: {
                totalAssets: 352583000000,
                totalLiabilities: 290437000000,
                totalEquity: 62146000000,
              },
              ic: {
                revenue: 383285000000,
                netIncome: 96995000000,
                grossProfit: 169148000000,
              },
              cf: {
                operatingCashFlow: 110543000000,
                freeCashFlow: 99584000000,
              },
            },
          },
        ],
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockReports,
      } as Response);

      const result = await fetchFinancialStatements('AAPL', 'annual', 1);

      expect(result).toBeDefined();
      expect(result.length).toBe(1);
      expect(result[0].symbol).toBe('AAPL');
      expect(result[0].fiscalYear).toBe(2023);
      expect(result[0].period).toBe('annual');
    });

    test('should fetch quarterly financial statements', async () => {
      const mockReports = {
        data: [
          {
            accessNumber: '0000320193-24-000001',
            symbol: 'AAPL',
            year: 2024,
            quarter: 1,
            form: '10-Q',
            endDate: '2024-03-31',
            filedDate: '2024-05-03',
            report: {
              bs: {},
              ic: {},
              cf: {},
            },
          },
        ],
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockReports,
      } as Response);

      const result = await fetchFinancialStatements('AAPL', 'quarterly', 1);

      expect(result.length).toBe(1);
      expect(result[0].fiscalQuarter).toBe(1);
      expect(result[0].period).toBe('quarterly');
    });

    test('should return empty array when no statements available', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);

      const result = await fetchFinancialStatements('AAPL');
      expect(result).toEqual([]);
    });
  });

  describe('fetchFullFundamentals', () => {
    test('should fetch full fundamentals data', async () => {
      const mockProfile = {
        country: 'US',
        currency: 'USD',
        exchange: 'NASDAQ',
        marketCapitalization: 2500000,
        name: 'Apple Inc',
        ticker: 'AAPL',
        finnhubIndustry: 'Technology',
      };

      const mockMetrics = {
        metric: {
          peBasicExclExtraTTM: 28.5,
          epsAnnual: 6.43,
          grossMarginTTM: 44.1,
          netProfitMarginTTM: 25.3,
          roeTTM: 147.2,
          currentRatioQuarterly: 0.99,
          epsGrowth3Y: 15.2,
        },
      };

      const mockEarnings = [
        {
          actual: 1.52,
          estimate: 1.43,
          period: '2024-03-31',
          quarter: 1,
          year: 2024,
          surprise: 0.09,
          surprisePercent: 6.29,
          symbol: 'AAPL',
        },
      ];

      // Profile call (twice due to both overview and metrics)
      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockProfile,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockMetrics,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEarnings,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockMetrics,
        } as Response);

      const result = await fetchFullFundamentals('AAPL');

      expect(result).toBeDefined();
      expect(result.overview).toBeDefined();
      expect(result.overview.name).toBe('Apple Inc');
      expect(result.earnings).toBeDefined();
      expect(result.earnings.length).toBeGreaterThan(0);
      expect(result.metrics).toBeDefined();
      expect(result.metrics.valuation.peRatio).toBe(28.5);
      expect(result.metrics.profitability.grossMargin).toBe(44.1);
      expect(result.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('isSupportedStock', () => {
    test('should return true for supported stocks', () => {
      expect(isSupportedStock('AAPL')).toBe(true);
      expect(isSupportedStock('MSFT')).toBe(true);
      expect(isSupportedStock('GOOGL')).toBe(true);
      expect(isSupportedStock('JPM')).toBe(true);
    });

    test('should return false for unsupported stocks', () => {
      expect(isSupportedStock('UNKNOWN')).toBe(false);
      expect(isSupportedStock('FAKE')).toBe(false);
    });

    test('should be case-insensitive', () => {
      expect(isSupportedStock('aapl')).toBe(true);
      expect(isSupportedStock('Msft')).toBe(true);
    });
  });

  describe('SUPPORTED_STOCKS', () => {
    test('should contain major tech stocks', () => {
      expect(SUPPORTED_STOCKS).toContain('AAPL');
      expect(SUPPORTED_STOCKS).toContain('MSFT');
      expect(SUPPORTED_STOCKS).toContain('GOOGL');
      expect(SUPPORTED_STOCKS).toContain('AMZN');
      expect(SUPPORTED_STOCKS).toContain('META');
      expect(SUPPORTED_STOCKS).toContain('NVDA');
      expect(SUPPORTED_STOCKS).toContain('TSLA');
    });

    test('should contain major finance stocks', () => {
      expect(SUPPORTED_STOCKS).toContain('JPM');
      expect(SUPPORTED_STOCKS).toContain('BAC');
      expect(SUPPORTED_STOCKS).toContain('GS');
      expect(SUPPORTED_STOCKS).toContain('V');
      expect(SUPPORTED_STOCKS).toContain('MA');
    });

    test('should have at least 40 stocks', () => {
      expect(SUPPORTED_STOCKS.length).toBeGreaterThanOrEqual(40);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty string symbol', async () => {
      await expect(fetchCompanyOverview('')).rejects.toThrow(APIError);
    });

    test('should handle symbol with whitespace', async () => {
      const mockProfile = {
        country: 'US',
        currency: 'USD',
        exchange: 'NASDAQ',
        marketCapitalization: 2500000,
        name: 'Apple Inc',
        ticker: 'AAPL',
        finnhubIndustry: 'Technology',
      };

      const mockMetrics = {
        metric: {},
      };

      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockProfile,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockMetrics,
        } as Response);

      const result = await fetchCompanyOverview('  AAPL  ');
      expect(result.symbol).toBe('AAPL');
    });

    test('should handle missing optional fields in API response', async () => {
      const mockProfile = {
        ticker: 'TEST',
        name: 'Test Company',
        // Missing many optional fields
      };

      const mockMetrics = {
        metric: {
          // Empty metrics
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockProfile,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockMetrics,
        } as Response);

      const result = await fetchCompanyOverview('TEST');
      expect(result.symbol).toBe('TEST');
      expect(result.name).toBe('Test Company');
      expect(result.peRatio).toBeUndefined();
      expect(result.eps).toBeUndefined();
    });
  });
});
