import {
    Address,
    Chain,
    createPublicClient,
    getAddress,
    http,
    parseUnits,
    PublicClient,
    Transport,
} from "viem";
import { base } from "viem/chains";
import { graphURL } from "./utils/token-data";
import goodTraderData from "./utils/trading-wallets.json";
import path from "path";
import fs from "fs";

const goodTraderWallets: Address[] = goodTraderData.map((wallet) =>
    getAddress(wallet.address)
);

const poolAbi = [
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "sender",
                type: "address",
            },
            {
                indexed: true,
                internalType: "address",
                name: "recipient",
                type: "address",
            },
            {
                indexed: false,
                internalType: "int256",
                name: "amount0",
                type: "int256",
            },
            {
                indexed: false,
                internalType: "int256",
                name: "amount1",
                type: "int256",
            },
            {
                indexed: false,
                internalType: "uint160",
                name: "sqrtPriceX96",
                type: "uint160",
            },
            {
                indexed: false,
                internalType: "uint128",
                name: "liquidity",
                type: "uint128",
            },
            {
                indexed: false,
                internalType: "int24",
                name: "tick",
                type: "int24",
            },
        ],
        name: "Swap",
        type: "event",
    },
] as const;

// Define interfaces for the responses and data structures
interface Token {
    id: string;
    symbol: string;
}

interface Pool {
    id: string;
    liquidity: string;
    token0: Token;
    token1: Token;
}

interface FactoryResponse {
    data: {
        factory: {
            poolCount: string;
        };
    };
}

interface PoolsResponse {
    data: {
        pools: Pool[];
    };
}

interface SwapData {
    timestamp: number;
    sender: Address;
    soldToken: {
        address: string;
        symbol: string;
        amount: bigint;
    };
    boughtToken: {
        address: string;
        symbol: string;
        amount: bigint;
    };
}

interface TokenSummary {
    symbol: string;
    address: string;
    totalSold: bigint;
    totalBought: bigint;
    swapCount: number;
    netAmount: bigint;
}

interface SwapResponse {
    amount0: string;
    amount1: string;
    timestamp: string;
    sender: string;
    token0: {
        id: string;
        symbol: string;
        decimals: string;
    };
    token1: {
        id: string;
        symbol: string;
        decimals: string;
    };
}

interface SwapsQueryResponse {
    data: {
        swaps: SwapResponse[];
    };
}

export interface TokenInfo {
    contractAddress: string;
    buys: number;
    sold: number;
    amount: string; // Using string to represent the BigInt amount for easier handling
}

export interface GoodTraderSwap {
    trader: string;
    timestamp: number;
    action: "BUY" | "SELL";
    token: {
        address: string;
        symbol: string;
        amount: string;
    };
}

export class SwapStorer {
    private client: PublicClient<Transport, Chain>;
    private pools: Pool[] = [];
    private unwatch: (() => void) | null = null;
    private swapHistory: Map<string, SwapData[]> = new Map();
    private poolTokens: Map<string, { token0: Token; token1: Token }> =
        new Map();
    private tokenSummaries: Map<string, TokenSummary> = new Map();

    constructor() {
        this.client = createPublicClient({
            chain: base,
            transport: http(),
        }) as any;
    }

    init() {
        try {
            console.log("SWAP STORE INIT..");

            // Try to load cached data first
            this.loadFromCache();

            // Refresh pools and backfill swaps
            // this.refreshPools();
            // this.backfillSwaps();

            // Set up hourly refresh
            setInterval(() => this.refreshPools(), 60 * 60 * 1000);
            console.log("INIT DONE");
        } catch (error) {
            console.error("Error initializing SwapStorer:", error);
        }
    }

