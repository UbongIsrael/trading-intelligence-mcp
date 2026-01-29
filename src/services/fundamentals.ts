/**
 * Fundamentals Service
 * Fetches company fundamental data (financials, earnings, company profile) from Finnhub
 */

import { EarningsData, APIError } from '../types.js';
import { apiConfig } from '../config.js';

/**
 * Finnhub API configuration
 */
const FINNHUB_BASE_URL = apiConfig.finnhub.baseUrl || 'https://finnhub.io/api/v1';
const REQUEST_TIMEOUT = 10000; // 10 seconds
const RATE_LIMIT_DELAY = 1100; // ~55 requests per minute to stay under limit

/**
 * Extended company overview beyond FundamentalData
 */
export interface CompanyOverview {
  symbol: string;
  name: string;
  description: string;
  sector: string;
  industry: string;
  marketCap: number;
  peRatio?: number;
  eps?: number;
  dividendYield?: number;
  week52High?: number;
  week52Low?: number;
  averageVolume?: number;
  beta?: number;
  exchange: string;
  currency: string;
  country: string;
  ipo?: string;
  weburl?: string;
  logo?: string;
  phone?: string;
  timestamp: Date;
}

/**
 * Financial statement data
 */
export interface FinancialStatement {
  symbol: string;
  fiscalYear: number;
  fiscalQuarter?: number;
  period: string; // 'annual' or 'quarterly'
  reportDate: Date;
  
  // Balance Sheet
  totalAssets?: number;
  totalLiabilities?: number;
  totalEquity?: number;
  totalDebt?: number;
  currentAssets?: number;
  currentLiabilities?: number;
  cash?: number;
  
  // Income Statement
  revenue?: number;
  costOfRevenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  ebitda?: number;
  
  // Cash Flow
  operatingCashFlow?: number;
  investingCashFlow?: number;
  financingCashFlow?: number;
  freeCashFlow?: number;
  
  // Margins
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;
  
  timestamp: Date;
}

/**
 * Extended earnings data
 */
export interface ExtendedEarningsData extends EarningsData {
  period: string;
}

/**
 * Finnhub profile response
 */
interface FinnhubProfile {
  country: string;
  currency: string;
  exchange: string;
  ipo: string;
  marketCapitalization: number;
  name: string;
  phone: string;
  shareOutstanding: number;
  ticker: string;
  weburl: string;
  logo: string;
  finnhubIndustry: string;
}

/**
 * Finnhub metrics response
 */
interface FinnhubMetrics {
  metric: {
    '10DayAverageTradingVolume'?: number;
    '52WeekHigh'?: number;
    '52WeekLow'?: number;
    'beta'?: number;
    'dividendYieldIndicatedAnnual'?: number;
    'epsAnnual'?: number;
    'epsGrowth3Y'?: number;
    'epsGrowth5Y'?: number;
    'epsGrowthTTMYoy'?: number;
    'peAnnual'?: number;
    'peBasicExclExtraTTM'?: number;
    'peTTM'?: number;
    'grossMarginAnnual'?: number;
    'grossMarginTTM'?: number;
    'netProfitMarginAnnual'?: number;
    'netProfitMarginTTM'?: number;
    'operatingMarginAnnual'?: number;
    'operatingMarginTTM'?: number;
    'revenuePerShareAnnual'?: number;
    'revenuePerShareTTM'?: number;
    'roaRfy'?: number;
    'roeTTM'?: number;
    'currentRatioAnnual'?: number;
    'currentRatioQuarterly'?: number;
    'quickRatioAnnual'?: number;
    'quickRatioQuarterly'?: number;
    'debtEquityAnnual'?: number;
    'debtEquityQuarterly'?: number;
    'totalDebtToEquityAnnual'?: number;
    'totalDebtToEquityQuarterly'?: number;
    [key: string]: number | undefined;
  };
  series?: {
    annual?: Record<string, Array<{ period: string; v: number }>>;
    quarterly?: Record<string, Array<{ period: string; v: number }>>;
  };
}

