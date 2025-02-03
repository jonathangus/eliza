import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const eigenDAEnvSchema = z.object({
    API_URL: z.string().optional(),
    BASE_RPC_URL: z.string().optional(),
    EIGENDA_PRIVATE_KEY: z.string().min(1, "Private key is required"),
    CREDITS_CONTRACT_ADDRESS: z.string().optional(),
    IDENTIFIER: z.string().optional(),
});

export type EigenDAConfig = z.infer<typeof eigenDAEnvSchema>;

export async function validateEigenDAConfig(
    runtime: IAgentRuntime
): Promise<EigenDAConfig> {
    try {
        const config = {
            API_URL: runtime.getSetting("API_URL") || process.env.API_URL || DEFAULT_API_URL,
            BASE_RPC_URL: runtime.getSetting("BASE_RPC_URL") || process.env.BASE_RPC_URL || DEFAULT_RPC_URL,
            EIGENDA_PRIVATE_KEY: runtime.getSetting("EIGENDA_PRIVATE_KEY") || process.env.EIGENDA_PRIVATE_KEY,
            CREDITS_CONTRACT_ADDRESS: runtime.getSetting("CREDITS_CONTRACT_ADDRESS") || process.env.CREDITS_CONTRACT_ADDRESS || DEFAULT_CREDITS_CONTRACT_ADDRESS,
            IDENTIFIER: runtime.getSetting("EIGENDA_IDENTIFIER") || process.env.EIGENDA_IDENTIFIER,
        };

        return eigenDAEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `EigenDA configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}

// Default configuration values
export const DEFAULT_API_URL = "http://test-agent-proxy-api.eigenda.xyz";
export const MAX_STATUS_CHECKS = 60;
export const STATUS_CHECK_INTERVAL = 10;
export const INITIAL_RETRIEVAL_DELAY = 300;
export const DEFAULT_CREDITS_CONTRACT_ADDRESS = "0x0CC001F1bDe9cd129092d4d24D935DB985Ce42A9";
export const DEFAULT_RPC_URL = "https://mainnet.base.org";