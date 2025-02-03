import {
    Action,
    ActionExample,
    State,
    IAgentRuntime,
    Memory,
    HandlerCallback,
    ModelClass,
    generateObject,
} from "@elizaos/core";
import { fetchAllTokens, TokenData } from "../utils/token-data";
import { swapStorer, GoodTraderSwap, TokenInfo } from "../swap-storer";
import { generateText, composeContext } from "@elizaos/core";
import { fetchTokenData, DexScreenerResponse } from "../utils/dextools";
import { z } from "zod";
import {
    enhancedDynamicScore,
    buildScoringRanges,
} from "../utils/token-valuation";
import { OpacityAdapter } from "@elizaos/plugin-opacity";
import fs from "fs";
import path from "path";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

function getRisk(size: string): "LOW" | "MID" | "HIGH" {
    if (size === "large") return "LOW";
    if (size === "small") return "HIGH";
    return "MID";
}

const template = `
You are a **trading assistant**. Given the user's request, you must determine:
1. **Risk Level** of the requested trade (**LOW**, **MID**, or **HIGH**).
2. **How much total** the user wants to spend.

Instructions:
- **If the user does not specify how much they want to spend**, set \amount\ to **null**.
- **If the user does not specify a risk level**, set \risk\ to **MID**.

**User message**:
\\\
{{currentMessage}}
\\\

    **Respond with the following JSON** (no extra text):

    \\\json
    {
        "amount": string | null,
        "risk": "LOW" | "MID" | "HIGH",
    }
    \\\
`;

const secondTemplate = `
    You are a trading assistant. Given the list of tokens, recommend which ones to buy.

    We want to **simulate** a hypothetical allocation plan.

    **No real money will be spent**.

    Available tokens:
    \`\`\`
    {{finalTokens}}
    \`\`\`

    User request: {{currentMessage}}
    Amount: {{amount}}
    Date: {{date}}

    Instructions:
    - Base recommendations on finalScoreValue, scoreDetails, and enhancedMetrics
    - Consider the following enhanced metrics for each token:
      * Smart Money Momentum (higher is better)
      * Liquidity Health (concentration, stability, depth)
      * Time-weighted price and volume changes
      * Risk-adjusted score
      * Market context
    - Each token that has been selected shall have one unique sentence explaining why it was selected
    - The explanation should incorporate both basic and enhanced metrics
    - Percentage is always in decimal form (e.g. 0.1 = 10%)
    - The percentage should always be a total of 100%
    - Allocate higher percentages to tokens with:
      * Higher risk-adjusted scores
      * Better liquidity health
      * Positive smart money momentum
      * Favorable market context
    - If you want to reference the heat ratio talk about the high volume compared to the total value locked 
    - The summary shall include all the tokens symbols and a explanation of the allocation. The sentance should not be more then 120 characters. Each token should be prefixed with $

    IMPORTANT: Return a JSON object with the following schema, and nothing else:
    {
        summary: string,
        order: Array<{
            contractAddress: string,
            percentage: string,
            name: string,
            symbol: string,
            decimals: number,
            summary: string,
            info: Object
        }>,
        amount: string | null,
        risk: "LOW" | "MID" | "HIGH",
        type: "token_buy",
        date: string
    }`;

