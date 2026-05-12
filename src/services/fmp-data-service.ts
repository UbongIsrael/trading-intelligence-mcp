/**
 * Financial Modeling Prep (FMP) Data Service
 *
 * Primary data source for DCF analysis. Replaces Alpha Vantage for all
 * DCF-related data fetching. Alpha Vantage remains for non-DCF tools.
 *
 * FMP provides:
 * - SEC EDGAR-sourced financial statements (audited, standardized)
 * - Revenue geographic segments (for GDP ceiling resolution)
 * - Industry peers (for beta pipeline)
 * - Analyst estimates (for forward growth)
 * - Pre-computed enterprise value, net debt, key metrics
 */

import { APIError } from '../types.js';
import { apiConfig } from '../config.js';
import { getCacheService } from '../cache/index.js';
import type {
    FMPIncomeStatement,
    FMPBalanceSheet,
    FMPCashFlowStatement,
    FMPProfile,
    FMPEnterpriseValue,
    FMPKeyMetrics,
    FMPRevenueSegment,
    FMPAnalystEstimate,
    FMPPeersResponse,
    ParsedRevenueSegment,
    DCFDataBundle,
} from './fmp-types.js';

// Re-export types for consumer convenience
export type {
    FMPIncomeStatement,
    FMPBalanceSheet,
    FMPCashFlowStatement,
    FMPProfile,
    FMPEnterpriseValue,
    FMPKeyMetrics,
    FMPAnalystEstimate,
    ParsedRevenueSegment,
    DCFDataBundle,
};

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const REQUEST_TIMEOUT = 15000; // 15 seconds — FMP is generally fast

/**
 * GDP growth rate fallbacks by country ISO code.
 * Used when FMP macro endpoint is unavailable or country not found.
 * Source: IMF World Economic Outlook, long-run estimates.
 */
export const GDP_FALLBACKS: Record<string, number> = {
    'US': 0.023,
    'GB': 0.018,
    'DE': 0.015,
    'FR': 0.016,
    'JP': 0.010,
    'CN': 0.050,
    'IN': 0.065,
    'CA': 0.020,
    'AU': 0.025,
    'KR': 0.025,
    'BR': 0.025,
    'MX': 0.022,
    'WORLD': 0.030, // IMF world average — default fallback
};

// ─────────────────────────────────────────────────────────
// Core HTTP Client
// ─────────────────────────────────────────────────────────

/**
 * Get the FMP API key from config. Throws if not configured.
 */
function getFMPApiKey(): string {
    const key = apiConfig.fmp.apiKey;
    if (!key) {
        throw new APIError(
            'FMP API key not configured. Set FMP_API_KEY environment variable.',
            {
                code: 'MISSING_FMP_KEY',
                suggestion: 'Get an API key at https://site.financialmodelingprep.com/developer/docs',
            }
        );
    }
    return key;
}

/**
 * Normalize stock symbol to uppercase, trimmed.
 */
function normalize(symbol: string): string {
    return symbol.toUpperCase().trim();
}

/**
 * Make a GET request to the FMP API.
 * Handles timeout, error responses, and API key injection.
 */
async function fmpRequest<T>(
    path: string,
    params: Record<string, string> = {},
): Promise<T> {
    const apiKey = getFMPApiKey();
    const baseUrl = apiConfig.fmp.baseUrl;
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.append('apikey', apiKey);

    for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new APIError(
                    'FMP API key is invalid, expired, or this endpoint requires a higher plan.',
                    { status: response.status, path }
                );
            }
            if (response.status === 429) {
                throw new APIError(
                    'FMP rate limit exceeded. Please wait and try again.',
                    { status: 429, path }
                );
            }
            throw new APIError(
                `FMP API error: ${response.status} ${response.statusText}`,
                { status: response.status, path }
            );
        }

        const data = await response.json() as T;

        // FMP returns empty array for invalid symbols — check for that
        if (Array.isArray(data) && data.length === 0) {
            throw new APIError(
                `No data found for the given request. Check the symbol or endpoint.`,
                { code: 'FMP_NO_DATA', path }
            );
        }

        return data;

    } catch (error: any) {
        if (error.name === 'AbortError') {
            throw new APIError(
                `FMP request timeout for ${path}`,
                { path, timeout: REQUEST_TIMEOUT }
            );
        }
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError(
            `FMP request failed: ${error.message}`,
            { path, originalError: error.message }
        );
    }
}

