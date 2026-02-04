/**
 * Liquidity Zones Tool
 * MCP tools for identifying support and resistance levels
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addToRegistry } from './registry.js';
import { TechnicalAnalysis } from '../types.js';
import { getCacheService } from '../cache/index.js';
import {
  calculateLiquidityZones,
  getAvailableTimeframes,
  isValidSymbol,
  LiquidityZonesAnalysis,
} from '../services/liquidity.js';
import {
  LiquidityZoneOutputSchema,
  SupportResistanceOutputSchema,
  PriceLevelAnalysisOutputSchema,
  AvailableTimeframesOutputSchema
} from '../schemas/output-schemas.js';

/**
 * Input schema for liquidity zones tool
 */
const LiquidityZonesInputSchema = z.object({
  symbol: z.string()
    .min(1)
    .max(10)
    .describe('Trading symbol (e.g., AAPL, TSLA, BTC, ETH)'),
  timeframe: z.enum(['1h', '4h', '1d', '1w'])
    .optional()
    .describe('Analysis timeframe (default: 1d). Options: 1h, 4h, 1d, 1w'),
  lookbackDays: z.number()
    .min(7)
    .max(365)
    .optional()
    .describe('Number of days to analyze (default: based on timeframe, max: 365)'),
});

/**
 * Input schema for support/resistance tool
 */
const SupportResistanceInputSchema = z.object({
  symbol: z.string()
    .min(1)
    .max(10)
    .describe('Trading symbol (e.g., AAPL, TSLA, BTC, ETH)'),
  timeframe: z.enum(['1h', '4h', '1d', '1w'])
    .optional()
    .describe('Analysis timeframe (default: 1d)'),
});

/**
 * Input schema for price level analysis
 */
const PriceLevelAnalysisInputSchema = z.object({
  symbol: z.string()
    .min(1)
    .max(10)
    .describe('Trading symbol (e.g., AAPL, TSLA, BTC, ETH)'),
  currentPrice: z.number()
    .positive()
    .optional()
    .describe('Current price for distance calculations (fetched if not provided)'),
  timeframe: z.enum(['1h', '4h', '1d', '1w'])
    .optional()
    .describe('Analysis timeframe (default: 1d)'),
});

/**
 * Register the liquidity zones tool
 */
