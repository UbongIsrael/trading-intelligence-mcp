# Trading Intelligence MCP Server

A high-performance Model Context Protocol (MCP) server providing comprehensive trading intelligence across multiple asset classes. Listed on [Ctx Protocol](https://ctxprotocol.com) with JWT authorization.

## Features

- 🚀 **Multi-Asset Price Aggregation**: Real-time prices for stocks (Yahoo Finance) and crypto (CoinGecko)
- 📊 **Technical Analysis**: Liquidity zones, support/resistance, trend analysis from historical data
- 💰 **Funding Rates**: Perpetual futures funding rates across 200+ Binance perpetuals
- 📈 **Fundamental Data**: Company overviews, earnings, financial statements via Alpha Vantage
- 🏢 **DCF Valuation**: Full DCF v5 model (EBITDA-based FCFF, WACC, equity bridge, sensitivity analysis)
- 🔍 **Contextual Fundamentals**: YoY changes, pattern detection, insider trading, SEC 8-K material events
- ⚡ **High Performance**: Redis caching with cache-aside pattern, graceful degradation when Redis is unavailable

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- Redis (optional — for caching; system degrades gracefully without it)

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

### Required Configuration

| Variable | Description |
|----------|-------------|
| `ALPHA_VANTAGE_API_KEY` | API key for fundamentals data |
| `FMP_API_KEY` | API key for DCF analysis (Financial Modeling Prep) |
| `CTX_JWT_SECRET` | JWT secret for Ctx Protocol authorization |
| `SEC_USER_AGENT` | Contact email for SEC EDGAR access (e.g., `yourname@email.com`) |
| `REDIS_URL` | Redis connection URL (optional, e.g., `redis://localhost:6379`) |

## Project Structure

```
src/
├── index.ts                          # Entry point
├── server.ts                         # MCP server setup
├── index-http.ts                     # HTTP server variant
├── http-server.ts                    # Express HTTP wrapper
├── types.ts                          # Shared type definitions
├── config.ts                         # Configuration management
├── tools/
│   ├── registry.ts                   # Tool registration & MCP handler wiring
│   ├── health.ts                     # health_check
│   ├── price-tool.ts                 # get_price, get_batch_prices, invalidate_price_cache
│   ├── funding-tool.ts               # 5 funding rate tools
│   ├── liquidity-tool.ts             # 5 technical analysis tools
│   ├── fundamentals-tool.ts          # 4 fundamentals tools
│   ├── dcf-tool.ts                   # run_dcf_analysis, quick_dcf
│   └── contextual-fundamentals-tool.ts # get_contextual_fundamentals
├── services/
│   ├── prices.ts                     # Price aggregation router (stock vs crypto)
│   ├── stocks.ts                     # Yahoo Finance stock price fetcher
│   ├── crypto.ts                     # CoinGecko crypto price fetcher
│   ├── funding.ts                    # Binance perpetual funding rate service
│   ├── liquidity.ts                  # Technical analysis engine (pivot points, S/R)
│   ├── fundamentals-alphavantage.ts  # Alpha Vantage fundamentals (active)
│   ├── fundamentals.ts               # Finnhub fundamentals (legacy, retained as reference)
│   ├── dcf-analysis.ts               # DCF v5 valuation engine (1592 lines)
│   ├── fmp-data-service.ts           # Financial Modeling Prep API client
│   ├── fmp-types.ts                  # FMP API type definitions
│   ├── contextual-analysis.ts        # YoY change & pattern detection
│   ├── insider-trading.ts            # SEC EDGAR insider transaction analysis
│   ├── material-events.ts            # SEC 8-K filing parsing
│   ├── sec-api.ts                    # SEC EDGAR API client
│   └── api-key-pool.ts               # Alpha Vantage API key rotation pool
├── cache/
│   ├── redis.ts                      # Redis connection pool (ioredis)
│   ├── utils.ts                      # Cache-aside pattern, batch ops, stats tracking
│   └── metrics.ts                    # Redis latency & health monitoring
├── schemas/
│   └── output-schemas.ts             # Data Broker output schema definitions
└── utils/
    └── mutex.ts                      # Async mutex for API key serialization
tests/
├── server.test.ts
├── registry.test.ts
├── liquidity.test.ts
├── funding.test.ts
├── fundamentals.test.ts
├── liquidity.integration.test.ts
├── funding.integration.test.ts
├── fundamentals.integration.test.ts
└── cache/
    ├── redis.test.ts
    ├── utils.test.ts
    ├── service.test.ts
    └── benchmarks.test.ts
scripts/
└── verify_fixes.ts
```

## MCP Tools

The server registers **17 MCP tools** across 6 categories:

### System

| Tool | Description | Parameters |
|------|-------------|------------|
| `health_check` | Server health, cache status, and upstream service status | `detailed?: boolean` |

### Prices

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_price` | Real-time price for a stock or crypto | `symbol: string` |
| `get_batch_prices` | Prices for up to 50 symbols | `symbols: string[]` |
| `invalidate_price_cache` | Force refresh cached prices | `symbols: string[]` |

### Funding Rates (Binance Perpetuals)

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_funding_rate` | Current funding rate for a perpetual | `symbol: string` |
| `get_batch_funding_rates` | Rates for up to 50 symbols | `symbols: string[]` |
| `get_all_funding_rates` | Rates for 200+ Binance perpetuals | _(none)_ |
| `get_funding_rate_stats` | Historical funding rate statistics | `symbol: string`, `period?: string` |
| `list_supported_perpetuals` | Available perpetual symbols | _(none)_ |

### Technical Analysis

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_liquidity_zones` | Top 5 support/resistance levels | `symbol: string`, `timeframe: string` |
| `get_support_resistance` | Nearest support & resistance | `symbol: string`, `timeframe: string` |
| `analyze_price_levels` | Comprehensive price level analysis | `symbol: string`, `timeframe: string` |
| `quick_support_resistance` | Lean support/resistance snapshot | `symbol: string`, `timeframe: string` |
| `get_available_timeframes` | Supported chart timeframes | _(none)_ |

Timeframes: `1h`, `4h`, `1d`, `1w`

### Fundamentals

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_company_overview` | Company profile, sector, market cap, ratios | `symbol: string` |
| `get_earnings` | Quarterly earnings history with beats/misses | `symbol: string` |
| `get_financial_statements` | Income statement, balance sheet, or cash flow | `symbol: string`, `type: string`, `period: string` |
| `get_full_fundamentals` | Combined overview + earnings + financials | `symbol: string` |
| `get_contextual_fundamentals` | YoY changes, pattern detection, insider trades, 8-K events | `symbol: string` |

### DCF Valuation

| Tool | Description | Parameters |
|------|-------------|------------|
| `run_dcf_analysis` | Full DCF v5 — EBITDA-based FCFF, WACC, equity bridge, sensitivity analysis, football field | `symbol: string` |
| `quick_dcf` | EPS-based rapid intrinsic value screening | `symbol: string` |

The DCF v5 model includes:
- EBITDA-based Free Cash Flow to Firm (FCFF) with equity bridge
- WACC via CAPM with peer-adjusted beta (Hamada equation)
- 10-year two-phase projection (5 years full growth, 5 years linear fade to terminal)
- Gordon Growth terminal value with GDP-ceiling guard
- Exit EBITDA multiple cross-check
- Reverse DCF (binary search for market-implied growth rate)
- 5×5 sensitivity matrix (WACC × terminal growth)
- Football field valuation ranges
- Automatic detection of financial institutions (banks, insurance, REITs, asset managers) with alternative models (DDM, FFO, FCFE)

## Data Sources

| Source | Usage |
|--------|-------|
| **Yahoo Finance** | Stock prices, historical OHLCV data |
| **CoinGecko** | Crypto prices (37 supported symbols) |
| **Binance** | Perpetual futures funding rates (200+ markets) |
| **Alpha Vantage** | Company fundamentals, financial statements, earnings |
| **Financial Modeling Prep** | DCF analysis (SEC EDGAR-sourced financials, revenue segments, analyst estimates) |
| **SEC EDGAR** | Insider trading transactions, 8-K material events |

## Architecture

- **MCP Layer**: `@modelcontextprotocol/sdk` for tool registration and request handling; `@ctxprotocol/sdk` for Ctx Protocol JWT authorization
- **Cache Layer**: Redis with cache-aside pattern (connection pooling, stats tracking, graceful degradation when unavailable)
- **Service Layer**: Modular services per data domain with try/catch fallbacks — the system never crashes from upstream API failures
- **Key Rotation**: Alpha Vantage supports multiple free-tier API keys with automatic least-recently-used rotation
- **Error Handling**: Structured error responses returned as MCP content, no unhandled exceptions

## Development

```bash
# Run tests
npm test

# Lint
npm run lint

# Format
npm run format

# Build
npm run build

# HTTP mode (dev)
npm run dev:http
npm run start:http
```

## Deployment

Designed for deployment on Railway, Render, or similar platforms.

```bash
npm run build
npm start
```

No PostgreSQL or external database is required — all state is ephemeral (Redis cache only).

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

For issues or questions, please open a GitHub issue.