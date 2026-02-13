/**
 * DCF (Discounted Cash Flow) Analysis Service — v3
 * 
 * v3 fixes addressing the AAPL $127 catastrophe:
 *   1. Graduated sanity gate (Critical/Warning/Normal) with confidence override
 *   2. Recency-weighted growth with quarterly data + inflection detection
 *   3. Net buyback yield from shares outstanding change
 *   4. Tiered ERP by market cap + net cash WACC discount
 *   5. Implied EV/FCF gap disclosure
 * 
 * Pipeline: Data Collection → Quarterly Recency → Buyback Yield → Growth Analysis →
 *           WACC (tiered) → Projections → Terminal Value → Discounting →
 *           Intrinsic Value → Sanity Gate (graduated) → Reverse DCF →
 *           Premium Analysis → Sensitivity → Output
 */

import {
    fetchCompanyOverview,
    fetchFinancialStatements,
    fetchTreasuryYield,
    fetchAnnualEarnings,
    type CompanyOverview,
    type FinancialStatement,
} from './fundamentals-alphavantage.js';
import { APIError } from '../types.js';

// ─────────────────────────────────────────────────────────
// Constants & Defaults
// ─────────────────────────────────────────────────────────

const TERMINAL_GROWTH_RATE = 0.025;
const DEFAULT_EXIT_EV_FCF = 20;
const DEFAULT_EXIT_PE = 20;
const PROJECTION_YEARS = 10;
const PHASE_1_YEARS = 5;
const MAX_GROWTH_CAP = 0.50;
const MIN_LONG_TERM_GROWTH = 0.03;
const MAX_LONG_TERM_GROWTH = 0.20;
const SENSITIVITY_WACC_DELTA = 0.02;
const DEFAULT_BETA = 1.0;
const DEFAULT_TAX_RATE = 0.21;

// Graduated sanity gate thresholds (v3)
const SANITY_CRITICAL_LOW = 0.50;
const SANITY_WARNING_LOW = 0.70;
const SANITY_WARNING_HIGH = 1.50;
const SANITY_CRITICAL_HIGH = 2.50;

// Net cash WACC discount
const NET_CASH_WACC_DISCOUNT = 0.0025; // 25bps

// Composite growth weights
const GROWTH_WEIGHTS = {
    revenue: 0.30,
    operatingIncome: 0.25,
    normalizedFCF: 0.25,
    ownerEarnings: 0.20,
};

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface DCFResult {
    metadata: {
        ticker: string;
        companyName: string;
        analysisDate: string;
        dcfMethod: 'fcf_based' | 'earnings_based';
        dataSource: string;
    };
    currentMarketData: {
        currentPrice: number;
        marketCap: number;
        sharesOutstanding: number;
        currentPE: number | null;
        beta: number;
    };
    historicalData: {
        yearsAnalyzed: number;
        annualData: Array<{
            year: number;
            revenue?: number;
            eps?: number;
            freeCashFlow?: number;
            normalizedFCF?: number;
            ownerEarnings?: number;
            operatingCashFlow?: number;
            capex?: number;
            depreciationAndAmortization?: number;
            maintenanceCapex?: number;
            growthCapex?: number;
        }>;
    };
    capexAnalysis: {
        isInvestmentCycle: boolean;
        avgGrowthCapexPct: number;
        interpretation: string;
    };
    growthAnalysis: {
        historicalGrowthRates: {
            revenueCagr3yr: number | null;
            opIncomeCagr3yr: number | null;
            normalizedFcfCagr3yr: number | null;
            ownerEarningsCagr3yr: number | null;
            rawFcfCagr3yr: number | null;
            growthTrend: string;
        };
        recencyAnalysis?: {
            quarterlyGrowthUsed: boolean;
            inflectionDetected: 'Accelerating' | 'Decelerating' | 'Stable';
            ttmGrowthRate: number | null;
            recencyWeights: { ttm: number; priorYear: number; yearBefore: number };
            adjustedGrowthRate: number | null;
        };
        buybackAnalysis: {
            netBuybackYield: number;
            organicGrowth: number;
            effectivePerShareGrowth: number;
            sharesOutstandingCurrent?: number;
            sharesOutstandingPrior?: number;
        };
        compositeGrowth: {
            rate: number;
            signalBreakdown: Array<{ signal: string; weight: number; value: number | null; contribution: number }>;
            capexAdjusted: boolean;
        };
        projectionAssumptions: {
            phase1: { years: string; growthRate: number; rationale: string };
            phase2: { years: string; growthRate: number; rationale: string };
        };
    };
    waccCalculation: {
        wacc: number;
        waccFormatted: string;
        netCashDiscount: boolean;
        components: {
            costOfEquity: { value: number; riskFreeRate: number; beta: number; marketRiskPremium: number; formula: string };
            costOfDebt: { preTax: number; afterTax: number; interestExpense: number; totalDebt: number; taxRate: number };
            capitalStructure: { marketCap: number; totalDebt: number; equityWeight: number; debtWeight: number };
        };
    };
    cashFlowProjections: {
        baseValue: number;
        baseMetric: string;
        projections: Array<{
            year: number;
            calendarYear: number;
            projectedValue: number;
            growthRate: number;
            phase: string;
        }>;
    };
    terminalValue: {
        terminalYear: number;
        finalCashFlow: number;
        methods: {
            perpetuityGrowth: { growthRate: number; terminalValue: number };
            exitMultiple: { multiple: number; multipleType: string; terminalValue: number };
            average: number;
        };
        validation: { gapBetweenMethods: number; gapAcceptable: boolean; warnings: string[] };
    };
    presentValueAnalysis: {
        discountRate: number;
        sumPvCashFlows: number;
        terminalValuePv: number;
        totalPv: number;
    };
    valuationSummary: {
        enterpriseValuePerShare: number;
        netDebt: number;
        netDebtPerShare: number;
        intrinsicValue: number;
        currentPrice: number;
        upsideDownside: number;
        upsideDownsideFormatted: string;
        valuation: string;
    };
    reverseDCF: {
        impliedGrowthRate: number;
        impliedGrowthFormatted: string;
        modelGrowthRate: number;
        gapPercent: number;
        interpretation: string;
    };
    sanityCheck: {
        severity: 'normal' | 'warning' | 'critical';
        anomalyDetected: boolean;
        intrinsicVsMarketRatio: number;
        flags: string[];
        driverAnalysis: string;
    };
    premiumAnalysis?: {
        modelImpliedEvFcf: number;
        marketEvFcf: number;
        premiumGap: number;
        warning?: string;
    };
    investmentRecommendation: {
        recommendation: string;
        confidence: string;
        rationale: string;
        targetPrice: number;
        expectedReturn: number;
    };
    sensitivityAnalysis: {
        waccSensitivity: Array<{ scenario: string; wacc: number; intrinsicValue: number; upsideDownside: number }>;
        growthSensitivity: Array<{ scenario: string; phase1Growth: number; phase2Growth: number; intrinsicValue: number; upsideDownside: number }>;
        terminalGrowthSensitivity: Array<{ terminalGrowth: number; intrinsicValue: number; impactVsBase: number }>;
    };
    riskFactors: {
        modelRisks: string[];
        valuationRisks: string[];
        companyRisks: string[];
    };
    dataQuality: {
        completeness: string;
        historicalYears: number;
        dataGaps: string[];
    };
    assumptionsUsed: {
        marketRiskPremium: number;
        terminalGrowthRate: number;
        projectionPeriod: number;
        discountRateSource: string;
        growthRateSource: string;
        growthWeights: typeof GROWTH_WEIGHTS;
    };
}

// ─────────────────────────────────────────────────────────
// Core Calculation Functions
// ─────────────────────────────────────────────────────────

