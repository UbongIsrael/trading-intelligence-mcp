/**
 * Price Tool
 * MCP tool for fetching asset prices
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { addToRegistry } from './registry.js';
import { getPrice, getMultiplePrices, invalidatePrice } from '../services/prices.js';
import { PriceData } from '../types.js';

/**
 * Input schema for price tool
 */
const PriceInputSchema = z.object({
  symbol: z.string()
    .min(1)
    .describe('Asset symbol (e.g., AAPL, BTC, ETH)'),
  assetType: z.enum(['stock', 'crypto'])
    .optional()
    .describe('Asset type (optional, auto-detected if not provided)'),
});

/**
 * Input schema for batch price tool
 */
const BatchPriceInputSchema = z.object({
  symbols: z.array(z.string())
    .min(1)
    .max(50)
    .describe('Array of asset symbols (max 50)'),
  assetType: z.enum(['stock', 'crypto'])
    .optional()
    .describe('Asset type for all symbols (optional, auto-detected if not provided)'),
});

/**
 * Register the price tool
 */
export function registerPriceTool(server: McpServer): void {
  server.registerTool(
    'get_price',
    {
      title: 'Get Asset Price',
      description: 'Get current price data for a stock or cryptocurrency. Supports stocks (e.g., AAPL, TSLA) and crypto (e.g., BTC, ETH). Data is cached for 5 minutes.',
      inputSchema: PriceInputSchema,
    },
    async ({ symbol, assetType }) => {
      const startTime = Date.now();

      try {
        const result = await getPrice({ symbol, assetType });

        const responseTime = Date.now() - startTime;
        console.log(`[Price Tool] Fetched ${symbol} in ${responseTime}ms (cached: ${result.cached})`);

        return {
          content: [
            {
              type: 'text',
              text: formatPriceResponse(result.data, result.cached),
            },
          ],
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching price for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  addToRegistry({
    name: 'get_price',
    description: 'Get current price for stocks and cryptocurrencies',
    category: 'prices',
    version: '0.1.0',
  });
}

/**
 * Register the batch price tool
 */
export function registerBatchPriceTool(server: McpServer): void {
  server.registerTool(
    'get_batch_prices',
    {
      title: 'Get Multiple Asset Prices',
      description: 'Get current price data for multiple stocks or cryptocurrencies at once. Maximum 50 symbols. Data is cached for 5 minutes.',
      inputSchema: BatchPriceInputSchema,
    },
    async ({ symbols, assetType }) => {
      const startTime = Date.now();

      try {
        const queries = symbols.map(symbol => ({ symbol, assetType }));
        const results = await getMultiplePrices(queries);

        const successCount = results.size;
        const failedCount = symbols.length - successCount;
        const pricesData: PriceData[] = [];
        const cachedCount = Array.from(results.values()).filter(r => r.cached).length;

        for (const result of results.values()) {
          pricesData.push(result.data);
        }

        const responseTime = Date.now() - startTime;
        console.log(`[Batch Price Tool] Fetched ${successCount}/${symbols.length} prices in ${responseTime}ms (cached: ${cachedCount})`);

        return {
          content: [
            {
              type: 'text',
              text: formatBatchPriceResponse(pricesData, successCount, failedCount, cachedCount),
            },
          ],
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching batch prices: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  addToRegistry({
    name: 'get_batch_prices',
    description: 'Get current prices for multiple assets at once',
    category: 'prices',
    version: '0.1.0',
  });
}

/**
 * Register the cache invalidation tool
 */
export function registerInvalidatePriceTool(server: McpServer): void {
  server.registerTool(
    'invalidate_price_cache',
    {
      title: 'Invalidate Price Cache',
      description: 'Clear cached price data for a specific symbol to force a fresh fetch',
      inputSchema: z.object({
        symbol: z.string().min(1).describe('Asset symbol to invalidate'),
      }),
    },
    async ({ symbol }) => {
      try {
        const invalidated = await invalidatePrice(symbol);

        return {
          content: [
            {
              type: 'text',
              text: invalidated
                ? `Cache invalidated for ${symbol}`
                : `No cache found for ${symbol}`,
            },
          ],
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error invalidating cache for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  addToRegistry({
    name: 'invalidate_price_cache',
    description: 'Clear cached price data for a symbol',
    category: 'prices',
    version: '0.1.0',
  });
}

/**
 * Format price response for display
 */
function formatPriceResponse(price: PriceData, cached: boolean): string {
  const lines: string[] = [
    `💰 ${price.symbol} Price`,
    `Price: $${price.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${price.currency}`,
  ];

  if (price.changePercent24h !== undefined) {
    const sign = price.changePercent24h >= 0 ? '+' : '';
    const emoji = price.changePercent24h >= 0 ? '📈' : '📉';
    lines.push(`24h Change: ${emoji} ${sign}${price.changePercent24h.toFixed(2)}%`);
  }

  if (price.high24h !== undefined && price.low24h !== undefined) {
    lines.push(`24h Range: $${price.low24h.toFixed(2)} - $${price.high24h.toFixed(2)}`);
  }

  if (price.volume24h !== undefined) {
    lines.push(`24h Volume: $${(price.volume24h / 1_000_000).toFixed(2)}M`);
  }

  if (price.marketCap !== undefined) {
    const marketCapB = price.marketCap / 1_000_000_000;
    lines.push(`Market Cap: $${marketCapB.toFixed(2)}B`);
  }

  lines.push(`Source: ${price.source}`);
  lines.push(`Cached: ${cached ? 'Yes ⚡' : 'No (Fresh)'}`);
  lines.push(`Updated: ${price.timestamp.toLocaleString()}`);

  return lines.join('\n');
}

/**
 * Format batch price response for display
 */
function formatBatchPriceResponse(
  prices: PriceData[],
  successCount: number,
  failedCount: number,
  cachedCount: number
): string {
  const lines: string[] = [
    `📊 Batch Price Results`,
    `Success: ${successCount}/${successCount + failedCount} symbols`,
    `Cached: ${cachedCount}/${successCount}`,
    '',
  ];

  // Sort by market cap descending
  const sortedPrices = [...prices].sort((a, b) => {
    return (b.marketCap || 0) - (a.marketCap || 0);
  });

  for (const price of sortedPrices) {
    const change = price.changePercent24h !== undefined
      ? `${price.changePercent24h >= 0 ? '+' : ''}${price.changePercent24h.toFixed(2)}%`
      : 'N/A';

    lines.push(
      `${price.symbol}: $${price.price.toFixed(2)} (${change})`
    );
  }

  return lines.join('\n');
}
