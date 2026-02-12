/**
 * DCF (Discounted Cash Flow) Analysis Service
 * 
 * Complete DCF valuation engine using Alpha Vantage API data.
 * Supports both FCF-based and Earnings-based DCF approaches.
 * All projections derived from historical data — no external analyst inputs.
 * 
 * Pipeline: Data Collection → Growth Analysis → WACC → Projections →
 *           Terminal Value → Discounting → Intrinsic Value → Sensitivity
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

const MARKET_RISK_PREMIUM = 0.06;       // Historical S&P 500 premium over risk-free
const TERMINAL_GROWTH_RATE = 0.025;     // ~US GDP growth
const DEFAULT_EXIT_PE = 20;             // Conservative P/E for exit multiple
const PROJECTION_YEARS = 10;
const PHASE_1_YEARS = 5;
const MAX_GROWTH_CAP = 0.50;            // 50% max growth per year
const MIN_LONG_TERM_GROWTH = 0.03;      // 3% floor for long-term
const MAX_LONG_TERM_GROWTH = 0.20;      // 20% ceiling for long-term
const SENSITIVITY_WACC_DELTA = 0.02;    // ±2% WACC sensitivity
const DEFAULT_BETA = 1.0;
const DEFAULT_TAX_RATE = 0.21;          // US corporate tax rate

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
            operatingCashFlow?: number;
            capex?: number;
        }>;
    };
    growthAnalysis: {
        historicalGrowthRates: {
            fcfCagr3yr: number | null;
            fcfCagr5yr: number | null;
            revenueCagr3yr: number | null;
            earningsCagr3yr: number | null;
            growthTrend: string;
        };
        projectionAssumptions: {
            phase1: { years: string; growthRate: number; rationale: string };
            phase2: { years: string; growthRate: number; rationale: string };
        };
    };
    waccCalculation: {
        wacc: number;
        waccFormatted: string;
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
    };
}

// ─────────────────────────────────────────────────────────
// Core calculation functions
// ─────────────────────────────────────────────────────────

/**
 * Calculate Compound Annual Growth Rate
 */
function calculateCAGR(beginningValue: number, endingValue: number, years: number): number | null {
    if (beginningValue <= 0 || endingValue <= 0 || years <= 0) return null;
    return Math.pow(endingValue / beginningValue, 1 / years) - 1;
}

/**
 * Determine two-stage growth rates from historical data
 */
function determineGrowthRates(
    cagr3yr: number | null,
    cagr5yr: number | null,
): { phase1: number; phase2: number; trend: string; rationale1: string; rationale2: string } {
    const base3 = cagr3yr ?? 0.10;
    const base5 = cagr5yr ?? base3;

    const trend = base3 > base5 ? 'accelerating' : 'decelerating';

    let nearTerm: number;
    if (trend === 'accelerating') {
        nearTerm = Math.max(base3, base3 * 0.7 + base5 * 0.3);
    } else {
        nearTerm = base3 * 0.6 + base5 * 0.4;
    }

    // Apply caps
    nearTerm = Math.min(nearTerm, MAX_GROWTH_CAP);
    nearTerm = Math.max(nearTerm, 0.02); // minimum 2% growth

    let longTerm = nearTerm * 0.65;
    longTerm = Math.max(longTerm, MIN_LONG_TERM_GROWTH);
    longTerm = Math.min(longTerm, MAX_LONG_TERM_GROWTH);

    return {
        phase1: nearTerm,
        phase2: longTerm,
        trend,
        rationale1: `Based on ${trend} historical trend; weighted toward recent performance`,
        rationale2: `Tapering toward mature growth rate; 65% of Phase 1`,
    };
}

/**
 * Calculate Cost of Equity using CAPM
 */
function calculateCostOfEquity(riskFreeRate: number, beta: number): number {
    return riskFreeRate + beta * MARKET_RISK_PREMIUM;
}

/**
 * Calculate After-tax Cost of Debt
 */
function calculateCostOfDebt(interestExpense: number, totalDebt: number, taxRate: number): { preTax: number; afterTax: number } {
    if (totalDebt <= 0) return { preTax: 0, afterTax: 0 };
    const preTax = interestExpense / totalDebt;
    return { preTax, afterTax: preTax * (1 - taxRate) };
}

