# DCF Tool Documentation

This document describes the production DCF tool implemented in `src/services/dcf-analysis.ts` and exposed through `src/tools/dcf-tool.ts`. The tool is no longer a single generic DCF. It is a valuation framework router that classifies the company, selects the best available valuation model, returns a bear/base/bull range where possible, and flags cases where a specialized model is still being built.

The tool should be read as a structured valuation framework, not as a promise that one intrinsic value is correct for every company.

## Output Philosophy

The production output includes:

- Primary model selected.
- Broad valuation class.
- Reinvestment subclass.
- Bear/base/bull scenario range.
- Confidence label.
- Model selection reasons.
- DCF suitability message.
- Reverse-implied assumptions.
- Relative valuation cross-checks when peer data is usable.
- Market data normalization diagnostics.
- Actual-values-only output for companies where FCFF/DCF is structurally unsuitable.

If a specialized model is not ready, the tool may still show a generic FCFF valuation and explicitly warn:

```text
<subclass> specialized model is being built; generic FCFF DCF is provided as an interim valuation view.
```

Financials, REITs, and unsupported ADR/foreign listings remain blocked from generic FCFF because the issue is structural, not just a missing model.

## Data Sources

The DCF service uses the FMP data bundle:

- Profile.
- Annual income statements.
- Annual balance sheets.
- Annual cash flow statements.
- Enterprise value records.
- Analyst estimates.
- Revenue geography segments.
- Industry peers.

The service also fetches:

- Live/current price through the local price service.
- FMP key metrics for selected diagnostics and peer cross-checks.

## Market Data Normalization

Production uses `src/services/market-data-normalization.ts` to build a consistent market data cluster:

```text
current price
market cap
shares outstanding
net debt
enterprise value
market currency
statement currency
financial statement scale
diagnostic warnings
```

The normalizer prefers profile market cap and live/profile price when available, then falls back to enterprise value records and finally price times shares.

### ADR / Foreign Currency Handling

Some FMP foreign listings have market data in USD while statements and enterprise-value market cap are reported in local currency. For obvious cases, the tool infers:

```text
financialStatementScale = profile market cap / enterprise-value market cap
```

This scale is used to convert balance-sheet net debt into the market-data currency. Models that explicitly support this, such as pharma product-cycle models, also scale starting revenue.

Example:

```text
NVO:
  market currency: USD
  statement currency: DKK
  financialStatementScale: inferred from profile market cap / EV market cap
```

ADR/foreign rules:

- Supported normalized pharma ADR/foreign names may route to pharma product-cycle or pharma supercycle models.
- Ambiguous ADR/foreign mismatches are blocked.
- Non-pharma ADR/foreign names remain actual-values-only until an ADR/share/FX framework exists.

## Broad Valuation Classes

The first-stage classifier returns:

```text
financial
utility
reit
adr_foreign
mature_defensive
growth_optional
heavy_reinvestment
distressed_or_turnaround
cyclical
standard_operating
```

### Financial

Detected from sector/industry and financial indicators such as significant net interest income.

Production behavior:

- Banks, insurance, capital markets, credit lenders, and similar financial institutions are marked unsuitable for standard FCFF.
- Output is actual-values-only.

Reason:

Debt, deposits, reserves, float, and working capital are operating raw materials for financial institutions. FCFF and WACC do not mean the same thing they mean for operating companies.

### Utility

Utilities route to a dividend discount model before reinvestment subclasses can select capex-heavy or generic DCF.

Reason:

Regulated utilities are debt-heavy, dividend-oriented, and often better framed by payout capacity than by generic operating FCFF.

### REIT

REITs are blocked from standard FCFF and return actual values only.

Reason:

REIT valuation should use AFFO, FFO quality, NAV, cap rates, lease duration, and property-level assumptions. The current production DCF does not yet have that model.

### ADR / Foreign

ADR/foreign listings are blocked unless a specific model explicitly supports normalized foreign data. Currently, normalized pharma ADR/foreign names can route to the pharma models.

### Mature Defensive

Stable, lower-growth names generally use standard FCFF unless a more specific model is selected.

### Growth Optional

High-growth or high-beta names. This class often relies on reinvestment subclasses to select the right model or produce an interim generic valuation.

### Heavy Reinvestment

Companies with high capex and/or low current FCF margins. This class is only a broad warning; subclass routing decides the model.

### Cyclical

