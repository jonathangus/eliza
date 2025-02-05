import type { Plugin, AgentRuntime } from "@elizaos/core";
import { tokenHelperAction } from "./actions/token-helper.ts";
import { swapStorer } from "./swap-storer.ts";
import { swapExecutor } from "./swap-executor.ts";
import { onChainDataStorer } from "./onchain-data-storer.ts";

export const initializePlugin = (runtime: AgentRuntime) => {
    swapStorer.init();
    swapExecutor.init(runtime);
    onChainDataStorer.init();
};

export const agenticPlugin: Plugin = {
    name: "agentic-hackathon",
    description: "agentic hackathon plugin",
    actions: [tokenHelperAction],
    evaluators: [],
    providers: [],
};
export default agenticPlugin;
