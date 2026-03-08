/**
 * Alpha Vantage Fundamentals Service
 * 
 * Replacement for Finnhub fundamentals service using Alpha Vantage API.
 * Implements smart rate limiting and daily quota management for free tier (25 requests/day).
 * 
 * Features:
 * - Company overview with description
 * - Quarterly earnings data
 * - Financial statements (income, balance sheet, cash flow)
 * - Multi-layer rate limit strategy
 * - Graceful degradation when limits reached
 */

import { APIError } from '../types.js';
import { apiConfig } from '../config.js';
import { getCacheService } from '../cache/index.js';



/**
 * Type definitions matching Finnhub interface
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
    sharesOutstanding?: number;
}

export interface ExtendedEarningsData {
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
    period: string;
}

export interface FinancialStatement {
    symbol: string;
    fiscalYear: number;
    fiscalQuarter?: number;
    period: string;
    reportDate: Date;

    // Balance Sheet
    totalAssets?: number;
    totalLiabilities?: number;
    totalEquity?: number;
    totalDebt?: number;
    shortTermDebt?: number;
    currentAssets?: number;
    currentLiabilities?: number;
    cash?: number;
    sharesOutstanding?: number; // From Balance Sheet
    weightedAverageShares?: number; // From Income Statement (v7 fallback)

    // Income Statement
    revenue?: number;
    costOfRevenue?: number;
    grossProfit?: number;
    operatingIncome?: number;
    netIncome?: number;
    ebitda?: number;
    interestExpense?: number;
    incomeTaxExpense?: number;
    incomeBeforeTax?: number;

    // Cash Flow
    operatingCashFlow?: number;
    investingCashFlow?: number;
    financingCashFlow?: number;
    freeCashFlow?: number;
    capitalExpenditures?: number;
    depreciationAndAmortization?: number;

    // Margins
    grossMargin?: number;
    operatingMargin?: number;
    netMargin?: number;

    timestamp: Date;
}

/**
 * Alpha Vantage API response types
 */
interface AlphaVantageOverview {
    Symbol: string;
    Name: string;
    Description: string;
    Exchange: string;
    Currency: string;
    Country: string;
    Sector: string;
    Industry: string;
    MarketCapitalization: string;
    PERatio: string;
    EPS: string;
    DividendYield: string;
    '52WeekHigh': string;
    '52WeekLow': string;
    Beta: string;
    SharesOutstanding: string;
    Address?: string;
    OfficialSite?: string;
}

interface AlphaVantageEarningsResponse {
    symbol: string;
    annualEarnings?: Array<{
        fiscalDateEnding: string;
        reportedEPS: string;
    }>;
    quarterlyEarnings: Array<{
        fiscalDateEnding: string;
        reportedDate: string;
        reportedEPS: string;
        estimatedEPS: string;
        surprise: string;
        surprisePercentage: string;
    }>;
}

interface AlphaVantageIncomeStatement {
    symbol: string;
    annualReports?: Array<{
        fiscalDateEnding: string;
        totalRevenue: string;
        costOfRevenue: string;
        grossProfit: string;
        operatingIncome: string;
        netIncome: string;
        ebitda: string;
        interestExpense: string;
        incomeTaxExpense: string;
        incomeBeforeTax: string;
        weightedAverageShsOut?: string;
        weightedAverageShsOutDil?: string;
    }>;
    quarterlyReports?: Array<{
        fiscalDateEnding: string;
        totalRevenue: string;
        costOfRevenue: string;
        grossProfit: string;
        operatingIncome: string;
        netIncome: string;
        ebitda: string;
        interestExpense: string;
        incomeTaxExpense: string;
        incomeBeforeTax: string;
        weightedAverageShsOut?: string;
        weightedAverageShsOutDil?: string;
    }>;
}

