/**
 * Core type definitions for Trading Intelligence MCP Server
 */

// ===== Asset Types =====

export type AssetType = 'stock' | 'crypto' | 'forex' | 'commodity';

export interface Asset {
  symbol: string;
  name: string;
  type: AssetType;
  exchange?: string;
  currency?: string;
}

// ===== Price Data =====

export interface PriceData {
  symbol: string;
  price: number;
  currency: string;
  timestamp: Date;
  source: string;
  volume24h?: number;
  change24h?: number;
  changePercent24h?: number;
  high24h?: number;
  low24h?: number;
  marketCap?: number;
}

export interface PriceQuery {
  symbol: string;
  assetType?: AssetType;
  includeExtendedData?: boolean;
}

// ===== Technical Analysis =====

export interface LiquidityZone {
  price: number;
  strength: 'strong' | 'medium' | 'weak';
  type: 'support' | 'resistance';
  touchCount: number;
  lastTouched?: Date;
}

export interface TechnicalAnalysis {
  symbol: string;
  timeframe: string;
  liquidityZones: LiquidityZone[];
  trend?: 'bullish' | 'bearish' | 'neutral';
  volatility?: number;
  volume?: number;
  timestamp: Date;
}

export interface LiquidityQuery {
  symbol: string;
  timeframe: string; // e.g., "1h", "4h", "1d", "1w"
  lookbackPeriod?: number; // days
}

// ===== Fundamental Data =====

export interface FundamentalData {
  symbol: string;
  companyName: string;
  sector?: string;
  industry?: string;
  marketCap?: number;
  peRatio?: number;
  eps?: number;
  revenue?: number;
  netIncome?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  shareholdersEquity?: number;
  timestamp: Date;
}

export interface EarningsData {
  symbol: string;
  quarter: string;
  year: number;
  reportDate: Date;
  epsEstimate?: number;
  epsActual?: number;
  revenueEstimate?: number;
  revenueActual?: number;
  surprise?: number;
  surprisePercent?: number;
}

export interface SECFiling {
  symbol: string;
  filingType: string; // e.g., "10-K", "10-Q", "8-K"
  filingDate: Date;
  reportDate?: Date;
  url: string;
  summary?: string;
}

export interface FundamentalsQuery {
  symbol: string;
  dataType: 'overview' | 'earnings' | 'balance_sheet' | 'income_statement' | 'sec_filings';
  period?: string; // e.g., "annual", "quarterly"
  limit?: number;
}

// ===== Derivatives Data =====

export interface FundingRate {
  symbol: string;
  exchange: string;
  rate: number;
  nextFundingTime?: Date;
  predictedRate?: number;
  timestamp: Date;
}

export interface OpenInterest {
  symbol: string;
  exchange: string;
  openInterest: number;
  change24h?: number;
  timestamp: Date;
}

export interface OptionsFlow {
  symbol: string;
  strike: number;
  expiration: Date;
  type: 'call' | 'put';
  volume: number;
  openInterest: number;
  impliedVolatility?: number;
  premium?: number;
  timestamp: Date;
}

// ===== News & Sentiment =====

export interface NewsArticle {
  title: string;
  source: string;
  url: string;
  publishedAt: Date;
  summary?: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
  sentimentScore?: number; // -1 to 1
  relatedSymbols: string[];
}

export interface SentimentAnalysis {
  symbol: string;
  overallSentiment: 'bullish' | 'bearish' | 'neutral';
  sentimentScore: number; // -1 to 1
  articleCount: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  timeframe: string;
  timestamp: Date;
}

// ===== Cache Configuration =====

export interface CacheConfig {
  ttl: number; // Time to live in seconds
  prefix: string;
}

export interface CacheEntry<T> {
  data: T;
  cachedAt: Date;
  expiresAt: Date;
}

// ===== MCP Tool Responses =====

export interface MCPToolResponse<T = any> {
  [x: string]: unknown;  // <-- ADD THIS LINE
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata?: {
    cached: boolean;
    responseTime: number;
    source: string;
    timestamp: Date;
  };
}

// ===== Configuration =====

export interface ServerConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  redis: {
    url: string;
    password?: string;
    poolSize?: number;  // Connection pool size
  };
  database: {
    url: string;
  };
  cache: {
    prices: CacheConfig;
    liquidity: CacheConfig;
    fundamentals: CacheConfig;
    news: CacheConfig;
  };
  rateLimit: {
    requestsPerMinute: number;
    burst: number;
  };
  features: {
    enableCaching: boolean;
    enableHistoricalData: boolean;
    enableNewsSentiment: boolean;
  };
}

// ===== Error Types =====

export class MCPError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'MCPError';
  }
}

export class APIError extends MCPError {
  constructor(message: string, details?: any) {
    super('API_ERROR', message, details);
    this.name = 'APIError';
  }
}

export class CacheError extends MCPError {
  constructor(message: string, details?: any) {
    super('CACHE_ERROR', message, details);
    this.name = 'CacheError';
  }
}

export class ValidationError extends MCPError {
  constructor(message: string, details?: any) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}
