/**
 * Financial Modeling Prep (FMP) — Type Definitions
 *
 * These types mirror the exact JSON field names returned by FMP's stable API.
 * See fmp_api_schemas.md in the brain folder for verified response samples.
 *
 * IMPORTANT differences vs Alpha Vantage:
 *   - All numbers are actual numbers, not strings
 *   - capitalExpenditure is POSITIVE (AV was negative)
 *   - SEC filing date field is spelled "fillingDate" (not "filingDate")
 *   - netDebt is pre-computed by FMP
 */

// ─────────────────────────────────────────────────────────
// Income Statement
// ─────────────────────────────────────────────────────────

export interface FMPIncomeStatement {
    date: string;                  // "2024-09-28"
    symbol: string;
    reportedCurrency: string;
    cik: string;
    fillingDate: string;           // SEC filing date — note double-L
    acceptedDate: string;
    calendarYear: string;          // "2024"
    period: string;                // "FY" | "Q1" | "Q2" | "Q3" | "Q4"
    revenue: number;
    costOfRevenue: number;
    grossProfit: number;
    grossProfitRatio: number;
    researchAndDevelopmentExpenses: number;
    generalAndAdministrativeExpenses: number;
    sellingAndMarketingExpenses: number;
    sellingGeneralAndAdministrativeExpenses: number;
    otherExpenses: number;
    operatingExpenses: number;
    costAndExpenses: number;
    interestIncome: number;
    interestExpense: number;
    depreciationAndAmortization: number;
    ebitda: number;
    ebitdaratio: number;
    operatingIncome: number;
    operatingIncomeRatio: number;
    totalOtherIncomeExpensesNet: number;
    incomeBeforeTax: number;
    incomeBeforeTaxRatio: number;
    incomeTaxExpense: number;
    netIncome: number;
    netIncomeRatio: number;
    eps: number;
    epsdiluted: number;
    weightedAverageShsOut: number;
    weightedAverageShsOutDil: number;
    link: string;
    finalLink: string;
}

// ─────────────────────────────────────────────────────────
// Balance Sheet
// ─────────────────────────────────────────────────────────

export interface FMPBalanceSheet {
    date: string;
    symbol: string;
    reportedCurrency: string;
    cik: string;
    fillingDate: string;
    calendarYear: string;
    period: string;
    cashAndCashEquivalents: number;
    shortTermInvestments: number;
    cashAndShortTermInvestments: number;
    netReceivables: number;
    inventory: number;
    otherCurrentAssets: number;
    totalCurrentAssets: number;
    propertyPlantEquipmentNet: number;
    goodwill: number;
    intangibleAssets: number;
    goodwillAndIntangibleAssets: number;
    longTermInvestments: number;
    taxAssets: number;
    otherNonCurrentAssets: number;
    totalNonCurrentAssets: number;
    otherAssets: number;
    totalAssets: number;
    accountPayables: number;
    shortTermDebt: number;
    taxPayables: number;
    deferredRevenue: number;
    otherCurrentLiabilities: number;
    totalCurrentLiabilities: number;
    longTermDebt: number;
    deferredRevenueNonCurrent: number;
    deferredTaxLiabilitiesNonCurrent: number;
    otherNonCurrentLiabilities: number;
    totalNonCurrentLiabilities: number;
    otherLiabilities: number;
    capitalLeaseObligations: number;
    totalLiabilities: number;
    preferredStock: number;
    commonStock: number;
    retainedEarnings: number;
    accumulatedOtherComprehensiveIncomeLoss: number;
    othertotalStockholdersEquity: number;
    totalStockholdersEquity: number;
    totalEquity: number;
    totalLiabilitiesAndStockholdersEquity: number;
    minorityInterest: number;
    totalLiabilitiesAndTotalEquity: number;
    totalInvestments: number;
    totalDebt: number;
    netDebt: number;
    link: string;
    finalLink: string;
}

// ─────────────────────────────────────────────────────────
// Cash Flow Statement
// ─────────────────────────────────────────────────────────

export interface FMPCashFlowStatement {
    date: string;
    symbol: string;
    reportedCurrency: string;
    cik: string;
    fillingDate: string;
    calendarYear: string;
    period: string;
    netIncome: number;
    depreciationAndAmortization: number;
    deferredIncomeTax: number;
    stockBasedCompensation: number;
    changeInWorkingCapital: number;
    accountsReceivables: number;
    inventory: number;
    accountsPayables: number;
    otherWorkingCapital: number;
    otherNonCashItems: number;
    netCashProvidedByOperatingActivities: number;
    investmentsInPropertyPlantAndEquipment: number;
    acquisitionsNet: number;
    purchasesOfInvestments: number;
    salesMaturitiesOfInvestments: number;
    otherInvestingActivites: number;
    netCashUsedForInvestingActivites: number;
    debtRepayment: number;
    commonStockIssued: number;
    commonStockRepurchased: number;
    dividendsPaid: number;
    otherFinancingActivites: number;
    netCashUsedProvidedByFinancingActivities: number;
    effectOfForexChangesOnCash: number;
    netChangeInCash: number;
    cashAtEndOfPeriod: number;
    cashAtBeginningOfPeriod: number;
    operatingCashFlow: number;
    capitalExpenditure: number;        // POSITIVE number — do NOT negate
    freeCashFlow: number;
    link: string;
    finalLink: string;
}