Energy, materials, industrials, autos, and other cyclically exposed companies. Many still use generic FCFF until a cycle-specific model exists.

### Standard Operating

Default class for operating companies that do not trigger a special broad class.

## Reinvestment Subclasses

The second-stage classifier returns:

```text
not_reinvestment
turnaround_or_low_roic_reinvestment
high_roic_mature_compounder
pharma_product_cycle_compounder
pharma_supercycle_compounder
biotech_pipeline_compounder
capital_light_software_compounder
capex_heavy_scaled_reinvestor
acquisition_platform
semiconductor_ai_acquisition_platform
cyclical_semicap_compounder
profitable_reinvestment_other
```

Shared reinvestment diagnostics:

```text
Adjusted EBIT = Operating Income + R&D - estimated R&D amortization
NOPAT = Adjusted EBIT * (1 - tax rate)
Invested Capital = Total Debt + Total Equity - Cash
ROIC = NOPAT / Invested Capital
Reinvestment = CapEx + Working Capital Investment + R&D - D&A
Reinvestment Rate = Reinvestment / NOPAT
Implied Growth = ROIC * Reinvestment Rate
```

R&D amortization is currently approximated with a simple trailing three-year average:

```text
R&D amortization ~= average(current R&D, prior-year R&D, two-year-prior R&D)
```

This avoids treating all R&D as a period expense while also treating it as reinvestment.

## Classification Logic

### Reinvestment Detection

A company is treated as reinvestment-relevant if any of the following is true:

```text
capex/revenue >= 6%
R&D/revenue >= 8%
SBC/revenue >= 5%
growth >= 8%
reinvestment rate >= 25%
normalized FCF margin <= 8%
```

### Turnaround / Low-ROIC

Selected when current economics are weak:

```text
latest NOPAT <= 0
or adjusted EBIT margin <= 0
or ROIC < 85% of WACC
```

Current production behavior:

```text
generic FCFF with specialized-model warning
```

### Cyclical Semicap

Selected for semiconductor equipment and related cyclicals:

```text
industry includes Semiconductor Equipment
or industry includes Semiconductor Material
or symbol in LRCX, KLAC, AMAT, ASML
```

Current production behavior:

```text
generic FCFF with specialized-model warning
```

The mid-cycle model exists in code but is intentionally disabled until retuned.

### Semiconductor AI Acquisition Platform

Currently explicit for:

```text
AVGO
```

Current production behavior:

```text
generic FCFF with specialized-model warning
```

Reason:

AVGO is not a generic acquisition platform. The intended model needs AI semiconductor owner earnings, VMware/software synergy realization, platform durability, and acquisition optionality.

### Pharma Product-Cycle

Selected when:

```text
sector is Healthcare
and industry includes Drug Manufacturers or Pharmaceutical
and supercycle guard is not triggered
```

### Pharma Supercycle

Selected when:

```text
sector is Healthcare
and industry includes Drug Manufacturers or Pharmaceutical
and (symbol is LLY or growth >= 20%)
```

### Biotech Pipeline

Selected when:

```text
sector is Healthcare
and industry includes Biotech or Biotechnology
```

Current production behavior:

```text
generic FCFF with specialized-model warning
```

This is an interim output. A true biotech model should be probability-adjusted by asset, indication, trial phase, launch timing, and patent life.

### High-ROIC Mature Compounder

Selected when:

```text
ROIC >= max(WACC + 8%, 18%)
adjusted EBIT margin >= 20%
growth between 0% and 18%
```

### Capital-Light Software Compounder

Selected when:

```text
sector is Technology
capex/revenue < 6%
and (R&D/revenue >= 12% or SBC/revenue >= 7%)
```

Current production behavior:

```text
generic FCFF with specialized-model warning
```

### Capex-Heavy Scaled Reinvestor

Selected when:

```text
capex/revenue >= 10%
adjusted EBIT margin < 25%
```

### Acquisition Platform

Selected only when acquisition behavior is persistent:

```text
average acquisitions/revenue >= 12%
median acquisitions/revenue >= 4%
acquisition years >= 2
```

Current production behavior:

```text
generic FCFF with specialized-model warning
```

### Profitable Reinvestment Other

Fallback for profitable reinvestment businesses that do not fit a more specific subclass.

Current production behavior:

```text
profitable_reinvestment_fade_bridge_fcff
```

## Production Model Routing Summary

