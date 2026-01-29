# Trading Intelligence MCP Server

A high-performance Model Context Protocol (MCP) server providing comprehensive trading intelligence across multiple asset classes.

## Features

- 🚀 **Multi-Asset Price Aggregation**: Real-time prices for stocks, crypto, forex
- 📊 **Technical Analysis**: Liquidity zones, support/resistance, trend analysis
- 📈 **Fundamental Data**: SEC filings, earnings, company financials
- 💰 **Derivatives Data**: Options flow, funding rates, open interest
- 📰 **News & Sentiment**: Real-time news aggregation with sentiment analysis
- ⚡ **High Performance**: Redis caching, <2s response times

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- Redis (for caching)
- PostgreSQL (for historical data)

### Installation

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your API keys and configuration
nano .env

# Build the project
npm run build

# Run in development mode
npm run dev

# Run in production mode
npm start
```

## Project Structure

```
trading-intelligence-mcp/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── types.ts              # TypeScript type definitions
│   ├── config.ts             # Configuration management
│   ├── cache/
│   │   └── redis.ts          # Redis caching layer
│   ├── services/
│   │   ├── prices.ts         # Price aggregation service
│   │   ├── stocks.ts         # Stock-specific data
│   │   ├── crypto.ts         # Crypto-specific data
│   │   ├── technical.ts      # Technical analysis
│   │   └── fundamentals.ts   # Fundamental data
│   └── tools/
│       ├── price-tool.ts     # MCP price query tool
│       ├── liquidity-tool.ts # MCP liquidity zones tool
│       └── fundamentals-tool.ts # MCP fundamentals tool
├── tests/
│   └── (test files)
├── package.json
├── tsconfig.json
└── README.md
```

## MCP Tools

### `get_price`
Retrieve real-time prices for any asset (stocks, crypto, forex).

**Parameters:**
- `symbol`: Asset symbol (e.g., "AAPL", "BTC", "EUR/USD")
- `assetType`: Optional asset type filter

**Example:**
```json
{
  "symbol": "AAPL"
}
```

### `get_liquidity_zones`
Identify key liquidity zones and support/resistance levels.

**Parameters:**
- `symbol`: Asset symbol
- `timeframe`: Chart timeframe (e.g., "1h", "4h", "1d")

### `get_fundamentals`
Retrieve fundamental data including financials, earnings, and SEC filings.

**Parameters:**
- `symbol`: Stock symbol
- `dataType`: Type of fundamental data (e.g., "earnings", "balance_sheet")

## Development

### Running Tests
```bash
npm test
```

### Linting
```bash
npm run lint
```

### Formatting
```bash
npm run format
```

## Architecture

- **MCP Layer**: Context Protocol SDK for tool registration and request handling
- **Cache Layer**: Redis for high-performance caching (cache-aside pattern)
- **Data Layer**: PostgreSQL for historical data storage
- **Service Layer**: Modular services for different data sources
- **API Integration**: Multiple data providers with fallback strategies

## Performance Targets

- Response time: <2 seconds for price queries
- Cache hit rate: >80% for repeated queries
- Uptime: 99.9% availability
- Rate limiting: Respectful of API provider limits

## Deployment

Designed for deployment on Railway, Render, or similar platforms.

```bash
# Build for production
npm run build

# Start production server
npm start
```

## Roadmap

### Week 1 ✅
- Foundation & core infrastructure
- Multi-asset price aggregator
- Redis caching

### Week 2 (In Progress)
- Funding rates & perpetual data
- Basic fundamental data
- Liquidity zone detection

### Week 3
- Advanced technical analysis
- News & sentiment integration
- Options flow data

### Week 4
- Performance optimization
- Enhanced error handling
- Documentation & examples

### Week 5
- Beta testing
- Context Protocol marketplace listing
- Production launch

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

For issues or questions, please open a GitHub issue.
