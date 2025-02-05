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

export interface TimeWeightedMetrics {
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

export interface LiquidityHealth {
    concentration: number; // How concentrated is liquidity
    stability: number; // How stable is liquidity over time
    depth: number; // How deep is the liquidity
}

export interface EnhancedLiquidityHealth extends LiquidityHealth {
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

export interface MarketContext {
    sectorPerformance: number;
    overallVolumeTrend: number;
    majorTokenCorrelation: number;
}

export interface TransactionMetrics {
    buyPressure: number; // Ratio of buys to total transactions
    volumeAcceleration: number; // Rate of volume change
    shortTermMomentum: number; // Recent price movement weighted
    socialSignals: number; // Presence of social/website links
}

export interface EnhancedScoreDetails extends ScoreDetails {
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

// New helper for volume scoring by size
function getVolumeScore(
    volume: number,
    size: string,
    ranges: Record<string, ScoringRanges> | ScoringRanges
): number {
    const sizeRanges: ScoringRanges =
        "medium" in ranges
            ? (ranges as Record<string, ScoringRanges>)[size] ||
              (ranges as Record<string, ScoringRanges>)["medium"]
            : (ranges as ScoringRanges);
    return scaleTo0to10(
        volume,
        sizeRanges.volumeMin,
        sizeRanges.volumeMax,
        false
    );
}

// Modified heat ratio scoring
function getHeatScore(heat: number): number {
    return heat * 1000; // Multiply by 1000 instead of 100
}

// Modified net buys scoring
function getNetBuyScore(buys: number, sells: number): number {
    if (buys === 0 && sells === 0) return 0;
    return buys - sells;
}

// Modified smart money scoring
function getSmartMoneyScore(buyCount: number, sellCount: number): number {
    if (buyCount === 0 && sellCount === 0) return 0;
    return buyCount - sellCount;
}

function groupBy<T>(array: T[], key: (item: T) => string): Record<string, T[]> {
    return array.reduce((result: Record<string, T[]>, item: T) => {
        const group: string = key(item);
        result[group] = result[group] || [];
        result[group].push(item);
        return result;
    }, {});
}

function calculateRangesForGroup(
    tokens: TokenData[],
    swapsData: TokenInfo[],
    goodTraderActions: GoodTraderSwap[]
): ScoringRanges {
    let tvlMin: number = Number.POSITIVE_INFINITY,
        tvlMax: number = 0;
    let volumeMin: number = Number.POSITIVE_INFINITY,
        volumeMax: number = 0;
    let netBuyMin: number = Number.POSITIVE_INFINITY,
        netBuyMax: number = Number.NEGATIVE_INFINITY;
    let goodTraderDiffMin: number = Number.POSITIVE_INFINITY,
        goodTraderDiffMax: number = Number.NEGATIVE_INFINITY;
    let heatMin: number = Number.POSITIVE_INFINITY,
        heatMax: number = 0;

    // Process tokens in group
    for (const t of tokens) {
        const tvl: number = parseFloat(t.totalValueLockedUSD) || 0;
        const vol: number = parseFloat(t.volumeUSD) || 0;
        const heat: number = calculateHeatRatio(t);

        const info: TokenInfo | undefined = swapsData.find(
            (x) =>
                x.contractAddress.toLowerCase() ===
                t.contractAddress.toLowerCase()
        );
        const netBuys: number = info ? info.buys - info.sold : 0;

        const cutoff: number = Date.now() - 30 * 60 * 1000;
        const smartMoneyBuys: number = goodTraderActions.filter(
            (g) =>
                g.token.address.toLowerCase() ===
                    t.contractAddress.toLowerCase() &&
                g.action === "BUY" &&
                g.timestamp > cutoff
        ).length;
        const smartMoneySells: number = goodTraderActions.filter(
            (g) =>
                g.token.address.toLowerCase() ===
                    t.contractAddress.toLowerCase() &&
                g.action === "SELL" &&
                g.timestamp > cutoff
        ).length;
        const goodTraderDiff: number = smartMoneyBuys - smartMoneySells;

        // Update min/max values
        tvlMin = Math.min(tvlMin, tvl);
        tvlMax = Math.max(tvlMax, tvl);
        volumeMin = Math.min(volumeMin, vol);
        volumeMax = Math.max(volumeMax, vol);
        netBuyMin = Math.min(netBuyMin, netBuys);
        netBuyMax = Math.max(netBuyMax, netBuys);
        goodTraderDiffMin = Math.min(goodTraderDiffMin, goodTraderDiff);
        goodTraderDiffMax = Math.max(goodTraderDiffMax, goodTraderDiff);
        heatMin = Math.min(heatMin, heat);
        heatMax = Math.max(heatMax, heat);
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

export function buildScoringRanges(
    tokens: TokenData[],
    swapsData: TokenInfo[],
    goodTraderActions: GoodTraderSwap[]
): Record<string, ScoringRanges> {
    // Group tokens by size
    const sizeGroups: Record<string, TokenData[]> = groupBy(
        tokens,
        (t) => t.size || "medium"
    );

    const ranges: Record<string, ScoringRanges> = {};

    // Calculate ranges for each size group
    for (const [size, sizeTokens] of Object.entries(sizeGroups)) {
        ranges[size] = calculateRangesForGroup(
            sizeTokens,
            swapsData,
            goodTraderActions
        );
    }

    return ranges;
}

/** Helper to scale a metric into 0..10 linearly. If invert=true => lower is better. */
export function scaleTo0to10(
    val: number,
    minVal: number,
    maxVal: number,
    invert: boolean = false
): number {
    if (maxVal === minVal) {
        return 5;
    }
    let ratio: number = 0;
    if (invert) {
        ratio = (maxVal - val) / (maxVal - minVal);
    } else {
        ratio = (val - minVal) / (maxVal - minVal);
    }
    const scaled: number = 10 * ratio;
    return Math.max(0, Math.min(10, scaled));
}

function calculateHeatRatio(token: TokenData): number {
    const volume: number = parseFloat(token.volumeUSD);
    const tvl: number = parseFloat(token.totalValueLockedUSD);
    return tvl > 0 ? volume / tvl : 0;
}

export function dynamicScore(
    token: TokenData,
    swapsData: TokenInfo[],
    goodTraderActions: GoodTraderSwap[],
    ranges: Record<string, ScoringRanges> | ScoringRanges,
    weights: Partial<ScoringWeights> = {}
): ScoreDetails {
    const size: string = token.size || "medium";
    const sizeRanges: ScoringRanges =
        "medium" in ranges
            ? (ranges as Record<string, ScoringRanges>)[size] ||
              (ranges as Record<string, ScoringRanges>)["medium"]
            : (ranges as ScoringRanges);

    const tvl: number = parseFloat(token.totalValueLockedUSD) || 0;
    const vol: number = parseFloat(token.volumeUSD) || 0;
    const heat: number = calculateHeatRatio(token);

    // Calculate scores using new methods
    const tvlScore: number = scaleTo0to10(
        tvl,
        sizeRanges.tvlMin,
        sizeRanges.tvlMax,
        false
    );
    const volumeScore: number = getVolumeScore(vol, size, ranges);
    const heatScore: number = getHeatScore(heat);

    // Get net buys data
    const info: TokenInfo | undefined = swapsData.find(
        (x) =>
            x.contractAddress.toLowerCase() ===
            token.contractAddress.toLowerCase()
    );
    const netBuyScore: number = getNetBuyScore(
        info?.buys || 0,
        info?.sold || 0
    );

    // Get smart money data
    const cutoff: number = Date.now() - 30 * 60 * 1000;
    const smartMoneyBuys: number = goodTraderActions.filter(
        (g) =>
            g.token.address.toLowerCase() ===
                token.contractAddress.toLowerCase() &&
            g.action === "BUY" &&
            g.timestamp > cutoff
    ).length;
    const smartMoneySells: number = goodTraderActions.filter(
        (g) =>
            g.token.address.toLowerCase() ===
                token.contractAddress.toLowerCase() &&
            g.action === "SELL" &&
            g.timestamp > cutoff
    ).length;
    const smartMoneyScore: number = getSmartMoneyScore(
        smartMoneyBuys,
        smartMoneySells
    );

    // Use provided weights or defaults
    const finalWeights: ScoringWeights = { ...DEFAULT_WEIGHTS, ...weights };

    // Calculate final score
    const finalScore: number = Math.round(
        tvlScore * finalWeights.tvl +
            volumeScore * finalWeights.volume +
            netBuyScore * finalWeights.netBuys +
            smartMoneyScore * finalWeights.goodTrader +
            heatScore * finalWeights.heat
    );

    return {
        finalScore,
        breakdown: {
            tvlScore,
            volumeScore,
            netBuyScore,
            goodTraderScore: smartMoneyScore,
            heatScore,
        },
        weightedBreakdown: {
            tvlScore: tvlScore * finalWeights.tvl * 10,
            volumeScore: volumeScore * finalWeights.volume * 10,
            netBuyScore: netBuyScore * finalWeights.netBuys * 10,
            goodTraderScore: smartMoneyScore * finalWeights.goodTrader * 10,
            heatScore: heatScore * finalWeights.heat,
        },
        weights: finalWeights,
        explanation: {
            tvl: `TVL: $${tvl.toFixed(2)} (Score: ${tvlScore.toFixed(1)}/10)`,
            volume: `24h Volume: $${vol.toFixed(
                2
            )} (Score: ${volumeScore.toFixed(1)}/10)`,
            netBuys: `Net Buys (30m): ${netBuyScore}`,
            goodTrader: `Smart Money: ${smartMoneyBuys} buys, ${smartMoneySells} sells`,
            heat: `Heat Ratio: ${heat.toFixed(3)} (Score: ${heatScore.toFixed(
                0
            )})`,
        },
        metrics: {
            tvl,
            volume: vol,
            netBuys: netBuyScore,
            goodTraderDiff: smartMoneyScore,
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
