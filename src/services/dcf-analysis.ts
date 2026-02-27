// DCF v4 — Simplified revenue-anchored model
// v3 features (recency weighting, dual terminal, buyback yield, composite growth,
// capex decomposition, sanity gates, sensitivity analysis) removed for reliability.
// Restore as v5 enhancements once base model is validated.

import {
    fetchCompanyOverview,
    fetchFinancialStatements,
    fetchEarnings,
    type CompanyOverview,
    type FinancialStatement,
} from './fundamentals-alphavantage.js';
import { getPrice } from './prices.js';
import { APIError } from '../types.js';

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const RISK_FREE_RATE = 0.0425;       // 10-year Treasury, update quarterly
const EQUITY_RISK_PREMIUM = 0.055;   // Damodaran 2026 estimate
const TAX_RATE = 0.21;               // US corporate rate
const TERMINAL_GROWTH_RATE = 0.025;  // Long-run GDP growth
const PROJECTION_YEARS = 10;
const PHASE_1_YEARS = 5;

const SECTOR_DEFAULTS: Record<string, { beta: number; debtRatio: number; terminalPE: number }> = {
    'TECHNOLOGY': { beta: 1.2, debtRatio: 0.15, terminalPE: 20 },
    'HEALTH CARE': { beta: 1.0, debtRatio: 0.20, terminalPE: 18 },
    'FINANCIALS': { beta: 1.1, debtRatio: 0.60, terminalPE: 12 },
    'CONSUMER DISCRETIONARY': { beta: 1.0, debtRatio: 0.25, terminalPE: 16 },
    'CONSUMER STAPLES': { beta: 0.7, debtRatio: 0.25, terminalPE: 18 },
    'ENERGY': { beta: 1.3, debtRatio: 0.30, terminalPE: 10 },
    'INDUSTRIALS': { beta: 1.1, debtRatio: 0.30, terminalPE: 15 },
    'COMMUNICATION SERVICES': { beta: 1.0, debtRatio: 0.20, terminalPE: 18 },
    'UTILITIES': { beta: 0.5, debtRatio: 0.50, terminalPE: 14 },
    'REAL ESTATE': { beta: 0.8, debtRatio: 0.45, terminalPE: 16 },
    'MATERIALS': { beta: 1.1, debtRatio: 0.25, terminalPE: 14 },
    'DEFAULT': { beta: 1.0, debtRatio: 0.25, terminalPE: 15 },
};

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface DCFProjection {
    year: number;
    revenue: number;
    fcf: number;
    growthApplied: number;
    discountedFCF: number;
}

export interface DCFResult {
    metadata: {
        companyName: string;
        ticker: string;
        sector: string;
        dcfMethod: string;
        analysisDate: string;
    };
    currentMarketData: {
        currentPrice: number;
        marketCap: number;
        sharesOutstanding: number;
    };
    growthAnalysis: {
        selectedGrowthRate: number;
        growthSource: string;
        revenueCAGR3yr: number | null;
        normalizedFCFMargin: number;
    };
    waccCalculation: {
        wacc: number;
        waccFormatted: string;
        components: {
            costOfEquity: number;
            costOfDebt: number;
            equityWeight: number;
            debtWeight: number;
            beta: number;
            riskFreeRate: number;
        };
        sector: string;
    };
    projections: Array<{
        year: number;
        revenue: number;
        fcf: number;
        growthRate: string;
        discountedFCF: number;
    }>;
    terminalValue: {
        method: string;
        terminalGrowth: string;
        undiscountedValue: number;
        discountedValue: number;
        percentOfTotal: string;
    };
    valuationSummary: {
        intrinsicValue: number;
        currentPrice: number;
        upsideDownside: string;
        valuation: string;
    };
    reverseDCF: {
        impliedGrowthRate: number;
        impliedGrowthFormatted: string;
        interpretation: string;
    };
    investmentRecommendation: {
        recommendation: string;
        confidence: string;
        reasoning: string;
    };
    warnings: string[];
}

