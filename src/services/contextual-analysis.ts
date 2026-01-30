
import { FinancialStatement } from './fundamentals-alphavantage.js';
import { InsiderTransaction } from './insider-trading.js'; // Will be created in Phase 2B

export interface YoYComparison {
    metric: string;
    currentValue: number;
    previousValue: number;
    change: number;
    changePercent: number;
    isSignificant: boolean; // >10% change
    direction: 'up' | 'down' | 'flat';
    severity: 'major' | 'moderate' | 'minor';
    insight: string;
}

export interface Pattern {
    type: 'margin_compression' | 'profitability_decline' | 'debt_accumulation' | 'cash_flow_problem' | 'revenue_expense_mismatch';
    severity: 'critical' | 'warning' | 'info';
    description: string;
    metrics: string[]; // Which metrics triggered this
    recommendation?: string;
}

export interface ContextualSummary {
    symbol: string;
    headline: string; // "NVDA: Rev up 17% but margins compressed 2%, insider routine selling"
    keyInsights: string[];
    patterns: Pattern[];
    sentiment: 'bullish' | 'bearish' | 'neutral';
    confidence: number; // 0-1
}

/**
 * Compare financial metrics year-over-year
 */
export async function analyzeYoYChanges(
    current: FinancialStatement,
    previous: FinancialStatement
): Promise<YoYComparison[]> {
    const metrics = [
        { key: 'revenue', label: 'Revenue' },
        { key: 'netIncome', label: 'Net Income' },
        { key: 'grossMargin', label: 'Gross Margin' },
        { key: 'operatingMargin', label: 'Operating Margin' },
        { key: 'netMargin', label: 'Net Margin' },
        { key: 'totalDebt', label: 'Total Debt' },
        { key: 'freeCashFlow', label: 'Free Cash Flow' },
        { key: 'grossProfit', label: 'Gross Profit' },
        { key: 'operatingIncome', label: 'Operating Income' },
        { key: 'operatingCashFlow', label: 'Operating Cash Flow' }
    ];

    const comparisons: YoYComparison[] = [];

    for (const m of metrics) {
        const curVal = (current as any)[m.key];
        const prevVal = (previous as any)[m.key];

        if (curVal !== undefined && prevVal !== undefined && prevVal !== 0) {
            const change = curVal - prevVal;
            const changePercent = (change / Math.abs(prevVal)) * 100;
            const absChangePercent = Math.abs(changePercent);

            let direction: 'up' | 'down' | 'flat' = 'flat';
            if (changePercent > 5) direction = 'up';
            else if (changePercent < -5) direction = 'down';

            let severity: 'major' | 'moderate' | 'minor' = 'minor';
            if (absChangePercent > 20) severity = 'major';
            else if (absChangePercent > 10) severity = 'moderate';

            const isSignificant = absChangePercent > 10;

            // Special handling for margins (they are already percentages)
            const isMargin = m.label.includes('Margin');
            const displayChange = isMargin ? `${change.toFixed(1)}%` : `${changePercent.toFixed(1)}%`;

            let insight = `${m.label} ${direction} ${displayChange}`;
            if (isSignificant) {
                insight += ` (${severity})`;
            }

            comparisons.push({
                metric: m.key,
                currentValue: curVal,
                previousValue: prevVal,
                change,
                changePercent,
                isSignificant,
                direction,
                severity,
                insight
            });
        }
    }

    return comparisons;
}

/**
 * Detect unusual patterns in financial data
 */
export async function detectPatterns(
    statements: FinancialStatement[],
    comparisons: YoYComparison[]
): Promise<Pattern[]> {
    const patterns: Pattern[] = [];

    // Helper to find comparison
    const getComp = (key: string) => comparisons.find(c => c.metric === key);

    const revenue = getComp('revenue');
    const grossMargin = getComp('grossMargin');
    const netMargin = getComp('netMargin');
    const netIncome = getComp('netIncome');
    const totalDebt = getComp('totalDebt');
    const totalAssets = (statements[0] as any).totalAssets; // Current assets
    const prevTotalAssets = (statements[1] as any).totalAssets; // Previous assets
    const costOfRevenue = (statements[0] as any).costOfRevenue;
    const prevCostOfRevenue = (statements[1] as any).costOfRevenue;


    // 1. Margin Compression
    if (
        revenue && revenue.direction === 'up' && revenue.changePercent > 5 &&
        (
            (grossMargin && grossMargin.change < -1) || // Margin dropped by > 1% point
            (netMargin && netMargin.change < -1)
        )
    ) {
        patterns.push({
            type: 'margin_compression',
            severity: 'warning',
            description: `Revenue up ${revenue.changePercent.toFixed(1)}% but margins compressed`,
            metrics: ['revenue', (grossMargin?.change ?? 0) < -1 ? 'grossMargin' : 'netMargin'],
            recommendation: 'Monitor cost structure and pricing power'
        });
    }

    // 2. Profitability Decline
    if (
        revenue && (revenue.direction === 'up' || revenue.direction === 'flat') &&
        netIncome && netIncome.direction === 'down' && netIncome.changePercent < -10
    ) {
        patterns.push({
            type: 'profitability_decline',
            severity: 'warning',
            description: `Revenue grew/stable but Net Income dropped ${Math.abs(netIncome.changePercent).toFixed(1)}%`,
            metrics: ['revenue', 'netIncome'],
            recommendation: 'Check for rising costs or one-time expenses'
        });
    }

    // 3. Debt Accumulation
    // Check if debt grew significantly faster than assets
    if (totalDebt && totalDebt.changePercent > 20) {
        // Need asset growth to compare
        let assetGrowth = 0;
        if (totalAssets && prevTotalAssets) {
            assetGrowth = ((totalAssets - prevTotalAssets) / prevTotalAssets) * 100;
        }

        if (totalDebt.changePercent > assetGrowth + 15) {
            patterns.push({
                type: 'debt_accumulation',
                severity: 'warning',
                description: `Debt grew ${totalDebt.changePercent.toFixed(1)}% while assets only grew ${assetGrowth.toFixed(1)}%`,
                metrics: ['totalDebt', 'totalAssets'],
                recommendation: 'Assess leverage risk'
            });
        }
    }

    // 4. Cash Flow Problems
    // Positive Net Income but Negative Operating Cash Flow
    const currentNetIncome = (statements[0] as any).netIncome;
    const currentOpCashFlow = (statements[0] as any).operatingCashFlow;

    if (currentNetIncome && currentNetIncome > 0 && currentOpCashFlow && currentOpCashFlow < 0) {
        patterns.push({
            type: 'cash_flow_problem',
            severity: 'warning',
            description: 'Profitable (Net Income > 0) but negative Operating Cash Flow',
            metrics: ['netIncome', 'operatingCashFlow'],
            recommendation: 'Check earnings quality and working capital'
        });
    }

    // 5. Revenue-Expense Mismatch
    // Expenses growing faster than revenue
    if (revenue && revenue.direction === 'up') {
        // approximate expenses growth by looking at (Revenue - Net Income) growth? 
        // Or just Cost of Revenue if available
        if (costOfRevenue && prevCostOfRevenue) {
            const costGrowth = ((costOfRevenue - prevCostOfRevenue) / prevCostOfRevenue) * 100;
            if (costGrowth > revenue.changePercent + 10) {
                patterns.push({
                    type: 'revenue_expense_mismatch',
                    severity: 'info',
                    description: `Costs (+${costGrowth.toFixed(1)}%) growing faster than Revenue (+${revenue.changePercent.toFixed(1)}%)`,
                    metrics: ['revenue', 'costOfRevenue'],
                    recommendation: 'Watch for efficiency loss'
                });
            }
        }
    }

    return patterns;
}