// ─────────────────────────────────────────────────────────
// Financial Statements
// ─────────────────────────────────────────────────────────

/**
 * Fetch income statements from FMP.
 * P1.3 — Maps all fields needed for FCFF calculation.
 */
export async function fetchFMPIncomeStatement(
    symbol: string,
    period: 'annual' | 'quarterly' = 'annual',
    limit: number = 5,
): Promise<FMPIncomeStatement[]> {
    const sym = normalize(symbol);
    const cacheKey = `fmp:income:${period}:${limit}`;

    try {
        const cache = getCacheService();
        const cached = await cache.fundamentals.get(sym, cacheKey);
        if (cached) {
            console.log(`📦 [FMP Cache] Hit: ${sym} income statement`);
            return cached as unknown as FMPIncomeStatement[];
        }
    } catch { /* cache miss — continue */ }

    console.log(`📊 [FMP] Fetching ${period} income statement for ${sym}...`);
    const data = await fmpRequest<FMPIncomeStatement[]>(
        `/income-statement`,
        { symbol: sym, period, limit: String(limit) },
    );

    try {
        const cache = getCacheService();
        await cache.fundamentals.set(sym, cacheKey, data as any);
    } catch { /* cache write failure is non-fatal */ }

    return data;
}

/**
 * Fetch balance sheet statements from FMP.
 * P1.4 — Provides netDebt, totalDebt, working capital components, preferredStock.
 */
export async function fetchFMPBalanceSheet(
    symbol: string,
    period: 'annual' | 'quarterly' = 'annual',
    limit: number = 5,
): Promise<FMPBalanceSheet[]> {
    const sym = normalize(symbol);
    const cacheKey = `fmp:balance:${period}:${limit}`;

    try {
        const cache = getCacheService();
        const cached = await cache.fundamentals.get(sym, cacheKey);
        if (cached) {
            console.log(`📦 [FMP Cache] Hit: ${sym} balance sheet`);
            return cached as unknown as FMPBalanceSheet[];
        }
    } catch { /* cache miss */ }

    console.log(`📊 [FMP] Fetching ${period} balance sheet for ${sym}...`);
    const data = await fmpRequest<FMPBalanceSheet[]>(
        `/balance-sheet-statement`,
        { symbol: sym, period, limit: String(limit) },
    );

    try {
        const cache = getCacheService();
        await cache.fundamentals.set(sym, cacheKey, data as any);
    } catch { /* non-fatal */ }

    return data;
}

/**
 * Fetch cash flow statements from FMP.
 * P1.5 — Note: capitalExpenditure is POSITIVE (unlike Alpha Vantage).
 */
export async function fetchFMPCashFlowStatement(
    symbol: string,
    period: 'annual' | 'quarterly' = 'annual',
    limit: number = 5,
): Promise<FMPCashFlowStatement[]> {
    const sym = normalize(symbol);
    const cacheKey = `fmp:cashflow:${period}:${limit}`;

    try {
        const cache = getCacheService();
        const cached = await cache.fundamentals.get(sym, cacheKey);
        if (cached) {
            console.log(`📦 [FMP Cache] Hit: ${sym} cash flow`);
            return cached as unknown as FMPCashFlowStatement[];
        }
    } catch { /* cache miss */ }

    console.log(`📊 [FMP] Fetching ${period} cash flow for ${sym}...`);
    const data = await fmpRequest<FMPCashFlowStatement[]>(
        `/cash-flow-statement`,
        { symbol: sym, period, limit: String(limit) },
    );

    try {
        const cache = getCacheService();
        await cache.fundamentals.set(sym, cacheKey, data as any);
    } catch { /* non-fatal */ }

    return data;
}

