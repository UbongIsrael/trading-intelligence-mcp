/**
 * DCF (Discounted Cash Flow) Analysis Tool — v4
 * 
 * MCP tool registration for the DCF analysis service.
 * Exposes `run_dcf_analysis` (full DCF) and `quick_dcf` (EPS-based quick mode).
 */

import { z } from 'zod';
import { registerTool } from './registry.js';
import { runDCFAnalysis, quickDCF, type DCFResult, type QuickDCFResult } from '../services/dcf-analysis.js';

// ─────────────────────────────────────────────────────────
// Input Schemas
// ─────────────────────────────────────────────────────────

const DCFInputSchema = z.object({
    symbol: z.string().min(1).max(10).describe(
        'Stock ticker symbol (e.g., AAPL, MSFT, GOOGL). Must be a US-listed equity.'
    ),
});

const QuickDCFInputSchema = z.object({
    symbol: z.string().min(1).max(10).describe(
        'US stock ticker (e.g. AAPL, MSFT)'
    ),
});

// ─────────────────────────────────────────────────────────
// Output Formatters
// ─────────────────────────────────────────────────────────

function fmtNum(n: number | null | undefined, decimals = 2): string {
    if (n === null || n === undefined) return 'N/A';
    if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(decimals)}T`;
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(decimals)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(decimals)}M`;
    if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(decimals)}K`;
    return `$${n.toFixed(decimals)}`;
}

function formatDCFOutput(result: DCFResult): string {
    const { metadata, currentMarketData, growthAnalysis, waccCalculation,
        projections, terminalValue, valuationSummary,
        reverseDCF, investmentRecommendation, warnings } = result;

    let output = '';

    // ── Header ──────────────────────────────────────
    output += `\n${'═'.repeat(70)}\n`;
    output += `  📊 DCF ANALYSIS v4: ${metadata.companyName} (${metadata.ticker})\n`;
    output += `${'═'.repeat(70)}\n`;
    output += `  Date: ${metadata.analysisDate.split('T')[0]} | Method: Revenue-Anchored FCF\n`;
    output += `  Sector: ${metadata.sector}\n`;

    // ── Current Market Data ─────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  📈 CURRENT MARKET DATA\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Current Price:       $${currentMarketData.currentPrice.toFixed(2)}\n`;
    output += `  Market Cap:          ${fmtNum(currentMarketData.marketCap)}\n`;
    output += `  Shares Outstanding:  ${(currentMarketData.sharesOutstanding / 1e9).toFixed(2)}B\n`;

    // ── Growth Analysis ─────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  📈 GROWTH ANALYSIS\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Selected Growth Rate: ${(growthAnalysis.selectedGrowthRate * 100).toFixed(2)}%\n`;
    output += `  Growth Source:        ${growthAnalysis.growthSource}\n`;
    output += `  Revenue CAGR (3yr):   ${growthAnalysis.revenueCAGR3yr !== null ? (growthAnalysis.revenueCAGR3yr * 100).toFixed(2) + '%' : 'N/A'}\n`;
    output += `  Normalized FCF Margin: ${(growthAnalysis.normalizedFCFMargin * 100).toFixed(2)}%\n`;

    // ── WACC ────────────────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  💰 WACC CALCULATION\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  WACC: ${waccCalculation.waccFormatted}\n`;
    output += `  Sector: ${waccCalculation.sector}\n\n`;
    output += `  Components:\n`;
    output += `    Cost of Equity:  ${(waccCalculation.components.costOfEquity * 100).toFixed(2)}%\n`;
    output += `    Cost of Debt:    ${(waccCalculation.components.costOfDebt * 100).toFixed(2)}%\n`;
    output += `    Equity Weight:   ${(waccCalculation.components.equityWeight * 100).toFixed(1)}%\n`;
    output += `    Debt Weight:     ${(waccCalculation.components.debtWeight * 100).toFixed(1)}%\n`;
    output += `    Beta:            ${waccCalculation.components.beta.toFixed(2)}\n`;
    output += `    Risk-Free Rate:  ${(waccCalculation.components.riskFreeRate * 100).toFixed(2)}%\n`;

    // ── Cash Flow Projections ───────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  📊 10-YEAR CASH FLOW PROJECTIONS\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  ${'Year'.padEnd(6)} ${'Revenue'.padStart(14)} ${'FCF'.padStart(14)} ${'Growth'.padStart(8)} ${'PV(FCF)'.padStart(14)}\n`;
    output += `  ${'─'.repeat(60)}\n`;
    for (const p of projections) {
        output += `  ${String(p.year).padEnd(6)} ${fmtNum(p.revenue).padStart(14)} ${fmtNum(p.fcf).padStart(14)} ${p.growthRate.padStart(8)} ${fmtNum(p.discountedFCF).padStart(14)}\n`;
    }

    // ── Terminal Value ──────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  🏁 TERMINAL VALUE (Gordon Growth Model)\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Terminal Growth Rate: ${terminalValue.terminalGrowth}\n`;
    output += `  Undiscounted Value:   ${fmtNum(terminalValue.undiscountedValue)}\n`;
    output += `  Discounted Value:     ${fmtNum(terminalValue.discountedValue)}\n`;
    output += `  % of Total Value:     ${terminalValue.percentOfTotal}\n`;

    // ── Valuation Summary ───────────────────
    output += `\n${'═'.repeat(70)}\n`;
    output += `  🎯 VALUATION SUMMARY\n`;
    output += `${'═'.repeat(70)}\n`;
    output += `  ┌─────────────────────────────────────────────────┐\n`;
    output += `  │  INTRINSIC VALUE:  $${valuationSummary.intrinsicValue.toFixed(2).padEnd(12)} per share    │\n`;
    output += `  │  CURRENT PRICE:    $${valuationSummary.currentPrice.toFixed(2).padEnd(12)} per share    │\n`;
    output += `  │  UPSIDE/DOWNSIDE:  ${valuationSummary.upsideDownside.padEnd(24)}     │\n`;
    output += `  │  VALUATION:        ${valuationSummary.valuation.padEnd(24)}     │\n`;
    output += `  └─────────────────────────────────────────────────┘\n`;

    // ── Reverse DCF ─────────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  🔄 REVERSE DCF\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Market-Implied Growth Rate: ${reverseDCF.impliedGrowthFormatted}\n`;
    output += `  📋 ${reverseDCF.interpretation}\n`;

    // ── Recommendation ──────────────────────
    output += `\n${'─'.repeat(70)}\n`;
    output += `  🏆 INVESTMENT RECOMMENDATION\n`;
    output += `${'─'.repeat(70)}\n`;
    output += `  Recommendation: ${investmentRecommendation.recommendation}\n`;
    output += `  Confidence:     ${investmentRecommendation.confidence}\n`;
    output += `  ${investmentRecommendation.reasoning}\n`;

    // ── Warnings ────────────────────────────
    if (warnings.length > 0) {
        output += `\n${'─'.repeat(70)}\n`;
        output += `  ⚠️ WARNINGS\n`;
        output += `${'─'.repeat(70)}\n`;
        for (const w of warnings) {
            output += `  • ${w}\n`;
        }
    }

    output += `\n${'═'.repeat(70)}\n`;
    output += `  ⚠️ DISCLAIMER: This analysis is for informational purposes only.\n`;
    output += `  Not financial advice. Past performance ≠ future results.\n`;
    output += `${'═'.repeat(70)}\n`;

    return output;
}