interface AlphaVantageBalanceSheet {
    symbol: string;
    annualReports?: Array<{
        fiscalDateEnding: string;
        totalAssets: string;
        totalLiabilities: string;
        totalShareholderEquity: string;
        totalCurrentAssets: string;
        totalCurrentLiabilities: string;
        cashAndCashEquivalentsAtCarryingValue: string;
        longTermDebt: string;
        shortTermDebt: string;
        commonStockSharesOutstanding: string;
    }>;
    quarterlyReports?: Array<{
        fiscalDateEnding: string;
        totalAssets: string;
        totalLiabilities: string;
        totalShareholderEquity: string;
        totalCurrentAssets: string;
        totalCurrentLiabilities: string;
        cashAndCashEquivalentsAtCarryingValue: string;
        longTermDebt: string;
        shortTermDebt: string;
        commonStockSharesOutstanding: string;
    }>;
}

interface AlphaVantageCashFlow {
    symbol: string;
    annualReports?: Array<{
        fiscalDateEnding: string;
        operatingCashflow: string;
        cashflowFromInvestment: string;
        cashflowFromFinancing: string;
        capitalExpenditures: string;
        depreciationDepletionAndAmortization: string;
    }>;
    quarterlyReports?: Array<{
        fiscalDateEnding: string;
        operatingCashflow: string;
        cashflowFromInvestment: string;
        cashflowFromFinancing: string;
        capitalExpenditures: string;
        depreciationDepletionAndAmortization: string;
    }>;
}

import { getKeyPool } from './api-key-pool.js';

/**
 * Request timeout for API calls
 */
const REQUEST_TIMEOUT = 10000;  // 10 seconds timeout

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
 * Parse number safely from string
 */
function parseNumber(value: string | number | undefined): number | undefined {
    if (value === undefined || value === null || value === 'None' || value === '') {
        return undefined;
    }
    const num = typeof value === 'string' ? parseFloat(value) : value;
    return isNaN(num) ? undefined : num;
}

/**
 * Make API request to Alpha Vantage with rate limiting and quota management.
 * Uses the key pool for parallel requests across different keys.
 * 
 * RETRY LOGIC: If Alpha Vantage server-side rejects a key (daily limit
 * Information message or rate-limit Note), the key is marked exhausted
 * and the request is retried with the next available key.
 */
async function makeAPICall<T>(
    functionName: string,
    symbol: string,
    additionalParams: Record<string, string> = {}
): Promise<T> {
    const pool = getKeyPool();
    const triedKeys = new Set<string>();

    while (true) {
        // acquireKey() throws DAILY_LIMIT_REACHED if all keys exhausted
        const managedKey = pool.acquireKey();

        // Safety: avoid infinite loop if acquireKey keeps returning same key
        if (triedKeys.has(managedKey.key)) {
            pool.markExhausted(managedKey);
            continue;
        }
        triedKeys.add(managedKey.key);

        try {
            // Use the key's per-key mutex to serialize requests on the SAME key,
            // while allowing concurrent requests on DIFFERENT keys.
            return await managedKey.mutex.dispatch(async () => {
                // Wait for this key's rate limit window
                await pool.waitForRateLimit(managedKey);

                const url = new URL(apiConfig.alphaVantage.baseUrl);
                url.searchParams.append('function', functionName);
                url.searchParams.append('symbol', symbol);
                url.searchParams.append('apikey', managedKey.key);

                for (const [key, value] of Object.entries(additionalParams)) {
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
                        throw new APIError(
                            `Alpha Vantage API error: ${response.status} ${response.statusText}`,
                            { status: response.status, function: functionName }
                        );
                    }

                    const data = await response.json() as Record<string, unknown>;

                    // Check for Alpha Vantage error responses
                    if (data['Error Message']) {
                        throw new APIError(
                            `Alpha Vantage API error: ${data['Error Message']}`,
                            { code: 'ALPHA_VANTAGE_ERROR', response: data }
                        );
                    }

                    // Check for rate limit note (5 calls/min)
                    if (typeof data['Note'] === 'string' && data['Note'].includes('5 calls per minute')) {
                        throw new APIError(
                            'Alpha Vantage rate limit hit (5/min).',
                            { code: 'RATE_LIMIT_HIT', retryAfter: 12000, keyLabel: managedKey.label }
                        );
                    }

                    // Check for daily limit Information message
                    if (typeof data['Information'] === 'string' &&
                        (data['Information'] as string).includes('rate limit')) {
                        throw new APIError(
                            `Alpha Vantage daily limit: ${data['Information']}`,
                            { code: 'KEY_DAILY_LIMIT', keyLabel: managedKey.label, response: data }
                        );
                    }

                    // Check for other information messages (invalid symbol, no data, etc.)
                    if (data['Information']) {
                        throw new APIError(
                            `Alpha Vantage: ${data['Information']}`,
                            { code: 'NO_DATA', response: data }
                        );
                    }

                    // Record successful call on this key
                    pool.recordSuccess(managedKey);

                    return data as T;

                } catch (error: any) {
                    if (error.name === 'AbortError') {
                        throw new APIError(
                            `Request timeout for Alpha Vantage ${functionName}`,
                            { function: functionName, timeout: REQUEST_TIMEOUT }
                        );
                    }

                    if (error instanceof APIError) {
                        throw error;
                    }

                    throw new APIError(
                        `Alpha Vantage request failed: ${error.message}`,
                        { function: functionName, originalError: error.message }
                    );
                }
            });

        } catch (error: any) {
            // RETRY LOGIC: If this key was rejected for rate/daily limits,
            // mark it exhausted and try the next key
            if (error instanceof APIError &&
                (error.details?.code === 'KEY_DAILY_LIMIT' || error.details?.code === 'RATE_LIMIT_HIT')) {
                console.warn(`🔄 [Key Pool] ${managedKey.label} rejected by AV server — trying next key...`);
                pool.markExhausted(managedKey);
                continue; // retry with next key
            }

            // Non-retryable error — propagate
            throw error;
        }
    }
}

