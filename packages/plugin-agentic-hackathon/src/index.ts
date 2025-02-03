import type { Plugin } from "@elizaos/core";
import { tokenHelperAction } from "./actions/token-helper.ts";
export { swapStorer } from "./swap-storer.ts";

export const agenticPlugin: Plugin = {
    name: "agentic-hackathon",
    description: "agentic hackathon plugin",
    actions: [tokenHelperAction],
    evaluators: [],
    providers: [],
};
export default agenticPlugin;
