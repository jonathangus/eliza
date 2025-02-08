import fs from "fs";
import path from "path";
import {
    fetchTokenData as fetchDexTokenData,
    DexScreenerResponse,
    DexTokenInfo,
} from "./utils/dextools";
import { fetchAllTokens, TokenData } from "./utils/token-data";
import { swapStorer } from "./swap-storer";
import {
    enhancedDynamicScore,
    buildScoringRanges,
    ScoringWeights,
    TimeWeightedMetrics,
    MarketContext,
    TransactionMetrics,
} from "./utils/token-valuation";

interface CachedDexData {
    timestamp: number;
    address: string;
    data: DexScreenerResponse;
}

interface CachedGraphData {
    timestamp: number;
    data: TokenData[];
}

type Risk = "LOW" | "MID" | "HIGH";

interface EnrichedTokenData extends TokenData {
    risk: Risk;
    finalScoreValue: number;
    scoreDetails: {
        breakdown: Record<string, number>;
        weightedBreakdown: Record<string, number>;
        weights: ScoringWeights;
        explanation: Record<string, string>;
        metrics: Record<string, number>;
    };
    enhancedMetrics: {
        timeWeighted: TimeWeightedMetrics;
        smartMoneyMomentum: number;
        liquidityHealth: {
            concentration: number;
            stability: number;
            depth: number;
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
        };
        riskAdjusted: number;
        marketContext: MarketContext;
        transactionMetrics: TransactionMetrics;
        socialMetrics: {
            websiteCount: number;
            socialCount: number;
            hasImage: boolean;
        };
    };
    dexTools?: DexScreenerResponse;
}

class OnchainDataStorer {
    private readonly cacheDir: string;
    private readonly dexCacheFile: string;
    private readonly graphCacheFile: string;
    private readonly dexCache: Map<string, CachedDexData>;
    private readonly pendingRequests: Map<
        string,
        Promise<DexScreenerResponse | null>
    >;
    private graphCache: CachedGraphData | null;
    private allTokens: TokenData[];
    private enrichedTokens: EnrichedTokenData[];
    private isInitialized: boolean;
    private refreshInterval: NodeJS.Timeout | null;
    private graphRefreshInterval: NodeJS.Timeout | null;
    private stateUpdateInterval: NodeJS.Timeout | null;

    constructor() {
        this.cacheDir = path.join(process.cwd(), "..", "cache");
        this.dexCacheFile = path.join(this.cacheDir, "dex-cache.json");
        this.graphCacheFile = path.join(this.cacheDir, "graph-cache.json");
        this.dexCache = new Map();
        this.pendingRequests = new Map();
        this.graphCache = null;
        this.allTokens = [];
        this.enrichedTokens = [];
        this.isInitialized = false;
        this.refreshInterval = null;
        this.graphRefreshInterval = null;
        this.stateUpdateInterval = null;

        // Create cache directory and files if they don't exist
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        if (!fs.existsSync(this.dexCacheFile)) {
            fs.writeFileSync(this.dexCacheFile, JSON.stringify({}));
        }
        if (!fs.existsSync(this.graphCacheFile)) {
            fs.writeFileSync(this.graphCacheFile, JSON.stringify(null));
        }
    }

    private async loadCacheFromDisk(): Promise<void> {
        try {
            // Load DEX cache
            const dexCacheData = JSON.parse(
                fs.readFileSync(this.dexCacheFile, "utf-8")
            );
            for (const [key, value] of Object.entries<CachedDexData>(
                dexCacheData
            )) {
                this.dexCache.set(key, value);
            }

            // Load Graph cache
            const graphCacheData = JSON.parse(
                fs.readFileSync(this.graphCacheFile, "utf-8")
            );
            if (graphCacheData) {
                this.graphCache = graphCacheData as CachedGraphData;
                this.allTokens = this.graphCache.data;
            }
        } catch (error) {
            console.error("Error loading cache from disk:", error);
        }
    }

