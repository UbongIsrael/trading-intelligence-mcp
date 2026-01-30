
import { getCIK, getSubmissions } from './sec-api.js';

export interface MaterialEvent {
    symbol: string;
    cik: string;
    filingDate: Date;
    eventType: string;
    eventCode: string;
    description: string;
    importance: 'high' | 'medium' | 'low';
    sentiment: 'positive' | 'negative' | 'neutral';
    url: string;
}

export interface RecentEvents {
    symbol: string;
    events: MaterialEvent[];
    highImportanceCount: number;
    lastEventDate: Date;
    summary: string;
}

// 8-K Item Codes mapping
const ITEM_CODES: Record<string, string> = {
    "1.01": "Entry into a Material Definitive Agreement",
    "1.02": "Termination of a Material Definitive Agreement",
    "1.03": "Bankruptcy or Receivership",
    "2.01": "Completion of Acquisition or Disposition of Assets",
    "2.02": "Results of Operations and Financial Condition",
    "2.03": "Creation of a Direct Financial Obligation",
    "2.04": "Triggering Events That Accelerate or Increase a Direct Financial Obligation",
    "3.01": "Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard",
    "3.02": "Unregistered Sales of Equity Securities",
    "3.03": "Material Modification to Rights of Security Holders",
    "4.01": "Changes in Registrant's Certifying Accountant",
    "4.02": "Non-Reliance on Previously Issued Financial Statements",
    "5.01": "Changes in Control of Registrant",
    "5.02": "Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers",
    "5.03": "Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year",
    "7.01": "Regulation FD Disclosure",
    "8.01": "Other Events"
};

/**
 * Classify event importance
 */
export function classifyEventImportance(eventCode: string): 'high' | 'medium' | 'low' {
    const high = ["1.01", "1.02", "1.03", "2.01", "2.02", "3.01", "4.02", "5.01", "5.02"];
    const medium = ["2.03", "2.04", "3.02", "3.03", "4.01"];

    if (high.includes(eventCode)) return 'high';
    if (medium.includes(eventCode)) return 'medium';
    return 'low';
}

/**
 * Classify sentiment based on code
 */
function classifySentiment(eventCode: string): 'positive' | 'negative' | 'neutral' {
    if (eventCode === "1.03" || eventCode === "3.01") return 'negative';
    if (eventCode === "1.01" || eventCode === "2.02") return 'neutral'; // Depends on context
    return 'neutral';
}

/**
 * Fetch recent 8-K filings
 */
export async function fetchMaterialEvents(
    symbol: string,
    lookbackDays: number = 90
): Promise<MaterialEvent[]> {
    try {
        const cik = await getCIK(symbol);
        const data = await getSubmissions(cik);

        const filings = data.filings.recent;
        const events: MaterialEvent[] = [];
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

        for (let i = 0; i < filings.accessionNumber.length; i++) {
            if (filings.form[i] !== '8-K') continue;

            const filingDateStr = filings.filingDate[i];
            const filingDate = new Date(filingDateStr);

            if (filingDate < cutoffDate) {
                if (events.length > 20) break;
                continue;
            }

            // Parse items
            const items = filings.items[i] || ""; // items is sometimes a string like "2.02,9.01"
            const itemCodes = items.split(',');

            // We might have multiple items per 8-K. Let's create an event for the most important one?
            // Or just one event per 8-K representing the primary items.

            const primaryItem = itemCodes[0];
            const description = ITEM_CODES[primaryItem] || `8-K Filing (Item ${primaryItem})`;
            const importance = classifyEventImportance(primaryItem);
            const sentiment = classifySentiment(primaryItem);

            const accessionNumber = filings.accessionNumber[i];
            const primaryDocument = filings.primaryDocument[i];
            const accessionClean = accessionNumber.replace(/-/g, '');
            const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionClean}/${primaryDocument}`;

            events.push({
                symbol,
                cik,
                filingDate,
                eventType: description,
                eventCode: primaryItem,
                description,
                importance,
                sentiment,
                url
            });
        }

        return events;

    } catch (error) {
        console.error(`Error fetching material events for ${symbol}:`, error);
        return [];
    }
}
