import type { DCFDataBundle } from './fmp-data-service.js';

export interface NormalizedMarketData {
    currentPrice: number;
    marketCap: number;
    sharesOutstanding: number;
    netDebt: number;
    enterpriseValue: number;
    financialStatementScale: number;
    marketCurrency: string;
    statementCurrency: string;
    source: string;
    warnings: string[];
    diagnostics: {
        profilePrice: number;
        priceServicePrice: number;
        profileMarketCap: number;
        profileImpliedShares: number;
        enterpriseValuePrice: number;
        enterpriseValueMarketCap: number;
        enterpriseValueShares: number;
        incomeDilutedShares: number;
        rawNetDebt: number;
        localToMarketCurrencyScale: number;
    };
}

function positive(value: number | undefined | null): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function gap(a: number, b: number): number {
    if (!positive(a) || !positive(b)) return Number.POSITIVE_INFINITY;
    return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
}

export function normalizeMarketData(bundle: DCFDataBundle, priceServicePrice = 0): NormalizedMarketData {
    const profilePrice = positive(bundle.profile.price) ? bundle.profile.price : 0;
    const currentPrice = positive(priceServicePrice) ? priceServicePrice : profilePrice;
    const profileMarketCap = bundle.profile.marketCap ?? bundle.profile.mktCap ?? 0;
    const latestEnterpriseValue = [...(bundle.enterpriseValues ?? [])].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
    const latestIncome = [...bundle.incomeStatements].sort((a, b) => b.date.localeCompare(a.date))[0];
    const latestBalance = [...bundle.balanceSheets].sort((a, b) => b.date.localeCompare(a.date))[0];
    const marketCurrency = bundle.profile.currency || 'USD';
    const statementCurrency = latestIncome?.reportedCurrency || latestBalance?.reportedCurrency || marketCurrency;
    const enterpriseValuePrice = latestEnterpriseValue?.stockPrice ?? 0;
    const enterpriseValueMarketCap = latestEnterpriseValue?.marketCapitalization ?? 0;
    const enterpriseValueShares = latestEnterpriseValue?.numberOfShares ?? 0;
    const incomeDilutedShares = latestIncome?.weightedAverageShsOutDil ?? 0;
    const rawNetDebt = latestBalance?.netDebt ?? 0;
    const warnings: string[] = [];
    const marketCapRatio = positive(profileMarketCap) && positive(enterpriseValueMarketCap)
        ? enterpriseValueMarketCap / profileMarketCap
        : 1;
    const looksLikeLocalCurrencyStatements = (
        marketCurrency !== statementCurrency &&
        positive(profileMarketCap) &&
        positive(enterpriseValueMarketCap) &&
        marketCapRatio >= 3
    );
    const financialStatementScale = looksLikeLocalCurrencyStatements
        ? profileMarketCap / enterpriseValueMarketCap
        : 1;
    const netDebt = rawNetDebt * financialStatementScale;

    if (positive(profilePrice) && positive(priceServicePrice) && gap(profilePrice, priceServicePrice) > 0.10) {
        warnings.push(`Profile price and live price differ materially: ${profilePrice.toFixed(2)} vs ${priceServicePrice.toFixed(2)}.`);
    }
    if (positive(profilePrice) && positive(enterpriseValuePrice) && gap(profilePrice, enterpriseValuePrice) > 0.25) {
        warnings.push(`Profile and enterprise-value prices conflict: ${profilePrice.toFixed(2)} vs ${enterpriseValuePrice.toFixed(2)}.`);
    }
    if (positive(profileMarketCap) && positive(enterpriseValueMarketCap) && gap(profileMarketCap, enterpriseValueMarketCap) > 0.25) {
        warnings.push(`Profile and enterprise-value market caps conflict: ${profileMarketCap.toFixed(0)} vs ${enterpriseValueMarketCap.toFixed(0)}.`);
    }

    const anchorPrice = currentPrice || profilePrice || enterpriseValuePrice;
    const profileImpliedShares = positive(profileMarketCap) && positive(anchorPrice) ? profileMarketCap / anchorPrice : 0;
    if (positive(profileImpliedShares) && positive(enterpriseValueShares) && gap(profileImpliedShares, enterpriseValueShares) > 0.10) {
        warnings.push(`Profile-implied and enterprise-value share counts conflict: ${profileImpliedShares.toFixed(0)} vs ${enterpriseValueShares.toFixed(0)}.`);
    }
    if (positive(profileImpliedShares) && positive(incomeDilutedShares) && gap(profileImpliedShares, incomeDilutedShares) > 0.10) {
        warnings.push(`Profile-implied and income-statement diluted shares conflict: ${profileImpliedShares.toFixed(0)} vs ${incomeDilutedShares.toFixed(0)}.`);
    }
    if (looksLikeLocalCurrencyStatements) {
        warnings.push(`Financial statements appear local-currency (${statementCurrency}) while market data is ${marketCurrency}; applying scale ${financialStatementScale.toFixed(4)} to balance-sheet net debt.`);
    } else if (marketCurrency !== statementCurrency && positive(profileMarketCap) && positive(enterpriseValueMarketCap) && gap(profileMarketCap, enterpriseValueMarketCap) > 0.25) {
        warnings.push(`Currency/listing mismatch is ambiguous (${statementCurrency} statements, ${marketCurrency} market data); valuation should remain blocked or manually reviewed.`);
    }

    if (positive(profileMarketCap) && positive(anchorPrice)) {
        return {
            currentPrice: anchorPrice,
            marketCap: profileMarketCap,
            sharesOutstanding: profileMarketCap / anchorPrice,
            netDebt,
            enterpriseValue: profileMarketCap + netDebt,
            financialStatementScale,
            marketCurrency,
            statementCurrency,
            source: warnings.length ? 'profile_market_cap_price_with_warnings' : 'profile_market_cap_price',
            warnings,
            diagnostics: {
                profilePrice,
                priceServicePrice,
                profileMarketCap,
                profileImpliedShares,
                enterpriseValuePrice,
                enterpriseValueMarketCap,
                enterpriseValueShares,
                incomeDilutedShares,
                rawNetDebt,
                localToMarketCurrencyScale: financialStatementScale,
            },
        };
    }

    if (positive(enterpriseValueMarketCap) && positive(enterpriseValuePrice)) {
        return {
            currentPrice: enterpriseValuePrice,
            marketCap: enterpriseValueMarketCap,
            sharesOutstanding: enterpriseValueMarketCap / enterpriseValuePrice,
            netDebt,
            enterpriseValue: enterpriseValueMarketCap + netDebt,
            financialStatementScale,
            marketCurrency,
            statementCurrency,
            source: 'enterprise_value_market_cap_price',
            warnings,
            diagnostics: {
                profilePrice,
                priceServicePrice,
                profileMarketCap,
                profileImpliedShares,
                enterpriseValuePrice,
                enterpriseValueMarketCap,
                enterpriseValueShares,
                incomeDilutedShares,
                rawNetDebt,
                localToMarketCurrencyScale: financialStatementScale,
            },
        };
    }

    const sharesOutstanding = enterpriseValueShares || incomeDilutedShares || 0;
    const marketCap = positive(anchorPrice) && positive(sharesOutstanding) ? anchorPrice * sharesOutstanding : 0;
    if (!positive(marketCap)) warnings.push('Unable to build internally consistent price, market cap, and shares cluster.');

    return {
        currentPrice: anchorPrice,
        marketCap,
        sharesOutstanding,
        netDebt,
        enterpriseValue: marketCap + netDebt,
        financialStatementScale,
        marketCurrency,
        statementCurrency,
        source: 'fallback_price_times_shares',
        warnings,
        diagnostics: {
            profilePrice,
            priceServicePrice,
            profileMarketCap,
            profileImpliedShares,
            enterpriseValuePrice,
            enterpriseValueMarketCap,
            enterpriseValueShares,
            incomeDilutedShares,
            rawNetDebt,
            localToMarketCurrencyScale: financialStatementScale,
        },
    };
}