function calculateCAGR(beginningValue: number, endingValue: number, years: number): number | null {
    if (beginningValue <= 0 || endingValue <= 0 || years <= 0) return null;
    return Math.pow(endingValue / beginningValue, 1 / years) - 1;
}

/** Calculate Normalized FCF: Operating Cash Flow minus maintenance capex (D&A proxy) */
function calculateNormalizedFCF(operatingCashFlow: number, depreciationAndAmortization: number): number {
    return operatingCashFlow - depreciationAndAmortization;
}

/** Calculate Owner Earnings (Buffett): Net Income + D&A - Maintenance Capex (D&A) ≈ Net Income */
function calculateOwnerEarnings(netIncome: number, da: number): number {
    // Owner Earnings = Net Income + D&A - Maintenance Capex
    // Since Maintenance Capex ≈ D&A, this simplifies, but we keep D&A explicit
    // to show the components. Owner Earnings ≈ NetIncome when maintenance=D&A.
    // However, a more useful formulation: NI + D&A - maintenanceCapex
    // where maintenanceCapex = D&A, so it's NI. But for transparency, compute explicitly:
    const maintenanceCapex = da;
    return netIncome + da - maintenanceCapex;
}

/** Detect capex anomaly: FCF declining while revenue is growing */
function detectCapexAnomaly(
    statements: FinancialStatement[],
): { isAnomaly: boolean; avgGrowthCapexPct: number; interpretation: string } {
    if (statements.length < 2) return { isAnomaly: false, avgGrowthCapexPct: 0, interpretation: 'Insufficient data' };

    const sorted = [...statements].sort((a, b) => a.fiscalYear - b.fiscalYear);

    // Check revenue growth vs FCF growth
    const recentRevGrowth = sorted.length >= 2
        ? ((sorted[sorted.length - 1].revenue ?? 0) / (sorted[sorted.length - 2].revenue ?? 1)) - 1
        : 0;

    const recentFCFGrowth = sorted.length >= 2 && sorted[sorted.length - 2].freeCashFlow && sorted[sorted.length - 2].freeCashFlow! > 0
        ? ((sorted[sorted.length - 1].freeCashFlow ?? 0) / sorted[sorted.length - 2].freeCashFlow!) - 1
        : 0;

    // Growth capex decomposition
    const growthCapexPcts: number[] = [];
    for (const stmt of sorted) {
        const totalCapex = Math.abs(stmt.capitalExpenditures ?? 0);
        const maintenanceCapex = stmt.depreciationAndAmortization ?? 0;
        if (totalCapex > 0) {
            const growthCapex = Math.max(0, totalCapex - maintenanceCapex);
            growthCapexPcts.push(growthCapex / totalCapex);
        }
    }

    const avgGrowthCapexPct = growthCapexPcts.length > 0
        ? growthCapexPcts.reduce((a, b) => a + b, 0) / growthCapexPcts.length
        : 0;

    const isAnomaly = recentRevGrowth > 0.10 && recentFCFGrowth < 0;

    let interpretation = '';
    if (isAnomaly) {
        interpretation = `Revenue grew ${(recentRevGrowth * 100).toFixed(1)}% but FCF declined ${(recentFCFGrowth * 100).toFixed(1)}% — ` +
            `likely due to elevated growth capex (${(avgGrowthCapexPct * 100).toFixed(0)}% of total capex is growth investment). ` +
            `Growth weights adjusted to favor revenue and operating income signals.`;
    } else if (avgGrowthCapexPct > 0.40) {
        interpretation = `Significant growth capex (${(avgGrowthCapexPct * 100).toFixed(0)}% of total) indicates active investment cycle. ` +
            `Using normalized FCF (OCF − D&A) to smooth capex distortion.`;
    } else {
        interpretation = `Capex profile is normal — growth capex is ${(avgGrowthCapexPct * 100).toFixed(0)}% of total. ` +
            `Standard FCF-based approach is appropriate.`;
    }

    return { isAnomaly, avgGrowthCapexPct, interpretation };
}

/**
 * Compute composite growth rate from multiple signals
 */
function computeCompositeGrowth(
    revCagr: number | null,
    opIncomeCagr: number | null,
    normalizedFcfCagr: number | null,
    ownerEarningsCagr: number | null,
    capexAnomaly: boolean,
): {
    rate: number;
    breakdown: Array<{ signal: string; weight: number; value: number | null; contribution: number }>;
    capexAdjusted: boolean;
} {
    let weights = { ...GROWTH_WEIGHTS };

    // During capex anomaly: boost revenue/OpIncome, reduce FCF weight
    if (capexAnomaly) {
        weights = {
            revenue: 0.40,
            operatingIncome: 0.30,
            normalizedFCF: 0.15,
            ownerEarnings: 0.15,
        };
    }

    const signals: Array<{ signal: string; weight: number; value: number | null }> = [
        { signal: 'Revenue CAGR (3yr)', weight: weights.revenue, value: revCagr },
        { signal: 'Operating Income CAGR (3yr)', weight: weights.operatingIncome, value: opIncomeCagr },
        { signal: 'Normalized FCF CAGR (3yr)', weight: weights.normalizedFCF, value: normalizedFcfCagr },
        { signal: 'Owner Earnings CAGR (3yr)', weight: weights.ownerEarnings, value: ownerEarningsCagr },
    ];

    // Compute weighted average, redistributing weight of null signals
    const available = signals.filter(s => s.value !== null);
    if (available.length === 0) {
        return {
            rate: 0.10, // Fallback: assume 10%
            breakdown: signals.map(s => ({ ...s, contribution: 0 })),
            capexAdjusted: capexAnomaly,
        };
    }

    const totalAvailableWeight = available.reduce((sum, s) => sum + s.weight, 0);
    let compositeRate = 0;

    const breakdown = signals.map(s => {
        if (s.value === null) {
            return { ...s, contribution: 0 };
        }
        const adjustedWeight = s.weight / totalAvailableWeight; // Normalize
        const contribution = adjustedWeight * s.value;
        compositeRate += contribution;
        return { ...s, weight: adjustedWeight, contribution };
    });

    // Apply caps
    compositeRate = Math.min(compositeRate, MAX_GROWTH_CAP);
    compositeRate = Math.max(compositeRate, 0.02);

    return {
        rate: compositeRate,
        breakdown,
        capexAdjusted: capexAnomaly,
    };
}

/**
 * Determine two-stage growth rates from composite
 */
function determinePhaseRates(
    compositeRate: number,
): { phase1: number; phase2: number; rationale1: string; rationale2: string } {
    const phase1 = compositeRate; // Use composite directly

    let phase2 = compositeRate * 0.65; // Taper to 65% of Phase 1
    phase2 = Math.max(phase2, MIN_LONG_TERM_GROWTH);
    phase2 = Math.min(phase2, MAX_LONG_TERM_GROWTH);

    return {
        phase1,
        phase2,
        rationale1: `Multi-signal composite growth (revenue, OpIncome, normalized FCF, owner earnings)`,
        rationale2: `Tapering toward mature growth rate; 65% of Phase 1`,
    };
}

// ─────────────────────────────────────────────────────────
// WACC Functions
// ─────────────────────────────────────────────────────────

/** Tiered Equity Risk Premium by market cap (v3) */
function getMarketRiskPremium(marketCap: number): number {
    if (marketCap >= 500e9) return 0.0475;  // Mega-cap: minimal idiosyncratic risk
    if (marketCap >= 50e9) return 0.0525;  // Large-cap
    if (marketCap >= 10e9) return 0.0575;  // Mid-cap
    return 0.0625;                            // Small-cap: full equity risk premium
}

function calculateCostOfEquity(riskFreeRate: number, beta: number, marketCap: number): number {
    const erp = getMarketRiskPremium(marketCap);
    return riskFreeRate + beta * erp;
}

