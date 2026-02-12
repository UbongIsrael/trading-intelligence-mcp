/**
 * DCF (Discounted Cash Flow) Analysis Tool
 * 
 * MCP tool registration for the DCF analysis service.
 * Exposes a single `run_dcf_analysis` tool that performs comprehensive
 * intrinsic valuation of a stock using discounted cash flow methodology.
 */

import { z } from 'zod';
import { registerTool } from './registry.js';
import { runDCFAnalysis, type DCFResult } from '../services/dcf-analysis.js';

// ─────────────────────────────────────────────────────────
// Input Schema
// ─────────────────────────────────────────────────────────

const DCFInputSchema = z.object({
    symbol: z.string().min(1).max(10).describe(
        'Stock ticker symbol (e.g., AAPL, MSFT, GOOGL). Must be a US-listed equity.'
    ),
});

// ─────────────────────────────────────────────────────────
// Output Formatter
// ─────────────────────────────────────────────────────────

function formatDCFOutput(result: DCFResult): string {
    const { metadata, currentMarketData, growthAnalysis, waccCalculation, cashFlowProjections, terminalValue, valuationSummary, investmentRecommendation, sensitivityAnalysis, riskFactors, dataQuality, historicalData } = result;

    const fmtNum = (n: number | null | undefined, decimals = 2): string => {
        if (n === null || n === undefined) return 'N/A';
        if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(decimals)}B`;
        if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(decimals)}M`;
        if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(decimals)}K`;
        return `$${n.toFixed(decimals)}`;
    };

    const fmtPct = (n: number | null | undefined): string => {
        if (n === null || n === undefined) return 'N/A';
        return `${(n * 100).toFixed(2)}%`;
    };

    let output = '';

    // ── Header ──────────────────────────────
    output += `\n${'═'.repeat(70)}\n`;
    output += `  📊 DCF ANALYSIS: ${metadata.companyName} (${metadata.ticker})\n`;
    output += `${'═'.repeat(70)}\n`;
    output += `  Date: ${metadata.analysisDate} | Method: ${metadata.dcfMethod === 'fcf_based' ? 'Free Cash Flow' : 'Earnings-Based'}\n`;
    output += `  Data Source: ${metadata.dataSource}\n`;

    // ── Current Market Data ─────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  📈 CURRENT MARKET DATA\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Current Price:       ${fmtNum(currentMarketData.currentPrice)}\n`;
    output += `  Market Cap:          ${fmtNum(currentMarketData.marketCap)}\n`;
    output += `  P/E Ratio:           ${currentMarketData.currentPE?.toFixed(2) ?? 'N/A'}\n`;
    output += `  Beta:                ${currentMarketData.beta.toFixed(2)}\n`;
    output += `  Shares Outstanding:  ${(currentMarketData.sharesOutstanding / 1e9).toFixed(2)}B\n`;

    // ── Historical Financial Data ──────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  📋 HISTORICAL DATA (${historicalData.yearsAnalyzed} years)\n`;
    output += `${'─'.repeat(70)}\n`;
    for (const d of historicalData.annualData.slice(0, 5)) {
        output += `  ${d.year}: Revenue ${fmtNum(d.revenue)} | `;
        if (d.freeCashFlow !== undefined) output += `FCF ${fmtNum(d.freeCashFlow)} | `;
        if (d.eps !== undefined) output += `EPS $${d.eps.toFixed(2)} | `;
        if (d.capex !== undefined) output += `CapEx ${fmtNum(d.capex)}`;
        output += '\n';
    }

    // ── Growth Analysis ─────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  📈 GROWTH ANALYSIS\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Historical CAGRs:\n`;
    output += `    3-Year FCF/Earnings:  ${fmtPct(growthAnalysis.historicalGrowthRates.fcfCagr3yr)}\n`;
    output += `    5-Year FCF/Earnings:  ${fmtPct(growthAnalysis.historicalGrowthRates.fcfCagr5yr)}\n`;
    output += `    3-Year Revenue:       ${fmtPct(growthAnalysis.historicalGrowthRates.revenueCagr3yr)}\n`;
    output += `    3-Year Earnings:      ${fmtPct(growthAnalysis.historicalGrowthRates.earningsCagr3yr)}\n`;
    output += `    Growth Trend:         ${growthAnalysis.historicalGrowthRates.growthTrend}\n\n`;
    output += `  Projection Assumptions:\n`;
    output += `    Phase 1 (${growthAnalysis.projectionAssumptions.phase1.years}): ${fmtPct(growthAnalysis.projectionAssumptions.phase1.growthRate)}\n`;
    output += `      ↳ ${growthAnalysis.projectionAssumptions.phase1.rationale}\n`;
    output += `    Phase 2 (${growthAnalysis.projectionAssumptions.phase2.years}): ${fmtPct(growthAnalysis.projectionAssumptions.phase2.growthRate)}\n`;
    output += `      ↳ ${growthAnalysis.projectionAssumptions.phase2.rationale}\n`;

    // ── WACC ────────────────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  💰 WACC CALCULATION\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  WACC: ${waccCalculation.waccFormatted}\n\n`;
    output += `  Cost of Equity (CAPM):\n`;
    output += `    Formula: ${waccCalculation.components.costOfEquity.formula}\n`;
    output += `    Risk-Free Rate:     ${fmtPct(waccCalculation.components.costOfEquity.riskFreeRate)}\n`;
    output += `    Beta:               ${waccCalculation.components.costOfEquity.beta.toFixed(2)}\n`;
    output += `    Market Risk Premium: ${fmtPct(waccCalculation.components.costOfEquity.marketRiskPremium)}\n\n`;
    output += `  Cost of Debt:\n`;
    output += `    Pre-Tax:  ${fmtPct(waccCalculation.components.costOfDebt.preTax)}\n`;
    output += `    After-Tax: ${fmtPct(waccCalculation.components.costOfDebt.afterTax)}\n`;
    output += `    Tax Rate:  ${fmtPct(waccCalculation.components.costOfDebt.taxRate)}\n\n`;
    output += `  Capital Structure:\n`;
    output += `    Equity Weight: ${fmtPct(waccCalculation.components.capitalStructure.equityWeight)}\n`;
    output += `    Debt Weight:   ${fmtPct(waccCalculation.components.capitalStructure.debtWeight)}\n`;

    // ── Cash Flow Projections ───────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  📊 CASH FLOW PROJECTIONS\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Base ${cashFlowProjections.baseMetric}: ${fmtNum(cashFlowProjections.baseValue)}\n\n`;
    for (const p of cashFlowProjections.projections) {
        output += `  Year ${p.year} (${p.calendarYear}):  ${fmtNum(p.projectedValue)}  [${fmtPct(p.growthRate)} - ${p.phase}]\n`;
    }

    // ── Terminal Value ──────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  🏁 TERMINAL VALUE (Year ${terminalValue.terminalYear})\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Final Cash Flow: ${fmtNum(terminalValue.finalCashFlow)}\n\n`;
    output += `  Perpetuity Growth Method:\n`;
    output += `    Terminal Growth Rate: ${fmtPct(terminalValue.methods.perpetuityGrowth.growthRate)}\n`;
    output += `    Terminal Value:       ${fmtNum(terminalValue.methods.perpetuityGrowth.terminalValue)}\n\n`;
    output += `  Exit Multiple Method:\n`;
    output += `    ${terminalValue.methods.exitMultiple.multipleType} Multiple: ${terminalValue.methods.exitMultiple.multiple}x\n`;
    output += `    Terminal Value:       ${fmtNum(terminalValue.methods.exitMultiple.terminalValue)}\n\n`;
    output += `  Average Term. Value:    ${fmtNum(terminalValue.methods.average)}\n`;
    if (terminalValue.validation.warnings.length > 0) {
        output += `  ⚠️  ${terminalValue.validation.warnings.join('; ')}\n`;
    }

    // ── Valuation Summary ───────────────────
    output += `\n${'═'.repeat(70)}\n`;
    output += `  🎯 VALUATION SUMMARY\n`;
    output += `${'═'.repeat(70)}\n`;
    output += `  PV of Projected Cash Flows: ${fmtNum(result.presentValueAnalysis.sumPvCashFlows)}\n`;
    output += `  PV of Terminal Value:       ${fmtNum(result.presentValueAnalysis.terminalValuePv)}\n`;
    output += `  Enterprise Value / Share:   ${fmtNum(valuationSummary.enterpriseValuePerShare)}\n`;
    output += `  Net Debt / Share:           ${fmtNum(valuationSummary.netDebtPerShare)}\n`;
    output += `  ┌─────────────────────────────────────────────────┐\n`;
    output += `  │  INTRINSIC VALUE:  $${valuationSummary.intrinsicValue.toFixed(2)}  per share            │\n`;
    output += `  │  CURRENT PRICE:    $${valuationSummary.currentPrice.toFixed(2)}  per share            │\n`;
    output += `  │  UPSIDE/DOWNSIDE:  ${valuationSummary.upsideDownsideFormatted}                      │\n`;
    output += `  │  VALUATION:        ${valuationSummary.valuation}                        │\n`;
    output += `  └─────────────────────────────────────────────────┘\n`;

    // ── Recommendation ──────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  🏆 INVESTMENT RECOMMENDATION\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Recommendation: ${investmentRecommendation.recommendation}\n`;
    output += `  Confidence:     ${investmentRecommendation.confidence}\n`;
    output += `  Target Price:   $${investmentRecommendation.targetPrice.toFixed(2)}\n`;
    output += `  Expected Return: ${fmtPct(investmentRecommendation.expectedReturn)}\n`;
    output += `  Rationale:      ${investmentRecommendation.rationale}\n`;

    // ── Sensitivity Analysis ────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  📐 SENSITIVITY ANALYSIS\n`;
    output += `${'─'.repeat(70)}\n`;

    output += `  WACC Sensitivity:\n`;
    for (const s of sensitivityAnalysis.waccSensitivity) {
        output += `    ${s.scenario}: WACC ${fmtPct(s.wacc)} → IV $${s.intrinsicValue.toFixed(2)} (${fmtPct(s.upsideDownside)})\n`;
    }

    output += `\n  Growth Rate Sensitivity:\n`;
    for (const s of sensitivityAnalysis.growthSensitivity) {
        output += `    ${s.scenario}: P1 ${fmtPct(s.phase1Growth)}, P2 ${fmtPct(s.phase2Growth)} → IV $${s.intrinsicValue.toFixed(2)} (${fmtPct(s.upsideDownside)})\n`;
    }

    output += `\n  Terminal Growth Sensitivity:\n`;
    for (const s of sensitivityAnalysis.terminalGrowthSensitivity) {
        output += `    Terminal Growth ${fmtPct(s.terminalGrowth)}: IV $${s.intrinsicValue.toFixed(2)} (${s.impactVsBase >= 0 ? '+' : ''}${fmtPct(s.impactVsBase)} vs base)\n`;
    }

    // ── Risk Factors ────────────────────────
    if (riskFactors.modelRisks.length > 0 || riskFactors.valuationRisks.length > 0 || riskFactors.companyRisks.length > 0) {
        output += `\n${'─'.repeat(70)}\n`;
        output += `  ⚠️ RISK FACTORS\n`;
        output += `${'─'.repeat(70)}\n`;
        if (riskFactors.modelRisks.length > 0) {
            output += `  Model Risks:\n`;
            riskFactors.modelRisks.forEach(r => { output += `    • ${r}\n`; });
        }
        if (riskFactors.valuationRisks.length > 0) {
            output += `  Valuation Risks:\n`;
            riskFactors.valuationRisks.forEach(r => { output += `    • ${r}\n`; });
        }
        if (riskFactors.companyRisks.length > 0) {
            output += `  Company Risks:\n`;
            riskFactors.companyRisks.forEach(r => { output += `    • ${r}\n`; });
        }
    }

    // ── Data Quality ────────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  📋 DATA QUALITY: ${dataQuality.completeness}\n`;
    output += `  Historical Years: ${dataQuality.historicalYears}\n`;
    if (dataQuality.dataGaps.length > 0) {
        output += `  Gaps: ${dataQuality.dataGaps.join('; ')}\n`;
    }

    output += `\n${'═'.repeat(70)}\n`;
    output += `  ⚠️ DISCLAIMER: This analysis is for informational purposes only.\n`;
    output += `  Not financial advice. Past performance ≠ future results.\n`;
    output += `${'═'.repeat(70)}\n`;

    return output;
}