// ─────────────────────────────────────────────────────────
// Company Profile & Enterprise Value
// ─────────────────────────────────────────────────────────

/**
 * Fetch company profile from FMP.
 * P1.6 — Provides beta, sector, country, marketCap, price.
 */
export async function fetchFMPProfile(symbol: string): Promise<FMPProfile> {
    const sym = normalize(symbol);
    const cacheKey = `fmp:profile`;

    try {
        const cache = getCacheService();
        const cached = await cache.fundamentals.get(sym, cacheKey);
        if (cached) {
            console.log(`📦 [FMP Cache] Hit: ${sym} profile`);
            return cached as unknown as FMPProfile;
        }
    } catch { /* cache miss */ }

    console.log(`📊 [FMP] Fetching profile for ${sym}...`);
    const data = await fmpRequest<FMPProfile[]>(`/profile`, { symbol: sym });

    if (!data[0] || !data[0].companyName) {
        throw new APIError(
            `Company not found: ${symbol}`,
            { symbol: sym, code: 'COMPANY_NOT_FOUND' }
        );
    }

    const profile = data[0];

    try {
        const cache = getCacheService();
        await cache.fundamentals.set(sym, cacheKey, profile as any);
    } catch { /* non-fatal */ }

    return profile;
}

/**
 * Fetch enterprise value history from FMP.
 * P1.7 — Provides EV, numberOfShares, market cap, net debt components.
 */
export async function fetchFMPEnterpriseValue(
    symbol: string,
    limit: number = 3,
): Promise<FMPEnterpriseValue[]> {
    const sym = normalize(symbol);
    const cacheKey = `fmp:ev:${limit}`;

    try {
        const cache = getCacheService();
        const cached = await cache.fundamentals.get(sym, cacheKey);
        if (cached) {
            console.log(`📦 [FMP Cache] Hit: ${sym} enterprise value`);
            return cached as unknown as FMPEnterpriseValue[];
        }
    } catch { /* cache miss */ }

    console.log(`📊 [FMP] Fetching enterprise value for ${sym}...`);
    const data = await fmpRequest<FMPEnterpriseValue[]>(
        `/enterprise-values`,
        { symbol: sym, period: 'annual', limit: String(limit) },
    );

    try {
        const cache = getCacheService();
        await cache.fundamentals.set(sym, cacheKey, data as any);
    } catch { /* non-fatal */ }

    return data;
}

/**
 * Fetch key metrics from FMP.
 * P1.8 — Provides D/E, CapEx ratios, EV/EBITDA, etc.
 */
export async function fetchFMPKeyMetrics(
    symbol: string,
    period: 'annual' | 'quarterly' = 'annual',
    limit: number = 3,
): Promise<FMPKeyMetrics[]> {
    const sym = normalize(symbol);
    const cacheKey = `fmp:metrics:${period}:${limit}`;

    try {
        const cache = getCacheService();
        const cached = await cache.fundamentals.get(sym, cacheKey);
        if (cached) {
            console.log(`📦 [FMP Cache] Hit: ${sym} key metrics`);
            return cached as unknown as FMPKeyMetrics[];
        }
    } catch { /* cache miss */ }

    console.log(`📊 [FMP] Fetching key metrics for ${sym}...`);
    const data = await fmpRequest<FMPKeyMetrics[]>(
        `/key-metrics`,
        { symbol: sym, period, limit: String(limit) },
    );

    try {
        const cache = getCacheService();
        await cache.fundamentals.set(sym, cacheKey, data as any);
    } catch { /* non-fatal */ }

    return data;
}

// ─────────────────────────────────────────────────────────
// Revenue Segments & GDP
// ─────────────────────────────────────────────────────────