    private loadFromCache = () => {
        try {
            const cacheDir = path.join(process.cwd(), "..", "cache");
            const poolsCacheFile = path.join(cacheDir, "pools-cache.json");
            const swapsCacheFile = path.join(cacheDir, "swaps-cache.json");

            // Load pools from cache
            if (fs.existsSync(poolsCacheFile)) {
                console.log("Loading pools from cache...");
                const poolsData = JSON.parse(
                    fs.readFileSync(poolsCacheFile, "utf-8")
                );
                this.pools = poolsData;

                // Rebuild poolTokens map
                for (const pool of this.pools) {
                    this.poolTokens.set(pool.id.toLowerCase(), {
                        token0: pool.token0,
                        token1: pool.token1,
                    });
                }
                console.log(`Loaded ${this.pools.length} pools from cache`);
            }

            // Load swaps from cache
            if (fs.existsSync(swapsCacheFile)) {
                console.log("Loading swaps from cache...");
                const swapsData = JSON.parse(
                    fs.readFileSync(swapsCacheFile, "utf-8")
                );

                // Convert cached string amounts back to BigInt
                for (const swap of swapsData) {
                    const poolId = swap.soldToken.address.toLowerCase();
                    if (!this.swapHistory.has(poolId)) {
                        this.swapHistory.set(poolId, []);
                    }

                    // Convert string amounts back to BigInt
                    const convertedSwap = {
                        ...swap,
                        soldToken: {
                            ...swap.soldToken,
                            amount: BigInt(swap.soldToken.amount),
                        },
                        boughtToken: {
                            ...swap.boughtToken,
                            amount: BigInt(swap.boughtToken.amount),
                        },
                    };

                    this.swapHistory.get(poolId)!.push(convertedSwap);
                }
                console.log(`Loaded swaps from cache`);
            }
        } catch (error) {
            console.error("Error loading from cache:", error);
        }
    };

    prepopulatePools = async () => {
        try {
            const URL = graphURL;
            console.log("Fetching pools data");
            const pageSize = 1000;
            const allPools: Pool[] = [];

            let hasMore = true;
            let page = 0;

            while (hasMore) {
                try {
                    console.log("Fetching pools page:", page);
                    const pageData = await this.fetchPoolsBatch(
                        URL,
                        page * pageSize,
                        pageSize
                    );

                    if (pageData.length === 0) {
                        hasMore = false;
                    } else {
                        allPools.push(...pageData);
                        page++;
                    }

                    if (page > 10) {
                        console.log("Reached maximum page limit");
                        break;
                    }
                } catch (error) {
                    console.error(`Error fetching pools page ${page}:`, error);
                    hasMore = false;
                }
            }

            console.log(`Total pools fetched: ${allPools.length}`);
            this.pools = allPools;

            // Store token information for each pool
            for (const pool of this.pools) {
                try {
                    this.poolTokens.set(pool.id.toLowerCase(), {
                        token0: pool.token0,
                        token1: pool.token1,
                    });
                } catch (error) {
                    console.error(
                        `Error storing pool tokens for ${pool.id}:`,
                        error
                    );
                }
            }

            // Save pools to cache
            try {
                const cacheDir = path.join(process.cwd(), "..", "cache");
                if (!fs.existsSync(cacheDir)) {
                    fs.mkdirSync(cacheDir, { recursive: true });
                }
                const poolsCacheFile = path.join(cacheDir, "pools-cache.json");
                fs.writeFileSync(
                    poolsCacheFile,
                    JSON.stringify(this.pools, null, 2)
                );
            } catch (error) {
                console.error("Error writing pools to cache:", error);
            }
        } catch (error) {
            console.error("Error in prepopulatePools:", error);
            throw error;
        }
    };