/**
 * Generate contextual summary for a company
 */
export async function generateContextualSummary(
    symbol: string,
    statements: FinancialStatement[],
    insiderTransactions?: InsiderTransaction[]
): Promise<ContextualSummary> {
    // 1. Calculate YoY Changes
    const comparisons = await analyzeYoYChanges(statements[0], statements[1]);

    // 2. Detect Patterns
    const patterns = await detectPatterns(statements, comparisons);

    // 3. Formulate Headline
    const revenue = comparisons.find(c => c.metric === 'revenue');
    const margins = comparisons.find(c => c.metric === 'grossMargin') || comparisons.find(c => c.metric === 'netMargin');

    let headlineParts: string[] = [];

    // Revenue part
    if (revenue) {
        if (revenue.direction === 'up') headlineParts.push(`Rev up ${revenue.changePercent.toFixed(0)}%`);
        else if (revenue.direction === 'down') headlineParts.push(`Rev down ${Math.abs(revenue.changePercent).toFixed(0)}%`);
        else headlineParts.push(`Rev flat`);
    }

    // Margins part
    if (margins) {
        if (margins.metric.includes('Margin')) {
            // Change is in percentage points already for margins in our logic?
            // Wait, analyzeYoYChanges calculates change as raw difference. 
            // For margins, raw difference IS percentage points.

            if ((margins?.change ?? 0) < -1) headlineParts.push(`margins compressed ${Math.abs(margins!.change).toFixed(1)}%`);
            else if ((margins?.change ?? 0) > 1) headlineParts.push(`margins expanding`);
        }
    }

    // Pattern part (most severe)
    const severePattern = patterns.find(p => p.severity === 'critical') || patterns.find(p => p.severity === 'warning');
    if (severePattern) {
        if (severePattern.type === 'margin_compression' && !headlineParts.some(p => p.includes('margin'))) {
            headlineParts.push('margins compressed');
        } else if (severePattern.type === 'profitability_decline') {
            headlineParts.push('profits decl.');
        }
    }

    // Basic headline construction
    let headline = `${symbol}: ${headlineParts.join(', ')}`;

    // 4. Key Insights
    const keyInsights: string[] = [];

    // Add pattern descriptions
    patterns.forEach(p => keyInsights.push(`${p.description} (${p.severity})`));

    // Add significant metric changes
    comparisons.filter(c => c.severity === 'major').forEach(c => {
        keyInsights.push(c.insight);
    });

    // Add Insider context if available (placeholder logic for now as InsiderTransaction is not fully implemented)
    if (insiderTransactions && insiderTransactions.length > 0) {
        keyInsights.push(`Recent insider activity detected: ${insiderTransactions.length} transactions`);
    }

    // 5. Determine Sentiment
    let sentimentScore = 0;
    if (revenue?.direction === 'up') sentimentScore++;
    if (revenue?.direction === 'down') sentimentScore--;
    if ((margins?.change ?? 0) > 0) sentimentScore++;
    if ((margins?.change ?? 0) < 0) sentimentScore--;
    if (patterns.some(p => p.severity === 'warning')) sentimentScore -= 2;
    if (patterns.some(p => p.severity === 'critical')) sentimentScore -= 3;

    let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (sentimentScore >= 2) sentiment = 'bullish';
    else if (sentimentScore <= -2) sentiment = 'bearish';

    return {
        symbol,
        headline,
        keyInsights,
        patterns,
        sentiment,
        confidence: 0.8 // Placeholder confidence
    };
}