/**
 * Calculate WACC
 */
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

/**
 * Project future cash flows using two-stage growth
 */
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
        projections.push({
            year: yr,
            calendarYear: baseYear + yr,
            value: current,
            growthRate: rate,
            phase,
        });
    }

    return projections;
}

/**
 * Calculate terminal value using both methods
 */
function calculateTerminalValue(
    finalCashFlow: number,
    wacc: number,
    exitMultiple: number = DEFAULT_EXIT_PE,
): {
    perpetuity: number;
    exitMult: number;
    average: number;
    gap: number;
    warnings: string[];
} {
    // Perpetuity Growth Method
    if (wacc <= TERMINAL_GROWTH_RATE) {
        throw new Error('WACC must be greater than terminal growth rate');
    }
    const perpetuity = (finalCashFlow * (1 + TERMINAL_GROWTH_RATE)) / (wacc - TERMINAL_GROWTH_RATE);

    // Exit Multiple Method
    const exitMult = finalCashFlow * exitMultiple;

    const average = (perpetuity + exitMult) / 2;

    const gap = Math.abs(perpetuity - exitMult) / Math.min(perpetuity, exitMult);
    const warnings: string[] = [];
    if (gap > 0.50) {
        warnings.push(`Terminal value methods differ by ${(gap * 100).toFixed(1)}% — review assumptions`);
    }

    return { perpetuity, exitMult, average, gap, warnings };
}

/**
 * Discount future values to present value
 */
function discountToPresent(cashFlows: number[], wacc: number): { pvs: number[]; total: number } {
    const pvs = cashFlows.map((cf, i) => cf / Math.pow(1 + wacc, i + 1));
    const total = pvs.reduce((sum, pv) => sum + pv, 0);
    return { pvs, total };
}

/**
 * Calculate intrinsic value per share
 */
function calculateIntrinsicValue(
    sumPvCashFlows: number,
    pvTerminalValue: number,
    totalDebt: number,
    cash: number,
    sharesOutstanding: number,
): { enterpriseValue: number; netDebt: number; equityValue: number; perShare: number } {
    const enterpriseValue = sumPvCashFlows + pvTerminalValue;
    const netDebt = totalDebt - cash;
    const equityValue = enterpriseValue - netDebt;
    const perShare = sharesOutstanding > 0 ? equityValue / sharesOutstanding : 0;
    return { enterpriseValue, netDebt, equityValue, perShare };
}

/**
 * Generate investment recommendation
 */
function generateRecommendation(
    intrinsicValue: number,
    currentPrice: number,
): { recommendation: string; rationale: string; confidence: string } {
    const upside = (intrinsicValue / currentPrice) - 1;

    if (upside >= 0.15) {
        return { recommendation: 'STRONG BUY', rationale: `Trading ${(Math.abs(upside) * 100).toFixed(1)}% below intrinsic value`, confidence: 'High' };
    } else if (upside > 0) {
        return { recommendation: 'BUY', rationale: `Trading ${(Math.abs(upside) * 100).toFixed(1)}% below intrinsic value`, confidence: 'Moderate' };
    } else if (upside > -0.15) {
        return { recommendation: 'HOLD', rationale: `Trading near fair value (${(upside * 100).toFixed(1)}%)`, confidence: 'Moderate' };
    } else if (upside > -0.30) {
        return { recommendation: 'SELL', rationale: `Trading ${(Math.abs(upside) * 100).toFixed(1)}% above intrinsic value`, confidence: 'High' };
    } else {
        return { recommendation: 'STRONG SELL', rationale: `Significantly overvalued — trading ${(Math.abs(upside) * 100).toFixed(1)}% above intrinsic value`, confidence: 'High' };
    }
}

/**
 * Run sensitivity analysis
 */