/**
 * Finnhub earnings response
 */
interface FinnhubEarnings {
  actual: number;
  estimate: number;
  period: string;
  quarter: number;
  surprise: number;
  surprisePercent: number;
  symbol: string;
  year: number;
}

/**
 * Finnhub financial report response
 */
interface FinnhubFinancialReport {
  accessNumber: string;
  symbol: string;
  cik: string;
  year: number;
  quarter: number;
  form: string;
  startDate: string;
  endDate: string;
  filedDate: string;
  acceptedDate: string;
  report: {
    bs?: Record<string, number>;
    ic?: Record<string, number>;
    cf?: Record<string, number>;
  };
}

/**
 * Rate limiter state
 */
let lastRequestTime = 0;

/**
 * Apply rate limiting
 */
async function applyRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
    const delay = RATE_LIMIT_DELAY - timeSinceLastRequest;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  lastRequestTime = Date.now();
}

/**
 * Get API key from config
 */
function getApiKey(): string {
  const apiKey = apiConfig.finnhub.apiKey;
  if (!apiKey) {
    throw new APIError(
      'Finnhub API key not configured. Set FINNHUB_API_KEY environment variable.',
      { suggestion: 'Get a free API key at https://finnhub.io/' }
    );
  }
  return apiKey;
}

/**
 * Normalize stock symbol
 */
function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().trim();
}

/**
 * Validate stock symbol format
 */
function validateSymbol(symbol: string): void {
  if (!symbol || typeof symbol !== 'string') {
    throw new APIError('Invalid symbol format: Symbol is required', { symbol });
  }
  
  const normalized = normalizeSymbol(symbol);
  
  // Basic validation: 1-5 uppercase letters
  if (!/^[A-Z]{1,5}$/.test(normalized)) {
    throw new APIError(
      `Invalid symbol format: ${symbol}. Stock symbols should be 1-5 letters.`,
      { symbol, normalized }
    );
  }
}

/**
 * Make API request to Finnhub
 */
async function finnhubRequest<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  await applyRateLimit();
  
  const apiKey = getApiKey();
  const url = new URL(`${FINNHUB_BASE_URL}${endpoint}`);
  url.searchParams.append('token', apiKey);
  
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      if (response.status === 429) {
        throw new APIError(
          'Finnhub rate limit exceeded. Please wait and try again.',
          { status: 429, retryAfter: response.headers.get('Retry-After') }
        );
      }
      if (response.status === 401) {
        throw new APIError(
          'Finnhub API key is invalid or expired.',
          { status: 401 }
        );
      }
      if (response.status === 403) {
        throw new APIError(
          'Access denied. This endpoint may require a premium subscription.',
          { status: 403, endpoint }
        );
      }
      
      throw new APIError(
        `Finnhub API error: ${response.status} ${response.statusText}`,
        { status: response.status, endpoint }
      );
    }
    
    const data = await response.json() as T;
    return data;
    
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new APIError(
        `Request timeout for ${endpoint}`,
        { endpoint, timeout: REQUEST_TIMEOUT }
      );
    }
    
    if (error instanceof APIError) {
      throw error;
    }
    
    throw new APIError(
      `Finnhub request failed: ${error.message}`,
      { endpoint, originalError: error.message }
    );
  }
}

/**
 * Fetch company overview (profile + metrics)
 */