    private saveCacheToDisk(): void {
        try {
            // Save DEX cache
            const dexCacheObj = Object.fromEntries(this.dexCache);
            fs.writeFileSync(
                this.dexCacheFile,
                JSON.stringify(dexCacheObj, null, 2)
            );

            // Save Graph cache
            fs.writeFileSync(
                this.graphCacheFile,
                JSON.stringify(this.graphCache, null, 2)
            );
        } catch (error) {
            console.error("Error saving cache to disk:", error);
        }
    }

    init = async (): Promise<void> => {
        if (this.isInitialized) {
            console.log("OnchainDataStorer already initialized");
            return;
        }

        try {
            console.log("Initializing OnchainDataStorer...");

            // Load state from cache
            await this.loadCacheFromDisk();

            // First, ensure we have all graph data
            await this.backfillGraphData();

            // Then update top state to identify important tokens
            await this.updateTopState();

            // Now backfill DEX data only for top tokens
            await this.backfillDexData();

            // Set up periodic refreshes
            this.refreshInterval = setInterval(() => {
                void this.refreshDexData();
            }, 5 * 60 * 1000);

            // Calculate time until next hour + 4 minutes
            const now = new Date();
            const nextHour = new Date(now);
            nextHour.setHours(nextHour.getHours() + 1, 4, 0, 0);
            const delay = nextHour.getTime() - now.getTime();

            // Schedule next graph data update
            setTimeout(() => {
                void this.backfillGraphData();
                this.graphRefreshInterval = setInterval(() => {
                    void this.backfillGraphData();
                }, 60 * 60 * 1000);
            }, delay);

            // Update state every 5 minutes
            this.stateUpdateInterval = setInterval(() => {
                void this.updateTopState();
            }, 5 * 60 * 1000);

            this.isInitialized = true;
            console.log("OnchainDataStorer initialized successfully");
        } catch (error) {
            console.error("Error initializing OnchainDataStorer:", error);
            throw error;
        }
    };

    private backfillGraphData = async () => {
        console.log("Backfilling Graph data...");
        try {
            if (
                !this.graphCache ||
                Date.now() - this.graphCache.timestamp > 60 * 60 * 1000
            ) {
                const tokens = await fetchAllTokens();
                if (tokens && tokens.length > 0) {
                    this.allTokens = tokens;
                    this.graphCache = {
                        timestamp: Date.now(),
                        data: tokens,
                    };
                    await this.saveCacheToDisk();
                    console.log("Graph data backfilled successfully");
                } else {
                    console.warn("No tokens returned from fetchAllTokens");
                    // Use existing data if available
                    if (this.graphCache) {
                        console.log("Using existing cached data");
                        this.allTokens = this.graphCache.data;
                    }
                }
            } else {
                console.log("Using cached Graph data");
                this.allTokens = this.graphCache.data;
            }
        } catch (error) {
            console.error("Error backfilling Graph data:", error);
            // Use existing data if available instead of throwing
            if (this.graphCache) {
                console.log("Using existing cached data after error");
                this.allTokens = this.graphCache.data;
            }
        }
    };

    private backfillDexData = async () => {
        console.log("Backfilling Dex data...");
        try {
            const tokens = this.enrichedTokens;
            const now = Date.now();

            for (const token of tokens) {
                try {
                    // Skip if we have recent cache
                    const cachedData = this.dexCache.get(
                        token.contractAddress.toLowerCase()
                    );
                    if (
                        cachedData &&
                        now - cachedData.timestamp < 5 * 60 * 1000
                    ) {
                        console.log(
                            `Using cached DEX data for ${token.symbol}`
                        );
                        continue;
                    }

                    console.log(`Fetching DEX data for ${token.symbol}`);
                    const data = await fetchDexTokenData(token.contractAddress);
                    if (data) {
                        this.dexCache.set(token.contractAddress.toLowerCase(), {
                            timestamp: now,
                            address: token.contractAddress,
                            data,
                        });
                    }

                    // Add a small delay between requests to avoid rate limiting
                    await new Promise((resolve) => setTimeout(resolve, 500));
                } catch (error) {
                    console.error(
                        `Error backfilling DEX data for token ${token.contractAddress}:`,
                        error
                    );
                    continue; // Continue with next token if one fails
                }
            }

            await this.saveCacheToDisk();
            console.log("Dex data backfill completed");
        } catch (error) {
            console.error("Error in backfillDexData:", error);
            // Continue execution, don't throw
        }
    };

