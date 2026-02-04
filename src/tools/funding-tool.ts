/**
 * Funding Rates Tool
 * MCP tool for fetching perpetual futures funding rates
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addToRegistry } from './registry.js';
import { FundingRate } from '../types.js';
import { getCacheService } from '../cache/index.js';
import {
  fetchFundingRate,
  fetchMultipleFundingRates,
  fetchAllFundingRates,
  calculateFundingRateStats,
  getSupportedPerpetualSymbols,
  FundingRateStats,
} from '../services/funding.js';
import {
  FundingRateOutputSchema,
  BatchPricesOutputSchema,
  FundingRateStatsOutputSchema,
  ListSupportedPerpetualsOutputSchema
} from '../schemas/output-schemas.js';

/**
 * Input schema for funding rate tool
 */
const FundingRateInputSchema = z.object({
  symbol: z.string()
    .min(1)
    .describe('Crypto symbol (e.g., BTC, ETH, SOL)'),
});

/**
 * Input schema for batch funding rates
 */
const BatchFundingRateInputSchema = z.object({
  symbols: z.array(z.string())
    .min(1)
    .max(50)
    .describe('Array of crypto symbols (max 50)'),
});

/**
 * Input schema for funding rate statistics
 */
const FundingRateStatsInputSchema = z.object({
  symbol: z.string()
    .min(1)
    .describe('Crypto symbol (e.g., BTC, ETH, SOL)'),
  limit: z.number()
    .min(1)
    .max(1000)
    .optional()
    .describe('Number of historical rates to analyze (default: 100)'),
});

/**
 * Register the funding rate tool
 */
export function registerFundingRateTool(server: McpServer): void {
  server.registerTool(
    'get_funding_rate',
    {
      title: 'Get Perpetual Funding Rate',
      description: 'Get current funding rate for crypto perpetual futures. Funding rates indicate long/short sentiment. Positive rates mean longs pay shorts (bullish), negative means shorts pay longs (bearish). Data cached for 15 minutes.',
      inputSchema: FundingRateInputSchema as any,
      outputSchema: FundingRateOutputSchema as any,
    },
    (async (args: { symbol: string }, _extra: any) => {
      const { symbol } = args;
      const startTime = Date.now();

      try {
        const cacheService = getCacheService();
        const cacheKey = `funding:${symbol.toUpperCase()}`;

        // Try cache first
        const result = await cacheService.funding.getOrFetch(
          cacheKey,
          async () => await fetchFundingRate(symbol)
        );

        const responseTime = Date.now() - startTime;
        console.log(`[Funding Tool] Fetched ${symbol} in ${responseTime}ms (cached: ${result.cached})`);

        const ratePercent = (result.data.rate * 100).toFixed(4);
        const annualized = (result.data.rate * 3 * 365 * 100).toFixed(2);

        const structuredData = {
          symbol: result.data.symbol,
          fundingRate: result.data.rate,
          fundingRatePercent: ratePercent,
          nextFundingTime: result.data.nextFundingTime instanceof Date
            ? result.data.nextFundingTime.toISOString()
            : String(result.data.nextFundingTime || ''),
          interpretation: result.data.rate > 0 ? 'Bullish' : result.data.rate < 0 ? 'Bearish' : 'Neutral',
          annualizedRate: annualized,
          source: result.data.exchange,
          cached: result.cached,
        };

        return {
          content: [
            {
              type: 'text',
              text: formatFundingRateResponse(result.data, result.cached),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching funding rate for ${symbol}: ${error.message}`,
            },
          ],
          structuredContent: {
            symbol: symbol,
            fundingRate: 0,
            fundingRatePercent: '0',
            nextFundingTime: '',
            interpretation: 'Error',
            annualizedRate: '0',
            source: 'error',
            cached: false,
            error: error.message,
          },
          isError: true,
        };
      }
    }) as any
  );

  addToRegistry({
    name: 'get_funding_rate',
    description: 'Get current perpetual funding rate for crypto',
    category: 'prices',
    version: '0.1.0',
  });
}

/**
 * Register the batch funding rates tool
 */
export function registerBatchFundingRatesTool(server: McpServer): void {
  server.registerTool(
    'get_batch_funding_rates',
    {
      title: 'Get Multiple Funding Rates',
      description: 'Get current funding rates for multiple perpetual futures at once. Maximum 50 symbols. Data cached for 15 minutes.',
      inputSchema: BatchFundingRateInputSchema as any,
      outputSchema: BatchPricesOutputSchema as any,
    },
    (async (args: { symbols: string[] }, _extra: any) => {
      const { symbols } = args;
      const startTime = Date.now();

      try {
        const cacheService = getCacheService();
        const results = new Map<string, { data: FundingRate; cached: boolean }>();
        const uncachedSymbols: string[] = [];

        // Check cache for each symbol
        for (const symbol of symbols) {
          const cacheKey = `funding:${symbol.toUpperCase()}`;
          const cached = await cacheService.funding.get(cacheKey);

          if (cached) {
            results.set(symbol.toUpperCase(), { data: cached, cached: true });
          } else {
            uncachedSymbols.push(symbol);
          }
        }

        // Fetch uncached symbols in batch
        if (uncachedSymbols.length > 0) {
          const freshRates = await fetchMultipleFundingRates(uncachedSymbols);

          for (const [symbol, rate] of freshRates.entries()) {
            const cacheKey = `funding:${symbol.toUpperCase()}`;
            await cacheService.funding.set(cacheKey, rate);
            results.set(symbol.toUpperCase(), { data: rate, cached: false });
          }
        }

        const successCount = results.size;
        const failedCount = symbols.length - successCount;
        const cachedCount = Array.from(results.values()).filter(r => r.cached).length;
        const fundingRatesData = Array.from(results.values()).map(r => r.data);

        const responseTime = Date.now() - startTime;
        console.log(`[Batch Funding Tool] Fetched ${successCount}/${symbols.length} rates in ${responseTime}ms (cached: ${cachedCount})`);

        const structuredRates = Array.from(results.values()).map(result => ({
          symbol: result.data.symbol,
          price: result.data.rate, // Mapping funding rate to price field for reusable schema
          change: 0,
          changePercent: 0,
          volume: 0,
          marketCap: 0,
          timestamp: new Date().toISOString(),
          source: result.data.exchange,
          cached: result.cached,
        }));

        const structuredData = {
          prices: structuredRates,
          timestamp: new Date().toISOString(),
        };

        return {
          content: [
            {
              type: 'text',
              text: formatBatchFundingRatesResponse(fundingRatesData, successCount, failedCount, cachedCount),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching batch funding rates: ${error.message}`,
            },
          ],
          structuredContent: {
            prices: [],
            timestamp: new Date().toISOString(),
            error: error.message,
          },
          isError: true,
        };
      }
    }) as any
  );

  addToRegistry({
    name: 'get_batch_funding_rates',
    description: 'Get current funding rates for multiple perpetuals at once',
    category: 'prices',
    version: '0.1.0',
  });
}

