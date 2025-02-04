import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import {
    createPublicClient,
    http,
    createWalletClient,
    Address,
    parseEther,
    formatEther,
    parseUnits,
    decodeFunctionData,
    FormattedTransaction,
    createClient,
} from "viem";
import { base } from "viem/chains";
import { Action, AgentRuntime, State } from "@elizaos/core";
import { fetchSwapParams } from "./utils/paraswap";
import { BuyTokenAction } from "./types";
import { eip5792Actions } from "viem/experimental";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { entryPointAbi } from "./abi/entry-point";
import { coinbaseSmartAccountAbi } from "./abi/coinbase-smart-account";

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
        name: string;
    }[];
}

const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL!),
});

interface AATransfer {
    target: Address;
    value: bigint;
}

const getAATransfer = (
    tx: FormattedTransaction<typeof base, any>
): AATransfer | null => {
    let decodedEntryPoint;

    // Try to decode the entry point transaction
    try {
        decodedEntryPoint = decodeFunctionData({
            abi: entryPointAbi,
            data: tx.input,
        });
    } catch (error) {
        console.error("Failed to decode entry point transaction:", error);
        return null;
    }

    // Loop through entry point args
    try {
        for (let i = 0; i < decodedEntryPoint.args.length; i++) {
            const arg = decodedEntryPoint.args[i];

            // Check if arg is an array containing user operations
            if (
                !Array.isArray(arg) ||
                arg.length === 0 ||
                !("callData" in arg[0])
            ) {
                continue;
            }

            // Process each user operation
            for (const userOp of arg) {
                if (!userOp.callData) continue;

                // Try to decode the call data
                let decodedCallData;
                try {
                    decodedCallData = decodeFunctionData({
                        abi: coinbaseSmartAccountAbi,
                        data: userOp.callData,
                    });
                } catch (error) {
                    console.error("Failed to decode call data:", error);
                    continue;
                }

                // Loop through call data args
                try {
                    for (let j = 0; j < decodedCallData.args.length; j++) {
                        const calls = decodedCallData.args[j];

                        // Check if we have valid calls array
                        if (!Array.isArray(calls) || calls.length === 0) {
                            continue;
                        }

                        // Check first call for target/to and value
                        const firstCall = calls[0];
                        if (firstCall && (firstCall.target || firstCall.to)) {
                            return {
                                target: (firstCall.target ||
                                    firstCall.to) as Address,
                                value: BigInt(firstCall.value || 0),
                            };
                        }
                    }
                } catch (error) {
                    console.error("Failed to process call data args:", error);
                    continue;
                }
            }
        }
    } catch (error) {
        console.error("Failed to process entry point args:", error);
        return null;
    }

    return null;
};

interface Transaction {
    from: string;
    to: string;
    value: bigint;
    hash: string;
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

    watchTransfers = async () => {
        console.log("watch is ready");

        const goooodtx = await publicClient.getTransaction({
            hash: "0x943cb3e54e33afcfdf3974de8583707f1e2c31cd95310de6a5be1a2825165397",
        });

        const res = getAATransfer(goooodtx);

        if (res) {
            console.log("res", res);
            const acc = this.accounts[res.target.toLowerCase()];
            console.log("acc", acc);
            if (acc) {
                console.log("execute that shit");
                this.executeOrder(acc, {
                    from: goooodtx.from,
                    to: res.target,
                    value: res.value,
                    hash: goooodtx.hash,
                });
            }
        }

        if (res.target) console.log(res);
        const unwatch = publicClient.watchBlocks({
            includeTransactions: true,
            blockTag: "latest",
            onBlock: async (block) => {
                const transactions = block.transactions;
                for (const tx of transactions) {
                    if (
                        typeof tx.to === "string" &&
                        typeof tx.from === "string"
                    ) {
                        const acc = this.accounts[tx.to.toLowerCase()];

                        if (acc) {
                            const transfer = getAATransfer(tx);
                            if (transfer) {
                                // Use transfer.target and transfer.value instead of tx properties
                                this.executeOrder(acc, {
                                    ...tx,
                                    to: transfer.target,
                                    value: transfer.value,
                                });
                            } else {
                                // Fall back to original tx data if AA transfer detection fails
                                this.executeOrder(acc, tx);
                            }
                        }
                    }
                }
            },
            onError: (error) => {
                console.error("Error watching blocks:", error);
            },
        });
    };