    private refreshDexData = async () => {
        console.log("Refreshing Dex data...");
        try {
            // Only refresh DEX data for enriched tokens
            const tokens = this.enrichedTokens;
            const now = Date.now();
            const maxAge = 30 * 60 * 1000; // 30 minutes

            // Clean old cache entries
            for (const [address, cachedData] of this.dexCache) {
                if (now - cachedData.timestamp > maxAge) {
                    this.dexCache.delete(address);
                }
            }

            // Refresh data for top tokens
            for (const token of tokens) {
                try {
                    // Skip if we have recent cache
                    const cachedData = this.dexCache.get(
                        token.contractAddress.toLowerCase()
                    );
                    if (
                        cachedData &&
                        now - cachedData.timestamp < 5 * 60 * 1000
                    ) {
                        continue;
                    }

                    const data = await fetchDexTokenData(token.contractAddress);
                    if (data) {
                        this.dexCache.set(token.contractAddress.toLowerCase(), {
                            timestamp: now,
                            address: token.contractAddress,
                            data,
                        });
                    }
                } catch (error) {
                    console.error(
                        `Error refreshing DEX data for token ${token.contractAddress}:`,
                        error
                    );
                }
            }

            await this.saveCacheToDisk();
            console.log("Dex data refresh completed");
        } catch (error) {
            console.error("Error in refreshDexData:", error);
        }
    };

    private getRisk(size: string): Risk {
        if (size === "large") return "LOW";
        if (size === "small") return "HIGH";
        return "MID";
    }

    updateTopState = () => {
        console.log("Updating top state...");
        try {
            // Use cached tokens instead of fetching
            const tokens = this.allTokens;
            const swapsData = swapStorer.getInfo();
            const goodTraderActions = swapStorer.getGoodTraderActivity();
            const ranges = buildScoringRanges(
                tokens,
                swapsData,
                goodTraderActions
            );

            const enriched: EnrichedTokenData[] = [];

            // Process each token using cached data
            for (const token of tokens) {
                try {
                    // Use cached DEX data
                    const dexData =
                        this.dexCache.get(token.contractAddress.toLowerCase())
                            ?.data || null;

                    // Calculate final score
                    const finalScore = enhancedDynamicScore(
                        token,
                        swapsData,
                        goodTraderActions,
                        ranges,
                        dexData
                    );

                    const risk = this.getRisk(token.size);

                    enriched.push({
                        ...token,
                        risk,
                        finalScoreValue: finalScore.finalScore,
                        scoreDetails: {
                            breakdown: finalScore.breakdown,
                            weightedBreakdown: finalScore.weightedBreakdown,
                            weights: finalScore.weights,
                            explanation: finalScore.explanation,
                            metrics: finalScore.metrics,
                        },
                        enhancedMetrics: {
                            timeWeighted: finalScore.timeWeighted,
                            smartMoneyMomentum: finalScore.smartMoneyMomentum,
                            liquidityHealth: finalScore.liquidityHealth,
                            riskAdjusted: finalScore.riskAdjusted,
                            marketContext: finalScore.marketContext,
                            transactionMetrics: finalScore.transactionMetrics,
                            socialMetrics: finalScore.socialMetrics,
                        },
                        dexTools: dexData,
                    });
                } catch (error) {
                    console.error(
                        `Error processing token ${token.contractAddress}:`,
                        error
                    );
                }
            }

            console.log("ALL TOKENS LENGHT:", this.allTokens.length);
            console.log("ENRICHED LENGTH", this.enrichedTokens.length);

            // Sort by final score and take top 30
            this.enrichedTokens = enriched
                .sort((a, b) => b.finalScoreValue - a.finalScoreValue)
                .slice(0, 30);

            console.log("Top state updated successfully");
        } catch (error) {
            console.error("Error updating top state:", error);
        }
    };