export interface QuickDCFResult {
    mode: string;
    symbol: string;
    intrinsicValue: number;
    currentPrice: number;
    upside: string;
    valuation: string;
    inputs: {
        ttmEPS: number;
        growthRate: number;
        discountRate: number;
        terminalPE: number;
    };
    projections: Array<{
        year: number;
        eps: number;
        discountedEPS: number;
    }>;
    terminalValue: {
        value: number;
        discounted: number;
    };
}

// ─────────────────────────────────────────────────────────
// Task 1: Growth Rate Selection
// ─────────────────────────────────────────────────────────

/**
 * Calculate Compound Annual Growth Rate.
 * Returns null if inputs are non-positive (can't CAGR negative values).
 */
function calculateCAGR(startValue: number, endValue: number, years: number): number | null {
    if (startValue <= 0 || endValue <= 0 || years <= 0) return null;
    return Math.pow(endValue / startValue, 1 / years) - 1;
}

/**
 * Select the best growth rate using a priority hierarchy:
 *   1. Analyst consensus (implied from estimated EPS vs trailing EPS)
 *   2. 3-year Revenue CAGR (stable, observable)
 *   3. Sector default (fallback)
 *
 * Clamped to [2%, 35%].
 */
function selectGrowthRate(
    incomeStatements: FinancialStatement[],
    earningsData: Array<{ reportedEPS: number; estimatedEPS?: number }> | null,
): { rate: number; source: string; raw: number | null } {
    // Sort income statements by year descending (most recent first)
    const sorted = [...incomeStatements].sort((a, b) => b.fiscalYear - a.fiscalYear);

    // Method 1: Revenue CAGR (3-year)
    let revenueCAGR: number | null = null;
    if (sorted.length >= 4) {
        const latest = sorted[0];
        const threeYrsAgo = sorted[3];
        if (latest.revenue && latest.revenue > 0 && threeYrsAgo.revenue && threeYrsAgo.revenue > 0) {
            revenueCAGR = calculateCAGR(threeYrsAgo.revenue, latest.revenue, 3);
        }
    }

    // Method 2: Analyst consensus — implied growth from estimated vs reported EPS
    if (earningsData && earningsData.length >= 5) {
        // TTM EPS = sum of last 4 reported
        const ttmEPS = earningsData.slice(0, 4).reduce((sum, q) => sum + (q.reportedEPS || 0), 0);
        // Find estimatedEPS from the most recent quarter
        const latestEstimate = earningsData.find(q => q.estimatedEPS !== undefined && q.estimatedEPS > 0);
        if (latestEstimate && latestEstimate.estimatedEPS && ttmEPS > 0) {
            const estimatedAnnualEPS = latestEstimate.estimatedEPS * 4;
            const analystGrowth = (estimatedAnnualEPS / ttmEPS) - 1;
            if (analystGrowth > 0 && isFinite(analystGrowth)) {
                const clamped = Math.max(0.02, Math.min(analystGrowth, 0.35));
                return { rate: clamped, source: 'analyst', raw: revenueCAGR };
            }
        }
    }

    // Method 3: Revenue CAGR
    if (revenueCAGR !== null && isFinite(revenueCAGR)) {
        const clamped = Math.max(0.02, Math.min(revenueCAGR, 0.35));
        return { rate: clamped, source: 'revenue_cagr', raw: revenueCAGR };
    }

    // Method 4: Sector default
    return { rate: 0.05, source: 'sector_default', raw: null };
}

/**
 * Calculate Normalized FCF Margin: average of (OCF - |CapEx|) / Revenue
 * over the last 3 years. Clamped to [5%, 50%].
 */
function calculateNormalizedFCFMargin(
    cashFlowStatements: FinancialStatement[],
    incomeStatements: FinancialStatement[],
): number {
    const margins: number[] = [];

    // Sort both by year descending, take last 3 years
    const cfSorted = [...cashFlowStatements].sort((a, b) => b.fiscalYear - a.fiscalYear).slice(0, 3);
    const incSorted = [...incomeStatements].sort((a, b) => b.fiscalYear - a.fiscalYear).slice(0, 3);

    for (const cf of cfSorted) {
        const inc = incSorted.find(i => i.fiscalYear === cf.fiscalYear);
        const revenue = inc?.revenue ?? cf.revenue;
        const ocf = cf.operatingCashFlow ?? 0;
        const capex = Math.abs(cf.capitalExpenditures ?? 0);

        if (revenue && revenue > 0 && ocf > 0) {
            const fcf = ocf - capex;
            const margin = fcf / revenue;
            margins.push(margin);
        }
    }

    if (margins.length === 0) return 0.10; // Conservative fallback

    const avgMargin = margins.reduce((a, b) => a + b, 0) / margins.length;
    return Math.max(0.05, Math.min(avgMargin, 0.50));
}

