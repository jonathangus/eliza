import fs from "fs";
import path from "path";

export const graphURL = `https://gateway.thegraph.com/api/${process.env.THE_GRAPH_API_KEY}/subgraphs/id/GqzP4Xaehti8KSfQmv3ZctFSjnSUYZ4En5NRsiTbvZpz`;

type TokenSize = "small" | "medium" | "large";

interface TheGraphTokenData {
    priceUSD: string;
    totalValueLockedUSD: string;
    volumeUSD: string;
    periodStartUnix: string;
    totalValueLocked: string;
    token: {
        id: string;
        name: string;
        symbol: string;
        totalValueLocked: string;
        txCount: string;
        whitelistPools: {
            createdAtTimestamp: string;
            id: string;
        }[];
    };
}

export interface TokenData {
    priceUSD: string;
    totalValueLockedUSD: string;
    volumeUSD: string;
    periodStartUnix: string;
    totalValueLocked: string;
    name: string;
    symbol: string;
    tokenTotalValueLocked: string;
    txCount: string;
    contractAddress: string;
    created: number;
    size: TokenSize;
}

interface SwapData {
    amount0: string;
    amount1: string;
    token0: {
        id: string;
        symbol: string;
    };
    token1: {
        id: string;
        symbol: string;
    };
}

async function fetchTokenData(
    first: number = 100,
    skip: number = 0,
    timestamp: number
): Promise<TheGraphTokenData[]> {
    const query = `
    query {
      tokenHourDatas(
        first: ${first}
        skip: ${skip}
        where: { periodStartUnix: ${timestamp}, volumeUSD_gt: 100}
        orderBy: volumeUSD
        orderDirection: desc
      ) {
        priceUSD
        totalValueLockedUSD
        volumeUSD
        periodStartUnix
        totalValueLocked
        token {
          id
          name
          symbol
          totalValueLocked
          txCount
          whitelistPools {
            createdAtTimestamp
            id
          }
        }
      }
    }
  `;

    const response = await fetch(graphURL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
    });

    const data = await response.json();

    return data.data.tokenHourDatas;
}

async function fetchTokenDataForTimestamp(
    timestamp: number
): Promise<TokenData[] | null> {
    console.log("Fetching data for timestamp:", timestamp);

    // Check cache
    const cacheDir = path.join(process.cwd(), "..", "cache");
    const cacheFile = path.join(cacheDir, `${timestamp}.json`);

    // Create cache directory if it doesn't exist
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Try to read from cache
    if (fs.existsSync(cacheFile)) {
        console.log("Using cached data from", cacheFile);
        const cachedData = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
        return cachedData;
    }

    console.log("Fetching fresh data from API");
    const pageSize = 100;
    const numberOfPages = 3;
    const allData: TheGraphTokenData[] = [];

    for (let i = 0; i < numberOfPages; i++) {
        const pageData = await fetchTokenData(
            pageSize,
            i * pageSize,
            timestamp
        );
        if (pageData.length === 0) break;
        allData.push(...pageData);
    }

    if (allData.length === 0) {
        return null;
    }

    // Process data first without size categorization
    let processedData = allData
        .filter((item) => {
            const { token } = item;
            if (!token.name || !token.symbol) {
                return false;
            }
            const name = token.name.toUpperCase();
            const symbol = token.symbol.toUpperCase();
            return (
                !name.includes("USD") &&
                !name.includes("ETH") &&
                !symbol.includes("USD") &&
                !symbol.includes("ETH")
            );
        })
        .map((item) => {
            const volume = parseFloat(item.volumeUSD);
            const tvl = parseFloat(item.totalValueLockedUSD);

            const created = item.token.whitelistPools.reduce(
                (earliest, pool) => {
                    const timestamp = parseInt(pool.createdAtTimestamp);
                    return timestamp < earliest ? timestamp : earliest;
                },
                Number.MAX_SAFE_INTEGER
            );

            return {
                priceUSD: item.priceUSD,
                totalValueLockedUSD: item.totalValueLockedUSD,
                volumeUSD: item.volumeUSD,
                periodStartUnix: item.periodStartUnix,
                totalValueLocked: item.totalValueLocked,
                name: item.token.name,
                symbol: item.token.symbol,
                tokenTotalValueLocked: item.token.totalValueLocked,
                txCount: item.token.txCount,
                contractAddress: item.token.id,
                created: created === Number.MAX_SAFE_INTEGER ? 0 : created,
                size: "small" as TokenSize, // temporary value
            };
        });

    // Sort by TVL in descending order
    processedData.sort(
        (a, b) =>
            parseFloat(b.totalValueLockedUSD) -
            parseFloat(a.totalValueLockedUSD)
    );

    // Calculate the size boundaries
    const third = Math.floor(processedData.length / 3);
    const twoThirds = third * 2;

    // Assign sizes based on position in sorted array
    const dataWithSizes = processedData.map((item, index) => ({
        ...item,
        size: index < third ? "large" : index < twoThirds ? "medium" : "small",
    }));

    // Sort by heat ratio for final output
    const finalData = dataWithSizes.sort((a, b) => b.heatRatio - a.heatRatio);

    // Write processed data to cache
    if (finalData.length > 0) {
        fs.writeFileSync(cacheFile, JSON.stringify(finalData, null, 2));
        console.log("Wrote processed data to cache:", cacheFile);
    }

    return finalData as TokenData[];
}

