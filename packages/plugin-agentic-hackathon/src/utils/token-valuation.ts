import { TokenData } from "./token-data";
import { TokenInfo, GoodTraderSwap } from "../swap-storer";
import { DexScreenerResponse } from "./dextools";

export interface ScoringRanges {
    tvlMin: number;
    tvlMax: number;
    volumeMin: number;
    volumeMax: number;
    netBuyMin: number;
    netBuyMax: number;
    goodTraderDiffMin: number;
    goodTraderDiffMax: number;
    heatMin: number;
    heatMax: number;
}

export interface ScoringWeights {
    tvl: number;
    volume: number;
    netBuys: number;
    goodTrader: number;
    heat: number;
}

export interface ScoreDetails {
    finalScore: number;
    breakdown: {
        tvlScore: number;
        volumeScore: number;
        netBuyScore: number;
        goodTraderScore: number;
        heatScore: number;
    };
    weightedBreakdown: {
        tvlScore: number;
        volumeScore: number;
        netBuyScore: number;
        goodTraderScore: number;
        heatScore: number;
    };
    weights: ScoringWeights;
    explanation: {
        tvl: string;
        volume: string;
        netBuys: string;
        goodTrader: string;
        heat: string;
    };
    metrics: {
        tvl: number;
        volume: number;
        netBuys: number;
        goodTraderDiff: number;
        heatRatio: number;
    };
}

interface TimeWeightedMetrics {
    shortTerm: {
        priceChange5m: number;
        volumeChange5m: number;
    };
    mediumTerm: {
        priceChange1h: number;
        volumeChange1h: number;
    };
    longTerm: {
        priceChange24h: number;
        volumeChange24h: number;
    };
}

interface LiquidityHealth {
    concentration: number; // How concentrated is liquidity
    stability: number; // How stable is liquidity over time
    depth: number; // How deep is the liquidity
}

interface MarketContext {
    sectorPerformance: number;
    overallVolumeTrend: number;
    majorTokenCorrelation: number;
}

interface TransactionMetrics {
    buyPressure: number; // Ratio of buys to total transactions
    volumeAcceleration: number; // Rate of volume change
    shortTermMomentum: number; // Recent price movement weighted
    socialSignals: number; // Presence of social/website links
}

interface EnhancedLiquidityHealth extends LiquidityHealth {
    buyPressure: {
        m5: number;
        h1: number;
        h6: number;
        h24: number;
    };
    volumeProfile: {
        m5: number;
        h1: number;
        h6: number;
        h24: number;
    };
}

interface EnhancedScoreDetails extends ScoreDetails {
    timeWeighted: TimeWeightedMetrics;
    smartMoneyMomentum: number;
    liquidityHealth: EnhancedLiquidityHealth;
    riskAdjusted: number;
    marketContext: MarketContext;
    transactionMetrics: TransactionMetrics;
    socialMetrics: {
        websiteCount: number;
        socialCount: number;
        hasImage: boolean;
    };
}

// Default weights - total should equal 1
export const DEFAULT_WEIGHTS: ScoringWeights = {
    tvl: 0.15,
    volume: 0.15,
    netBuys: 0.2,
    goodTrader: 0.3,
    heat: 0.2,
};

