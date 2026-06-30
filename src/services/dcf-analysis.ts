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
    fetchFMPKeyMetrics,
    type DCFDataBundle,
    type FMPKeyMetrics,
} from './fmp-data-service.js';
// REMOVED: Alpha Vantage imports replaced by FMP data service (Phase 1 migration)
// Alpha Vantage service retained for non-DCF tools (fundamentals-tool, contextual)
import { getPrice } from './prices.js';
import { APIError } from '../types.js';
import { normalizeMarketData, type NormalizedMarketData } from './market-data-normalization.js';

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
    incomeStatement?: { netInterestIncome?: number; interestExpense?: number; netPremium?: number; revenue?: number }
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
    // FMP's netInterestIncome can appear for any company with interest income/expense,
    // so we need a proportionality threshold to distinguish banks (where it's primary revenue)
    // from companies with minor interest income (e.g., NVDA: ~1% of revenue vs JPM: ~34%)
    if (incomeStatement) {
        const netInterestIncome = incomeStatement.netInterestIncome ?? 0;
        const revenue = incomeStatement.revenue ?? 0;
        const hasNetPremium = (incomeStatement.netPremium ?? 0) !== 0;

        // Only flag as bank if netInterestIncome is a significant portion of revenue (>5%)
        // Banks typically have 20-40% netInterestIncome ratio; non-banks are <2%
        const interestIncomeRatio = revenue > 0 ? netInterestIncome / revenue : 0;
        const isBankRevenue = interestIncomeRatio > 0.05;

        if (isBankRevenue) {
            return { isFinancialInstitution: true, type: 'BANK', reason: `Net interest income is ${(interestIncomeRatio * 100).toFixed(1)}% of revenue` };
        }
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
    divergenceWarning?: string;
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

    // Excess Return Value (if book value and ROE available) - compute first for blending
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

    // Intrinsic value from DDM (dividend stream) — primary valuation for banks/insurance
    const intrinsicValue = stage1PV + terminalPV;

    // Divergence warning: if excessReturnValue differs significantly from DDM value,
    // it signals either suppressed dividends (DDM understates) or unsustainably high ROE
    const divergenceWarning = excessReturnValue !== undefined
        ? Math.abs(excessReturnValue - intrinsicValue) / intrinsicValue > 0.30
            ? `DDM value ($${intrinsicValue.toFixed(2)}) differs significantly from Excess Return model ($${excessReturnValue.toFixed(2)}) — ${((excessReturnValue / intrinsicValue - 1) * 100).toFixed(0)}% deviation`
            : undefined
        : undefined;

    return {
        intrinsicValue,
        stage1PV,
        terminalValue,
        terminalPV,
        dividendsProjected: projections,
        excessReturnValue,
        divergenceWarning,
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
    // FMP's changeInWorkingCapital is already the cash flow impact (negative = WC increased, cash used)
    let fcfe = netIncome - (capex - depreciation) * (1 - debtRatio) + workingCapitalChange * (1 - debtRatio);
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
        enterpriseValue?: number;
        source?: string;
        warnings?: string[];
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
    valuationFramework?: ValuationFramework;
}

export type ValuationConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNSUITABLE';

export interface ValuationRange {
    label: string;
    value: number;
    upside: string;
    model: string;
}

export interface RelativeValuationRange {
    metric: string;
    targetMultiple: number;
    peerMedian: number | null;
    peerLow: number | null;
    peerHigh: number | null;
    impliedValue: number;
    peersUsed: string[];
}

export interface ValuationFramework {
    primaryModel: string;
    selectedFramework: string;
    classification: {
        valuationClass: string;
        reinvestmentSubclass: string;
        reasons: string[];
    };
    confidence: ValuationConfidence;
    confidenceReasons: string[];
    modelSelectionReasons: string[];
    suitability: {
        isSuitableForDCF: boolean;
        message: string;
    };
    primaryResult: ValuationRange;
    scenarioRange: {
        bear: ValuationRange;
        base: ValuationRange;
        bull: ValuationRange;
    };
    reverseImpliedAssumptions: {
        impliedGrowthRate: number;
        impliedGrowthFormatted: string;
        impliedExitMultiple: number | null;
        interpretation: string;
    };
    relativeValuation?: {
        ranges: RelativeValuationRange[];
        summary: string;
    };
    marketData: NormalizedMarketData;
    actualValues?: {
        currentPrice: number;
        marketCap: number;
        sharesOutstanding: number;
        bookEquity: number;
        bookValuePerShare: number;
        netIncome: number;
        eps: number;
        roe: number | null;
        priceToBook: number | null;
        priceToEarnings: number | null;
    };
    warnings: string[];
}

type TeslaScenarioProjectionYear = {
    year: number;
    revenue: number;
    growth: number;
    ebitdarMargin: number;
    capexToRevenue: number;
    ebit: number;
    nopat: number;
    fcff: number;
};

type TeslaScenarioValue = {
    scenario: string;
    wacc: number;
    terminalGrowth: number;
    enterpriseValue: number;
    equityValue: number;
    perShare: number;
    sumPVFCFF: number;
    discountedTerminalValue: number;
    terminalPct: number;
    impliedEVTo2033EBITDA: number;
    projection: TeslaScenarioProjectionYear[];
};

type TeslaScenarioDCFResult = {
    model: string;
    price: number;
    latestRevenue: number;
    netDebt: number;
    basicShares: number;
    dilutedShares: number;
    daToRevenue: number;
    analystGrowth: number;
    currentEnterpriseValue: number;
    bear: TeslaScenarioValue;
    base: TeslaScenarioValue;
    bull: TeslaScenarioValue;
    reverseTerminalGrowth: Array<{
        scenario: string;
        wacc: number;
        requiredTerminalGrowth: number;
        perShareAtRequiredGrowth: number;
        flag: string;
    }>;
};

type CapexHeavyProjectionYear = {
    year: number;
    revenue: number;
    growth: number;
    ebitdaMargin: number;
    capexToRevenue: number;
    workingCapitalToRevenue: number;
    fcff: number;
};

type CapexHeavyScenarioValue = {
    scenario: string;
    wacc: number;
    terminalGrowth: number;
    enterpriseValue: number;
    equityValue: number;
    perShare: number;
    sumPVFCFF: number;
    discountedTerminalValue: number;
    terminalPct: number;
    projection: CapexHeavyProjectionYear[];
};

type CapexHeavyScaledReinvestorResult = {
    model: string;
    price: number;
    latestRevenue: number;
    netDebt: number;
    dilutedShares: number;
    analystGrowth: number;
    currentEnterpriseValue: number;
    daToRevenue: number;
    capexToRevenue: number;
    workingCapitalToRevenue: number;
    sbcToRevenue: number;
    ebitdaMargin: number;
    forwardEbitdaMargin: number;
    bear: CapexHeavyScenarioValue;
    base: CapexHeavyScenarioValue;
    bull: CapexHeavyScenarioValue;
    reverseTerminalGrowth: Array<{
        scenario: string;
        wacc: number;
        requiredTerminalGrowth: number;
        perShareAtRequiredGrowth: number;
        flag: string;
    }>;
};

type ReinvestmentInputs = {
    observedROIC: number;
    observedReinvestmentRate: number;
    observedImpliedGrowth: number;
    ebitMargin: number;
    taxRate: number;
    capexToRevenue: number;
    rndToRevenue: number;
    sbcToRevenue: number;
    acquisitionToRevenue: number;
    medianAcquisitionToRevenue: number;
    maxAcquisitionToRevenue: number;
    acquisitionYears: number;
    latestNOPAT: number;
};

type HighROICFadeBridgeCaps = {
    phaseOneGrowthCap: number;
    bridgeGrowthFloor: number;
    terminalMarginCap: number;
    terminalROICSpread: number;
    stableROICCap: number;
    fadeBridgeYears: number;
    phaseTwoEnd: number;
    label: string;
};

type ReinvestmentLifecycleYear = {
    year: number;
    revenue: number;
    revenueGrowth: number;
    roic: number;
    reinvestmentRate: number;
    nopat: number;
    reinvestment: number;
    fcff: number;
    dilutedShares: number;
};

type ReinvestmentLifecycleResult = {
    perShare: number;
    enterpriseValue: number;
    equityValue: number;
    terminalPct: number;
    reverseRequiredGrowth: number;
    observedROIC: number;
    observedReinvestmentRate: number;
    observedImpliedGrowth: number;
    stableROIC: number;
    stableReinvestmentRate: number;
    stableGrowth: number;
    sbcDilutionRate: number;
    model: string;
    years: ReinvestmentLifecycleYear[];
};

type ProfitableReinvestmentFadeBridgeResult = {
    model: string;
    base: ReinvestmentLifecycleResult;
    bull: ReinvestmentLifecycleResult;
};

type SemicapMidCycleScenario = {
    scenario: string;
    normalizedRevenue: number;
    growth: number;
    margin: number;
    wacc: number;
    terminalGrowth: number;
    enterpriseValue: number;
    equityValue: number;
    perShare: number;
    sumPVFCFF: number;
    discountedTerminalValue: number;
    terminalPct: number;
};

type SemicapMidCycleResult = {
    model: string;
    marketData: NormalizedMarketData;
    latestRevenue: number;
    midCycleRevenue: number;
    cyclePosition: number;
    secularTrend: number;
    normalizedGrowth: number;
    baseMargin: number;
    bear: SemicapMidCycleScenario;
    base: SemicapMidCycleScenario;
    bull: SemicapMidCycleScenario;
};

type PharmaProductCycleProjectionYear = {
    year: number;
    revenue: number;
    growth: number;
    operatingMargin: number;
    rndMaintenanceToRevenue: number;
    fcff: number;
};

type PharmaProductCycleScenarioValue = {
    scenario: string;
    wacc: number;
    terminalGrowth: number;
    enterpriseValue: number;
    equityValue: number;
    perShare: number;
    sumPVFCFF: number;
    discountedTerminalValue: number;
    terminalPct: number;
    pipelineCreditPct: number;
    projection: PharmaProductCycleProjectionYear[];
};

type PharmaProductCycleResult = {
    model: string;
    framework: 'product_cycle' | 'supercycle';
    marketData: NormalizedMarketData;
    latestRevenue: number;
    historicalGrowth: number;
    forwardGrowth: number;
    growthSignal: number;
    operatingMargin: number;
    rndToRevenue: number;
    adjustedOperatingMargin: number;
    bear: PharmaProductCycleScenarioValue;
    base: PharmaProductCycleScenarioValue;
    bull: PharmaProductCycleScenarioValue;
    reverseDiagnostics: {
        currentEnterpriseValue: number;
        requiredPipelineCredit: number;
        requiredTerminalMargin: number;
        requiredGrowthMultiplier: number;
        requiredErosionStartYear: number | null;
        notes: string[];
    };
};

type UtilityDDMScenarioValue = {
    scenario: string;
    costOfEquity: number;
    growthRate: number;
    terminalGrowth: number;
    payoutRatio: number;
    dividendPerShare: number;
    perShare: number;
    stage1PV: number;
    terminalPV: number;
};

type UtilityDDMResult = {
    model: string;
    latestEPS: number;
    dividendPerShare: number;
    payoutRatio: number;
    costOfEquity: number;
    bear: UtilityDDMScenarioValue;
    base: UtilityDDMScenarioValue;
    bull: UtilityDDMScenarioValue;
};

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
// Valuation Framework Helpers
// ─────────────────────────────────────────────────────────

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function classifyValuationFramework(
    bundle: DCFDataBundle,
    profile: FMPProfile,
    growth: { rate: number },
    fcfMargin: number,
    capexToRevenue: number,
    wacc: number,
    keyMetrics: FMPKeyMetrics[] = [],
): ValuationFramework['classification'] {
    const sector = (profile.sector || '').toUpperCase();
    const industry = (profile.industry || '').toUpperCase();
    const country = (profile.country || '').toUpperCase();
    const reasons: string[] = [
        `sector=${profile.sector || 'Unknown'}`,
        `industry=${profile.industry || 'Unknown'}`,
        `growth=${(growth.rate * 100).toFixed(2)}%`,
        `fcfMargin=${(fcfMargin * 100).toFixed(2)}%`,
        `capexRevenue=${(capexToRevenue * 100).toFixed(2)}%`,
        `wacc=${(wacc * 100).toFixed(2)}%`,
    ];

    let valuationClass = 'standard_operating';
    if (profile.isAdr || (country && country !== 'US' && country !== 'USA' && country !== 'UNITED STATES')) {
        valuationClass = 'adr_foreign';
    } else if (sector.includes('FINANCIAL') || industry.includes('BANK') || industry.includes('INSURANCE') || industry.includes('CAPITAL MARKETS')) {
        valuationClass = 'financial';
    } else if (industry.includes('REIT') || industry.includes('REAL ESTATE INVESTMENT')) {
        valuationClass = 'reit';
    } else if (sector.includes('UTILITIES')) {
        valuationClass = 'utility';
    } else if (capexToRevenue >= 0.08 && fcfMargin <= 0.08) {
        valuationClass = 'heavy_reinvestment';
    } else if (growth.rate >= 0.15 || ((profile.beta ?? 1) >= 1.4 && growth.rate >= 0.08)) {
        valuationClass = 'growth_optional';
    } else if (sector.includes('CONSUMER DEFENSIVE') || (growth.rate <= 0.07 && (profile.beta ?? 1) <= 1.1 && fcfMargin >= 0.08)) {
        valuationClass = 'mature_defensive';
    } else if (sector.includes('ENERGY') || sector.includes('MATERIAL') || sector.includes('INDUSTRIAL') || industry.includes('AUTO')) {
        valuationClass = 'cyclical';
    }

    let reinvestmentSubclass = 'not_reinvestment';
    const reinvestmentInputs = computeHistoricalReinvestmentInputs(bundle, keyMetrics);
    const looksReinvestment = (
        reinvestmentInputs.capexToRevenue >= 0.06 ||
        reinvestmentInputs.rndToRevenue >= 0.08 ||
        reinvestmentInputs.sbcToRevenue >= 0.05 ||
        growth.rate >= 0.08 ||
        reinvestmentInputs.observedReinvestmentRate >= 0.25 ||
        fcfMargin <= 0.08 ||
        capexToRevenue >= 0.06
    );
    if (!looksReinvestment) {
        reinvestmentSubclass = 'not_reinvestment';
        reasons.push('Reinvestment subclass: low reinvestment intensity.');
    } else if (reinvestmentInputs.latestNOPAT <= 0 || reinvestmentInputs.ebitMargin <= 0 || reinvestmentInputs.observedROIC < wacc * 0.85) {
        reinvestmentSubclass = 'turnaround_or_low_roic_reinvestment';
        reasons.push('Reinvestment subclass: NOPAT/margin/ROIC not currently investment-grade.');
    } else {
        reasons.push(
            `ROIC=${(reinvestmentInputs.observedROIC * 100).toFixed(2)}%`,
            `RR=${(reinvestmentInputs.observedReinvestmentRate * 100).toFixed(2)}%`,
            `R&D/revenue=${(reinvestmentInputs.rndToRevenue * 100).toFixed(2)}%`,
            `SBC/revenue=${(reinvestmentInputs.sbcToRevenue * 100).toFixed(2)}%`,
            `acquisitions/revenue=${(reinvestmentInputs.acquisitionToRevenue * 100).toFixed(2)}%`,
            `median acquisitions/revenue=${(reinvestmentInputs.medianAcquisitionToRevenue * 100).toFixed(2)}%`,
            `acquisition years=${reinvestmentInputs.acquisitionYears}`,
        );

        if (industry.includes('SEMICONDUCTOR EQUIPMENT') || industry.includes('SEMICONDUCTOR MATERIAL') || ['LRCX', 'KLAC', 'AMAT', 'ASML'].includes(profile.symbol)) {
            reinvestmentSubclass = 'cyclical_semicap_compounder';
        } else if (['AVGO'].includes(profile.symbol)) {
            reinvestmentSubclass = 'semiconductor_ai_acquisition_platform';
        } else if (
            sector.includes('HEALTHCARE') &&
            (industry.includes('DRUG MANUFACTURERS') || industry.includes('PHARMACEUTICAL'))
        ) {
            reinvestmentSubclass = ['LLY'].includes(profile.symbol) || growth.rate >= 0.20
                ? 'pharma_supercycle_compounder'
                : 'pharma_product_cycle_compounder';
        } else if (
            sector.includes('HEALTHCARE') &&
            (industry.includes('BIOTECH') || industry.includes('BIOTECHNOLOGY'))
        ) {
            reinvestmentSubclass = 'biotech_pipeline_compounder';
        } else if (
            reinvestmentInputs.observedROIC >= Math.max(wacc + 0.08, 0.18) &&
            reinvestmentInputs.ebitMargin >= 0.20 &&
            growth.rate >= 0 &&
            growth.rate <= 0.18
        ) {
            reinvestmentSubclass = 'high_roic_mature_compounder';
        } else if (sector.includes('TECHNOLOGY') && reinvestmentInputs.capexToRevenue < 0.06 && (reinvestmentInputs.rndToRevenue >= 0.12 || reinvestmentInputs.sbcToRevenue >= 0.07)) {
            reinvestmentSubclass = 'capital_light_software_compounder';
        } else if (reinvestmentInputs.capexToRevenue >= 0.10 && reinvestmentInputs.ebitMargin < 0.25) {
            reinvestmentSubclass = 'capex_heavy_scaled_reinvestor';
        } else if (
            reinvestmentInputs.acquisitionToRevenue >= 0.12 &&
            reinvestmentInputs.medianAcquisitionToRevenue >= 0.04 &&
            reinvestmentInputs.acquisitionYears >= 2
        ) {
            reinvestmentSubclass = 'acquisition_platform';
        } else {
            reinvestmentSubclass = 'profitable_reinvestment_other';
        }
    }

    return { valuationClass, reinvestmentSubclass, reasons };
}

function isUnsupportedFinancialForFramework(finCheck: ReturnType<typeof detectFinancialInstitution>): boolean {
    return finCheck.isFinancialInstitution && ['BANK', 'INSURANCE', 'REIT'].includes(finCheck.type ?? '');
}

function buildActualValues(
    latestIncome: FMPIncomeStatement,
    latestBalance: FMPBalanceSheet,
    marketData: NormalizedMarketData,
): ValuationFramework['actualValues'] {
    const bookEquity = latestBalance.totalStockholdersEquity || latestBalance.totalEquity || 0;
    const bookValuePerShare = marketData.sharesOutstanding > 0 ? bookEquity / marketData.sharesOutstanding : 0;
    const netIncome = latestIncome.netIncome || 0;
    const eps = latestIncome.epsdiluted || (marketData.sharesOutstanding > 0 ? netIncome / marketData.sharesOutstanding : 0);
    const roe = bookEquity > 0 ? netIncome / bookEquity : null;
    return {
        currentPrice: marketData.currentPrice,
        marketCap: marketData.marketCap,
        sharesOutstanding: marketData.sharesOutstanding,
        bookEquity,
        bookValuePerShare,
        netIncome,
        eps,
        roe,
        priceToBook: bookValuePerShare > 0 ? marketData.currentPrice / bookValuePerShare : null,
        priceToEarnings: eps > 0 ? marketData.currentPrice / eps : null,
    };
}

async function buildRelativeValuation(
    bundle: { peers: string[] },
    targetMetrics: FMPKeyMetrics[],
    baseRevenue: number,
    ebitdaMargin: number,
    marketData: NormalizedMarketData,
): Promise<ValuationFramework['relativeValuation']> {
    const latestTarget = [...targetMetrics].sort((a, b) => b.date.localeCompare(a.date))[0];
    const targetEVRevenue = marketData.enterpriseValue > 0 && baseRevenue > 0 ? marketData.enterpriseValue / baseRevenue : latestTarget?.evToSales;
    const targetEVEBITDA = latestTarget?.enterpriseValueOverEBITDA || (ebitdaMargin > 0 ? targetEVRevenue / ebitdaMargin : 0);
    const targetPE = latestTarget?.peRatio;
    const selectedPeers = bundle.peers.slice(0, 6);
    const peerRows = await Promise.all(selectedPeers.map(async peer => {
        try {
            const metrics = await fetchFMPKeyMetrics(peer, 'annual', 1);
            const latest = metrics[0];
            return latest ? { peer, latest } : null;
        } catch {
            return null;
        }
    }));
    const usable = peerRows.filter((row): row is { peer: string; latest: FMPKeyMetrics } => Boolean(row));
    const medianPositive = (values: number[]): number | null => {
        const clean = values.filter(v => Number.isFinite(v) && v > 0 && v < 500);
        return clean.length >= 2 ? median(clean) : null;
    };
    const makeRange = (
        metric: string,
        targetMultiple: number,
        peerValues: number[],
        impliedValueBuilder: (peerMedian: number) => number,
    ): RelativeValuationRange | null => {
        const clean = peerValues.filter(v => Number.isFinite(v) && v > 0 && v < 500);
        if (!Number.isFinite(targetMultiple) || targetMultiple <= 0 || clean.length < 2) return null;
        const peerMedian = median(clean);
        return {
            metric,
            targetMultiple,
            peerMedian,
            peerLow: percentile(clean, 0.25),
            peerHigh: percentile(clean, 0.75),
            impliedValue: impliedValueBuilder(peerMedian),
            peersUsed: usable.map(row => row.peer),
        };
    };

    const ranges = [
        makeRange(
            'EV/Revenue',
            targetEVRevenue,
            usable.map(row => row.latest.evToSales),
            peerMedian => marketData.sharesOutstanding > 0 ? ((peerMedian * baseRevenue) - marketData.netDebt) / marketData.sharesOutstanding : 0,
        ),
        makeRange(
            'EV/EBITDA',
            targetEVEBITDA,
            usable.map(row => row.latest.enterpriseValueOverEBITDA),
            peerMedian => marketData.sharesOutstanding > 0 ? ((peerMedian * baseRevenue * ebitdaMargin) - marketData.netDebt) / marketData.sharesOutstanding : 0,
        ),
        makeRange(
            'P/E',
            targetPE,
            usable.map(row => row.latest.peRatio),
            peerMedian => {
                const targetPERatio = medianPositive(usable.map(row => row.latest.peRatio));
                return targetPERatio && targetPE && targetPE > 0 ? marketData.currentPrice * (peerMedian / targetPE) : marketData.currentPrice;
            },
        ),
    ].filter((range): range is RelativeValuationRange => Boolean(range));

    if (ranges.length === 0) return undefined;
    return {
        ranges,
        summary: `Peer multiple cross-check from ${usable.length} usable FMP peer(s). Treat as a boundary, not an intrinsic valuation anchor.`,
    };
}

function buildValuationRange(label: string, value: number, currentPrice: number, model: string): ValuationRange {
    return {
        label,
        value: Math.round(value * 100) / 100,
        upside: currentPrice > 0 ? (((value - currentPrice) / currentPrice) * 100).toFixed(2) + '%' : 'N/A',
        model,
    };
}

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(value, high));
}

