
import { getCacheService } from '../cache/index.js';
import { APIError } from '../types.js';

const SEC_BASE_URL = 'https://data.sec.gov';
const USER_AGENT = 'TradingIntelligenceMCP/1.0 (admin@example.com)'; // Replace with config if available

interface SecTicker {
    cik_str: number;
    ticker: string;
    title: string;
}

interface SecTickersResponse {
    [key: string]: SecTicker;
}

// Rate limiting: SEC allows ~10 requests/second. We'll be conservative.
const RATE_LIMIT_DELAY = 150; // 150ms between requests (~6 req/sec)
let lastRequestTime = 0;

async function respectRateLimit() {
    const now = Date.now();
    const timeSinceLast = now - lastRequestTime;
    if (timeSinceLast < RATE_LIMIT_DELAY) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLast));
    }
    lastRequestTime = Date.now();
}

/**
 * Fetch with rate limiting and User-Agent
 */
export async function fetchSecData<T>(url: string, isText = false): Promise<T> {
    await respectRateLimit();

    //console.log(`[SEC API] Fetching ${url}`);

    const response = await fetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept-Encoding': 'gzip, deflate',
            'Host': 'data.sec.gov'
        }
    });

    if (!response.ok) {
        throw new APIError(`SEC API failed: ${response.status} ${response.statusText}`, { url });
    }

    if (isText) {
        return await response.text() as unknown as T;
    }
    return await response.json() as T;
}

/**
 * Get CIK for a symbol
 * Caches the ticker->CIK mapping
 */
export async function getCIK(symbol: string): Promise<string> {
    symbol = symbol.toUpperCase();
    const cache = getCacheService();

    // Try cache first
    const cachedCik = await cache.fundamentals.get(`cik:${symbol}`, 'mapping');
    if (cachedCik) {
        return cachedCik as unknown as string;
    }

    // Verify we have the mapping loaded
    // We'll cache the entire mapping list ID for a day, but individual lookups?
    // Let's just fetch the tickers.json if we miss

    console.log(`[SEC API] Fetching ticker map for ${symbol}`);
    const tickersUrl = 'https://www.sec.gov/files/company_tickers.json';

    // Note: company_tickers.json is on www.sec.gov, not data.sec.gov
    await respectRateLimit();
    const response = await fetch(tickersUrl, {
        headers: { 'User-Agent': USER_AGENT }
    });

    if (!response.ok) {
        throw new APIError('Failed to fetch SEC ticker mapping');
    }

    const data = await response.json() as SecTickersResponse;
    const tickers = Object.values(data);

    const match = tickers.find(t => t.ticker === symbol);
    if (!match) {
        throw new APIError(`CIK not found for symbol ${symbol}`);
    }

    const cik = match.cik_str.toString().padStart(10, '0');

    // Cache this specific result
    await cache.fundamentals.set(`cik:${symbol}`, 'mapping', cik as any);

    return cik;
}

/**
 * Get recent submissions for CIK
 */
export async function getSubmissions(cik: string) {
    const url = `${SEC_BASE_URL}/submissions/CIK${cik}.json`;
    return await fetchSecData<any>(url);
}
