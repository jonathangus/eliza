import axios, { type AxiosInstance } from "axios";
import FormData from "form-data";
import type { IAgentRuntime } from "@elizaos/core";

// ipfs pinning service: https://storj.dev/dcs/api/storj-ipfs-pinning
class StorjProvider {
    private STORJ_API_URL = "https://www.storj-ipfs.com";
    private STORJ_API_USERNAME: string;
    private STORJ_API_PASSWORD: string;
    private baseURL: string;
    private client: AxiosInstance;

    constructor(runtime: IAgentRuntime) {
        this.STORJ_API_USERNAME = runtime.getSetting("STORJ_API_USERNAME")!;
        this.STORJ_API_PASSWORD = runtime.getSetting("STORJ_API_PASSWORD")!;
        this.baseURL = `${this.STORJ_API_URL}/api/v0`;
        this.client = this.createClient();
    }

    private createClient(): AxiosInstance {
        return axios.create({
            baseURL: this.baseURL,
            auth: {
                username: this.STORJ_API_USERNAME,
                password: this.STORJ_API_PASSWORD,
            },
        });
    }

    private hash(uriOrHash: string): string {
        return typeof uriOrHash === "string" && uriOrHash.startsWith("ipfs://")
            ? uriOrHash.split("ipfs://")[1]
            : uriOrHash;
    }

    public gatewayURL(uriOrHash: string): string {
        return `${this.STORJ_API_URL}/ipfs/${this.hash(uriOrHash)}`;
    }

    public async pinJson(json: any): Promise<string> {
        if (typeof json !== "string") {
            // json = JSON.stringify(json);
        }

        const { data: result } = await axios.post(
            "https://api.pinata.cloud/pinning/pinJSONToIPFS",
            {
                pinataOptions: {
                    cidVersion: 1,
                },
                pinataMetadata: {
                    name: "content.json",
                },
                pinataContent: json,
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.PINATA_JWT}`,
                },
            }
        );

        console.log(`${process.env.PINATA_GATEWAY}/ipfs/${result.IpfsHash}`);

        return `${process.env.PINATA_GATEWAY}/ipfs/${result.IpfsHash}`;
    }

    public async pinFile(file: {
        buffer: Buffer;
        originalname: string;
        mimetype: string;
    }): Promise<string> {
        const formData = new FormData();
        formData.append("file", file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
        });

        const response = await this.client.post("add?cid-version=1", formData, {
            headers: {
                "Content-Type": `multipart/form-data; boundary=${formData.getBoundary()}`,
            },
            maxContentLength: Number.POSITIVE_INFINITY,
            maxBodyLength: Number.POSITIVE_INFINITY,
        });

        return this.gatewayURL(response.data.Hash);
    }
}

export default StorjProvider;