export function buildScoringRanges(
    tokens: TokenData[],
    swapsData: TokenInfo[],
    goodTraderActions: GoodTraderSwap[]
): ScoringRanges {
    let tvlMin = Number.POSITIVE_INFINITY,
        tvlMax = 0;
    let volumeMin = Number.POSITIVE_INFINITY,
        volumeMax = 0;
    let netBuyMin = Number.POSITIVE_INFINITY,
        netBuyMax = Number.NEGATIVE_INFINITY;
    let goodTraderDiffMin = Number.POSITIVE_INFINITY,
        goodTraderDiffMax = Number.NEGATIVE_INFINITY;
    let heatMin = Number.POSITIVE_INFINITY,
        heatMax = 0;

    // Precompute netBuy (buys - sells) for each token
    const netBuyMap: Record<string, number> = {};
    for (const info of swapsData) {
        const net = info.buys - info.sold;
        netBuyMap[info.contractAddress.toLowerCase()] = net;
    }

    // Precompute goodTraderDiff in last 30 minutes
    const cutoff = Date.now() - 30 * 60 * 1000;
    const goodTraderCount: Record<string, { buys: number; sells: number }> = {};
    for (const trade of goodTraderActions) {
        const addr = trade.token.address.toLowerCase();
        if (!goodTraderCount[addr]) {
            goodTraderCount[addr] = { buys: 0, sells: 0 };
        }
        if (trade.timestamp > cutoff) {
            if (trade.action === "BUY") goodTraderCount[addr].buys++;
            else if (trade.action === "SELL") goodTraderCount[addr].sells++;
        }
    }

    // Loop all tokens to find global min/max
    for (const t of tokens) {
        const tvl = parseFloat(t.totalValueLockedUSD) || 0;
        const vol = parseFloat(t.volumeUSD) || 0;
        const heat = calculateHeatRatio(t);

        const netBuys = netBuyMap[t.contractAddress.toLowerCase()] ?? 0;
        const gCount = goodTraderCount[t.contractAddress.toLowerCase()] || {
            buys: 0,
            sells: 0,
        };
        const goodTraderDiff = gCount.buys - gCount.sells;

        if (tvl < tvlMin) tvlMin = tvl;
        if (tvl > tvlMax) tvlMax = tvl;

        if (vol < volumeMin) volumeMin = vol;
        if (vol > volumeMax) volumeMax = vol;

        if (netBuys < netBuyMin) netBuyMin = netBuys;
        if (netBuys > netBuyMax) netBuyMax = netBuys;

        if (goodTraderDiff < goodTraderDiffMin)
            goodTraderDiffMin = goodTraderDiff;
        if (goodTraderDiff > goodTraderDiffMax)
            goodTraderDiffMax = goodTraderDiff;

        if (heat < heatMin) heatMin = heat;
        if (heat > heatMax) heatMax = heat;
    }

    return {
        tvlMin,
        tvlMax,
        volumeMin,
        volumeMax,
        netBuyMin,
        netBuyMax,
        goodTraderDiffMin,
        goodTraderDiffMax,
        heatMin,
        heatMax,
    };
}

/** Helper to scale a metric into 0..10 linearly. If invert=true => lower is better. */
export function scaleTo0to10(
    val: number,
    minVal: number,
    maxVal: number,
    invert = false
): number {
    if (maxVal === minVal) {
        // All tokens share the same metric => neutral sub-score
        return 5;
    }
    let ratio = 0;
    if (invert) {
        ratio = (maxVal - val) / (maxVal - minVal);
    } else {
        ratio = (val - minVal) / (maxVal - minVal);
    }
    const scaled = 10 * ratio; // 0..10
    return Math.max(0, Math.min(10, scaled));
}

// Add this function to calculate heat ratio
function calculateHeatRatio(token: TokenData): number {
    const volume = parseFloat(token.volumeUSD);
    const tvl = parseFloat(token.totalValueLockedUSD);
    return tvl > 0 ? volume / tvl : 0;
}

