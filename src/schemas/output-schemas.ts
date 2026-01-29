/**
 * Output Schema Definitions for Context Protocol Data Broker Standard
 * 
 * These schemas are REQUIRED by Context Protocol for:
 * 1. AI code generation with precise parsing
 * 2. Type safety with guaranteed structure
 * 3. Auto-adjudicated dispute resolution on-chain
 * 4. "Data Broker" verification badge
 */

/**
 * Price Tool Output Schemas
 */
export const PriceOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { 
      type: "string" as const,
      description: "Asset symbol (e.g., AAPL, BTC)"
    },
    price: { 
      type: "number" as const,
      description: "Current price in USD"
    },
    change: { 
      type: "number" as const,
      description: "Price change in USD"
    },
    changePercent: { 
      type: "number" as const,
      description: "Price change percentage"
    },
    volume: { 
      type: "number" as const,
      description: "Trading volume"
    },
    marketCap: { 
      type: "number" as const,
      description: "Market capitalization"
    },
    timestamp: { 
      type: "string" as const,
      description: "ISO 8601 timestamp"
    },
    source: { 
      type: "string" as const,
      description: "Data source (yahoo_finance, coingecko)"
    },
    cached: { 
      type: "boolean" as const,
      description: "Whether data was served from cache"
    }
  },
  required: ["symbol", "price", "timestamp", "source"]
};

export const BatchPricesOutputSchema = {
  type: "object" as const,
  properties: {
    prices: {
      type: "array" as const,
      items: PriceOutputSchema
    },
    timestamp: { 
      type: "string" as const,
      description: "ISO 8601 timestamp of batch query"
    }
  },
  required: ["prices", "timestamp"]
};

/**
 * Funding Rate Tool Output Schemas
 */
export const FundingRateOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { 
      type: "string" as const,
      description: "Perpetual futures symbol"
    },
    fundingRate: { 
      type: "number" as const,
      description: "Current funding rate (decimal)"
    },
    fundingRatePercent: { 
      type: "string" as const,
      description: "Funding rate as percentage string"
    },
    nextFundingTime: { 
      type: "string" as const,
      description: "ISO 8601 timestamp of next funding"
    },
    interpretation: { 
      type: "string" as const,
      description: "Sentiment interpretation (e.g., 'Bullish', 'Neutral')"
    },
    annualizedRate: { 
      type: "string" as const,
      description: "Annualized funding rate percentage"
    },
    source: { 
      type: "string" as const,
      description: "Exchange source (binance)"
    },
    cached: { 
      type: "boolean" as const
    }
  },
  required: ["symbol", "fundingRate", "fundingRatePercent", "interpretation", "source"]
};

export const FundingRateStatsOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { type: "string" as const },
    current: { type: "number" as const, description: "Current funding rate" },
    average: { type: "number" as const, description: "Historical average" },
    high: { type: "number" as const, description: "Historical high" },
    low: { type: "number" as const, description: "Historical low" },
    trend: { type: "string" as const, description: "Trend direction (up/down/stable)" },
    dataPoints: { type: "number" as const, description: "Number of historical data points" }
  },
  required: ["symbol", "current", "average", "high", "low", "trend"]
};

/**
 * Fundamentals Tool Output Schemas
 */
export const CompanyOverviewOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { type: "string" as const },
    name: { type: "string" as const },
    description: { type: "string" as const },
    sector: { type: "string" as const },
    industry: { type: "string" as const },
    marketCap: { type: "number" as const },
    peRatio: { type: "number" as const },
    eps: { type: "number" as const },
    dividendYield: { type: "number" as const },
    "52WeekHigh": { type: "number" as const },
    "52WeekLow": { type: "number" as const },
    source: { type: "string" as const },
    cached: { type: "boolean" as const },
    cacheExpiry: { type: "string" as const, description: "ISO 8601 timestamp when cache expires" }
  },
  required: ["symbol", "name", "sector", "industry", "source"]
};

export const EarningsOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { type: "string" as const },
    earnings: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          fiscalDateEnding: { type: "string" as const },
          reportedEPS: { type: "number" as const },
          estimatedEPS: { type: "number" as const },
          surprise: { type: "number" as const },
          surprisePercentage: { type: "number" as const }
        },
        required: ["fiscalDateEnding", "reportedEPS"]
      }
    },
    source: { type: "string" as const },
    cached: { type: "boolean" as const }
  },
  required: ["symbol", "earnings", "source"]
};