function calculateCostOfDebt(interestExpense: number, totalDebt: number, taxRate: number): { preTax: number; afterTax: number } {
    if (totalDebt <= 0) return { preTax: 0, afterTax: 0 };
    const preTax = interestExpense / totalDebt;
    return { preTax, afterTax: preTax * (1 - taxRate) };
}

function calculateWACC(
    marketCap: number,
    totalDebt: number,
    costOfEquity: number,
    costOfDebtAfterTax: number,
): { wacc: number; equityWeight: number; debtWeight: number } {
    const totalValue = marketCap + totalDebt;
    const equityWeight = totalValue > 0 ? marketCap / totalValue : 1;
    const debtWeight = totalValue > 0 ? totalDebt / totalValue : 0;
    const wacc = equityWeight * costOfEquity + debtWeight * costOfDebtAfterTax;
    return { wacc, equityWeight, debtWeight };
}

// ─────────────────────────────────────────────────────────
// Projection & Valuation Functions
// ─────────────────────────────────────────────────────────

function projectCashFlows(
    baseValue: number,
    phase1Rate: number,
    phase2Rate: number,
    baseYear: number,
): Array<{ year: number; calendarYear: number; value: number; growthRate: number; phase: string }> {
    const projections: Array<{ year: number; calendarYear: number; value: number; growthRate: number; phase: string }> = [];
    let current = baseValue;

    for (let yr = 1; yr <= PROJECTION_YEARS; yr++) {
        const rate = yr <= PHASE_1_YEARS ? phase1Rate : phase2Rate;
        const phase = yr <= PHASE_1_YEARS ? 'Phase 1 (High Growth)' : 'Phase 2 (Moderate Growth)';
        current = current * (1 + rate);
        projections.push({ year: yr, calendarYear: baseYear + yr, value: current, growthRate: rate, phase });
    }

    return projections;
}

/**
 * Calculate terminal value using both methods
 * For FCF-based: uses EV/FCF multiple
 * For earnings-based: uses P/E multiple
 */
function calculateTerminalValue(
    finalCashFlow: number,
    wacc: number,
    exitMultiple: number,
    _multipleType: string,
): {
    perpetuity: number;
    exitMult: number;
    average: number;
    gap: number;
    warnings: string[];
} {
    if (wacc <= TERMINAL_GROWTH_RATE) {
        throw new Error('WACC must be greater than terminal growth rate');
    }
    const perpetuity = (finalCashFlow * (1 + TERMINAL_GROWTH_RATE)) / (wacc - TERMINAL_GROWTH_RATE);
    const exitMult = finalCashFlow * exitMultiple;
    const average = (perpetuity + exitMult) / 2;
    const gap = Math.abs(perpetuity - exitMult) / Math.min(Math.abs(perpetuity), Math.abs(exitMult));

    const warnings: string[] = [];
    if (gap > 0.50) {
        warnings.push(`Terminal value methods differ by ${(gap * 100).toFixed(1)}% — review assumptions`);
    }

    return { perpetuity, exitMult, average, gap, warnings };
}

function discountToPresent(cashFlows: number[], wacc: number): { pvs: number[]; total: number } {
    const pvs = cashFlows.map((cf, i) => cf / Math.pow(1 + wacc, i + 1));
    const total = pvs.reduce((sum, pv) => sum + pv, 0);
    return { pvs, total };
}

/**
 * Shared intrinsic value computation — used by BOTH base case and sensitivity.
 * This eliminates the inconsistency where sensitivity used different terminal value methods.
 */
function computeIntrinsicValue(
    projectedCashFlows: number[],
    wacc: number,
    exitMultiple: number,
    multipleType: string,
    totalDebt: number,
    cash: number,
    sharesOutstanding: number,
): { intrinsicPerShare: number; enterpriseValue: number; netDebt: number; pvCashFlows: number; pvTerminalValue: number } {
    const { total: pvCashFlows } = discountToPresent(projectedCashFlows, wacc);

    const finalCF = projectedCashFlows[projectedCashFlows.length - 1];
    const tv = calculateTerminalValue(finalCF, wacc, exitMultiple, multipleType);
    const pvTerminalValue = tv.average / Math.pow(1 + wacc, PROJECTION_YEARS);

    const enterpriseValue = pvCashFlows + pvTerminalValue;
    const netDebt = totalDebt - cash;
    const equityValue = enterpriseValue - netDebt;
    const intrinsicPerShare = sharesOutstanding > 0 ? equityValue / sharesOutstanding : 0;

    return { intrinsicPerShare, enterpriseValue, netDebt, pvCashFlows, pvTerminalValue };
}

// ─────────────────────────────────────────────────────────
// Reverse DCF
// ─────────────────────────────────────────────────────────

/**
 * Solve for the implied growth rate that justifies the current market price.
 * Uses binary search since the relationship is monotonic.
 */
function reverseImpliedGrowth(
    currentPrice: number,
    sharesOutstanding: number,
    baseValue: number,
    wacc: number,
    exitMultiple: number,
    multipleType: string,
    totalDebt: number,
    cash: number,
    baseYear: number,
): number {
    const targetEV = currentPrice * sharesOutstanding + totalDebt - cash;

    let low = -0.10;
    let high = 0.60;

    for (let iter = 0; iter < 50; iter++) {
        const mid = (low + high) / 2;
        const phase2 = Math.max(mid * 0.65, MIN_LONG_TERM_GROWTH);
        const proj = projectCashFlows(baseValue, mid, phase2, baseYear);
        const projValues = proj.map(p => p.value);

        const { total: pvCF } = discountToPresent(projValues, wacc);
        const finalCF = projValues[projValues.length - 1];
        const tv = calculateTerminalValue(finalCF, wacc, exitMultiple, multipleType);
        const pvTV = tv.average / Math.pow(1 + wacc, PROJECTION_YEARS);
        const ev = pvCF + pvTV;

        if (ev < targetEV) {
            low = mid;
        } else {
            high = mid;
        }

        if (Math.abs(high - low) < 0.001) break;
    }

    return (low + high) / 2;
}

// ─────────────────────────────────────────────────────────
// v3: Buyback, Recency, Sanity Gate
// ─────────────────────────────────────────────────────────

/**
 * Net buyback yield from shares outstanding change YoY.
 * Uses basic shares from balance sheet (commonStockSharesOutstanding).
 * Negative = net dilution (penalizes per-share growth).
 */
function computeNetBuybackYield(
    statements: FinancialStatement[],
): { yield: number; currentShares?: number; priorShares?: number } {
    const sorted = [...statements].sort((a, b) => b.fiscalYear - a.fiscalYear);
    const current = sorted[0]?.sharesOutstanding;
    const prior = sorted[1]?.sharesOutstanding;

    if (!prior || !current || prior <= 0) {
        return { yield: 0 };
    }

    // Positive = buyback (shrinkage), Negative = dilution
    const buybackYield = (prior - current) / prior;
    return { yield: buybackYield, currentShares: current, priorShares: prior };
}

/**
 * Recency-weighted growth using quarterly data.
 * Weights: TTM 50%, prior year 30%, year before 20%.
 * Inflection detection: accelerating (>2× trailing) or decelerating (<0.5× trailing).
 * Growth cap: max(recentQuarter, 1.5 × trailingAvg).
 */