/**
 * Register the all funding rates tool
 */
export function registerAllFundingRatesTool(server: McpServer): void {
  server.registerTool(
    'get_all_funding_rates',
    {
      title: 'Get All Funding Rates',
      description: 'Get current funding rates for all available perpetual futures on Binance. Returns 200+ symbols. Use for market-wide analysis. Data cached for 15 minutes.',
      inputSchema: z.object({}) as any,
      outputSchema: BatchPricesOutputSchema as any,
    },
    (async (_args: Record<string, never>, _extra: any) => {
      const startTime = Date.now();

      try {
        const cacheService = getCacheService();
        const cacheKey = 'funding:all';

        // Try cache first
        const result = await cacheService.funding.getOrFetch(
          cacheKey,
          async () => await fetchAllFundingRates()
        );

        const responseTime = Date.now() - startTime;
        console.log(`[All Funding Tool] Fetched all rates in ${responseTime}ms (cached: ${result.cached})`);

        const rates = result.data as FundingRate[];
        const structuredRates = rates.map(rate => ({
          symbol: rate.symbol,
          price: rate.rate, // Mapping funding rate to price for reusable schema
          change: 0,
          changePercent: 0,
          volume: 0,
          marketCap: 0,
          timestamp: new Date().toISOString(),
          source: rate.exchange,
          cached: result.cached,
        }));

        const structuredData = {
          prices: structuredRates,
          timestamp: new Date().toISOString(),
        };

        return {
          content: [
            {
              type: 'text',
              text: formatAllFundingRatesResponse(rates, result.cached),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching all funding rates: ${error.message}`,
            },
          ],
          structuredContent: {
            prices: [],
            timestamp: new Date().toISOString(),
            error: error.message,
          },
          isError: true,
        };
      }
    }) as any
  );

  addToRegistry({
    name: 'get_all_funding_rates',
    description: 'Get current funding rates for all available perpetuals',
    category: 'prices',
    version: '0.1.0',
  });
}

/**
 * Register the funding rate statistics tool
 */
export function registerFundingRateStatsTool(server: McpServer): void {
  server.registerTool(
    'get_funding_rate_stats',
    {
      title: 'Get Funding Rate Statistics',
      description: 'Get statistical analysis of historical funding rates including average, high, low, and trends. Useful for understanding funding rate behavior over time.',
      inputSchema: FundingRateStatsInputSchema as any,
      outputSchema: FundingRateStatsOutputSchema as any,
    },
    (async (args: { symbol: string; limit?: number }, _extra: any) => {
      const { symbol, limit } = args;
      const startTime = Date.now();

      try {
        const stats = await calculateFundingRateStats(symbol, limit || 100);

        const responseTime = Date.now() - startTime;
        console.log(`[Funding Stats Tool] Calculated stats for ${symbol} in ${responseTime}ms`);

        const structuredData = {
          symbol: symbol,
          current: stats.current,
          average: stats.average,
          high: stats.high,
          low: stats.low,
          trend: stats.current > stats.average ? 'up' : stats.current < stats.average ? 'down' : 'stable',
          dataPoints: stats.count,
        };

        return {
          content: [
            {
              type: 'text',
              text: formatFundingRateStatsResponse(stats),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching funding rate statistics for ${symbol}: ${error.message}`,
            },
          ],
          structuredContent: {
            symbol: symbol,
            current: 0,
            average: 0,
            high: 0,
            low: 0,
            trend: 'unknown',
            dataPoints: 0,
            error: error.message,
          },
          isError: true,
        };
      }
    }) as any
  );

  addToRegistry({
    name: 'get_funding_rate_stats',
    description: 'Get statistical analysis of historical funding rates',
    category: 'prices',
    version: '0.1.0',
  });
}

