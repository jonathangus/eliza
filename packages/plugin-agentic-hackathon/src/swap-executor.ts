import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import { createPublicClient, http, createWalletClient, Address } from "viem";
import { baseSepolia } from "viem/chains";
import { Action, AgentRuntime, State } from "@elizaos/core";
import { fetchSwapParams } from "./utils/paraswap";
import { BuyTokenAction } from "./types";

interface AccountEntry {
    id: string;
    address: string;
    privateKey: string;
    timestamp: string;
    // state: State;
    // buyTokenAction: BuyTokenAction;
    formatedOrder: {
        contractAddress: string;
        decimals: number;
        percentage: string;
    }[];
}

class SwapExecutor {
    private cacheDir: string;
    private accountsPath: string;
    private accounts: Record<string, AccountEntry>;
    runtime: AgentRuntime;

    constructor() {
        // Set up cache directory path relative to token-helper.ts location
        this.cacheDir = path.join(process.cwd(), "..", "cache");

        this.accountsPath = path.join(this.cacheDir, "accounts.json");
        this.accounts = {};
        this.initializeCache();
        this.loadAccounts();
    }

    init = (runtime: AgentRuntime) => {
        this.watchTransfers();
        this.runtime = runtime;
    };

    watchTransfers = () => {
        const client = createPublicClient({
            chain: baseSepolia,
            transport: http(process.env.BASE_RPC_URL!),
        });

        console.log("watch is ready");
        const unwatch = client.watchBlocks({
            includeTransactions: true,
            onBlock: async (block) => {
                const transactions = block.transactions;
                for (const tx of transactions) {
                    if (
                        typeof tx.to === "string" &&
                        typeof tx.from === "string"
                    ) {
                        const acc = this.accounts[tx.to.toLowerCase()];

                        if (acc) {
                            this.executeOrder(acc, tx);
                        }
                    }
                }
            },
            onError: (error) => {
                console.error("Error watching blocks:", error);
            },
        });
    };

    executeOrder = async (acc: AccountEntry, tx) => {
        // try {
        //     // Create wallet instance from private key
        //     const account = privateKeyToAccount(
        //         acc.privateKey as `0x${string}`
        //     );
        //     const amount = BigInt(tx.value);

        //     const calldata = await Promise.all(
        //         acc.buyTokenAction.order.map(async (order) => {

        //             // Get swap parameters using similar logic to frontend
        //             const swapParams = await fetchSwapParams({
        //                 srcToken: "ETH",
        //                 destToken: order.contractAddress,
        //                 destDecimals: acc.state.decimals,
        //                 userAddress: account.address,
        //                 amount: tx.value, // Amount of ETH received
        //             });

        //             console.log("SWAP PARAMS:", swapParams);

        //             return swapParams.txParams;
        //         })
        //     );

        //     // Create wallet client for sending transaction
        //     const client = createWalletClient({
        //         account,
        //         chain: baseSepolia,
        //         transport: http(process.env.BASE_RPC_URL!),
        //     });

        //     // Execute the swap
        //     const hash = await client.sendTransaction({
        //         to: swapParams.txParams.to as `0x${string}`,
        //         data: swapParams.txParams.data as `0x${string}`,
        //         value: BigInt(swapParams.txParams.value || 0),
        //         gasPrice: swapParams.txParams.gasPrice
        //             ? BigInt(swapParams.txParams.gasPrice)
        //             : undefined,
        //     });

        //     console.log("Swap executed:", hash);
        // } catch (error) {
        //     console.error("Error executing swap:", error);
        // }

        console.log("ACC:", acc);
        console.log("tx:", { from: tx.from, amount: tx.value, hash: tx.hash });
    };

    private initializeCache = () => {
        // Create cache directory if it doesn't exist
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        // Create accounts file if it doesn't exist
        if (!fs.existsSync(this.accountsPath)) {
            fs.writeFileSync(this.accountsPath, JSON.stringify({}));
        }
    };

    private loadAccounts = () => {
        // Load existing accounts into memory
        this.accounts = JSON.parse(fs.readFileSync(this.accountsPath, "utf-8"));
    };

    addEntry = ({
        id,
        buyTokenAction,
        state,
        pk,
        owner,
    }: {
        id: string;
        buyTokenAction: BuyTokenAction;
        state: State;
        pk: Address;
        owner: Address;
    }) => {
        const formatedOrder = buyTokenAction.order.map((order) => {
            return {
                contractAddress: order.contractAddress,
                decimals: order.decimals,
                percentage: order.percentage,
            };
        });

        // Create new account entry
        const newAccount: AccountEntry = {
            id,
            address: owner,
            privateKey: pk,
            timestamp: new Date().toISOString(),
            // state,
            formatedOrder,
        };

        // Update in-memory accounts using address as key
        this.accounts[owner.toLowerCase()] = newAccount;

        // Save to file
        fs.writeFileSync(
            this.accountsPath,
            JSON.stringify(this.accounts, null, 2)
        );

        console.log("ADDRESSSS TO SEND TO:::", owner);
    };
}

export const swapExecutor = new SwapExecutor();
