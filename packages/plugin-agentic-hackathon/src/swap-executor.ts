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
    getAddress,
} from "viem";
import { base } from "viem/chains";
import {
    Action,
    AgentRuntime,
    ExecutorTransaction,
    State,
    TokenExecutor,
} from "@elizaos/core";
import { fetchSwapParams } from "./utils/paraswap";
import { BuyTokenAction } from "./types";
import {
    createPaymasterClient,
    createBundlerClient,
    toCoinbaseSmartAccount,
} from "viem/account-abstraction";
import { entryPointAbi } from "./abi/entry-point";
import { coinbaseSmartAccountAbi } from "./abi/coinbase-smart-account";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

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
const BASE_ENTRY_POINT = "0xbdBeBD58cC8153Ce74530BB342427579315915B2";

const publicClient = createPublicClient({
    chain: base,
    transport: http(),
});
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
                                    sender: call.sender as Address,
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
                try {
                    if (block) {
                        const transactions = block.transactions || [];
                        for (const tx of transactions) {
                            if (
                                tx.to?.toLowerCase() ===
                                BASE_ENTRY_POINT.toLowerCase()
                            ) {
                                const aaTransfer = getAATransfer(tx);

                                if (aaTransfer.length > 0) {
                                    for (const t of aaTransfer) {
                                        const updatedTx =
                                            await publicClient.getTransaction({
                                                hash: tx.hash,
                                            });

                                        const wantedTx =
                                            getAATransfer(updatedTx);
                                        if (wantedTx.length > 0) {
                                            for (const tt of aaTransfer) {
                                                const acc =
                                                    this.accounts[
                                                        t.target.toLowerCase()
                                                    ];
                                                if (acc) {
                                                    console.log(
                                                        "AA transfer to vault detected. Executing trade",
                                                        tx
                                                    );

                                                    this.executeOrder(acc, {
                                                        ...updatedTx,
                                                        to: tt.target,
                                                        from: tt.sender,
                                                        value: tt.value,
                                                    });
                                                }
                                            }
                                        }
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
                } catch (e) {
                    console.error("watchBlocks error", e);
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
            console.log("executeOrder TX:", tx);
            const { bundlerClient, account } =
                await this.getBundlerClientFromAcc(acc);
            const amount = tx.value;
            console.info(
                `Processing transaction for account: ${acc.address}, Amount: ${amount}`
            );

            const preparedCalls = acc.formatedOrder.map((order) => {
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

                return {
                    srcToken: "ETH",
                    destToken: order.contractAddress,
                    destDecimals: order.decimals,
                    receiver: tx.from as Address,
                    userAddress: account.address as Address,
                    amount: String(orderAmount),
                };
            });

            const calls = await Promise.all(
                preparedCalls.map(async (preparedCall) => {
                    const swapParams = await fetchSwapParams({
                        ...preparedCall,
                        amount: BigInt(preparedCall.amount),
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

            const executor = (await redis.get(
                `${getAddress(acc.address)}-executor`
            )) as TokenExecutor;
            const executorTx: ExecutorTransaction = {
                hash,
                data: preparedCalls,
                receiver: tx.from,
                amount: String(tx.value),
            };
            executor.txs = [...executor.txs, executorTx];
            executor.isDeployed = true;

            await redis.set(
                `${getAddress(acc.address)}-executor`,
                JSON.stringify(executor)
            );

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
                    to: "0xaB79D1e6A7C61b8aBece51fB7FF53dbe7c34ec88" as Address, // main deployer
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