/**
 * Fetch revenue geographic segments from FMP.
 * P1.9 — Required for terminal growth rate GDP guard.
 * Returns empty array (no throw) if data unavailable.
 */
export async function fetchFMPRevenueSegments(
    symbol: string,
): Promise<ParsedRevenueSegment[]> {
    const sym = normalize(symbol);
    const cacheKey = `fmp:geo_segments`;

    try {
        const cache = getCacheService();
        const cached = await cache.fundamentals.get(sym, cacheKey);
        if (cached) {
            console.log(`📦 [FMP Cache] Hit: ${sym} revenue segments`);
            return cached as unknown as ParsedRevenueSegment[];
        }
    } catch { /* cache miss */ }

    try {
        console.log(`📊 [FMP] Fetching revenue segments for ${sym}...`);
        const data = await fmpRequest<FMPRevenueSegment[]>(
            `/revenue-geographic-segmentation`,
            { symbol: sym },
        );

        if (!data || data.length === 0) {
            console.log(`📊 [FMP] No revenue segment data for ${sym}`);
            return [];
        }

        // Take the most recent entry
        const latest = data[0];

        // Sum all segments for total revenue
        let totalRevenue = 0;
        const rawSegments: Array<{ segment: string; revenue: number }> = [];

        if (latest.data) {
            for (const [segment, revenue] of Object.entries(latest.data)) {
                if (typeof revenue === 'number') {
                    rawSegments.push({ segment, revenue });
                    totalRevenue += revenue;
                }
            }
        }

        if (totalRevenue <= 0) return [];

        const parsed: ParsedRevenueSegment[] = rawSegments.map(s => ({
            segment: s.segment,
            revenue: s.revenue,
            share: s.revenue / totalRevenue,
        }));

        try {
            const cache = getCacheService();
            await cache.fundamentals.set(sym, cacheKey, parsed as any);
        } catch { /* non-fatal */ }

        return parsed;

    } catch (error: any) {
        // Revenue segments are optional — graceful degradation
        console.warn(`⚠️ [FMP] Revenue segments unavailable for ${sym}: ${error.message}`);
        return [];
    }
}

/**
 * Resolve GDP growth rate for a country.
 * P1.10 — Uses hardcoded fallback table. FMP's macro endpoints vary by plan.
 */
export function resolveGDPGrowthRate(countryCode: string): number {
    const code = countryCode.toUpperCase().trim();
    const rate = GDP_FALLBACKS[code];
    if (rate !== undefined) {
        console.log(`📊 [GDP] Resolved ${code} GDP growth: ${(rate * 100).toFixed(1)}%`);
        return rate;
    }
    console.log(`📊 [GDP] No data for ${code}, using world average: 3.0%`);
    return GDP_FALLBACKS['WORLD'];
}

// ─────────────────────────────────────────────────────────
// Industry Peers & Analyst Estimates
// ─────────────────────────────────────────────────────────

/**
 * Fetch industry peers from FMP.
 * P1.11 — Used by beta pipeline (Phase 3).
 */
export async function fetchFMPIndustryPeers(symbol: string): Promise<string[]> {
    const sym = normalize(symbol);
    const cacheKey = `fmp:peers`;

    try {
        const cache = getCacheService();
        const cached = await cache.fundamentals.get(sym, cacheKey);
        if (cached) {
            console.log(`📦 [FMP Cache] Hit: ${sym} peers`);
            return cached as unknown as string[];
        }
    } catch { /* cache miss */ }

    try {
        console.log(`📊 [FMP] Fetching industry peers for ${sym}...`);
        const data = await fmpRequest<FMPPeersResponse[]>(
            `/stock-peers`,
            { symbol: sym },
        );

        const peers = data?.map(p => p.symbol) ?? [];

        try {
            const cache = getCacheService();
            await cache.fundamentals.set(sym, cacheKey, peers as any);
        } catch { /* non-fatal */ }

        return peers;

    } catch (error: any) {
        console.warn(`⚠️ [FMP] Peers unavailable for ${sym}: ${error.message}`);
        return [];
    }
}