function formatQuickDCFOutput(result: QuickDCFResult): string {
    let output = '';

    output += `\n${'═'.repeat(50)}\n`;
    output += `  ⚡ QUICK DCF: ${result.symbol}\n`;
    output += `${'═'.repeat(50)}\n`;
    output += `  Mode: EPS-Based Quick Valuation\n\n`;

    output += `  Inputs:\n`;
    output += `    TTM EPS:       $${result.inputs.ttmEPS.toFixed(2)}\n`;
    output += `    Growth Rate:   ${(result.inputs.growthRate * 100).toFixed(2)}%\n`;
    output += `    Discount Rate: ${(result.inputs.discountRate * 100).toFixed(1)}%\n`;
    output += `    Terminal P/E:  ${result.inputs.terminalPE}x\n\n`;

    output += `  10-Year EPS Projections:\n`;
    for (const p of result.projections) {
        output += `    Year ${String(p.year).padEnd(3)} EPS: $${p.eps.toFixed(2).padStart(8)}  PV: $${p.discountedEPS.toFixed(2).padStart(8)}\n`;
    }

    output += `\n  Terminal Value:  ${fmtNum(result.terminalValue.value)}\n`;
    output += `  Discounted TV:  ${fmtNum(result.terminalValue.discounted)}\n`;

    output += `\n  ┌───────────────────────────────────┐\n`;
    output += `  │  INTRINSIC VALUE:  $${result.intrinsicValue.toFixed(2).padEnd(10)}  │\n`;
    output += `  │  CURRENT PRICE:    $${result.currentPrice.toFixed(2).padEnd(10)}  │\n`;
    output += `  │  UPSIDE:           ${result.upside.padEnd(10)}  │\n`;
    output += `  │  VALUATION:        ${result.valuation.padEnd(10)}  │\n`;
    output += `  └───────────────────────────────────┘\n`;

    return output;
}

// ─────────────────────────────────────────────────────────
// Tool Registration
// ─────────────────────────────────────────────────────────

export function registerDCFAnalysisTool(): void {
    // ── Full DCF Tool ──────────────────────
    registerTool({
        name: 'run_dcf_analysis',
        description: 'Perform a comprehensive Discounted Cash Flow (DCF) analysis on a stock. ' +
            'Revenue-anchored FCF model with WACC discounting, Gordon Growth terminal value, ' +
            'and reverse DCF. Returns 10-year projections, intrinsic value, and investment recommendation. ' +
            'Uses historical financial data from Alpha Vantage.',
        category: 'fundamental',
        version: '4.0.0',
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
                const input = DCFInputSchema.parse(args);
                console.log(`\n🔬 [DCF Tool] Starting DCF analysis for ${input.symbol}...`);

                const result = await runDCFAnalysis(input.symbol);
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
    console.log('✅ [DCF Tool] Registered: run_dcf_analysis (v4)');

    // ── Quick DCF Tool ─────────────────────
    registerTool({
        name: 'quick_dcf',
        description: 'Quick EPS-based stock valuation. Returns 10-year earnings projection ' +
            'with intrinsic value estimate. Faster than full DCF — use for rapid screening ' +
            'or as a sanity check. Only requires 3 API calls.',
        category: 'fundamental',
        version: '1.0.0',
        inputSchema: {
            type: 'object' as const,
            properties: {
                symbol: {
                    type: 'string',
                    description: 'US stock ticker (e.g. AAPL, MSFT)',
                },
            },
            required: ['symbol'],
        },
        handler: async (args: any) => {
            try {
                const input = QuickDCFInputSchema.parse(args);
                console.log(`\n⚡ [Quick DCF] Starting quick DCF for ${input.symbol}...`);

                const result = await quickDCF(input.symbol);
                const formattedOutput = formatQuickDCFOutput(result);

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
                console.error(`❌ [Quick DCF] Error: ${error.message}`);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Quick DCF Error: ${error.message}`,
                        },
                    ],
                };
            }
        },
    });
    console.log('✅ [DCF Tool] Registered: quick_dcf');
}