    getTokensByRisk = (
        risk: Risk
    ): Array<{ token: EnrichedTokenData; percentage: number }> => {
        const ignoreTokens = ["USD", "BTC", "ETH", "Stable", "DAI"];
        console.log("risk", risk);

        const tokens = this.enrichedTokens
            .filter((token) => token.risk === risk)
            .filter(
                (token) =>
                    !ignoreTokens.some((ignore) =>
                        token.name.toLowerCase().includes(ignore.toLowerCase())
                    )
            )
            .sort((a, b) => b.finalScoreValue - a.finalScoreValue);

        // Calculate total score for percentage calculation
        const totalScore = tokens.reduce(
            (sum, token) => sum + token.finalScoreValue,
            0
        );

        // Remove sensitive info from dexTools data and calculate percentage
        return tokens.map((tok) => ({
            token: {
                ...tok,
                dexTools: tok.dexTools
                    ? {
                          ...tok.dexTools,
                          pairs: tok.dexTools.pairs.map((pair) => ({
                              ...pair,
                              info: undefined,
                          })),
                      }
                    : undefined,
            },
            percentage: totalScore ? tok.finalScoreValue / totalScore : 0,
        }));
    };

    getInfoFromContractAddress = (
        contractAddress: string
    ): DexTokenInfo | null => {
        const token = this.enrichedTokens.find(
            (token) =>
                token.contractAddress.toLowerCase() ===
                contractAddress.toLowerCase()
        );

        if (!token?.dexTools?.pairs?.[0]?.info) {
            return null;
        }

        // Return just the token info from the first pair
        return token.dexTools.pairs[0].info;
    };

    // Public methods to fetch data
    fetchDexTokenData = async (
        tokenAddress: string
    ): Promise<DexScreenerResponse | null> => {
        const normalizedAddress = tokenAddress.toLowerCase();
        const cachedData = this.dexCache.get(normalizedAddress);
        const now = Date.now();

        // Return cached data if it's less than 5 minutes old
        if (cachedData && now - cachedData.timestamp < 5 * 60 * 1000) {
            return cachedData.data;
        }

        // Check if there's already a pending request for this token
        const pendingRequest = this.pendingRequests.get(normalizedAddress);
        if (pendingRequest) {
            console.log(
                `Request already pending for ${tokenAddress}, waiting for result`
            );
            return pendingRequest;
        }

        try {
            // Create the request promise
            const requestPromise = (async () => {
                // Add delay to avoid rate limiting
                await new Promise((resolve) => setTimeout(resolve, 500));

                const data = await fetchDexTokenData(tokenAddress);
                if (data) {
                    this.dexCache.set(normalizedAddress, {
                        timestamp: now,
                        address: tokenAddress,
                        data,
                    });
                    await this.saveCacheToDisk();
                }
                return data;
            })();

            // Store the promise in pending requests
            this.pendingRequests.set(normalizedAddress, requestPromise);

            // Wait for the result
            const result = await requestPromise;

            // Clean up after request is complete
            this.pendingRequests.delete(normalizedAddress);

            return result;
        } catch (error) {
            // Clean up on error
            this.pendingRequests.delete(normalizedAddress);
            console.error(
                `Error fetching DEX data for token ${tokenAddress}:`,
                error
            );
            return null;
        }
    };

    fetchAllTokens = async (): Promise<TokenData[]> => {
        if (
            !this.graphCache ||
            Date.now() - this.graphCache.timestamp > 60 * 60 * 1000
        ) {
            await this.backfillGraphData();
        }
        return this.allTokens;
    };

    // Cleanup method
    cleanup = (): void => {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        if (this.graphRefreshInterval) {
            clearInterval(this.graphRefreshInterval);
            this.graphRefreshInterval = null;
        }
        if (this.stateUpdateInterval) {
            clearInterval(this.stateUpdateInterval);
            this.stateUpdateInterval = null;
        }
        // Clear pending requests
        this.pendingRequests.clear();
    };
}

export const onChainDataStorer = new OnchainDataStorer();