// ─────────────────────────────────────────────────────────
// Tool Registration
// ─────────────────────────────────────────────────────────

export function registerDCFAnalysisTool(): void {
    registerTool({
        name: 'run_dcf_analysis',
        description: 'Perform a comprehensive Discounted Cash Flow (DCF) analysis on a stock. ' +
            'This tool calculates the intrinsic value of a company by projecting future cash flows, ' +
            'discounting them using WACC, and comparing to the current market price. ' +
            'Returns detailed valuation including WACC breakdown, 10-year projections, terminal value, ' +
            'sensitivity analysis, and investment recommendation (BUY/HOLD/SELL). ' +
            'Uses historical financial data from Alpha Vantage. Requires ~6 API calls.',
        category: 'fundamental',
        version: '0.1.0',
        inputSchema: {
            type: 'object' as const,
            properties: {
                symbol: {
                    type: 'string',
                    description: 'Stock ticker symbol (e.g., AAPL, MSFT, GOOGL). Must be a US-listed equity.',
                },
            },
            required: ['symbol'],
        },
        handler: async (args: any) => {
            try {
                // Validate input
                const input = DCFInputSchema.parse(args);

                console.log(`\n🔬 [DCF Tool] Starting DCF analysis for ${input.symbol}...`);

                // Run the full DCF analysis
                const result = await runDCFAnalysis(input.symbol);

                // Format output
                const formattedOutput = formatDCFOutput(result);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: formattedOutput,
                        },
                    ],
                    structuredContent: result as unknown as Record<string, unknown>,
                };
            } catch (error: any) {
                console.error(`❌ [DCF Tool] Error: ${error.message}`);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `DCF Analysis Error: ${error.message}`,
                        },
                    ],
                };
            }
        },
    });

    console.log('✅ [DCF Tool] Registered: run_dcf_analysis');
}
