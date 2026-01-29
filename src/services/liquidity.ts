/**
 * Liquidity Zones Service
 * Identifies support and resistance levels using price pivot point analysis
 */

import { LiquidityZone, TechnicalAnalysis, APIError } from '../types.js';

/**
 * Yahoo Finance API configuration
 */
const YAHOO_FINANCE_BASE_URL = 'https://query2.finance.yahoo.com';

/**
 * Common crypto symbols that need to be converted to Yahoo Finance format
 * These symbols will have '-USD' appended for Yahoo Finance API calls
 */
const CRYPTO_SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'DOT', 'MATIC', 'AVAX',
  'LINK', 'UNI', 'ATOM', 'LTC', 'ETC', 'XLM', 'ALGO', 'VET', 'FIL', 'AAVE',
  'SHIB', 'TRX', 'XMR', 'APT', 'ARB', 'OP', 'NEAR', 'INJ', 'FTM', 'RUNE',
  'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME', 'IMX', 'STX', 'SEI', 'SUI', 'TIA',
]);

/**
 * Check if a symbol is a known cryptocurrency
 */
export function isCryptoSymbol(symbol: string): boolean {
  const normalized = symbol.toUpperCase().trim();
  // Already in Yahoo format (ends with -USD)
  if (normalized.endsWith('-USD')) {
    return true;
  }
  return CRYPTO_SYMBOLS.has(normalized);
}

/**
 * Convert a crypto symbol to Yahoo Finance format
 * Appends '-USD' if not already present
 */
export function toYahooFinanceSymbol(symbol: string, assetType?: 'stock' | 'crypto'): string {
  const normalized = symbol.toUpperCase().trim();

  // If explicitly marked as crypto or detected as crypto, add -USD
  if (assetType === 'crypto' || isCryptoSymbol(normalized)) {
    // Don't double-append -USD
    if (normalized.endsWith('-USD')) {
      return normalized;
    }
    return `${normalized}-USD`;
  }

  return normalized;
}
const REQUEST_TIMEOUT = 10000; // 10 seconds for historical data

/**
 * Price bar interface for OHLCV data
 */
export interface PriceBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Price level identified from historical data
 */
export interface PriceLevel {
  price: number;
  date: Date;
  volume: number;
  type: 'high' | 'low';
}

/**
 * Clustered level after grouping nearby prices
 */
export interface ClusteredLevel {
  avgPrice: number;
  touches: number;
  lastDate: Date;
  avgVolume: number;
  prices: number[];
}

/**
 * Extended analysis result
 */
export interface LiquidityZonesAnalysis extends TechnicalAnalysis {
  currentPrice: number;
  nextResistance?: number;
  nextSupport?: number;
  priceRange: {
    high: number;
    low: number;
    range: number;
    rangePercent: number;
  };
}

/**
 * Timeframe mapping to Yahoo Finance intervals and periods
 */
const TIMEFRAME_CONFIG: Record<string, { interval: string; period: string; lookbackDays: number }> = {
  '1h': { interval: '1h', period: '7d', lookbackDays: 7 },
  '4h': { interval: '1h', period: '30d', lookbackDays: 30 },  // Use 1h and aggregate
  '1d': { interval: '1d', period: '90d', lookbackDays: 90 },
  '1w': { interval: '1d', period: '1y', lookbackDays: 365 },
};

/**
 * Yahoo Finance chart response interface
 */
interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: {
        symbol: string;
        currency: string;
        regularMarketPrice: number;
        regularMarketTime: number;
      };
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: number[];
          high: number[];
          low: number[];
          close: number[];
          volume: number[];
        }>;
      };
    }>;
    error: any;
  };
}

/**
 * Fetch historical price data from Yahoo Finance
 */