// ─────────────────────────────────────────────────────────
// Task 2: 10-Year FCF Projection with Growth Fade
// ─────────────────────────────────────────────────────────

/**
 * Project cash flows over 10 years with two-phase growth:
 *   Phase 1 (years 1-5): full growth rate
 *   Phase 2 (years 6-10): linear fade toward terminal growth
 */
function projectCashFlows(
    baseRevenue: number,
    growthRate: number,
    fcfMargin: number,
    years: number = PROJECTION_YEARS,
    terminalGrowth: number = TERMINAL_GROWTH_RATE,
): DCFProjection[] {
    const projections: DCFProjection[] = [];
    let revenue = baseRevenue;

    // Phase 1: Full growth rate (years 1-5)
    for (let y = 1; y <= PHASE_1_YEARS; y++) {
        revenue = revenue * (1 + growthRate);
        const fcf = revenue * fcfMargin;
        projections.push({ year: y, revenue, fcf, growthApplied: growthRate, discountedFCF: 0 });
    }

    // Phase 2: Linear fade to terminal growth (years 6-10)
    for (let y = PHASE_1_YEARS + 1; y <= years; y++) {
        const fadeProgress = (y - PHASE_1_YEARS) / (years - PHASE_1_YEARS);
        const fadedGrowth = growthRate - (growthRate - terminalGrowth) * fadeProgress;
        revenue = revenue * (1 + fadedGrowth);
        const fcf = revenue * fcfMargin;
        projections.push({ year: y, revenue, fcf, growthApplied: fadedGrowth, discountedFCF: 0 });
    }

    return projections;
}

// ─────────────────────────────────────────────────────────
// Task 3: WACC Calculation (CAPM + Sector Defaults)
// ─────────────────────────────────────────────────────────

/**
 * Calculate WACC using CAPM with sector defaults as fallback.
 * Clamped to [6%, 15%].
 */
function calculateWACC(
    overview: CompanyOverview,
    latestBalance: FinancialStatement,
    latestIncome: FinancialStatement,
): {
    wacc: number;
    components: { costOfEquity: number; costOfDebt: number; equityWeight: number; debtWeight: number; beta: number; riskFreeRate: number };
    clamped: boolean;
    sector: string;
} {
    const sector = (overview.sector || 'DEFAULT').toUpperCase();
    const defaults = SECTOR_DEFAULTS[sector] || SECTOR_DEFAULTS['DEFAULT'];
    const beta = overview.beta ?? defaults.beta;

    // Cost of equity via CAPM
    const costOfEquity = RISK_FREE_RATE + beta * EQUITY_RISK_PREMIUM;

    // Debt/equity split
    const totalDebt = (latestBalance.totalDebt ?? 0) + (latestBalance.shortTermDebt ?? 0);
    const marketCap = overview.marketCap || 0;
    const totalValue = totalDebt + marketCap;

    const equityWeight = marketCap > 0 ? marketCap / totalValue : (1 - defaults.debtRatio);
    const debtWeight = 1 - equityWeight;

    // Cost of debt
    const interestExpense = Math.abs(latestIncome.interestExpense ?? 0);
    const costOfDebt = totalDebt > 0 ? interestExpense / totalDebt : 0.05;

    // WACC
    const wacc = (equityWeight * costOfEquity) + (debtWeight * costOfDebt * (1 - TAX_RATE));

    // Sanity clamp: WACC between 6% and 15%
    const clampedWACC = Math.max(0.06, Math.min(wacc, 0.15));

    return {
        wacc: clampedWACC,
        components: { costOfEquity, costOfDebt, equityWeight, debtWeight, beta, riskFreeRate: RISK_FREE_RATE },
        clamped: wacc !== clampedWACC,
        sector,
    };
}