export const tokenHelperAction: Action = {
    name: "CREATE_TRADE",
    similes: [
        "CREATE_TRADE_ACTION",
        "BUY_TOKENS",
        "BUY_TOKEN",
        "BUY_TOKEN_ACTION",
    ],
    description:
        "All-in-one Action that returns one list of tokens from top-10 in each risk category, then final recommendation.",
    suppressInitialMessage: true,

    validate: async (runtime: IAgentRuntime, message: Memory) => true,

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        console.log(state);
        state.currentMessage =
            state.recentMessageInteractions ||
            state.recentMessagesData?.[1].content.text;

        const sender = state.senderName;
        console.log("message....:", message);

        console.log(":::::::sender", sender);

        const context1 = composeContext({
            state,
            template,
        });
        const firstCallSchema = z.object({
            amount: z.string().nullable(),
            risk: z.enum(["LOW", "MID", "HIGH"]),
        });
        const { object } = await generateObject({
            runtime,
            context: context1,
            modelClass: ModelClass.SMALL,
            schema: firstCallSchema,
        });

        const { amount, risk } = firstCallSchema.parse(object);

        const allTokens = await fetchAllTokens();
        const swapsData = swapStorer.getInfo();
        const goodTraderActions = swapStorer.getGoodTraderActivity();

        // Build min-max ranges
        const ranges = buildScoringRanges(
            allTokens,
            swapsData,
            goodTraderActions
        );

        // Score & add "risk" with enhanced scoring
        const enriched = await Promise.all(
            allTokens.map(async (t) => {
                // Fetch DEX data for enhanced scoring
                const dexData = await fetchTokenData(t.contractAddress);

                // Use enhanced scoring
                const finalScore = enhancedDynamicScore(
                    t,
                    swapsData,
                    goodTraderActions,
                    ranges,
                    dexData
                );

                const risk = getRisk(t.size);

                return {
                    ...t,
                    risk,
                    finalScoreValue: finalScore.finalScore,
                    scoreDetails: {
                        breakdown: finalScore.breakdown,
                        weightedBreakdown: finalScore.weightedBreakdown,
                        weights: finalScore.weights,
                        explanation: finalScore.explanation,
                        metrics: finalScore.metrics,
                    },
                    enhancedMetrics: {
                        timeWeighted: finalScore.timeWeighted,
                        smartMoneyMomentum: finalScore.smartMoneyMomentum,
                        liquidityHealth: finalScore.liquidityHealth,
                        riskAdjusted: finalScore.riskAdjusted,
                        marketContext: finalScore.marketContext,
                    },
                };
            })
        );

        const ignoreTokens = ["USD", "BTC", "ETH", "Stable", "DAI"];
        const selectedTokens = enriched
            .filter((x) => x.risk === risk)
            .filter(
                (x) =>
                    !ignoreTokens.some((tokenName) =>
                        x.name.toLowerCase().includes(tokenName.toLowerCase())
                    )
            )
            // Sort by risk-adjusted score instead of just finalScore
            .sort(
                (a, b) =>
                    b.enhancedMetrics.riskAdjusted -
                    a.enhancedMetrics.riskAdjusted
            )
            .slice(0, 10);

        const tokensWithDextools = await Promise.all(
            selectedTokens.map(async (tok) => {
                return {
                    ...tok,
                    dexTools: await fetchTokenData(tok.contractAddress),
                };
            })
        );

        state.finalTokens = JSON.stringify(tokensWithDextools);
        state.amount = amount;
        state.date = new Date().toISOString();

        const context2 = composeContext({ state, template: secondTemplate });

        // const verifiableInferenceAdapter = new OpacityAdapter({
        //     teamId: process.env.OPACITY_TEAM_ID,
        //     teamName: process.env.OPACITY_CLOUDFLARE_NAME,
        //     opacityProverUrl: process.env.OPACITY_PROVER_URL,
        //     modelProvider: runtime.modelProvider,
        //     token: runtime.token,
        // });

        // console.log(context2);

        // const result = await verifiableInferenceAdapter.generateText(
        //     context2,
        //     ModelClass.LARGE,
        //     {}
        // );

        const result = await generateText({
            runtime,
            context: context2,
            modelClass: ModelClass.LARGE,
        });

        // console.log("SECOND CALL", result.text);
        // console.log("SECOND CALL PROOF", result.id);

        const outputData = result;

        // Create outputs directory if it doesn't exist
        const outputDir = path.join(process.cwd(), "outputs");
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const myOutput = JSON.parse(
            result.replace("```", "").replace("json", "").replace("```", "")
        );

        console.log("::::::::ACTION:", myOutput);

        const uuid = crypto.randomUUID();
        const outputPath = path.join(
            outputDir,
            `token-recommendation-${uuid}.json`
        );

        fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
        console.log(`Saved recommendation to ${outputPath}`);

        await redis.set(uuid, JSON.stringify(outputData));

        const output = `${myOutput.summary} Execute the trade on https://based-helper.vercel.app/${uuid}`;

        // Return final JSON from second LLM call
        callback({ text: output });
        return true;
    },

    examples: [
        [
            {
                user: "Alice",
                content: {
                    text: "Get me the top tokens from each risk category as a single list, then fetch Dex data, and finalize a buy plan.",
                },
            },
            {
                user: "Assistant",
                content: {
                    text: "Sure, I'll do it in one action with two LLM calls. The first returns a single array 'tokens', the second finalizes the recommendation.",
                    action: "CONTINUE",
                },
            },
        ],
    ] as ActionExample[][],
};
