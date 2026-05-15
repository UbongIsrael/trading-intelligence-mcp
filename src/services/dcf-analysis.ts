// DCF v5 — EBITDA-based FCFF model with equity bridge
// Migrated from Alpha Vantage to Financial Modeling Prep (FMP)
// Key v5 additions: equity bridge, EBITDA-based FCFF, fractional discounting,
// exit EBITDA multiple cross-check, sensitivity analysis, user overrides

import {
    fetchDCFDataBundle,
    resolveGDPGrowthRate,
    GDP_FALLBACKS,
    type FMPIncomeStatement,
    type FMPBalanceSheet,
    type FMPCashFlowStatement,
    type FMPProfile,
    type ParsedRevenueSegment,
    fetchFMPProfile,
    fetchFMPBalanceSheet,
} from './fmp-data-service.js';
// REMOVED: Alpha Vantage imports replaced by FMP data service (Phase 1 migration)
// Alpha Vantage service retained for non-DCF tools (fundamentals-tool, contextual)
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

const SECTOR_DEFAULTS: Record<string, { beta: number; debtRatio: number; terminalPE: number; ebitdaMultiple: number }> = {
    'TECHNOLOGY':             { beta: 1.2, debtRatio: 0.15, terminalPE: 20, ebitdaMultiple: 25 },
    'HEALTH CARE':            { beta: 1.0, debtRatio: 0.20, terminalPE: 18, ebitdaMultiple: 15 },
    'FINANCIALS':             { beta: 1.1, debtRatio: 0.60, terminalPE: 12, ebitdaMultiple: 12 },
    'CONSUMER DISCRETIONARY': { beta: 1.0, debtRatio: 0.25, terminalPE: 16, ebitdaMultiple: 12 },
    'CONSUMER STAPLES':       { beta: 0.7, debtRatio: 0.25, terminalPE: 18, ebitdaMultiple: 14 },
    'ENERGY':                 { beta: 1.3, debtRatio: 0.30, terminalPE: 10, ebitdaMultiple: 8 },
    'INDUSTRIALS':            { beta: 1.1, debtRatio: 0.30, terminalPE: 15, ebitdaMultiple: 13 },
    'COMMUNICATION SERVICES': { beta: 1.0, debtRatio: 0.20, terminalPE: 18, ebitdaMultiple: 15 },
    'UTILITIES':              { beta: 0.5, debtRatio: 0.50, terminalPE: 14, ebitdaMultiple: 12 },
    'REAL ESTATE':            { beta: 0.8, debtRatio: 0.45, terminalPE: 16, ebitdaMultiple: 18 },
    'MATERIALS':              { beta: 1.1, debtRatio: 0.25, terminalPE: 14, ebitdaMultiple: 10 },
    'DEFAULT':                { beta: 1.0, debtRatio: 0.25, terminalPE: 15, ebitdaMultiple: 13 },
};

// ─────────────────────────────────────────────────────────
// F1: Financial Institutions Detection
// ─────────────────────────────────────────────────────────

export type FinancialInstitutionType = 'BANK' | 'INSURANCE' | 'REIT' | 'ASSET_MANAGER' | null;

export function detectFinancialInstitution(
    profile: { sector?: string; industry?: string },
    incomeStatement?: { netInterestIncome?: number; interestExpense?: number; netPremium?: number }
): { isFinancialInstitution: boolean; type: FinancialInstitutionType; reason: string } {
    const sector = (profile.sector || '').toUpperCase();
    const industry = (profile.industry || '').toUpperCase();

    // Check sector first
    if (sector === 'FINANCIALS') {
        // Determine type from industry
        if (industry.includes('BANK') || industry.includes('BANKS') || industry.includes('CREDIT')) {
            return { isFinancialInstitution: true, type: 'BANK', reason: 'Commercial/Investment Bank' };
        }
        if (industry.includes('INSURANCE') || industry.includes('UNDERWRITING')) {
            return { isFinancialInstitution: true, type: 'INSURANCE', reason: 'Insurance Company' };
        }
        if (industry.includes('ASSET') || industry.includes('MANAGEMENT') || industry.includes('INVESTMENT')) {
            return { isFinancialInstitution: true, type: 'ASSET_MANAGER', reason: 'Asset Management Firm' };
        }
        // Default to BANK for financials without specific industry
        return { isFinancialInstitution: true, type: 'BANK', reason: 'Financial Services (default)' };
    }

    if (sector === 'REAL ESTATE') {
        if (industry.includes('REIT') || industry.includes('REAL ESTATE INVESTMENT')) {
            return { isFinancialInstitution: true, type: 'REIT', reason: 'Real Estate Investment Trust' };
        }
    }

    // Check income statement for financial indicators
    if (incomeStatement) {
        const hasInterestIncome = (incomeStatement.netInterestIncome ?? 0) !== 0;
        const hasInterestExpense = (incomeStatement.interestExpense ?? 0) !== 0;
        const hasNetPremium = (incomeStatement.netPremium ?? 0) !== 0;

        // If primary revenue is from interest, likely a bank
        if (hasInterestIncome && hasInterestExpense && !hasNetPremium) {
            return { isFinancialInstitution: true, type: 'BANK', reason: 'Net interest income detected' };
        }
        // If has net premiums, likely insurance
        if (hasNetPremium) {
            return { isFinancialInstitution: true, type: 'INSURANCE', reason: 'Net premium revenue detected' };
        }
    }

    return { isFinancialInstitution: false, type: null, reason: 'Non-financial company' };
}

// ─────────────────────────────────────────────────────────
// F3: Dividend Discount Model (DDM) for Banks/Insurance
// ─────────────────────────────────────────────────────────

interface DDMResult {
    intrinsicValue: number;
    stage1PV: number;
    terminalValue: number;
    terminalPV: number;
    dividendsProjected: { year: number; dividend: number; pv: number }[];
    excessReturnValue?: number;
}

function calculateDDM(
    latestEPS: number,
    payoutRatio: number,
    growthRate: number,
    costOfEquity: number,
    terminalGrowth: number,
    _sharesOutstanding: number,
    bookValuePerShare?: number,
    roe?: number,
): DDMResult {
    const projections: { year: number; dividend: number; pv: number }[] = [];
    let eps = latestEPS;
    let stage1PV = 0;

    // Stage 1: 5 years of explicit dividends
    for (let year = 1; year <= PHASE_1_YEARS; year++) {
        eps = eps * (1 + growthRate);
        const dividend = eps * payoutRatio;
        const pv = dividend / Math.pow(1 + costOfEquity, year);
        stage1PV += pv;
        projections.push({ year, dividend, pv });
    }

    // Terminal value (Gordon Growth)
    const finalDividend = projections[PHASE_1_YEARS - 1].dividend * (1 + terminalGrowth);
    const terminalValue = finalDividend / (costOfEquity - terminalGrowth);
    const terminalPV = terminalValue / Math.pow(1 + costOfEquity, PHASE_1_YEARS);

    // Intrinsic value (already per-share - stage1PV and terminalPV are discounted dividends per share)
    const intrinsicValue = stage1PV + terminalPV;

    // Excess Return Value (if book value and ROE available)
    let excessReturnValue: number | undefined;
    if (bookValuePerShare && roe && payoutRatio < 1) {
        let pvExcessReturns = 0;
        let bv = bookValuePerShare;
        for (let year = 1; year <= PHASE_1_YEARS; year++) {
            const excessReturn = (roe - costOfEquity) * bv;
            pvExcessReturns += excessReturn / Math.pow(1 + costOfEquity, year);
            bv = bv * (1 + growthRate); // Retained earnings plowed back
        }
        excessReturnValue = bookValuePerShare + pvExcessReturns;
    }

    return {
        intrinsicValue,
        stage1PV,
        terminalValue,
        terminalPV,
        dividendsProjected: projections,
        excessReturnValue,
    };
}