// ─────────────────────────────────────────────────────────
// Task 4: Terminal Value (Gordon Growth Only)
// ─────────────────────────────────────────────────────────

/**
 * Gordon Growth terminal value. Terminal growth is clamped to be
 * strictly less than WACC.
 */
function calculateTerminalValue(
    finalYearFCF: number,
    wacc: number,
    terminalGrowth: number = TERMINAL_GROWTH_RATE,
): { terminalValue: number; discountedTV: number; terminalGrowth: number } {
    // Clamp: must be less than WACC
    const tg = Math.max(0.01, Math.min(terminalGrowth, wacc - 0.01));

    // Gordon Growth Model
    const terminalValue = (finalYearFCF * (1 + tg)) / (wacc - tg);

    // Discount terminal value back to present
    const discountedTV = terminalValue / Math.pow(1 + wacc, PROJECTION_YEARS);

    return { terminalValue, discountedTV, terminalGrowth: tg };
}

// ─────────────────────────────────────────────────────────
// Task 5: Intrinsic Value Assembly
// ─────────────────────────────────────────────────────────

/**
 * Assemble intrinsic value from projected cash flows and terminal value.
 */
function calculateIntrinsicValue(
    projections: DCFProjection[],
    wacc: number,
    terminalGrowth: number,
    sharesOutstanding: number,
): {
    enterpriseValue: number;
    intrinsicValuePerShare: number;
    sumDiscountedFCF: number;
    terminalValueContribution: number;
    terminalValuePct: number;
    projections: DCFProjection[];
    terminal: { terminalValue: number; discountedTV: number; terminalGrowth: number };
} {
    // Discount each year's FCF
    let sumDiscountedFCF = 0;
    const detailedProjections = projections.map(p => {
        const discountedFCF = p.fcf / Math.pow(1 + wacc, p.year);
        sumDiscountedFCF += discountedFCF;
        return { ...p, discountedFCF };
    });

    // Terminal value
    const finalYearFCF = projections[projections.length - 1].fcf;
    const tv = calculateTerminalValue(finalYearFCF, wacc, terminalGrowth);

    // Enterprise value
    const enterpriseValue = sumDiscountedFCF + tv.discountedTV;

    // Per-share value
    const intrinsicValuePerShare = sharesOutstanding > 0 ? enterpriseValue / sharesOutstanding : 0;

    return {
        enterpriseValue,
        intrinsicValuePerShare,
        sumDiscountedFCF,
        terminalValueContribution: tv.discountedTV,
        terminalValuePct: enterpriseValue > 0 ? tv.discountedTV / enterpriseValue : 0,
        projections: detailedProjections,
        terminal: tv,
    };
}

// ─────────────────────────────────────────────────────────
// Task 6: Reverse DCF (Implied Growth Rate)
// ─────────────────────────────────────────────────────────

/**
 * Binary search for the growth rate that equates the DCF intrinsic value
 * to the current market price.
 */
function reverseDCF(
    currentPrice: number,
    sharesOutstanding: number,
    baseRevenue: number,
    fcfMargin: number,
    wacc: number,
    terminalGrowth: number = TERMINAL_GROWTH_RATE,
): { impliedGrowthRate: number; impliedGrowthFormatted: string; interpretation: string } {
    let low = 0.0;
    let high = 0.50;

    for (let i = 0; i < 50; i++) {
        const mid = (low + high) / 2;
        const proj = projectCashFlows(baseRevenue, mid, fcfMargin, PROJECTION_YEARS, terminalGrowth);
        const result = calculateIntrinsicValue(proj, wacc, terminalGrowth, sharesOutstanding);

        if (result.intrinsicValuePerShare < currentPrice) {
            low = mid;
        } else {
            high = mid;
        }
    }

    const impliedGrowth = (low + high) / 2;
    let interpretation: string;
    if (impliedGrowth > 0.25) {
        interpretation = 'Market expects exceptional growth — high risk if it decelerates';
    } else if (impliedGrowth > 0.15) {
        interpretation = 'Market expects strong growth — priced for continued execution';
    } else if (impliedGrowth > 0.08) {
        interpretation = 'Market expects moderate growth — reasonable expectations';
    } else if (impliedGrowth > 0.03) {
        interpretation = 'Market expects low growth — potential value opportunity';
    } else {
        interpretation = 'Market expects near-zero growth — deep value or distressed';
    }

    return {
        impliedGrowthRate: impliedGrowth,
        impliedGrowthFormatted: (impliedGrowth * 100).toFixed(2) + '%',
        interpretation,
    };
}