```text
financial
  -> actual values only

reit
  -> actual values only

unsupported adr_foreign
  -> actual values only

TSLA
  -> tesla_scenario_required_dcf

utility
  -> regulated_utility_forward_eps_payout_ddm
  -> or regulated_utility_current_dividend_ddm

high_roic_mature_compounder
  -> high_roic_mature_fade_bridge_fcff

profitable_reinvestment_other
  -> profitable_reinvestment_fade_bridge_fcff
  -> excluded for mature_defensive and cyclical broad classes

capex_heavy_scaled_reinvestor
  -> capex_heavy_scaled_reinvestor_tsla_directional_dcf

pharma_product_cycle_compounder
  -> pharma_product_cycle_sotp_dcf

pharma_supercycle_compounder
  -> pharma_supercycle_sotp_dcf

cyclical_semicap_compounder
  -> generic FCFF with specialized-model warning

turnaround_or_low_roic_reinvestment
  -> generic FCFF with specialized-model warning

capital_light_software_compounder
  -> generic FCFF with specialized-model warning

acquisition_platform
  -> generic FCFF with specialized-model warning

semiconductor_ai_acquisition_platform
  -> generic FCFF with specialized-model warning

biotech_pipeline_compounder
  -> generic FCFF with specialized-model warning

not_reinvestment
  -> standard FCFF
```

## Available Models

### 1. Standard FCFF

Used for:

```text
standard_operating
mature_defensive
not_reinvestment
generic fallback classes
```

Formula:

```text
FCFF_t = Revenue_t * normalized FCF margin
Terminal Value = FCFF_n * (1 + g) / (WACC - g)
Enterprise Value = PV(explicit FCFF) + PV(Terminal Value)
Equity Value = Enterprise Value - Net Debt
Fair Value / Share = Equity Value / Shares
```

Growth is selected from analyst forward revenue when usable, otherwise revenue CAGR, otherwise sector fallback.

Terminal growth:

```text
g = min(2.5%, GDP ceiling)
```

Known weakness:

Generic FCFF is blunt for high-growth, cyclical, turnaround, pipeline, acquisition-heavy, and reinvestment-heavy names.

### 2. High-ROIC Mature Fade Bridge

Model id:

```text
high_roic_mature_fade_bridge_fcff
```

Core formula:

```text
NOPAT = Revenue * adjusted EBIT margin * (1 - tax rate)
Reinvestment Rate = Growth / ROIC
FCFF = NOPAT * (1 - Reinvestment Rate)
```

Forecast structure:

- Years 1-5: phase-one growth capped by sector/scale.
- Bridge period: growth fades toward terminal growth.
- ROIC fades toward a capped stable ROIC.
- SBC is handled through diluted share growth.
- Terminal growth remains GDP-like and capped.

Stable ROIC:

```text
stable ROIC = clamp(WACC + terminal ROIC spread, WACC + 0.5%, stable ROIC cap)
```

Tightening conditions:

```text
Healthcare/pharma:
  phase-one growth cap 10%
  terminal margin cap 32%
  stable ROIC cap 24%

Consumer defensive:
  phase-one growth cap 8%
  terminal margin cap 28%
  stable ROIC cap 22%

Industrial/materials/energy:
  phase-one growth cap 10%
  terminal margin cap 22%
  stable ROIC cap 22%

Semiconductor:
  phase-one growth cap 16% mega-cap, 20% otherwise
  terminal margin cap 35%
  stable ROIC cap 32%

Technology/communication:
  phase-one growth cap 15% mega-cap, 22% otherwise
  terminal margin cap 35%
  stable ROIC cap 28% mega-cap, 32% otherwise
```

Purpose:

This model does not uncap terminal growth. It gives high-quality businesses a longer fade and preserves value through ROIC spread, not fantasy perpetual growth.

### 3. Profitable Reinvestment Fade Bridge

Model id:

```text
profitable_reinvestment_fade_bridge_fcff
```

Used for:

```text
profitable_reinvestment_other
```

Core formula:

```text
Adjusted EBIT = Operating Income + R&D - R&D amortization
NOPAT = Revenue * normalized adjusted EBIT margin * (1 - tax rate)
Reinvestment Rate = Growth / ROIC
FCFF = NOPAT * (1 - Reinvestment Rate)
```

Base case:

```text
forecast period: 23 years
phase-one growth: clamp(analyst growth, 12%, 30%)
terminal margin: 27%
stable ROIC: WACC + 7.5%, capped at 35%
terminal growth: min(2.5%, WACC - 1%)
SBC: diluted share growth
```