export async function fetchCompanyOverview(symbol: string): Promise<CompanyOverview> {
  const startTime = Date.now();
  validateSymbol(symbol);
  const normalized = normalizeSymbol(symbol);
  
  try {
    // Fetch profile and metrics in parallel
    const [profile, metricsData] = await Promise.all([
      finnhubRequest<FinnhubProfile>('/stock/profile2', { symbol: normalized }),
      finnhubRequest<FinnhubMetrics>('/stock/metric', { symbol: normalized, metric: 'all' }),
    ]);
    
    // Check if profile data exists
    if (!profile || !profile.name) {
      throw new APIError(
        `Company not found: ${symbol}`,
        { symbol: normalized, suggestion: 'Ensure the symbol is a valid US stock ticker' }
      );
    }
    
    const metrics = metricsData.metric || {};
    
    const overview: CompanyOverview = {
      symbol: normalized,
      name: profile.name,
      description: '', // Finnhub free tier doesn't include description
      sector: profile.finnhubIndustry || 'Unknown',
      industry: profile.finnhubIndustry || 'Unknown',
      marketCap: profile.marketCapitalization * 1_000_000, // Convert from millions
      peRatio: metrics.peBasicExclExtraTTM || metrics.peTTM || metrics.peAnnual,
      eps: metrics.epsAnnual,
      dividendYield: metrics.dividendYieldIndicatedAnnual,
      week52High: metrics['52WeekHigh'],
      week52Low: metrics['52WeekLow'],
      averageVolume: metrics['10DayAverageTradingVolume'] 
        ? metrics['10DayAverageTradingVolume'] * 1_000_000 
        : undefined,
      beta: metrics.beta,
      exchange: profile.exchange,
      currency: profile.currency,
      country: profile.country,
      ipo: profile.ipo,
      weburl: profile.weburl,
      logo: profile.logo,
      phone: profile.phone,
      timestamp: new Date(),
    };
    
    const responseTime = Date.now() - startTime;
    console.log(`[Fundamentals Service] Fetched ${symbol} overview in ${responseTime}ms`);
    
    return overview;
    
  } catch (error: any) {
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError(
      `Failed to fetch company overview for ${symbol}: ${error.message}`,
      { symbol, originalError: error.message }
    );
  }
}

/**
 * Fetch financial metrics (key ratios and margins)
 */
export async function fetchFinancialMetrics(symbol: string): Promise<{
  symbol: string;
  metrics: FinnhubMetrics['metric'];
  timestamp: Date;
}> {
  validateSymbol(symbol);
  const normalized = normalizeSymbol(symbol);
  
  const metricsData = await finnhubRequest<FinnhubMetrics>('/stock/metric', {
    symbol: normalized,
    metric: 'all',
  });
  
  return {
    symbol: normalized,
    metrics: metricsData.metric || {},
    timestamp: new Date(),
  };
}

/**
 * Fetch earnings data (quarterly earnings surprises)
 */
export async function fetchEarnings(symbol: string, limit: number = 8): Promise<ExtendedEarningsData[]> {
  const startTime = Date.now();
  validateSymbol(symbol);
  const normalized = normalizeSymbol(symbol);
  
  try {
    const earnings = await finnhubRequest<FinnhubEarnings[]>('/stock/earnings', {
      symbol: normalized,
    });
    
    if (!earnings || earnings.length === 0) {
      console.log(`[Fundamentals Service] No earnings data found for ${symbol}`);
      return [];
    }
    
    // Sort by year and quarter descending, then limit
    const sortedEarnings = earnings
      .sort((a, b) => {
        if (b.year !== a.year) return b.year - a.year;
        return b.quarter - a.quarter;
      })
      .slice(0, limit);
    
    const earningsData: ExtendedEarningsData[] = sortedEarnings.map(e => ({
      symbol: normalized,
      quarter: `Q${e.quarter}`,
      year: e.year,
      reportDate: new Date(e.period),
      epsEstimate: e.estimate,
      epsActual: e.actual,
      surprise: e.surprise,
      surprisePercent: e.surprisePercent,
      period: e.period,
    }));
    
    const responseTime = Date.now() - startTime;
    console.log(`[Fundamentals Service] Fetched ${earningsData.length} earnings for ${symbol} in ${responseTime}ms`);
    
    return earningsData;
    
  } catch (error: any) {
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError(
      `Failed to fetch earnings for ${symbol}: ${error.message}`,
      { symbol, originalError: error.message }
    );
  }
}

/**
 * Fetch financial statements from SEC filings
 */