function average(values: number[]): number {
    const finite = values.filter(Number.isFinite);
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
}

function estimateRevenueAvg(estimate: Record<string, unknown>): number | undefined {
    return firstNumber(estimate, ['estimatedRevenueAvg', 'revenueAvg']);
}

function estimateEpsAvg(estimate: Record<string, unknown>): number | undefined {
    return firstNumber(estimate, ['estimatedEpsAvg', 'epsAvg']);
}

function simpleCAGR(startValue: number, endValue: number, years: number): number | null {
    if (startValue <= 0 || endValue <= 0 || years <= 0) return null;
    return Math.pow(endValue / startValue, 1 / years) - 1;
}

function computeInvestedCapital(balance: FMPBalanceSheet): number {
    const debt = balance.totalDebt || 0;
    const equity = balance.totalStockholdersEquity || balance.totalEquity || 0;
    const cash = balance.cashAndShortTermInvestments || balance.cashAndCashEquivalents || 0;
    const investedCapital = debt + equity - cash;
    return investedCapital > 0 ? investedCapital : balance.totalAssets - balance.cashAndCashEquivalents;
}

function computeShareDilutionRate(incomeStatements: FMPIncomeStatement[]): number {
    const sorted = [...incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const latestShares = sorted[0]?.weightedAverageShsOutDil || 0;
    const priorShares = sorted[Math.min(3, sorted.length - 1)]?.weightedAverageShsOutDil || 0;
    const years = Math.min(3, sorted.length - 1);
    const dilution = years > 0 ? simpleCAGR(priorShares, latestShares, years) : null;
    return clamp(dilution ?? 0, -0.03, 0.05);
}

function computeRDAmortization(incomeStatements: FMPIncomeStatement[], index: number): number {
    const values = [
        incomeStatements[index]?.researchAndDevelopmentExpenses || 0,
        incomeStatements[index + 1]?.researchAndDevelopmentExpenses || 0,
        incomeStatements[index + 2]?.researchAndDevelopmentExpenses || 0,
    ].filter(v => v > 0);
    return average(values);
}

function computeHistoricalReinvestmentInputs(
    bundle: DCFDataBundle,
    keyMetrics: FMPKeyMetrics[],
): ReinvestmentInputs {
    const income = [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const cashFlow = [...bundle.cashFlowStatements].sort((a, b) => b.date.localeCompare(a.date));
    const balance = [...bundle.balanceSheets].sort((a, b) => b.date.localeCompare(a.date));
    const metrics = [...keyMetrics].sort((a, b) => b.date.localeCompare(a.date));
    const years = Math.min(3, income.length, cashFlow.length, balance.length);
    const roics: number[] = [];
    const reinvestmentRates: number[] = [];
    const ebitMargins: number[] = [];
    const taxRates: number[] = [];
    const capexRates: number[] = [];
    const rndRates: number[] = [];
    const sbcRates: number[] = [];
    const acquisitionRates: number[] = [];
    let latestNOPAT = 0;

    for (let i = 0; i < years; i++) {
        const inc = income[i];
        const cf = cashFlow[i];
        const bs = balance[i];
        const revenue = inc.revenue || 1;
        const taxRate = inc.incomeBeforeTax > 0 ? clamp(inc.incomeTaxExpense / inc.incomeBeforeTax, 0.05, 0.30) : TAX_RATE;
        const rdAmortization = computeRDAmortization(income, i);
        const adjustedEBIT = inc.operatingIncome + (inc.researchAndDevelopmentExpenses || 0) - rdAmortization;
        const nopat = adjustedEBIT * (1 - taxRate);
        if (i === 0) latestNOPAT = nopat;
        const metricROIC = metrics.find(m => m.date === inc.date)?.roic;
        const investedCapital = computeInvestedCapital(bs);
        const computedROIC = investedCapital > 0 ? nopat / investedCapital : 0;
        const roic = metricROIC && Number.isFinite(metricROIC) && metricROIC > 0 ? metricROIC : computedROIC;
        const da = cf.depreciationAndAmortization || inc.depreciationAndAmortization || 0;
        const capex = Math.abs(cf.capitalExpenditure || 0);
        const workingCapitalInvestment = -(cf.changeInWorkingCapital || 0);
        const capitalizedRnD = inc.researchAndDevelopmentExpenses || 0;
        const acquisitions = Math.abs(cf.acquisitionsNet || 0);
        const reinvestment = capex + workingCapitalInvestment + capitalizedRnD - da;
        const reinvestmentRate = nopat > 0 ? reinvestment / nopat : 0;

        if (Number.isFinite(roic) && roic > 0) roics.push(roic);
        if (Number.isFinite(reinvestmentRate)) reinvestmentRates.push(reinvestmentRate);
        if (Number.isFinite(adjustedEBIT / revenue)) ebitMargins.push(adjustedEBIT / revenue);
        taxRates.push(taxRate);
        capexRates.push(capex / revenue);
        rndRates.push((inc.researchAndDevelopmentExpenses || 0) / revenue);
        sbcRates.push((cf.stockBasedCompensation || 0) / revenue);
        acquisitionRates.push(acquisitions / revenue);
    }

    const observedROIC = clamp(roics.length ? median(roics) : 0.12, 0.03, 1.20);
    const observedReinvestmentRate = clamp(reinvestmentRates.length ? median(reinvestmentRates) : 0.35, 0.00, 1.20);
    const observedImpliedGrowth = clamp(observedROIC * observedReinvestmentRate, -0.05, 0.35);

    return {
        observedROIC,
        observedReinvestmentRate,
        observedImpliedGrowth,
        ebitMargin: clamp(ebitMargins.length ? median(ebitMargins) : 0.10, -0.20, 0.65),
        taxRate: clamp(taxRates.length ? median(taxRates) : TAX_RATE, 0.05, 0.30),
        capexToRevenue: average(capexRates),
        rndToRevenue: average(rndRates),
        sbcToRevenue: average(sbcRates),
        acquisitionToRevenue: average(acquisitionRates),
        medianAcquisitionToRevenue: acquisitionRates.length ? median(acquisitionRates) : 0,
        maxAcquisitionToRevenue: acquisitionRates.length ? Math.max(...acquisitionRates) : 0,
        acquisitionYears: acquisitionRates.filter(rate => rate >= 0.03).length,
        latestNOPAT,
    };
}

function isUsableNormalizedForeignMarketData(marketData: NormalizedMarketData): boolean {
    const hasAmbiguousCurrencyWarning = marketData.warnings.some(w => w.toLowerCase().includes('currency/listing mismatch is ambiguous'));
    return marketData.financialStatementScale > 0 && Number.isFinite(marketData.financialStatementScale) && !hasAmbiguousCurrencyWarning;
}

function highROICFadeBridgeCaps(bundle: DCFDataBundle): HighROICFadeBridgeCaps {
    const profile = bundle.profile;
    const sector = (profile.sector || '').toUpperCase();
    const industry = (profile.industry || '').toUpperCase();
    const marketCap = (profile.marketCap ?? profile.mktCap) || 0;
    const megaCap = marketCap >= 500e9;

    if (sector.includes('HEALTHCARE') || sector.includes('HEALTH CARE') || industry.includes('PHARMA') || industry.includes('BIOTECH')) {
        return { phaseOneGrowthCap: 0.10, bridgeGrowthFloor: 0.045, terminalMarginCap: 0.32, terminalROICSpread: 0.03, stableROICCap: 0.24, fadeBridgeYears: 15, phaseTwoEnd: 7, label: 'healthcare_pharma_cap' };
    }
    if (sector.includes('CONSUMER DEFENSIVE') || sector.includes('CONSUMER STAPLES')) {
        return { phaseOneGrowthCap: 0.08, bridgeGrowthFloor: 0.04, terminalMarginCap: 0.28, terminalROICSpread: 0.025, stableROICCap: 0.22, fadeBridgeYears: 15, phaseTwoEnd: 7, label: 'consumer_defensive_cap' };
    }
    if (sector.includes('INDUSTRIAL') || sector.includes('MATERIAL') || sector.includes('ENERGY')) {
        return { phaseOneGrowthCap: 0.10, bridgeGrowthFloor: 0.04, terminalMarginCap: 0.22, terminalROICSpread: 0.025, stableROICCap: 0.22, fadeBridgeYears: 15, phaseTwoEnd: 7, label: 'industrial_cyclical_cap' };
    }
    if (industry.includes('SEMICONDUCTOR')) {
        return { phaseOneGrowthCap: megaCap ? 0.16 : 0.20, bridgeGrowthFloor: 0.055, terminalMarginCap: 0.35, terminalROICSpread: megaCap ? 0.055 : 0.07, stableROICCap: 0.32, fadeBridgeYears: megaCap ? 18 : 20, phaseTwoEnd: megaCap ? 8 : 10, label: megaCap ? 'mega_cap_semiconductor_cap' : 'semiconductor_cap' };
    }
    if (sector.includes('TECHNOLOGY') || sector.includes('COMMUNICATION')) {
        return { phaseOneGrowthCap: megaCap ? 0.15 : 0.22, bridgeGrowthFloor: megaCap ? 0.05 : 0.06, terminalMarginCap: 0.35, terminalROICSpread: megaCap ? 0.04 : 0.06, stableROICCap: megaCap ? 0.28 : 0.32, fadeBridgeYears: megaCap ? 16 : 20, phaseTwoEnd: megaCap ? 7 : 10, label: megaCap ? 'mega_cap_platform_cap' : 'software_platform_cap' };
    }
    return { phaseOneGrowthCap: 0.12, bridgeGrowthFloor: 0.045, terminalMarginCap: 0.30, terminalROICSpread: 0.03, stableROICCap: 0.26, fadeBridgeYears: 16, phaseTwoEnd: 8, label: 'default_high_roic_cap' };
}

function valueTeslaScenarioDCF(bundle: DCFDataBundle, marketData: NormalizedMarketData): TeslaScenarioDCFResult {
    const START_YEAR = 2026;
    const END_YEAR = 2033;
    const TAX_RATE_SCENARIO = 0.21;
    const TESLA_SBC_COST = 1.8e9;
    const TESLA_DILUTED_SHARES = 3.448e9;
    const years = Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, i) => START_YEAR + i);
    const income = [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const cashFlow = [...bundle.cashFlowStatements].sort((a, b) => b.date.localeCompare(a.date));
    const latestRevenue = income[0]?.revenue || 0;
    const basicShares = marketData.sharesOutstanding;
    const daToRevenue = latestRevenue > 0
        ? ((cashFlow[0]?.depreciationAndAmortization || income[0]?.depreciationAndAmortization || 0) / latestRevenue)
        : 0.0648;
    const analystGrowth = clamp(selectGrowthRate(bundle.incomeStatements, bundle.analystEstimates).rate, 0.10, 0.35);

    type TeslaScenarioAssumption = {
        scenario: string;
        wacc: number;
        terminalGrowth: number;
        firstGrowth: number;
        terminalBridgeGrowth: number;
        ebitdarStart: number;
        ebitdarEnd: number;
        capexStart: number;
        capexEnd: number;
    };

    const valueAssumption = (assumption: TeslaScenarioAssumption): TeslaScenarioValue => {
        let revenue = latestRevenue;
        let sumPVFCFF = 0;
        let finalFCFF = 0;
        const projection: TeslaScenarioProjectionYear[] = [];

        for (const year of years) {
            const t = (year - START_YEAR) / (END_YEAR - START_YEAR);
            const growth = assumption.firstGrowth + (assumption.terminalBridgeGrowth - assumption.firstGrowth) * t;
            const ebitdarMargin = assumption.ebitdarStart + (assumption.ebitdarEnd - assumption.ebitdarStart) * t;
            const capexToRevenue = assumption.capexStart + (assumption.capexEnd - assumption.capexStart) * t;
            revenue *= 1 + growth;
            const ebitdar = revenue * ebitdarMargin;
            const da = revenue * daToRevenue;
            const ebit = ebitdar - da - TESLA_SBC_COST;
            const nopat = ebit * (1 - TAX_RATE_SCENARIO);
            const capex = revenue * capexToRevenue;
            const fcff = nopat + da - capex;
            const yearIndex = year - START_YEAR + 1;
            finalFCFF = fcff;
            sumPVFCFF += fcff / Math.pow(1 + assumption.wacc, yearIndex);
            projection.push({ year, revenue, growth, ebitdarMargin, capexToRevenue, ebit, nopat, fcff });
        }

        const terminalGrowth = clamp(assumption.terminalGrowth, -0.02, assumption.wacc - 0.005);
        const terminalValue = (finalFCFF * (1 + terminalGrowth)) / (assumption.wacc - terminalGrowth);
        const discountedTerminalValue = terminalValue / Math.pow(1 + assumption.wacc, years.length);
        const enterpriseValue = sumPVFCFF + discountedTerminalValue;
        const equityValue = enterpriseValue - marketData.netDebt;
        const finalProjection = projection[projection.length - 1];
        const finalEBITDA = finalProjection
            ? finalProjection.ebit + finalProjection.revenue * daToRevenue + TESLA_SBC_COST
            : 0;

        return {
            scenario: assumption.scenario,
            wacc: assumption.wacc,
            terminalGrowth,
            enterpriseValue,
            equityValue,
            perShare: TESLA_DILUTED_SHARES > 0 ? equityValue / TESLA_DILUTED_SHARES : 0,
            sumPVFCFF,
            discountedTerminalValue,
            terminalPct: enterpriseValue > 0 ? discountedTerminalValue / enterpriseValue : 0,
            impliedEVTo2033EBITDA: finalEBITDA > 0 ? enterpriseValue / finalEBITDA : 0,
            projection,
        };
    };

    const assumptions: TeslaScenarioAssumption[] = [
        {
            scenario: 'bear_company_beta',
            wacc: 0.14,
            terminalGrowth: 0.025,
            firstGrowth: Math.min(analystGrowth, 0.18),
            terminalBridgeGrowth: 0.025,
            ebitdarStart: 0.145,
            ebitdarEnd: 0.13,
            capexStart: 0.116,
            capexEnd: 0.05,
        },
        {
            scenario: 'base_industry_beta',
            wacc: 0.091,
            terminalGrowth: 0.03,
            firstGrowth: 0.225,
            terminalBridgeGrowth: 0.03,
            ebitdarStart: 0.163,
            ebitdarEnd: 0.15,
            capexStart: 0.116,
            capexEnd: 0.03,
        },
        {
            scenario: 'bull_industry_beta',
            wacc: 0.091,
            terminalGrowth: 0.04,
            firstGrowth: 0.26,
            terminalBridgeGrowth: 0.04,
            ebitdarStart: 0.17,
            ebitdarEnd: 0.165,
            capexStart: 0.10,
            capexEnd: 0.03,
        },
    ];

    const [bear, base, bull] = assumptions.map(valueAssumption);
    const currentEnterpriseValue = marketData.currentPrice * TESLA_DILUTED_SHARES + marketData.netDebt;
    const reverseTerminalGrowth = assumptions.map(assumption => {
        let low = -0.02;
        let high = Math.min(assumption.wacc - 0.005, 0.09);
        for (let i = 0; i < 80; i++) {
            const mid = (low + high) / 2;
            const value = valueAssumption({ ...assumption, terminalGrowth: mid });
            if (value.enterpriseValue < currentEnterpriseValue) low = mid;
            else high = mid;
        }
        const requiredTerminalGrowth = (low + high) / 2;
        const valueAtRequiredGrowth = valueAssumption({ ...assumption, terminalGrowth: requiredTerminalGrowth });
        return {
            scenario: assumption.scenario,
            wacc: assumption.wacc,
            requiredTerminalGrowth,
            perShareAtRequiredGrowth: valueAtRequiredGrowth.perShare,
            flag: requiredTerminalGrowth >= 0.07 ? 'approaches/aggressive 7%+' : 'below 7%',
        };
    });

    return {
        model: 'tesla_scenario_required_dcf',
        price: marketData.currentPrice,
        latestRevenue,
        netDebt: marketData.netDebt,
        basicShares,
        dilutedShares: TESLA_DILUTED_SHARES,
        daToRevenue,
        analystGrowth,
        currentEnterpriseValue,
        bear,
        base,
        bull,
        reverseTerminalGrowth,
    };
}

function valueCapexHeavyScaledReinvestorDCF(
    bundle: DCFDataBundle,
    marketData: NormalizedMarketData,
    waccInput: number,
): CapexHeavyScaledReinvestorResult {
    const projectionStartYear = Number(
        [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date))[0]?.calendarYear ||
        [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date))[0]?.date.slice(0, 4) ||
        new Date().getFullYear(),
    ) + 1;
    const income = [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const cashFlow = [...bundle.cashFlowStatements].sort((a, b) => b.date.localeCompare(a.date));
    const latestIncome = income[0];
    const latestRevenue = latestIncome?.revenue || 0;
    const dilutedShares = marketData.sharesOutstanding;
    const recentIncome = income.slice(0, 3);
    const recentCashFlow = cashFlow.slice(0, 3);
    const safeAverage = (values: number[], fallback: number) => {
        const finite = values.filter(Number.isFinite);
        return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : fallback;
    };
    const taxRate = latestIncome?.incomeBeforeTax && latestIncome.incomeBeforeTax > 0
        ? clamp(latestIncome.incomeTaxExpense / latestIncome.incomeBeforeTax, 0.10, 0.28)
        : TAX_RATE;
    const daToRevenue = safeAverage(
        recentCashFlow.map((cf, i) => (cf.depreciationAndAmortization || recentIncome[i]?.depreciationAndAmortization || 0) / (recentIncome[i]?.revenue || 1)),
        0.08,
    );
    const capexToRevenue = safeAverage(
        recentCashFlow.map((cf, i) => Math.abs(cf.capitalExpenditure || 0) / (recentIncome[i]?.revenue || 1)),
        0.12,
    );
    const workingCapitalToRevenue = safeAverage(
        recentCashFlow.map((cf, i) => -(cf.changeInWorkingCapital || 0) / (recentIncome[i]?.revenue || 1)),
        0.00,
    );
    const sbcToRevenue = safeAverage(
        recentCashFlow.map((cf, i) => (cf.stockBasedCompensation || 0) / (recentIncome[i]?.revenue || 1)),
        0.03,
    );
    const ebitdaMargin = safeAverage(
        recentIncome.map(inc => inc.ebitda / (inc.revenue || 1)),
        0.18,
    );
    const analystGrowth = clamp(selectGrowthRate(bundle.incomeStatements, bundle.analystEstimates).rate, 0.00, 0.30);
    const forwardEstimate = [...bundle.analystEstimates]
        .filter(e => (e.estimatedRevenueAvg ?? 0) > 0)
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))[0];
    const forwardRevenue = forwardEstimate?.estimatedRevenueAvg;
    const forwardEbitda = forwardEstimate?.estimatedEbitdaAvg;
    const forwardEbitdaMargin = forwardRevenue && forwardEbitda ? forwardEbitda / forwardRevenue : ebitdaMargin;

    type CapexHeavyAssumption = {
        scenario: string;
        wacc: number;
        firstGrowth: number;
        terminalGrowth: number;
        ebitdaEnd: number;
        capexEnd: number;
        workingCapitalEnd: number;
    };

    const assumptions: CapexHeavyAssumption[] = [
        {
            scenario: 'bear_capex_fade',
            wacc: Math.max(waccInput, 0.125),
            firstGrowth: Math.min(analystGrowth, 0.09),
            terminalGrowth: 0.025,
            ebitdaEnd: Math.max(ebitdaMargin, 0.22),
            capexEnd: 0.07,
            workingCapitalEnd: 0.005,
        },
        {
            scenario: 'base_tsla_directional_capex_fade',
            wacc: Math.min(waccInput, 0.095),
            firstGrowth: Math.max(analystGrowth, 0.13),
            terminalGrowth: 0.03,
            ebitdaEnd: Math.max(forwardEbitdaMargin, 0.25),
            capexEnd: 0.05,
            workingCapitalEnd: 0.00,
        },
        {
            scenario: 'bull_tsla_directional_capex_fade',
            wacc: Math.min(waccInput, 0.09),
            firstGrowth: Math.max(analystGrowth, 0.15),
            terminalGrowth: 0.035,
            ebitdaEnd: Math.max(forwardEbitdaMargin + 0.02, 0.28),
            capexEnd: 0.04,
            workingCapitalEnd: -0.005,
        },
    ];

    const valueAssumption = (assumption: CapexHeavyAssumption): CapexHeavyScenarioValue => {
        let revenue = latestRevenue;
        let sumPVFCFF = 0;
        let finalFCFF = 0;
        const projection: CapexHeavyProjectionYear[] = [];

        for (let year = 1; year <= PROJECTION_YEARS; year++) {
            const t = PROJECTION_YEARS > 1 ? (year - 1) / (PROJECTION_YEARS - 1) : 1;
            const growth = assumption.firstGrowth + (assumption.terminalGrowth - assumption.firstGrowth) * t;
            const projectedEbitdaMargin = ebitdaMargin + (assumption.ebitdaEnd - ebitdaMargin) * t;
            const projectedCapexToRevenue = capexToRevenue + (assumption.capexEnd - capexToRevenue) * t;
            const projectedWorkingCapitalToRevenue = workingCapitalToRevenue + (assumption.workingCapitalEnd - workingCapitalToRevenue) * t;
            revenue *= 1 + growth;
            const ebitda = revenue * projectedEbitdaMargin;
            const da = revenue * daToRevenue;
            const sbc = revenue * sbcToRevenue;
            const ebit = ebitda - da - sbc;
            const nopat = ebit * (1 - taxRate);
            const capex = revenue * projectedCapexToRevenue;
            const workingCapitalInvestment = revenue * projectedWorkingCapitalToRevenue;
            const fcff = nopat + da - capex - workingCapitalInvestment;
            finalFCFF = fcff;
            sumPVFCFF += fcff / Math.pow(1 + assumption.wacc, year);
            projection.push({
                year: projectionStartYear + year - 1,
                revenue,
                growth,
                ebitdaMargin: projectedEbitdaMargin,
                capexToRevenue: projectedCapexToRevenue,
                workingCapitalToRevenue: projectedWorkingCapitalToRevenue,
                fcff,
            });
        }

        const terminalGrowth = clamp(assumption.terminalGrowth, -0.02, assumption.wacc - 0.005);
        const terminalValue = (finalFCFF * (1 + terminalGrowth)) / (assumption.wacc - terminalGrowth);
        const discountedTerminalValue = terminalValue / Math.pow(1 + assumption.wacc, PROJECTION_YEARS);
        const enterpriseValue = sumPVFCFF + discountedTerminalValue;
        const equityValue = enterpriseValue - marketData.netDebt;

        return {
            scenario: assumption.scenario,
            wacc: assumption.wacc,
            terminalGrowth,
            enterpriseValue,
            equityValue,
            perShare: dilutedShares > 0 ? equityValue / dilutedShares : 0,
            sumPVFCFF,
            discountedTerminalValue,
            terminalPct: enterpriseValue > 0 ? discountedTerminalValue / enterpriseValue : 0,
            projection,
        };
    };

    const [bear, base, bull] = assumptions.map(valueAssumption);
    const reverseTerminalGrowth = assumptions.map(assumption => {
        let low = -0.02;
        let high = Math.min(assumption.wacc - 0.005, 0.09);
        for (let i = 0; i < 80; i++) {
            const mid = (low + high) / 2;
            const value = valueAssumption({ ...assumption, terminalGrowth: mid });
            if (value.enterpriseValue < marketData.enterpriseValue) low = mid;
            else high = mid;
        }
        const requiredTerminalGrowth = (low + high) / 2;
        const valueAtRequiredGrowth = valueAssumption({ ...assumption, terminalGrowth: requiredTerminalGrowth });
        return {
            scenario: assumption.scenario,
            wacc: assumption.wacc,
            requiredTerminalGrowth,
            perShareAtRequiredGrowth: valueAtRequiredGrowth.perShare,
            flag: requiredTerminalGrowth >= 0.07 ? 'approaches/aggressive 7%+' : 'below 7%',
        };
    });

    return {
        model: 'capex_heavy_scaled_reinvestor_tsla_directional_dcf',
        price: marketData.currentPrice,
        latestRevenue,
        netDebt: marketData.netDebt,
        dilutedShares,
        analystGrowth,
        currentEnterpriseValue: marketData.enterpriseValue,
        daToRevenue,
        capexToRevenue,
        workingCapitalToRevenue,
        sbcToRevenue,
        ebitdaMargin,
        forwardEbitdaMargin,
        bear,
        base,
        bull,
        reverseTerminalGrowth,
    };
}