// Modify the dynamicScore function to calculate heat ratio
export function dynamicScore(
    token: TokenData,
    swapsData: TokenInfo[],
    goodTraderActions: GoodTraderSwap[],
    ranges: ScoringRanges,
    weights: Partial<ScoringWeights> = {}
): ScoreDetails {
    // Merge provided weights with defaults
    const finalWeights: ScoringWeights = {
        ...DEFAULT_WEIGHTS,
        ...weights,
    };

    // Normalize weights to ensure they sum to 1
    const weightSum = Object.values(finalWeights).reduce((a, b) => a + b, 0);
    const normalizedWeights: ScoringWeights = Object.entries(
        finalWeights
    ).reduce(
        (acc, [key, value]) => ({
            ...acc,
            [key]: value / weightSum,
        }),
        {} as ScoringWeights
    );

    const tvl = parseFloat(token.totalValueLockedUSD) || 0;
    const vol = parseFloat(token.volumeUSD) || 0;
    const heat = calculateHeatRatio(token);

    // net buys
    const info = swapsData.find(
        (x) =>
            x.contractAddress.toLowerCase() ===
            token.contractAddress.toLowerCase()
    );
    const netBuys = info ? info.buys - info.sold : 0;

    // good trader diff
    const cutoff = Date.now() - 30 * 60 * 1000;
    const buyCount = goodTraderActions.filter(
        (g) =>
            g.token.address.toLowerCase() ===
                token.contractAddress.toLowerCase() &&
            g.action === "BUY" &&
            g.timestamp > cutoff
    ).length;
    const sellCount = goodTraderActions.filter(
        (g) =>
            g.token.address.toLowerCase() ===
                token.contractAddress.toLowerCase() &&
            g.action === "SELL" &&
            g.timestamp > cutoff
    ).length;
    const gDiff = buyCount - sellCount;

    // scale each metric to 0..10
    const tvlSub = scaleTo0to10(tvl, ranges.tvlMin, ranges.tvlMax, false);
    const volSub = scaleTo0to10(vol, ranges.volumeMin, ranges.volumeMax, false);
    const netBuySub = scaleTo0to10(
        netBuys,
        ranges.netBuyMin,
        ranges.netBuyMax,
        false
    );
    const goodTraderSub = scaleTo0to10(
        gDiff,
        ranges.goodTraderDiffMin,
        ranges.goodTraderDiffMax,
        false
    );
    const heatSub = scaleTo0to10(heat, ranges.heatMin, ranges.heatMax, true);

    // Apply weights to each score
    const weightedScores = {
        tvl: tvlSub * normalizedWeights.tvl,
        volume: volSub * normalizedWeights.volume,
        netBuys: netBuySub * normalizedWeights.netBuys,
        goodTrader: goodTraderSub * normalizedWeights.goodTrader,
        heat: heatSub * normalizedWeights.heat,
    };

    // Calculate final score (0-100)
    const finalScore = Math.round(
        Object.values(weightedScores).reduce((a, b) => a + b, 0) * 10
    );

    return {
        finalScore,
        breakdown: {
            tvlScore: tvlSub,
            volumeScore: volSub,
            netBuyScore: netBuySub,
            goodTraderScore: goodTraderSub,
            heatScore: heatSub,
        },
        weightedBreakdown: {
            tvlScore: weightedScores.tvl * 10,
            volumeScore: weightedScores.volume * 10,
            netBuyScore: weightedScores.netBuys * 10,
            goodTraderScore: weightedScores.goodTrader * 10,
            heatScore: weightedScores.heat * 10,
        },
        weights: normalizedWeights,
        explanation: {
            tvl: `TVL: $${tvl.toFixed(2)} (Score: ${tvlSub.toFixed(
                1
            )}/10, Weight: ${(normalizedWeights.tvl * 100).toFixed(0)}%)`,
            volume: `24h Volume: $${vol.toFixed(2)} (Score: ${volSub.toFixed(
                1
            )}/10, Weight: ${(normalizedWeights.volume * 100).toFixed(0)}%)`,
            netBuys: `Net Buys: ${netBuys} (Score: ${netBuySub.toFixed(
                1
            )}/10, Weight: ${(normalizedWeights.netBuys * 100).toFixed(0)}%)`,
            goodTrader: `Smart Money: ${buyCount} buys, ${sellCount} sells (Score: ${goodTraderSub.toFixed(
                1
            )}/10, Weight: ${(normalizedWeights.goodTrader * 100).toFixed(
                0
            )}%)`,
            heat: `Heat Ratio: ${heat.toFixed(3)} (Score: ${heatSub.toFixed(
                1
            )}/10, Weight: ${(normalizedWeights.heat * 100).toFixed(0)}%)`,
        },
        metrics: {
            tvl,
            volume: vol,
            netBuys,
            goodTraderDiff: gDiff,
            heatRatio: heat,
        },
    };
}