export async function fetchAllTokens(): Promise<TokenData[]> {
    // Get the current timestamp and round down to the nearest hour
    const currentTime = Math.floor(Date.now() / 1000);
    const nearestHour = Math.floor(currentTime / 3600) * 3600;

    // Try current hour first
    let result = await fetchTokenDataForTimestamp(nearestHour);

    // If no results, try previous hour
    if (!result) {
        console.log("No data found for current hour, trying previous hour");
        const previousHour = nearestHour - 3600;
        result = await fetchTokenDataForTimestamp(previousHour);

        // If still no results, throw error
        if (!result) {
            throw new Error("No data found for current or previous hour");
        }
    }

    return result;
}

async function fetchSwapsPage(
    timestamp: number,
    first: number = 100,
    skip: number = 0
): Promise<SwapData[]> {
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

    const response = await fetch(graphURL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
    });

    const data = await response.json();
    return data.data.swaps;
}

export async function getSwapsData(): Promise<SwapData[]> {
    // Get current timestamp in seconds
    const currentTime = Math.floor(Date.now() / 1000);
    const currentHour = Math.floor(currentTime / 3600) * 3600;
    const previousHour = currentHour - 3600;

    // Check cache
    const cacheDir = path.join(process.cwd(), "..", "cache");
    const cacheFile = path.join(cacheDir, `swaps_data.json`); // Remove hourly timestamp from filename

    // Create cache directory if it doesn't exist
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Check if cache exists and is less than 1 minute old
    if (fs.existsSync(cacheFile)) {
        const stats = fs.statSync(cacheFile);
        const cacheAge = (Date.now() - stats.mtimeMs) / 1000; // age in seconds

        if (cacheAge < 60) {
            // 1 minute cache
            console.log("Using cached swaps data");
            return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
        }
    }

    console.log("Fetching fresh swaps data");
    const pageSize = 1000;
    const allSwaps: SwapData[] = [];

    let hasMore = true;
    let page = 0;

    while (hasMore) {
        console.log("Fetching page:", page);
        const pageData = await fetchSwapsPage(
            previousHour,
            pageSize,
            page * pageSize
        );

        console.log("PAGE[]", pageData[pageData.length - 1]);
        console.log("PAGE DATA::", pageData.length);

        if (pageData.length === 0) {
            hasMore = false;
        } else {
            allSwaps.push(...pageData);
            page++;
        }
    }

    // Write to cache
    fs.writeFileSync(cacheFile, JSON.stringify(allSwaps, null, 2));
    console.log("Wrote swaps data to cache");

    return allSwaps;
}