export async function fetchHistoricalPrices(
  symbol: string,
  timeframe: string = '1d',
  lookbackDays?: number
): Promise<PriceBar[]> {
  // Validate symbol format
  if (!symbol || typeof symbol !== 'string') {
    throw new APIError('Invalid symbol format');
  }

  // Normalize and convert crypto symbols to Yahoo Finance format
  const normalizedSymbol = symbol.toUpperCase().trim();
  const yahooSymbol = toYahooFinanceSymbol(normalizedSymbol);

  const config = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG['1d'];

  // Use custom lookback if provided, otherwise use config default
  const period = lookbackDays ? `${Math.min(lookbackDays, 365)}d` : config.period;

  try {
    // Build URL for Yahoo Finance chart API
    const url = new URL(`${YAHOO_FINANCE_BASE_URL}/v8/finance/chart/${yahooSymbol}`);
    url.searchParams.append('interval', config.interval);
    url.searchParams.append('range', period);
    url.searchParams.append('includePrePost', 'false');

    // Make request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new APIError(
        `Yahoo Finance API error: ${response.status} ${response.statusText}`,
        { status: response.status }
      );
    }

    const data = await response.json() as YahooChartResponse;

    // Check for API errors
    if (data.chart.error) {
      throw new APIError(
        data.chart.error.description || 'Yahoo Finance API error',
        { code: data.chart.error.code }
      );
    }

    // Check for valid result
    if (!data.chart.result || data.chart.result.length === 0) {
      throw new APIError(
        `No historical data found for symbol: ${normalizedSymbol}`,
        { symbol: normalizedSymbol, suggestion: 'Verify the symbol is correct' }
      );
    }

    const result = data.chart.result[0];
    const timestamps = result.timestamp || [];
    const quotes = result.indicators.quote[0];

    if (!quotes || timestamps.length === 0) {
      throw new APIError(
        `Incomplete historical data for symbol: ${normalizedSymbol}`,
        { symbol: normalizedSymbol }
      );
    }

    // Convert to PriceBar array
    const priceBars: PriceBar[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      // Skip bars with null values
      if (
        quotes.open[i] != null &&
        quotes.high[i] != null &&
        quotes.low[i] != null &&
        quotes.close[i] != null &&
        quotes.volume[i] != null
      ) {
        priceBars.push({
          date: new Date(timestamps[i] * 1000),
          open: quotes.open[i],
          high: quotes.high[i],
          low: quotes.low[i],
          close: quotes.close[i],
          volume: quotes.volume[i],
        });
      }
    }

    if (priceBars.length < 10) {
      throw new APIError(
        `Insufficient historical data for symbol: ${normalizedSymbol}. Need at least 10 bars, got ${priceBars.length}`,
        { symbol: normalizedSymbol, barsFound: priceBars.length }
      );
    }

    console.log(`[Liquidity Service] Fetched ${priceBars.length} bars for ${normalizedSymbol} (${timeframe})`);
    return priceBars;

  } catch (error: any) {
    // Handle AbortController timeout
    if (error.name === 'AbortError') {
      throw new APIError(
        `Request timeout for symbol: ${normalizedSymbol}`,
        { symbol: normalizedSymbol, timeout: REQUEST_TIMEOUT }
      );
    }

    // Re-throw APIError as-is
    if (error instanceof APIError) {
      throw error;
    }

    // Wrap unknown errors
    throw new APIError(
      `Failed to fetch historical data for ${normalizedSymbol}: ${error.message}`,
      { symbol: normalizedSymbol, originalError: error }
    );
  }
}

/**
 * Find local highs in price data (potential resistance levels)
 * A local high is when the current bar's high is higher than the surrounding bars
 */
export function findLocalHighs(priceData: PriceBar[], windowSize: number = 5): PriceLevel[] {
  const highs: PriceLevel[] = [];

  // Need at least windowSize bars on each side
  if (priceData.length < windowSize * 2 + 1) {
    return highs;
  }

  for (let i = windowSize; i < priceData.length - windowSize; i++) {
    const current = priceData[i];
    let isLocalHigh = true;

    // Check if current high is higher than all surrounding bars
    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j !== i && priceData[j].high >= current.high) {
        isLocalHigh = false;
        break;
      }
    }

    if (isLocalHigh) {
      highs.push({
        price: current.high,
        date: current.date,
        volume: current.volume,
        type: 'high',
      });
    }
  }

  return highs;
}