export function getRisk(size: string): "LOW" | "MID" | "HIGH" {
    if (size === "large") return "LOW";
    if (size === "small") return "HIGH";
    return "MID";
}

function calculateSmartMoneyMomentum(
    goodTraderActions: GoodTraderSwap[]
): number {
    const timeWindows = [5, 15, 30, 60]; // minutes
    let momentum = 0;

    timeWindows.forEach((window, index) => {
        const windowWeight = 1 / Math.pow(2, index); // Exponential decay
        const cutoff = Date.now() - window * 60 * 1000;
        const recentActions = goodTraderActions.filter(
            (a) => a.timestamp > cutoff
        );
        const buyRatio =
            recentActions.length > 0
                ? recentActions.filter((a) => a.action === "BUY").length /
                  recentActions.length
                : 0;

        momentum += buyRatio * windowWeight;
    });

    return momentum;
}

function calculateTransactionMetrics(
    dexData: DexScreenerResponse | null
): TransactionMetrics {
    if (!dexData?.pairs?.[0]) {
        return {
            buyPressure: 0,
            volumeAcceleration: 0,
            shortTermMomentum: 0,
            socialSignals: 0,
        };
    }

    const pair = dexData.pairs[0];

    // Calculate buy pressure (weighted average of different timeframes)
    const buyPressure = [
        { timeframe: pair.txns.m5, weight: 0.4 },
        { timeframe: pair.txns.h1, weight: 0.3 },
        { timeframe: pair.txns.h6, weight: 0.2 },
        { timeframe: pair.txns.h24, weight: 0.1 },
    ].reduce((acc, { timeframe, weight }) => {
        const total = timeframe.buys + timeframe.sells;
        return acc + (total > 0 ? (timeframe.buys / total) * weight : 0);
    }, 0);

    // Calculate volume acceleration
    const volumeAcceleration = (pair.volume.m5 * 12) / pair.volume.h1 - 1; // Normalized hourly comparison

    // Calculate short-term momentum (weighted price changes)
    const shortTermMomentum =
        (pair.priceChange.m5 || 0) * 0.4 +
        (pair.priceChange.h1 || 0) * 0.3 +
        (pair.priceChange.h6 || 0) * 0.2 +
        (pair.priceChange.h24 || 0) * 0.1;

    // Calculate social signals
    const socialSignals = calculateSocialSignals(pair.info);

    return {
        buyPressure,
        volumeAcceleration,
        shortTermMomentum,
        socialSignals,
    };
}

function calculateSocialSignals(info: any): number {
    if (!info) return 0;

    const websiteCount = info.websites?.length || 0;
    const socialCount = info.socials?.length || 0;
    const hasImage = !!info.imageUrl;

    return (websiteCount * 0.3 + socialCount * 0.2 + (hasImage ? 0.5 : 0)) / 1;
}

function assessLiquidityHealth(
    token: TokenData,
    dexData: DexScreenerResponse | null
): EnhancedLiquidityHealth {
    const defaultHealth: EnhancedLiquidityHealth = {
        concentration: 0.5,
        stability: 0.5,
        depth: 0.5,
        buyPressure: { m5: 0, h1: 0, h6: 0, h24: 0 },
        volumeProfile: { m5: 0, h1: 0, h6: 0, h24: 0 },
    };

    if (!dexData?.pairs?.[0]) return defaultHealth;

    const pair = dexData.pairs[0];

    // Enhanced depth calculation using actual liquidity data
    const depth = Math.min(pair.liquidity.usd / 1000000, 1);

    // Calculate stability using price changes
    const stability = 1 - Math.abs(pair.priceChange.h24 || 0) / 100;

    // Enhanced concentration calculation using transaction data
    const concentration = calculateConcentration(pair);

    // Add detailed buy pressure metrics
    const buyPressure = {
        m5: calculateBuyPressure(pair.txns.m5),
        h1: calculateBuyPressure(pair.txns.h1),
        h6: calculateBuyPressure(pair.txns.h6),
        h24: calculateBuyPressure(pair.txns.h24),
    };

    // Add volume profile
    const volumeProfile = {
        m5: pair.volume.m5 || 0,
        h1: pair.volume.h1 || 0,
        h6: pair.volume.h6 || 0,
        h24: pair.volume.h24 || 0,
    };

    return {
        concentration,
        stability,
        depth,
        buyPressure,
        volumeProfile,
    };
}

