
const YAHOO_FINANCE_BASE_URL = 'https://query2.finance.yahoo.com';

async function fetchStockPrice(symbol) {
    const url = new URL(`${YAHOO_FINANCE_BASE_URL}/v8/finance/chart/${symbol}`);
    url.searchParams.append('interval', '1d');
    url.searchParams.append('range', '1d');

    console.log(`Fetching ${url.toString()}...`);

    try {
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        if (!response.ok) {
            console.error(`Error: ${response.status} ${response.statusText}`);
            return;
        }

        const data = await response.json();
        if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
            console.error("No data found");
            return;
        }

        const meta = data.chart.result[0].meta;
        const output = `
Symbol: ${meta.symbol}
Regular Market Price: ${meta.regularMarketPrice}
Chart Previous Close: ${meta.chartPreviousClose}
Previous Close: ${meta.previousClose}
Market Cap: ${meta.marketCap}
Currency: ${meta.currency}
Full Meta Keys: ${Object.keys(meta).join(', ')}
    `;

        // Append to file
        const fs = require('fs');
        fs.appendFileSync('debug_output.txt', output + '\n---\n');
        console.log("Logged to debug_output.txt");

    } catch (error) {
        console.error("Fetch failed:", error);
        const fs = require('fs');
        fs.appendFileSync('debug_output.txt', `ERROR: ${error.message}\n---\n`);
    }
}

fetchStockPrice('TSLA');
fetchStockPrice('AAPL');