function runSensitivityAnalysis(
    projectedCashFlows: number[],
    terminalValueBase: number,
    netDebt: number,
    shares: number,
    currentPrice: number,
    baseWacc: number,
    phase1Rate: number,
    phase2Rate: number,
    baseValue: number,
    baseYear: number,
): DCFResult['sensitivityAnalysis'] {
    // WACC sensitivity
    const waccScenarios = [-SENSITIVITY_WACC_DELTA, 0, SENSITIVITY_WACC_DELTA].map(delta => {
        const w = baseWacc + delta;
        const { total: pvCF } = discountToPresent(projectedCashFlows, w);
        const pvTV = terminalValueBase / Math.pow(1 + w, PROJECTION_YEARS);
        const ev = pvCF + pvTV;
        const eq = ev - netDebt;
        const iv = shares > 0 ? eq / shares : 0;
        const ud = currentPrice > 0 ? (iv / currentPrice) - 1 : 0;
        const label = delta < 0 ? 'Optimistic (Lower WACC)' : delta === 0 ? 'Base Case' : 'Conservative (Higher WACC)';
        return { scenario: label, wacc: w, intrinsicValue: iv, upsideDownside: ud };
    });

    // Growth sensitivity
    const growthDeltas = [
        { label: 'Conservative Growth', p1: phase1Rate * 0.78, p2: phase2Rate * 0.79 },
        { label: 'Base Case', p1: phase1Rate, p2: phase2Rate },
        { label: 'Optimistic Growth', p1: phase1Rate * 1.20, p2: phase2Rate * 1.19 },
    ];
    const growthScenarios = growthDeltas.map(gd => {
        const proj = projectCashFlows(baseValue, gd.p1, gd.p2, baseYear);
        const projValues = proj.map(p => p.value);
        const { total: pvCF } = discountToPresent(projValues, baseWacc);
        const finalCF = projValues[projValues.length - 1];
        const tv = (finalCF * (1 + TERMINAL_GROWTH_RATE)) / (baseWacc - TERMINAL_GROWTH_RATE);
        const pvTV = tv / Math.pow(1 + baseWacc, PROJECTION_YEARS);
        const iv = shares > 0 ? (pvCF + pvTV - netDebt) / shares : 0;
        const ud = currentPrice > 0 ? (iv / currentPrice) - 1 : 0;
        return { scenario: gd.label, phase1Growth: gd.p1, phase2Growth: gd.p2, intrinsicValue: iv, upsideDownside: ud };
    });

    // Terminal growth sensitivity
    const tgDeltas = [-0.005, 0, 0.005];
    const baseIV = waccScenarios.find(s => s.scenario === 'Base Case')?.intrinsicValue ?? 0;
    const termGrowthScenarios = tgDeltas.map(delta => {
        const tg = TERMINAL_GROWTH_RATE + delta;
        const finalCF = projectedCashFlows[projectedCashFlows.length - 1];
        const tv = (finalCF * (1 + tg)) / (baseWacc - tg);
        const { total: pvCF } = discountToPresent(projectedCashFlows, baseWacc);
        const pvTV = tv / Math.pow(1 + baseWacc, PROJECTION_YEARS);
        const iv = shares > 0 ? (pvCF + pvTV - netDebt) / shares : 0;
        const impact = baseIV > 0 ? (iv - baseIV) / baseIV : 0;
        return { terminalGrowth: tg, intrinsicValue: iv, impactVsBase: impact };
    });

    return {
        waccSensitivity: waccScenarios,
        growthSensitivity: growthScenarios,
        terminalGrowthSensitivity: termGrowthScenarios,
    };
}

// ─────────────────────────────────────────────────────────
// Helper: calculate effective tax rate from financial statements
// ─────────────────────────────────────────────────────────