/**
 * Find local lows in price data (potential support levels)
 * A local low is when the current bar's low is lower than the surrounding bars
 */
export function findLocalLows(priceData: PriceBar[], windowSize: number = 5): PriceLevel[] {
  const lows: PriceLevel[] = [];

  // Need at least windowSize bars on each side
  if (priceData.length < windowSize * 2 + 1) {
    return lows;
  }

  for (let i = windowSize; i < priceData.length - windowSize; i++) {
    const current = priceData[i];
    let isLocalLow = true;

    // Check if current low is lower than all surrounding bars
    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j !== i && priceData[j].low <= current.low) {
        isLocalLow = false;
        break;
      }
    }

    if (isLocalLow) {
      lows.push({
        price: current.low,
        date: current.date,
        volume: current.volume,
        type: 'low',
      });
    }
  }

  return lows;
}

/**
 * Cluster nearby price levels together
 * Levels within the threshold percentage are grouped
 */
export function clusterLevels(levels: PriceLevel[], threshold: number = 0.02): ClusteredLevel[] {
  if (levels.length === 0) {
    return [];
  }

  // Sort levels by price
  const sortedLevels = [...levels].sort((a, b) => a.price - b.price);

  const clusters: ClusteredLevel[] = [];
  let currentCluster: PriceLevel[] = [sortedLevels[0]];

  for (let i = 1; i < sortedLevels.length; i++) {
    const currentLevel = sortedLevels[i];
    const prevLevel = sortedLevels[i - 1];

    // Calculate price difference as percentage
    const priceDiff = Math.abs(currentLevel.price - prevLevel.price) / prevLevel.price;

    if (priceDiff <= threshold) {
      // Add to current cluster
      currentCluster.push(currentLevel);
    } else {
      // Finalize current cluster and start new one
      if (currentCluster.length > 0) {
        clusters.push(aggregateCluster(currentCluster));
      }
      currentCluster = [currentLevel];
    }
  }

  // Don't forget the last cluster
  if (currentCluster.length > 0) {
    clusters.push(aggregateCluster(currentCluster));
  }

  return clusters;
}

/**
 * Aggregate multiple price levels into a single clustered level
 */
function aggregateCluster(levels: PriceLevel[]): ClusteredLevel {
  const avgPrice = levels.reduce((sum, l) => sum + l.price, 0) / levels.length;
  const avgVolume = levels.reduce((sum, l) => sum + l.volume, 0) / levels.length;

  // Find the most recent date
  const sortedByDate = [...levels].sort((a, b) => b.date.getTime() - a.date.getTime());
  const lastDate = sortedByDate[0].date;

  return {
    avgPrice,
    touches: levels.length,
    lastDate,
    avgVolume,
    prices: levels.map(l => l.price),
  };
}

/**
 * Calculate strength of a liquidity zone based on touches and volume
 */
export function calculateStrength(
  touchCount: number,
  volume: number,
  avgVolume: number
): 'strong' | 'medium' | 'weak' {
  // Score based on touches (more touches = stronger)
  let touchScore = 0;
  if (touchCount >= 4) touchScore = 3;
  else if (touchCount >= 3) touchScore = 2;
  else if (touchCount >= 2) touchScore = 1;
  else touchScore = 0;

  // Score based on volume (higher than average = stronger)
  let volumeScore = 0;
  if (avgVolume > 0) {
    const volumeRatio = volume / avgVolume;
    if (volumeRatio >= 1.5) volumeScore = 2;
    else if (volumeRatio >= 1.0) volumeScore = 1;
    else volumeScore = 0;
  }

  const totalScore = touchScore + volumeScore;

  if (totalScore >= 4) return 'strong';
  if (totalScore >= 2) return 'medium';
  return 'weak';
}