export function registerLiquidityZonesTool(server: McpServer): void {
  server.registerTool(
    'get_liquidity_zones',
    {
      title: 'Get Liquidity Zones',
      description: 'Identify key support and resistance levels (liquidity zones) for any trading symbol. Returns the top 5 most significant price levels based on historical pivot points, with strength ratings and touch counts. Data cached for 30 minutes.',
      inputSchema: LiquidityZonesInputSchema as any,
      outputSchema: LiquidityZoneOutputSchema as any,
    },
    (async (args: { symbol: string; timeframe?: string; lookbackDays?: number }, _extra: any) => {
      const { symbol, timeframe, lookbackDays } = args;
      const startTime = Date.now();
      const effectiveTimeframe = timeframe || '1d';

      try {
        // Validate symbol
        if (!isValidSymbol(symbol)) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid symbol format: ${symbol}. Please use standard ticker symbols (e.g., AAPL, TSLA, BTC).`,
              },
            ],
          };
        }

        const cacheService = getCacheService();
        const normalizedSymbol = symbol.toUpperCase().trim();

        // Try cache first using the existing LiquidityCacheService
        const result = await cacheService.liquidity.getOrFetch(
          normalizedSymbol,
          effectiveTimeframe,
          async () => {
            const analysis = await calculateLiquidityZones(
              normalizedSymbol,
              effectiveTimeframe,
              lookbackDays
            );
            // Return TechnicalAnalysis for cache compatibility
            return analysis as TechnicalAnalysis;
          }
        );

        const responseTime = Date.now() - startTime;
        console.log(`[Liquidity Tool] Fetched ${normalizedSymbol} in ${responseTime}ms (cached: ${result.cached})`);

        const analysis = result.data as LiquidityZonesAnalysis;

        const structuredData = {
          symbol: analysis.symbol,
          currentPrice: analysis.currentPrice,
          timeframe: analysis.timeframe,
          zones: analysis.liquidityZones.map(zone => ({
            type: zone.type,
            price: zone.price,
            strength: zone.strength === 'strong' ? 0.9 : zone.strength === 'medium' ? 0.6 : 0.3,
            touches: zone.touchCount,
            distance: formatDistancePercent(zone.price, analysis.currentPrice),
          })),
          trend: analysis.trend || 'neutral',
          recommendation: analysis.trend === 'bullish' ? 'Look for support bounces' : analysis.trend === 'bearish' ? 'Look for resistance rejections' : 'Range trade',
          cached: result.cached,
        };

        return {
          content: [
            {
              type: 'text',
              text: formatLiquidityZonesResponse(analysis, result.cached),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error analyzing liquidity zones for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }) as any
  );

  addToRegistry({
    name: 'get_liquidity_zones',
    description: 'Get support/resistance liquidity zones for any trading symbol',
    category: 'technical',
    version: '0.1.0',
  });
}

/**
 * Register the support/resistance tool
 */
export function registerSupportResistanceTool(server: McpServer): void {
  server.registerTool(
    'get_support_resistance',
    {
      title: 'Get Support & Resistance',
      description: 'Get the nearest support and resistance levels for a trading symbol. Returns just the key levels closest to current price - perfect for quick trading decisions. Data cached for 30 minutes.',
      inputSchema: SupportResistanceInputSchema as any,
      outputSchema: SupportResistanceOutputSchema as any,
    },
    (async (args: { symbol: string; timeframe?: string }, _extra: any) => {
      const { symbol, timeframe } = args;
      const startTime = Date.now();
      const effectiveTimeframe = timeframe || '1d';

      try {
        // Validate symbol
        if (!isValidSymbol(symbol)) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid symbol format: ${symbol}. Please use standard ticker symbols (e.g., AAPL, TSLA, BTC).`,
              },
            ],
          };
        }

        const cacheService = getCacheService();
        const normalizedSymbol = symbol.toUpperCase().trim();

        // Try cache first
        const result = await cacheService.liquidity.getOrFetch(
          normalizedSymbol,
          effectiveTimeframe,
          async () => {
            const analysis = await calculateLiquidityZones(
              normalizedSymbol,
              effectiveTimeframe
            );
            return analysis as TechnicalAnalysis;
          }
        );

        const analysis = result.data as LiquidityZonesAnalysis;
        const responseTime = Date.now() - startTime;
        console.log(`[S/R Tool] Fetched ${normalizedSymbol} in ${responseTime}ms (cached: ${result.cached})`);

        // Find strength for nearest levels
        const supportZone = analysis.liquidityZones.find(z => z.type === 'support' && Math.abs(z.price - (analysis.nextSupport || 0)) < 0.001);
        const resistanceZone = analysis.liquidityZones.find(z => z.type === 'resistance' && Math.abs(z.price - (analysis.nextResistance || 0)) < 0.001);

        const supportStrengthVal = supportZone ? (supportZone.strength === 'strong' ? 0.9 : supportZone.strength === 'medium' ? 0.6 : 0.3) : 0.5;
        const resistanceStrengthVal = resistanceZone ? (resistanceZone.strength === 'strong' ? 0.9 : resistanceZone.strength === 'medium' ? 0.6 : 0.3) : 0.5;

        const structuredData = {
          symbol: analysis.symbol,
          currentPrice: analysis.currentPrice,
          nearestSupport: analysis.nextSupport || 0,
          nearestResistance: analysis.nextResistance || 0,
          supportStrength: supportStrengthVal,
          resistanceStrength: resistanceStrengthVal,
        };

        return {
          content: [
            {
              type: 'text',
              text: formatSupportResistanceResponse(analysis, result.cached),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching support/resistance for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }) as any
  );

  addToRegistry({
    name: 'get_support_resistance',
    description: 'Get nearest support and resistance levels',
    category: 'technical',
    version: '0.1.0',
  });
}