Bull case:

```text
forecast period: 20 years
phase-one growth: max(analyst growth + 2%, observed implied growth * 90%), capped at 33%
terminal margin: 42%
stable ROIC: WACC + 9%, capped at 35%
terminal growth: min(2.5%, WACC - 1%)
```

This was calibrated for NVDA-like profitable reinvestment names where generic FCFF crushed explicit-period value.

### 4. Capex-Heavy Scaled Reinvestor

Model id:

```text
capex_heavy_scaled_reinvestor_tsla_directional_dcf
```

Used for:

```text
capex_heavy_scaled_reinvestor
```

Formula:

```text
EBITDA = Revenue * EBITDA margin
D&A = Revenue * D&A/revenue
SBC = Revenue * SBC/revenue
EBIT = EBITDA - D&A - SBC
NOPAT = EBIT * (1 - tax rate)
FCFF = NOPAT + D&A - CapEx - Working Capital Investment
```

Scenario assumptions:

```text
Bear:
  WACC >= 12.5%
  initial growth <= 9%
  EBITDA margin fades to at least 22%
  capex/revenue fades to 7%

Base:
  WACC <= 9.5%
  initial growth at least 13%
  EBITDA margin fades to at least 25%
  capex/revenue fades to 5%

Bull:
  WACC <= 9.0%
  initial growth at least 15%
  EBITDA margin fades to at least 28%
  capex/revenue fades to 4%
```

Purpose:

This model frames scaled reinvestors as margin and capex-normalization stories.

### 5. TSLA Scenario DCF

Model id:

```text
tesla_scenario_required_dcf
```

Used only for:

```text
TSLA
```

Formula:

```text
EBITDAR = Revenue * EBITDAR margin
EBIT = EBITDAR - D&A - SBC cost
NOPAT = EBIT * (1 - tax rate)
FCFF = NOPAT + D&A - CapEx
Terminal Value = FCFF_2033 * (1 + g) / (WACC - g)
Fair Value / Share = (Enterprise Value - Net Debt) / 3.448B diluted shares
```

Base assumptions:

```text
WACC: 9.1%
terminal growth: 3.0%
revenue growth: 22.5% fading to 3.0%
EBITDAR margin: 16.3% fading to 15.0%
capex/revenue: 11.6% fading to 3.0%
SBC cost: $1.8B annually
```

Purpose:

This model shows what Tesla's operating DCF supports before adding any separately modeled real-option value for FSD, Robotaxi, Optimus, or similar optionality.

### 6. Pharma Product-Cycle and Supercycle

Model ids:

```text
pharma_product_cycle_sotp_dcf
pharma_supercycle_sotp_dcf
```

Formula:

```text
Starting Revenue = latest reported revenue * financialStatementScale
Adjusted Operating Margin = average operating margin + 25% * R&D/revenue
NOPAT_t = Revenue_t * Operating Margin_t * (1 - tax rate)
R&D Maintenance = Revenue_t * clamp(35% * R&D/revenue, 3%, 10%)
FCFF_t = NOPAT_t - R&D Maintenance
Core EV = PV(FCFF) + PV(Terminal Value)
Pipeline Value = Core EV * pipeline credit
Enterprise Value = Core EV + Pipeline Value
Fair Value / Share = (Enterprise Value - Net Debt) / Shares
```

Product-cycle scenario anchors:

```text
Bear:
  erosion starts year 7
  erosion rate 10%
  terminal margin cap 26%
  pipeline credit 4%

Base:
  erosion starts year 9
  erosion rate 6%
  terminal margin cap 32%
  pipeline credit 10%

Bull:
  erosion starts year 11
  erosion rate 3%
  terminal margin cap 36%
  pipeline credit 18%
```

Supercycle scenario anchors:

```text
Bear:
  erosion starts year 8
  erosion rate 8%
  terminal margin cap 30%
  pipeline credit 8%

Base:
  erosion starts year 11
  erosion rate 3.5%
  terminal margin cap 35%
  pipeline credit 16%

Bull:
  erosion starts year 14
  erosion rate 1.5%
  terminal margin cap 40%
  pipeline credit 28%
```

Reverse diagnostics:

