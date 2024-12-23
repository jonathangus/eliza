import {
    StorageProvider,
    StorageProviderEnum,
    UploadResponse,
} from "./StorageProvider";
import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import axios, { AxiosInstance } from "axios";

export class PinataProvider implements StorageProvider {
    provider = StorageProviderEnum.PINATA;

    private PINATA_API_URL: string = "https://api.pinata.cloud";
    private PINATA_JWT: string;
    private client: AxiosInstance;

    constructor(runtime: IAgentRuntime) {
        this.PINATA_JWT = runtime.getSetting("PINATA_JWT")!;
        this.client = this.createClient();

        if (!this.PINATA_JWT) {
            elizaLogger.warn(
                "To use Pinata IPFS service you need to set PINATA_JWT in environment variables. Get your key at https://pinata.cloud"
            );
        }
    }

    private createClient(): AxiosInstance {
        return axios.create({
            baseURL: this.PINATA_API_URL,
            headers: {
                Authorization: `Bearer ${this.PINATA_JWT}`,
                "Content-Type": "application/json",
            },
        });
    }

    async uploadFile(file: {
        buffer: Buffer;
        originalname: string;
        mimetype: string;
    }): Promise<UploadResponse> {
        const formData = new FormData();

        // Create a Blob from the buffer
        const blob = new Blob([file.buffer], { type: file.mimetype });

        // Append the file to FormData
        formData.append("file", blob, file.originalname);

        const { data } = await this.client.post(
            "/pinning/pinFileToIPFS",
            formData,
            {
                headers: {
                    "Content-Type": `multipart/form-data`,
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            }
        );

        return {
            cid: data.IpfsHash,
            url: `https://gateway.pinata.cloud/ipfs/${data.IpfsHash}`,
        };
    }

    async uploadJson(
        json: Record<string, any> | string
    ): Promise<UploadResponse> {
        const data = typeof json === "string" ? JSON.parse(json) : json;

        const { data: result } = await this.client.post(
            "/pinning/pinJSONToIPFS",
            {
                pinataOptions: {
                    cidVersion: 1,
                },
                pinataMetadata: {
                    name: "content.json",
                },
                pinataContent: data,
            }
        );

        // For some reason we need to wait for some seconds for Lens to be able to find the content
        await new Promise((resolve) => setTimeout(resolve, 10_000));

        return {
            cid: result.IpfsHash,
            url: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
        };
    }
}
