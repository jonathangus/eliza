import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import {
    createPublicClient,
    http,
    Address,
    formatEther,
    parseUnits,
    decodeFunctionData,
    FormattedTransaction,
    createClient,
    webSocket,
} from "viem";
import { base } from "viem/chains";
import { Action, AgentRuntime, State } from "@elizaos/core";
import { fetchSwapParams } from "./utils/paraswap";
import { BuyTokenAction } from "./types";
import {
    createPaymasterClient,
    createBundlerClient,
    toCoinbaseSmartAccount,
} from "viem/account-abstraction";
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

interface AATransfer {
    target: Address;
    value: bigint;
    sender: Address;
}

const getAATransfer = (
    tx: FormattedTransaction<typeof base, any>
): AATransfer[] => {
    let decodedEntryPoint;
    const transfers: AATransfer[] = [];

    // Try to decode the entry point transaction
    try {
        decodedEntryPoint = decodeFunctionData({
            abi: entryPointAbi,
            data: tx.input,
        });
    } catch (error) {
        return [];
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
                if (!userOp.callData || !userOp.sender) continue;

                // Try to decode the call data
                let decodedCallData;
                try {
                    decodedCallData = decodeFunctionData({
                        abi: coinbaseSmartAccountAbi,
                        data: userOp.callData,
                    });
                } catch (error) {
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

                        // Process all calls in the array
                        for (const call of calls) {
                            if (call && (call.target || call.to)) {
                                transfers.push({
                                    target: (call.target || call.to) as Address,
                                    value: BigInt(call.value || 0),
                                    sender: userOp.sender as Address,
                                });
                            }
                        }
                    }
                } catch (error) {
                    continue;
                }
            }
        }
    } catch (error) {
        return [];
    }

    return transfers;
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
        const websocketPublicClient = createPublicClient({
            chain: base,
            transport: webSocket(
                `wss://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`!
            ),
        });

        const unwatch = websocketPublicClient.watchBlocks({
            includeTransactions: true,
            blockTag: "latest",
            emitMissed: true,
            onBlock: async (block) => {
                if (block) {
                    const transactions = block.transactions || [];
                    for (const tx of transactions) {
                        const aaTransfer = getAATransfer(tx);

                        if (aaTransfer.length > 0) {
                            const acc =
                                this.accounts[
                                    aaTransfer[0].target.toLowerCase()
                                ];

                            if (acc) {
                                console.log(
                                    "AA transfers are to one of our vaults. Execute trades"
                                );
                                for (const t of aaTransfer) {
                                    this.executeOrder(acc, {
                                        ...tx,
                                        to: t.target,
                                        value: t.value,
                                    });
                                }
                            }
                        } else if (
                            typeof tx.to === "string" &&
                            typeof tx.from === "string"
                        ) {
                            const acc = this.accounts[tx.to.toLowerCase()];

                            if (acc) {
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

    private getBundlerClientFromAcc = async (acc: AccountEntry) => {
        const owner = privateKeyToAccount(acc.privateKey as `0x${string}`);

        const client = createClient({
            chain: base,
            transport: http(),
            account: owner,
        });

        const account = await toCoinbaseSmartAccount({
            client,
            owners: [owner],
        });

        const paymasterClient = createPaymasterClient({
            transport: http(process.env.BASE_PAYMASTER_URL!),
        });

        const bundlerClient = createBundlerClient({
            account,
            client,
            paymaster: paymasterClient,
            transport: http(process.env.BASE_PAYMASTER_URL),
        });

        return { bundlerClient, account };
    };

    executeOrder = async (acc: AccountEntry, tx: Transaction) => {
        try {
            const { bundlerClient, account } =
                await this.getBundlerClientFromAcc(acc);
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
            if (!account) {
                throw new Error("Account not found");
            }

            const op = bundlerClient.sendUserOperation as any;
            const hash = await op({
                account,
                calls,
            });

            console.log("Tx done: ", hash);
            const receipt = await bundlerClient.waitForUserOperationReceipt({
                hash,
            });

            console.log(receipt);
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
        try {
            const { bundlerClient, account } =
                await this.getBundlerClientFromAcc(acc);

            const calls = [
                {
                    to: acc.address as Address,
                    value: amount,
                    data: "0x",
                },
            ];

            const op = bundlerClient.sendUserOperation as any;
            const hash = await op({
                account,
                calls,
            });

            console.log(hash);
            const receipt = await bundlerClient.waitForUserOperationReceipt({
                hash,
            });

            console.info(
                `ETH successfully sent back to user: ${acc.address}, Transaction: ${receipt.receipt.transactionHash}`
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
