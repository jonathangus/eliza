import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { AgentRuntime, State } from "@elizaos/core";

interface AccountEntry {
    id: string;
    address: string;
    privateKey: string;
    timestamp: string;
    state: State;
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
                    const acc = this.accounts[tx.to.toLowerCase()];

                    if (acc) {
                        this.executeOrder(acc, tx);
                    }
                }
            },
            onError: (error) => {
                console.error("Error watching blocks:", error);
            },
        });
    };

    executeOrder = (acc: AccountEntry, tx) => {
        console.log("AC::", acc);
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

    addEntry = (id: string, state: State) => {
        const pk = generatePrivateKey();
        const owner = privateKeyToAccount(pk);

        // Create new account entry
        const newAccount: AccountEntry = {
            id,
            address: owner.address,
            privateKey: pk,
            timestamp: new Date().toISOString(),
            state,
        };

        console.log("ID:", id);
        console.log("ADDRESS:", owner.address);

        // Update in-memory accounts using address as key
        this.accounts[owner.address.toLowerCase()] = newAccount;

        // Save to file
        fs.writeFileSync(
            this.accountsPath,
            JSON.stringify(this.accounts, null, 2)
        );

        return owner;
    };
}

export const swapExecutor = new SwapExecutor();