/**
 * Register supported symbols list tool
 */
export function registerSupportedPerpetualsTool(server: McpServer): void {
  server.registerTool(
    'list_supported_perpetuals',
    {
      title: 'List Supported Perpetuals',
      description: 'Get a list of all supported perpetual futures symbols for funding rate queries.',
      inputSchema: z.object({}) as any,
      outputSchema: ListSupportedPerpetualsOutputSchema as any,
    },
    (async (_args: Record<string, never>, _extra: any) => {
      const symbols = getSupportedPerpetualSymbols();

      const structuredData = {
        symbols: symbols,
        count: symbols.length,
        source: 'binance',
      };

      return {
        content: [
          {
            type: 'text',
            text: formatSupportedSymbolsResponse(symbols),
          },
        ],
        structuredContent: structuredData,
      };
    }) as any
  );

  addToRegistry({
    name: 'list_supported_perpetuals',
    description: 'List all supported perpetual futures symbols',
    category: 'prices',
    version: '0.1.0',
  });
}

/**
 * Format single funding rate response
 */
function formatFundingRateResponse(rate: FundingRate, cached: boolean): string {
  const ratePercent = (rate.rate * 100).toFixed(4);
  const sentiment = rate.rate > 0 ? '📈 Bullish (Longs pay shorts)' : rate.rate < 0 ? '📉 Bearish (Shorts pay longs)' : '➖ Neutral';
  const emoji = rate.rate > 0 ? '💰' : rate.rate < 0 ? '💸' : '➖';

  const lines: string[] = [
    `${emoji} ${rate.symbol} Perpetual Funding Rate`,
    `Rate: ${ratePercent}% ${sentiment}`,
    `Exchange: ${rate.exchange}`,
    `Next Funding: ${rate.nextFundingTime instanceof Date ? rate.nextFundingTime.toLocaleString() : String(rate.nextFundingTime ?? 'N/A')}`,
  ];

  if (rate.predictedRate !== undefined) {
    const predictedPercent = (rate.predictedRate * 100).toFixed(4);
    lines.push(`Predicted Next Rate: ${predictedPercent}%`);
  }

  lines.push(`Cached: ${cached ? 'Yes ⚡' : 'No (Fresh)'}`);
  lines.push(`Updated: ${rate.timestamp instanceof Date ? rate.timestamp.toLocaleString() : String(rate.timestamp)}`);

  // Add interpretation
  lines.push('');
  lines.push('📊 Interpretation:');
  if (Math.abs(rate.rate) > 0.001) {
    lines.push(`  High ${rate.rate > 0 ? 'long' : 'short'} interest - ${Math.abs(rate.rate * 100).toFixed(2)}% rate is significant`);
  } else if (Math.abs(rate.rate) > 0.0005) {
    lines.push(`  Moderate ${rate.rate > 0 ? 'long' : 'short'} bias`);
  } else {
    lines.push('  Market is balanced - minimal directional bias');
  }

  return lines.join('\n');
}

/**
 * Format batch funding rates response
 */
