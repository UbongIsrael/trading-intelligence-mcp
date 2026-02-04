/**
 * Price Tool
 * MCP tool for fetching asset prices with Data Broker Standard compliance
 */

import { registerTool } from './registry.js';
import { getPrice, getMultiplePrices, invalidatePrice } from '../services/prices.js';
import { PriceData } from '../types.js';
import { PriceOutputSchema, BatchPricesOutputSchema, CacheInvalidationOutputSchema } from '../schemas/output-schemas.js';

/**
 * Input schema for price tool (JSON Schema format)
 */
const PriceInputSchema = {
  type: "object" as const,
  properties: {
    symbol: {
      type: "string" as const,
      description: "Asset symbol (e.g., AAPL, BTC, ETH)",
    },
    assetType: {
      type: "string" as const,
      enum: ["stock", "crypto"],
      description: "Asset type (optional, auto-detected if not provided)",
    },
  },
  required: ["symbol"],
};

/**
 * Input schema for batch price tool (JSON Schema format)
 */
const BatchPriceInputSchema = {
  type: "object" as const,
  properties: {
    symbols: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Array of asset symbols (max 50)",
    },
    assetType: {
      type: "string" as const,
      enum: ["stock", "crypto"],
      description: "Asset type for all symbols (optional, auto-detected if not provided)",
    },
  },
  required: ["symbols"],
};

/**
 * Register the price tool
 */
/**
 * Register the price tool
 */
export function registerPriceTool(): void {
  registerTool({
    name: 'get_price',
    description: 'Get current price data for a stock or cryptocurrency. Supports stocks (e.g., AAPL, TSLA) and crypto (e.g., BTC, ETH). Data is cached for 5 minutes.',
    category: 'prices',
    version: '0.1.0',
    inputSchema: PriceInputSchema,
    outputSchema: PriceOutputSchema,
    handler: async (args: any) => {
      const { symbol, assetType } = args as { symbol: string; assetType?: 'stock' | 'crypto' };
      const startTime = Date.now();

      try {
        const result = await getPrice({ symbol, assetType });

        const responseTime = Date.now() - startTime;
        console.log(`[Price Tool] Fetched ${symbol} in ${responseTime}ms (cached: ${result.cached})`);

        // Create structured response
        const structuredData = {
          symbol: result.data.symbol,
          price: result.data.price,
          change: result.data.change24h || 0,
          changePercent: result.data.changePercent24h || 0,
          volume: result.data.volume24h || 0,
          marketCap: result.data.marketCap || 0,
          timestamp: result.data.timestamp instanceof Date
            ? result.data.timestamp.toISOString()
            : String(result.data.timestamp),
          source: result.data.source,
          cached: result.cached,
        };

        return {
          content: [
            {
              type: 'text',
              text: formatPriceResponse(result.data, result.cached),
            },
          ],
          structuredContent: structuredData, // REQUIRED by Context Protocol
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching price for ${symbol}: ${error.message}`,
            },
          ],
          structuredContent: {
            symbol: symbol,
            price: 0,
            change: 0,
            changePercent: 0,
            volume: 0,
            marketCap: 0,
            timestamp: new Date().toISOString(),
            source: 'error',
            cached: false,
            error: error.message,
          },
          isError: true,
        };
      }
    }
  });
}

/**
 * Register the batch price tool
 */
/**
 * Register the batch price tool
 */
export function registerBatchPriceTool(): void {
  registerTool({
    name: 'get_batch_prices',
    description: 'Get current price data for multiple stocks or cryptocurrencies at once. Maximum 50 symbols. Data is cached for 5 minutes.',
    category: 'prices',
    version: '0.1.0',
    inputSchema: BatchPriceInputSchema,
    outputSchema: BatchPricesOutputSchema,
    handler: async (args: any) => {
      const { symbols, assetType } = args as { symbols: string[]; assetType?: 'stock' | 'crypto' };
      const startTime = Date.now();

      try {
        const queries = symbols.map(symbol => ({ symbol, assetType }));
        const results = await getMultiplePrices(queries);

        const successCount = results.size;
        const failedCount = symbols.length - successCount;
        const cachedCount = Array.from(results.values()).filter(r => r.cached).length;

        // Build structured data array
        const pricesArray = Array.from(results.values()).map(result => ({
          symbol: result.data.symbol,
          price: result.data.price,
          change: result.data.change24h || 0,
          changePercent: result.data.changePercent24h || 0,
          volume: result.data.volume24h || 0,
          marketCap: result.data.marketCap || 0,
          timestamp: result.data.timestamp instanceof Date
            ? result.data.timestamp.toISOString()
            : String(result.data.timestamp),
          source: result.data.source,
          cached: result.cached,
        }));

        const responseTime = Date.now() - startTime;
        console.log(`[Batch Price Tool] Fetched ${successCount}/${symbols.length} prices in ${responseTime}ms (cached: ${cachedCount})`);

        const structuredData = {
          prices: pricesArray,
          timestamp: new Date().toISOString(),
        };

        return {
          content: [
            {
              type: 'text',
              text: formatBatchPriceResponse(pricesArray.map(p => ({
                symbol: p.symbol,
                price: p.price,
                changePercent24h: p.changePercent,
                marketCap: p.marketCap,
                source: p.source,
                timestamp: new Date(p.timestamp),
                currency: 'USD',
              }) as PriceData), successCount, failedCount, cachedCount),
            },
          ],
          structuredContent: structuredData, // REQUIRED by Context Protocol
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching batch prices: ${error.message}`,
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
    }
  });
}

/**
 * Register the cache invalidation tool
 */
/**
 * Register the cache invalidation tool
 */
export function registerInvalidatePriceTool(): void {
  registerTool({
    name: 'invalidate_price_cache',
    description: 'Clear cached price data for a specific symbol to force a fresh fetch',
    category: 'prices',
    version: '0.1.0',
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string" as const,
          description: "Asset symbol to invalidate",
        },
      },
      required: ["symbol"],
    },
    outputSchema: CacheInvalidationOutputSchema,
    handler: async (args: any) => {
      const { symbol } = args as { symbol: string };
      try {
        const invalidated = await invalidatePrice(symbol);

        const structuredData = {
          symbol,
          invalidated,
          message: invalidated
            ? `Cache invalidated for ${symbol}`
            : `No cache found for ${symbol}`,
        };

        return {
          content: [
            {
              type: 'text',
              text: structuredData.message,
            },
          ],
          structuredContent: structuredData, // REQUIRED by Context Protocol
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error invalidating cache for ${symbol}: ${error.message}`,
            },
          ],
          structuredContent: {
            success: false,
            symbol: symbol,
            message: `Error: ${error.message}`,
          },
          isError: true,
        };
      }
    }
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