function calculateBuyPressure(timeframe: {
    buys: number;
    sells: number;
}): number {
    const total = timeframe.buys + timeframe.sells;
    return total > 0 ? timeframe.buys / total : 0;
}

function calculateConcentration(pair: any): number {
    const h1VolumeHourly = pair.volume.h1;
    const h24VolumeHourly = pair.volume.h24 / 24;

    // Compare current hour to average hour
    return h24VolumeHourly > 0
        ? Math.min(h1VolumeHourly / h24VolumeHourly, 1)
        : 0.5;
}

function calculateRiskAdjustedScore(
    baseScore: number,
    volatility: number,
    liquidityDepth: number
): number {
    const volatilityPenalty = Math.log(1 + volatility) * 0.1;
    const liquidityBonus = Math.min(Math.log(1 + liquidityDepth) * 0.05, 0.5);
    return baseScore * (1 - volatilityPenalty + liquidityBonus);
}

function calculateTimeWeightedMetrics(
    token: TokenData,
    dexData: DexScreenerResponse | null
): TimeWeightedMetrics {
    const defaultMetrics: TimeWeightedMetrics = {
        shortTerm: { priceChange5m: 0, volumeChange5m: 0 },
        mediumTerm: { priceChange1h: 0, volumeChange1h: 0 },
        longTerm: { priceChange24h: 0, volumeChange24h: 0 },
    };

    if (!dexData || !dexData.pairs || dexData.pairs.length === 0) {
        return defaultMetrics;
    }

    const pair = dexData.pairs[0];

    return {
        shortTerm: {
            priceChange5m: pair.priceChange.m5 || 0,
            volumeChange5m: pair.volume.m5 || 0,
        },
        mediumTerm: {
            priceChange1h: pair.priceChange.h1,
            volumeChange1h: pair.volume.h1,
        },
        longTerm: {
            priceChange24h: pair.priceChange.h24,
            volumeChange24h: pair.volume.h24,
        },
    };
}

// Enhanced version of dynamicScore
export function enhancedDynamicScore(
    token: TokenData,
    swapsData: TokenInfo[],
    goodTraderActions: GoodTraderSwap[],
    ranges: ScoringRanges,
    dexData: DexScreenerResponse | null,
    weights: Partial<ScoringWeights> = {}
): EnhancedScoreDetails {
    // Get base scoring
    const baseScore = dynamicScore(
        token,
        swapsData,
        goodTraderActions,
        ranges,
        weights
    );

    // Calculate enhanced metrics
    const momentum = calculateSmartMoneyMomentum(goodTraderActions);
    const liquidityHealth = assessLiquidityHealth(token, dexData);
    const timeWeighted = calculateTimeWeightedMetrics(token, dexData);

    // Calculate volatility from time-weighted metrics
    const volatility =
        Math.abs(timeWeighted.shortTerm.priceChange5m) +
        Math.abs(timeWeighted.mediumTerm.priceChange1h) / 2 +
        Math.abs(timeWeighted.longTerm.priceChange24h) / 4;

    // Calculate risk-adjusted score
    const riskAdjusted = calculateRiskAdjustedScore(
        baseScore.finalScore,
        volatility,
        liquidityHealth.depth
    );

    // Simple market context (can be enhanced with more data)
    const marketContext: MarketContext = {
        sectorPerformance: timeWeighted.longTerm.priceChange24h > 0 ? 1 : 0,
        overallVolumeTrend: timeWeighted.longTerm.volumeChange24h > 0 ? 1 : 0,
        majorTokenCorrelation: 0.5, // Default value, needs historical data for better calculation
    };

    const transactionMetrics = calculateTransactionMetrics(dexData);
    const socialMetrics = {
        websiteCount: dexData?.pairs?.[0]?.info?.websites?.length || 0,
        socialCount: dexData?.pairs?.[0]?.info?.socials?.length || 0,
        hasImage: !!dexData?.pairs?.[0]?.info?.imageUrl,
    };

    // Adjust risk-adjusted score based on new metrics
    const adjustedScore =
        riskAdjusted *
        (1 + transactionMetrics.buyPressure * 0.2) *
        (1 + Math.max(transactionMetrics.volumeAcceleration, 0) * 0.1) *
        (1 + socialMetrics.websiteCount * 0.05);

    return {
        ...baseScore,
        timeWeighted,
        smartMoneyMomentum: momentum,
        liquidityHealth,
        riskAdjusted: adjustedScore,
        marketContext,
        transactionMetrics,
        socialMetrics,
    };
}