    executeOrder = async (acc: AccountEntry, tx: Transaction) => {
        try {
            const pkAccount = privateKeyToAccount(
                acc.privateKey as `0x${string}`
            );

            const client = createClient({
                chain: base,
                account: pkAccount,
                transport: http(),
            });

            const account = await toCoinbaseSmartAccount({
                owners: [pkAccount],
                client: client,
            });

            const amount = tx.value;
            console.info(
                `Processing transaction for account: ${acc.address}, Amount: ${amount}`
            );

            const calls = await Promise.all(
                acc.formatedOrder.map(async (order) => {
                    const weiValue =
                        (amount *
                            BigInt(
                                Math.floor(parseFloat(order.percentage) * 100)
                            )) /
                        BigInt(100);
                    const ethAmount = formatEther(weiValue);
                    const orderAmount = parseUnits(ethAmount, order.decimals);

                    console.info(
                        `Preparing to buy ${order.name} for ${weiValue} wei`
                    );
                    const swapParams = await fetchSwapParams({
                        srcToken: "ETH",
                        destToken: order.contractAddress,
                        destDecimals: order.decimals,
                        receiver: acc.address as Address,
                        userAddress: account.address as Address,
                        amount: orderAmount,
                    });

                    console.debug("Swap parameters obtained:", swapParams);

                    return {
                        gasPrice: swapParams.txParams.gasPrice,
                        to: swapParams.txParams.to as Address,
                        data: swapParams.txParams.data as `0x${string}`,
                        value: BigInt(swapParams.txParams.value || 0),
                    };
                })
            );

            console.debug("Compiled call data for transactions:", calls);

            const walletClient = createWalletClient({
                account,
                chain: base,
                transport: http(),
                // transport: http(process.env.BASE_RPC_URL!),
            }).extend(eip5792Actions());

            const id = await walletClient.sendCalls({
                chain: base,
                account: account.address as Address,
                calls,
                capabilities: {
                    paymasterService: {
                        url: process.env.BASE_PAYMASTER_URL!,
                    },
                },
            });
            console.info(`Transaction calls sent, ID: ${id}`);
            const status = await walletClient.showCallsStatus({
                id,
            });
            console.info(
                "Transaction status:",
                JSON.stringify(status, null, 2)
            );
        } catch (error) {
            console.error("Error executing swap:", error);
            this.sendBackEth(acc, BigInt(tx.value));
        }

        console.info("Transaction details:", {
            from: tx.from,
            amount: tx.value,
            hash: tx.hash,
        });
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

    sendBackEth = async (acc: AccountEntry, amount: bigint) => {
        return;
        try {
            const pkAccount = privateKeyToAccount(
                acc.privateKey as `0x${string}`
            );

            const client = createPublicClient({
                chain: base,
                transport: http(),
            });

            const account = await toCoinbaseSmartAccount({
                client: client,
                owners: [pkAccount],
            } as any);

            const walletClient = createWalletClient({
                account,
                chain: base,
                transport: http(process.env.BASE_RPC_URL!),
            }).extend(eip5792Actions());

            const transaction = await walletClient.sendTransaction({
                chain: base,
                account: account,
                to: acc.address as Address,
                value: amount,
                kzg: undefined,
                capabilities: {
                    paymasterService: {
                        url: process.env.BASE_PAYMASTER_URL!,
                    },
                },
            });

            console.info(
                `ETH successfully sent back to user: ${acc.address}, Transaction: ${transaction}`
            );
        } catch (error) {
            console.error("Error sending back ETH:", error);
        }
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
                name: order.name,
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
