/**
 * Configuration management for Trading Intelligence MCP Server
 */

import { config as dotenvConfig } from 'dotenv';
import { ServerConfig } from './types.js';

// Load environment variables
dotenvConfig();

/**
 * Parse integer from environment variable with fallback
 */
function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse boolean from environment variable with fallback
 */
function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

/**
 * Server configuration singleton
 */
export const config: ServerConfig = {
  port: getEnvInt('PORT', 3000),
  nodeEnv: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',
  logLevel: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD,
    poolSize: getEnvInt('REDIS_POOL_SIZE', 10), // Connection pool size
  },

  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/trading_intelligence',
  },

  cache: {
    prices: {
      ttl: getEnvInt('CACHE_TTL_PRICES', 300), // 5 minutes
      prefix: 'price:',
    },
    liquidity: {
      ttl: getEnvInt('CACHE_TTL_LIQUIDITY', 900), // 15 minutes
      prefix: 'liquidity:',
    },
    fundamentals: {
      ttl: getEnvInt('CACHE_TTL_FUNDAMENTALS', 3600), // 1 hour
      prefix: 'fundamentals:',
    },
    news: {
      ttl: getEnvInt('CACHE_TTL_NEWS', 600), // 10 minutes
      prefix: 'news:',
    },
  },

  rateLimit: {
    requestsPerMinute: getEnvInt('RATE_LIMIT_REQUESTS_PER_MINUTE', 60),
    burst: getEnvInt('RATE_LIMIT_BURST', 10),
  },

  features: {
    enableCaching: getEnvBool('ENABLE_CACHING', true),
    enableHistoricalData: getEnvBool('ENABLE_HISTORICAL_DATA', true),
    enableNewsSentiment: getEnvBool('ENABLE_NEWS_SENTIMENT', false),
  },
};

/**
 * API configuration
 */
export const apiConfig = {
  yahooFinance: {
    baseUrl: process.env.YAHOO_FINANCE_BASE_URL || 'https://query2.finance.yahoo.com',
    apiKey: process.env.YAHOO_FINANCE_API_KEY,
  },
  alphaVantage: {
    apiKey: process.env.ALPHA_VANTAGE_API_KEY,
    baseUrl: 'https://www.alphavantage.co/query',
  },
  coinGecko: {
    baseUrl: process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3',
    apiKey: process.env.COINGECKO_API_KEY,
  },
  finnhub: {
    apiKey: process.env.FINNHUB_API_KEY,
    baseUrl: 'https://finnhub.io/api/v1',
  },
  newsApi: {
    apiKey: process.env.NEWS_API_KEY,
    baseUrl: 'https://newsapi.org/v2',
  },
  sec: {
    userAgent: process.env.SEC_USER_AGENT || 'trading-intelligence-mcp/0.1.0',
    baseUrl: 'https://data.sec.gov',
  },
};

/**
 * MCP server metadata
 */
export const mcpMetadata = {
  name: process.env.MCP_SERVER_NAME || 'trading-intelligence',
  version: process.env.MCP_SERVER_VERSION || '0.1.0',
  description: process.env.MCP_DESCRIPTION || 'Trading Intelligence MCP Server',
};

/**
 * Validate configuration on startup
 */
export function validateConfig(): void {
  const errors: string[] = [];

  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (majorVersion < 18) {
    errors.push(`Node.js version ${nodeVersion} is not supported. Minimum version is 18.0.0`);
  }

  // Validate Redis URL format (supports standard Redis and Upstash HTTPS URLs)
  const redisUrl = config.redis.url.toLowerCase();
  const validRedisProtocols = redisUrl.startsWith('redis://') ||
    redisUrl.startsWith('rediss://') ||
    redisUrl.startsWith('http://') ||
    redisUrl.startsWith('https://');

  if (!validRedisProtocols) {
    errors.push('REDIS_URL must start with redis://, rediss://, http://, or https://');
  }

  // Validate port
  if (config.port < 1 || config.port > 65535) {
    errors.push('PORT must be between 1 and 65535');
  }

  // Warn about missing API keys (non-fatal)
  const warnings: string[] = [];
  if (!apiConfig.yahooFinance.apiKey) {
    warnings.push('YAHOO_FINANCE_API_KEY is not set - some features may be limited');
  }
  if (!apiConfig.coinGecko.apiKey) {
    warnings.push('COINGECKO_API_KEY is not set - rate limits will be lower');
  }

  // Log warnings
  if (warnings.length > 0) {
    console.warn('Configuration warnings:');
    warnings.forEach(warning => console.warn(`  ⚠️  ${warning}`));
  }

  // Throw if there are errors
  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(error => console.error(`  ❌ ${error}`));
    throw new Error('Invalid configuration');
  }

  console.log('✅ Configuration validated successfully');
}

/**
 * Log configuration summary (without sensitive data)
 */
export function logConfigSummary(): void {
  console.log('=== Trading Intelligence MCP Server Configuration ===');
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Port: ${config.port}`);
  console.log(`Log Level: ${config.logLevel}`);
  console.log(`Redis: ${config.redis.url.replace(/:[^:@]*@/, ':****@')}`);
  console.log(`Caching: ${config.features.enableCaching ? 'Enabled' : 'Disabled'}`);
  console.log(`Historical Data: ${config.features.enableHistoricalData ? 'Enabled' : 'Disabled'}`);
  console.log(`News Sentiment: ${config.features.enableNewsSentiment ? 'Enabled' : 'Disabled'}`);
  console.log('===================================================');
}

export default config;
