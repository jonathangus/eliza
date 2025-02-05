import { toCoinbaseSmartAccount } from "viem/account-abstraction";
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
import { generateText, composeContext } from "@elizaos/core";
import { z } from "zod";
import { onChainDataStorer } from "../onchain-data-storer";
import { Redis } from "@upstash/redis";
import { swapExecutor } from "../swap-executor";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createClient, getAddress, http } from "viem";

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
3. **How many tokens** the user wants to buy.

Instructions:
- **If the user does not specify how much they want to spend**, set \amount\ to **null**.
- **If the user does not specify a risk level**, set \risk\ to **MID**.
- Extract the message the user sent and return it in the originalQuestion field. It should just be the question without any information about the sender.

**User message**:
\\\
{{currentMessage}}
\\\

    **Respond with the following JSON** (no extra text):

    \\\json
    {
        "amount": string | null,
        "risk": "LOW" | "MID" | "HIGH",
        "originalQuestion": string,
        "tokenCount": number,
    }
    \\\
`;

const secondTemplate = `You are a hypothetical trading assistant.  
All allocations are fictional and for simulation only.  
No real money is spent.  
No financial advice is given or implied.

We have the following tokens:
{{finalTokens}}

We want a **hypothetical** allocation plan for the tokens based on:  
1. finalScoreValue  
2. scoreDetails  
3. enhancedMetrics (including Smart Money Momentum, Liquidity Health, Time-weighted price/volume changes, Risk-adjusted score, Market context)

Constraints:
- Percentages must total 100% (in decimal form).  
- Allocate higher percentages to tokens with better risk-adjusted scores, higher liquidity health, and positive smart money momentum.  
- Provide a one-sentence explanation for why each token is chosen, referencing both basic and enhanced metrics.  
- Summaries should reference the token symbol with a "$" prefix (e.g. "$ABC").  
- Keep the main "summary" field to no more than 120 characters.
- Answer should be a single sentence that summarizes the user's request and the output from our allocation plan in the  voice and style and perspective of {{agentName}}
- Keymetrics should be coming from the token data to be extracted

User want to buy {{tokenCount}} tokens. Only return this amount of suggested tokens.
User request: {{currentMessage}}  
Amount: {{amount}}  
Date: {{date}}
Wanted risk: {{risk}}
# About {{agentName}
{{bio}} 


IMPORTANT: Return only this JSON (no extra text, no formatting):

{
  "summary": "string",
  "answer": "string",
  "order": [
    {
      "contractAddress": "string",
      "percentage": "string",// make sure its a decimal value (ex 0.1 for 10%)
      "name": "string",
      "symbol": "string",
      "decimals": number,
      "summary": "string",
      "keyMetrics": {
        "smartMoneyMomentum": "string",
        "liquidityHealth": "string",
        "riskAdjusted": "string",
        "marketContext": "string",
        "tvl": "string",
        "volume": "string",
        "price": "string",
      },
      "explanation": {
            "tvl": "string",
            "volume": "string",
            "netBuys": "string",
            "goodTrader": "string",
            "heat": "string", 
        },
    }
  ],
  "amount": "string" or null,
  "risk": "LOW" | "MID" | "HIGH",
  "type": "token_buy",
  "date": "string"
}
`;

export const tokenHelperAction: Action = {
    name: "CREATE_TRADE",
    similes: [
        "CREATE_TRADE_ACTION",
        "BUY_TOKENS",
        "BUY_TOKEN",
        "BUY_TOKEN_ACTION",
    ],
    description:
        "All-in-one Action that returns one list of tokens from top-10 in each risk category, then final recommendation. Always return IGNORE after",
    suppressInitialMessage: true,

    validate: async (runtime: IAgentRuntime, message: Memory) => true,

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        state.currentMessage =
            state.recentMessagesData?.[1]?.content.text ||
            state.recentMessagesData?.[0]?.content.text ||
            state.recentMessagesData;

        const context1 = composeContext({
            state,
            template,
        });
        const firstCallSchema = z.object({
            amount: z.string().nullable(),
            risk: z.enum(["LOW", "MID", "HIGH"]),
            tokenCount: z.number(),
        });
        const { object } = await generateObject({
            runtime,
            context: context1,
            modelClass: ModelClass.SMALL,
            schema: firstCallSchema,
        });

        const { amount, risk, tokenCount } = firstCallSchema.parse(object);

        onChainDataStorer.updateTopState();

        const tokensWithDextools = onChainDataStorer
            .getTokensByRisk(risk)
            .slice(0, 7); // only care about the top 7 tokens for now

        state.finalTokens = JSON.stringify(tokensWithDextools);
        state.amount = amount;
        state.date = new Date().toISOString();
        state.risk = risk;
        state.tokenCoun = tokenCount;

        const context2 = composeContext({ state, template: secondTemplate });

        console.log("generating text");
        const result = await generateText({
            runtime,
            context: context2,
            modelClass: ModelClass.LARGE,
        });

        console.info("Generated result from model:", result);
        let buyTokenAction = JSON.parse(
            result.replace("```", "").replace("json", "").replace("```", "")
        );

        buyTokenAction.order = buyTokenAction.order.map((x) => {
            const tokenInfo = onChainDataStorer.getInfoFromContractAddress(
                x.contractAddress
            );
            return {
                ...x,
                tokenInfo,
            };
        });

        const uuid = crypto.randomUUID();

        console.info("Generated buy token action:", buyTokenAction);
        console.info("Generated UUID for transaction:", uuid);

        await redis.set(uuid, JSON.stringify(buyTokenAction));

        const pk = generatePrivateKey();
        const owner = privateKeyToAccount(pk);
        const client = createClient({
            chain: base,
            account: owner,
            transport: http(),
        });

        const account = await toCoinbaseSmartAccount({
            client: client,
            owners: [owner],
        });

        console.info("Generated account address for order:", account.address);

        const output = `${
            buyTokenAction.summary
        } Execute the trade on https://based-helper.vercel.app/${uuid}\n\nSend ETH on Base to ${getAddress(
            account.address
        )} to execute the trade. Remember this is not NFA and was built by a random dude in a hackathon project and your funds might be lost. `;

        swapExecutor.addEntry({
            id: uuid,
            buyTokenAction,
            state,
            pk,
            owner: account.address,
        });

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
