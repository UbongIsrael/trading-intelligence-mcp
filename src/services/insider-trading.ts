
import { getCIK, getSubmissions, fetchSecData } from './sec-api.js';

export interface InsiderTransaction {
    symbol: string;
    cik: string;
    filingDate: Date;
    transactionDate: Date;
    insiderName: string;
    insiderTitle: string;
    transactionType: 'buy' | 'sell';
    shares: number;
    pricePerShare: number;
    totalValue: number;
    sharesOwnedAfter: number;
    isDirector: boolean;
    isOfficer: boolean;
    is10PercentOwner: boolean;
}

export interface InsiderActivity {
    symbol: string;
    recentTransactions: InsiderTransaction[];
    buyingActivity: {
        totalShares: number;
        totalValue: number;
        transactionCount: number;
    };
    sellingActivity: {
        totalShares: number;
        totalValue: number;
        transactionCount: number;
    };
    netActivity: 'net_buying' | 'net_selling' | 'neutral';
    pattern: 'routine' | 'unusual' | 'clustered';
    sentiment: 'bullish' | 'bearish' | 'neutral';
    lastUpdated: Date;
}

/**
 * Helper to parse value from XML tag
 */
function getTagValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 's');
    const match = xml.match(regex);
    return match ? match[1].trim() : '';
}

/**
 * Fetch recent insider transactions from SEC Form 4
 */
export async function fetchInsiderTransactions(
    symbol: string,
    lookbackDays: number = 90
): Promise<InsiderTransaction[]> {
    try {
        const cik = await getCIK(symbol);
        const data = await getSubmissions(cik);

        const filings = data.filings.recent;
        const transactions: InsiderTransaction[] = [];
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

        // Iterate through recent filings
        for (let i = 0; i < filings.accessionNumber.length; i++) {
            if (filings.form[i] !== '4') continue;

            const filingDateStr = filings.filingDate[i]; // YYYY-MM-DD
            const filingDate = new Date(filingDateStr);

            if (filingDate < cutoffDate) {
                // Assuming filings are ordered, we can stop or skip. 
                // EDGAR recent filings are time ordered descending.
                if (transactions.length > 50) break; // Safety break
                continue;
            }

            // Construct URL for the XML document
            const accessionNumber = filings.accessionNumber[i];
            const primaryDocument = filings.primaryDocument[i];
            const accessionClean = accessionNumber.replace(/-/g, '');
            const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionClean}/${primaryDocument}`;

            try {
                const xml = await fetchSecData<string>(xmlUrl, true);

                // Basic XML parsing - identifying non-derivative transactions
                // We look for <nonDerivativeTransaction> blocks
                const transactionBlocks = xml.split('</nonDerivativeTransaction>');

                const insiderName = getTagValue(xml, 'rptOwnerName');
                const isDirector = getTagValue(xml, 'isDirector') === '1' || getTagValue(xml, 'isDirector') === 'true';
                const isOfficer = getTagValue(xml, 'isOfficer') === '1' || getTagValue(xml, 'isOfficer') === 'true';
                const is10PercentOwner = getTagValue(xml, 'isTenPercentOwner') === '1' || getTagValue(xml, 'isTenPercentOwner') === 'true';
                let officerTitle = getTagValue(xml, 'officerTitle');
                if (!officerTitle && isDirector) officerTitle = 'Director';

                for (const block of transactionBlocks) {
                    if (!block.includes('<nonDerivativeTransaction>')) continue;

                    // Extract transaction code (P = Purchase, S = Sale)
                    // Note: <transactionCode> is typically inside <transactionCoding>
                    const codeMatch = block.match(/<transactionCode>\s*(.*?)\s*<\/transactionCode>/);
                    const code = codeMatch ? codeMatch[1] : '';

                    if (code !== 'P' && code !== 'S') continue; // Only interested in open market buy/sell

                    const dateStr = getTagValue(block, 'transactionDate').replace(/<value>|<\/value>/g, '');
                    const shares = parseFloat(getTagValue(block, 'transactionShares').replace(/<value>|<\/value>/g, ''));
                    const price = parseFloat(getTagValue(block, 'transactionPricePerShare').replace(/<value>|<\/value>/g, ''));
                    const ownedAfter = parseFloat(getTagValue(block, 'sharesOwnedFollowingTransaction').replace(/<value>|<\/value>/g, ''));

                    if (isNaN(shares) || isNaN(price)) continue;

                    transactions.push({
                        symbol,
                        cik,
                        filingDate,
                        transactionDate: new Date(dateStr),
                        insiderName,
                        insiderTitle: officerTitle,
                        transactionType: code === 'P' ? 'buy' : 'sell',
                        shares,
                        pricePerShare: price,
                        totalValue: shares * price,
                        sharesOwnedAfter: ownedAfter,
                        isDirector,
                        isOfficer,
                        is10PercentOwner
                    });
                }

            } catch (err) {
                console.warn(`Failed to parse filing ${xmlUrl}:`, err);
            }
        }

        return transactions;

    } catch (error) {
        console.error(`Error fetching insider transactions for ${symbol}:`, error);
        return [];
    }
}

/**
 * Analyze insider activity patterns
 */
export async function analyzeInsiderActivity(
    symbol: string,
    transactions: InsiderTransaction[]
): Promise<InsiderActivity> {
    const buying = transactions.filter(t => t.transactionType === 'buy');
    const selling = transactions.filter(t => t.transactionType === 'sell');

    const buyShares = buying.reduce((sum, t) => sum + t.shares, 0);
    const buyValue = buying.reduce((sum, t) => sum + t.totalValue, 0);

    const sellShares = selling.reduce((sum, t) => sum + t.shares, 0);
    const sellValue = selling.reduce((sum, t) => sum + t.totalValue, 0);

    let netActivity: 'net_buying' | 'net_selling' | 'neutral' = 'neutral';
    if (buyValue > sellValue * 1.2) netActivity = 'net_buying';
    else if (sellValue > buyValue * 1.2) netActivity = 'net_selling';

    // Pattern detection heuristic
    let pattern: 'routine' | 'unusual' | 'clustered' = 'routine';

    // Check for clustering (multiple insiders in short period)
    const uniqueInsiders = new Set(transactions.map(t => t.insiderName)).size;
    if (uniqueInsiders > 2 && transactions.length > 5) {
        pattern = 'clustered';
    }

    // Check for unusual size (simple heuristic: > $1M or > 10% of remaining holdings?)
    // For now, let's just say if single transaction > $500k and it's a buy, or > $5M and it's a sell
    if (transactions.some(t => t.transactionType === 'buy' && t.totalValue > 500000) ||
        transactions.some(t => t.transactionType === 'sell' && t.totalValue > 5000000)) {
        // Only unusual if not routine? Hard to say without history.
        // Let's stick to easy flags.
        if (pattern !== 'clustered') pattern = 'unusual';
    }

    let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (netActivity === 'net_buying') sentiment = 'bullish';
    else if (netActivity === 'net_selling') sentiment = 'bearish';

    return {
        symbol,
        recentTransactions: transactions.slice(0, 10), // Limit to top 10 recent
        buyingActivity: {
            totalShares: buyShares,
            totalValue: buyValue,
            transactionCount: buying.length
        },
        sellingActivity: {
            totalShares: sellShares,
            totalValue: sellValue,
            transactionCount: selling.length
        },
        netActivity,
        pattern,
        sentiment,
        lastUpdated: new Date()
    };
}