export async function fetchFinancialStatements(
  symbol: string,
  period: 'annual' | 'quarterly' = 'annual',
  limit: number = 4
): Promise<FinancialStatement[]> {
  const startTime = Date.now();
  validateSymbol(symbol);
  const normalized = normalizeSymbol(symbol);
  
  try {
    const freq = period === 'annual' ? 'annual' : 'quarterly';
    const reports = await finnhubRequest<FinnhubFinancialReport[]>('/stock/financials-reported', {
      symbol: normalized,
      freq,
    });
    
    // Finnhub returns { data: [...] } or just [...] depending on endpoint
    const reportData = Array.isArray(reports) ? reports : (reports as any).data;
    
    if (!reportData || reportData.length === 0) {
      console.log(`[Fundamentals Service] No financial statements found for ${symbol}`);
      return [];
    }
    
    // Sort by year and quarter descending, then limit
    const sortedReports = reportData
      .sort((a: FinnhubFinancialReport, b: FinnhubFinancialReport) => {
        if (b.year !== a.year) return b.year - a.year;
        if (period === 'quarterly') {
          return (b.quarter || 0) - (a.quarter || 0);
        }
        return 0;
      })
      .slice(0, limit);
    
    const statements: FinancialStatement[] = sortedReports.map((report: FinnhubFinancialReport) => {
      const bs = report.report?.bs || {};
      const ic = report.report?.ic || {};
      const cf = report.report?.cf || {};
      
      // Helper to find value from various key formats
      const findValue = (obj: Record<string, number>, ...keys: string[]): number | undefined => {
        for (const key of keys) {
          const found = Object.entries(obj).find(([k]) => 
            k.toLowerCase().includes(key.toLowerCase())
          );
          if (found && typeof found[1] === 'number') {
            return found[1];
          }
        }
        return undefined;
      };
      
      const revenue = findValue(ic, 'revenue', 'sales', 'netrevenue');
      const netIncome = findValue(ic, 'netincome', 'profit', 'earnings');
      const grossProfit = findValue(ic, 'grossprofit');
      const operatingIncome = findValue(ic, 'operatingincome', 'operatingprofit');
      
      return {
        symbol: normalized,
        fiscalYear: report.year,
        fiscalQuarter: period === 'quarterly' ? report.quarter : undefined,
        period,
        reportDate: new Date(report.endDate || report.filedDate),
        
        // Balance Sheet
        totalAssets: findValue(bs, 'totalassets', 'assets'),
        totalLiabilities: findValue(bs, 'totalliabilities', 'liabilities'),
        totalEquity: findValue(bs, 'totalequity', 'stockholdersequity', 'shareholdersequity'),
        totalDebt: findValue(bs, 'totaldebt', 'longtermdebt'),
        currentAssets: findValue(bs, 'currentassets'),
        currentLiabilities: findValue(bs, 'currentliabilities'),
        cash: findValue(bs, 'cashandcashequivalents', 'cash'),
        
        // Income Statement
        revenue,
        costOfRevenue: findValue(ic, 'costofrevenue', 'costofgoods'),
        grossProfit,
        operatingIncome,
        netIncome,
        ebitda: findValue(ic, 'ebitda'),
        
        // Cash Flow
        operatingCashFlow: findValue(cf, 'operatingcashflow', 'netcashfromoperating'),
        investingCashFlow: findValue(cf, 'investingcashflow', 'netcashfrominvesting'),
        financingCashFlow: findValue(cf, 'financingcashflow', 'netcashfromfinancing'),
        freeCashFlow: findValue(cf, 'freecashflow'),
        
        // Margins (calculated)
        grossMargin: revenue && grossProfit ? (grossProfit / revenue) * 100 : undefined,
        operatingMargin: revenue && operatingIncome ? (operatingIncome / revenue) * 100 : undefined,
        netMargin: revenue && netIncome ? (netIncome / revenue) * 100 : undefined,
        
        timestamp: new Date(),
      };
    });
    
    const responseTime = Date.now() - startTime;
    console.log(`[Fundamentals Service] Fetched ${statements.length} ${period} statements for ${symbol} in ${responseTime}ms`);
    
    return statements;
    
  } catch (error: any) {
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError(
      `Failed to fetch financial statements for ${symbol}: ${error.message}`,
      { symbol, period, originalError: error.message }
    );
  }
}

