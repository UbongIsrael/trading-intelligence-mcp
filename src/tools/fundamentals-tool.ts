/**
 * Fundamentals Tools
 * MCP tools for fetching company fundamental data
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addToRegistry } from './registry.js';
import { getCacheService } from '../cache/index.js';
import {
  fetchCompanyOverview,
  fetchEarnings,
  fetchFinancialStatements,
  fetchFullFundamentals,
  isAlphaVantageConfigured,
  CompanyOverview,
  FinancialStatement,
  ExtendedEarningsData,
} from '../services/fundamentals-alphavantage.js';
import {
  CompanyOverviewOutputSchema,
  EarningsOutputSchema,
  FinancialStatementsOutputSchema,
  FullFundamentalsOutputSchema
} from '../schemas/output-schemas.js';

/**
 * Input schema for company overview tool (JSON Schema format)
 */
const CompanyOverviewInputSchema = {
  type: "object" as const,
  properties: {
    symbol: {
      type: "string" as const,
      description: "Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)",
    },
  },
  required: ["symbol"],
};

/**
 * Input schema for financial statements tool (JSON Schema format)
 */
const FinancialStatementsInputSchema = {
  type: "object" as const,
  properties: {
    symbol: {
      type: "string" as const,
      description: "Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)",
    },
    period: {
      type: "string" as const,
      enum: ["annual", "quarterly"],
      description: "Report period: annual or quarterly (default: annual)",
    },
    limit: {
      type: "number" as const,
      description: "Number of periods to return (default: 4)",
    },
  },
  required: ["symbol"],
};

/**
 * Input schema for earnings tool (JSON Schema format)
 */
const EarningsInputSchema = {
  type: "object" as const,
  properties: {
    symbol: {
      type: "string" as const,
      description: "Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)",
    },
    limit: {
      type: "number" as const,
      description: "Number of earnings periods to return (default: 8)",
    },
  },
  required: ["symbol"],
};

/**
 * Input schema for full fundamentals tool (JSON Schema format)
 */
const FullFundamentalsInputSchema = {
  type: "object" as const,
  properties: {
    symbol: {
      type: "string" as const,
      description: "Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)",
    },
  },
  required: ["symbol"],
};

/**
 * Register the company overview tool
 */