/**
 * Register the price level analysis tool
 */
export function registerPriceLevelAnalysisTool(server: McpServer): void {
  server.registerTool(
    'analyze_price_levels',
    {
      title: 'Analyze Price Levels',
      description: 'Get comprehensive price level analysis including all support/resistance zones, distances from current price, trend direction, and trading recommendations. Ideal for detailed technical analysis. Data cached for 30 minutes.',
      inputSchema: PriceLevelAnalysisInputSchema as any,
      outputSchema: PriceLevelAnalysisOutputSchema as any,
    },
    (async (args: { symbol: string; currentPrice?: number; timeframe?: string }, _extra: any) => {
      const { symbol, currentPrice, timeframe } = args;
      const startTime = Date.now();
      const effectiveTimeframe = timeframe || '1d';

      try {
        // Validate symbol
        if (!isValidSymbol(symbol)) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid symbol format: ${symbol}. Please use standard ticker symbols (e.g., AAPL, TSLA, BTC).`,
              },
            ],
          };
        }

        const cacheService = getCacheService();
        const normalizedSymbol = symbol.toUpperCase().trim();

        // Try cache first
        const result = await cacheService.liquidity.getOrFetch(
          normalizedSymbol,
          effectiveTimeframe,
          async () => {
            const analysis = await calculateLiquidityZones(
              normalizedSymbol,
              effectiveTimeframe
            );
            return analysis as TechnicalAnalysis;
          }
        );

        const analysis = result.data as LiquidityZonesAnalysis;

        // Use provided current price or the one from analysis
        const effectiveCurrentPrice = currentPrice || analysis.currentPrice;

        const responseTime = Date.now() - startTime;
        console.log(`[Price Level Tool] Analyzed ${normalizedSymbol} in ${responseTime}ms (cached: ${result.cached})`);

        const structuredData = {
          symbol: analysis.symbol,
          currentPrice: effectiveCurrentPrice,
          allZones: analysis.liquidityZones.map(zone => ({
            type: zone.type,
            price: zone.price,
            strength: zone.strength === 'strong' ? 0.9 : zone.strength === 'medium' ? 0.6 : 0.3,
            touches: zone.touchCount,
            distance: formatDistancePercent(zone.price, effectiveCurrentPrice),
          })),
          distances: {
            nearestSupport: analysis.nextSupport ? formatDistancePercent(analysis.nextSupport, effectiveCurrentPrice) : 'N/A',
            nearestResistance: analysis.nextResistance ? formatDistancePercent(analysis.nextResistance, effectiveCurrentPrice) : 'N/A',
          },
          trend: analysis.trend || 'neutral',
          recommendation: analysis.trend === 'bullish' ? 'Buy on support' : analysis.trend === 'bearish' ? 'Sell on resistance' : 'Trade range',
        };

        return {
          content: [
            {
              type: 'text',
              text: formatPriceLevelAnalysisResponse(analysis, effectiveCurrentPrice, result.cached),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error analyzing price levels for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }) as any
  );

  addToRegistry({
    name: 'analyze_price_levels',
    description: 'Comprehensive price level analysis with recommendations',
    category: 'technical',
    version: '0.1.0',
  });
}

/**
 * Format liquidity zones response
 */
function formatLiquidityZonesResponse(analysis: LiquidityZonesAnalysis, cached: boolean): string {
  const lines: string[] = [
    `📊 ${analysis.symbol} Liquidity Zones Analysis`,
    `Timeframe: ${analysis.timeframe}`,
    `Current Price: $${formatPrice(analysis.currentPrice)}`,
    `Trend: ${getTrendEmoji(analysis.trend)} ${analysis.trend || 'neutral'}`,
    `Cached: ${cached ? 'Yes ⚡' : 'No (Fresh)'}`,
    '',
  ];

  // Show liquidity zones
  if (analysis.liquidityZones.length === 0) {
    lines.push('⚠️ No significant liquidity zones identified');
  } else {
    lines.push(`Found ${analysis.liquidityZones.length} key levels:`);
    lines.push('');

    // Group by type
    const resistanceZones = analysis.liquidityZones.filter(z => z.type === 'resistance');
    const supportZones = analysis.liquidityZones.filter(z => z.type === 'support');

    // Show resistance levels (sorted high to low)
    if (resistanceZones.length > 0) {
      lines.push('🔴 Resistance Levels:');
      resistanceZones
        .sort((a, b) => b.price - a.price)
        .forEach(zone => {
          const distance = ((zone.price - analysis.currentPrice) / analysis.currentPrice * 100).toFixed(2);
          const strengthIcon = getStrengthIcon(zone.strength);
          lines.push(`  ${strengthIcon} $${formatPrice(zone.price)} (+${distance}%) - ${zone.touchCount} touches, ${zone.strength}`);
        });
      lines.push('');
    }

    // Show support levels (sorted high to low)
    if (supportZones.length > 0) {
      lines.push('🟢 Support Levels:');
      supportZones
        .sort((a, b) => b.price - a.price)
        .forEach(zone => {
          const distance = ((analysis.currentPrice - zone.price) / analysis.currentPrice * 100).toFixed(2);
          const strengthIcon = getStrengthIcon(zone.strength);
          lines.push(`  ${strengthIcon} $${formatPrice(zone.price)} (-${distance}%) - ${zone.touchCount} touches, ${zone.strength}`);
        });
      lines.push('');
    }
  }

  // Key levels summary
  if (analysis.nextResistance || analysis.nextSupport) {
    lines.push('🎯 Key Levels:');
    if (analysis.nextResistance) {
      const resistanceDistance = ((analysis.nextResistance - analysis.currentPrice) / analysis.currentPrice * 100).toFixed(2);
      lines.push(`  Next Resistance: $${formatPrice(analysis.nextResistance)} (+${resistanceDistance}%)`);
    }
    if (analysis.nextSupport) {
      const supportDistance = ((analysis.currentPrice - analysis.nextSupport) / analysis.currentPrice * 100).toFixed(2);
      lines.push(`  Next Support: $${formatPrice(analysis.nextSupport)} (-${supportDistance}%)`);
    }
  }

  // Add price range info
  if (analysis.priceRange) {
    lines.push('');
    lines.push(`📈 Price Range: $${formatPrice(analysis.priceRange.low)} - $${formatPrice(analysis.priceRange.high)} (${analysis.priceRange.rangePercent}%)`);
  }

  lines.push(`Updated: ${analysis.timestamp.toLocaleString()}`);

  return lines.join('\n');
}

/**
 * Format support/resistance response
 */
function formatSupportResistanceResponse(analysis: LiquidityZonesAnalysis, cached: boolean): string {
  const lines: string[] = [
    `📍 ${analysis.symbol} Support & Resistance`,
    `Current: $${formatPrice(analysis.currentPrice)}`,
    '',
  ];

  if (analysis.nextResistance) {
    const resistanceDistance = ((analysis.nextResistance - analysis.currentPrice) / analysis.currentPrice * 100).toFixed(2);
    lines.push(`🔴 Resistance: $${formatPrice(analysis.nextResistance)} (+${resistanceDistance}% away)`);
  } else {
    lines.push('🔴 Resistance: No clear level identified');
  }

  if (analysis.nextSupport) {
    const supportDistance = ((analysis.currentPrice - analysis.nextSupport) / analysis.currentPrice * 100).toFixed(2);
    lines.push(`🟢 Support: $${formatPrice(analysis.nextSupport)} (-${supportDistance}% away)`);
  } else {
    lines.push('🟢 Support: No clear level identified');
  }

  lines.push('');
  lines.push(`Trend: ${getTrendEmoji(analysis.trend)} ${analysis.trend || 'neutral'}`);
  lines.push(`Cached: ${cached ? 'Yes ⚡' : 'Fresh'}`);

  return lines.join('\n');
}

/**
 * Format comprehensive price level analysis response
 */
function formatPriceLevelAnalysisResponse(
  analysis: LiquidityZonesAnalysis,
  currentPrice: number,
  cached: boolean
): string {
  const lines: string[] = [
    `📊 ${analysis.symbol} Comprehensive Price Level Analysis`,
    `═══════════════════════════════════════════`,
    '',
    `📈 Market Overview:`,
    `  Current Price: $${formatPrice(currentPrice)}`,
    `  Trend: ${getTrendEmoji(analysis.trend)} ${capitalizeFirst(analysis.trend || 'neutral')}`,
    `  Volatility: ${analysis.volatility?.toFixed(2) ?? 'N/A'}%`,
    `  Timeframe: ${analysis.timeframe}`,
    '',
  ];

  // Price range analysis
  if (analysis.priceRange) {
    const position = ((currentPrice - analysis.priceRange.low) / analysis.priceRange.range * 100).toFixed(1);
    lines.push(`📏 Price Range Analysis:`);
    lines.push(`  Range High: $${formatPrice(analysis.priceRange.high)}`);
    lines.push(`  Range Low: $${formatPrice(analysis.priceRange.low)}`);
    lines.push(`  Total Range: ${analysis.priceRange.rangePercent}%`);
    lines.push(`  Current Position: ${position}% of range`);
    lines.push('');
  }

  // Key levels
  lines.push(`🎯 Key Trading Levels:`);
  if (analysis.nextResistance) {
    const resistanceDistance = ((analysis.nextResistance - currentPrice) / currentPrice * 100).toFixed(2);
    lines.push(`  🔴 Next Resistance: $${formatPrice(analysis.nextResistance)} (+${resistanceDistance}%)`);
  }
  if (analysis.nextSupport) {
    const supportDistance = ((currentPrice - analysis.nextSupport) / currentPrice * 100).toFixed(2);
    lines.push(`  🟢 Next Support: $${formatPrice(analysis.nextSupport)} (-${supportDistance}%)`);
  }

  // Risk/reward if both levels exist
  if (analysis.nextResistance && analysis.nextSupport) {
    const upside = analysis.nextResistance - currentPrice;
    const downside = currentPrice - analysis.nextSupport;
    const riskReward = (upside / downside).toFixed(2);
    lines.push(`  📊 Risk/Reward Ratio: ${riskReward}:1`);
  }
  lines.push('');

  // All liquidity zones with details
  lines.push(`📍 All Liquidity Zones (${analysis.liquidityZones.length} identified):`);

  if (analysis.liquidityZones.length === 0) {
    lines.push('  No significant zones identified');
  } else {
    analysis.liquidityZones.forEach((zone, index) => {
      const distance = zone.type === 'resistance'
        ? ((zone.price - currentPrice) / currentPrice * 100).toFixed(2)
        : ((currentPrice - zone.price) / currentPrice * 100).toFixed(2);
      const direction = zone.type === 'resistance' ? '+' : '-';
      const emoji = zone.type === 'resistance' ? '🔴' : '🟢';
      const strengthIcon = getStrengthIcon(zone.strength);

      lines.push(`  ${index + 1}. ${emoji} $${formatPrice(zone.price)} (${direction}${distance}%)`);
      lines.push(`     ${strengthIcon} ${capitalizeFirst(zone.strength)} | ${zone.touchCount} touches`);
      if (zone.lastTouched) {
        const daysAgo = Math.floor((Date.now() - zone.lastTouched.getTime()) / (1000 * 60 * 60 * 24));
        lines.push(`     Last tested: ${daysAgo} days ago`);
      }
    });
  }
  lines.push('');

  // Trading insights
  lines.push(`💡 Trading Insights:`);

  // Trend-based insight
  if (analysis.trend === 'bullish') {
    lines.push(`  • Bullish trend - consider buying near support levels`);
    if (analysis.nextSupport) {
      lines.push(`  • Watch $${formatPrice(analysis.nextSupport)} for potential bounce`);
    }
  } else if (analysis.trend === 'bearish') {
    lines.push(`  • Bearish trend - consider selling near resistance levels`);
    if (analysis.nextResistance) {
      lines.push(`  • Watch $${formatPrice(analysis.nextResistance)} for potential rejection`);
    }
  } else {
    lines.push(`  • Neutral trend - trade the range between support/resistance`);
  }

  // Volatility insight
  if (analysis.volatility) {
    if (analysis.volatility > 50) {
      lines.push(`  • High volatility (${analysis.volatility.toFixed(1)}%) - use wider stops`);
    } else if (analysis.volatility < 20) {
      lines.push(`  • Low volatility (${analysis.volatility.toFixed(1)}%) - expect breakout potential`);
    }
  }

  lines.push('');
  lines.push(`⏱️ Data: ${cached ? 'Cached ⚡' : 'Fresh'} | Updated: ${analysis.timestamp.toLocaleString()}`);

  return lines.join('\n');
}

/**
 * Helper functions
 */
function formatPrice(price: number): string {
  if (price >= 1000) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (price >= 1) {
    return price.toFixed(2);
  } else {
    return price.toFixed(4);
  }
}

function getTrendEmoji(trend: string | undefined): string {
  switch (trend) {
    case 'bullish': return '📈';
    case 'bearish': return '📉';
    default: return '➡️';
  }
}

function getStrengthIcon(strength: string): string {
  switch (strength) {
    case 'strong': return '💪';
    case 'medium': return '✓';
    case 'weak': return '○';
    default: return '?';
  }
}

function formatDistancePercent(targetPrice: number, currentPrice: number): string {
  const distance = ((targetPrice - currentPrice) / currentPrice) * 100;
  const sign = distance >= 0 ? '+' : '';
  return `${sign}${distance.toFixed(2)}%`;
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Register quick support/resistance tool (uses simpler getSupportResistanceLevels function)
 * This is a leaner alternative that bypasses the full zone analysis
 */
export function registerQuickSupportResistanceTool(server: McpServer): void {
  const QuickSRInputSchema = z.object({
    symbol: z.string()
      .min(1)
      .max(10)
      .describe('Trading symbol (e.g., AAPL, TSLA, BTC)'),
    timeframe: z.enum(['1h', '4h', '1d', '1w'])
      .optional()
      .describe('Analysis timeframe (default: 1d). Use get_available_timeframes to see options.'),
  });

  server.registerTool(
    'quick_support_resistance',
    {
      title: 'Quick Support & Resistance',
      description: 'Get just the nearest support and resistance levels with minimal overhead. Uses the streamlined getSupportResistanceLevels function. For full zone analysis with caching, use get_support_resistance instead.',
      inputSchema: QuickSRInputSchema as any,
      outputSchema: SupportResistanceOutputSchema as any,
    },
    (async (args: { symbol: string; timeframe?: string }, _extra: any) => {
      const { symbol, timeframe } = args;
      const effectiveTimeframe = timeframe || '1d';
      const validTimeframes = getAvailableTimeframes();

      try {
        // Validate symbol
        if (!isValidSymbol(symbol)) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid symbol format: ${symbol}. Please use standard ticker symbols (e.g., AAPL, TSLA, BTC).`,
              },
            ],
          };
        }

        // Validate timeframe
        if (timeframe && !validTimeframes.includes(timeframe)) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid timeframe: ${timeframe}. Valid options are: ${validTimeframes.join(', ')}`,
              },
            ],
          };
        }

        // Use calculateLiquidityZones to get strength data for schema compliance
        const analysis = await calculateLiquidityZones(symbol.toUpperCase().trim(), effectiveTimeframe);

        const result = {
          symbol: analysis.symbol,
          currentPrice: analysis.currentPrice,
          support: analysis.nextSupport || 0,
          resistance: analysis.nextResistance || 0,
          trend: analysis.trend,
        };

        // Find strength for nearest levels
        const supportZone = analysis.liquidityZones.find(z => z.type === 'support' && Math.abs(z.price - (analysis.nextSupport || 0)) < 0.001);
        const resistanceZone = analysis.liquidityZones.find(z => z.type === 'resistance' && Math.abs(z.price - (analysis.nextResistance || 0)) < 0.001);

        const supportStrengthVal = supportZone ? (supportZone.strength === 'strong' ? 0.9 : supportZone.strength === 'medium' ? 0.6 : 0.3) : 0.5;
        const resistanceStrengthVal = resistanceZone ? (resistanceZone.strength === 'strong' ? 0.9 : resistanceZone.strength === 'medium' ? 0.6 : 0.3) : 0.5;

        // Format compact response
        const lines = [
          `📍 ${result.symbol} Quick S/R`,
          `Current: $${formatPrice(result.currentPrice)}`,
          '',
          result.resistance
            ? `🔴 Resistance: $${formatPrice(result.resistance)} (${formatDistancePercent(result.resistance, result.currentPrice)} away)`
            : '🔴 Resistance: Not identified',
          result.support
            ? `🟢 Support: $${formatPrice(result.support)} (${formatDistancePercent(result.support, result.currentPrice)} away)`
            : '🟢 Support: Not identified',
          '',
          `Trend: ${getTrendEmoji(result.trend)} ${result.trend}`,
        ];

        const structuredData = {
          symbol: analysis.symbol,
          currentPrice: analysis.currentPrice,
          nearestSupport: analysis.nextSupport || 0,
          nearestResistance: analysis.nextResistance || 0,
          supportStrength: supportStrengthVal,
          resistanceStrength: resistanceStrengthVal,
        };

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching S/R for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }) as any
  );

  addToRegistry({
    name: 'quick_support_resistance',
    description: 'Fast support/resistance levels without full zone analysis',
    category: 'technical',
    version: '0.1.0',
  });
}

/**
 * Register available timeframes tool
 */
export function registerAvailableTimeframesTool(server: McpServer): void {
  server.registerTool(
    'get_available_timeframes',
    {
      title: 'Get Available Timeframes',
      description: 'Get the list of available timeframes for liquidity zone analysis.',
      inputSchema: {} as any,
      outputSchema: AvailableTimeframesOutputSchema as any,
    },
    (async (_extra: any) => {
      const timeframes = getAvailableTimeframes();

      const descriptions: Record<string, string> = {
        '1h': 'Hourly - 7 day lookback, best for day trading',
        '4h': '4-Hour - 30 day lookback, best for swing trading',
        '1d': 'Daily - 90 day lookback, default for position trading',
        '1w': 'Weekly - 365 day lookback, best for long-term investing',
      };

      const lines = [
        '📈 Available Timeframes for Liquidity Analysis',
        '',
        ...timeframes.map(tf => `• ${tf}: ${descriptions[tf] || 'Unknown'}`),
        '',
        'Tip: Use these timeframes with get_liquidity_zones, get_support_resistance, or quick_support_resistance tools.',
      ];

      const structuredData = {
        timeframes: timeframes,
        descriptions: descriptions,
      };

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: structuredData,
      };
    }) as any
  );

  addToRegistry({
    name: 'get_available_timeframes',
    description: 'List available timeframes for analysis',
    category: 'technical',
    version: '0.1.0',
  });
}