function calculateEffectiveTaxRate(statements: FinancialStatement[]): number {
    const validTaxRates: number[] = [];
    for (const stmt of statements.slice(0, 3)) { // Use last 3 years for stability
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

/**
 * Run complete DCF analysis for a stock
 * 
 * @param symbol Stock ticker (e.g., "MSFT", "AAPL")
 * @returns Full structured DCF result
 */
export async function runDCFAnalysis(symbol: string): Promise<DCFResult> {
    const startTime = Date.now();
    const sym = symbol.toUpperCase().trim();
    console.log(`\n📈 [DCF] Starting DCF analysis for ${sym}...`);

    // ─── Step 1: Data Collection ─────────────────────
    console.log(`📊 [DCF] Step 1: Collecting data...`);

    // Fetch overview (1 API call — has beta, market cap, P/E, EPS, shares outstanding)
    const overview: CompanyOverview = await fetchCompanyOverview(sym);

    // Fetch financial statements — 3 API calls (income, balance, cash flow)
    const statements: FinancialStatement[] = await fetchFinancialStatements(sym, 'annual', 5);

    // Fetch treasury yield — 1 API call
    const riskFreeRate: number = await fetchTreasuryYield();

    // Fetch annual EPS — 1 API call
    const annualEarnings = await fetchAnnualEarnings(sym, 10);

    // Data validation
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

    // Shares outstanding from overview (in number of shares)
    // Alpha Vantage OVERVIEW returns MarketCapitalization and EPS
    // shares ≈ MarketCap / (EPS × P/E) or directly from SharesOutstanding field
    let sharesOutstanding = 0;
    if (currentEPS && currentEPS > 0 && currentPE && currentPE > 0) {
        const impliedPrice = currentEPS * currentPE;
        sharesOutstanding = impliedPrice > 0 ? marketCap / impliedPrice : 0;
    }
    if (sharesOutstanding <= 0 && marketCap > 0 && currentEPS && currentEPS > 0) {
        // Fallback: use 52-week average price
        const avg52 = ((overview.week52High ?? 0) + (overview.week52Low ?? 0)) / 2;
        if (avg52 > 0) {
            sharesOutstanding = marketCap / avg52;
        }
    }
    if (sharesOutstanding <= 0) {
        dataGaps.push('Could not reliably determine shares outstanding');
        sharesOutstanding = 1; // prevent division by zero
    }

    // Current price from overview
    const currentPrice = (currentEPS && currentPE) ? currentEPS * currentPE :
        (overview.week52High && overview.week52Low ? (overview.week52High + overview.week52Low) / 2 : 0);

    // Financial data from statements (sorted most recent first)
    const sortedStatements = [...statements].sort((a, b) => b.fiscalYear - a.fiscalYear);

    // Most recent balance sheet data
    const latestStmt = sortedStatements[0];
    const totalDebtLong = latestStmt.totalDebt ?? 0;
    const shortTermDebt = latestStmt.shortTermDebt ?? 0;
    const totalDebt = totalDebtLong + shortTermDebt;
    const cash = latestStmt.cash ?? 0;
    const interestExpense = latestStmt.interestExpense ?? 0;

    // Tax rate
    const taxRate = calculateEffectiveTaxRate(sortedStatements);

    // ─── Step 3: Determine DCF method ────────────────
    console.log(`📊 [DCF] Step 3: Determining DCF method...`);

    // Check if FCF data is usable
    const fcfData = sortedStatements
        .filter(s => s.freeCashFlow !== undefined && s.freeCashFlow > 0)
        .map(s => ({ year: s.fiscalYear, value: s.freeCashFlow! }));

    const epsData = annualEarnings
        .filter(e => e.reportedEPS > 0)
        .map(e => ({ year: parseInt(e.fiscalDateEnding.substring(0, 4)), value: e.reportedEPS }));

    let dcfMethod: 'fcf_based' | 'earnings_based';
    let baseValue: number;
    let baseMetric: string;
    let historicalValues: { year: number; value: number }[];

    if (fcfData.length >= 3) {
        // FCF-based: use total FCF (not per-share)
        dcfMethod = 'fcf_based';
        baseValue = fcfData[0].value; // Most recent FCF
        baseMetric = 'Free Cash Flow (Total, millions)';
        historicalValues = fcfData;
        console.log(`📊 [DCF] Using FCF-based approach (${fcfData.length} years of positive FCF)`);
    } else if (epsData.length >= 3) {
        // Earnings-based: use total earnings (EPS × shares)
        dcfMethod = 'earnings_based';
        baseValue = epsData[0].value * sharesOutstanding; // Convert EPS to total earnings
        baseMetric = 'Total Earnings (EPS × Shares)';
        historicalValues = epsData.map(e => ({ year: e.year, value: e.value * sharesOutstanding }));
        console.log(`📊 [DCF] Using Earnings-based approach (${epsData.length} years of positive EPS)`);
    } else {
        throw new APIError(
            `Insufficient positive cash flow or earnings data for DCF analysis of ${sym}`,
            { symbol: sym, fcfYears: fcfData.length, epsYears: epsData.length }
        );
    }

    // ─── Step 4: Growth rate analysis ────────────────
    console.log(`📊 [DCF] Step 4: Calculating growth rates...`);

    // Sort historical values by year ascending for CAGR
    const sortedHist = [...historicalValues].sort((a, b) => a.year - b.year);

    let cagr3yr: number | null = null;
    let cagr5yr: number | null = null;

    if (sortedHist.length >= 4) {
        const end = sortedHist[sortedHist.length - 1].value;
        const begin3 = sortedHist[Math.max(0, sortedHist.length - 4)].value;
        cagr3yr = calculateCAGR(begin3, end, 3);
    }
    if (sortedHist.length >= 6) {
        const end = sortedHist[sortedHist.length - 1].value;
        const begin5 = sortedHist[Math.max(0, sortedHist.length - 6)].value;
        cagr5yr = calculateCAGR(begin5, end, 5);
    }

    // Revenue CAGR
    const revData = sortedStatements
        .filter(s => s.revenue !== undefined && s.revenue > 0)
        .sort((a, b) => a.fiscalYear - b.fiscalYear);
    let revCagr3yr: number | null = null;
    if (revData.length >= 4) {
        revCagr3yr = calculateCAGR(
            revData[Math.max(0, revData.length - 4)].revenue!,
            revData[revData.length - 1].revenue!,
            3
        );
    }

    // EPS CAGR
    let epsCagr3yr: number | null = null;
    const sortedEPS = [...epsData].sort((a, b) => a.year - b.year);
    if (sortedEPS.length >= 4) {
        epsCagr3yr = calculateCAGR(
            sortedEPS[Math.max(0, sortedEPS.length - 4)].value,
            sortedEPS[sortedEPS.length - 1].value,
            3
        );
    }

    const growth = determineGrowthRates(cagr3yr, cagr5yr);

    // ─── Step 5: WACC calculation ────────────────────
    console.log(`📊 [DCF] Step 5: Calculating WACC...`);

    const costOfEquity = calculateCostOfEquity(riskFreeRate, beta);
    const costOfDebt = calculateCostOfDebt(interestExpense, totalDebt, taxRate);
    const waccResult = calculateWACC(marketCap, totalDebt, costOfEquity, costOfDebt.afterTax);

    // ─── Step 6: Project cash flows ──────────────────
    console.log(`📊 [DCF] Step 6: Projecting cash flows...`);

    const latestYear = sortedStatements[0].fiscalYear;
    const projections = projectCashFlows(baseValue, growth.phase1, growth.phase2, latestYear);
    const projectedValues = projections.map(p => p.value);

    // ─── Step 7: Terminal value ──────────────────────
    console.log(`📊 [DCF] Step 7: Calculating terminal value...`);

    const finalCashFlow = projectedValues[projectedValues.length - 1];
    const terminalYear = latestYear + PROJECTION_YEARS;

    // Determine exit multiple
    let exitPE = DEFAULT_EXIT_PE;
    if (currentPE && currentPE > 0 && currentPE < 100) {
        // Use average of current P/E and default (moderate approach)
        exitPE = Math.round((currentPE + DEFAULT_EXIT_PE) / 2);
    }

    const tv = calculateTerminalValue(finalCashFlow, waccResult.wacc, exitPE);

    // ─── Step 8: Discount to present value ───────────
    console.log(`📊 [DCF] Step 8: Discounting to present value...`);

    const { total: pvCashFlows } = discountToPresent(projectedValues, waccResult.wacc);
    const pvTerminalValue = tv.average / Math.pow(1 + waccResult.wacc, PROJECTION_YEARS);
    const totalPV = pvCashFlows + pvTerminalValue;

    // ─── Step 9: Intrinsic value ─────────────────────
    console.log(`📊 [DCF] Step 9: Calculating intrinsic value...`);

    const intrinsic = calculateIntrinsicValue(
        pvCashFlows, pvTerminalValue, totalDebt, cash, sharesOutstanding
    );

    // Upside/downside
    const upsideDownside = currentPrice > 0 ? (intrinsic.perShare / currentPrice) - 1 : 0;
    const valuation = upsideDownside >= 0 ? 'UNDERVALUED' : 'OVERVALUED';

    // ─── Step 10: Recommendation ─────────────────────
    const rec = generateRecommendation(intrinsic.perShare, currentPrice);

    // ─── Step 11: Sensitivity analysis ───────────────
    console.log(`📊 [DCF] Step 11: Running sensitivity analysis...`);

    const sensitivity = runSensitivityAnalysis(
        projectedValues, tv.average, intrinsic.netDebt, sharesOutstanding,
        currentPrice, waccResult.wacc, growth.phase1, growth.phase2,
        baseValue, latestYear,
    );

    // ─── Step 12: Risk factors ───────────────────────
    const modelRisks: string[] = [];
    const valuationRisks: string[] = [];
    const companyRisks: string[] = [];

    const tvPctOfEV = intrinsic.enterpriseValue > 0
        ? pvTerminalValue / intrinsic.enterpriseValue * 100 : 0;
    if (tvPctOfEV > 60) {
        modelRisks.push(`Terminal value represents ${tvPctOfEV.toFixed(0)}% of total enterprise value`);
    }
    if (tv.warnings.length > 0) {
        modelRisks.push(...tv.warnings);
    }
    if (growth.phase1 > 0.30) {
        modelRisks.push(`Phase 1 growth rate (${(growth.phase1 * 100).toFixed(1)}%) is very high`);
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
    console.log(`✅ [DCF] Complete DCF analysis for ${sym} finished in ${responseTime}ms`);

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
            annualData: sortedStatements.map(s => ({
                year: s.fiscalYear,
                revenue: s.revenue,
                eps: epsData.find(e => e.year === s.fiscalYear)?.value ?? undefined,
                freeCashFlow: s.freeCashFlow,
                operatingCashFlow: s.operatingCashFlow,
                capex: s.capitalExpenditures,
            })),
        },
        growthAnalysis: {
            historicalGrowthRates: {
                fcfCagr3yr: cagr3yr,
                fcfCagr5yr: cagr5yr,
                revenueCagr3yr: revCagr3yr,
                earningsCagr3yr: epsCagr3yr,
                growthTrend: growth.trend,
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
            wacc: waccResult.wacc,
            waccFormatted: `${(waccResult.wacc * 100).toFixed(2)}%`,
            components: {
                costOfEquity: {
                    value: costOfEquity,
                    riskFreeRate,
                    beta,
                    marketRiskPremium: MARKET_RISK_PREMIUM,
                    formula: `${(riskFreeRate * 100).toFixed(2)}% + (${beta.toFixed(2)} × ${(MARKET_RISK_PREMIUM * 100).toFixed(0)}%) = ${(costOfEquity * 100).toFixed(2)}%`,
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
            terminalYear,
            finalCashFlow,
            methods: {
                perpetuityGrowth: { growthRate: TERMINAL_GROWTH_RATE, terminalValue: tv.perpetuity },
                exitMultiple: { multiple: exitPE, multipleType: 'P/E', terminalValue: tv.exitMult },
                average: tv.average,
            },
            validation: {
                gapBetweenMethods: tv.gap,
                gapAcceptable: tv.gap <= 0.50,
                warnings: tv.warnings,
            },
        },
        presentValueAnalysis: {
            discountRate: waccResult.wacc,
            sumPvCashFlows: pvCashFlows,
            terminalValuePv: pvTerminalValue,
            totalPv: totalPV,
        },
        valuationSummary: {
            enterpriseValuePerShare: sharesOutstanding > 0 ? intrinsic.enterpriseValue / sharesOutstanding : 0,
            netDebt: intrinsic.netDebt,
            netDebtPerShare: sharesOutstanding > 0 ? intrinsic.netDebt / sharesOutstanding : 0,
            intrinsicValue: intrinsic.perShare,
            currentPrice,
            upsideDownside,
            upsideDownsideFormatted: `${upsideDownside >= 0 ? '+' : ''}${(upsideDownside * 100).toFixed(2)}%`,
            valuation,
        },
        investmentRecommendation: {
            recommendation: rec.recommendation,
            confidence: rec.confidence,
            rationale: rec.rationale,
            targetPrice: intrinsic.perShare,
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
            marketRiskPremium: MARKET_RISK_PREMIUM,
            terminalGrowthRate: TERMINAL_GROWTH_RATE,
            projectionPeriod: PROJECTION_YEARS,
            discountRateSource: 'Calculated WACC',
            growthRateSource: 'Historical CAGR analysis',
        },
    };

    return result;
}