function formatBatchFundingRatesResponse(
  rates: FundingRate[],
  successCount: number,
  failedCount: number,
  cachedCount: number
): string {
  const lines: string[] = [
    `💹 Batch Funding Rate Results`,
    `Success: ${successCount}/${successCount + failedCount} symbols`,
    `Cached: ${cachedCount}/${successCount}`,
    '',
  ];

  // Sort by absolute rate (most extreme first)
  const sortedRates = [...rates].sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));

  // Show top 20 most extreme rates
  const displayRates = sortedRates.slice(0, 20);

  for (const rate of displayRates) {
    const ratePercent = (rate.rate * 100).toFixed(4);
    const emoji = rate.rate > 0 ? '📈' : rate.rate < 0 ? '📉' : '➖';
    const direction = rate.rate > 0 ? 'Long' : rate.rate < 0 ? 'Short' : 'Neutral';

    lines.push(
      `${emoji} ${rate.symbol}: ${ratePercent}% (${direction})`
    );
  }

  if (sortedRates.length > 20) {
    lines.push('');
    lines.push(`... and ${sortedRates.length - 20} more symbols`);
  }

  return lines.join('\n');
}

/**
 * Format all funding rates response
 */
function formatAllFundingRatesResponse(rates: FundingRate[], cached: boolean): string {
  const lines: string[] = [
    `💹 All Perpetual Funding Rates (${rates.length} symbols)`,
    `Cached: ${cached ? 'Yes ⚡' : 'No (Fresh)'}`,
    '',
  ];

  // Calculate market statistics
  const allRates = rates.map(r => r.rate);
  const avgRate = allRates.reduce((a, b) => a + b, 0) / allRates.length;
  const positiveCount = allRates.filter(r => r > 0).length;
  const negativeCount = allRates.filter(r => r < 0).length;

  lines.push('📊 Market Overview:');
  lines.push(`  Average Rate: ${(avgRate * 100).toFixed(4)}%`);
  lines.push(`  Bullish (Positive): ${positiveCount} (${(positiveCount / rates.length * 100).toFixed(1)}%)`);
  lines.push(`  Bearish (Negative): ${negativeCount} (${(negativeCount / rates.length * 100).toFixed(1)}%)`);
  lines.push('');

  // Show top 10 most extreme rates (both positive and negative)
  const sortedByRate = [...rates].sort((a, b) => b.rate - a.rate);

  lines.push('📈 Top 10 Most Bullish (Highest Rates):');
  sortedByRate.slice(0, 10).forEach(rate => {
    lines.push(`  ${rate.symbol}: ${(rate.rate * 100).toFixed(4)}%`);
  });

  lines.push('');
  lines.push('📉 Top 10 Most Bearish (Lowest Rates):');
  sortedByRate.slice(-10).reverse().forEach(rate => {
    lines.push(`  ${rate.symbol}: ${(rate.rate * 100).toFixed(4)}%`);
  });

  return lines.join('\n');
}

/**
 * Format funding rate statistics response
 */
function formatFundingRateStatsResponse(stats: FundingRateStats): string {
  const lines: string[] = [
    `📊 ${stats.symbol} Funding Rate Statistics (${stats.count} periods)`,
    `Current: ${(stats.current * 100).toFixed(4)}%`,
    `Average: ${(stats.average * 100).toFixed(4)}%`,
    `High: ${(stats.high * 100).toFixed(4)}%`,
    `Low: ${(stats.low * 100).toFixed(4)}%`,
    '',
    '💡 Analysis:',
  ];

  // Determine if current rate is extreme
  const isHigh = stats.current > stats.average + (stats.high - stats.average) * 0.5;
  const isLow = stats.current < stats.average - (stats.average - stats.low) * 0.5;

  if (isHigh) {
    lines.push('  ⚠️  Current rate is significantly above average - strong bullish sentiment');
  } else if (isLow) {
    lines.push('  ⚠️  Current rate is significantly below average - strong bearish sentiment');
  } else {
    lines.push('  ✅ Current rate is within normal range');
  }

  // Volatility analysis
  const range = stats.high - stats.low;
  const volatility = range / Math.abs(stats.average);

  if (volatility > 2) {
    lines.push('  📊 High funding rate volatility - sentiment is unstable');
  } else if (volatility < 0.5) {
    lines.push('  📊 Low funding rate volatility - stable market conditions');
  } else {
    lines.push('  📊 Moderate funding rate volatility');
  }

  return lines.join('\n');
}

/**
 * Format supported symbols list
 */
function formatSupportedSymbolsResponse(symbols: string[]): string {
  const lines: string[] = [
    `📋 Supported Perpetual Futures (${symbols.length} symbols)`,
    '',
    'Major Cryptocurrencies:',
  ];

  const major = symbols.slice(0, 10);
  major.forEach(symbol => lines.push(`  • ${symbol}`));

  lines.push('');
  lines.push(`... and ${symbols.length - 10} more altcoins`);
  lines.push('');
  lines.push('💡 Tip: Use the symbol directly (e.g., BTC, ETH) or with USDT suffix (e.g., BTCUSDT)');

  return lines.join('\n');
}