// ─────────────────────────────────────────────────────────
// Task 7: Quick DCF (EPS-Based Simplified Mode)
// ─────────────────────────────────────────────────────────

/**
 * EPS-based quick intrinsic valuation.
 * Only needs EARNINGS + OVERVIEW + Price (3 API calls).
 */
export async function quickDCF(symbol: string): Promise<QuickDCFResult> {
    const sym = symbol.toUpperCase().trim();

    // Fetch only what we need
    const [earningsData, priceResult, overview] = await Promise.all([
        fetchEarnings(sym, 8),
        getPrice({ symbol: sym }),
        fetchCompanyOverview(sym),
    ]);

    // Base EPS = TTM (sum of last 4 quarterly reportedEPS)
    const ttmEPS = earningsData
        .slice(0, 4)
        .reduce((sum, q) => sum + (q.epsActual ?? 0), 0);

    if (ttmEPS <= 0) {
        throw new APIError(
            `Cannot run quick DCF for ${sym}: TTM EPS is non-positive (${ttmEPS.toFixed(2)}).`,
            { symbol: sym, ttmEPS },
        );
    }

    // Growth rate from analyst estimates or default
    const latestEstimate = earningsData.find(q => q.epsEstimate !== undefined && q.epsEstimate > 0);
    let growthRate: number;
    if (latestEstimate && latestEstimate.epsEstimate) {
        const estimatedAnnualEPS = latestEstimate.epsEstimate * 4;
        growthRate = Math.max(0.02, Math.min((estimatedAnnualEPS / ttmEPS) - 1, 0.35));
    } else {
        growthRate = 0.05; // Fallback
    }

    // Discount rate and terminal PE from sector defaults
    const sector = (overview.sector || 'DEFAULT').toUpperCase();
    const defaults = SECTOR_DEFAULTS[sector] || SECTOR_DEFAULTS['DEFAULT'];
    const discountRate = 0.10; // Simple 10% for quick mode
    const terminalPE = defaults.terminalPE;

    // Project 10 years of EPS
    const projections: Array<{ year: number; eps: number; discountedEPS: number }> = [];
    let eps = ttmEPS;
    let sumDiscountedEPS = 0;

    for (let y = 1; y <= PROJECTION_YEARS; y++) {
        eps = eps * (1 + growthRate);
        const discounted = eps / Math.pow(1 + discountRate, y);
        sumDiscountedEPS += discounted;
        projections.push({ year: y, eps, discountedEPS: discounted });
    }

    // Terminal value = Year 10 EPS × PE multiple, discounted
    const terminalValue = eps * terminalPE;
    const discountedTV = terminalValue / Math.pow(1 + discountRate, PROJECTION_YEARS);

    const intrinsicValue = sumDiscountedEPS + discountedTV;
    const currentPrice = priceResult.data.price;
    const upside = (intrinsicValue - currentPrice) / currentPrice;

    return {
        mode: 'quick_eps',
        symbol: sym,
        intrinsicValue: Math.round(intrinsicValue * 100) / 100,
        currentPrice,
        upside: (upside * 100).toFixed(2) + '%',
        valuation: upside > 0.15 ? 'UNDERVALUED' : upside < -0.15 ? 'OVERVALUED' : 'FAIRLY_VALUED',
        inputs: { ttmEPS, growthRate, discountRate, terminalPE },
        projections,
        terminalValue: { value: terminalValue, discounted: discountedTV },
    };
}

// ─────────────────────────────────────────────────────────
// Task 8: Warnings Generator
// ─────────────────────────────────────────────────────────