// ─────────────────────────────────────────────────────────
// F4: FFO Model for REITs
// ─────────────────────────────────────────────────────────

interface FFOResult {
    intrinsicValue: number;
    ffoProjected: { year: number; ffo: number; pv: number }[];
    terminalValue: number;
    terminalPV: number;
}

function calculateFFO(
    netIncome: number,
    depreciation: number,
    gainsOnPropertySales: number,
    growthRate: number,
    costOfEquity: number,
    terminalGrowth: number,
    sharesOutstanding: number,
): FFOResult {
    const projections: { year: number; ffo: number; pv: number }[] = [];
    let ffo = netIncome + depreciation - gainsOnPropertySales;
    let stage1PV = 0;

    // Project FFO for 5 years
    for (let year = 1; year <= PHASE_1_YEARS; year++) {
        ffo = ffo * (1 + growthRate);
        const pv = ffo / Math.pow(1 + costOfEquity, year);
        stage1PV += pv;
        projections.push({ year, ffo, pv });
    }

    // Terminal value
    const finalFFO = projections[PHASE_1_YEARS - 1].ffo * (1 + terminalGrowth);
    const terminalValue = finalFFO / (costOfEquity - terminalGrowth);
    const terminalPV = terminalValue / Math.pow(1 + costOfEquity, PHASE_1_YEARS);

    const intrinsicValue = (stage1PV + terminalPV) / sharesOutstanding;

    return {
        intrinsicValue,
        ffoProjected: projections,
        terminalValue,
        terminalPV,
    };
}

// ─────────────────────────────────────────────────────────
// F5: FCFE Model for Asset Managers
// ─────────────────────────────────────────────────────────

interface FCFEResult {
    intrinsicValue: number;
    fcfeProjected: { year: number; fcfe: number; pv: number }[];
    terminalValue: number;
    terminalPV: number;
}

