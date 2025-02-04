import { Address } from "viem";
import { base } from "viem/chains";

interface SwapParams {
    srcToken: string;
    destToken: string;
    destDecimals: number;
    userAddress: Address;
    amount: bigint;
    enabled?: boolean;
}

export interface SwapResponse {
    priceRoute: {
        blockNumber: number;
        network: number;
        srcToken: string;
        srcDecimals: number;
        srcAmount: string;
        destToken: string;
        destDecimals: number;
        destAmount: string;
        bestRoute: Array<{
            percent: number;
            swaps: Array<{
                srcToken: string;
                srcDecimals: number;
                destToken: string;
                destDecimals: number;
                swapExchanges: Array<{
                    exchange: string;
                    srcAmount: string;
                    destAmount: string;
                    percent: number;
                    poolAddresses: string[];
                    data: {
                        path: Array<{
                            tokenIn: string;
                            tokenOut: string;
                            fee: string;
                            currentFee: string;
                        }>;
                        gasUSD: string;
                    };
                }>;
            }>;
        }>;
        gasCostUSD: string;
        gasCost: string;
        side: string;
        version: string;
        contractAddress: string;
        tokenTransferProxy: string;
        contractMethod: string;
        partnerFee: number;
        srcUSD: string;
        destUSD: string;
        partner: string;
        maxImpactReached: boolean;
        hmac: string;
    };
    txParams: {
        from: string;
        to: string;
        value: string;
        data: string;
        gasPrice: string;
        chainId: number;
    };
}

export async function fetchSwapParams({
    srcToken,
    destToken,
    destDecimals,
    userAddress,
    amount,
}: Omit<SwapParams, "enabled">) {
    const params = new URLSearchParams({
        network: String(base.id),
        srcToken,
        destToken,
        destDecimals: destDecimals.toString(),
        userAddress,
        amount: String(amount),
        side: "SELL",
        slippage: "250",
    });

    const response = await fetch(`https://api.paraswap.io/swap?${params}`);
    if (!response.ok) {
        throw new Error("Failed to fetch swap parameters");
    }
    return response.json() as Promise<SwapResponse>;
}