function generateWarnings(
    growth: { rate: number; source: string; raw: number | null },
    waccResult: { wacc: number; clamped: boolean },
    valuation: { terminalValuePct: number },
    fcfMargin: number,
): string[] {
    const warnings: string[] = [];
    if (growth.rate >= 0.30) warnings.push('Growth rate at or near ceiling (35%). High uncertainty.');
    if (waccResult.clamped) warnings.push('WACC was clamped to bounds. Check beta/debt data.');
    if (valuation.terminalValuePct > 0.80) warnings.push('Terminal value exceeds 80% of total — sensitive to terminal assumptions.');
    if (fcfMargin < 0.08) warnings.push('Low FCF margin. Company may be in heavy investment phase.');
    return warnings;
}

// ─────────────────────────────────────────────────────────
// Task 8: Main Orchestrator — runDCFAnalysis
// ─────────────────────────────────────────────────────────

/**
 * Full DCF analysis: revenue-anchored FCF model with WACC discounting,
 * Gordon Growth terminal value, and reverse DCF.
 */
export async function runDCFAnalysis(symbol: string): Promise<DCFResult> {
    const sym = symbol.toUpperCase().trim();
    console.log(`\n📈 [DCF v4] Starting analysis for ${sym}...`);

    // ─── 1. Fetch all data in parallel ────────────────
    console.log(`📊 [DCF] Step 1: Fetching data...`);

    const [statements, priceResult, overview, earningsData] = await Promise.all([
        fetchFinancialStatements(sym, 'annual', 5),
        getPrice({ symbol: sym }),
        fetchCompanyOverview(sym),
        fetchEarnings(sym, 8).catch(() => [] as Awaited<ReturnType<typeof fetchEarnings>>),
    ]);

    if (statements.length < 3) {
        throw new APIError(
            `Insufficient historical data for DCF analysis of ${sym}. Need at least 3 years, got ${statements.length}.`,
            { symbol: sym, yearsAvailable: statements.length },
        );
    }

    // ─── 2. Extract key inputs ───────────────────────
    console.log(`📊 [DCF] Step 2: Extracting inputs...`);

    const sortedStatements = [...statements].sort((a, b) => b.fiscalYear - a.fiscalYear);
    const latestIncome = sortedStatements[0];
    const latestBalance = sortedStatements[0]; // Financial statements include all data
    const baseRevenue = latestIncome.revenue ?? 0;
    const sharesOutstanding = overview.sharesOutstanding ?? 0;
    const currentPrice = priceResult.data.price;

    if (baseRevenue <= 0) {
        throw new APIError(
            `Cannot run DCF for ${sym}: latest revenue is zero or negative.`,
            { symbol: sym, baseRevenue },
        );
    }
    if (sharesOutstanding <= 0) {
        throw new APIError(
            `Cannot run DCF for ${sym}: shares outstanding is zero or missing.`,
            { symbol: sym },
        );
    }

    // ─── 3. Growth rate (Task 1) ─────────────────────
    console.log(`📊 [DCF] Step 3: Selecting growth rate...`);

    // Adapt earningsData to the format selectGrowthRate expects
    const earningsForGrowth = earningsData.map(e => ({
        reportedEPS: e.epsActual ?? 0,
        estimatedEPS: e.epsEstimate,
    }));
    const growth = selectGrowthRate(sortedStatements, earningsForGrowth.length > 0 ? earningsForGrowth : null);
    console.log(`📊 [DCF] Growth rate: ${(growth.rate * 100).toFixed(2)}% (source: ${growth.source})`);

    // ─── 4. FCF margin (Task 1) ──────────────────────
    console.log(`📊 [DCF] Step 4: Computing FCF margin...`);

    const fcfMargin = calculateNormalizedFCFMargin(sortedStatements, sortedStatements);
    console.log(`📊 [DCF] FCF margin: ${(fcfMargin * 100).toFixed(2)}%`);

    // ─── 5. WACC (Task 3) ────────────────────────────
    console.log(`📊 [DCF] Step 5: Calculating WACC...`);

    const waccResult = calculateWACC(overview, latestBalance, latestIncome);
    console.log(`📊 [DCF] WACC: ${(waccResult.wacc * 100).toFixed(2)}%${waccResult.clamped ? ' (clamped)' : ''}`);

    // ─── 6. Project 10 years (Task 2) ────────────────
    console.log(`📊 [DCF] Step 6: Projecting cash flows...`);

    const projections = projectCashFlows(baseRevenue, growth.rate, fcfMargin, PROJECTION_YEARS, TERMINAL_GROWTH_RATE);

    // ─── 7. Intrinsic value (Task 5) ─────────────────
    console.log(`📊 [DCF] Step 7: Computing intrinsic value...`);

    const valuation = calculateIntrinsicValue(projections, waccResult.wacc, TERMINAL_GROWTH_RATE, sharesOutstanding);
    console.log(`📊 [DCF] Intrinsic value: $${valuation.intrinsicValuePerShare.toFixed(2)}`);

    // ─── 8. Reverse DCF (Task 6) ─────────────────────
    console.log(`📊 [DCF] Step 8: Running reverse DCF...`);

    const reverseDCFResult = reverseDCF(currentPrice, sharesOutstanding, baseRevenue, fcfMargin, waccResult.wacc, TERMINAL_GROWTH_RATE);

    // ─── 9. Assemble output ──────────────────────────
    const upside = (valuation.intrinsicValuePerShare - currentPrice) / currentPrice;

    const warnings = generateWarnings(growth, waccResult, valuation, fcfMargin);

    const result: DCFResult = {
        metadata: {
            companyName: overview.name,
            ticker: sym,
            sector: overview.sector || 'Unknown',
            dcfMethod: 'revenue_anchored_fcf',
            analysisDate: new Date().toISOString(),
        },
        currentMarketData: {
            currentPrice,
            marketCap: overview.marketCap || 0,
            sharesOutstanding,
        },
        growthAnalysis: {
            selectedGrowthRate: growth.rate,
            growthSource: growth.source,
            revenueCAGR3yr: growth.raw,
            normalizedFCFMargin: fcfMargin,
        },
        waccCalculation: {
            wacc: waccResult.wacc,
            waccFormatted: (waccResult.wacc * 100).toFixed(2) + '%',
            components: waccResult.components,
            sector: waccResult.sector,
        },
        projections: valuation.projections.map(p => ({
            year: p.year,
            revenue: Math.round(p.revenue),
            fcf: Math.round(p.fcf),
            growthRate: (p.growthApplied * 100).toFixed(2) + '%',
            discountedFCF: Math.round(p.discountedFCF),
        })),
        terminalValue: {
            method: 'gordon_growth',
            terminalGrowth: '2.50%',
            undiscountedValue: Math.round(valuation.terminal.terminalValue),
            discountedValue: Math.round(valuation.terminal.discountedTV),
            percentOfTotal: (valuation.terminalValuePct * 100).toFixed(1) + '%',
        },
        valuationSummary: {
            intrinsicValue: Math.round(valuation.intrinsicValuePerShare * 100) / 100,
            currentPrice,
            upsideDownside: (upside * 100).toFixed(2) + '%',
            valuation: upside > 0.15 ? 'UNDERVALUED' : upside < -0.15 ? 'OVERVALUED' : 'FAIRLY_VALUED',
        },
        reverseDCF: reverseDCFResult,
        investmentRecommendation: {
            recommendation: upside > 0.20 ? 'BUY' : upside > -0.10 ? 'HOLD' : 'SELL',
            confidence: Math.abs(upside) > 0.30 ? 'High' : 'Medium',
            reasoning: `Based on ${growth.source} growth of ${(growth.rate * 100).toFixed(1)}%, ` +
                `WACC of ${(waccResult.wacc * 100).toFixed(1)}%, ` +
                `and FCF margin of ${(fcfMargin * 100).toFixed(1)}%. ` +
                `Market implies ${reverseDCFResult.impliedGrowthFormatted} growth.`,
        },
        warnings,
    };

    console.log(`✅ [DCF v4] Analysis complete for ${sym}. Intrinsic Value: $${valuation.intrinsicValuePerShare.toFixed(2)} | Current: $${currentPrice.toFixed(2)} | Upside: ${(upside * 100).toFixed(1)}%`);
    return result;
}
