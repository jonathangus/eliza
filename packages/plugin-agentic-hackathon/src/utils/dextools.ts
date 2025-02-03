interface TokenInfo {
    imageUrl: string;
    header: string;
    openGraph: string;
    websites: {
        label: string;
        url: string;
    }[];
    socials: {
        type: string;
        url: string;
    }[];
}

export interface BaseToken {
    address: string;
    name: string;
    symbol: string;
}

export interface Transactions {
    m5: {
        buys: number;
        sells: number;
    };
    h1: {
        buys: number;
        sells: number;
    };
    h6: {
        buys: number;
        sells: number;
    };
    h24: {
        buys: number;
        sells: number;
    };
}

export interface Volume {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
}

export interface PriceChange {
    m5?: number;
    h1: number;
    h6: number;
    h24: number;
}

export interface Liquidity {
    usd: number;
    base: number;
    quote: number;
}

export interface Pair {
    chainId: string;
    dexId: string;
    url: string;
    pairAddress: string;
    labels: string[];
    baseToken: BaseToken;
    quoteToken: BaseToken;
    priceNative: string;
    priceUsd: string;
    txns: Transactions;
    volume: Volume;
    priceChange: PriceChange;
    liquidity: Liquidity;
    fdv: number;
    marketCap: number;
    pairCreatedAt: number;
    info: TokenInfo;
    boosts: {
        active: number;
    };
}

export interface DexScreenerResponse {
    schemaVersion: string;
    pairs: Pair[];
}

export async function fetchTokenData(
    tokenAddress: string
): Promise<DexScreenerResponse | null> {
    try {
        const response = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
        );

        if (!response.ok) {
            console.log("response bad in dextools");
            // throw new Error(`HTTP error! status: ${response.status}`);
            return null;
        }

        const data = (await response.json()) as DexScreenerResponse;
        return data;
    } catch (error) {
        console.error("Error fetching token data:", error);
        return null;
    }
}

// Example usage:
// const tokenData = await fetchTokenData("0x23dd3ce6161422622e773e13dac2781c7f990d45");