/**
 * Calculate fiscal quarter from date string
 */
function calculateQuarter(dateString: string): number {
    const month = parseInt(dateString.substring(5, 7));
    return Math.ceil(month / 3);
}

/**
 * Internal: Fetch company overview from Alpha Vantage API (no caching)
 */
async function _fetchCompanyOverviewFromAPI(symbol: string): Promise<CompanyOverview> {
    const startTime = Date.now();
    const normalized = normalizeSymbol(symbol);

    const response = await makeAPICall<AlphaVantageOverview>('OVERVIEW', normalized);

    // Check if we got valid data
    if (!response.Symbol || !response.Name) {
        throw new APIError(
            `Company not found: ${symbol}`,
            { symbol: normalized, suggestion: 'Ensure the symbol is a valid US stock ticker' }
        );
    }

    const overview: CompanyOverview = {
        symbol: normalized,
        name: response.Name,
        description: response.Description || '',
        sector: response.Sector || 'Unknown',
        industry: response.Industry || 'Unknown',
        marketCap: parseNumber(response.MarketCapitalization) || 0,
        peRatio: parseNumber(response.PERatio),
        eps: parseNumber(response.EPS),
        dividendYield: parseNumber(response.DividendYield),
        week52High: parseNumber(response['52WeekHigh']),
        week52Low: parseNumber(response['52WeekLow']),
        averageVolume: undefined, // Not provided by Alpha Vantage
        beta: parseNumber(response.Beta),
        exchange: response.Exchange,
        currency: response.Currency,
        country: response.Country,
        ipo: undefined, // Not provided
        weburl: response.OfficialSite,
        logo: undefined, // Not provided
        phone: undefined, // Not provided
        timestamp: new Date(),
        sharesOutstanding: parseNumber(response.SharesOutstanding),
    };

    // v7 Debug: Log the raw shares value to diagnose why AAPL/MSFT return undefined
    if (symbol === 'AAPL' || symbol === 'MSFT') {
        console.log(`🔍 [Alpha Vantage] ${symbol} Overview shares raw: "${response.SharesOutstanding}" -> parsed: ${overview.sharesOutstanding}`);
    }

    const responseTime = Date.now() - startTime;
    console.log(`✅ [Alpha Vantage] Fetched ${symbol} overview from API in ${responseTime}ms`);

    return overview;
}

/**
 * Fetch company overview with caching (7-day TTL)
 */