// ─────────────────────────────────────────────────────────
// Company Profile
// ─────────────────────────────────────────────────────────

export interface FMPProfile {
    symbol: string;
    price: number;
    beta: number;
    volAvg: number;
    mktCap: number;
    lastDiv: number;
    range: string;
    changes: number;
    companyName: string;
    currency: string;
    cik: string;
    isin: string;
    cusip: string;
    exchange: string;
    exchangeShortName: string;
    industry: string;
    website: string;
    description: string;
    ceo: string;
    sector: string;
    country: string;
    fullTimeEmployees: string;
    phone: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    dcfDiff: number;
    dcf: number;
    image: string;
    ipoDate: string;
    defaultImage: boolean;
    isEtf: boolean;
    isActivelyTrading: boolean;
    isAdr: boolean;
    isFund: boolean;
}

// ─────────────────────────────────────────────────────────
// Enterprise Value
// ─────────────────────────────────────────────────────────

export interface FMPEnterpriseValue {
    symbol: string;
    date: string;
    stockPrice: number;
    numberOfShares: number;
    marketCapitalization: number;
    minusCashAndCashEquivalents: number;
    addTotalDebt: number;
    enterpriseValue: number;
}

// ─────────────────────────────────────────────────────────
// Key Metrics
// ─────────────────────────────────────────────────────────

export interface FMPKeyMetrics {
    symbol: string;
    date: string;
    calendarYear: string;
    period: string;
    revenuePerShare: number;
    netIncomePerShare: number;
    operatingCashFlowPerShare: number;
    freeCashFlowPerShare: number;
    cashPerShare: number;
    bookValuePerShare: number;
    marketCap: number;
    enterpriseValue: number;
    peRatio: number;
    priceToSalesRatio: number;
    pfcfRatio: number;
    pbRatio: number;
    evToSales: number;
    enterpriseValueOverEBITDA: number;
    evToFreeCashFlow: number;
    debtToEquity: number;
    debtToAssets: number;
    netDebtToEBITDA: number;
    currentRatio: number;
    interestCoverage: number;
    dividendYield: number;
    payoutRatio: number;
    capexToRevenue: number;
    capexToDepreciation: number;
    roic: number;
    roe: number;
    workingCapital: number;
    investedCapital: number;
    capexPerShare: number;
}

// ─────────────────────────────────────────────────────────
// Revenue Geographic Segments
// ─────────────────────────────────────────────────────────

export interface FMPRevenueSegment {
    date: string;
    symbol: string;
    reportedCurrency: string;
    period: string;
    [region: string]: string | number; // region keys are dynamic: "Americas", "Europe", etc.
}

export interface ParsedRevenueSegment {
    segment: string;
    revenue: number;
    share: number;
}

// ─────────────────────────────────────────────────────────
// Analyst Estimates
// ─────────────────────────────────────────────────────────

export interface FMPAnalystEstimate {
    symbol: string;
    date: string;
    estimatedRevenueLow: number;
    estimatedRevenueHigh: number;
    estimatedRevenueAvg: number;
    estimatedEbitdaLow: number;
    estimatedEbitdaHigh: number;
    estimatedEbitdaAvg: number;
    estimatedEbitLow: number;
    estimatedEbitHigh: number;
    estimatedEbitAvg: number;
    estimatedNetIncomeLow: number;
    estimatedNetIncomeHigh: number;
    estimatedNetIncomeAvg: number;
    estimatedSgaExpenseLow: number;
    estimatedSgaExpenseHigh: number;
    estimatedSgaExpenseAvg: number;
    estimatedEpsAvg: number;
    estimatedEpsHigh: number;
    estimatedEpsLow: number;
    numberAnalystEstimatedRevenue: number;
    numberAnalystsEstimatedEps: number;
}

// ─────────────────────────────────────────────────────────
// Industry Peers
// ─────────────────────────────────────────────────────────

export interface FMPPeersResponse {
    symbol: string;
    peersList: string[];
}

// ─────────────────────────────────────────────────────────
// DCF Data Bundle — aggregated fetch result for DCF engine
// ─────────────────────────────────────────────────────────

export interface DCFDataBundle {
    profile: FMPProfile;
    incomeStatements: FMPIncomeStatement[];
    balanceSheets: FMPBalanceSheet[];
    cashFlowStatements: FMPCashFlowStatement[];
    enterpriseValues: FMPEnterpriseValue[];
    analystEstimates: FMPAnalystEstimate[];
    revenueSegments: ParsedRevenueSegment[];
    peers: string[];
    fetchedAt: Date;
}
