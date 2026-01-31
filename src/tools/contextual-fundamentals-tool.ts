
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addToRegistry } from './registry.js';
import { getCacheService } from '../cache/index.js';
import {
    fetchCompanyOverview,
    fetchEarnings,
    fetchFinancialStatements,
    isAlphaVantageConfigured
} from '../services/fundamentals-alphavantage.js';
import {
    analyzeYoYChanges,
    detectPatterns,
    generateContextualSummary,
    YoYComparison,
    Pattern
} from '../services/contextual-analysis.js';
import {
    fetchInsiderTransactions,
    analyzeInsiderActivity,
    InsiderTransaction,
    InsiderActivity
} from '../services/insider-trading.js';
import {
    fetchMaterialEvents,
    MaterialEvent
} from '../services/material-events.js';
import { ContextualFundamentalsOutputSchema } from '../schemas/output-schemas.js';

/**
 * Input schema for contextual fundamentals tool
 */
const ContextualFundamentalsInputSchema = z.object({
    symbol: z.string()
        .min(1)
        .max(5)
        .describe('Stock ticker symbol (e.g., AAPL, NVDA)'),
    includeInsider: z.boolean()
        .optional()
        .default(true)
        .describe('Include insider trading analysis (default: true)'),
    includeEvents: z.boolean()
        .optional()
        .default(true)
        .describe('Include material events from 8-K (default: true)'),
});

/**
 * Register the contextual fundamentals tool
 */