    private fetchPoolsBatch = async (
        URL: string,
        skip: number,
        first: number
    ) => {
        try {
            const query = `{
                pools(
                    first: ${first}
                    skip: ${skip}
                    where: { volumeUSD_gt: 1000 }
                    orderBy: volumeUSD
                    orderDirection: desc
                ) {
                    id
                    liquidity
                    token0 {
                        id
                        symbol
                    }
                    token1 {
                        id
                        symbol
                    }
                }
            }`;

            const result = await fetch(URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query }),
            });

            if (!result.ok) {
                throw new Error(`HTTP error! status: ${result.status}`);
            }

            const data = (await result.json()) as PoolsResponse;
            return data.data.pools;
        } catch (error) {
            console.error("Error fetching pools batch:", error);
            return [];
        }
    };

    getPools = () => this.pools;

    refreshPools = async () => {
        try {
            // Clean up old listener
            if (this.unwatch) {
                this.unwatch();
            }

            // Clear old pools and fetch new ones
            this.pools = [];
            await this.prepopulatePools();

            console.log("time to set listener");
            // Create new listener
            await this.createListener();

            // Cleanup old history (keep last 24 hours)
            const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
            for (const [poolId, history] of this.swapHistory) {
                try {
                    this.swapHistory.set(
                        poolId,
                        history.filter((entry) => entry.timestamp > oneDayAgo)
                    );
                } catch (error) {
                    console.error(
                        `Error cleaning history for pool ${poolId}:`,
                        error
                    );
                }
            }
        } catch (error) {
            console.error("Error refreshing pools:", error);
        }
    };

    createListener = async () => {
        const addresses = this.pools.map((pool) => getAddress(pool.id));
        console.log("Listening to addresses", addresses.length);
        this.unwatch = this.client.watchContractEvent({
            address: addresses,
            abi: poolAbi,
            eventName: "Swap",
            onLogs: (logs) => {
                for (const log of logs) {
                    const poolId = log.address.toLowerCase();
                    const poolTokenInfo = this.poolTokens.get(poolId);

                    if (!poolTokenInfo) {
                        console.error(`No token info found for pool ${poolId}`);
                        continue;
                    }

                    // Determine which token was sold and which was bought
                    let soldToken, boughtToken;

                    if (log.args.amount0 < 0n) {
                        // Negative amount0 means token0 was sold
                        soldToken = {
                            address: getAddress(poolTokenInfo.token0.id),
                            symbol: poolTokenInfo.token0.symbol,
                            amount: -log.args.amount0, // Convert negative to positive
                        };
                        boughtToken = {
                            address: getAddress(poolTokenInfo.token1.id),
                            symbol: poolTokenInfo.token1.symbol,
                            amount: log.args.amount1,
                        };
                    } else {
                        // Negative amount1 means token1 was sold
                        soldToken = {
                            address: getAddress(poolTokenInfo.token1.id),
                            symbol: poolTokenInfo.token1.symbol,
                            amount: -log.args.amount1, // Convert negative to positive
                        };
                        boughtToken = {
                            address: getAddress(poolTokenInfo.token0.id),
                            symbol: poolTokenInfo.token0.symbol,
                            amount: log.args.amount0,
                        };
                    }

                    const swapData: SwapData = {
                        timestamp: Date.now(),
                        sender: getAddress(log.args.sender),
                        soldToken,
                        boughtToken,
                    };

                    if (!this.swapHistory.has(poolId)) {
                        this.swapHistory.set(poolId, []);
                    }
                    this.swapHistory.get(poolId)!.push(swapData);
                }
                console.log(`Found ${logs.length} swaps`);
            },
            onError: (error) => {},
        });
    };

    private updateTokenSummaries = () => {
        try {
            // Reset summaries
            this.tokenSummaries.clear();

            // Create cache directory if it doesn't exist
            const cacheDir = path.join(process.cwd(), "..", "cache");
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

            const cacheFile = path.join(cacheDir, "swaps-cache.json");
            const swapsToCache: any[] = [];

            // Process all swap history
            for (const swaps of this.swapHistory.values()) {
                for (const swap of swaps) {
                    try {
                        // Add to cache array
                        swapsToCache.push({
                            ...swap,
                            soldToken: {
                                ...swap.soldToken,
                                amount: String(swap.soldToken.amount),
                            },
                            boughtToken: {
                                ...swap.boughtToken,
                                amount: String(swap.boughtToken.amount),
                            },
                        });

                        // Process sold token
                        this.updateTokenSummary(
                            swap.soldToken.address,
                            swap.soldToken.symbol,
                            swap.soldToken.amount,
                            true
                        );

                        // Process bought token
                        this.updateTokenSummary(
                            swap.boughtToken.address,
                            swap.boughtToken.symbol,
                            swap.boughtToken.amount,
                            false
                        );
                    } catch (error) {
                        console.error("Error processing swap:", error);
                    }
                }
            }

            // Write to cache file
            try {
                fs.writeFileSync(
                    cacheFile,
                    JSON.stringify(swapsToCache, null, 2)
                );
                console.log("Wrote swaps to cache:", cacheFile);
            } catch (error) {
                console.error("Error writing to cache file:", error);
            }
        } catch (error) {
            console.error("Error updating token summaries:", error);
        }
    };

    private updateTokenSummary = (
        address: string,
        symbol: string,
        amount: bigint,
        isSold: boolean
    ) => {
        try {
            // Clear old swap history (keep last hour)
            const oneHourAgo = Date.now() - 60 * 60 * 1000;
            for (const [poolId, swaps] of this.swapHistory.entries()) {
                try {
                    this.swapHistory.set(
                        poolId,
                        swaps.filter((swap) => swap.timestamp > oneHourAgo)
                    );
                } catch (error) {
                    console.error(
                        `Error cleaning history for pool ${poolId}:`,
                        error
                    );
                }
            }

            const summary = this.tokenSummaries.get(address) || {
                symbol,
                address,
                totalSold: 0n,
                totalBought: 0n,
                swapCount: 0,
                netAmount: 0n,
            };

            if (isSold) {
                summary.totalSold += amount;
                summary.netAmount -= amount;
            } else {
                summary.totalBought += amount;
                summary.netAmount += amount;
            }
            summary.swapCount++;

            this.tokenSummaries.set(address, summary);
        } catch (error) {
            console.error(`Error updating token summary for ${symbol}:`, error);
        }
    };

    private logTokenSummaries = () => {
        try {
            console.log("\n=== Token Swap Summaries ===");
            for (const summary of this.tokenSummaries.values()) {
                try {
                    const netDirection =
                        summary.netAmount > 0n ? "NET BUY" : "NET SELL";
                    console.log(`
${summary.symbol} (${summary.address.slice(0, 6)}...):
- Total Bought: ${summary.totalBought.toString()}
- Total Sold: ${summary.totalSold.toString()}
- Net Amount: ${summary.netAmount.toString()} (${netDirection})
- Swap Count: ${summary.swapCount}
                    `);
                } catch (error) {
                    console.error(`Error logging summary for token:`, error);
                }
            }
            console.log("===========================\n");
        } catch (error) {
            console.error("Error logging token summaries:", error);
        }
    };

    // Helper method to get token summaries
    getTokenSummaries = () => {
        return Array.from(this.tokenSummaries.values());
    };

    // Helper method to get swap history for a pool
    getPoolHistory = (poolId: string) => {
        return this.swapHistory.get(poolId.toLowerCase()) || [];
    };

    private backfillSwaps = async () => {
        try {
            console.log("Backfilling swaps from last 30 minutes...");
            const thirtyMinutesAgo = Math.floor(Date.now() / 1000) - 30 * 60;
            const pageSize = 1000;
            let hasMore = true;
            let page = 0;
            let totalSwapsAdded = 0;

            while (hasMore) {
                try {
                    const swaps = await this.fetchSwapsPage(
                        thirtyMinutesAgo,
                        pageSize,
                        page * pageSize
                    );

                    if (swaps.length === 0) {
                        hasMore = false;
                        continue;
                    }

                    console.log(
                        `Processing ${swaps.length} swaps from page ${page}`
                    );
                    let pageSwapsAdded = 0;

                    // Process each swap
                    for (const swap of swaps) {
                        try {
                            // Convert amounts using viem's parseUnits
                            const amount0 = parseUnits(
                                swap.amount0,
                                parseInt(swap.token0.decimals)
                            );
                            const amount1 = parseUnits(
                                swap.amount1,
                                parseInt(swap.token1.decimals)
                            );

                            // Determine which token was sold and which was bought
                            let soldToken, boughtToken;

                            if (amount0 < 0n) {
                                // Negative amount0 means token0 was sold
                                soldToken = {
                                    address: swap.token0.id,
                                    symbol: swap.token0.symbol,
                                    amount: -amount0, // Convert negative to positive
                                };
                                boughtToken = {
                                    address: swap.token1.id,
                                    symbol: swap.token1.symbol,
                                    amount: amount1,
                                };
                            } else {
                                // Negative amount1 means token1 was sold
                                soldToken = {
                                    address: swap.token1.id,
                                    symbol: swap.token1.symbol,
                                    amount: -amount1, // Convert negative to positive
                                };
                                boughtToken = {
                                    address: swap.token0.id,
                                    symbol: swap.token0.symbol,
                                    amount: amount0,
                                };
                            }

                            const swapData: SwapData = {
                                timestamp: parseInt(swap.timestamp) * 1000,
                                sender: getAddress(swap.sender),
                                soldToken,
                                boughtToken,
                            };

                            // Store in swap history using token0's address as pool ID
                            const poolId = swap.token0.id.toLowerCase();
                            if (!this.swapHistory.has(poolId)) {
                                this.swapHistory.set(poolId, []);
                            }
                            this.swapHistory.get(poolId)!.push(swapData);
                            pageSwapsAdded++;
                            totalSwapsAdded++;
                        } catch (error) {
                            console.error(
                                "Error processing historical swap:",
                                error
                            );
                        }
                    }

                    console.log(
                        `Added ${pageSwapsAdded} swaps from page ${page}`
                    );
                    page++;

                    // Safety limit
                    if (page > 10) {
                        console.log(
                            "Reached maximum page limit for historical swaps"
                        );
                        break;
                    }
                } catch (error) {
                    console.error(`Error fetching swaps page ${page}:`, error);
                    hasMore = false;
                }
            }

            console.log(
                `Finished backfilling swaps. Total swaps added: ${totalSwapsAdded}`
            );
            // Update summaries with historical data
            this.updateTokenSummaries();
        } catch (error) {
            console.error("Error in backfillSwaps:", error);
        }
    };

    private fetchSwapsPage = async (
        timestamp: number,
        first: number = 100,
        skip: number = 0
    ): Promise<SwapResponse[]> => {
        try {
            const query = `
            query {
                swaps(
                    first: ${first}
                    skip: ${skip}
                    where: { timestamp_gte: ${timestamp} }
                    orderBy: timestamp
                    orderDirection: desc
                ) {
                    amount0
                    amount1
                    timestamp
                    sender
                    token0 {
                        id
                        symbol
                        decimals
                    }
                    token1 {
                        id
                        symbol
                        decimals
                    }
                }
            }`;

            const response = await fetch(graphURL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ query }),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = (await response.json()) as SwapsQueryResponse;
            return data.data.swaps;
        } catch (error) {
            console.error("Error fetching swaps page:", error);
            return [];
        }
    };

    getInfo = (): TokenInfo[] => {
        try {
            const tokenInfoMap = new Map<string, TokenInfo>();

            // Process all swap history to build token info
            for (const swaps of this.swapHistory.values()) {
                for (const swap of swaps) {
                    // Process sold token (negative amount)
                    const soldTokenInfo = tokenInfoMap.get(
                        swap.soldToken.address
                    ) || {
                        contractAddress: swap.soldToken.address,
                        buys: 0,
                        sold: 0,
                        amount: "0",
                    };
                    soldTokenInfo.sold += 1;
                    // Subtract amount for sells
                    soldTokenInfo.amount = (
                        BigInt(soldTokenInfo.amount) - swap.soldToken.amount
                    ).toString();
                    tokenInfoMap.set(swap.soldToken.address, soldTokenInfo);

                    // Process bought token (positive amount)
                    const boughtTokenInfo = tokenInfoMap.get(
                        swap.boughtToken.address
                    ) || {
                        contractAddress: swap.boughtToken.address,
                        buys: 0,
                        sold: 0,
                        amount: "0",
                    };
                    boughtTokenInfo.buys += 1;
                    // Add amount for buys
                    boughtTokenInfo.amount = (
                        BigInt(boughtTokenInfo.amount) + swap.boughtToken.amount
                    ).toString();
                    tokenInfoMap.set(swap.boughtToken.address, boughtTokenInfo);
                }
            }

            // Convert map to array
            return Array.from(tokenInfoMap.values());
        } catch (error) {
            console.error("Error getting token info:", error);
            return [];
        }
    };

    getGoodTraderActivity = (): GoodTraderSwap[] => {
        try {
            const goodTraderActivity: GoodTraderSwap[] = [];
            const oneHourAgo = Date.now() - 60 * 60 * 1000;

            // Process all swap history
            for (const swaps of this.swapHistory.values()) {
                for (const swap of swaps) {
                    // Skip old swaps
                    if (swap.timestamp < oneHourAgo) continue;

                    // Check if sender is a good trader
                    if (goodTraderWallets.includes(swap.sender)) {
                        // Add sell activity
                        goodTraderActivity.push({
                            trader: swap.sender,
                            timestamp: swap.timestamp,
                            action: "SELL",
                            token: {
                                ...swap.soldToken,
                                amount: String(swap.soldToken.amount),
                            },
                        });

                        // Add buy activity
                        goodTraderActivity.push({
                            trader: swap.sender,
                            timestamp: swap.timestamp,
                            action: "BUY",
                            token: {
                                ...swap.boughtToken,
                                amount: String(swap.boughtToken.amount),
                            },
                        });
                    }
                }
            }

            // Sort by most recent first
            return goodTraderActivity.sort((a, b) => b.timestamp - a.timestamp);
        } catch (error) {
            console.error("Error getting good trader activity:", error);
            return [];
        }
    };
}

export const swapStorer = new SwapStorer();