/**
 * Score a zone for sorting (higher = more important)
 */
function scoreZone(zone: LiquidityZone, currentPrice: number): number {
  let score = 0;

  // Strength score
  if (zone.strength === 'strong') score += 10;
  else if (zone.strength === 'medium') score += 5;
  else score += 2;

  // Touch count bonus
  score += zone.touchCount * 2;

  // Recency bonus (zones tested recently are more relevant)
  if (zone.lastTouched) {
    const daysSinceTouched = (Date.now() - zone.lastTouched.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceTouched < 7) score += 5;
    else if (daysSinceTouched < 30) score += 3;
    else if (daysSinceTouched < 60) score += 1;
  }

  // Proximity bonus (zones closer to current price are more actionable)
  const distancePercent = Math.abs(zone.price - currentPrice) / currentPrice;
  if (distancePercent < 0.05) score += 5;  // Within 5%
  else if (distancePercent < 0.10) score += 3;  // Within 10%
  else if (distancePercent < 0.20) score += 1;  // Within 20%

  return score;
}

/**
 * Determine market trend based on price action
 */
function determineTrend(priceData: PriceBar[]): 'bullish' | 'bearish' | 'neutral' {
  if (priceData.length < 20) {
    return 'neutral';
  }

  // Compare recent price to older price
  const recentBars = priceData.slice(-10);
  const olderBars = priceData.slice(-30, -20);

  if (olderBars.length === 0) {
    return 'neutral';
  }

  const recentAvg = recentBars.reduce((sum, b) => sum + b.close, 0) / recentBars.length;
  const olderAvg = olderBars.reduce((sum, b) => sum + b.close, 0) / olderBars.length;

  const change = (recentAvg - olderAvg) / olderAvg;

  if (change > 0.03) return 'bullish';
  if (change < -0.03) return 'bearish';
  return 'neutral';
}

/**
 * Identify pivot points and convert to liquidity zones
 */
export function identifyPivotPoints(
  priceData: PriceBar[],
  currentPrice: number,
  windowSize: number = 5,
  clusterThreshold: number = 0.02
): LiquidityZone[] {
  // Calculate average volume for strength calculation
  const avgVolume = priceData.reduce((sum, b) => sum + b.volume, 0) / priceData.length;

  // Find local highs and lows
  const highs = findLocalHighs(priceData, windowSize);
  const lows = findLocalLows(priceData, windowSize);

  // Cluster nearby levels
  const clusteredResistance = clusterLevels(highs, clusterThreshold);
  const clusteredSupport = clusterLevels(lows, clusterThreshold);

  // Convert to LiquidityZone format
  const resistanceZones: LiquidityZone[] = clusteredResistance.map(level => ({
    price: Math.round(level.avgPrice * 100) / 100, // Round to 2 decimal places
    type: 'resistance',
    strength: calculateStrength(level.touches, level.avgVolume, avgVolume),
    touchCount: level.touches,
    lastTouched: level.lastDate,
  }));

  const supportZones: LiquidityZone[] = clusteredSupport.map(level => ({
    price: Math.round(level.avgPrice * 100) / 100, // Round to 2 decimal places
    type: 'support',
    strength: calculateStrength(level.touches, level.avgVolume, avgVolume),
    touchCount: level.touches,
    lastTouched: level.lastDate,
  }));

  // Combine and sort by importance
  const allZones = [...resistanceZones, ...supportZones];
  allZones.sort((a, b) => scoreZone(b, currentPrice) - scoreZone(a, currentPrice));

  return allZones;
}

/**
 * Main function to calculate liquidity zones for a symbol
 */