```text
Required Pipeline Credit = Current EV / Base Core EV - 1
Required Terminal Margin = terminal margin needed to match current EV
Required Growth Multiplier = growth multiplier needed to match current EV
Required Erosion Start Year = erosion delay needed to match current EV
```

### 7. Utility Dividend Discount Model

Model ids:

```text
regulated_utility_forward_eps_payout_ddm
regulated_utility_current_dividend_ddm
```

Formula:

```text
Value = Dividend_1 / (Cost of Equity - g)
Dividend_1 = Forward EPS * payout ratio
```

Fallback:

```text
Dividend_1 = current dividend per share
```

Growth is capped by the terminal growth guard. Utilities route here before reinvestment models.

### 8. Actual Values Only

Used for:

```text
financial
reit
unsupported adr_foreign
```

Output includes:

- Current price.
- Market cap.
- Shares outstanding.
- Book equity.
- Book value per share.
- Net income.
- EPS.
- ROE.
- P/B.
- P/E.

## Generic FCFF Fallback Classes

These currently receive a full generic FCFF valuation plus a warning that the specialized model is being built:

```text
turnaround_or_low_roic_reinvestment
capital_light_software_compounder
acquisition_platform
semiconductor_ai_acquisition_platform
cyclical_semicap_compounder
biotech_pipeline_compounder
```

## Models Still Being Worked On

### Turnaround / Low-ROIC Reinvestment

Needed for names where current NOPAT, margin, or ROIC is too weak for a reinvestment compounder model.

Planned approach:

```text
explicit recovery scenarios
target margin normalization
target ROIC recovery
probability-weighted outcomes
no automatic extrapolation from current weak economics
```

### Capital-Light Software Compounder

Planned approach:

```text
R&D-capitalized owner earnings
SBC handled through dilution
sales efficiency fade
operating leverage bridge
terminal growth capped
```

### Acquisition Platform

Planned approach:

```text
organic FCFF
acquisitions as reinvested capital
acquired-capital ROIC
integration/synergy sensitivity
```

### Semiconductor AI Acquisition Platform

Current example:

```text
AVGO
```

Planned approach:

```text
AI semiconductor owner earnings
VMware/software synergy realization
future acquisition optionality
platform durability
reverse-implied assumptions
```

### Cyclical Semicap Compounder

The `cyclical_semicap_midcycle_dcf` function exists in production code but is disabled in routing because current tests were not acceptable.

Planned retune:

```text
mid-cycle revenue
mid-cycle EBIT/FCF margin
cycle-adjusted WACC
normalized wafer-fab equipment demand
relative valuation boundary
```

### Biotech Pipeline

Planned approach:

```text
asset-by-asset pipeline model
trial phase probabilities
indication market sizing
launch timing
patent/LOE schedules
probability-adjusted FCFF
```

FMP does not currently provide enough pipeline detail for this to be automatic.

### REIT / AFFO / NAV

Planned approach:

```text
AFFO
same-store NOI
cap rates
debt maturity schedule
NAV
property-sector assumptions
```

## Core Assumptions

### Terminal Growth

Terminal growth is capped. The tool does not uncap terminal growth to force values toward market price.

Policy:

```text
Use longer fade bridges and terminal ROIC spreads instead of fantasy terminal growth.
```

### SBC

Preferred treatment:

```text
handle SBC through diluted share growth where the model projects shares
```

Avoid double-counting by not always subtracting SBC from FCFF and also diluting shares.

### R&D

R&D-heavy companies are adjusted by partially capitalizing R&D in reinvestment models:

```text
Adjusted EBIT = Operating Income + R&D - R&D amortization
```

Current amortization is a rough trailing average. Future work should make amortization period industry-specific.

### GDP Ceiling

Terminal growth is constrained by the GDP ceiling resolved from revenue geography when possible:

```text
dominant geography if >= 75%
otherwise weighted geography blend
otherwise world/listing fallback
```

### Confidence Labels

Confidence is tied to:

- Base IV offset from market price.
- Data warnings.
- Terminal value concentration.
- WACC clamps.
- Class/model suitability.

It is not a recommendation to buy or sell by itself.

## Known Limitations

- FMP does not provide full segment EBIT, capex, working capital, invested capital, or WACC.
- Product-level pharma and biotech data is unavailable in the current bundle.
- ADR/share ratios and FX are only partially normalized.
- Generic FCFF fallback is intentionally approximate for classes with pending specialized models.
- Some live audits may fail due to FMP rate limits or price-service timeouts.