export async function fetchCompanyOverview(symbol: string): Promise<CompanyOverview> {
    validateSymbol(symbol);
    const normalized = normalizeSymbol(symbol);

    try {
        const cache = getCacheService();

        // Try cache first
        const cached = await cache.fundamentals.get(normalized, 'overview');
        if (cached) {
            console.log(`📦 [Cache] Hit for ${symbol} overview (saved API call)`);
            return cached as unknown as CompanyOverview;
        }

        // Cache miss - fetch from API
        console.log(`📦 [Cache] Miss for ${symbol} overview - fetching from API`);
        const overview = await _fetchCompanyOverviewFromAPI(symbol);

        // Store in cache with 7-day TTL
        await cache.fundamentals.set(normalized, 'overview', overview as any);
        console.log(`📦 [Cache] Stored ${symbol} overview (TTL: 7 days)`);

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
 * Internal: Fetch earnings data from Alpha Vantage API (no caching)
 */
async function _fetchEarningsFromAPI(symbol: string, limit: number): Promise<ExtendedEarningsData[]> {
    const startTime = Date.now();
    const normalized = normalizeSymbol(symbol);

    const response = await makeAPICall<AlphaVantageEarningsResponse>('EARNINGS', normalized);

    if (!response.quarterlyEarnings || response.quarterlyEarnings.length === 0) {
        console.log(`[Alpha Vantage] No earnings data found for ${symbol}`);
        return [];
    }

    // Sort by date descending and limit
    const earnings = response.quarterlyEarnings
        .slice(0, limit)
        .map(e => {
            const fiscalYear = parseInt(e.fiscalDateEnding.substring(0, 4));
            const fiscalQuarter = calculateQuarter(e.fiscalDateEnding);

            return {
                symbol: normalized,
                quarter: `Q${fiscalQuarter}`,
                year: fiscalYear,
                reportDate: new Date(e.reportedDate),
                epsEstimate: parseNumber(e.estimatedEPS),
                epsActual: parseNumber(e.reportedEPS),
                revenueEstimate: undefined, // Not provided by Alpha Vantage
                revenueActual: undefined, // Not provided by Alpha Vantage
                surprise: parseNumber(e.surprise),
                surprisePercent: parseNumber(e.surprisePercentage),
                period: e.fiscalDateEnding,
            };
        });

    const responseTime = Date.now() - startTime;
    console.log(`✅ [Alpha Vantage] Fetched ${earnings.length} earnings from API in ${responseTime}ms`);

    return earnings;
}

/**
 * Fetch earnings data with caching (7-day TTL)
 */
export async function fetchEarnings(symbol: string, limit: number = 8): Promise<ExtendedEarningsData[]> {
    validateSymbol(symbol);
    const normalized = normalizeSymbol(symbol);
    const dataType = `earnings:${limit}`;

    try {
        const cache = getCacheService();

        // Try cache first
        const cached = await cache.fundamentals.get(normalized, dataType);
        if (cached) {
            console.log(`📦 [Cache] Hit for ${symbol} earnings (saved API call)`);
            return cached as unknown as ExtendedEarningsData[];
        }

        // Cache miss - fetch from API
        console.log(`📦 [Cache] Miss for ${symbol} earnings - fetching from API`);
        const earnings = await _fetchEarningsFromAPI(symbol, limit);

        // Store in cache with 7-day TTL
        await cache.fundamentals.set(normalized, dataType, earnings as any);
        console.log(`📦 [Cache] Stored ${symbol} earnings (TTL: 7 days)`);

        return earnings;

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
 * Internal: Fetch financial statements from Alpha Vantage API (no caching)
 * Note: This requires 3 API calls
 */
async function _fetchFinancialStatementsFromAPI(
    symbol: string,
    period: 'annual' | 'quarterly',
    limit: number
): Promise<FinancialStatement[]> {
    const startTime = Date.now();
    const normalized = normalizeSymbol(symbol);

    console.log(`📊 [Alpha Vantage] Fetching ${period} financials from API for ${symbol} (3 API calls)...`);

    // Fetch all three statements SEQUENTIALLY (Alpha Vantage requires 1 request/second for free tier)
    const incomeResponse = await makeAPICall<AlphaVantageIncomeStatement>('INCOME_STATEMENT', normalized);
    const balanceResponse = await makeAPICall<AlphaVantageBalanceSheet>('BALANCE_SHEET', normalized);
    const cashFlowResponse = await makeAPICall<AlphaVantageCashFlow>('CASH_FLOW', normalized);

    // Get the appropriate reports based on period
    const incomeReports = period === 'annual'
        ? incomeResponse.annualReports || []
        : incomeResponse.quarterlyReports || [];

    const balanceReports = period === 'annual'
        ? balanceResponse.annualReports || []
        : balanceResponse.quarterlyReports || [];

    const cashFlowReports = period === 'annual'
        ? cashFlowResponse.annualReports || []
        : cashFlowResponse.quarterlyReports || [];

    if (incomeReports.length === 0) {
        console.log(`[Alpha Vantage] No ${period} financial statements found for ${symbol}`);
        return [];
    }

    // Merge statements by fiscal date
    const statements: FinancialStatement[] = [];

    for (let i = 0; i < Math.min(limit, incomeReports.length); i++) {
        const income = incomeReports[i];
        const balance = balanceReports.find(b => b.fiscalDateEnding === income.fiscalDateEnding);
        const cashFlow = cashFlowReports.find(c => c.fiscalDateEnding === income.fiscalDateEnding);

        const fiscalYear = parseInt(income.fiscalDateEnding.substring(0, 4));
        const fiscalQuarter = period === 'quarterly' ? calculateQuarter(income.fiscalDateEnding) : undefined;

        const revenue = parseNumber(income.totalRevenue);
        const grossProfit = parseNumber(income.grossProfit);
        const operatingIncome = parseNumber(income.operatingIncome);
        const netIncome = parseNumber(income.netIncome);

        const opCF = cashFlow ? parseNumber(cashFlow.operatingCashflow) : undefined;
        const capEx = cashFlow ? parseNumber(cashFlow.capitalExpenditures) : undefined;
        // FCF = Operating Cash Flow - |CapEx| (CapEx is often reported negative)
        const fcf = (opCF !== undefined && capEx !== undefined)
            ? opCF - Math.abs(capEx)
            : undefined;

        const longTermDebt = balance ? parseNumber(balance.longTermDebt) : undefined;
        const shortTermDebt = balance ? parseNumber(balance.shortTermDebt) : undefined;

        statements.push({
            symbol: normalized,
            fiscalYear,
            fiscalQuarter,
            period,
            reportDate: new Date(income.fiscalDateEnding),

            // Balance Sheet
            totalAssets: balance ? parseNumber(balance.totalAssets) : undefined,
            totalLiabilities: balance ? parseNumber(balance.totalLiabilities) : undefined,
            totalEquity: balance ? parseNumber(balance.totalShareholderEquity) : undefined,
            totalDebt: longTermDebt,
            shortTermDebt,
            currentAssets: balance ? parseNumber(balance.totalCurrentAssets) : undefined,
            currentLiabilities: balance ? parseNumber(balance.totalCurrentLiabilities) : undefined,
            cash: balance ? parseNumber(balance.cashAndCashEquivalentsAtCarryingValue) : undefined,
            sharesOutstanding: balance ? parseNumber(balance.commonStockSharesOutstanding) : undefined,

            // v7: Weighted average shares from income statement as fallback
            weightedAverageShares: income ? parseNumber(income.weightedAverageShsOut) : undefined,

            // Income Statement
            revenue,
            costOfRevenue: parseNumber(income.costOfRevenue),
            grossProfit,
            operatingIncome,
            netIncome,
            ebitda: parseNumber(income.ebitda),
            interestExpense: parseNumber(income.interestExpense),
            incomeTaxExpense: parseNumber(income.incomeTaxExpense),
            incomeBeforeTax: parseNumber(income.incomeBeforeTax),

            // Cash Flow
            operatingCashFlow: opCF,
            investingCashFlow: cashFlow ? parseNumber(cashFlow.cashflowFromInvestment) : undefined,
            financingCashFlow: cashFlow ? parseNumber(cashFlow.cashflowFromFinancing) : undefined,
            freeCashFlow: fcf,
            capitalExpenditures: capEx,
            depreciationAndAmortization: cashFlow ? parseNumber(cashFlow.depreciationDepletionAndAmortization) : undefined,

            // Margins (calculated)
            grossMargin: revenue && grossProfit ? (grossProfit / revenue) * 100 : undefined,
            operatingMargin: revenue && operatingIncome ? (operatingIncome / revenue) * 100 : undefined,
            netMargin: revenue && netIncome ? (netIncome / revenue) * 100 : undefined,

            timestamp: new Date(),
        });
    }

    const responseTime = Date.now() - startTime;
    console.log(`✅ [Alpha Vantage] Fetched ${statements.length} ${period} statements from API in ${responseTime}ms`);

    return statements;
}

/**
 * Fetch financial statements with caching (7-day TTL)
 * Note: Uses 3 API calls on cache miss - caching is especially valuable here!
 */
export async function fetchFinancialStatements(
    symbol: string,
    period: 'annual' | 'quarterly' = 'annual',
    limit: number = 4
): Promise<FinancialStatement[]> {
    validateSymbol(symbol);
    const normalized = normalizeSymbol(symbol);
    const dataType = `statements:${period}:${limit}`;

    try {
        const cache = getCacheService();

        // Try cache first - especially important for financial statements (3 API calls!)
        const cached = await cache.fundamentals.get(normalized, dataType);
        if (cached) {
            console.log(`📦 [Cache] Hit for ${symbol} ${period} statements (saved 3 API calls!)`);
            return cached as unknown as FinancialStatement[];
        }

        // Cache miss - fetch from API
        console.log(`📦 [Cache] Miss for ${symbol} ${period} statements - fetching from API`);
        const statements = await _fetchFinancialStatementsFromAPI(symbol, period, limit);

        // Store in cache with 7-day TTL
        await cache.fundamentals.set(normalized, dataType, statements as any);
        console.log(`📦 [Cache] Stored ${symbol} ${period} statements (TTL: 7 days)`);

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
 * Fetch full fundamentals (overview + earnings)
 * Note: Financial statements excluded by default due to 3 API calls
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
        // Fetch overview and earnings in parallel (2 API calls)
        const [overview, earnings] = await Promise.all([
            fetchCompanyOverview(normalized),
            fetchEarnings(normalized, 8),
        ]);

        // Build metrics from overview data
        const metrics = {
            profitability: {
                grossMargin: undefined,
                operatingMargin: undefined,
                netMargin: undefined,
                roe: undefined,
                roa: undefined,
            },
            valuation: {
                peRatio: overview.peRatio,
                eps: overview.eps,
                dividendYield: overview.dividendYield,
            },
            liquidity: {
                currentRatio: undefined,
                quickRatio: undefined,
            },
            leverage: {
                debtToEquity: undefined,
            },
            growth: {
                epsGrowth3Y: undefined,
                epsGrowth5Y: undefined,
            },
        };

        const result = {
            overview,
            earnings,
            metrics,
            timestamp: new Date(),
        };

        // v7 Debug: Log if shares missing from Overview
        if (!result.overview.sharesOutstanding && (symbol === 'AAPL' || symbol === 'MSFT')) {
            console.log(`⚠️ [Alpha Vantage] ${symbol} Overview shares missing. Raw: "${overview.sharesOutstanding}"`);
        }

        const responseTime = Date.now() - startTime;
        console.log(`✅ [Alpha Vantage] Fetched full fundamentals for ${symbol} in ${responseTime}ms`);

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
 * Fetch 10-year Treasury yield (risk-free rate for WACC/CAPM)
 * Note: TREASURY_YIELD does not use a stock symbol parameter
 */
export async function fetchTreasuryYield(): Promise<number> {
    const cacheKey = 'treasury_yield_10y';

    try {
        const cache = getCacheService();

        // Try cache first (1-day TTL for treasury yields)
        const cached = await cache.fundamentals.get(cacheKey, 'treasury');
        if (cached && typeof cached === 'object' && 'value' in (cached as any)) {
            console.log(`📦 [Cache] Hit for treasury yield`);
            return (cached as any).value;
        }

        // Use key pool for the API call
        const pool = getKeyPool();
        const managedKey = pool.acquireKey();

        return await managedKey.mutex.dispatch(async () => {
            await pool.waitForRateLimit(managedKey);

            const url = new URL(apiConfig.alphaVantage.baseUrl);
            url.searchParams.append('function', 'TREASURY_YIELD');
            url.searchParams.append('interval', 'monthly');
            url.searchParams.append('maturity', '10year');
            url.searchParams.append('apikey', managedKey.key);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new APIError(`Treasury yield API error: ${response.status}`, { status: response.status });
            }

            const data = await response.json() as any;
            pool.recordSuccess(managedKey);

            // Extract most recent yield value
            if (!data.data || data.data.length === 0) {
                console.warn('⚠️ No treasury yield data available, using default 4.25%');
                return 0.0425;
            }

            const yieldValue = parseFloat(data.data[0].value);
            if (isNaN(yieldValue)) {
                console.warn('⚠️ Invalid treasury yield value, using default 4.25%');
                return 0.0425;
            }

            const riskFreeRate = yieldValue / 100; // Convert from percentage

            // Cache result
            await cache.fundamentals.set(cacheKey, 'treasury', { value: riskFreeRate } as any);
            console.log(`📦 [Cache] Stored treasury yield: ${(riskFreeRate * 100).toFixed(2)}%`);

            return riskFreeRate;
        });

    } catch (error: any) {
        if (error instanceof APIError) throw error;
        console.warn(`⚠️ Failed to fetch treasury yield: ${error.message}. Using default 4.25%`);
        return 0.0425; // Sensible fallback
    }
}

/**
 * Fetch annual earnings (EPS) history for DCF analysis
 * Uses the EARNINGS endpoint's annualEarnings array
 */
export async function fetchAnnualEarnings(symbol: string, limit: number = 10): Promise<Array<{
    fiscalDateEnding: string;
    reportedEPS: number;
}>> {
    validateSymbol(symbol);
    const normalized = normalizeSymbol(symbol);
    const dataType = `annual_earnings:${limit}`;

    try {
        const cache = getCacheService();

        // Try cache first
        const cached = await cache.fundamentals.get(normalized, dataType);
        if (cached) {
            console.log(`📦 [Cache] Hit for ${symbol} annual earnings`);
            return cached as any;
        }

        const response = await makeAPICall<AlphaVantageEarningsResponse>('EARNINGS', normalized);

        if (!response.annualEarnings || response.annualEarnings.length === 0) {
            console.log(`[Alpha Vantage] No annual earnings data found for ${symbol}`);
            return [];
        }

        const earnings = response.annualEarnings
            .slice(0, limit)
            .filter(e => e.reportedEPS && e.reportedEPS !== 'None')
            .map(e => ({
                fiscalDateEnding: e.fiscalDateEnding,
                reportedEPS: parseFloat(e.reportedEPS),
            }))
            .filter(e => !isNaN(e.reportedEPS));

        // Cache result
        await cache.fundamentals.set(normalized, dataType, earnings as any);
        console.log(`📦 [Cache] Stored ${symbol} annual earnings (${earnings.length} years)`);

        return earnings;

    } catch (error: any) {
        if (error instanceof APIError) throw error;
        throw new APIError(
            `Failed to fetch annual earnings for ${symbol}: ${error.message}`,
            { symbol, originalError: error.message }
        );
    }
}

/**
 * Check if Alpha Vantage API is configured
 */
export function isAlphaVantageConfigured(): boolean {
    return getKeyPool().hasKeys();
}

/**
 * Get daily usage statistics (pool-aware)
 */
export function getDailyUsageStats(): {
    used: number;
    limit: number | string;
    remaining: number | string;
    resetTime: Date;
} {
    const stats = getKeyPool().getPoolStats();
    const totalLimit = stats.totalDailyLimit;
    return {
        used: stats.totalDailyUsed,
        limit: totalLimit,
        remaining: typeof totalLimit === 'number' ? totalLimit - stats.totalDailyUsed : 'unlimited',
        resetTime: new Date(new Date().setHours(24, 0, 0, 0)),
    };
}

/**
 * List of supported major stocks (same as Finnhub)
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