export const FinancialStatementsOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { type: "string" as const },
    period: { type: "string" as const, description: "annual or quarterly" },
    incomeStatement: { type: "object" as const },
    balanceSheet: { type: "object" as const },
    cashFlow: { type: "object" as const },
    source: { type: "string" as const },
    cached: { type: "boolean" as const }
  },
  required: ["symbol", "period", "source"]
};

export const FullFundamentalsOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { type: "string" as const },
    overview: CompanyOverviewOutputSchema,
    earnings: EarningsOutputSchema,
    summary: { 
      type: "string" as const,
      description: "AI-generated summary of key metrics"
    },
    source: { type: "string" as const }
  },
  required: ["symbol", "overview", "source"]
};

/**
 * Liquidity/Technical Analysis Tool Output Schemas
 */
export const LiquidityZoneOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { type: "string" as const },
    currentPrice: { type: "number" as const },
    timeframe: { type: "string" as const },
    zones: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          type: { type: "string" as const, description: "support or resistance" },
          price: { type: "number" as const },
          strength: { type: "number" as const, description: "0-1 strength rating" },
          touches: { type: "number" as const, description: "Number of times tested" },
          distance: { type: "string" as const, description: "Distance from current price" }
        },
        required: ["type", "price", "strength"]
      }
    },
    trend: { type: "string" as const, description: "Overall trend direction" },
    recommendation: { type: "string" as const },
    cached: { type: "boolean" as const }
  },
  required: ["symbol", "currentPrice", "timeframe", "zones"]
};

export const SupportResistanceOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { type: "string" as const },
    currentPrice: { type: "number" as const },
    nearestSupport: { type: "number" as const },
    nearestResistance: { type: "number" as const },
    supportStrength: { type: "number" as const },
    resistanceStrength: { type: "number" as const }
  },
  required: ["symbol", "currentPrice", "nearestSupport", "nearestResistance"]
};

export const PriceLevelAnalysisOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { type: "string" as const },
    currentPrice: { type: "number" as const },
    allZones: {
      type: "array" as const,
      items: LiquidityZoneOutputSchema.properties.zones.items
    },
    distances: {
      type: "object" as const,
      properties: {
        nearestSupport: { type: "string" as const },
        nearestResistance: { type: "string" as const }
      }
    },
    trend: { type: "string" as const },
    recommendation: { type: "string" as const }
  },
  required: ["symbol", "currentPrice", "allZones", "trend"]
};

/**
 * System Tool Output Schemas
 */
export const HealthCheckOutputSchema = {
  type: "object" as const,
  properties: {
    status: { type: "string" as const, description: "healthy or unhealthy" },
    version: { type: "string" as const },
    uptime: { type: "number" as const, description: "Server uptime in seconds" },
    cache: {
      type: "object" as const,
      properties: {
        status: { type: "string" as const, description: "connected or disconnected" },
        latency: { type: "string" as const },
        hitRate: { type: "string" as const }
      }
    },
    tools: { type: "number" as const, description: "Number of registered tools" },
    integrations: {
      type: "object" as const,
      properties: {
        yahooFinance: { type: "string" as const },
        coinGecko: { type: "string" as const },
        binance: { type: "string" as const },
        alphaVantage: { type: "string" as const },
        redis: { type: "string" as const }
      }
    }
  },
  required: ["status", "version", "uptime", "tools"]
};

export const ListSupportedPerpetualsOutputSchema = {
  type: "object" as const,
  properties: {
    symbols: {
      type: "array" as const,
      items: { type: "string" as const }
    },
    count: { type: "number" as const },
    source: { type: "string" as const }
  },
  required: ["symbols", "count", "source"]
};

export const AvailableTimeframesOutputSchema = {
  type: "object" as const,
  properties: {
    timeframes: {
      type: "array" as const,
      items: { type: "string" as const }
    },
    descriptions: {
      type: "object" as const,
      additionalProperties: { type: "string" as const }
    }
  },
  required: ["timeframes"]
};

export const CacheInvalidationOutputSchema = {
  type: "object" as const,
  properties: {
    symbol: { type: "string" as const },
    invalidated: { type: "boolean" as const },
    message: { type: "string" as const }
  },
  required: ["symbol", "invalidated", "message"]
};