/**
 * Fetch full fundamentals (overview + earnings + key metrics)
 */
export async function fetchFullFundamentals(symbol: string): Promise<{
  overview: CompanyOverview;
  earnings: ExtendedEarningsData[];
  metrics: {
    profitability: {
      grossMargin?: number;
      operatingMargin?: number;
      netMargin?: number;
      roe?: number;
      roa?: number;
    };
    valuation: {
      peRatio?: number;
      eps?: number;
      dividendYield?: number;
    };
    liquidity: {
      currentRatio?: number;
      quickRatio?: number;
    };
    leverage: {
      debtToEquity?: number;
    };
    growth: {
      epsGrowth3Y?: number;
      epsGrowth5Y?: number;
    };
  };
  timestamp: Date;
}> {
  const startTime = Date.now();
  validateSymbol(symbol);
  const normalized = normalizeSymbol(symbol);
  
  try {
    // Fetch all data in parallel
    const [overview, earnings, metricsResponse] = await Promise.all([
      fetchCompanyOverview(normalized),
      fetchEarnings(normalized, 8),
      fetchFinancialMetrics(normalized),
    ]);
    
    const m = metricsResponse.metrics;
    
    const result = {
      overview,
      earnings,
      metrics: {
        profitability: {
          grossMargin: m.grossMarginTTM || m.grossMarginAnnual,
          operatingMargin: m.operatingMarginTTM || m.operatingMarginAnnual,
          netMargin: m.netProfitMarginTTM || m.netProfitMarginAnnual,
          roe: m.roeTTM,
          roa: m.roaRfy,
        },
        valuation: {
          peRatio: m.peBasicExclExtraTTM || m.peTTM || m.peAnnual,
          eps: m.epsAnnual,
          dividendYield: m.dividendYieldIndicatedAnnual,
        },
        liquidity: {
          currentRatio: m.currentRatioQuarterly || m.currentRatioAnnual,
          quickRatio: m.quickRatioQuarterly || m.quickRatioAnnual,
        },
        leverage: {
          debtToEquity: m.debtEquityQuarterly || m.debtEquityAnnual,
        },
        growth: {
          epsGrowth3Y: m.epsGrowth3Y,
          epsGrowth5Y: m.epsGrowth5Y,
        },
      },
      timestamp: new Date(),
    };
    
    const responseTime = Date.now() - startTime;
    console.log(`[Fundamentals Service] Fetched full fundamentals for ${symbol} in ${responseTime}ms`);
    
    return result;
    
  } catch (error: any) {
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError(
      `Failed to fetch full fundamentals for ${symbol}: ${error.message}`,
      { symbol, originalError: error.message }
    );
  }
}

/**
 * Check if Finnhub API is available
 */
export function isFinnhubConfigured(): boolean {
  return !!apiConfig.finnhub.apiKey;
}

/**
 * List of supported major stocks for testing
 */
export const SUPPORTED_STOCKS = [
  // Tech
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'AMD', 'INTC', 'CRM',
  // Finance
  'JPM', 'BAC', 'GS', 'V', 'MA', 'WFC', 'C', 'AXP', 'BLK', 'MS',
  // Consumer
  'WMT', 'HD', 'DIS', 'NKE', 'SBUX', 'MCD', 'KO', 'PEP', 'COST', 'TGT',
  // Healthcare
  'JNJ', 'UNH', 'PFE', 'ABBV', 'MRK', 'LLY', 'TMO', 'DHR', 'BMY', 'AMGN',
  // Energy
  'XOM', 'CVX', 'COP', 'SLB', 'EOG',
];

/**
 * Check if a symbol is in our supported list
 */
export function isSupportedStock(symbol: string): boolean {
  return SUPPORTED_STOCKS.includes(normalizeSymbol(symbol));
}