export async function calculateLiquidityZones(
  symbol: string,
  timeframe: string = '1d',
  lookbackDays?: number,
  maxZones: number = 5
): Promise<LiquidityZonesAnalysis> {
  const startTime = Date.now();

  // Fetch historical price data
  const priceData = await fetchHistoricalPrices(symbol, timeframe, lookbackDays);

  if (priceData.length === 0) {
    throw new APIError(`No price data available for ${symbol}`);
  }

  // Get current price from the most recent bar
  const currentPrice = priceData[priceData.length - 1].close;

  // Adjust window size based on data available
  const windowSize = Math.min(5, Math.floor(priceData.length / 4));

  // Identify liquidity zones
  const allZones = identifyPivotPoints(priceData, currentPrice, windowSize);

  // Get top zones
  const topZones = allZones.slice(0, maxZones);

  // Find nearest support and resistance
  const supportZones = topZones.filter(z => z.type === 'support' && z.price < currentPrice);
  const resistanceZones = topZones.filter(z => z.type === 'resistance' && z.price > currentPrice);

  const nextSupport = supportZones.length > 0
    ? Math.max(...supportZones.map(z => z.price))
    : undefined;

  const nextResistance = resistanceZones.length > 0
    ? Math.min(...resistanceZones.map(z => z.price))
    : undefined;

  // Calculate price range
  const highPrice = Math.max(...priceData.map(b => b.high));
  const lowPrice = Math.min(...priceData.map(b => b.low));
  const priceRange = highPrice - lowPrice;
  const rangePercent = (priceRange / lowPrice) * 100;

  // Determine trend
  const trend = determineTrend(priceData);

  // Calculate volatility (standard deviation of returns)
  const returns = priceData.slice(1).map((bar, i) =>
    (bar.close - priceData[i].close) / priceData[i].close
  );
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const volatility = Math.sqrt(
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  ) * Math.sqrt(252); // Annualize

  // Calculate average volume
  const avgVolume = priceData.reduce((sum, b) => sum + b.volume, 0) / priceData.length;

  const responseTime = Date.now() - startTime;
  console.log(`[Liquidity Service] Calculated zones for ${symbol} in ${responseTime}ms (${allZones.length} zones found, returning top ${topZones.length})`);

  return {
    symbol: symbol.toUpperCase(),
    timeframe,
    liquidityZones: topZones,
    currentPrice,
    nextSupport,
    nextResistance,
    trend,
    volatility: Math.round(volatility * 10000) / 100, // As percentage
    volume: avgVolume,
    priceRange: {
      high: highPrice,
      low: lowPrice,
      range: priceRange,
      rangePercent: Math.round(rangePercent * 100) / 100,
    },
    timestamp: new Date(),
  };
}

/**
 * Get simplified support and resistance levels
 */
export async function getSupportResistanceLevels(
  symbol: string,
  timeframe: string = '1d'
): Promise<{
  symbol: string;
  currentPrice: number;
  support: number | null;
  resistance: number | null;
  trend: 'bullish' | 'bearish' | 'neutral';
  timestamp: Date;
}> {
  const analysis = await calculateLiquidityZones(symbol, timeframe);

  return {
    symbol: analysis.symbol,
    currentPrice: analysis.currentPrice,
    support: analysis.nextSupport ?? null,
    resistance: analysis.nextResistance ?? null,
    trend: analysis.trend || 'neutral',
    timestamp: analysis.timestamp,
  };
}

/**
 * Validate if a symbol is likely valid for liquidity analysis
 */
export function isValidSymbol(symbol: string): boolean {
  if (!symbol || typeof symbol !== 'string') return false;

  const normalized = symbol.toUpperCase().trim();

  // Basic validation: 1-10 alphanumeric characters, may include - or .
  const validPattern = /^[A-Z0-9]{1,10}([.-][A-Z0-9]{1,4})?$/;

  return validPattern.test(normalized);
}

/**
 * Get available timeframes
 */
export function getAvailableTimeframes(): string[] {
  return Object.keys(TIMEFRAME_CONFIG);
}