function calculateFCFE(
    netIncome: number,
    capex: number,
    depreciation: number,
    workingCapitalChange: number,
    debtRatio: number,
    growthRate: number,
    costOfEquity: number,
    terminalGrowth: number,
    sharesOutstanding: number,
): FCFEResult {
    const projections: { year: number; fcfe: number; pv: number }[] = [];
    let fcfe = netIncome - (capex - depreciation) * (1 - debtRatio) - workingCapitalChange * (1 - debtRatio);
    let stage1PV = 0;

    // Project FCFE for 5 years
    for (let year = 1; year <= PHASE_1_YEARS; year++) {
        // Simplified: grow FCFE at same rate as earnings
        fcfe = fcfe * (1 + growthRate);
        const pv = fcfe / Math.pow(1 + costOfEquity, year);
        stage1PV += pv;
        projections.push({ year, fcfe, pv });
    }

    // Terminal value
    const finalFCFE = projections[PHASE_1_YEARS - 1].fcfe * (1 + terminalGrowth);
    const terminalValue = finalFCFE / (costOfEquity - terminalGrowth);
    const terminalPV = terminalValue / Math.pow(1 + costOfEquity, PHASE_1_YEARS);

    const intrinsicValue = (stage1PV + terminalPV) / sharesOutstanding;

    return {
        intrinsicValue,
        fcfeProjected: projections,
        terminalValue,
        terminalPV,
    };
}

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface DCFProjection {
    year: number;
    revenue: number;
    ebitda: number;
    capex: number;
    da: number;
    workingCapitalDelta: number;
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
        financialInstitution?: { type: FinancialInstitutionType; reason: string };
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
        fcffMethod: string;
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
            preferredStockWeight?: number;
        };
        sector: string;
        betaSource?: string;
    };
    projections: Array<{
        year: number;
        revenue: number;
        ebitda: number;
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
    terminalValueCrossCheck?: {
        method: string;
        multiple: number;
        undiscountedValue: number;
        discountedValue: number;
        percentOfTotal: string;
    };
    equityBridge: {
        enterpriseValue: number;
        netDebt: number;
        cash: number;
        equityValue: number;
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
    keyAssumptions: {
        baseRevenue: number;
        effectiveTaxRate: number;
        ebitdaMargin: number;
        capexToRevenue: number;
        daToRevenue: number;
        gdpCeiling: number;
        gdpCountry: string;
        filingDate: string;
    };
    warnings: string[];
    sensitivityAnalysis?: SensitivityResult;
    footballField?: FootballFieldRange[];
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
 * P2.2 — Compute Free Cash Flow to Firm (FCFF) from EBITDA components.
 * Formula: FCFF = EBITDA × (1 - taxRate) + D&A - CapEx - ΔWorkingCapital
 */
export function computeFCFF(
    ebitda: number,
    taxRate: number,
    da: number,
    capex: number,
    deltaWorkingCapital: number,
): { fcff: number; components: { ebitdaAfterTax: number; daAddback: number; capexDeduction: number; wcDeduction: number } } {
    const ebitdaAfterTax = ebitda * (1 - taxRate);
    const fcff = ebitdaAfterTax + da - capex - deltaWorkingCapital;
    return {
        fcff,
        components: { ebitdaAfterTax, daAddback: da, capexDeduction: capex, wcDeduction: deltaWorkingCapital },
    };
}

/**
 * P2.5 — Compute exact fraction of year between two dates.
 * Used for fractional discounting per the spec's YEARFRAC requirement.
 */
export function yearFrac(startDate: Date, endDate: Date): number {
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    return (endDate.getTime() - startDate.getTime()) / msPerYear;
}

/**
 * P2.9 — Exit EBITDA Multiple terminal value (cross-check for Gordon Growth).
 * TV = EBITDA_year_n × EV/EBITDA_multiple, discounted back to present.
 */
export function calculateExitMultipleTV(
    finalYearEBITDA: number,
    ebitdaMultiple: number,
    wacc: number,
    projectionYears: number = PROJECTION_YEARS,
): { exitMultipleTV: number; discountedExitMultipleTV: number; multiple: number } {
    const exitMultipleTV = finalYearEBITDA * ebitdaMultiple;
    const discountedExitMultipleTV = exitMultipleTV / Math.pow(1 + wacc, projectionYears);
    return { exitMultipleTV, discountedExitMultipleTV, multiple: ebitdaMultiple };
}

/**
 * P3.3 — Un-lever a beta using the Hamada equation.
 * β_unlevered = β_levered / (1 + (1 - taxRate) × (D/E))
 */
export function unleverBeta(leveredBeta: number, taxRate: number, debtToEquityRatio: number): number {
    return leveredBeta / (1 + (1 - taxRate) * debtToEquityRatio);
}

/**
 * P3.4 — Re-lever an unlevered beta using the Hamada equation.
 * β_levered = β_unlevered × (1 + (1 - taxRate) × (D/E))
 */
export function releverBeta(unleveredBeta: number, taxRate: number, debtToEquityRatio: number): number {
    return unleveredBeta * (1 + (1 - taxRate) * debtToEquityRatio);
}

/**
 * P3.1 — Resolve GDP ceiling for terminal growth rate guard.
 * Priority: 1) single country ≥75% revenue, 2) weighted blend,
 *           3) IMF world 3%, 4) listing country GDP
 */
export function resolveGDPCeiling(
    countryCode: string,
    revenueSegments: ParsedRevenueSegment[],
): { gdpCeiling: number; method: string; country: string } {
    // Priority 1: Single country ≥75% of revenue
    if (revenueSegments.length > 0) {
        const dominant = revenueSegments.find(s => s.share >= 0.75);
        if (dominant) {
            const mapped = mapSegmentToCountry(dominant.segment);
            const gdp = resolveGDPGrowthRate(mapped);
            return { gdpCeiling: gdp, method: 'dominant_segment', country: mapped };
        }

        // Priority 2: Weighted blend of segment GDP rates
        let weightedGDP = 0;
        let totalWeight = 0;
        for (const seg of revenueSegments) {
            const mapped = mapSegmentToCountry(seg.segment);
            const gdp = resolveGDPGrowthRate(mapped);
            weightedGDP += gdp * seg.share;
            totalWeight += seg.share;
        }
        if (totalWeight > 0) {
            return { gdpCeiling: weightedGDP / totalWeight, method: 'weighted_blend', country: 'BLENDED' };
        }
    }

    // Priority 3: IMF world GDP
    if (!countryCode || countryCode === 'WORLD') {
        return { gdpCeiling: GDP_FALLBACKS['WORLD'], method: 'imf_world', country: 'WORLD' };
    }

    // Priority 4: Listing country
    const gdp = resolveGDPGrowthRate(countryCode);
    return { gdpCeiling: gdp, method: 'listing_country', country: countryCode };
}

/**
 * P3.5 — Calculate Peer Beta using pure-play method.
 * Fetches peers, un-levers their betas, averages them, and re-levers to target capital structure.
 */
export async function calculatePeerBeta(
    peers: string[],
    targetDE: number,
    taxRate: number,
    rawBeta: number
): Promise<{ leveredBeta: number; unleveredBeta: number; peersUsed: string[]; method: string }> {
    if (peers.length < 3) {
        return { 
            leveredBeta: rawBeta, 
            unleveredBeta: unleverBeta(rawBeta, taxRate, targetDE), 
            peersUsed: [], 
            method: 'raw_profile' 
        };
    }

    const selectedPeers = peers.slice(0, 5); // Limit API calls to 5 peers max
    const unleveredBetas: number[] = [];
    const peersUsed: string[] = [];

    await Promise.all(selectedPeers.map(async (peer) => {
        try {
            const [profile, bs] = await Promise.all([
                fetchFMPProfile(peer),
                fetchFMPBalanceSheet(peer, 'annual', 1)
            ]);
            const peerBeta = profile.beta;
            if (!peerBeta) return;
            
            const totalDebt = bs[0]?.totalDebt || 0;
            const marketCap = profile.mktCap || 1; 
            const peerDE = totalDebt / marketCap;
            
            // Assume standard 21% tax rate for peers as approximation if we don't fetch their income statements
            const peerTaxRate = 0.21; 
            const uBeta = unleverBeta(peerBeta, peerTaxRate, peerDE);
            unleveredBetas.push(uBeta);
            peersUsed.push(peer);
        } catch {
            // non-fatal if a peer fetch fails
        }
    }));

    if (unleveredBetas.length < 3) {
        return { 
            leveredBeta: rawBeta, 
            unleveredBeta: unleverBeta(rawBeta, taxRate, targetDE), 
            peersUsed: [], 
            method: 'raw_profile' 
        };
    }

    const avgUnlevered = unleveredBetas.reduce((a, b) => a + b, 0) / unleveredBetas.length;
    const reLevered = releverBeta(avgUnlevered, taxRate, targetDE);

    return {
        leveredBeta: reLevered,
        unleveredBeta: avgUnlevered,
        peersUsed,
        method: 'peer_average'
    };
}

/** Map FMP revenue segment names to ISO country codes */
function mapSegmentToCountry(segment: string): string {
    const lower = segment.toLowerCase();
    if (lower.includes('america') || lower.includes('united states') || lower === 'us') return 'US';
    if (lower.includes('china') || lower.includes('greater china')) return 'CN';
    if (lower.includes('japan')) return 'JP';
    if (lower.includes('europe')) return 'DE'; // Use Germany as EU proxy
    if (lower.includes('india')) return 'IN';
    if (lower.includes('korea')) return 'KR';
    if (lower.includes('brazil')) return 'BR';
    if (lower.includes('canada')) return 'CA';
    if (lower.includes('australia')) return 'AU';
    if (lower.includes('uk') || lower.includes('united kingdom')) return 'GB';
    return 'WORLD';
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
    incomeStatements: FMPIncomeStatement[],
    analystEstimates: { estimatedRevenueAvg?: number; estimatedEpsAvg?: number }[],
): { rate: number; source: string; raw: number | null } {
    // Sort income statements by date descending (most recent first)
    const sorted = [...incomeStatements].sort((a, b) => b.date.localeCompare(a.date));

    // Method 1: Analyst forward revenue growth
    if (analystEstimates.length > 0 && sorted.length > 0) {
        const fwdRevenue = analystEstimates[0]?.estimatedRevenueAvg;
        const latestRevenue = sorted[0]?.revenue;
        if (fwdRevenue && fwdRevenue > 0 && latestRevenue && latestRevenue > 0) {
            const impliedGrowth = (fwdRevenue / latestRevenue) - 1;
            if (isFinite(impliedGrowth) && impliedGrowth > 0) {
                const clamped = Math.max(0.02, Math.min(impliedGrowth, 0.35));
                return { rate: clamped, source: 'analyst_forward_revenue', raw: impliedGrowth };
            }
        }
    }

    // Method 2: Revenue CAGR (3-year)
    let revenueCAGR: number | null = null;
    if (sorted.length >= 4) {
        const latest = sorted[0];
        const threeYrsAgo = sorted[3];
        if (latest.revenue > 0 && threeYrsAgo.revenue > 0) {
            revenueCAGR = calculateCAGR(threeYrsAgo.revenue, latest.revenue, 3);
        }
    }

    if (revenueCAGR !== null && isFinite(revenueCAGR)) {
        const clamped = Math.max(0.02, Math.min(revenueCAGR, 0.35));
        return { rate: clamped, source: 'revenue_cagr', raw: revenueCAGR };
    }

    // Method 3: Sector default
    return { rate: 0.05, source: 'sector_default', raw: null };
}

/**
 * Calculate Normalized FCF Margin using EBITDA-based FCFF when data available,
 * falling back to (OCF - CapEx) / Revenue. Clamped to [5%, 50%].
 */
function calculateNormalizedFCFMargin(
    incomeStatements: FMPIncomeStatement[],
    cashFlowStatements: FMPCashFlowStatement[],
    balanceSheets: FMPBalanceSheet[],
): { margin: number; method: 'ebitda_based' | 'ocf_fallback' } {
    const margins: number[] = [];

    // Sort by date descending, take last 3 years
    const incSorted = [...incomeStatements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
    const cfSorted = [...cashFlowStatements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
    const bsSorted = [...balanceSheets].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4); // need N+1 for WC delta

    let method: 'ebitda_based' | 'ocf_fallback' = 'ebitda_based';

    for (let i = 0; i < incSorted.length; i++) {
        const inc = incSorted[i];
        const cf = cfSorted[i];
        const bsCurrent = bsSorted[i];
        const bsPrior = bsSorted[i + 1];

        if (!inc || !cf || inc.revenue <= 0) continue;

        // Try EBITDA-based FCFF first
        if (inc.ebitda > 0 && inc.incomeBeforeTax !== 0 && bsCurrent && bsPrior) {
            const taxRate = inc.incomeBeforeTax > 0
                ? Math.max(0, Math.min(inc.incomeTaxExpense / inc.incomeBeforeTax, 0.40))
                : TAX_RATE;
            const da = cf.depreciationAndAmortization || 0;
            const capex = cf.capitalExpenditure || 0; // FMP: positive number
            const wcCurrent = bsCurrent.totalCurrentAssets - bsCurrent.totalCurrentLiabilities;
            const wcPrior = bsPrior.totalCurrentAssets - bsPrior.totalCurrentLiabilities;
            const deltaWC = wcCurrent - wcPrior;

            const { fcff } = computeFCFF(inc.ebitda, taxRate, da, capex, deltaWC);
            margins.push(fcff / inc.revenue);
        } else {
            // Fallback: OCF - CapEx
            method = 'ocf_fallback';
            const ocf = cf.operatingCashFlow || 0;
            const capex = cf.capitalExpenditure || 0;
            if (ocf > 0) {
                margins.push((ocf - capex) / inc.revenue);
            }
        }
    }

    if (margins.length === 0) return { margin: 0.10, method: 'ocf_fallback' };

    const avgMargin = margins.reduce((a, b) => a + b, 0) / margins.length;
    return { margin: Math.max(0.05, Math.min(avgMargin, 0.50)), method };
}

// ─────────────────────────────────────────────────────────
// Task 2: 10-Year FCF Projection with Growth Fade
// ─────────────────────────────────────────────────────────

/**
 * Project cash flows over 10 years with EBITDA-based FCFF.
 * Projects line items: revenue → EBITDA → CapEx → D&A → WC delta → FCFF.
 *   Phase 1 (years 1-5): full growth rate
 *   Phase 2 (years 6-10): linear fade toward terminal growth
 */
function projectCashFlows(
    baseRevenue: number,
    growthRate: number,
    _fcfMargin: number,  // retained for API compat; EBITDA components used instead
    ebitdaMargin: number,
    capexToRevenue: number,
    daToRevenue: number,
    effectiveTaxRate: number,
    years: number = PROJECTION_YEARS,
    terminalGrowth: number = TERMINAL_GROWTH_RATE,
): DCFProjection[] {
    const projections: DCFProjection[] = [];
    let revenue = baseRevenue;

    for (let y = 1; y <= years; y++) {
        // Growth rate: full for years 1-5, linear fade for 6-10
        let appliedGrowth: number;
        if (y <= PHASE_1_YEARS) {
            appliedGrowth = growthRate;
        } else {
            const fadeProgress = (y - PHASE_1_YEARS) / (years - PHASE_1_YEARS);
            appliedGrowth = growthRate - (growthRate - terminalGrowth) * fadeProgress;
        }

        revenue = revenue * (1 + appliedGrowth);
        const ebitda = revenue * ebitdaMargin;
        const capex = revenue * capexToRevenue;
        const da = revenue * daToRevenue;
        // WC delta approximated as stable ratio; real delta is captured in margin
        const workingCapitalDelta = 0;

        const { fcff } = computeFCFF(ebitda, effectiveTaxRate, da, capex, workingCapitalDelta);

        projections.push({
            year: y,
            revenue,
            ebitda,
            capex,
            da,
            workingCapitalDelta,
            fcf: fcff,
            growthApplied: appliedGrowth,
            discountedFCF: 0,
        });
    }

    return projections;
}

// ─────────────────────────────────────────────────────────
// Task 3: WACC Calculation (CAPM + Sector Defaults)
// ─────────────────────────────────────────────────────────

function calculateWACC(
    profile: FMPProfile,
    latestBalance: FMPBalanceSheet,
    latestIncome: FMPIncomeStatement,
    overrides?: { costOfEquity?: number; costOfDebt?: number },
    peerBetaResult?: { leveredBeta: number; method: string },
): {
    wacc: number;
    components: { costOfEquity: number; costOfDebt: number; equityWeight: number; debtWeight: number; beta: number; riskFreeRate: number; preferredStockWeight?: number };
    clamped: boolean;
    sector: string;
} {
    const sector = (profile.sector || 'DEFAULT').toUpperCase();
    const defaults = SECTOR_DEFAULTS[sector] || SECTOR_DEFAULTS['DEFAULT'];
    
    // Use peer beta if available, otherwise profile beta, otherwise sector default
    const beta = peerBetaResult?.leveredBeta ?? profile.beta ?? defaults.beta;

    // Cost of equity via CAPM (or override)
    const costOfEquity = overrides?.costOfEquity ?? (RISK_FREE_RATE + beta * EQUITY_RISK_PREMIUM);

    // Capital structure from FMP balance sheet
    const totalDebt = latestBalance.totalDebt || 0;
    const marketCap = profile.mktCap || 0;
    const preferredStock = latestBalance.preferredStock || 0;
    const totalCapital = totalDebt + marketCap + preferredStock;

    const equityWeight = totalCapital > 0 ? marketCap / totalCapital : (1 - defaults.debtRatio);
    const debtWeight = totalCapital > 0 ? totalDebt / totalCapital : defaults.debtRatio;
    const preferredWeight = totalCapital > 0 ? preferredStock / totalCapital : 0;

    // Cost of debt (or override)
    const interestExpense = Math.abs(latestIncome.interestExpense || 0);
    const costOfDebt = overrides?.costOfDebt ?? (totalDebt > 0 ? interestExpense / totalDebt : 0.05);

    // Preferred stock dividend rate (industry average fallback)
    const preferredDividendRate = 0.06;

    // WACC with optional preferred stock term
    let wacc = (equityWeight * costOfEquity) + (debtWeight * costOfDebt * (1 - TAX_RATE));
    if (preferredWeight > 0) {
        wacc += preferredWeight * preferredDividendRate;
    }

    // Sanity clamp: WACC between 6% and 15%
    const clampedWACC = Math.max(0.06, Math.min(wacc, 0.15));

    return {
        wacc: clampedWACC,
        components: {
            costOfEquity, costOfDebt, equityWeight, debtWeight, beta,
            riskFreeRate: RISK_FREE_RATE,
            ...(preferredWeight > 0 ? { preferredStockWeight: preferredWeight } : {}),
        },
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
 * P2.1 — Assemble intrinsic value from projected cash flows and terminal value.
 * Includes equity bridge: Equity Value = Enterprise Value - Net Debt.
 * (FMP's netDebt already = totalDebt - cash, so cash is implicitly included.)
 * Uses fractional discounting when filing date is available.
 */
function calculateIntrinsicValue(
    projections: DCFProjection[],
    wacc: number,
    terminalGrowth: number,
    sharesOutstanding: number,
    netDebt: number = 0,
    _cash: number = 0,
    filingDate?: string,
): {
    enterpriseValue: number;
    equityValue: number;
    intrinsicValuePerShare: number;
    sumDiscountedFCF: number;
    terminalValueContribution: number;
    terminalValuePct: number;
    projections: DCFProjection[];
    terminal: { terminalValue: number; discountedTV: number; terminalGrowth: number };
} {
    const analysisDate = new Date();
    const baseDate = filingDate ? new Date(filingDate) : analysisDate;

    // Discount each year's FCF (fractional when filing date available)
    let sumDiscountedFCF = 0;
    const detailedProjections = projections.map(p => {
        let discountFactor: number;
        if (filingDate) {
            // Fractional discounting: exact year offset from filing date
            const projectedDate = new Date(baseDate);
            projectedDate.setFullYear(projectedDate.getFullYear() + p.year);
            discountFactor = Math.pow(1 + wacc, yearFrac(analysisDate, projectedDate));
        } else {
            discountFactor = Math.pow(1 + wacc, p.year);
        }
        const discountedFCF = p.fcf / discountFactor;
        sumDiscountedFCF += discountedFCF;
        return { ...p, discountedFCF };
    });

    // Terminal value
    const finalYearFCF = projections[projections.length - 1].fcf;
    const tv = calculateTerminalValue(finalYearFCF, wacc, terminalGrowth);

    // Enterprise value = PV(FCFs) + PV(TV)
    const enterpriseValue = sumDiscountedFCF + tv.discountedTV;

    // Equity bridge: EV - Net Debt + Cash (FMP provides netDebt = totalDebt - cash)
    // So: equityValue = EV - netDebt (which already accounts for cash)
    const equityValue = enterpriseValue - netDebt;

    // Per-share value
    const intrinsicValuePerShare = sharesOutstanding > 0 ? equityValue / sharesOutstanding : 0;

    return {
        enterpriseValue,
        equityValue,
        intrinsicValuePerShare,
        sumDiscountedFCF,
        terminalValueContribution: tv.discountedTV,
        terminalValuePct: enterpriseValue > 0 ? tv.discountedTV / enterpriseValue : 0,
        projections: detailedProjections,
        terminal: tv,
    };
}

// ─────────────────────────────────────────────────────────
// P4.1: Sensitivity Analysis
// ─────────────────────────────────────────────────────────

export interface SensitivityResult {
    waccValues: number[];
    tgValues: number[];
    matrix: number[][];
    baseWacc: number;
    baseTg: number;
    baseValue: number;
}

export function runSensitivityAnalysis(
    baseParams: {
        baseRevenue: number;
        baseGrowthRate: number;
        fcfMargin: number;
        ebitdaMargin: number;
        capexToRevenue: number;
        daToRevenue: number;
        effectiveTaxRate: number;
        sharesOutstanding: number;
        netDebt: number;
        terminalGrowth: number;
    },
    baseWacc: number,
    baseTg: number,
): SensitivityResult {
    const waccStep = 0.005; // 0.5%
    const tgStep = 0.0025; // 0.25%

    const waccValues: number[] = [];
    const tgValues: number[] = [];

    // WACC range: ±1% in 0.5% steps (5 values)
    for (let w = baseWacc - 0.01; w <= baseWacc + 0.01; w += waccStep) {
        waccValues.push(Math.max(0.03, Math.min(0.25, w)));
    }

    // Terminal growth: ±0.5% in 0.25% steps (5 values)
    for (let t = baseTg - 0.005; t <= baseTg + 0.005; t += tgStep) {
        tgValues.push(Math.max(0, Math.min(baseWacc - 0.01, t)));
    }

    // Build matrix
    const matrix: number[][] = [];
    for (const wacc of waccValues) {
        const row: number[] = [];
        for (const tg of tgValues) {
            const projections = projectCashFlows(
                baseParams.baseRevenue,
                baseParams.baseGrowthRate,
                baseParams.fcfMargin,
                baseParams.ebitdaMargin,
                baseParams.capexToRevenue,
                baseParams.daToRevenue,
                baseParams.effectiveTaxRate,
                PROJECTION_YEARS,
                tg
            );
            const result = calculateIntrinsicValue(
                projections,
                wacc,
                tg,
                baseParams.sharesOutstanding,
                baseParams.netDebt
            );
            row.push(result.intrinsicValuePerShare);
        }
        matrix.push(row);
    }

    // Find base value (center of matrix)
    const centerRow = Math.floor(waccValues.length / 2);
    const centerCol = Math.floor(tgValues.length / 2);
    const baseValue = matrix[centerRow]?.[centerCol] ?? 0;

    return { waccValues, tgValues, matrix, baseWacc, baseTg, baseValue };
}

// ─────────────────────────────────────────────────────────
// P4.3: Football Field Chart Data
// ─────────────────────────────────────────────────────────

export interface FootballFieldRange {
    label: string;
    low: number;
    high: number;
    currentPrice?: number;
}

export function buildFootballField(
    dcfResult: {
        intrinsicValuePerShare: number;
        enterpriseValue: number;
        sumDiscountedFCF: number;
    },
    sensitivityResult: SensitivityResult | null,
    exitMultipleValue: number,
    currentPrice: number,
    _sharesOutstanding?: number,
): FootballFieldRange[] {
    const ranges: FootballFieldRange[] = [];

    // DCF Base
    ranges.push({
        label: 'DCF (Gordon Growth)',
        low: dcfResult.intrinsicValuePerShare * 0.8,
        high: dcfResult.intrinsicValuePerShare * 1.2,
    });

    // Sensitivity Analysis
    if (sensitivityResult) {
        const flatValues = sensitivityResult.matrix.flat();
        ranges.push({
            label: 'Sensitivity Range',
            low: Math.min(...flatValues),
            high: Math.max(...flatValues),
        });
    }

    // Exit Multiple
    if (exitMultipleValue > 0) {
        ranges.push({
            label: 'Exit Multiple',
            low: exitMultipleValue * 0.8,
            high: exitMultipleValue * 1.2,
        });
    }

    // Market Price
    ranges.push({
        label: 'Current Price',
        low: currentPrice,
        high: currentPrice,
        currentPrice: currentPrice,
    });

    return ranges;
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
    ebitdaMargin: number,
    capexToRevenue: number,
    daToRevenue: number,
    effectiveTaxRate: number,
    wacc: number,
    netDebt: number,
    terminalGrowth: number = TERMINAL_GROWTH_RATE,
): { impliedGrowthRate: number; impliedGrowthFormatted: string; interpretation: string } {
    let low = 0.0;
    let high = 0.50;

    for (let i = 0; i < 50; i++) {
        const mid = (low + high) / 2;
        const proj = projectCashFlows(baseRevenue, mid, fcfMargin, ebitdaMargin, capexToRevenue, daToRevenue, effectiveTaxRate, PROJECTION_YEARS, terminalGrowth);
        const result = calculateIntrinsicValue(proj, wacc, terminalGrowth, sharesOutstanding, netDebt);

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
 * EPS-based quick intrinsic valuation using FMP data.
 * Lightweight alternative to full DCF — uses profile + income statements.
 */
export async function quickDCF(symbol: string): Promise<QuickDCFResult> {
    const sym = symbol.toUpperCase().trim();

    // Fetch minimal FMP data
    const [bundle, priceResult] = await Promise.all([
        fetchDCFDataBundle(sym),
        getPrice({ symbol: sym }),
    ]);

    const { profile, incomeStatements } = bundle;
    const sortedIncome = [...incomeStatements].sort((a, b) => b.date.localeCompare(a.date));

    // Base EPS = latest diluted EPS
    const ttmEPS = sortedIncome[0]?.epsdiluted ?? 0;

    if (ttmEPS <= 0) {
        throw new APIError(
            `Cannot run quick DCF for ${sym}: TTM EPS is non-positive (${ttmEPS.toFixed(2)}).`,
            { symbol: sym, ttmEPS },
        );
    }

    // Growth rate: YoY EPS growth
    const priorEPS = sortedIncome[1]?.epsdiluted ?? 0;
    let growthRate: number;
    if (priorEPS > 0 && ttmEPS > 0) {
        const historicalGrowth = (ttmEPS / priorEPS) - 1;
        growthRate = Math.max(0.02, Math.min(historicalGrowth, 0.35));
    } else {
        growthRate = 0.05;
    }

    // Discount rate from sector beta via CAPM, terminal PE from sector defaults
    const sector = (profile.sector || 'DEFAULT').toUpperCase();
    const defaults = SECTOR_DEFAULTS[sector] || SECTOR_DEFAULTS['DEFAULT'];
    const discountRate = RISK_FREE_RATE + defaults.beta * EQUITY_RISK_PREMIUM;
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
 * Full DCF v5 analysis: EBITDA-based FCFF model with equity bridge,
 * GDP-guarded terminal growth, exit multiple cross-check, and user overrides.
 */
export async function runDCFAnalysis(symbol: string): Promise<DCFResult> {
    const sym = symbol.toUpperCase().trim();
    console.log(`\n📈 [DCF v5] Starting analysis for ${sym}...`);

    // ─── 1. Fetch all data via FMP ────────────────────
    console.log(`📊 [DCF] Step 1: Fetching FMP data bundle...`);
    const [bundle, priceResult] = await Promise.all([
        fetchDCFDataBundle(sym),
        getPrice({ symbol: sym }),
    ]);
    const { profile, incomeStatements, balanceSheets, cashFlowStatements,
            enterpriseValues, analystEstimates, revenueSegments } = bundle;

    // ─── 2. Extract key inputs ───────────────────────
    console.log(`📊 [DCF] Step 2: Extracting inputs...`);
    const sortedIncome = [...incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const sortedBalance = [...balanceSheets].sort((a, b) => b.date.localeCompare(a.date));
    const sortedCashFlow = [...cashFlowStatements].sort((a, b) => b.date.localeCompare(a.date));
    const latestIncome = sortedIncome[0];
    const latestBalance = sortedBalance[0];
    const latestCashFlow = sortedCashFlow[0];
    const baseRevenue = latestIncome.revenue;
    const currentPrice = priceResult.data.price;
    const filingDate = latestIncome.fillingDate;
    const sharesOutstanding = enterpriseValues?.[0]?.numberOfShares || (profile.mktCap / profile.price) || 0;

    if (baseRevenue <= 0) {
        throw new APIError(`Cannot run DCF for ${sym}: latest revenue is zero or negative.`, { symbol: sym, baseRevenue });
    }
    if (sharesOutstanding <= 0) {
        throw new APIError(`Cannot run DCF for ${sym}: shares outstanding is zero or missing.`, { symbol: sym });
    }

    // ─── 3. Derived ratios ───────────────────────────
    const effectiveTaxRate = latestIncome.incomeBeforeTax > 0
        ? Math.max(0, Math.min(latestIncome.incomeTaxExpense / latestIncome.incomeBeforeTax, 0.40))
        : TAX_RATE;
    const ebitdaMargin = baseRevenue > 0 ? (latestIncome.ebitda / baseRevenue) : 0.20;
    const capexToRevenue = latestCashFlow.capitalExpenditure > 0
        ? latestCashFlow.capitalExpenditure / baseRevenue : 0.05;
    const daToRevenue = latestCashFlow.depreciationAndAmortization > 0
        ? latestCashFlow.depreciationAndAmortization / baseRevenue : 0.03;
    const netDebt = latestBalance.netDebt || 0;
    const cash = latestBalance.cashAndCashEquivalents || 0;

    // ─── 4. GDP ceiling ──────────────────────────────
    console.log(`📊 [DCF] Step 3: Resolving GDP ceiling...`);
    const gdpResult = resolveGDPCeiling(profile.country || 'US', revenueSegments);
    const gdpCeiling = gdpResult.gdpCeiling;
    const terminalGrowthRate = Math.min(TERMINAL_GROWTH_RATE, gdpCeiling);
    console.log(`📊 [DCF] Terminal growth: ${(terminalGrowthRate * 100).toFixed(2)}% (GDP ceiling: ${(gdpCeiling * 100).toFixed(2)}%)`);

    // ─── 5. Growth rate ──────────────────────────────
    console.log(`📊 [DCF] Step 4: Selecting growth rate...`);
    const growth = selectGrowthRate(sortedIncome, analystEstimates);
    console.log(`📊 [DCF] Growth: ${(growth.rate * 100).toFixed(2)}% (${growth.source})`);

    // ─── 6. FCF margin ───────────────────────────────
    console.log(`📊 [DCF] Step 5: Computing FCF margin...`);
    const mr = calculateNormalizedFCFMargin(sortedIncome, sortedCashFlow, sortedBalance);
    const fcfMargin = mr.margin;
    const fcfMethod = mr.method;
    console.log(`📊 [DCF] FCF margin: ${(fcfMargin * 100).toFixed(2)}% (${fcfMethod})`);

    // ─── 7. Peer Beta + WACC ─────────────────────────
    console.log(`📊 [DCF] Step 6: Calculating peer beta & WACC...`);
    const sector = (profile.sector || 'DEFAULT').toUpperCase();
    const sectorDefaults = SECTOR_DEFAULTS[sector] || SECTOR_DEFAULTS['DEFAULT'];
    const targetDE = profile.mktCap > 0 ? (latestBalance.totalDebt || 0) / profile.mktCap : 0;
    const peerBetaResult = await calculatePeerBeta(
        bundle.peers,
        targetDE,
        effectiveTaxRate,
        profile.beta ?? sectorDefaults.beta
    );
    console.log(`📊 [DCF] Beta: ${peerBetaResult.leveredBeta.toFixed(3)} (${peerBetaResult.method}, ${peerBetaResult.peersUsed.length} peers)`);

    const waccResult = calculateWACC(profile, latestBalance, latestIncome, {}, peerBetaResult);
    console.log(`📊 [DCF] WACC: ${(waccResult.wacc * 100).toFixed(2)}%${waccResult.clamped ? ' (clamped)' : ''}`);

    // ─── F1: Check for Financial Institutions ─────────────
    console.log(`📊 [DCF] Step 6b: Checking for financial institution...`);
    const finCheck = detectFinancialInstitution(
        { sector: profile.sector, industry: profile.industry },
        { netInterestIncome: latestIncome.interestIncome, interestExpense: latestIncome.interestExpense }
    );

    let modelUsed = 'standard_dcf';
    let altValuationResult: DDMResult | FFOResult | FCFEResult | null = null;
    let finCostOfEquity = 0;
    let finTerminalGrowthRate = terminalGrowthRate;

    if (finCheck.isFinancialInstitution && finCheck.type) {
        console.log(`🏦 [DCF] Financial institution detected: ${finCheck.type} - ${finCheck.reason}`);
        modelUsed = `financial_${finCheck.type.toLowerCase()}`;

        // Calculate cost of equity using CAPM (not WACC for financial institutions)
        finCostOfEquity = RISK_FREE_RATE + peerBetaResult.leveredBeta * EQUITY_RISK_PREMIUM;
        finTerminalGrowthRate = Math.min(TERMINAL_GROWTH_RATE, gdpCeiling);

        switch (finCheck.type) {
            case 'BANK':
            case 'INSURANCE': {
                // Calculate EPS properly - use net income / shares if epsdiluted is missing/zero
                let latestEPS = latestIncome.epsdiluted;
                if (!latestEPS || latestEPS <= 0) {
                    // Fallback: use diluted EPS from income statement net income
                    latestEPS = latestIncome.netIncome / sharesOutstanding;
                }
                // If still invalid (e.g., 0 shares), use a reasonable EPS proxy
                if (!latestEPS || latestEPS <= 0 || !isFinite(latestEPS)) {
                    console.warn(`⚠️ [DCF] Cannot calculate DDM - invalid EPS (${latestEPS}). Falling back to book value method.`);
                    // Use book value per share as minimum floor
                    const bvPerShare = latestBalance.totalStockholdersEquity ? latestBalance.totalStockholdersEquity / sharesOutstanding : 0;
                    altValuationResult = {
                        intrinsicValue: bvPerShare, // Use book value as floor
                        stage1PV: 0,
                        terminalValue: 0,
                        terminalPV: 0,
                        dividendsProjected: [],
                    };
                } else {
                    const dividendsPaid = Math.abs(latestCashFlow.dividendsPaid ?? 0);
                    let payoutRatio = 0.30;
                    if (latestIncome.netIncome && latestIncome.netIncome > 0 && dividendsPaid > 0) {
                        payoutRatio = Math.min(dividendsPaid / latestIncome.netIncome, 1.0);
                    }
                    if (payoutRatio <= 0 || payoutRatio > 1 || !isFinite(payoutRatio)) {
                        payoutRatio = 0.30;
                        console.log(`⚠️ [DCF] DDM payout ratio invalid - using default 30%`);
                    } else {
                        console.log(`📊 [DCF] DDM payout ratio: ${(payoutRatio * 100).toFixed(1)}% (dividends: $${dividendsPaid.toFixed(0)}M / NI: $${latestIncome.netIncome.toFixed(0)}M)`);
                    }
                    const bookValuePerShare = latestBalance.totalStockholdersEquity ? latestBalance.totalStockholdersEquity / sharesOutstanding : undefined;
                    const roe = latestBalance.totalStockholdersEquity ? latestIncome.netIncome / latestBalance.totalStockholdersEquity : undefined;
                    const finGrowthRate = Math.min(growth.rate, 0.08);
                    altValuationResult = calculateDDM(latestEPS, payoutRatio, finGrowthRate, finCostOfEquity, finTerminalGrowthRate, sharesOutstanding, bookValuePerShare, roe);
                }
                console.log(`📊 [DCF] DDM: Intrinsic Value = $${altValuationResult.intrinsicValue.toFixed(2)}`);
                break;
            }
            case 'REIT': {
                const netIncome = latestIncome.netIncome ?? 0;
                const depreciation = latestCashFlow.depreciationAndAmortization ?? 0;
                if (netIncome <= 0 || sharesOutstanding <= 0) {
                    console.warn(`⚠️ [DCF] Cannot calculate FFO - invalid data.`);
                    altValuationResult = null;
                } else {
                    altValuationResult = calculateFFO(netIncome, depreciation, 0, Math.min(growth.rate, 0.06), finCostOfEquity, finTerminalGrowthRate, sharesOutstanding);
                }
                console.log(`📊 [DCF] FFO: Intrinsic Value = $${altValuationResult?.intrinsicValue?.toFixed(2) ?? 'N/A'}`);
                break;
            }
            case 'ASSET_MANAGER': {
                const netIncome = latestIncome.netIncome ?? 0;
                const capex = latestCashFlow.capitalExpenditure ?? 0;
                const depreciation = latestCashFlow.depreciationAndAmortization ?? 0;
                const wcChange = latestCashFlow.changeInWorkingCapital ?? 0;
                if (netIncome <= 0 || sharesOutstanding <= 0) {
                    console.warn(`⚠️ [DCF] Cannot calculate FCFE - invalid data.`);
                    altValuationResult = null;
                } else {
                    const debtRatio = targetDE / (1 + targetDE);
                    altValuationResult = calculateFCFE(netIncome, capex, depreciation, wcChange, debtRatio, Math.min(growth.rate, 0.08), finCostOfEquity, finTerminalGrowthRate, sharesOutstanding);
                }
                console.log(`📊 [DCF] FCFE: Intrinsic Value = $${altValuationResult?.intrinsicValue?.toFixed(2) ?? 'N/A'}`);
                break;
            }
        }
    }

    // For financial institutions, SKIP standard DCF entirely - it gives garbage results
    if (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue <= 0) {
        console.warn(`⚠️ [DCF] Financial institution valuation failed - cannot compute ${finCheck.type} model.`);
    }

    // ─── 8. Project 10 years ─────────────────────────
    console.log(`📊 [DCF] Step 7: Projecting cash flows...`);
    const projections = projectCashFlows(baseRevenue, growth.rate, fcfMargin, ebitdaMargin,
        capexToRevenue, daToRevenue, effectiveTaxRate, PROJECTION_YEARS, terminalGrowthRate);

    // ─── 9. Intrinsic value + equity bridge ──────────
    console.log(`📊 [DCF] Step 8: Computing intrinsic value...`);
    const valuation = calculateIntrinsicValue(projections, waccResult.wacc, terminalGrowthRate,
        sharesOutstanding, netDebt, cash, filingDate);
    console.log(`📊 [DCF] EV: $${(valuation.enterpriseValue / 1e9).toFixed(2)}B | Equity: $${(valuation.equityValue / 1e9).toFixed(2)}B | Per share: $${valuation.intrinsicValuePerShare.toFixed(2)}`);

    // ─── 10. Exit multiple cross-check ───────────────
    const finalEBITDA = projections[projections.length - 1].ebitda;
    const exitMultiple = calculateExitMultipleTV(finalEBITDA, sectorDefaults.ebitdaMultiple, waccResult.wacc);

    // ─── 11. Reverse DCF ─────────────────────────────
    console.log(`📊 [DCF] Step 9: Running reverse DCF...`);
    const reverseDCFResult = reverseDCF(currentPrice, sharesOutstanding, baseRevenue, fcfMargin,
        ebitdaMargin, capexToRevenue, daToRevenue, effectiveTaxRate, waccResult.wacc, netDebt, terminalGrowthRate);

    // ─── 12. Warnings & output ───────────────────────
    const upside = (valuation.intrinsicValuePerShare - currentPrice) / currentPrice;
    const warnings = generateWarnings(growth, waccResult, valuation, fcfMargin);
    // Note: GDP ceiling enforcement for user overrides happens in step 4 above (throws).
    // This warning catches auto-calculated edge cases (should be rare due to Math.min clamp).
    if (terminalGrowthRate > gdpCeiling) {
        warnings.push(`Terminal growth (${(terminalGrowthRate * 100).toFixed(1)}%) exceeds GDP ceiling (${(gdpCeiling * 100).toFixed(1)}%).`);
    }

    // ─── 13. Sensitivity Analysis & Football Field ───────────────────────
    const sensitivityResult = finCheck.isFinancialInstitution ? null : runSensitivityAnalysis(
        { baseRevenue, baseGrowthRate: growth.rate, fcfMargin, ebitdaMargin, capexToRevenue, daToRevenue, effectiveTaxRate, sharesOutstanding, netDebt, terminalGrowth: terminalGrowthRate },
        waccResult.wacc,
        terminalGrowthRate
    );

    const footballField = finCheck.isFinancialInstitution ? null : buildFootballField(
        { intrinsicValuePerShare: valuation.intrinsicValuePerShare, enterpriseValue: valuation.enterpriseValue, sumDiscountedFCF: valuation.sumDiscountedFCF },
        sensitivityResult,
        exitMultiple.discountedExitMultipleTV / sharesOutstanding,
        currentPrice
    );

    const result: DCFResult = {
        metadata: {
            companyName: profile.companyName, ticker: sym,
            sector: profile.sector || 'Unknown', dcfMethod: modelUsed !== 'standard_dcf' ? modelUsed : 'ebitda_based_fcff',
            analysisDate: new Date().toISOString(),
            financialInstitution: finCheck.isFinancialInstitution ? { type: finCheck.type, reason: finCheck.reason } : undefined,
        },
        currentMarketData: { currentPrice, marketCap: profile.mktCap || 0, sharesOutstanding },
        growthAnalysis: {
            selectedGrowthRate: growth.rate, growthSource: growth.source,
            revenueCAGR3yr: growth.raw, normalizedFCFMargin: fcfMargin, fcffMethod: fcfMethod,
        },
        waccCalculation: {
            wacc: waccResult.wacc, waccFormatted: (waccResult.wacc * 100).toFixed(2) + '%',
            components: waccResult.components, sector: waccResult.sector,
            betaSource: peerBetaResult.method,
        },
        projections: valuation.projections.map(p => ({
            year: p.year, revenue: Math.round(p.revenue), ebitda: Math.round(p.ebitda),
            fcf: Math.round(p.fcf), growthRate: (p.growthApplied * 100).toFixed(2) + '%',
            discountedFCF: Math.round(p.discountedFCF),
        })),
        terminalValue: {
            method: 'gordon_growth',
            terminalGrowth: (valuation.terminal.terminalGrowth * 100).toFixed(2) + '%',
            undiscountedValue: Math.round(valuation.terminal.terminalValue),
            discountedValue: Math.round(valuation.terminal.discountedTV),
            percentOfTotal: (valuation.terminalValuePct * 100).toFixed(1) + '%',
        },
        terminalValueCrossCheck: {
            method: 'ebitda_exit_multiple', multiple: exitMultiple.multiple,
            undiscountedValue: Math.round(exitMultiple.exitMultipleTV),
            discountedValue: Math.round(exitMultiple.discountedExitMultipleTV),
            percentOfTotal: valuation.enterpriseValue > 0
                ? (exitMultiple.discountedExitMultipleTV / (valuation.sumDiscountedFCF + exitMultiple.discountedExitMultipleTV) * 100).toFixed(1) + '%' : '0%',
        },
        equityBridge: {
            enterpriseValue: Math.round(valuation.enterpriseValue), netDebt: Math.round(netDebt),
            cash: Math.round(cash), equityValue: Math.round(valuation.equityValue),
        },
        valuationSummary: {
            // For financial institutions, ONLY use the DDM/FFO/FCFE result - NEVER fall back to standard DCF
            intrinsicValue: (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
                ? Math.round(altValuationResult.intrinsicValue * 100) / 100
                : (finCheck.isFinancialInstitution ? 0 : Math.round(valuation.intrinsicValuePerShare * 100) / 100),
            currentPrice,
            upsideDownside: (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
                ? (((altValuationResult.intrinsicValue - currentPrice) / currentPrice * 100).toFixed(2) + '%')
                : (finCheck.isFinancialInstitution ? 'N/A' : (upside * 100).toFixed(2) + '%'),
            valuation: (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
                ? (altValuationResult.intrinsicValue > currentPrice * 1.15 ? 'UNDERVALUED' :
                   altValuationResult.intrinsicValue < currentPrice * 0.85 ? 'OVERVALUED' : 'FAIRLY_VALUED')
                : (finCheck.isFinancialInstitution ? 'USE_MARKET_PRICE' :
                   (upside > 0.15 ? 'UNDERVALUED' : upside < -0.15 ? 'OVERVALUED' : 'FAIRLY_VALUED')),
        },
        reverseDCF: reverseDCFResult,
        investmentRecommendation: {
            recommendation: (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
                ? (altValuationResult.intrinsicValue > currentPrice * 1.20 ? 'BUY' :
                   altValuationResult.intrinsicValue < currentPrice * 0.80 ? 'SELL' : 'HOLD')
                : (finCheck.isFinancialInstitution ? 'USE_MARKET_PRICE' : 
                   (upside > 0.20 ? 'BUY' : upside > -0.10 ? 'HOLD' : 'SELL')),
            confidence: (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0) ? 'Medium' : 'Low',
            reasoning: (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
                ? `Financial institution valuation using ${modelUsed.replace('financial_', '').toUpperCase()} model. ` +
                  `Cost of Equity: ${(finCostOfEquity * 100).toFixed(1)}%, Terminal Growth: ${(finTerminalGrowthRate * 100).toFixed(1)}%.`
                : (finCheck.isFinancialInstitution 
                    ? `Banking/Financial institutions are not valued using standard DCF methods. ` +
                      `For banks, debt is a raw material (deposits fund loans), not capital — making FCFF/WACC unreliable. ` +
                      `Use current market price: $${currentPrice.toFixed(2)} for reference.`
                    : `Based on ${growth.source} growth of ${(growth.rate * 100).toFixed(1)}%, ` +
                      `WACC of ${(waccResult.wacc * 100).toFixed(1)}%, ` +
                      `FCF margin of ${(fcfMargin * 100).toFixed(1)}% (${fcfMethod}). ` +
                      `Market implies ${reverseDCFResult.impliedGrowthFormatted} growth.`),
        },
        keyAssumptions: {
            baseRevenue, effectiveTaxRate, ebitdaMargin, capexToRevenue, daToRevenue,
            gdpCeiling, gdpCountry: gdpResult.country, filingDate: filingDate || 'N/A',
        },
        warnings,
        sensitivityAnalysis: sensitivityResult || undefined,
        footballField: footballField || undefined,
    };

    console.log(`✅ [DCF v5] Complete for ${sym}. IV: $${valuation.intrinsicValuePerShare.toFixed(2)} | Price: $${currentPrice.toFixed(2)} | Upside: ${(upside * 100).toFixed(1)}%`);
    return result;
}