export function registerContextualFundamentalsTool(server: McpServer): void {
    server.registerTool(
        'get_contextual_fundamentals',
        {
            title: 'Get Contextual Fundamental Analysis',
            description: 'Get company fundamentals with YoY changes, pattern detection, and contextual insights. Saves 30+ minutes of manual analysis by flagging unusual patterns and generating actionable insights.',
            inputSchema: ContextualFundamentalsInputSchema,
            outputSchema: ContextualFundamentalsOutputSchema as any,
        },
        async ({ symbol, includeInsider = true, includeEvents = true }) => {
            const startTime = Date.now();

            if (!isAlphaVantageConfigured()) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: 'Error: Alpha Vantage API key not configured. Set ALPHA_VANTAGE_API_KEY environment variable to enable fundamentals data.',
                        },
                    ],
                };
            }

            try {
                const cacheService = getCacheService();
                // Use a composite cache key
                const cacheKey = `contextual:${symbol.toUpperCase()}:${includeInsider}:${includeEvents}`;

                const result = await cacheService.fundamentals.getOrFetch(
                    symbol.toUpperCase(),
                    cacheKey,
                    async () => {
                        // 1. Fetch Key Data (Parallel where possible)
                        const [, , statements] = await Promise.all([
                            fetchCompanyOverview(symbol),
                            fetchEarnings(symbol, 4),
                            fetchFinancialStatements(symbol, 'annual', 2)
                        ]);

                        if (statements.length < 2) {
                            throw new Error(`Insufficient financial history for ${symbol} to perform YoY analysis.`);
                        }

                        // 2. Calculate YoY changes
                        const yoyChanges = await analyzeYoYChanges(statements[0], statements[1]);

                        // 3. Detect patterns
                        const patterns = await detectPatterns(statements, yoyChanges);

                        // 4. Get insider activity (if requested)
                        let insiderActivity: InsiderActivity | undefined;
                        let recentTransactions: InsiderTransaction[] | undefined;
                        if (includeInsider) {
                            recentTransactions = await fetchInsiderTransactions(symbol);
                            insiderActivity = await analyzeInsiderActivity(symbol, recentTransactions);
                        }

                        // 5. Get material events (if requested)
                        let recentEvents: MaterialEvent[] | undefined;
                        if (includeEvents) {
                            recentEvents = await fetchMaterialEvents(symbol);
                        }

                        // 6. Generate contextual summary
                        const summary = await generateContextualSummary(
                            symbol,
                            statements,
                            recentTransactions
                        );

                        const structuredData = {
                            symbol: symbol.toUpperCase(),
                            headline: summary.headline,
                            yoyChanges,
                            patterns,
                            insiderActivity,
                            recentEvents,
                            keyInsights: summary.keyInsights,
                            sentiment: summary.sentiment,
                        };

                        return {
                            data: structuredData,
                            timestamp: new Date()
                        } as any;
                    }
                );

                const responseTime = Date.now() - startTime;
                console.log(`[Contextual Analysis] Fetched ${symbol} in ${responseTime}ms (cached: ${result.cached})`);

                const data = (result.data as any).data || result.data;

                return {
                    content: [
                        {
                            type: 'text',
                            text: formatContextualAnalysis(data),
                        },
                    ],
                    structuredContent: data,
                };

            } catch (error: any) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error performing contextual analysis for ${symbol}: ${error.message}`
                        }
                    ],
                    isError: true
                };
            }
        }
    );

    addToRegistry({
        name: 'get_contextual_fundamentals',
        description: 'Get company fundamentals with YoY changes, pattern detection, and contextual insights',
        category: 'fundamental',
        version: '0.1.0'
    });
}

/**
 * Format the contextual analysis text output
 */
function formatContextualAnalysis(data: any): string {
    const lines: string[] = [];

    // Headline
    lines.push(`🎯 ${data.symbol} Contextual Analysis`);
    lines.push('');
    lines.push(`📊 Headline: ${data.headline}`);
    lines.push('');

    // YoY Changes
    lines.push('💰 YoY Changes:');
    if (data.yoyChanges && Array.isArray(data.yoyChanges)) {
        data.yoyChanges.forEach((c: YoYComparison) => {
            if (c.severity !== 'minor' && c.metric !== 'revenue') {
                let emoji = '';
                if (c.direction === 'up') emoji = '↑';
                if (c.direction === 'down') emoji = '↓';

                let indicator = '';
                if (c.severity === 'major') indicator = '❗';
                else if (c.metric.includes('Margin') && c.change < 0) indicator = '⚠️';
                else if (c.metric === 'revenue' && c.direction === 'up') indicator = '✅';

                lines.push(`  ${formatMetricName(c.metric)}: ${emoji} ${c.changePercent.toFixed(1)}% ${indicator}`);
            } else if (c.metric === 'revenue') {
                const changeStr = `$${formatLargeNumber(Math.abs(c.change))}`;
                const dirStr = c.change > 0 ? 'increase' : 'decrease';
                lines.push(`  Revenue: ${c.direction === 'up' ? '↑' : '↓'} ${c.changePercent.toFixed(1)}% (${changeStr} ${dirStr}) ${c.direction === 'up' ? '✅' : ''}`);
            }
        });
    }
    lines.push('');

    // Patterns
    if (data.patterns && data.patterns.length > 0) {
        lines.push('⚠️ Patterns Detected:');
        data.patterns.forEach((p: Pattern) => {
            lines.push(`  • ${p.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} (${p.severity})`);
            lines.push(`    - ${p.description}`);
            if (p.recommendation) lines.push(`    - Monitor: ${p.recommendation}`);
        });
    } else {
        lines.push('✅ Patterns Detected: None - Strong financial health');
    }
    lines.push('');

    // Insider Activity
    if (data.insiderActivity) {
        lines.push(`👥 Insider Activity (Last 90 days):`);
        const ia = data.insiderActivity;

        let netValueString = '';
        const buyVal = ia.buyingActivity?.totalValue || 0;
        const sellVal = ia.sellingActivity?.totalValue || 0;
        const netVal = buyVal - sellVal;

        if (Math.abs(netVal) > 0) {
            netValueString = `$${formatLargeNumber(Math.abs(netVal))}`;
        } else {
            netValueString = '$0';
        }

        let sentimentEmoji = '😐';
        if (ia.sentiment === 'bullish') sentimentEmoji = '🟢';
        if (ia.sentiment === 'bearish') sentimentEmoji = '🔴';

        const activityLabel = ia.netActivity === 'net_selling' ? 'Net Selling' :
            ia.netActivity === 'net_buying' ? 'Net Buying' : 'Net Activity';

        lines.push(`  ${activityLabel}: ${netValueString} (${ia.pattern}) ${sentimentEmoji}`);
        if (ia.pattern === 'routine') {
            lines.push(`  Pattern: Quarterly routine transactions (not concerning)`);
        } else {
            lines.push(`  Pattern: ${ia.pattern} ⚠️`);
        }

        lines.push('');
    }

    // Recent Events
    if (data.recentEvents && data.recentEvents.length > 0) {
        lines.push('📰 Recent Events:');
        data.recentEvents.slice(0, 3).forEach((e: MaterialEvent) => {
            const dateStr = new Date(e.filingDate).toLocaleDateString();
            const importanceStr = e.importance === 'high' ? '- High importance' : '';
            lines.push(`  • ${e.description} (${dateStr}) ${importanceStr}`);
        });
        lines.push('');
    }

    // Key Insights
    if (data.keyInsights && data.keyInsights.length > 0) {
        lines.push('💡 Key Insights:');
        data.keyInsights.forEach((insight: string) => {
            lines.push(`  - ${insight}`);
        });
        lines.push('');
    }

    let sentimentLabel = data.sentiment.toUpperCase();
    if (data.sentiment === 'bullish' && data.yoyChanges?.some((c: any) => c.metric === 'revenue' && c.changePercent > 50)) {
        sentimentLabel = 'STRONGLY BULLISH';
    }

    lines.push(`Sentiment: ${sentimentLabel}`);

    return lines.join('\n');
}

function formatMetricName(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
}

/**
 * Format large numbers (duplicate from fundamentals tool, strictly for local usage)
 */
function formatLargeNumber(num: number): string {
    if (Math.abs(num) >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
    if (Math.abs(num) >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
    return num.toFixed(2);
}