/**
 * Fetch analyst estimates from FMP.
 * P1.12 — Forward EPS and revenue estimates for growth rate selection.
 */
export async function fetchFMPAnalystEstimates(
    symbol: string,
    limit: number = 2,
): Promise<FMPAnalystEstimate[]> {
    const sym = normalize(symbol);
    const cacheKey = `fmp:estimates:${limit}`;

    try {
        const cache = getCacheService();
        const cached = await cache.fundamentals.get(sym, cacheKey);
        if (cached) {
            console.log(`📦 [FMP Cache] Hit: ${sym} analyst estimates`);
            return cached as unknown as FMPAnalystEstimate[];
        }
    } catch { /* cache miss */ }

    try {
        console.log(`📊 [FMP] Fetching analyst estimates for ${sym}...`);
        const data = await fmpRequest<FMPAnalystEstimate[]>(
            `/analyst-estimates`,
            { symbol: sym, period: 'annual', limit: String(limit) },
        );

        try {
            const cache = getCacheService();
            await cache.fundamentals.set(sym, cacheKey, data as any);
        } catch { /* non-fatal */ }

        return data;

    } catch (error: any) {
        console.warn(`⚠️ [FMP] Analyst estimates unavailable for ${sym}: ${error.message}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────────
// DCF Data Bundle — Master Fetch
// ─────────────────────────────────────────────────────────

/**
 * Fetch all data required for a full DCF analysis in parallel.
 * P1.13 — Single entry point; each sub-fetch is independently cached.
 *
 * Required: profile, income, balance, cashflow
 * Optional (graceful degradation): EV, estimates, segments, peers
 */
export async function fetchDCFDataBundle(symbol: string): Promise<DCFDataBundle> {
    const sym = normalize(symbol);
    console.log(`\n📈 [FMP] Fetching DCF data bundle for ${sym}...`);
    const startTime = Date.now();

    // Fire all requests in parallel — each has its own caching
    const [
        profile,
        incomeStatements,
        balanceSheets,
        cashFlowStatements,
        enterpriseValues,
        analystEstimates,
        revenueSegments,
        peers,
    ] = await Promise.all([
        fetchFMPProfile(sym),
        fetchFMPIncomeStatement(sym, 'annual', 5),
        fetchFMPBalanceSheet(sym, 'annual', 5),
        fetchFMPCashFlowStatement(sym, 'annual', 5),
        fetchFMPEnterpriseValue(sym, 3).catch(() => [] as FMPEnterpriseValue[]),
        fetchFMPAnalystEstimates(sym, 2).catch(() => [] as FMPAnalystEstimate[]),
        fetchFMPRevenueSegments(sym).catch(() => [] as ParsedRevenueSegment[]),
        fetchFMPIndustryPeers(sym).catch(() => [] as string[]),
    ]);

    // Validate minimum required data
    if (incomeStatements.length < 3) {
        throw new APIError(
            `Insufficient historical data for DCF analysis of ${sym}. Need at least 3 years of income statements, got ${incomeStatements.length}.`,
            { symbol: sym, yearsAvailable: incomeStatements.length }
        );
    }

    const elapsed = Date.now() - startTime;
    console.log(`✅ [FMP] DCF data bundle for ${sym} fetched in ${elapsed}ms`);
    console.log(`   Income: ${incomeStatements.length}yr | Balance: ${balanceSheets.length}yr | CF: ${cashFlowStatements.length}yr`);
    console.log(`   EV: ${enterpriseValues.length} | Estimates: ${analystEstimates.length} | Segments: ${revenueSegments.length} | Peers: ${peers.length}`);

    return {
        profile,
        incomeStatements,
        balanceSheets,
        cashFlowStatements,
        enterpriseValues,
        analystEstimates,
        revenueSegments,
        peers,
        fetchedAt: new Date(),
    };
}