function computeRecencyAdjustedGrowth(
    annualStatements: FinancialStatement[],
    quarterlyStatements: FinancialStatement[],
): {
    quarterlyGrowthUsed: boolean;
    inflection: 'Accelerating' | 'Decelerating' | 'Stable';
    ttmGrowthRate: number | null;
    weights: { ttm: number; priorYear: number; yearBefore: number };
    adjustedRate: number | null;
} {
    const annSorted = [...annualStatements].sort((a, b) => b.fiscalYear - a.fiscalYear);

    if (quarterlyStatements.length < 2 || annSorted.length < 3) {
        return { quarterlyGrowthUsed: false, inflection: 'Stable', ttmGrowthRate: null, weights: { ttm: 0.50, priorYear: 0.30, yearBefore: 0.20 }, adjustedRate: null };
    }

    // TTM revenue growth from quarterly data
    const qSorted = [...quarterlyStatements].sort((a, b) => {
        if (b.fiscalYear !== a.fiscalYear) return b.fiscalYear - a.fiscalYear;
        return (b.fiscalQuarter ?? 0) - (a.fiscalQuarter ?? 0);
    });

    // Most recent quarter YoY growth (compare Q with same Q prior year)
    const recentQ = qSorted[0];
    const priorYearSameQ = qSorted.find(q =>
        q.fiscalYear === recentQ.fiscalYear - 1 &&
        q.fiscalQuarter === recentQ.fiscalQuarter
    );

    let ttmRevenueGrowth: number | null = null;
    if (recentQ?.revenue && priorYearSameQ?.revenue && priorYearSameQ.revenue > 0) {
        ttmRevenueGrowth = (recentQ.revenue - priorYearSameQ.revenue) / priorYearSameQ.revenue;
    }

    if (ttmRevenueGrowth === null) {
        return { quarterlyGrowthUsed: false, inflection: 'Stable', ttmGrowthRate: null, weights: { ttm: 0.50, priorYear: 0.30, yearBefore: 0.20 }, adjustedRate: null };
    }

    // Trailing annual revenue growth rates
    const annRevGrowths: number[] = [];
    for (let i = 0; i < annSorted.length - 1 && i < 3; i++) {
        const curr = annSorted[i].revenue;
        const prev = annSorted[i + 1].revenue;
        if (curr && prev && prev > 0) {
            annRevGrowths.push((curr - prev) / prev);
        }
    }
    const trailingAvg = annRevGrowths.length > 0
        ? annRevGrowths.reduce((a, b) => a + b, 0) / annRevGrowths.length
        : 0;

    // Inflection detection (bidirectional)
    let inflection: 'Accelerating' | 'Decelerating' | 'Stable' = 'Stable';
    let weights = { ttm: 0.50, priorYear: 0.30, yearBefore: 0.20 };

    if (trailingAvg > 0 && ttmRevenueGrowth > 2 * trailingAvg) {
        inflection = 'Accelerating';
        weights = { ttm: 0.60, priorYear: 0.25, yearBefore: 0.15 };
    } else if (trailingAvg > 0 && ttmRevenueGrowth < 0.5 * trailingAvg) {
        inflection = 'Decelerating';
        weights = { ttm: 0.60, priorYear: 0.25, yearBefore: 0.15 };
    }

    // Compute recency-weighted rate
    const rates: number[] = [];
    if (ttmRevenueGrowth !== null) rates.push(ttmRevenueGrowth);
    if (annRevGrowths.length >= 1) rates.push(annRevGrowths[0]); // Most recent annual
    if (annRevGrowths.length >= 2) rates.push(annRevGrowths[1]); // Year before

    let adjustedRate = 0;
    const w = [weights.ttm, weights.priorYear, weights.yearBefore];
    let totalW = 0;
    for (let i = 0; i < rates.length && i < 3; i++) {
        adjustedRate += rates[i] * w[i];
        totalW += w[i];
    }
    if (totalW > 0) adjustedRate /= totalW;

    // Growth cap guardrail: max(recentQuarter, 1.5 × trailingAvg)
    const cap = Math.max(ttmRevenueGrowth, trailingAvg * 1.5);
    adjustedRate = Math.min(adjustedRate, cap);

    return { quarterlyGrowthUsed: true, inflection, ttmGrowthRate: ttmRevenueGrowth, weights, adjustedRate };
}

/**
 * Graduated sanity gate severity (v3)
 */
function determineSanitySeverity(ratio: number): 'normal' | 'warning' | 'critical' {
    if (ratio < SANITY_CRITICAL_LOW || ratio > SANITY_CRITICAL_HIGH) return 'critical';
    if (ratio < SANITY_WARNING_LOW || ratio > SANITY_WARNING_HIGH) return 'warning';
    return 'normal';
}

// ─────────────────────────────────────────────────────────
// Recommendation & Sensitivity
// ─────────────────────────────────────────────────────────

function generateRecommendation(
    intrinsicValue: number,
    currentPrice: number,
    sanitySeverity: 'normal' | 'warning' | 'critical',
): { recommendation: string; rationale: string; confidence: string } {
    const upside = (intrinsicValue / currentPrice) - 1;

    let recommendation: string;
    let rationale: string;
    let confidence: string;

    if (upside >= 0.15) {
        recommendation = 'STRONG BUY';
        rationale = `Trading ${(Math.abs(upside) * 100).toFixed(1)}% below intrinsic value`;
        confidence = 'High';
    } else if (upside > 0) {
        recommendation = 'BUY';
        rationale = `Trading ${(Math.abs(upside) * 100).toFixed(1)}% below intrinsic value`;
        confidence = 'Moderate';
    } else if (upside > -0.15) {
        recommendation = 'HOLD';
        rationale = `Trading near fair value (${(upside * 100).toFixed(1)}%)`;
        confidence = 'Moderate';
    } else if (upside > -0.30) {
        recommendation = 'SELL';
        rationale = `Trading ${(Math.abs(upside) * 100).toFixed(1)}% above intrinsic value`;
        confidence = 'High';
    } else {
        recommendation = 'STRONG SELL';
        rationale = `Significantly overvalued — trading ${(Math.abs(upside) * 100).toFixed(1)}% above intrinsic value`;
        confidence = 'High';
    }

    // Override confidence based on sanity gate severity (v3)
    if (sanitySeverity === 'critical') {
        confidence = 'Very Low — Model Likely Unreliable';
    } else if (sanitySeverity === 'warning') {
        confidence = 'Low — Sanity Gate Triggered';
    }

    return { recommendation, rationale, confidence };
}

/**
 * Sensitivity analysis — all scenarios use the same computeIntrinsicValue path
 */