function valueHighROICMatureFadeBridgeFCFF(
    bundle: DCFDataBundle,
    keyMetrics: FMPKeyMetrics[],
    analystGrowth: { rate: number },
    wacc: number,
    sharesOutstanding: number,
    netDebt: number,
): ReinvestmentLifecycleResult {
    const caps = highROICFadeBridgeCaps(bundle);
    const income = [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const latestRevenue = income[0]?.revenue || 0;
    const inputs = computeHistoricalReinvestmentInputs(bundle, keyMetrics);
    const stableGrowth = Math.min(TERMINAL_GROWTH_RATE, wacc - 0.01);
    const stableROIC = clamp(wacc + caps.terminalROICSpread, wacc + 0.005, caps.stableROICCap);
    const stableReinvestmentRate = clamp(stableGrowth / stableROIC, 0.04, 0.35);
    const phaseOneGrowth = Math.min(
        Math.max(analystGrowth.rate, inputs.observedROIC * Math.min(inputs.observedReinvestmentRate, 0.55)),
        caps.phaseOneGrowthCap,
    );
    const phaseOneROIC = inputs.observedROIC;
    const currentMargin = inputs.ebitMargin;
    const terminalMargin = Math.min(Math.max(currentMargin, 0.05), caps.terminalMarginCap);
    const sbcDilutionRate = computeShareDilutionRate(income);
    const years: ReinvestmentLifecycleYear[] = [];
    let revenue = latestRevenue;
    let shares = sharesOutstanding;
    let sumPVFCFF = 0;
    let finalFCFF = 0;

    for (let year = 1; year <= caps.fadeBridgeYears; year++) {
        let revenueGrowth: number;
        let roic: number;

        if (year <= PHASE_1_YEARS) {
            revenueGrowth = phaseOneGrowth;
            roic = phaseOneROIC;
        } else if (year <= caps.phaseTwoEnd) {
            const fade = (year - PHASE_1_YEARS) / (caps.phaseTwoEnd - PHASE_1_YEARS);
            const bridgeGrowth = Math.max(caps.bridgeGrowthFloor, stableGrowth + 0.02);
            revenueGrowth = phaseOneGrowth - (phaseOneGrowth - bridgeGrowth) * fade;
            roic = phaseOneROIC - (phaseOneROIC - stableROIC) * fade * 0.65;
        } else {
            const fade = (year - caps.phaseTwoEnd) / (caps.fadeBridgeYears - caps.phaseTwoEnd);
            const bridgeGrowth = Math.max(caps.bridgeGrowthFloor, stableGrowth + 0.02);
            const phaseTwoROIC = phaseOneROIC - (phaseOneROIC - stableROIC) * 0.65;
            revenueGrowth = bridgeGrowth - (bridgeGrowth - stableGrowth) * fade;
            roic = phaseTwoROIC - (phaseTwoROIC - stableROIC) * fade;
        }

        revenueGrowth = clamp(revenueGrowth, -0.05, 0.35);
        roic = clamp(roic, 0.03, 1.20);
        const reinvestmentRate = clamp(revenueGrowth / roic, stableReinvestmentRate, 0.95);
        const marginFade = caps.fadeBridgeYears > 1 ? (year - 1) / (caps.fadeBridgeYears - 1) : 1;
        const adjustedMargin = currentMargin + (terminalMargin - currentMargin) * marginFade;
        revenue *= 1 + revenueGrowth;
        shares *= 1 + sbcDilutionRate;
        const nopat = revenue * adjustedMargin * (1 - inputs.taxRate);
        const reinvestment = Math.max(0, nopat * reinvestmentRate);
        const fcff = nopat - reinvestment;
        finalFCFF = fcff;
        sumPVFCFF += fcff / Math.pow(1 + wacc, year);
        years.push({ year, revenue, revenueGrowth, roic, reinvestmentRate, nopat, reinvestment, fcff, dilutedShares: shares });
    }

    const terminalValue = (finalFCFF * (1 + stableGrowth)) / (wacc - stableGrowth);
    const discountedTV = terminalValue / Math.pow(1 + wacc, caps.fadeBridgeYears);
    const enterpriseValue = sumPVFCFF + discountedTV;
    const equityValue = enterpriseValue - netDebt;
    const perShare = shares > 0 ? equityValue / shares : 0;
    const marketCap = (bundle.profile.marketCap ?? bundle.profile.mktCap) || sharesOutstanding * (bundle.profile.price || 0);
    const currentEnterpriseValue = marketCap + netDebt;
    const reverseRequiredGrowth = finalFCFF > 0 && currentEnterpriseValue > sumPVFCFF
        ? clamp(((currentEnterpriseValue - sumPVFCFF) * Math.pow(1 + wacc, caps.fadeBridgeYears) * (wacc - stableGrowth)) / finalFCFF - 1, -0.50, 1.00)
        : 0;

    return {
        perShare: Number.isFinite(perShare) ? perShare : 0,
        enterpriseValue,
        equityValue,
        terminalPct: enterpriseValue > 0 ? discountedTV / enterpriseValue : 0,
        reverseRequiredGrowth,
        observedROIC: inputs.observedROIC,
        observedReinvestmentRate: inputs.observedReinvestmentRate,
        observedImpliedGrowth: inputs.observedImpliedGrowth,
        stableROIC,
        stableReinvestmentRate,
        stableGrowth,
        sbcDilutionRate,
        model: 'high_roic_mature_fade_bridge_fcff',
        years,
    };
}

function valueProfitableReinvestmentFadeBridgeFCFF(
    bundle: DCFDataBundle,
    keyMetrics: FMPKeyMetrics[],
    analystGrowth: { rate: number },
    wacc: number,
    sharesOutstanding: number,
    netDebt: number,
): ProfitableReinvestmentFadeBridgeResult {
    const income = [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const latestRevenue = income[0]?.revenue || 0;
    const inputs = computeHistoricalReinvestmentInputs(bundle, keyMetrics);
    const sbcDilutionRate = Math.max(0, computeShareDilutionRate(income));

    const buildCase = (
        label: string,
        projectionYears: number,
        phaseOneGrowth: number,
        terminalMargin: number,
        stableROICSpread: number,
        caseWacc: number,
    ): ReinvestmentLifecycleResult => {
        const stableGrowth = Math.min(TERMINAL_GROWTH_RATE, caseWacc - 0.01);
        const stableROIC = clamp(caseWacc + stableROICSpread, caseWacc + 0.01, 0.35);
        const stableReinvestmentRate = clamp(stableGrowth / stableROIC, 0.04, 0.35);
        const years: ReinvestmentLifecycleYear[] = [];
        let revenue = latestRevenue;
        let shares = sharesOutstanding;
        let sumPVFCFF = 0;
        let finalFCFF = 0;

        for (let year = 1; year <= projectionYears; year++) {
            const totalProgress = projectionYears > 1 ? (year - 1) / (projectionYears - 1) : 1;
            const fadeProgress = year <= PHASE_1_YEARS ? 0 : (year - PHASE_1_YEARS) / (projectionYears - PHASE_1_YEARS);
            const revenueGrowth = year <= PHASE_1_YEARS
                ? phaseOneGrowth
                : phaseOneGrowth - (phaseOneGrowth - stableGrowth) * fadeProgress;
            const roic = year <= PHASE_1_YEARS
                ? inputs.observedROIC
                : inputs.observedROIC - (inputs.observedROIC - stableROIC) * fadeProgress;
            const normalizedMargin = inputs.ebitMargin + (terminalMargin - inputs.ebitMargin) * totalProgress;
            const reinvestmentRate = clamp(revenueGrowth / Math.max(roic, 0.01), stableReinvestmentRate, 0.90);

            revenue *= 1 + clamp(revenueGrowth, -0.05, 0.35);
            shares *= 1 + sbcDilutionRate;
            const nopat = revenue * clamp(normalizedMargin, 0.05, 0.70) * (1 - inputs.taxRate);
            const reinvestment = Math.max(0, nopat * reinvestmentRate);
            const fcff = nopat - reinvestment;
            finalFCFF = fcff;
            sumPVFCFF += fcff / Math.pow(1 + caseWacc, year);
            years.push({ year, revenue, revenueGrowth, roic, reinvestmentRate, nopat, reinvestment, fcff, dilutedShares: shares });
        }

        const terminalValue = (finalFCFF * (1 + stableGrowth)) / (caseWacc - stableGrowth);
        const discountedTV = terminalValue / Math.pow(1 + caseWacc, projectionYears);
        const enterpriseValue = sumPVFCFF + discountedTV;
        const equityValue = enterpriseValue - netDebt;
        const perShare = shares > 0 ? equityValue / shares : 0;
        const marketCap = (bundle.profile.marketCap ?? bundle.profile.mktCap) || sharesOutstanding * (bundle.profile.price || 0);
        const currentEnterpriseValue = marketCap + netDebt;
        const reverseRequiredGrowth = finalFCFF > 0 && currentEnterpriseValue > sumPVFCFF
            ? clamp(((currentEnterpriseValue - sumPVFCFF) * Math.pow(1 + caseWacc, projectionYears) * (caseWacc - stableGrowth)) / finalFCFF - 1, -0.50, 1.00)
            : 0;

        return {
            perShare: Number.isFinite(perShare) ? perShare : 0,
            enterpriseValue,
            equityValue,
            terminalPct: enterpriseValue > 0 ? discountedTV / enterpriseValue : 0,
            reverseRequiredGrowth,
            observedROIC: inputs.observedROIC,
            observedReinvestmentRate: inputs.observedReinvestmentRate,
            observedImpliedGrowth: inputs.observedImpliedGrowth,
            stableROIC,
            stableReinvestmentRate,
            stableGrowth,
            sbcDilutionRate,
            model: label,
            years,
        };
    };

    const baseGrowth = clamp(analystGrowth.rate, 0.12, 0.30);
    const bullGrowth = clamp(Math.max(analystGrowth.rate + 0.02, inputs.observedImpliedGrowth * 0.90), baseGrowth, 0.33);

    return {
        model: 'profitable_reinvestment_fade_bridge_fcff',
        base: buildCase('profitable_reinvestment_fade_bridge_base', 23, baseGrowth, 0.27, 0.075, wacc),
        bull: buildCase('profitable_reinvestment_fade_bridge_bull', 20, bullGrowth, 0.42, 0.09, wacc),
    };
}

function valueCyclicalSemicapMidCycleDCF(
    bundle: DCFDataBundle,
    growth: { rate: number },
): SemicapMidCycleResult {
    const marketData = normalizeMarketData(bundle);
    const income = [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    const cashFlow = [...bundle.cashFlowStatements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    const latestIncome = income[0];
    const oldestIncome = income[income.length - 1] ?? latestIncome;
    const latestYear = Number(latestIncome?.calendarYear || latestIncome?.date.slice(0, 4) || new Date().getFullYear());
    const oldestYear = Number(oldestIncome?.calendarYear || oldestIncome?.date.slice(0, 4) || latestYear - 4);
    const latestRevenue = latestIncome?.revenue || 0;
    const secularTrend = clamp(simpleCAGR(oldestIncome?.revenue || 0, latestRevenue, Math.max(1, latestYear - oldestYear)) ?? 0, -0.05, 0.12);
    const rows = income.map((inc, index) => {
        const cf = cashFlow[index];
        const revenue = inc.revenue || 1;
        const taxRate = inc.incomeBeforeTax > 0 ? clamp(inc.incomeTaxExpense / inc.incomeBeforeTax, 0.05, 0.30) : TAX_RATE;
        const da = cf?.depreciationAndAmortization || inc.depreciationAndAmortization || 0;
        const capex = Math.abs(cf?.capitalExpenditure || 0);
        const workingCapitalInvestment = -(cf?.changeInWorkingCapital || 0);
        const fcffMargin = (inc.operatingIncome * (1 - taxRate) + da - capex - workingCapitalInvestment) / revenue;
        const reportedFCF = cf?.freeCashFlow ?? ((cf?.operatingCashFlow || 0) - capex);
        return { revenue, fcffMargin, reportedFCFMargin: reportedFCF / revenue };
    }).filter(row => row.revenue > 0);
    const trendAdjustedRevenue = rows.map((row, index) => row.revenue * Math.pow(1 + secularTrend, index));
    const midCycleRevenue = trendAdjustedRevenue.length ? median(trendAdjustedRevenue) : latestRevenue;
    const cyclePosition = latestRevenue > 0 && midCycleRevenue > 0 ? latestRevenue / midCycleRevenue - 1 : 0;
    const blendedMargins = rows.map(row => (row.fcffMargin + row.reportedFCFMargin) / 2).filter(Number.isFinite);
    const baseMargin = clamp(blendedMargins.length ? median(blendedMargins) : 0.18, 0.08, 0.36);
    const bearMargin = clamp(blendedMargins.length ? percentile(blendedMargins, 0.25) : baseMargin * 0.85, 0.05, baseMargin);
    const bullMargin = clamp(blendedMargins.length ? percentile(blendedMargins, 0.75) : baseMargin * 1.15, baseMargin, 0.42);
    const adjustedBeta = clamp(bundle.profile.beta || 1.2, 1.05, 1.35);
    const totalCapital = marketData.marketCap + Math.max(0, marketData.netDebt);
    const equityWeight = totalCapital > 0 ? marketData.marketCap / totalCapital : 0.90;
    const debtWeight = totalCapital > 0 ? Math.max(0, marketData.netDebt) / totalCapital : 0.10;
    const costOfEquity = RISK_FREE_RATE + adjustedBeta * EQUITY_RISK_PREMIUM;
    const cycleAdjustedWacc = clamp(equityWeight * costOfEquity + debtWeight * 0.055 * (1 - TAX_RATE), 0.09, 0.115);
    const cyclePenalty = Math.max(0, cyclePosition) * 0.45;
    const normalizedGrowth = clamp((growth.rate * 0.60) + (secularTrend * 0.40) - cyclePenalty, -0.03, 0.12);

    const valueCase = (scenario: string, normalizedRevenue: number, margin: number, firstGrowth: number, wacc: number, terminalGrowth: number): SemicapMidCycleScenario => {
        let revenue = normalizedRevenue;
        let sumPVFCFF = 0;
        let finalFCFF = 0;
        for (let year = 1; year <= PROJECTION_YEARS; year++) {
            const fade = PROJECTION_YEARS > 1 ? (year - 1) / (PROJECTION_YEARS - 1) : 1;
            const revenueGrowth = firstGrowth + (terminalGrowth - firstGrowth) * fade;
            revenue *= 1 + revenueGrowth;
            finalFCFF = revenue * margin;
            sumPVFCFF += finalFCFF / Math.pow(1 + wacc, year);
        }
        const tg = clamp(terminalGrowth, -0.01, wacc - 0.01);
        const terminalValue = (finalFCFF * (1 + tg)) / (wacc - tg);
        const discountedTerminalValue = terminalValue / Math.pow(1 + wacc, PROJECTION_YEARS);
        const enterpriseValue = sumPVFCFF + discountedTerminalValue;
        const equityValue = enterpriseValue - marketData.netDebt;
        return {
            scenario,
            normalizedRevenue,
            growth: firstGrowth,
            margin,
            wacc,
            terminalGrowth: tg,
            enterpriseValue,
            equityValue,
            perShare: marketData.sharesOutstanding > 0 ? equityValue / marketData.sharesOutstanding : 0,
            sumPVFCFF,
            discountedTerminalValue,
            terminalPct: enterpriseValue > 0 ? discountedTerminalValue / enterpriseValue : 0,
        };
    };

    return {
        model: 'cyclical_semicap_midcycle_dcf',
        marketData,
        latestRevenue,
        midCycleRevenue,
        cyclePosition,
        secularTrend,
        normalizedGrowth,
        baseMargin,
        bear: valueCase('bear_trough_margin', midCycleRevenue * 0.92, bearMargin, Math.min(normalizedGrowth, 0.02), cycleAdjustedWacc + 0.0125, 0.02),
        base: valueCase('base_midcycle', midCycleRevenue, baseMargin, normalizedGrowth, cycleAdjustedWacc, TERMINAL_GROWTH_RATE),
        bull: valueCase('bull_cycle_recovery', midCycleRevenue * 1.08, bullMargin, clamp(normalizedGrowth + 0.035, 0.02, 0.15), cycleAdjustedWacc - 0.0075, 0.03),
    };
}

function valuePharmaProductCycleDCF(
    bundle: DCFDataBundle,
    fallbackPrice: number,
    framework: 'product_cycle' | 'supercycle' = 'product_cycle',
): PharmaProductCycleResult {
    const marketData = normalizeMarketData(bundle, fallbackPrice);
    const income = [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const latestIncome = income[0];
    const recentIncome = income.slice(0, 5);
    const latestRevenueRaw = latestIncome?.revenue || 0;
    const latestRevenue = latestRevenueRaw * marketData.financialStatementScale;
    const currentYear = Number(latestIncome?.calendarYear || latestIncome?.date?.slice(0, 4) || new Date().getFullYear());
    const historicalGrowth = simpleCAGR(income[4]?.revenue || 0, latestRevenueRaw, 4) ?? 0;
    const forwardEstimate = [...bundle.analystEstimates]
        .filter(e => (estimateRevenueAvg(e as unknown as Record<string, unknown>) ?? 0) > latestRevenueRaw && latestRevenueRaw > 0)
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))[0];
    const forwardRevenue = forwardEstimate ? estimateRevenueAvg(forwardEstimate as unknown as Record<string, unknown>) : undefined;
    const rawForwardGrowth = forwardRevenue && latestRevenueRaw > 0 ? forwardRevenue / latestRevenueRaw - 1 : historicalGrowth;
    const forwardGrowth = clamp(rawForwardGrowth, -0.10, 0.45);
    const growthSignal = clamp(Math.max(historicalGrowth, forwardGrowth), 0.02, 0.32);
    const operatingMargins = recentIncome.filter(inc => inc.revenue > 0).map(inc => inc.operatingIncome / inc.revenue);
    const rndRatios = recentIncome.filter(inc => inc.revenue > 0).map(inc => (inc.researchAndDevelopmentExpenses || 0) / inc.revenue);
    const operatingMargin = clamp(average(operatingMargins), 0.12, 0.45);
    const rndToRevenue = clamp(average(rndRatios), 0.08, 0.32);
    const adjustedOperatingMargin = clamp(operatingMargin + rndToRevenue * 0.25, 0.16, 0.48);
    const beta = clamp(bundle.profile.beta || 1, 0.75, 1.35);
    const baseWacc = clamp(RISK_FREE_RATE + beta * EQUITY_RISK_PREMIUM, 0.075, 0.12);
    const projectionYears = 12;

    type PharmaAssumption = {
        scenario: string;
        nearGrowth: number;
        peakGrowth: number;
        erosionStart: number;
        erosionRate: number;
        terminalMarginCap: number;
        wacc: number;
        pipelineCredit: number;
    };

    const assumptions: PharmaAssumption[] = framework === 'supercycle'
        ? [
            { scenario: 'bear_supercycle_normalizes', nearGrowth: clamp(growthSignal * 0.65, 0.04, 0.18), peakGrowth: clamp(growthSignal * 0.75, 0.05, 0.20), erosionStart: 8, erosionRate: 0.08, terminalMarginCap: 0.30, wacc: clamp(baseWacc + 0.005, 0.08, 0.13), pipelineCredit: 0.08 },
            { scenario: 'base_supercycle_durable_product_cycle', nearGrowth: clamp(growthSignal * 0.90, 0.06, 0.26), peakGrowth: clamp(growthSignal, 0.08, 0.28), erosionStart: 11, erosionRate: 0.035, terminalMarginCap: 0.35, wacc: baseWacc, pipelineCredit: 0.16 },
            { scenario: 'bull_supercycle_pipeline_replacement', nearGrowth: clamp(growthSignal * 1.10, 0.08, 0.32), peakGrowth: clamp(growthSignal * 1.20, 0.10, 0.34), erosionStart: 14, erosionRate: 0.015, terminalMarginCap: 0.40, wacc: clamp(baseWacc - 0.0075, 0.075, 0.12), pipelineCredit: 0.28 },
        ]
        : [
            { scenario: 'bear_product_cycle_erosion', nearGrowth: clamp(growthSignal * 0.45, 0.02, 0.12), peakGrowth: clamp(growthSignal * 0.55, 0.02, 0.14), erosionStart: 7, erosionRate: 0.10, terminalMarginCap: 0.26, wacc: clamp(baseWacc + 0.01, 0.08, 0.13), pipelineCredit: 0.04 },
            { scenario: 'base_product_cycle_sotp', nearGrowth: clamp(growthSignal * 0.75, 0.03, 0.20), peakGrowth: clamp(growthSignal * 0.85, 0.04, 0.22), erosionStart: 9, erosionRate: 0.06, terminalMarginCap: 0.32, wacc: baseWacc, pipelineCredit: 0.10 },
            { scenario: 'bull_product_cycle_pipeline_replacement', nearGrowth: clamp(growthSignal, 0.05, 0.28), peakGrowth: clamp(growthSignal * 1.10, 0.06, 0.30), erosionStart: 11, erosionRate: 0.03, terminalMarginCap: 0.36, wacc: clamp(baseWacc - 0.005, 0.075, 0.12), pipelineCredit: 0.18 },
        ];

    const valueAssumption = (assumption: PharmaAssumption): PharmaProductCycleScenarioValue => {
        let revenue = latestRevenue;
        let sumPVFCFF = 0;
        let finalFCFF = 0;
        const projection: PharmaProductCycleProjectionYear[] = [];

        for (let year = 1; year <= projectionYears; year++) {
            const fadeProgress = projectionYears > 1 ? (year - 1) / (projectionYears - 1) : 1;
            const rampProgress = Math.min(year / 4, 1);
            const productCycleGrowth = assumption.nearGrowth + (assumption.peakGrowth - assumption.nearGrowth) * rampProgress;
            let growth = productCycleGrowth + (TERMINAL_GROWTH_RATE - productCycleGrowth) * fadeProgress;
            if (year >= assumption.erosionStart) {
                const erosionProgress = (year - assumption.erosionStart + 1) / (projectionYears - assumption.erosionStart + 1);
                growth -= assumption.erosionRate * erosionProgress;
            }
            growth = clamp(growth, -0.10, 0.35);
            revenue *= 1 + growth;
            const operatingMarginAtYear = clamp(
                adjustedOperatingMargin + (assumption.terminalMarginCap - adjustedOperatingMargin) * fadeProgress,
                0.12,
                Math.max(adjustedOperatingMargin, assumption.terminalMarginCap),
            );
            const nopat = revenue * operatingMarginAtYear * (1 - TAX_RATE);
            const rndMaintenanceToRevenue = clamp(rndToRevenue * 0.35, 0.03, 0.10);
            const fcff = nopat - revenue * rndMaintenanceToRevenue;
            finalFCFF = fcff;
            sumPVFCFF += fcff / Math.pow(1 + assumption.wacc, year);
            projection.push({ year: currentYear + year, revenue, growth, operatingMargin: operatingMarginAtYear, rndMaintenanceToRevenue, fcff });
        }

        const terminalGrowth = clamp(TERMINAL_GROWTH_RATE, 0.00, assumption.wacc - 0.005);
        const terminalValue = (finalFCFF * (1 + terminalGrowth)) / (assumption.wacc - terminalGrowth);
        const discountedTerminalValue = terminalValue / Math.pow(1 + assumption.wacc, projectionYears);
        const coreEnterpriseValue = sumPVFCFF + discountedTerminalValue;
        const pipelineValue = coreEnterpriseValue * assumption.pipelineCredit;
        const enterpriseValue = coreEnterpriseValue + pipelineValue;
        const equityValue = enterpriseValue - marketData.netDebt;

        return {
            scenario: assumption.scenario,
            wacc: assumption.wacc,
            terminalGrowth,
            enterpriseValue,
            equityValue,
            perShare: marketData.sharesOutstanding > 0 ? equityValue / marketData.sharesOutstanding : 0,
            sumPVFCFF,
            discountedTerminalValue,
            terminalPct: enterpriseValue > 0 ? discountedTerminalValue / enterpriseValue : 0,
            pipelineCreditPct: enterpriseValue > 0 ? pipelineValue / enterpriseValue : 0,
            projection,
        };
    };

    const [bear, base, bull] = assumptions.map(valueAssumption);
    const baseAssumption = assumptions[1];
    const currentEnterpriseValue = marketData.enterpriseValue;
    const baseCoreEnterpriseValue = base.enterpriseValue / (1 + baseAssumption.pipelineCredit);
    const requiredPipelineCredit = baseCoreEnterpriseValue > 0 ? currentEnterpriseValue / baseCoreEnterpriseValue - 1 : Number.POSITIVE_INFINITY;
    const solveRequired = (low: number, high: number, valueFor: (candidate: number) => number): number => {
        let left = low;
        let right = high;
        for (let i = 0; i < 80; i++) {
            const mid = (left + right) / 2;
            if (valueFor(mid) < currentEnterpriseValue) left = mid;
            else right = mid;
        }
        return (left + right) / 2;
    };
    const requiredTerminalMargin = solveRequired(0.18, 0.55, margin => valueAssumption({ ...baseAssumption, terminalMarginCap: margin }).enterpriseValue);
    const requiredGrowthMultiplier = solveRequired(0.50, 2.50, multiplier => valueAssumption({
        ...baseAssumption,
        nearGrowth: clamp(baseAssumption.nearGrowth * multiplier, 0.00, 0.45),
        peakGrowth: clamp(baseAssumption.peakGrowth * multiplier, 0.00, 0.50),
    }).enterpriseValue);
    let requiredErosionStartYear: number | null = null;
    for (let erosionStart = baseAssumption.erosionStart; erosionStart <= 20; erosionStart++) {
        if (valueAssumption({ ...baseAssumption, erosionStart }).enterpriseValue >= currentEnterpriseValue) {
            requiredErosionStartYear = currentYear + erosionStart;
            break;
        }
    }

    return {
        model: framework === 'supercycle' ? 'pharma_supercycle_sotp_dcf' : 'pharma_product_cycle_sotp_dcf',
        framework,
        marketData,
        latestRevenue,
        historicalGrowth,
        forwardGrowth,
        growthSignal,
        operatingMargin,
        rndToRevenue,
        adjustedOperatingMargin,
        bear,
        base,
        bull,
        reverseDiagnostics: {
            currentEnterpriseValue,
            requiredPipelineCredit,
            requiredTerminalMargin,
            requiredGrowthMultiplier,
            requiredErosionStartYear,
            notes: [
                requiredPipelineCredit > 0.50 ? 'Market requires very large explicit pipeline/label-expansion credit at base assumptions.' : 'Pipeline credit requirement is within a plausible stress range.',
                requiredTerminalMargin > 0.45 ? 'Market requires unusually high normalized terminal operating margin.' : 'Terminal margin requirement is not the main pressure point.',
                requiredGrowthMultiplier > 1.75 ? 'Market requires materially longer/stronger growth duration than base case.' : 'Growth-duration requirement is moderate.',
                requiredErosionStartYear === null ? 'Delaying erosion alone cannot bridge to market value under base assumptions.' : `Base assumptions need erosion delayed to about ${requiredErosionStartYear}.`,
            ],
        },
    };
}

function valueRegulatedUtilityDDM(
    bundle: DCFDataBundle,
    growth: { rate: number },
    costOfEquityInput: number,
    sharesOutstanding: number,
): UtilityDDMResult {
    const income = [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const cashFlow = [...bundle.cashFlowStatements].sort((a, b) => b.date.localeCompare(a.date));
    const latestIncome = income[0];
    const latestCashFlow = cashFlow[0] as unknown as Record<string, unknown> | undefined;
    const latestEPS = latestIncome?.epsdiluted && latestIncome.epsdiluted > 0
        ? latestIncome.epsdiluted
        : sharesOutstanding > 0
            ? (latestIncome?.netIncome || 0) / sharesOutstanding
            : 0;
    const dividendsPaid = Math.abs(firstNumber(latestCashFlow ?? {}, ['dividendsPaid', 'commonDividendsPaid', 'netDividendsPaid']) || 0);
    const cashFlowDividendPerShare = sharesOutstanding > 0 ? dividendsPaid / sharesOutstanding : 0;
    const profileDividendPerShare = bundle.profile.lastDiv && bundle.profile.lastDiv > 0 ? bundle.profile.lastDiv : 0;
    const dividendPerShare = cashFlowDividendPerShare > 0 ? cashFlowDividendPerShare : profileDividendPerShare;
    const firstEstimate = [...bundle.analystEstimates]
        .filter(e => (estimateEpsAvg(e as unknown as Record<string, unknown>) ?? 0) > 0)
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))[0];
    const forwardEPS = firstEstimate ? estimateEpsAvg(firstEstimate as unknown as Record<string, unknown>) : undefined;
    const rawPayoutRatio = latestEPS > 0 && dividendPerShare > 0 ? dividendPerShare / latestEPS : 0;
    const payoutRatio = clamp(rawPayoutRatio, 0.45, 0.90);
    const baseDividend = forwardEPS && payoutRatio > 0
        ? forwardEPS * payoutRatio
        : dividendPerShare;
    const costOfEquity = Math.max(costOfEquityInput, 0.055);
    const baseGrowth = clamp(growth.rate, 0.00, Math.min(TERMINAL_GROWTH_RATE, costOfEquity - 0.01));

    const buildCase = (
        scenario: string,
        growthRate: number,
        costOfEquityCase: number,
        terminalGrowth: number,
        payoutRatioCase: number,
    ): UtilityDDMScenarioValue => {
        const stableGrowth = clamp(growthRate, 0.00, Math.min(terminalGrowth, costOfEquityCase - 0.01));
        const discountRate = Math.max(costOfEquityCase, stableGrowth + 0.01);
        const dividend = forwardEPS && payoutRatioCase > 0
            ? forwardEPS * payoutRatioCase
            : baseDividend;
        const perShare = dividend > 0 ? (dividend * (1 + stableGrowth)) / (discountRate - stableGrowth) : 0;
        return {
            scenario,
            costOfEquity: discountRate,
            growthRate: stableGrowth,
            terminalGrowth: stableGrowth,
            payoutRatio: payoutRatioCase,
            dividendPerShare: dividend,
            perShare: Number.isFinite(perShare) ? perShare : 0,
            stage1PV: 0,
            terminalPV: Number.isFinite(perShare) ? perShare : 0,
        };
    };

    return {
        model: forwardEPS ? 'regulated_utility_forward_eps_payout_ddm' : 'regulated_utility_current_dividend_ddm',
        latestEPS,
        dividendPerShare,
        payoutRatio,
        costOfEquity,
        bear: buildCase('bear_regulated_utility_ddm', clamp(baseGrowth - 0.005, 0.00, TERMINAL_GROWTH_RATE), costOfEquity + 0.005, TERMINAL_GROWTH_RATE, clamp(payoutRatio - 0.05, 0.05, 0.90)),
        base: buildCase('base_regulated_utility_ddm', baseGrowth, costOfEquity, TERMINAL_GROWTH_RATE, payoutRatio),
        bull: buildCase('bull_regulated_utility_ddm', clamp(baseGrowth + 0.005, 0.00, TERMINAL_GROWTH_RATE), Math.max(0.05, costOfEquity - 0.005), TERMINAL_GROWTH_RATE, clamp(payoutRatio + 0.05, 0.05, 0.90)),
    };
}

function deriveFrameworkConfidence(
    classification: ValuationFramework['classification'],
    suitability: ValuationFramework['suitability'],
    marketData: NormalizedMarketData,
    terminalValuePct: number,
    waccClamped: boolean,
): { confidence: ValuationConfidence; reasons: string[] } {
    const reasons: string[] = [];
    if (!suitability.isSuitableForDCF) {
        reasons.push('Selected class is unsuitable for standard FCFF/DCF.');
        return { confidence: 'UNSUITABLE', reasons };
    }
    let score = 3;
    if (marketData.warnings.length > 0) {
        score -= 1;
        reasons.push('Market data has price/share/market-cap consistency warnings.');
    }
    if (terminalValuePct > 0.75) {
        score -= 1;
        reasons.push('Terminal value concentration is high.');
    }
    if (waccClamped) {
        score -= 1;
        reasons.push('WACC was clamped.');
    }
    if (['growth_optional', 'heavy_reinvestment', 'cyclical'].includes(classification.valuationClass)) {
        score -= 1;
        reasons.push(`Valuation class ${classification.valuationClass} has higher forecast uncertainty.`);
    }
    if (classification.valuationClass === 'mature_defensive') {
        score += 1;
        reasons.push('Mature defensive classification supports higher DCF reliability.');
    }
    if (reasons.length === 0) reasons.push('No major data-quality or model-suitability warning detected.');
    return { confidence: score >= 3 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW', reasons };
}

function derivePriceOffsetConfidence(baseValue: number, currentPrice: number, suitability: ValuationFramework['suitability']): { confidence: ValuationConfidence; reason: string } {
    if (!suitability.isSuitableForDCF) {
        return { confidence: 'UNSUITABLE', reason: 'DCF is not suitable for this classification.' };
    }
    if (!Number.isFinite(baseValue) || baseValue <= 0 || currentPrice <= 0) {
        return { confidence: 'LOW', reason: 'Base valuation or current price is unavailable.' };
    }
    const absoluteOffset = Math.abs(baseValue - currentPrice) / currentPrice;
    if (absoluteOffset <= 0.25) {
        return { confidence: 'HIGH', reason: `Base IV is within ${(absoluteOffset * 100).toFixed(1)}% of market price.` };
    }
    if (absoluteOffset <= 0.50) {
        return { confidence: 'MEDIUM', reason: `Base IV is ${(absoluteOffset * 100).toFixed(1)}% from market price.` };
    }
    return { confidence: 'LOW', reason: `Base IV is ${(absoluteOffset * 100).toFixed(1)}% from market price.` };
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
): { fcff: number; components: { ebitdaAfterTax: number; daTaxShield: number; capexDeduction: number; wcDeduction: number } } {
    const ebitdaAfterTax = ebitda * (1 - taxRate);
    const daTaxShield = da * taxRate;
    const fcff = ebitdaAfterTax + daTaxShield - capex - deltaWorkingCapital;
    return {
        fcff,
        components: { ebitdaAfterTax, daTaxShield, capexDeduction: capex, wcDeduction: deltaWorkingCapital },
    };
}

function computeComponentFCFFMargin(
    ebitdaMargin: number,
    taxRate: number,
    daToRevenue: number,
    capexToRevenue: number,
): number {
    return (ebitdaMargin * (1 - taxRate)) + (daToRevenue * taxRate) - capexToRevenue;
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
            const marketCap = (profile.marketCap ?? profile.mktCap) || 1; 
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
    analystEstimates: { date?: string; estimatedRevenueAvg?: number; estimatedEpsAvg?: number }[],
): { rate: number; source: string; raw: number | null; warning?: string } {
    // Sort income statements by date descending (most recent first)
    const sorted = [...incomeStatements].sort((a, b) => b.date.localeCompare(a.date));

    // Method 1: Analyst forward revenue growth
    // Filter to only future-period estimates (date > latest income statement date)
    if (analystEstimates.length > 0 && sorted.length > 0) {
        const latestIncomeDate = sorted[0]?.date;
        const futureEstimates = analystEstimates
            .filter(e => e.date && latestIncomeDate && e.date > latestIncomeDate)
            .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

        if (futureEstimates.length > 0) {
            const fwdRevenue = futureEstimates[0]?.estimatedRevenueAvg;
            const latestRevenue = sorted[0]?.revenue;
            if (fwdRevenue && fwdRevenue > 0 && latestRevenue && latestRevenue > 0) {
                const impliedGrowth = (fwdRevenue / latestRevenue) - 1;
                if (isFinite(impliedGrowth)) {
                    const clamped = Math.max(-0.10, Math.min(impliedGrowth, 0.35));
                    const warning = impliedGrowth < 0 ? `Analyst expects revenue contraction (${(impliedGrowth * 100).toFixed(1)}%), clamped to -10%` : undefined;
                    return { rate: clamped, source: 'analyst_forward_revenue', raw: impliedGrowth, warning };
                }
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
        const clamped = Math.max(-0.10, Math.min(revenueCAGR, 0.35));
        const warning = revenueCAGR < 0 ? `Historical revenue contracting (${(revenueCAGR * 100).toFixed(1)}%), clamped to -10%` : undefined;
        return { rate: clamped, source: 'revenue_cagr', raw: revenueCAGR, warning };
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
): { margin: number; method: 'ebitda_based' | 'ocf_fallback' | 'mixed' } {
    const margins: number[] = [];

    // Sort by date descending, take last 3 years
    const incSorted = [...incomeStatements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
    const cfSorted = [...cashFlowStatements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
    const bsSorted = [...balanceSheets].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4); // need N+1 for WC delta

    let ebitdaCount = 0;
    let ocfCount = 0;

    for (let i = 0; i < incSorted.length; i++) {
        const inc = incSorted[i];
        const cf = cfSorted[i];
        const bsCurrent = bsSorted[i];
        const bsPrior = bsSorted[i + 1];

        if (!inc || !cf || inc.revenue <= 0) continue;

        // Try EBITDA-based FCFF first
        if (inc.ebitda > 0 && inc.incomeBeforeTax !== 0 && bsCurrent && bsPrior) {
            ebitdaCount++;
            const taxRate = inc.incomeBeforeTax > 0
                ? Math.max(0, Math.min(inc.incomeTaxExpense / inc.incomeBeforeTax, 0.40))
                : TAX_RATE;
            const da = cf.depreciationAndAmortization || 0;
            const capex = Math.abs(cf.capitalExpenditure || 0);
            const wcCurrent = bsCurrent.totalCurrentAssets - bsCurrent.totalCurrentLiabilities;
            const wcPrior = bsPrior.totalCurrentAssets - bsPrior.totalCurrentLiabilities;
            const deltaWC = wcCurrent - wcPrior;

            const { fcff } = computeFCFF(inc.ebitda, taxRate, da, capex, deltaWC);
            margins.push(fcff / inc.revenue);
        } else {
            // Fallback: OCF - CapEx
            ocfCount++;
            const ocf = cf.operatingCashFlow || 0;
            const capex = Math.abs(cf.capitalExpenditure || 0);
            if (ocf > 0) {
                margins.push((ocf - capex) / inc.revenue);
            }
        }
    }

    if (margins.length === 0) return { margin: 0.10, method: 'ocf_fallback' };

    const avgMargin = margins.reduce((a, b) => a + b, 0) / margins.length;
    const method = ocfCount === 0 ? 'ebitda_based' : ebitdaCount === 0 ? 'ocf_fallback' : 'mixed';
    return { margin: Math.max(0.05, Math.min(avgMargin, 0.50)), method };
}

// ─────────────────────────────────────────────────────────
// Task 2: 10-Year FCF Projection with Growth Fade
// ─────────────────────────────────────────────────────────

/**
 * Project cash flows over 10 years using normalized FCFF margin.
 * Projects line items for diagnostics, but base valuation uses normalized FCFF
 * so temporary heavy capex does not get treated as a permanent margin reset.
 *   Phase 1 (years 1-5): full growth rate
 *   Phase 2 (years 6-10): linear fade toward terminal growth
 */
function projectCashFlows(
    baseRevenue: number,
    growthRate: number,
    fcfMargin: number,
    ebitdaMargin: number,
    capexToRevenue: number,
    daToRevenue: number,
    _effectiveTaxRate: number,
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
        const fcff = revenue * fcfMargin;

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
    rawWacc: number;
    components: { costOfEquity: number; costOfDebt: number; equityWeight: number; debtWeight: number; beta: number; riskFreeRate: number; preferredStockWeight?: number };
    clamped: boolean;
    clampDirection?: 'floor' | 'ceiling';
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
    const marketCap = (profile.marketCap ?? profile.mktCap) || 0;
    const preferredStock = latestBalance.preferredStock || 0;
    const totalCapital = totalDebt + marketCap + preferredStock;

    const equityWeight = totalCapital > 0 ? marketCap / totalCapital : (1 - defaults.debtRatio);
    const debtWeight = totalCapital > 0 ? totalDebt / totalCapital : defaults.debtRatio;
    const preferredWeight = totalCapital > 0 ? preferredStock / totalCapital : 0;

    // Cost of debt (or override) - clamp to realistic range [2%, 15%]
    const interestExpense = Math.abs(latestIncome.interestExpense || 0);
    const rawCostOfDebt = totalDebt > 0 ? interestExpense / totalDebt : 0.05;
    const costOfDebt = overrides?.costOfDebt ?? Math.max(0.02, Math.min(rawCostOfDebt, 0.15));

    // Preferred stock dividend rate (industry average fallback)
    const preferredDividendRate = 0.06;

    // WACC with optional preferred stock term
    let wacc = (equityWeight * costOfEquity) + (debtWeight * costOfDebt * (1 - TAX_RATE));
    if (preferredWeight > 0) {
        wacc += preferredWeight * preferredDividendRate;
    }

    // Sanity clamp: WACC between 6% and 15%
    const clampedWACC = Math.max(0.06, Math.min(wacc, 0.15));
    const clampDirection = wacc < 0.06 ? 'floor' : wacc > 0.15 ? 'ceiling' : undefined;

    return {
        wacc: clampedWACC,
        rawWacc: wacc,
        components: {
            costOfEquity, costOfDebt, equityWeight, debtWeight, beta,
            riskFreeRate: RISK_FREE_RATE,
            ...(preferredWeight > 0 ? { preferredStockWeight: preferredWeight } : {}),
        },
        clamped: wacc !== clampedWACC,
        clampDirection,
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
    const waccValues: number[] = [];
    const tgValues: number[] = [];

    // WACC range: ±1% in 0.5% steps (5 values) - use explicit array to avoid floating-point drift
    const waccDeltas = [-0.01, -0.005, 0, 0.005, 0.01];
    for (const d of waccDeltas) {
        waccValues.push(Math.max(0.03, Math.min(0.25, baseWacc + d)));
    }

    // Terminal growth: ±0.5% in 0.25% steps (5 values)
    const tgDeltas = [-0.005, -0.0025, 0, 0.0025, 0.005];
    for (const d of tgDeltas) {
        tgValues.push(Math.max(0, Math.min(baseWacc - 0.01, baseTg + d)));
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
    waccResult: { wacc: number; rawWacc: number; clamped: boolean; clampDirection?: 'floor' | 'ceiling' },
    valuation: { terminalValuePct: number },
    fcfMargin: number,
    componentFCFFMargin: number,
): string[] {
    const warnings: string[] = [];
    if (growth.rate >= 0.30) warnings.push('Growth rate at or near ceiling (35%). High uncertainty.');
    if (waccResult.clamped) {
        if (waccResult.clampDirection === 'floor') {
            warnings.push(`WACC clamped to floor (6%). Raw WACC was ${(waccResult.rawWacc * 100).toFixed(1)}% — valuation likely overstated. Verify beta/peer data.`);
        } else {
            warnings.push(`WACC clamped to ceiling (15%). Raw WACC was ${(waccResult.rawWacc * 100).toFixed(1)}% — valuation likely understated. High-risk inputs detected.`);
        }
    }
    if (valuation.terminalValuePct > 0.80) warnings.push('Terminal value exceeds 80% of total — sensitive to terminal assumptions.');
    if (fcfMargin < 0.08) warnings.push('Low FCF margin. Company may be in heavy investment phase.');
    const marginGap = fcfMargin - componentFCFFMargin;
    if (marginGap > 0.05) {
        warnings.push(`Current EBITDA/CapEx components imply a ${(componentFCFFMargin * 100).toFixed(1)}% FCFF margin vs normalized ${(fcfMargin * 100).toFixed(1)}% — heavy current reinvestment may make component-based DCF too punitive.`);
    }
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
    const [bundle, priceResult, keyMetrics] = await Promise.all([
        fetchDCFDataBundle(sym),
        getPrice({ symbol: sym }),
        fetchFMPKeyMetrics(sym, 'annual', 5).catch(() => [] as FMPKeyMetrics[]),
    ]);
    const { profile, incomeStatements, balanceSheets, cashFlowStatements,
            analystEstimates, revenueSegments } = bundle;

    // ─── 2. Extract key inputs ───────────────────────
    console.log(`📊 [DCF] Step 2: Extracting inputs...`);
    const sortedIncome = [...incomeStatements].sort((a, b) => b.date.localeCompare(a.date));
    const sortedBalance = [...balanceSheets].sort((a, b) => b.date.localeCompare(a.date));
    const sortedCashFlow = [...cashFlowStatements].sort((a, b) => b.date.localeCompare(a.date));
    const latestIncome = sortedIncome[0];
    const latestBalance = sortedBalance[0];
    const latestCashFlow = sortedCashFlow[0];
    const baseRevenue = latestIncome.revenue;
    const marketData = normalizeMarketData(bundle, priceResult.data.price);
    const currentPrice = marketData.currentPrice;
    const filingDate = latestIncome.fillingDate;
    const sharesOutstanding = marketData.sharesOutstanding;

    if (baseRevenue <= 0) {
        throw new APIError(`Cannot run DCF for ${sym}: latest revenue is zero or negative.`, { symbol: sym, baseRevenue });
    }
    if (!sharesOutstanding || sharesOutstanding <= 0 || !isFinite(sharesOutstanding)) {
        throw new APIError(`Cannot run DCF for ${sym}: shares outstanding is invalid.`, { symbol: sym, sharesOutstanding });
    }

    // ─── 3. Derived ratios ───────────────────────────
    const effectiveTaxRate = latestIncome.incomeBeforeTax > 0
        ? Math.max(0, Math.min(latestIncome.incomeTaxExpense / latestIncome.incomeBeforeTax, 0.40))
        : TAX_RATE;
    const rawEbitdaMargin = baseRevenue > 0 ? (latestIncome.ebitda / baseRevenue) : 0.20;
    const ebitdaMargin = Math.max(0.05, Math.min(rawEbitdaMargin, 0.80));
    const rawCapex = latestCashFlow.capitalExpenditure ?? 0;
    const capexToRevenue = rawCapex !== 0 ? Math.abs(rawCapex) / baseRevenue : 0.05;
    const daToRevenue = latestCashFlow.depreciationAndAmortization > 0
        ? latestCashFlow.depreciationAndAmortization / baseRevenue : 0.03;
    const netDebt = marketData.netDebt;
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
    const componentFCFFMargin = computeComponentFCFFMargin(ebitdaMargin, effectiveTaxRate, daToRevenue, capexToRevenue);
    console.log(`📊 [DCF] FCF margin: ${(fcfMargin * 100).toFixed(2)}% (${fcfMethod})`);

    // ─── 7. Peer Beta + WACC ─────────────────────────
    console.log(`📊 [DCF] Step 6: Calculating peer beta & WACC...`);
    const sector = (profile.sector || 'DEFAULT').toUpperCase();
    const sectorDefaults = SECTOR_DEFAULTS[sector] || SECTOR_DEFAULTS['DEFAULT'];
    const targetDE = marketData.marketCap > 0 ? (latestBalance.totalDebt || 0) / marketData.marketCap : 0;
    const peerBetaResult = await calculatePeerBeta(
        bundle.peers,
        targetDE,
        effectiveTaxRate,
        profile.beta ?? sectorDefaults.beta
    );
    console.log(`📊 [DCF] Beta: ${peerBetaResult.leveredBeta.toFixed(3)} (${peerBetaResult.method}, ${peerBetaResult.peersUsed.length} peers)`);

    // Peer beta sanity guard: if peer beta diverges >0.40 absolute units from profile beta, fall back to profile beta
    const MAX_PEER_BETA_DIVERGENCE = 0.40;
    const profileBeta = profile.beta ?? sectorDefaults.beta;
    const divergence = Math.abs(peerBetaResult.leveredBeta - profileBeta);
    if (divergence > MAX_PEER_BETA_DIVERGENCE) {
        console.log(`⚠️ [DCF] Peer beta (${peerBetaResult.leveredBeta.toFixed(2)}) diverges ${(divergence * 100).toFixed(0)}% from profile beta (${profileBeta.toFixed(2)}) — using profile beta`);
        peerBetaResult.leveredBeta = profileBeta;
        peerBetaResult.unleveredBeta = profileBeta; // Sync for consistency
        peerBetaResult.method = 'profile_fallback';
    }

    const normalizedProfileForCapital = { ...profile, marketCap: marketData.marketCap, mktCap: marketData.marketCap, price: currentPrice };
    const waccResult = calculateWACC(normalizedProfileForCapital, latestBalance, latestIncome, {}, peerBetaResult);
    console.log(`📊 [DCF] WACC: ${(waccResult.wacc * 100).toFixed(2)}%${waccResult.clamped ? ' (clamped)' : ''}`);

    // ─── F1: Check for Financial Institutions ─────────────
    console.log(`📊 [DCF] Step 6b: Checking for financial institution...`);
    const finCheck = detectFinancialInstitution(
        { sector: profile.sector, industry: profile.industry },
        { netInterestIncome: latestIncome.netInterestIncome, interestExpense: latestIncome.interestExpense, netPremium: latestIncome.netPremium, revenue: latestIncome.revenue }
    );
    const classification = classifyValuationFramework(bundle, profile, growth, fcfMargin, capexToRevenue, waccResult.wacc, keyMetrics);
    const normalizedForeignDataUsable = isUsableNormalizedForeignMarketData(marketData);
    const adrPharmaRouteAllowed = classification.valuationClass === 'adr_foreign' &&
        normalizedForeignDataUsable &&
        ['pharma_product_cycle_compounder', 'pharma_supercycle_compounder'].includes(classification.reinvestmentSubclass);
    const genericDCFWhileSpecializedModelBuilds = [
        'turnaround_or_low_roic_reinvestment',
        'capital_light_software_compounder',
        'acquisition_platform',
        'semiconductor_ai_acquisition_platform',
        'cyclical_semicap_compounder',
        'biotech_pipeline_compounder',
    ].includes(classification.reinvestmentSubclass) &&
        !['financial', 'utility', 'reit', 'adr_foreign'].includes(classification.valuationClass);
    const frameworkSuitability: ValuationFramework['suitability'] = isUnsupportedFinancialForFramework(finCheck)
        ? {
            isSuitableForDCF: false,
            message: `${finCheck.type} is not suitable for standard FCFF/DCF because debt, deposits, reserves, working capital, and reinvestment do not behave like operating-company capital.`,
        }
        : classification.valuationClass === 'adr_foreign'
            ? {
                isSuitableForDCF: adrPharmaRouteAllowed,
                message: adrPharmaRouteAllowed
                    ? 'ADR/foreign pharma route allowed after market/share/currency normalization; review data-quality warnings.'
                    : 'ADR/foreign listings require currency and ADR-ratio normalization before a reliable production DCF.',
            }
            : genericDCFWhileSpecializedModelBuilds
                ? {
                    isSuitableForDCF: true,
                    message: `${classification.reinvestmentSubclass} specialized model is being built; generic FCFF DCF is shown as an interim full valuation experience.`,
                }
            : {
                isSuitableForDCF: true,
                message: 'DCF is usable, but framework diagnostics should be reviewed alongside the point estimate.',
            };

    let modelUsed = 'standard_dcf';
    let altValuationResult: DDMResult | FFOResult | FCFEResult | null = null;
    let finCostOfEquity = 0;
    let finTerminalGrowthRate = terminalGrowthRate;

    if (finCheck.isFinancialInstitution && finCheck.type) {
        modelUsed = `financial_${finCheck.type.toLowerCase()}`;
        console.log(`🏦 [DCF] Financial institution detected: ${finCheck.type} - ${finCheck.reason} (using ${modelUsed})`);

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
    const warnings = generateWarnings(growth, waccResult, valuation, fcfMargin, componentFCFFMargin);
    if (growth.warning) warnings.push(growth.warning);
    warnings.push(...marketData.warnings);
    // Note: GDP ceiling enforcement for user overrides happens in step 4 above (throws).
    // This warning catches auto-calculated edge cases (should be rare due to Math.min clamp).
    if (terminalGrowthRate > gdpCeiling) {
        warnings.push(`Terminal growth (${(terminalGrowthRate * 100).toFixed(1)}%) exceeds GDP ceiling (${(gdpCeiling * 100).toFixed(1)}%).`);
    }
    if (sym === 'TSLA') {
        warnings.push('TSLA uses a dedicated scenario framework; base value excludes separately modeled real-option value for FSD/Robotaxi/Optimus.');
    }
    if (classification.reinvestmentSubclass === 'capex_heavy_scaled_reinvestor' && sym !== 'TSLA') {
        warnings.push('Capex-heavy scaled reinvestor uses a scenario-based valuation; review bear/base/bull range and capex fade assumptions.');
    }
    if (genericDCFWhileSpecializedModelBuilds) {
        warnings.push(`${classification.reinvestmentSubclass} specialized model is being built; generic FCFF DCF is provided as an interim valuation view.`);
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

    const buildScenarioValue = (label: string, growthRate: number, margin: number, wacc: number): ValuationRange => {
        const scenarioProjections = projectCashFlows(
            baseRevenue,
            growthRate,
            margin,
            ebitdaMargin,
            capexToRevenue,
            daToRevenue,
            effectiveTaxRate,
            PROJECTION_YEARS,
            terminalGrowthRate,
        );
        const scenarioValue = calculateIntrinsicValue(scenarioProjections, wacc, terminalGrowthRate, sharesOutstanding, netDebt, cash, filingDate);
        return buildValuationRange(label, scenarioValue.intrinsicValuePerShare, currentPrice, 'ebitda_based_fcff');
    };
    const teslaScenario = sym === 'TSLA' ? valueTeslaScenarioDCF(bundle, marketData) : null;
    const utilityDDMScenario = !teslaScenario && frameworkSuitability.isSuitableForDCF && classification.valuationClass === 'utility'
        ? valueRegulatedUtilityDDM(bundle, growth, waccResult.components.costOfEquity, sharesOutstanding)
        : null;
    const capexHeavyScenario = !teslaScenario && !utilityDDMScenario && frameworkSuitability.isSuitableForDCF && classification.reinvestmentSubclass === 'capex_heavy_scaled_reinvestor'
        ? valueCapexHeavyScaledReinvestorDCF(bundle, marketData, waccResult.wacc)
        : null;
    const highROICScenario = !teslaScenario && !capexHeavyScenario && frameworkSuitability.isSuitableForDCF && classification.reinvestmentSubclass === 'high_roic_mature_compounder'
        ? {
            model: 'high_roic_mature_fade_bridge_fcff',
            bear: valueHighROICMatureFadeBridgeFCFF(bundle, keyMetrics, { rate: Math.max(-0.05, growth.rate - 0.02) }, Math.min(0.20, waccResult.wacc + 0.01), sharesOutstanding, netDebt),
            base: valueHighROICMatureFadeBridgeFCFF(bundle, keyMetrics, growth, waccResult.wacc, sharesOutstanding, netDebt),
            bull: valueHighROICMatureFadeBridgeFCFF(bundle, keyMetrics, { rate: Math.min(0.35, growth.rate + 0.02) }, Math.max(0.04, waccResult.wacc - 0.01), sharesOutstanding, netDebt),
        }
        : null;
    const profitableReinvestmentScenario = !teslaScenario && !capexHeavyScenario && !highROICScenario && frameworkSuitability.isSuitableForDCF &&
        classification.reinvestmentSubclass === 'profitable_reinvestment_other' &&
        classification.valuationClass !== 'mature_defensive' &&
        classification.valuationClass !== 'cyclical'
        ? {
            ...valueProfitableReinvestmentFadeBridgeFCFF(bundle, keyMetrics, growth, waccResult.wacc, sharesOutstanding, netDebt),
            bear: valueProfitableReinvestmentFadeBridgeFCFF(bundle, keyMetrics, { rate: Math.max(-0.05, growth.rate - 0.03) }, Math.min(0.20, waccResult.wacc + 0.01), sharesOutstanding, netDebt).base,
        }
        : null;
    // Cyclical semicap mid-cycle model is intentionally disabled for now.
    // Route semicap names through generic FCFF with the specialized-model warning until the model is retuned.
    const semicapScenario = null;
    const pharmaScenario = !teslaScenario && !capexHeavyScenario && !highROICScenario && !profitableReinvestmentScenario && !semicapScenario && frameworkSuitability.isSuitableForDCF &&
        ['pharma_product_cycle_compounder', 'pharma_supercycle_compounder'].includes(classification.reinvestmentSubclass)
        ? valuePharmaProductCycleDCF(
            bundle,
            currentPrice,
            classification.reinvestmentSubclass === 'pharma_supercycle_compounder' ? 'supercycle' : 'product_cycle',
        )
        : null;
    const bearRange = teslaScenario
        ? buildValuationRange('Bear', teslaScenario.bear.perShare, currentPrice, teslaScenario.bear.scenario)
        : utilityDDMScenario
        ? buildValuationRange('Bear', utilityDDMScenario.bear.perShare, currentPrice, utilityDDMScenario.bear.scenario)
        : capexHeavyScenario
        ? buildValuationRange('Bear', capexHeavyScenario.bear.perShare, currentPrice, capexHeavyScenario.bear.scenario)
        : highROICScenario
        ? buildValuationRange('Bear', highROICScenario.bear.perShare, currentPrice, `${highROICScenario.model}_bear`)
        : profitableReinvestmentScenario
        ? buildValuationRange('Bear', profitableReinvestmentScenario.bear.perShare, currentPrice, profitableReinvestmentScenario.bear.model)
        : semicapScenario
        ? buildValuationRange('Bear', semicapScenario.bear.perShare, currentPrice, semicapScenario.bear.scenario)
        : pharmaScenario
        ? buildValuationRange('Bear', pharmaScenario.bear.perShare, currentPrice, pharmaScenario.bear.scenario)
        : frameworkSuitability.isSuitableForDCF
        ? buildScenarioValue('Bear', Math.max(-0.05, growth.rate - 0.04), Math.max(0.03, fcfMargin - 0.04), Math.min(0.20, waccResult.wacc + 0.01))
        : buildValuationRange('Bear', 0, currentPrice, 'dcf_unsuitable');
    const baseRange = teslaScenario
        ? buildValuationRange('Base', teslaScenario.base.perShare, currentPrice, teslaScenario.base.scenario)
        : utilityDDMScenario
        ? buildValuationRange('Base', utilityDDMScenario.base.perShare, currentPrice, utilityDDMScenario.base.scenario)
        : capexHeavyScenario
        ? buildValuationRange('Base', capexHeavyScenario.base.perShare, currentPrice, capexHeavyScenario.base.scenario)
        : highROICScenario
        ? buildValuationRange('Base', highROICScenario.base.perShare, currentPrice, highROICScenario.model)
        : profitableReinvestmentScenario
        ? buildValuationRange('Base', profitableReinvestmentScenario.base.perShare, currentPrice, profitableReinvestmentScenario.model)
        : semicapScenario
        ? buildValuationRange('Base', semicapScenario.base.perShare, currentPrice, semicapScenario.base.scenario)
        : pharmaScenario
        ? buildValuationRange('Base', pharmaScenario.base.perShare, currentPrice, pharmaScenario.base.scenario)
        : frameworkSuitability.isSuitableForDCF
        ? buildValuationRange('Base', valuation.intrinsicValuePerShare, currentPrice, modelUsed !== 'standard_dcf' ? modelUsed : 'ebitda_based_fcff')
        : buildValuationRange('Base', 0, currentPrice, 'dcf_unsuitable');
    const bullRange = teslaScenario
        ? buildValuationRange('Bull', teslaScenario.bull.perShare, currentPrice, teslaScenario.bull.scenario)
        : utilityDDMScenario
        ? buildValuationRange('Bull', utilityDDMScenario.bull.perShare, currentPrice, utilityDDMScenario.bull.scenario)
        : capexHeavyScenario
        ? buildValuationRange('Bull', capexHeavyScenario.bull.perShare, currentPrice, capexHeavyScenario.bull.scenario)
        : highROICScenario
        ? buildValuationRange('Bull', highROICScenario.bull.perShare, currentPrice, `${highROICScenario.model}_bull`)
        : profitableReinvestmentScenario
        ? buildValuationRange('Bull', profitableReinvestmentScenario.bull.perShare, currentPrice, profitableReinvestmentScenario.bull.model)
        : semicapScenario
        ? buildValuationRange('Bull', semicapScenario.bull.perShare, currentPrice, semicapScenario.bull.scenario)
        : pharmaScenario
        ? buildValuationRange('Bull', pharmaScenario.bull.perShare, currentPrice, pharmaScenario.bull.scenario)
        : frameworkSuitability.isSuitableForDCF
        ? buildScenarioValue('Bull', Math.min(0.35, growth.rate + 0.04), Math.min(0.50, fcfMargin + 0.04), Math.max(0.04, waccResult.wacc - 0.01))
        : buildValuationRange('Bull', 0, currentPrice, 'dcf_unsuitable');
    const finalEBITDAForReverse = finalEBITDA > 0 ? finalEBITDA : 0;
    const impliedExitMultiple = finalEBITDAForReverse > 0
        ? (marketData.enterpriseValue * Math.pow(1 + waccResult.wacc, PROJECTION_YEARS) - valuation.sumDiscountedFCF) / finalEBITDAForReverse
        : null;
    const relativeValuation = frameworkSuitability.isSuitableForDCF
        ? await buildRelativeValuation(bundle, keyMetrics, baseRevenue, ebitdaMargin, marketData)
        : undefined;
    const confidenceResult = deriveFrameworkConfidence(
        classification,
        frameworkSuitability,
        marketData,
        valuation.terminalValuePct,
        waccResult.clamped,
    );
    const priceOffsetConfidence = derivePriceOffsetConfidence(baseRange.value, currentPrice, frameworkSuitability);
    const actualValues = !frameworkSuitability.isSuitableForDCF
        ? buildActualValues(latestIncome, latestBalance, marketData)
        : undefined;
    const primaryFrameworkModel = teslaScenario
        ? teslaScenario.model
        : utilityDDMScenario
        ? utilityDDMScenario.model
        : capexHeavyScenario
        ? capexHeavyScenario.model
        : highROICScenario
        ? highROICScenario.model
        : profitableReinvestmentScenario
        ? profitableReinvestmentScenario.model
        : semicapScenario
        ? semicapScenario.model
        : pharmaScenario
        ? pharmaScenario.model
        : frameworkSuitability.isSuitableForDCF
        ? (classification.reinvestmentSubclass !== 'not_reinvestment' ? classification.reinvestmentSubclass : 'standard_fcff')
        : 'dcf_unsuitable_actual_values';
    const selectedFramework = teslaScenario
        ? 'tesla_scenario_framework'
        : utilityDDMScenario
            ? 'regulated_utility_dividend_discount_model'
            : capexHeavyScenario
            ? 'scenario_based_capex_heavy_scaled_reinvestor'
            : highROICScenario
                ? 'high_roic_mature_fade_bridge'
                : profitableReinvestmentScenario
                    ? 'profitable_reinvestment_fade_bridge'
                    : semicapScenario
                        ? 'cyclical_semicap_midcycle_dcf'
                        : pharmaScenario
                    ? `risk_adjusted_pharma_${pharmaScenario.framework}`
                    : frameworkSuitability.isSuitableForDCF
                        ? 'intrinsic_dcf_with_framework_diagnostics'
                        : 'actual_values_only';
    const reverseInterpretation = teslaScenario
        ? `Base TSLA scenario market-price reverse check: ${teslaScenario.reverseTerminalGrowth.find(r => r.scenario === 'base_industry_beta')?.flag ?? 'N/A'}.`
        : utilityDDMScenario
            ? `Utility DDM selected. Base dividend $${utilityDDMScenario.base.dividendPerShare.toFixed(2)}, payout ${(utilityDDMScenario.base.payoutRatio * 100).toFixed(1)}%, cost of equity ${(utilityDDMScenario.base.costOfEquity * 100).toFixed(2)}%, stable growth ${(utilityDDMScenario.base.growthRate * 100).toFixed(2)}%.`
            : capexHeavyScenario
            ? `Base capex-heavy scenario market-price reverse check: ${capexHeavyScenario.reverseTerminalGrowth.find(r => r.scenario === 'base_tsla_directional_capex_fade')?.flag ?? 'N/A'}.`
            : highROICScenario
                ? `High-ROIC fade bridge reverse check requires ${(highROICScenario.base.reverseRequiredGrowth * 100).toFixed(2)}% terminal-step growth pressure versus a ${(highROICScenario.base.stableGrowth * 100).toFixed(2)}% stable-growth model.`
                : profitableReinvestmentScenario
                    ? `Profitable reinvestment fade bridge reverse check requires ${(profitableReinvestmentScenario.base.reverseRequiredGrowth * 100).toFixed(2)}% terminal-step growth pressure versus a ${(profitableReinvestmentScenario.base.stableGrowth * 100).toFixed(2)}% stable-growth model.`
                    : semicapScenario
                        ? `Cyclical semicap mid-cycle model selected. Mid-cycle revenue $${(semicapScenario.midCycleRevenue / 1e9).toFixed(2)}B, normalized growth ${(semicapScenario.normalizedGrowth * 100).toFixed(2)}%, base margin ${(semicapScenario.baseMargin * 100).toFixed(2)}%.`
                        : pharmaScenario
                    ? `Pharma reverse check: required pipeline credit ${(pharmaScenario.reverseDiagnostics.requiredPipelineCredit * 100).toFixed(2)}%, terminal margin ${(pharmaScenario.reverseDiagnostics.requiredTerminalMargin * 100).toFixed(2)}%, growth multiplier ${pharmaScenario.reverseDiagnostics.requiredGrowthMultiplier.toFixed(2)}x. ${pharmaScenario.reverseDiagnostics.notes.join(' ')}`
                    : reverseDCFResult.interpretation;
    const valuationFramework: ValuationFramework = {
        primaryModel: primaryFrameworkModel,
        selectedFramework,
        classification,
        confidence: frameworkSuitability.isSuitableForDCF ? priceOffsetConfidence.confidence : confidenceResult.confidence,
        confidenceReasons: teslaScenario
            ? [priceOffsetConfidence.reason, 'Tesla valuation is scenario-dependent and highly sensitive to growth, margin, WACC, dilution, and optionality assumptions.']
            : utilityDDMScenario
                ? [priceOffsetConfidence.reason, 'Regulated utility route uses dividend discount model because payout policy is more informative than FCFF reinvestment math.']
                : capexHeavyScenario
                ? [priceOffsetConfidence.reason, 'Capex-heavy scaled reinvestor valuation is scenario-based and sensitive to capex fade, EBITDA margin, and terminal assumptions.']
                : highROICScenario
                ? [priceOffsetConfidence.reason, 'High-ROIC mature compounder uses capped fade-bridge assumptions by sector/scale to avoid terminal-growth fantasy.']
                    : profitableReinvestmentScenario
                        ? [priceOffsetConfidence.reason, 'Profitable reinvestment fade bridge links growth, ROIC, reinvestment, margin normalization, dilution, and GDP-like terminal growth.']
                        : semicapScenario
                            ? [priceOffsetConfidence.reason, 'Cyclical semicap model uses mid-cycle revenue, normalized margins, and cycle-adjusted WACC.']
                            : pharmaScenario
                        ? [priceOffsetConfidence.reason, 'Risk-adjusted pharma product-cycle valuation is sensitive to erosion timing, pipeline credit, growth duration, and terminal margin.']
                        : genericDCFWhileSpecializedModelBuilds
                            ? [priceOffsetConfidence.reason, `${classification.reinvestmentSubclass} specialized model is being built; generic FCFF DCF is interim.`, ...confidenceResult.reasons]
                            : [priceOffsetConfidence.reason, ...confidenceResult.reasons],
        modelSelectionReasons: [
            `Valuation class: ${classification.valuationClass}`,
            `Reinvestment subclass: ${classification.reinvestmentSubclass}`,
            teslaScenario ? 'TSLA explicit scenario framework selected.' :
                utilityDDMScenario ? 'Regulated utility DDM selected before reinvestment subclass routing.' :
                capexHeavyScenario ? 'Capex-heavy scaled reinvestor scenario framework selected.' :
                highROICScenario ? 'High-ROIC fade bridge selected for mature compounder subclass.' :
                profitableReinvestmentScenario ? 'Profitable reinvestment fade bridge selected from model lab.' :
                semicapScenario ? 'Cyclical semicap mid-cycle model selected from model lab.' :
                pharmaScenario ? `${pharmaScenario.framework === 'supercycle' ? 'Pharma supercycle' : 'Pharma product-cycle'} framework selected.` :
                genericDCFWhileSpecializedModelBuilds ? `${classification.reinvestmentSubclass} has no production-ready specialized model yet; using generic FCFF DCF as interim full valuation.` :
                frameworkSuitability.message,
        ],
        suitability: frameworkSuitability,
        primaryResult: baseRange,
        scenarioRange: {
            bear: bearRange,
            base: baseRange,
            bull: bullRange,
        },
        reverseImpliedAssumptions: {
            impliedGrowthRate: teslaScenario?.reverseTerminalGrowth.find(r => r.scenario === 'base_industry_beta')?.requiredTerminalGrowth ??
                utilityDDMScenario?.base.growthRate ??
                capexHeavyScenario?.reverseTerminalGrowth.find(r => r.scenario === 'base_tsla_directional_capex_fade')?.requiredTerminalGrowth ??
                highROICScenario?.base.reverseRequiredGrowth ??
                profitableReinvestmentScenario?.base.reverseRequiredGrowth ??
                semicapScenario?.normalizedGrowth ??
                pharmaScenario?.reverseDiagnostics.requiredGrowthMultiplier ??
                reverseDCFResult.impliedGrowthRate,
            impliedGrowthFormatted: teslaScenario
                ? `${((teslaScenario.reverseTerminalGrowth.find(r => r.scenario === 'base_industry_beta')?.requiredTerminalGrowth ?? 0) * 100).toFixed(2)}% terminal growth required`
                : utilityDDMScenario
                    ? `${(utilityDDMScenario.base.growthRate * 100).toFixed(2)}% stable dividend growth`
                    : capexHeavyScenario
                    ? `${((capexHeavyScenario.reverseTerminalGrowth.find(r => r.scenario === 'base_tsla_directional_capex_fade')?.requiredTerminalGrowth ?? 0) * 100).toFixed(2)}% terminal growth required`
                    : highROICScenario
                        ? `${(highROICScenario.base.reverseRequiredGrowth * 100).toFixed(2)}% reverse growth pressure`
                        : profitableReinvestmentScenario
                            ? `${(profitableReinvestmentScenario.base.reverseRequiredGrowth * 100).toFixed(2)}% reverse growth pressure`
                            : semicapScenario
                                ? `${(semicapScenario.normalizedGrowth * 100).toFixed(2)}% normalized mid-cycle growth`
                                : pharmaScenario
                            ? `${pharmaScenario.reverseDiagnostics.requiredGrowthMultiplier.toFixed(2)}x base product-cycle growth multiplier required`
                            : reverseDCFResult.impliedGrowthFormatted,
            impliedExitMultiple: teslaScenario?.base.impliedEVTo2033EBITDA ?? (impliedExitMultiple && Number.isFinite(impliedExitMultiple) ? impliedExitMultiple : null),
            interpretation: reverseInterpretation,
        },
        relativeValuation,
        marketData,
        actualValues,
        warnings,
    };

    const result: DCFResult = {
        metadata: {
            companyName: profile.companyName, ticker: sym,
            sector: profile.sector || 'Unknown',
            dcfMethod: primaryFrameworkModel,
            analysisDate: new Date().toISOString(),
            financialInstitution: finCheck.isFinancialInstitution ? { type: finCheck.type, reason: finCheck.reason } : undefined,
        },
        currentMarketData: {
            currentPrice,
            marketCap: marketData.marketCap,
            sharesOutstanding,
            enterpriseValue: marketData.enterpriseValue,
            source: marketData.source,
            warnings: marketData.warnings,
        },
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
            intrinsicValue: !frameworkSuitability.isSuitableForDCF
                ? 0
                : (teslaScenario || utilityDDMScenario || capexHeavyScenario || highROICScenario || profitableReinvestmentScenario || semicapScenario || pharmaScenario)
                ? baseRange.value
                : (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
                ? Math.round(altValuationResult.intrinsicValue * 100) / 100
                : (finCheck.isFinancialInstitution ? 0 : Math.round(valuation.intrinsicValuePerShare * 100) / 100),
            currentPrice,
            upsideDownside: !frameworkSuitability.isSuitableForDCF
                ? 'N/A'
                : (teslaScenario || utilityDDMScenario || capexHeavyScenario || highROICScenario || profitableReinvestmentScenario || semicapScenario || pharmaScenario)
                ? baseRange.upside
                : (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
                ? (((altValuationResult.intrinsicValue - currentPrice) / currentPrice * 100).toFixed(2) + '%')
                : (finCheck.isFinancialInstitution ? 'N/A' : (upside * 100).toFixed(2) + '%'),
            valuation: !frameworkSuitability.isSuitableForDCF
                ? 'USE_MARKET_PRICE'
                : (teslaScenario || utilityDDMScenario || capexHeavyScenario || highROICScenario || profitableReinvestmentScenario || semicapScenario || pharmaScenario)
                ? (baseRange.value > currentPrice * 1.15 ? 'UNDERVALUED' :
                   baseRange.value < currentPrice * 0.85 ? 'OVERVALUED' : 'FAIRLY_VALUED')
                : (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
                ? (altValuationResult.intrinsicValue > currentPrice * 1.15 ? 'UNDERVALUED' :
                   altValuationResult.intrinsicValue < currentPrice * 0.85 ? 'OVERVALUED' : 'FAIRLY_VALUED')
                : (finCheck.isFinancialInstitution ? 'USE_MARKET_PRICE' :
                   (upside > 0.15 ? 'UNDERVALUED' : upside < -0.15 ? 'OVERVALUED' : 'FAIRLY_VALUED')),
        },
        reverseDCF: reverseDCFResult,
        investmentRecommendation: {
            confidence: valuationFramework.confidence,
            recommendation: !frameworkSuitability.isSuitableForDCF
                ? 'USE_MARKET_PRICE'
                : (teslaScenario || utilityDDMScenario || capexHeavyScenario || highROICScenario || profitableReinvestmentScenario || semicapScenario || pharmaScenario)
                ? (baseRange.value > currentPrice * 1.20 ? 'BUY' :
                   baseRange.value > currentPrice * 0.90 ? 'HOLD' : 'SELL')
                : (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
                ? (altValuationResult.intrinsicValue > currentPrice * 1.20 ? 'BUY' :
                   altValuationResult.intrinsicValue < currentPrice * 0.80 ? 'SELL' : 'HOLD')
                : (finCheck.isFinancialInstitution ? 'USE_MARKET_PRICE' :
                   (upside > 0.20 ? 'BUY' : upside > -0.10 ? 'HOLD' : 'SELL')),
            reasoning: teslaScenario
                ? `Tesla scenario framework selected. Base scenario IV $${teslaScenario.base.perShare.toFixed(2)}, bear $${teslaScenario.bear.perShare.toFixed(2)}, bull $${teslaScenario.bull.perShare.toFixed(2)}. Market-implied base terminal growth: ${((teslaScenario.reverseTerminalGrowth.find(r => r.scenario === 'base_industry_beta')?.requiredTerminalGrowth ?? 0) * 100).toFixed(2)}%.`
                : utilityDDMScenario
                ? `Regulated utility DDM selected. Base IV $${utilityDDMScenario.base.perShare.toFixed(2)}, bear $${utilityDDMScenario.bear.perShare.toFixed(2)}, bull $${utilityDDMScenario.bull.perShare.toFixed(2)}. ${reverseInterpretation}`
                : capexHeavyScenario
                ? `Capex-heavy scaled reinvestor scenario framework selected. Base scenario IV $${capexHeavyScenario.base.perShare.toFixed(2)}, bear $${capexHeavyScenario.bear.perShare.toFixed(2)}, bull $${capexHeavyScenario.bull.perShare.toFixed(2)}. Market-implied base terminal growth: ${((capexHeavyScenario.reverseTerminalGrowth.find(r => r.scenario === 'base_tsla_directional_capex_fade')?.requiredTerminalGrowth ?? 0) * 100).toFixed(2)}%.`
                : highROICScenario
                ? `High-ROIC fade bridge selected. Base IV $${highROICScenario.base.perShare.toFixed(2)}, bear $${highROICScenario.bear.perShare.toFixed(2)}, bull $${highROICScenario.bull.perShare.toFixed(2)}. ${reverseInterpretation}`
                : profitableReinvestmentScenario
                ? `Profitable reinvestment fade bridge selected. Base IV $${profitableReinvestmentScenario.base.perShare.toFixed(2)}, bear $${profitableReinvestmentScenario.bear.perShare.toFixed(2)}, bull $${profitableReinvestmentScenario.bull.perShare.toFixed(2)}. ${reverseInterpretation}`
                : semicapScenario
                ? `Cyclical semicap mid-cycle model selected. Base IV $${semicapScenario.base.perShare.toFixed(2)}, bear $${semicapScenario.bear.perShare.toFixed(2)}, bull $${semicapScenario.bull.perShare.toFixed(2)}. ${reverseInterpretation}`
                : pharmaScenario
                ? `${pharmaScenario.framework === 'supercycle' ? 'Pharma supercycle' : 'Pharma product-cycle'} framework selected. Base IV $${pharmaScenario.base.perShare.toFixed(2)}, bear $${pharmaScenario.bear.perShare.toFixed(2)}, bull $${pharmaScenario.bull.perShare.toFixed(2)}. ${reverseInterpretation}`
                : !frameworkSuitability.isSuitableForDCF
                ? `${frameworkSuitability.message} Current market price is $${currentPrice.toFixed(2)}; actual values are provided in valuationFramework.actualValues.`
                : (finCheck.isFinancialInstitution && altValuationResult && altValuationResult.intrinsicValue > 0)
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
        valuationFramework,
    };

    console.log(`✅ [DCF v5] Complete for ${sym}. IV: $${valuation.intrinsicValuePerShare.toFixed(2)} | Price: $${currentPrice.toFixed(2)} | Upside: ${(upside * 100).toFixed(1)}%`);
    return result;
}
