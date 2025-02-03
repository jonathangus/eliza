import {
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    type Action,
    elizaLogger,
    composeContext,
    generateObjectDeprecated,
} from "@elizaos/core";
import { validateEigenDAConfig } from "../environment";
import { getClient } from "../utils";

export interface RetrieveContent extends Content {
    jobId?: string;
    requestId?: string;
    batchHeaderHash?: string;
    blobIndex?: number;
}

export function isRetrieveContent(content: RetrieveContent): content is RetrieveContent {
    // At least one of these must be provided
    return !!(content.jobId || (content.requestId) || (content.batchHeaderHash && typeof content.blobIndex === 'number'));
}

const retrieveTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "jobId": "abc123def456",
    "requestId": null,
    "batchHeaderHash": null,
    "blobIndex": null
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested EigenDA retrieval:
- Job ID (if provided)
- Request ID (if provided)
- Batch Header Hash (if provided)
- Blob Index (if provided with Batch Header Hash)

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "RETRIEVE_DATA",
    similes: [
        "RETRIEVE_FROM_EIGENDA",
        "RETRIEVE_CONTENT",
        "RETRIEVE_FILE",
        "GET_DATA",
        "GET_CONTENT",
        "GET_FILE",
        "FETCH_DATA",
        "FETCH_CONTENT",
        "FETCH_FILE",
        "DOWNLOAD_DATA",
        "DOWNLOAD_CONTENT",
        "DOWNLOAD_FILE",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateEigenDAConfig(runtime);
        return true;
    },
    description: "Retrieve content from EigenDA",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting RETRIEVE_DATA handler...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose retrieve context
        const retrieveContext = composeContext({
            state,
            template: retrieveTemplate,
        });

        // Generate retrieve content
        const content = await generateObjectDeprecated({
            runtime,
            context: retrieveContext,
            modelClass: ModelClass.SMALL,
        });

        // Validate retrieve content
        if (!isRetrieveContent(content)) {
            console.error("Invalid content for RETRIEVE_DATA action.");
            if (callback) {
                callback({
                    text: "Unable to process retrieval request. Invalid content provided.",
                    content: { error: "Invalid retrieval content" },
                });
            }
            return false;
        }

        try {
            const client = getClient();

            // Prepare retrieval options based on provided parameters
            const retrieveOptions: any = {};
            if (content.jobId) {
                retrieveOptions.jobId = content.jobId;
            } else if (content.requestId) {
                retrieveOptions.requestId = content.requestId;
            } else if (content.batchHeaderHash && content.blobIndex !== undefined) {
                retrieveOptions.batchHeaderHash = content.batchHeaderHash;
                retrieveOptions.blobIndex = content.blobIndex;
            } else {
                throw new Error("Must provide either jobId, requestId, or both batchHeaderHash and blobIndex");
            }

            // Retrieve the content
            const retrievedContent = await client.retrieve(retrieveOptions);

            // Process the response similar to Python implementation
            let processedContent;
            let contentType = 'unknown';
            let size = 0;

            if (retrievedContent instanceof Uint8Array) {
                size = retrievedContent.length;
                try {
                    // First try to parse as JSON
                    const decodedString = new TextDecoder().decode(retrievedContent);
                    try {
                        processedContent = JSON.parse(decodedString);
                        contentType = 'json';
                    } catch {
                        // Check if it's an image
                        if (retrievedContent.length > 4 &&
                            (retrievedContent[0] === 0xFF && retrievedContent[1] === 0xD8 || // JPEG
                             retrievedContent[0] === 0x89 && retrievedContent[1] === 0x50))  // PNG
                        {
                            contentType = 'image';
                            processedContent = `<Image data of length ${size} bytes>`;
                        } else {
                            // If not JSON or image, check if it's readable text
                            const isProbablyText = /^[\x20-\x7E\n\r\t]*$/.test(decodedString);
                            contentType = isProbablyText ? 'text' : 'binary';
                            processedContent = isProbablyText ? decodedString :
                                `<Binary data of length ${size} bytes>`;
                        }
                    }
                } catch {
                    contentType = 'binary';
                    processedContent = `<Binary data of length ${size} bytes>`;
                }
            } else {
                // Handle case where response is already parsed (e.g., JSON)
                processedContent = retrievedContent;
                contentType = 'json';
                size = JSON.stringify(retrievedContent).length;
            }

            elizaLogger.success("Successfully retrieved content");
            if (callback) {
                callback({
                    text: `Retrieved ${contentType} content: ${
                        typeof processedContent === 'object'
                            ? JSON.stringify(processedContent, null, 2)
                            : processedContent
                    }`,
                    content: {
                        data: retrievedContent,
                        contentType,
                        size
                    }
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error retrieving content:", error);
            if (callback) {
                callback({
                    text: `Error retrieving content: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Retrieve data for job abc123def456",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll retrieve that content from EigenDA for you.",
                    action: "RETRIEVE_DATA",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Retrieved content: Hello, EigenDA! This is a test message.",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get the data with request ID xyz789",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch that content for you.",
                    action: "RETRIEVE_DATA",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: 'Retrieved content: {"name": "Test Object", "values": [1, 2, 3, 4, 5]}',
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