function runSensitivityAnalysis(
    baseValue: number,
    baseYear: number,
    baseWacc: number,
    phase1Rate: number,
    phase2Rate: number,
    exitMultiple: number,
    multipleType: string,
    totalDebt: number,
    cash: number,
    shares: number,
    currentPrice: number,
    baseIntrinsicValue: number,
): DCFResult['sensitivityAnalysis'] {
    // WACC sensitivity
    const waccScenarios = [-SENSITIVITY_WACC_DELTA, 0, SENSITIVITY_WACC_DELTA].map(delta => {
        const w = baseWacc + delta;
        const proj = projectCashFlows(baseValue, phase1Rate, phase2Rate, baseYear);
        const projValues = proj.map(p => p.value);
        const { intrinsicPerShare } = computeIntrinsicValue(projValues, w, exitMultiple, multipleType, totalDebt, cash, shares);
        const ud = currentPrice > 0 ? (intrinsicPerShare / currentPrice) - 1 : 0;
        const label = delta < 0 ? 'Optimistic (Lower WACC)' : delta === 0 ? 'Base Case' : 'Conservative (Higher WACC)';
        return { scenario: label, wacc: w, intrinsicValue: intrinsicPerShare, upsideDownside: ud };
    });

    // Growth sensitivity
    const growthDeltas = [
        { label: 'Conservative Growth (-20%)', p1: phase1Rate * 0.80, p2: phase2Rate * 0.80 },
        { label: 'Base Case', p1: phase1Rate, p2: phase2Rate },
        { label: 'Optimistic Growth (+20%)', p1: phase1Rate * 1.20, p2: phase2Rate * 1.20 },
    ];
    const growthScenarios = growthDeltas.map(gd => {
        const proj = projectCashFlows(baseValue, gd.p1, gd.p2, baseYear);
        const projValues = proj.map(p => p.value);
        const { intrinsicPerShare } = computeIntrinsicValue(projValues, baseWacc, exitMultiple, multipleType, totalDebt, cash, shares);
        const ud = currentPrice > 0 ? (intrinsicPerShare / currentPrice) - 1 : 0;
        return { scenario: gd.label, phase1Growth: gd.p1, phase2Growth: gd.p2, intrinsicValue: intrinsicPerShare, upsideDownside: ud };
    });

    // Terminal growth sensitivity
    const tgDeltas = [-0.005, 0, 0.005];
    const termGrowthScenarios = tgDeltas.map(delta => {
        const tg = TERMINAL_GROWTH_RATE + delta;
        // Use perpetuity-only with adjusted terminal growth for this sensitivity
        const proj = projectCashFlows(baseValue, phase1Rate, phase2Rate, baseYear);
        const projValues = proj.map(p => p.value);
        const { total: pvCF } = discountToPresent(projValues, baseWacc);
        const finalCF = projValues[projValues.length - 1];
        const adjustedTV = (finalCF * (1 + tg)) / (baseWacc - tg);
        const exitTV = finalCF * exitMultiple;
        const avgTV = (adjustedTV + exitTV) / 2;
        const pvTV = avgTV / Math.pow(1 + baseWacc, PROJECTION_YEARS);
        const ev = pvCF + pvTV;
        const netDebt = totalDebt - cash;
        const iv = shares > 0 ? (ev - netDebt) / shares : 0;
        const impact = baseIntrinsicValue > 0 ? (iv - baseIntrinsicValue) / baseIntrinsicValue : 0;
        return { terminalGrowth: tg, intrinsicValue: iv, impactVsBase: impact };
    });

    return {
        waccSensitivity: waccScenarios,
        growthSensitivity: growthScenarios,
        terminalGrowthSensitivity: termGrowthScenarios,
    };
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function calculateEffectiveTaxRate(statements: FinancialStatement[]): number {
    const validTaxRates: number[] = [];
    for (const stmt of statements.slice(0, 3)) {
        if (stmt.incomeTaxExpense !== undefined && stmt.incomeBeforeTax !== undefined && stmt.incomeBeforeTax > 0) {
            const rate = stmt.incomeTaxExpense / stmt.incomeBeforeTax;
            if (rate > 0 && rate < 1) {
                validTaxRates.push(rate);
            }
        }
    }
    if (validTaxRates.length === 0) return DEFAULT_TAX_RATE;
    return validTaxRates.reduce((a, b) => a + b, 0) / validTaxRates.length;
}

// ─────────────────────────────────────────────────────────
// Main Orchestrator
// ─────────────────────────────────────────────────────────

export async function runDCFAnalysis(symbol: string): Promise<DCFResult> {
    const startTime = Date.now();
    const sym = symbol.toUpperCase().trim();
    console.log(`\n📈 [DCF v3] Starting DCF analysis for ${sym}...`);

    // ─── Step 1: Data Collection ─────────────────────
    console.log(`📊 [DCF] Step 1: Collecting data...`);

    const overview: CompanyOverview = await fetchCompanyOverview(sym);
    const statements: FinancialStatement[] = await fetchFinancialStatements(sym, 'annual', 5);
    const riskFreeRate: number = await fetchTreasuryYield();
    const annualEarnings = await fetchAnnualEarnings(sym, 10);

    if (statements.length < 3) {
        throw new APIError(
            `Insufficient historical data for DCF analysis of ${sym}. Need at least 3 years, got ${statements.length}.`,
            { symbol: sym, yearsAvailable: statements.length }
        );
    }

    const dataGaps: string[] = [];

    // ─── Step 2: Extract key data ────────────────────
    console.log(`📊 [DCF] Step 2: Extracting key data...`);

    const beta = overview.beta ?? DEFAULT_BETA;
    const marketCap = overview.marketCap || 0;
    const currentPE = overview.peRatio ?? null;
    const currentEPS = overview.eps ?? null;

    // Shares outstanding
    let sharesOutstanding = 0;
    if (currentEPS && currentEPS > 0 && currentPE && currentPE > 0) {
        const impliedPrice = currentEPS * currentPE;
        sharesOutstanding = impliedPrice > 0 ? marketCap / impliedPrice : 0;
    }
    if (sharesOutstanding <= 0 && marketCap > 0) {
        const avg52 = ((overview.week52High ?? 0) + (overview.week52Low ?? 0)) / 2;
        if (avg52 > 0) {
            sharesOutstanding = marketCap / avg52;
        }
    }
    if (sharesOutstanding <= 0) {
        dataGaps.push('Could not reliably determine shares outstanding');
        sharesOutstanding = 1;
    }

    // Current price
    const currentPrice = (currentEPS && currentPE) ? currentEPS * currentPE :
        (overview.week52High && overview.week52Low ? (overview.week52High + overview.week52Low) / 2 : 0);

    // Sort statements most recent first
    const sortedStatements = [...statements].sort((a, b) => b.fiscalYear - a.fiscalYear);

    // Balance sheet data (avoid double-counting: use max of totalDebt, longTermDebt+shortTermDebt)
    const latestStmt = sortedStatements[0];
    const longTermDebt = latestStmt.totalDebt ?? 0;
    const shortTermDebt = latestStmt.shortTermDebt ?? 0;
    // totalDebt field from AV is actually longTermDebt; add shortTermDebt
    const totalDebt = longTermDebt + shortTermDebt;
    const cash = latestStmt.cash ?? 0;
    const interestExpense = latestStmt.interestExpense ?? 0;

    const taxRate = calculateEffectiveTaxRate(sortedStatements);

    // ─── Step 3: Capex decomposition & anomaly detection ────
    console.log(`📊 [DCF] Step 3: Analyzing capex profile...`);

    const capexAnomaly = detectCapexAnomaly(sortedStatements);

    // Compute normalized FCF and owner earnings for each year
    const enrichedData = sortedStatements.map(s => {
        const da = s.depreciationAndAmortization ?? 0;
        const opCF = s.operatingCashFlow ?? 0;
        const ni = s.netIncome ?? 0;
        const totalCapex = Math.abs(s.capitalExpenditures ?? 0);
        const maintenanceCapex = da;
        const growthCapex = Math.max(0, totalCapex - maintenanceCapex);

        return {
            year: s.fiscalYear,
            revenue: s.revenue,
            operatingIncome: s.operatingIncome,
            netIncome: ni,
            freeCashFlow: s.freeCashFlow,
            normalizedFCF: opCF > 0 && da > 0 ? calculateNormalizedFCF(opCF, da) : undefined,
            ownerEarnings: ni > 0 && da > 0 ? calculateOwnerEarnings(ni, da) : undefined,
            operatingCashFlow: opCF,
            capex: s.capitalExpenditures,
            depreciationAndAmortization: da > 0 ? da : undefined,
            maintenanceCapex: da > 0 ? maintenanceCapex : undefined,
            growthCapex: da > 0 ? growthCapex : undefined,
        };
    });

    // ─── Step 4: Multi-signal growth rate analysis ────
    console.log(`📊 [DCF] Step 4: Computing composite growth rate...`);

    // EPS data from annual earnings
    const epsData = annualEarnings
        .filter(e => e.reportedEPS > 0)
        .map(e => ({ year: parseInt(e.fiscalDateEnding.substring(0, 4)), value: e.reportedEPS }));

    // Determine DCF method
    const fcfData = sortedStatements
        .filter(s => s.freeCashFlow !== undefined && s.freeCashFlow > 0)
        .map(s => ({ year: s.fiscalYear, value: s.freeCashFlow! }));

    let dcfMethod: 'fcf_based' | 'earnings_based';
    let baseValue: number;
    let baseMetric: string;

    // Prefer normalized FCF if available, fall back to raw FCF, then earnings
    const normFCFData = enrichedData
        .filter(d => d.normalizedFCF !== undefined && d.normalizedFCF > 0)
        .map(d => ({ year: d.year, value: d.normalizedFCF! }));

    if (normFCFData.length >= 3 || fcfData.length >= 3) {
        dcfMethod = 'fcf_based';
        // Use normalized FCF as base if available, otherwise raw FCF
        if (normFCFData.length >= 3) {
            baseValue = normFCFData[0].value; // Most recent normalized FCF
            baseMetric = 'Normalized Free Cash Flow (OCF − Maintenance Capex)';
        } else {
            baseValue = fcfData[0].value;
            baseMetric = 'Free Cash Flow (Total)';
        }
        console.log(`📊 [DCF] Using FCF-based approach`);
    } else if (epsData.length >= 3) {
        dcfMethod = 'earnings_based';
        baseValue = epsData[0].value * sharesOutstanding;
        baseMetric = 'Total Earnings (EPS × Shares)';
        console.log(`📊 [DCF] Using Earnings-based approach (${epsData.length} years of positive EPS)`);
    } else {
        throw new APIError(
            `Insufficient positive cash flow or earnings data for DCF analysis of ${sym}`,
            { symbol: sym, fcfYears: fcfData.length, epsYears: epsData.length }
        );
    }

    // Compute CAGRs for each signal
    const sortedByYearAsc = [...sortedStatements].sort((a, b) => a.fiscalYear - b.fiscalYear);

    // Revenue CAGR
    const revValues = sortedByYearAsc.filter(s => s.revenue && s.revenue > 0);
    const revCagr3yr = revValues.length >= 4
        ? calculateCAGR(revValues[Math.max(0, revValues.length - 4)].revenue!, revValues[revValues.length - 1].revenue!, 3)
        : null;

    // Operating Income CAGR
    const opIncValues = sortedByYearAsc.filter(s => s.operatingIncome && s.operatingIncome > 0);
    const opIncomeCagr3yr = opIncValues.length >= 4
        ? calculateCAGR(opIncValues[Math.max(0, opIncValues.length - 4)].operatingIncome!, opIncValues[opIncValues.length - 1].operatingIncome!, 3)
        : null;

    // Normalized FCF CAGR
    const normFCFAsc = [...normFCFData].sort((a, b) => a.year - b.year);
    const normalizedFcfCagr3yr = normFCFAsc.length >= 4
        ? calculateCAGR(normFCFAsc[Math.max(0, normFCFAsc.length - 4)].value, normFCFAsc[normFCFAsc.length - 1].value, 3)
        : null;

    // Owner Earnings CAGR
    const oeData = enrichedData
        .filter(d => d.ownerEarnings !== undefined && d.ownerEarnings > 0)
        .sort((a, b) => a.year - b.year);
    const ownerEarningsCagr3yr = oeData.length >= 4
        ? calculateCAGR(oeData[Math.max(0, oeData.length - 4)].ownerEarnings!, oeData[oeData.length - 1].ownerEarnings!, 3)
        : null;

    // Raw FCF CAGR (for transparency)
    const fcfAsc = [...fcfData].sort((a, b) => a.year - b.year);
    const rawFcfCagr3yr = fcfAsc.length >= 4
        ? calculateCAGR(fcfAsc[Math.max(0, fcfAsc.length - 4)].value, fcfAsc[fcfAsc.length - 1].value, 3)
        : null;

    // Compute composite growth
    const composite = computeCompositeGrowth(
        revCagr3yr, opIncomeCagr3yr, normalizedFcfCagr3yr, ownerEarningsCagr3yr,
        capexAnomaly.isAnomaly,
    );

    // ─── Step 4b: Buyback yield (v3) ──────────────────
    console.log(`📊 [DCF] Step 4b: Computing buyback yield...`);
    const buyback = computeNetBuybackYield(sortedStatements);
    const organicGrowth = composite.rate;
    const effectivePerShareGrowth = composite.rate + buyback.yield;

    // ─── Step 4c: Recency-weighted growth (v3) ────────
    console.log(`📊 [DCF] Step 4c: Checking for growth inflection...`);
    // Conditional fetch: only when annual variance is high or latest annual > 6 months old
    let quarterlyStatements: FinancialStatement[] = [];
    const latestReportDate = sortedStatements[0]?.reportDate;
    const monthsSinceLatest = latestReportDate
        ? (Date.now() - new Date(latestReportDate).getTime()) / (30 * 24 * 60 * 60 * 1000)
        : 12;
    const annualGrowthVariance = (revCagr3yr !== null && rawFcfCagr3yr !== null)
        ? Math.abs(revCagr3yr - rawFcfCagr3yr)
        : 0;
    const shouldFetchQuarterly = annualGrowthVariance > 0.03 || monthsSinceLatest > 6;

    if (shouldFetchQuarterly) {
        console.log(`📊 [DCF] Fetching quarterly data (variance: ${(annualGrowthVariance * 100).toFixed(1)}pp, staleness: ${monthsSinceLatest.toFixed(0)} months)`);
        try {
            quarterlyStatements = await fetchFinancialStatements(sym, 'quarterly', 8);
        } catch (e) {
            console.log(`⚠️ [DCF] Quarterly fetch failed, proceeding with annual-only data`);
            quarterlyStatements = [];
        }
    }

    const recency = computeRecencyAdjustedGrowth(sortedStatements, quarterlyStatements);

    // Blend recency-adjusted growth with composite if available
    let finalGrowthRate = effectivePerShareGrowth;
    if (recency.adjustedRate !== null && recency.quarterlyGrowthUsed) {
        // 60% composite, 40% recency-adjusted (ensures we don't overfit to recent quarters)
        finalGrowthRate = 0.60 * effectivePerShareGrowth + 0.40 * recency.adjustedRate;
        console.log(`📊 [DCF] Growth: composite=${(effectivePerShareGrowth * 100).toFixed(1)}%, recency=${(recency.adjustedRate * 100).toFixed(1)}%, blended=${(finalGrowthRate * 100).toFixed(1)}%`);
    }
    // Cap at MAX_GROWTH_CAP
    finalGrowthRate = Math.min(finalGrowthRate, MAX_GROWTH_CAP);

    const growth = determinePhaseRates(finalGrowthRate);

    // ─── Step 5: WACC (v3: tiered ERP + net cash) ─────
    console.log(`📊 [DCF] Step 5: Calculating WACC (tiered ERP)...`);

    const erp = getMarketRiskPremium(marketCap);
    const costOfEquity = calculateCostOfEquity(riskFreeRate, beta, marketCap);
    const costOfDebt = calculateCostOfDebt(interestExpense, totalDebt, taxRate);
    const waccResult = calculateWACC(marketCap, totalDebt, costOfEquity, costOfDebt.afterTax);

    // Net cash discount: if cash > totalDebt, subtract 25bps from WACC
    const isNetCash = cash > totalDebt;
    const effectiveWacc = isNetCash ? Math.max(waccResult.wacc - NET_CASH_WACC_DISCOUNT, 0.01) : waccResult.wacc;
    if (isNetCash) {
        console.log(`💰 [DCF] Net cash position detected — WACC reduced by ${(NET_CASH_WACC_DISCOUNT * 10000).toFixed(0)}bps to ${(effectiveWacc * 100).toFixed(2)}%`);
    }
    // ─── Step 6: Project cash flows ──────────────────
    console.log(`📊 [DCF] Step 6: Projecting cash flows...`);

    const latestYear = sortedStatements[0].fiscalYear;
    const projections = projectCashFlows(baseValue, growth.phase1, growth.phase2, latestYear);
    const projectedValues = projections.map(p => p.value);

    // ─── Step 7: Terminal value ──────────────────────
    console.log(`📊 [DCF] Step 7: Calculating terminal value...`);

    const finalCashFlow = projectedValues[projectedValues.length - 1];

    // Determine exit multiple — use EV/FCF for FCF-based, P/E for earnings-based
    let exitMultiple: number;
    let multipleType: string;
    if (dcfMethod === 'fcf_based') {
        // EV/FCF from historical data
        const ev = marketCap + totalDebt - cash;
        const latestFCF = fcfData.length > 0 ? fcfData[0].value : baseValue;
        const historicalEvFcf = latestFCF > 0 ? ev / latestFCF : DEFAULT_EXIT_EV_FCF;
        // Clamp to reasonable range
        exitMultiple = Math.min(Math.max(historicalEvFcf, 5), 50);
        exitMultiple = Math.round(exitMultiple);
        multipleType = 'EV/FCF';
    } else {
        // P/E for earnings-based
        exitMultiple = (currentPE && currentPE > 0 && currentPE < 100)
            ? Math.round((currentPE + DEFAULT_EXIT_PE) / 2)
            : DEFAULT_EXIT_PE;
        multipleType = 'P/E';
    }

    const tv = calculateTerminalValue(finalCashFlow, effectiveWacc, exitMultiple, multipleType);

    // ─── Step 8: Intrinsic value (shared path) ───────
    console.log(`📊 [DCF] Step 8: Computing intrinsic value...`);

    const valuation = computeIntrinsicValue(
        projectedValues, effectiveWacc, exitMultiple, multipleType,
        totalDebt, cash, sharesOutstanding,
    );

    const upsideDownside = currentPrice > 0 ? (valuation.intrinsicPerShare / currentPrice) - 1 : 0;
    const valuationLabel = upsideDownside >= 0 ? 'UNDERVALUED' : 'OVERVALUED';

    // ─── Step 9: Reverse DCF ─────────────────────────
    console.log(`📊 [DCF] Step 9: Running reverse DCF...`);

    const impliedGrowth = reverseImpliedGrowth(
        currentPrice, sharesOutstanding, baseValue, effectiveWacc,
        exitMultiple, multipleType, totalDebt, cash, latestYear,
    );

    const growthGap = composite.rate > 0 ? ((impliedGrowth - composite.rate) / composite.rate) : 0;
    let reverseDCFInterpretation: string;
    if (Math.abs(growthGap) < 0.20) {
        reverseDCFInterpretation = `Market pricing is consistent with our growth estimate (gap: ${(growthGap * 100).toFixed(0)}%)`;
    } else if (impliedGrowth > composite.rate) {
        reverseDCFInterpretation = `Market is pricing in ${(impliedGrowth * 100).toFixed(1)}% growth vs our ${(composite.rate * 100).toFixed(1)}% — ` +
            `the market expects stronger future performance than historical trends suggest`;
    } else {
        reverseDCFInterpretation = `Market is pricing in only ${(impliedGrowth * 100).toFixed(1)}% growth vs our ${(composite.rate * 100).toFixed(1)}% — ` +
            `potential undervaluation if our growth estimate is accurate`;
    }

    // ─── Step 10: Sanity gate (v3: graduated) ────────
    console.log(`📊 [DCF] Step 10: Running graduated sanity gate...`);

    const intrinsicVsMarketRatio = currentPrice > 0 ? valuation.intrinsicPerShare / currentPrice : 1;
    const sanitySeverity = determineSanitySeverity(intrinsicVsMarketRatio);
    const sanityFlags: string[] = [];
    let driverAnalysis = '';

    if (sanitySeverity !== 'normal') {
        const label = sanitySeverity === 'critical' ? '⚠️ CRITICAL REVIEW NEEDED' : '⚠️ WARNING';
        sanityFlags.push(`${label} — intrinsic value implies ${((1 - intrinsicVsMarketRatio) * 100).toFixed(0)}% mispricing (severity: ${sanitySeverity})`);

        // Identify the driver
        if (composite.rate < 0.05 && revCagr3yr !== null && revCagr3yr > 0.10) {
            driverAnalysis = `Low composite growth rate (${(composite.rate * 100).toFixed(1)}%) despite strong revenue growth (${(revCagr3yr * 100).toFixed(1)}%). ` +
                `This is likely driven by capex-compressed FCF. Consider that the market is pricing in future returns from current investments.`;
        } else if (effectiveWacc > 0.12) {
            driverAnalysis = `High WACC (${(effectiveWacc * 100).toFixed(1)}%) may be overly penalizing future cash flows.`;
        } else if (composite.rate > 0.30) {
            driverAnalysis = `Very high growth assumption (${(composite.rate * 100).toFixed(1)}%) — verify sustainability.`;
        } else {
            driverAnalysis = `Multiple factors contributing. Market implied growth: ${(impliedGrowth * 100).toFixed(1)}% vs model: ${(composite.rate * 100).toFixed(1)}%.`;
        }
    }

    // ─── Step 10b: Premium analysis (v3) ──────────────
    let premiumAnalysis: DCFResult['premiumAnalysis'] = undefined;
    if (dcfMethod === 'fcf_based' && fcfData.length > 0) {
        const latestFCF = fcfData[0].value;
        const ev = marketCap + totalDebt - cash;
        const marketEvFcf = latestFCF > 0 ? ev / latestFCF : 0;
        const modelEV = valuation.enterpriseValue;
        const modelEvFcf = latestFCF > 0 ? modelEV / latestFCF : 0;
        const premiumGap = modelEvFcf > 0 ? marketEvFcf / modelEvFcf : 0;

        premiumAnalysis = {
            modelImpliedEvFcf: modelEvFcf,
            marketEvFcf,
            premiumGap,
        };
        if (premiumGap > 1.5) {
            premiumAnalysis.warning = `Market trades at ${marketEvFcf.toFixed(1)}× EV/FCF vs model's ${modelEvFcf.toFixed(1)}× — ` +
                `${((premiumGap - 1) * 100).toFixed(0)}% intangible premium not captured by DCF (brand, ecosystem, network effects)`;
        }
    }

    // ─── Step 11: Recommendation (v3: sanity override) ─
    const rec = generateRecommendation(valuation.intrinsicPerShare, currentPrice, sanitySeverity);

    // ─── Step 12: Sensitivity analysis ───────────────
    console.log(`📊 [DCF] Step 12: Running sensitivity analysis...`);

    const sensitivity = runSensitivityAnalysis(
        baseValue, latestYear, effectiveWacc,
        growth.phase1, growth.phase2,
        exitMultiple, multipleType,
        totalDebt, cash, sharesOutstanding, currentPrice,
        valuation.intrinsicPerShare,
    );

    // ─── Step 13: Risk factors ───────────────────────
    const modelRisks: string[] = [];
    const valuationRisks: string[] = [];
    const companyRisks: string[] = [];

    const tvPctOfEV = valuation.enterpriseValue > 0
        ? valuation.pvTerminalValue / valuation.enterpriseValue * 100 : 0;
    if (tvPctOfEV > 60) {
        modelRisks.push(`Terminal value represents ${tvPctOfEV.toFixed(0)}% of total enterprise value`);
    }
    if (tv.warnings.length > 0) {
        modelRisks.push(...tv.warnings);
    }
    if (capexAnomaly.isAnomaly) {
        modelRisks.push(`Capex anomaly detected: ${capexAnomaly.interpretation}`);
    }
    if (sanityFlags.length > 0) {
        modelRisks.push(...sanityFlags);
    }
    if (Math.abs(upsideDownside) > 0.30) {
        valuationRisks.push(`Stock trading ${(Math.abs(upsideDownside) * 100).toFixed(1)}% ${upsideDownside > 0 ? 'below' : 'above'} intrinsic value`);
    }
    if (beta > 1.5) {
        companyRisks.push(`High beta (${beta.toFixed(2)}) indicates above-average volatility`);
    }
    if (totalDebt > 0 && marketCap > 0) {
        const deRatio = (totalDebt / marketCap) * 100;
        if (deRatio > 50) {
            companyRisks.push(`High debt-to-equity ratio (${deRatio.toFixed(1)}%)`);
        }
    }

    // ─── Build result ────────────────────────────────
    const responseTime = Date.now() - startTime;
    console.log(`✅ [DCF v3] Complete DCF analysis for ${sym} finished in ${responseTime}ms`);

    const result: DCFResult = {
        metadata: {
            ticker: sym,
            companyName: overview.name,
            analysisDate: new Date().toISOString().split('T')[0],
            dcfMethod,
            dataSource: 'Alpha Vantage API',
        },
        currentMarketData: {
            currentPrice,
            marketCap,
            sharesOutstanding,
            currentPE,
            beta,
        },
        historicalData: {
            yearsAnalyzed: sortedStatements.length,
            annualData: enrichedData.map(d => ({
                year: d.year,
                revenue: d.revenue,
                eps: epsData.find(e => e.year === d.year)?.value ?? undefined,
                freeCashFlow: d.freeCashFlow,
                normalizedFCF: d.normalizedFCF,
                ownerEarnings: d.ownerEarnings,
                operatingCashFlow: d.operatingCashFlow,
                capex: d.capex,
                depreciationAndAmortization: d.depreciationAndAmortization,
                maintenanceCapex: d.maintenanceCapex,
                growthCapex: d.growthCapex,
            })),
        },
        capexAnalysis: {
            isInvestmentCycle: capexAnomaly.isAnomaly || capexAnomaly.avgGrowthCapexPct > 0.40,
            avgGrowthCapexPct: capexAnomaly.avgGrowthCapexPct,
            interpretation: capexAnomaly.interpretation,
        },
        growthAnalysis: {
            historicalGrowthRates: {
                revenueCagr3yr: revCagr3yr,
                opIncomeCagr3yr: opIncomeCagr3yr,
                normalizedFcfCagr3yr: normalizedFcfCagr3yr,
                ownerEarningsCagr3yr: ownerEarningsCagr3yr,
                rawFcfCagr3yr: rawFcfCagr3yr,
                growthTrend: (revCagr3yr ?? 0) > (rawFcfCagr3yr ?? 0) ? 'Revenue outpacing FCF (likely investment cycle)' : 'Normal',
            },
            recencyAnalysis: recency.quarterlyGrowthUsed ? {
                quarterlyGrowthUsed: true,
                inflectionDetected: recency.inflection,
                ttmGrowthRate: recency.ttmGrowthRate,
                recencyWeights: recency.weights,
                adjustedGrowthRate: recency.adjustedRate,
            } : undefined,
            buybackAnalysis: {
                netBuybackYield: buyback.yield,
                organicGrowth,
                effectivePerShareGrowth,
                sharesOutstandingCurrent: buyback.currentShares,
                sharesOutstandingPrior: buyback.priorShares,
            },
            compositeGrowth: {
                rate: composite.rate,
                signalBreakdown: composite.breakdown,
                capexAdjusted: composite.capexAdjusted,
            },
            projectionAssumptions: {
                phase1: {
                    years: `${latestYear + 1}-${latestYear + PHASE_1_YEARS}`,
                    growthRate: growth.phase1,
                    rationale: growth.rationale1,
                },
                phase2: {
                    years: `${latestYear + PHASE_1_YEARS + 1}-${latestYear + PROJECTION_YEARS}`,
                    growthRate: growth.phase2,
                    rationale: growth.rationale2,
                },
            },
        },
        waccCalculation: {
            wacc: effectiveWacc,
            waccFormatted: `${(effectiveWacc * 100).toFixed(2)}%`,
            netCashDiscount: isNetCash,
            components: {
                costOfEquity: {
                    value: costOfEquity,
                    riskFreeRate,
                    beta,
                    marketRiskPremium: erp,
                    formula: `${(riskFreeRate * 100).toFixed(2)}% + (${beta.toFixed(2)} × ${(erp * 100).toFixed(2)}%) = ${(costOfEquity * 100).toFixed(2)}%${isNetCash ? ' − 25bps net cash' : ''}`,
                },
                costOfDebt: {
                    preTax: costOfDebt.preTax,
                    afterTax: costOfDebt.afterTax,
                    interestExpense,
                    totalDebt,
                    taxRate,
                },
                capitalStructure: {
                    marketCap,
                    totalDebt,
                    equityWeight: waccResult.equityWeight,
                    debtWeight: waccResult.debtWeight,
                },
            },
        },
        cashFlowProjections: {
            baseValue,
            baseMetric,
            projections: projections.map(p => ({
                year: p.year,
                calendarYear: p.calendarYear,
                projectedValue: p.value,
                growthRate: p.growthRate,
                phase: p.phase,
            })),
        },
        terminalValue: {
            terminalYear: latestYear + PROJECTION_YEARS,
            finalCashFlow,
            methods: {
                perpetuityGrowth: { growthRate: TERMINAL_GROWTH_RATE, terminalValue: tv.perpetuity },
                exitMultiple: { multiple: exitMultiple, multipleType, terminalValue: tv.exitMult },
                average: tv.average,
            },
            validation: {
                gapBetweenMethods: tv.gap,
                gapAcceptable: tv.gap <= 0.50,
                warnings: tv.warnings,
            },
        },
        presentValueAnalysis: {
            discountRate: effectiveWacc,
            sumPvCashFlows: valuation.pvCashFlows,
            terminalValuePv: valuation.pvTerminalValue,
            totalPv: valuation.pvCashFlows + valuation.pvTerminalValue,
        },
        valuationSummary: {
            enterpriseValuePerShare: sharesOutstanding > 0 ? valuation.enterpriseValue / sharesOutstanding : 0,
            netDebt: valuation.netDebt,
            netDebtPerShare: sharesOutstanding > 0 ? valuation.netDebt / sharesOutstanding : 0,
            intrinsicValue: valuation.intrinsicPerShare,
            currentPrice,
            upsideDownside,
            upsideDownsideFormatted: `${upsideDownside >= 0 ? '+' : ''}${(upsideDownside * 100).toFixed(2)}%`,
            valuation: valuationLabel,
        },
        reverseDCF: {
            impliedGrowthRate: impliedGrowth,
            impliedGrowthFormatted: `${(impliedGrowth * 100).toFixed(2)}%`,
            modelGrowthRate: composite.rate,
            gapPercent: growthGap,
            interpretation: reverseDCFInterpretation,
        },
        sanityCheck: {
            severity: sanitySeverity,
            anomalyDetected: sanityFlags.length > 0,
            intrinsicVsMarketRatio,
            flags: sanityFlags,
            driverAnalysis,
        },
        premiumAnalysis,
        investmentRecommendation: {
            recommendation: rec.recommendation,
            confidence: rec.confidence,
            rationale: rec.rationale,
            targetPrice: valuation.intrinsicPerShare,
            expectedReturn: upsideDownside,
        },
        sensitivityAnalysis: sensitivity,
        riskFactors: {
            modelRisks,
            valuationRisks,
            companyRisks,
        },
        dataQuality: {
            completeness: dataGaps.length === 0 ? 'High' : 'Moderate',
            historicalYears: sortedStatements.length,
            dataGaps,
        },
        assumptionsUsed: {
            marketRiskPremium: erp,
            terminalGrowthRate: TERMINAL_GROWTH_RATE,
            projectionPeriod: PROJECTION_YEARS,
            discountRateSource: `Calculated WACC (tiered ERP: ${(erp * 100).toFixed(2)}%${isNetCash ? ', net cash discount applied' : ''})`,
            growthRateSource: 'Multi-signal composite + buyback yield + recency weighting',
            growthWeights: composite.capexAdjusted
                ? { revenue: 0.40, operatingIncome: 0.30, normalizedFCF: 0.15, ownerEarnings: 0.15 }
                : GROWTH_WEIGHTS,
        },
    };

    return result;
}