export function registerCompanyOverviewTool(server: McpServer): void {
  server.registerTool(
    'get_company_overview',
    {
      title: 'Get Company Overview',
      description: 'Get company profile and key financial metrics for a stock. Includes sector, market cap, P/E ratio, EPS, 52-week range, and more. Data cached for 1 hour.',
      inputSchema: CompanyOverviewInputSchema as any,
      outputSchema: CompanyOverviewOutputSchema as any,
    },
    async (args: any, _extra: any) => {
      const { symbol } = args as { symbol: string };
      const startTime = Date.now();

      // Check if Alpha Vantage is configured
      if (!isAlphaVantageConfigured()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Alpha Vantage API key not configured. Set ALPHA_VANTAGE_API_KEY environment variable to enable fundamentals data.',
            },
          ],
        };
      }

      try {
        const cacheService = getCacheService();
        // Use cache-aside pattern
        const result = await cacheService.fundamentals.getOrFetch(
          symbol.toUpperCase(),
          'overview',
          async () => {
            const overview = await fetchCompanyOverview(symbol);
            // Convert to FundamentalData format for cache
            return {
              symbol: overview.symbol,
              companyName: overview.name,
              sector: overview.sector,
              industry: overview.industry,
              marketCap: overview.marketCap,
              peRatio: overview.peRatio,
              eps: overview.eps,
              timestamp: overview.timestamp,
              // Store full overview in a way we can retrieve it
              _fullData: overview,
            } as any;
          }
        );

        const responseTime = Date.now() - startTime;
        console.log(`[Company Overview Tool] Fetched ${symbol} in ${responseTime}ms (cached: ${result.cached})`);

        // Extract full data if available, otherwise use the basic data
        const overview = (result.data as any)._fullData || result.data;

        const structuredData = {
          symbol: overview.symbol,
          name: overview.name || overview.companyName || '',
          description: overview.description || '',
          sector: overview.sector || '',
          industry: overview.industry || '',
          marketCap: overview.marketCap || 0,
          peRatio: overview.peRatio || 0,
          eps: overview.eps || 0,
          dividendYield: overview.dividendYield || 0,
          "52WeekHigh": overview.week52High || 0,
          "52WeekLow": overview.week52Low || 0,
          source: 'alpha_vantage',
          cached: result.cached,
          cacheExpiry: '', // Optional in schema
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: formatCompanyOverviewResponse(overview, result.cached),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching company overview for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  addToRegistry({
    name: 'get_company_overview',
    description: 'Get company profile and key financial metrics',
    category: 'fundamental',
    version: '0.1.0',
  });
}

/**
 * Register the earnings tool
 */
export function registerEarningsTool(server: McpServer): void {
  server.registerTool(
    'get_earnings',
    {
      title: 'Get Earnings Data',
      description: 'Get quarterly earnings data including EPS estimates, actuals, and surprise percentages. Shows analyst expectations vs actual performance. Data cached for 1 hour.',
      inputSchema: EarningsInputSchema as any,
      outputSchema: EarningsOutputSchema as any,
    },
    async (args: any, _extra: any) => {
      const { symbol, limit } = args as { symbol: string; limit?: number };
      const startTime = Date.now();

      if (!isAlphaVantageConfigured()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Alpha Vantage API key not configured. Set ALPHA_VANTAGE_API_KEY environment variable to enable fundamentals data.',
            },
          ],
        };
      }

      try {
        const cacheService = getCacheService();
        const effectiveLimit = limit || 8;

        const result = await cacheService.fundamentals.getOrFetch(
          symbol.toUpperCase(),
          `earnings:${effectiveLimit}`,
          async () => {
            const earnings = await fetchEarnings(symbol, effectiveLimit);
            return {
              symbol: symbol.toUpperCase(),
              companyName: symbol.toUpperCase(),
              timestamp: new Date(),
              _earningsData: earnings,
            } as any;
          }
        );

        const responseTime = Date.now() - startTime;
        console.log(`[Earnings Tool] Fetched ${symbol} in ${responseTime}ms (cached: ${result.cached})`);

        const earnings = (result.data as any)._earningsData || [];

        const structuredData = {
          symbol: symbol.toUpperCase(),
          earnings: earnings.map((e: any) => ({
            fiscalDateEnding: e.period || '',
            reportedEPS: e.epsActual || 0,
            estimatedEPS: e.epsEstimate || 0,
            surprise: e.surprise || 0,
            surprisePercentage: e.surprisePercent || 0,
          })),
          source: 'alpha_vantage',
          cached: result.cached,
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: formatEarningsResponse(symbol.toUpperCase(), earnings, result.cached),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching earnings for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  addToRegistry({
    name: 'get_earnings',
    description: 'Get quarterly earnings data with estimates and surprises',
    category: 'fundamental',
    version: '0.1.0',
  });
}

/**
 * Register the financial statements tool
 */
export function registerFinancialStatementsTool(server: McpServer): void {
  server.registerTool(
    'get_financial_statements',
    {
      title: 'Get Financial Statements',
      description: 'Get company financial statements including balance sheet, income statement, and cash flow data. Available for annual or quarterly periods. Data cached for 1 hour.',
      inputSchema: FinancialStatementsInputSchema as any,
      outputSchema: FinancialStatementsOutputSchema as any,
    },
    async (args: any, _extra: any) => {
      const { symbol, period, limit } = args as { symbol: string; period?: string; limit?: number };
      const startTime = Date.now();

      if (!isAlphaVantageConfigured()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Alpha Vantage API key not configured. Set ALPHA_VANTAGE_API_KEY environment variable to enable fundamentals data.',
            },
          ],
        };
      }

      try {
        const cacheService = getCacheService();
        const effectivePeriod = (period || 'annual') as 'annual' | 'quarterly';
        const effectiveLimit = limit || 4;

        const result = await cacheService.fundamentals.getOrFetch(
          symbol.toUpperCase(),
          `statements:${effectivePeriod}:${effectiveLimit}`,
          async () => {
            const statements = await fetchFinancialStatements(symbol, effectivePeriod, effectiveLimit);
            return {
              symbol: symbol.toUpperCase(),
              companyName: symbol.toUpperCase(),
              timestamp: new Date(),
              _statementsData: statements,
            } as any;
          }
        );

        const responseTime = Date.now() - startTime;
        console.log(`[Financial Statements Tool] Fetched ${symbol} in ${responseTime}ms (cached: ${result.cached})`);

        const statements = (result.data as any)._statementsData || [];
        const latestInfo = statements.length > 0 ? statements[0] : {};

        const structuredData = {
          symbol: symbol.toUpperCase(),
          period: effectivePeriod,
          incomeStatement: {
            revenue: latestInfo.revenue,
            grossProfit: latestInfo.grossProfit,
            operatingIncome: latestInfo.operatingIncome,
            netIncome: latestInfo.netIncome,
            ebitda: latestInfo.ebitda
          },
          balanceSheet: {
            totalAssets: latestInfo.totalAssets,
            totalLiabilities: latestInfo.totalLiabilities,
            totalEquity: latestInfo.totalEquity,
            cash: latestInfo.cash,
            totalDebt: latestInfo.totalDebt
          },
          cashFlow: {
            operatingCashFlow: latestInfo.operatingCashFlow,
            investingCashFlow: latestInfo.investingCashFlow,
            financingCashFlow: latestInfo.financingCashFlow,
            freeCashFlow: latestInfo.freeCashFlow
          },
          source: 'alpha_vantage',
          cached: result.cached,
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: formatFinancialStatementsResponse(symbol.toUpperCase(), statements, effectivePeriod, result.cached),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching financial statements for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  addToRegistry({
    name: 'get_financial_statements',
    description: 'Get company financial statements (balance sheet, income, cash flow)',
    category: 'fundamental',
    version: '0.1.0',
  });
}

/**
 * Register the full fundamentals tool
 */
export function registerFullFundamentalsTool(server: McpServer): void {
  server.registerTool(
    'get_full_fundamentals',
    {
      title: 'Get Full Fundamentals',
      description: 'Get comprehensive fundamental data for a stock including company overview, earnings history, and key financial ratios. Best for complete fundamental analysis. Data cached for 1 hour.',
      inputSchema: FullFundamentalsInputSchema as any,
      outputSchema: FullFundamentalsOutputSchema as any,
    },
    async (args: any, _extra: any) => {
      const { symbol } = args as { symbol: string };
      const startTime = Date.now();

      if (!isAlphaVantageConfigured()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Alpha Vantage API key not configured. Set ALPHA_VANTAGE_API_KEY environment variable to enable fundamentals data.',
            },
          ],
        };
      }

      try {
        const cacheService = getCacheService();

        const result = await cacheService.fundamentals.getOrFetch(
          symbol.toUpperCase(),
          'full',
          async () => {
            const fullData = await fetchFullFundamentals(symbol);
            return {
              symbol: symbol.toUpperCase(),
              companyName: fullData.overview.name,
              timestamp: new Date(),
              _fullFundamentals: fullData,
            } as any;
          }
        );

        const responseTime = Date.now() - startTime;
        console.log(`[Full Fundamentals Tool] Fetched ${symbol} in ${responseTime}ms (cached: ${result.cached})`);

        const fullData = (result.data as any)._fullFundamentals;
        const ov = fullData.overview;

        const structuredOverview = {
          symbol: ov.symbol,
          name: ov.name,
          description: ov.description || '',
          sector: ov.sector || '',
          industry: ov.industry || '',
          marketCap: ov.marketCap || 0,
          peRatio: ov.peRatio || 0,
          eps: ov.eps || 0,
          dividendYield: ov.dividendYield || 0,
          "52WeekHigh": ov.week52High || 0,
          "52WeekLow": ov.week52Low || 0,
          source: 'alpha_vantage',
          cached: result.cached,
          cacheExpiry: '',
        };

        const structuredEarnings = {
          symbol: symbol.toUpperCase(),
          earnings: fullData.earnings.map((e: any) => ({
            fiscalDateEnding: e.period || '',
            reportedEPS: e.epsActual || 0,
            estimatedEPS: e.epsEstimate || 0,
            surprise: e.surprise || 0,
            surprisePercentage: e.surprisePercent || 0,
          })),
          source: 'alpha_vantage',
          cached: result.cached,
        };

        // Generate AI summary string
        const m = fullData.metrics;
        const summary = `Financial Summary for ${ov.name}: Market Cap $${formatLargeNumber(ov.marketCap)}. ` +
          `PE Ratio: ${ov.peRatio?.toFixed(2) || 'N/A'}, EPS: ${ov.eps?.toFixed(2) || 'N/A'}. ` +
          `Profitability: Gross Margin ${m.profitability?.grossMargin?.toFixed(1) || 'N/A'}%, ` +
          `Net Margin ${m.profitability?.netMargin?.toFixed(1) || 'N/A'}%.`;

        const structuredData = {
          symbol: symbol.toUpperCase(),
          overview: structuredOverview,
          earnings: structuredEarnings,
          summary: summary,
          source: 'alpha_vantage',
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: formatFullFundamentalsResponse(fullData, result.cached),
            },
          ],
          structuredContent: structuredData,
        };

      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching full fundamentals for ${symbol}: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  addToRegistry({
    name: 'get_full_fundamentals',
    description: 'Get comprehensive fundamental analysis for a stock',
    category: 'fundamental',
    version: '0.1.0',
  });
}

/**
 * Format company overview response
 */
function formatCompanyOverviewResponse(overview: CompanyOverview | any, cached: boolean): string {
  const lines: string[] = [
    `🏢 ${overview.name || overview.companyName} (${overview.symbol})`,
    '',
    '📋 Company Profile:',
    `  Sector: ${overview.sector || 'N/A'}`,
    `  Industry: ${overview.industry || 'N/A'}`,
    `  Exchange: ${overview.exchange || 'N/A'}`,
    `  Country: ${overview.country || 'N/A'}`,
  ];

  if (overview.weburl) {
    lines.push(`  Website: ${overview.weburl}`);
  }

  lines.push('');
  lines.push('💰 Key Metrics:');

  if (overview.marketCap) {
    lines.push(`  Market Cap: $${formatLargeNumber(overview.marketCap)}`);
  }
  if (overview.peRatio !== undefined && overview.peRatio !== null) {
    lines.push(`  P/E Ratio: ${overview.peRatio.toFixed(2)}`);
  }
  if (overview.eps !== undefined && overview.eps !== null) {
    lines.push(`  EPS: $${overview.eps.toFixed(2)}`);
  }
  if (overview.dividendYield !== undefined && overview.dividendYield !== null) {
    lines.push(`  Dividend Yield: ${overview.dividendYield.toFixed(2)}%`);
  }
  if (overview.beta !== undefined && overview.beta !== null) {
    lines.push(`  Beta: ${overview.beta.toFixed(2)}`);
  }

  if (overview.week52High || overview.week52Low) {
    lines.push('');
    lines.push('📊 52-Week Range:');
    if (overview.week52High) {
      lines.push(`  High: $${overview.week52High.toFixed(2)}`);
    }
    if (overview.week52Low) {
      lines.push(`  Low: $${overview.week52Low.toFixed(2)}`);
    }
  }

  if (overview.averageVolume) {
    lines.push(`  Avg Volume (10D): ${formatLargeNumber(overview.averageVolume)}`);
  }

  lines.push('');
  lines.push(`Cached: ${cached ? 'Yes ⚡' : 'No (Fresh)'}`);

  return lines.join('\n');
}

/**
 * Format earnings response
 */
function formatEarningsResponse(symbol: string, earnings: ExtendedEarningsData[], cached: boolean): string {
  const lines: string[] = [
    `📊 ${symbol} Earnings History`,
    '',
  ];

  if (earnings.length === 0) {
    lines.push('No earnings data available for this symbol.');
    return lines.join('\n');
  }

  // Calculate summary stats
  const surprises = earnings.filter(e => e.surprisePercent !== undefined);
  const beats = surprises.filter(e => (e.surprisePercent || 0) > 0).length;
  const misses = surprises.filter(e => (e.surprisePercent || 0) < 0).length;

  lines.push(`📈 Summary (Last ${earnings.length} quarters):`);
  lines.push(`  Beat Estimates: ${beats} times`);
  lines.push(`  Missed Estimates: ${misses} times`);
  lines.push('');
  lines.push('📅 Recent Earnings:');

  for (const e of earnings) {
    const emoji = (e.surprisePercent || 0) > 0 ? '✅' : (e.surprisePercent || 0) < 0 ? '❌' : '➖';
    const surpriseStr = e.surprisePercent !== undefined
      ? `${e.surprisePercent >= 0 ? '+' : ''}${e.surprisePercent.toFixed(2)}%`
      : 'N/A';

    lines.push(`  ${emoji} ${e.quarter} ${e.year}:`);
    lines.push(`     EPS: $${e.epsActual?.toFixed(2) || 'N/A'} (Est: $${e.epsEstimate?.toFixed(2) || 'N/A'})`);
    lines.push(`     Surprise: ${surpriseStr}`);
  }

  lines.push('');
  lines.push(`Cached: ${cached ? 'Yes ⚡' : 'No (Fresh)'}`);

  return lines.join('\n');
}

/**
 * Format financial statements response
 */
function formatFinancialStatementsResponse(
  symbol: string,
  statements: FinancialStatement[],
  period: string,
  cached: boolean
): string {
  const lines: string[] = [
    `📑 ${symbol} Financial Statements (${period})`,
    '',
  ];

  if (statements.length === 0) {
    lines.push('No financial statements available for this symbol.');
    lines.push('Note: Detailed financial statements may require a premium API subscription.');
    return lines.join('\n');
  }

  for (const stmt of statements) {
    const periodLabel = stmt.fiscalQuarter
      ? `Q${stmt.fiscalQuarter} ${stmt.fiscalYear}`
      : `FY ${stmt.fiscalYear}`;

    lines.push(`📅 ${periodLabel}`);

    // Income Statement
    if (stmt.revenue || stmt.netIncome) {
      lines.push('  Income Statement:');
      if (stmt.revenue) lines.push(`    Revenue: $${formatLargeNumber(stmt.revenue)}`);
      if (stmt.grossProfit) lines.push(`    Gross Profit: $${formatLargeNumber(stmt.grossProfit)}`);
      if (stmt.operatingIncome) lines.push(`    Operating Income: $${formatLargeNumber(stmt.operatingIncome)}`);
      if (stmt.netIncome) lines.push(`    Net Income: $${formatLargeNumber(stmt.netIncome)}`);
    }

    // Margins
    if (stmt.grossMargin || stmt.netMargin) {
      lines.push('  Margins:');
      if (stmt.grossMargin) lines.push(`    Gross Margin: ${stmt.grossMargin.toFixed(1)}%`);
      if (stmt.operatingMargin) lines.push(`    Operating Margin: ${stmt.operatingMargin.toFixed(1)}%`);
      if (stmt.netMargin) lines.push(`    Net Margin: ${stmt.netMargin.toFixed(1)}%`);
    }

    // Balance Sheet
    if (stmt.totalAssets || stmt.totalLiabilities) {
      lines.push('  Balance Sheet:');
      if (stmt.totalAssets) lines.push(`    Total Assets: $${formatLargeNumber(stmt.totalAssets)}`);
      if (stmt.totalLiabilities) lines.push(`    Total Liabilities: $${formatLargeNumber(stmt.totalLiabilities)}`);
      if (stmt.totalEquity) lines.push(`    Shareholders Equity: $${formatLargeNumber(stmt.totalEquity)}`);
      if (stmt.cash) lines.push(`    Cash: $${formatLargeNumber(stmt.cash)}`);
    }

    // Cash Flow
    if (stmt.operatingCashFlow || stmt.freeCashFlow) {
      lines.push('  Cash Flow:');
      if (stmt.operatingCashFlow) lines.push(`    Operating: $${formatLargeNumber(stmt.operatingCashFlow)}`);
      if (stmt.investingCashFlow) lines.push(`    Investing: $${formatLargeNumber(stmt.investingCashFlow)}`);
      if (stmt.financingCashFlow) lines.push(`    Financing: $${formatLargeNumber(stmt.financingCashFlow)}`);
      if (stmt.freeCashFlow) lines.push(`    Free Cash Flow: $${formatLargeNumber(stmt.freeCashFlow)}`);
    }

    lines.push('');
  }

  lines.push(`Cached: ${cached ? 'Yes ⚡' : 'No (Fresh)'}`);

  return lines.join('\n');
}

/**
 * Format full fundamentals response
 */
function formatFullFundamentalsResponse(data: any, cached: boolean): string {
  const { overview, earnings, metrics } = data;

  const lines: string[] = [
    `🏢 ${overview.name} (${overview.symbol}) - Full Fundamental Analysis`,
    '',
    '═══════════════════════════════════════════════════════',
    '',
  ];

  // Company Overview
  lines.push('📋 COMPANY PROFILE');
  lines.push(`  Sector: ${overview.sector}`);
  lines.push(`  Industry: ${overview.industry}`);
  lines.push(`  Market Cap: $${formatLargeNumber(overview.marketCap)}`);
  if (overview.weburl) lines.push(`  Website: ${overview.weburl}`);
  lines.push('');

  // Valuation
  lines.push('💰 VALUATION');
  if (metrics.valuation.peRatio) lines.push(`  P/E Ratio: ${metrics.valuation.peRatio.toFixed(2)}`);
  if (metrics.valuation.eps) lines.push(`  EPS: $${metrics.valuation.eps.toFixed(2)}`);
  if (metrics.valuation.dividendYield) lines.push(`  Dividend Yield: ${metrics.valuation.dividendYield.toFixed(2)}%`);
  lines.push('');

  // Profitability
  lines.push('📈 PROFITABILITY');
  if (metrics.profitability.grossMargin) lines.push(`  Gross Margin: ${metrics.profitability.grossMargin.toFixed(1)}%`);
  if (metrics.profitability.operatingMargin) lines.push(`  Operating Margin: ${metrics.profitability.operatingMargin.toFixed(1)}%`);
  if (metrics.profitability.netMargin) lines.push(`  Net Margin: ${metrics.profitability.netMargin.toFixed(1)}%`);
  if (metrics.profitability.roe) lines.push(`  ROE: ${metrics.profitability.roe.toFixed(1)}%`);
  if (metrics.profitability.roa) lines.push(`  ROA: ${metrics.profitability.roa.toFixed(1)}%`);
  lines.push('');

  // Financial Health
  lines.push('🏦 FINANCIAL HEALTH');
  if (metrics.liquidity.currentRatio) lines.push(`  Current Ratio: ${metrics.liquidity.currentRatio.toFixed(2)}`);
  if (metrics.liquidity.quickRatio) lines.push(`  Quick Ratio: ${metrics.liquidity.quickRatio.toFixed(2)}`);
  if (metrics.leverage.debtToEquity) lines.push(`  Debt/Equity: ${metrics.leverage.debtToEquity.toFixed(2)}`);
  lines.push('');

  // Growth
  if (metrics.growth.epsGrowth3Y || metrics.growth.epsGrowth5Y) {
    lines.push('📊 GROWTH');
    if (metrics.growth.epsGrowth3Y) lines.push(`  EPS Growth (3Y): ${metrics.growth.epsGrowth3Y.toFixed(1)}%`);
    if (metrics.growth.epsGrowth5Y) lines.push(`  EPS Growth (5Y): ${metrics.growth.epsGrowth5Y.toFixed(1)}%`);
    lines.push('');
  }

  // Recent Earnings
  if (earnings && earnings.length > 0) {
    lines.push('📅 RECENT EARNINGS');
    const recentEarnings = earnings.slice(0, 4);
    const beats = recentEarnings.filter((e: any) => (e.surprisePercent || 0) > 0).length;
    lines.push(`  Last 4 quarters: ${beats}/4 beats`);

    for (const e of recentEarnings) {
      const emoji = (e.surprisePercent || 0) > 0 ? '✅' : (e.surprisePercent || 0) < 0 ? '❌' : '➖';
      lines.push(`  ${emoji} ${e.quarter} ${e.year}: $${e.epsActual?.toFixed(2) || 'N/A'} (${e.surprisePercent >= 0 ? '+' : ''}${e.surprisePercent?.toFixed(1) || 'N/A'}%)`);
    }
    lines.push('');
  }

  // 52-week range
  if (overview.week52High && overview.week52Low) {
    lines.push('📊 52-WEEK RANGE');
    lines.push(`  High: $${overview.week52High.toFixed(2)}`);
    lines.push(`  Low: $${overview.week52Low.toFixed(2)}`);
    lines.push('');
  }

  lines.push('═══════════════════════════════════════════════════════');
  lines.push(`Cached: ${cached ? 'Yes ⚡' : 'No (Fresh)'}`);
  lines.push(`Updated: ${data.timestamp.toLocaleString()}`);

  return lines.join('\n');
}

/**
 * Format large numbers (e.g., 1500000000 -> 1.5B)
 */
function formatLargeNumber(num: number): string {
  if (num >= 1e12) {
    return `${(num / 1e12).toFixed(2)}T`;
  }
  if (num >= 1e9) {
    return `${(num / 1e9).toFixed(2)}B`;
  }
  if (num >= 1e6) {
    return `${(num / 1e6).toFixed(2)}M`;
  }
  if (num >= 1e3) {
    return `${(num / 1e3).toFixed(2)}K`;
  }
  return num.toFixed(2);
}