/*



const secondTemplate = `You are a hypothetical trading assistant.  
All allocations are fictional and for simulation only.  
No real money is spent.  
No financial advice is given or implied.

We have the following tokens:
{{finalTokens}}

For each token, analyze these detailed metrics:

1. Smart Money Momentum:
- Recent smart trader activity (5-60min windows)
- Buy/Sell ratio from experienced traders
- Weighted momentum score (0-1)

2. Liquidity Health Analysis:
- Depth: Liquidity depth in USD
- Stability: Price stability over 24h
- Concentration: Volume distribution
- Buy Pressure: 
  * 5min: Latest trend
  * 1h: Short-term trend
  * 6h: Medium-term trend
  * 24h: Long-term trend
- Volume Profile across timeframes

3. Risk-Adjusted Performance:
- Base score (0-100)
- Volatility adjustment
- Liquidity depth bonus
- Transaction metrics impact
- Social signal multipliers

4. Market Context:
- Sector performance trend
- Overall volume trajectory
- Major token correlation
- Transaction metrics:
  * Buy pressure ratio
  * Volume acceleration
  * Short-term momentum
  * Social/community signals

5. Price & Volume Metrics:
- TVL (Total Value Locked)
- 24h Trading Volume
- Current Price
- Time-weighted changes:
  * 5min changes
  * 1h changes
  * 24h changes

Allocation Guidelines:
- Prioritize tokens with:
  * Smart Money Momentum > 0.6
  * Liquidity Health depth > 0.7
  * Positive buy pressure across timeframes
  * Strong risk-adjusted scores
  * Healthy social signals
- Adjust allocations based on risk level: {{risk}}
- Total allocation must be 100% (in decimal form)

User request: {{currentMessage}}
Amount to allocate: {{amount}}
Date: {{date}}
Risk preference: {{risk}}

About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

IMPORTANT: Return only this JSON (no extra text, no formatting):

{
  "summary": "string",
  "answer": "string",
  "order": [
    {
      "contractAddress": "string",
      "percentage": "string",
      "name": "string",
      "symbol": "string",
      "decimals": number,
      "summary": "string",
      "info": {},
      "keyMetrics": {
        "smartMoneyMomentum": "string", // Format: "X% bullish momentum (5m: Y%, 1h: Z%)"
        "liquidityHealth": "string",     // Format: "Depth: X%, Stability: Y%, Buy Pressure 24h: Z%"
        "riskAdjusted": "string",       // Format: "Score: X/100 (Vol: Y%, Depth: Z%)"
        "marketContext": "string",       // Format: "Sector: Bullish/Bearish, Volume: Up/Down"
        "tvl": "string",                // Format: "$X,XXX,XXX"
        "volume": "string",             // Format: "$X,XXX,XXX (24h)"
        "price": "string"               // Format: "$X.XXXX"
      }
    }
  ],
  "amount": "string or null",
  "risk": "LOW" | "MID" | "HIGH",
  "type": "token_buy",
  "date": "string"
}`;


*/
