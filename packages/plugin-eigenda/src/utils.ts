import { ethers } from 'ethers';
import { config } from 'dotenv';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { elizaLogger } from '@elizaos/core';
import { DEFAULT_API_URL, DEFAULT_CREDITS_CONTRACT_ADDRESS, DEFAULT_RPC_URL } from "./environment";

// Load environment variables
config();

// Default configuration
const MAX_STATUS_CHECKS = 60; // Maximum number of status checks (10 minutes with 10-second interval)
const STATUS_CHECK_INTERVAL = 10; // Seconds between status checks
const INITIAL_RETRIEVAL_DELAY = 300; // 5 minutes initial delay before first retrieval attempt

interface EigenDAClientConfig {
  apiUrl?: string;
  rpcUrl?: string;
  privateKey?: string;
  creditsContractAddress?: string;
}

interface UploadResponse {
  job_id: string;
  request_id: string;
}

interface StatusResponse {
  status: string;
  request_id?: string;
  blob_info?: any;
  error?: string;
}

export class EigenDAClient {
  private apiUrl: string;
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private creditsContract: ethers.Contract;
  private creditsAbi: any;

  constructor(config?: EigenDAClientConfig) {
    this.apiUrl = (config?.apiUrl || process.env.API_URL || DEFAULT_API_URL).replace(/\/$/, '');

    // Setup provider
    const rpcUrl = config?.rpcUrl || process.env.BASE_RPC_URL || DEFAULT_RPC_URL;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    // Setup wallet
    const privateKey = config?.privateKey || process.env.EIGENDA_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("Private key not provided and EIGENDA_PRIVATE_KEY not set in environment");
    }
    const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    this.wallet = new ethers.Wallet(normalizedPrivateKey, this.provider);

    // Setup contract
    const creditsContractAddress = config?.creditsContractAddress || process.env.CREDITS_CONTRACT_ADDRESS || DEFAULT_CREDITS_CONTRACT_ADDRESS;

    // Load contract ABI
    try {
      this.creditsAbi = require('./abi/Credits.json').abi;
      this.creditsContract = new ethers.Contract(creditsContractAddress, this.creditsAbi, this.wallet);
    } catch (error) {
      throw new Error("Credits ABI file not found. Please ensure abi/Credits.json exists");
    }
  }

  private async signRequest(requestData: any): Promise<string> {
    // Convert request data to a consistent format
    const dataToSign = {
      content: requestData.content,
      salt: requestData.salt
    };

    // Convert to JSON string with sorted keys (matching Python's json.dumps with sort_keys=True)
    const message = JSON.stringify(dataToSign, Object.keys(dataToSign).sort());
    elizaLogger.debug('Message to sign:', message);

    // Sign the message directly (not the hash)
    const signature = await this.wallet.signMessage(message);
    return signature;
  }

  async createIdentifier(): Promise<Uint8Array> {
    try {
      const tx = await this.creditsContract.createIdentifier();
      const receipt = await tx.wait();

      const event = receipt.logs
        .map(log => this.creditsContract.interface.parseLog(log))
        .find(event => event?.name === 'IdentifierCreated');

      if (event) {
        // Convert the identifier to proper bytes32 format
        const identifier = event.args.identifier;
        // Remove '0x' prefix if present and ensure 32 bytes
        const hexString = identifier.slice(0, 2) === '0x' ? identifier.slice(2) : identifier;
        return ethers.getBytes('0x' + hexString.padStart(64, '0'));
      }
      throw new Error("No identifier in event logs");
    } catch (error) {
      throw new Error(`Failed to create identifier: ${error.message}`);
    }
  }

  async getIdentifiers(): Promise<Uint8Array[]> {
    try {
      const count = await this.creditsContract.getUserIdentifierCount(this.wallet.address);
      const identifiers = await Promise.all(
        Array.from({ length: Number(count) }, (_, i) =>
          this.creditsContract.getUserIdentifierAt(this.wallet.address, i)
        )
      );
      // Convert each identifier to proper bytes32 format
      return identifiers.map(id => {
        const hexString = id.slice(0, 2) === '0x' ? id.slice(2) : id;
        return ethers.getBytes('0x' + hexString.padStart(64, '0'));
      });
    } catch (error) {
      throw new Error(`Failed to get identifiers: ${error.message}`);
    }
  }

  async getBalance(identifier: Uint8Array): Promise<number> {
    try {
      // Convert identifier to proper bytes32 format
      const hexString = Buffer.from(identifier).toString('hex');
      const formattedIdentifier = ethers.hexlify(ethers.zeroPadValue('0x' + hexString, 32));
      const balance = await this.creditsContract.getBalance(formattedIdentifier);
      return Number(ethers.formatEther(balance));
    } catch (error) {
      throw new Error(`Failed to get balance: ${error.message}`);
    }
  }

  async topupCredits(identifier: Uint8Array, amountEth: number): Promise<{ transactionHash: string; status: string }> {
    try {
      // Convert identifier to proper bytes32 format
      const hexString = Buffer.from(identifier).toString('hex');
      const formattedIdentifier = ethers.hexlify(ethers.zeroPadValue('0x' + hexString, 32));
      const tx = await this.creditsContract.topup(formattedIdentifier, {
        value: ethers.parseEther(amountEth.toString())
      });
      const receipt = await tx.wait();

      return {
        transactionHash: receipt.hash,
        status: receipt.status === 1 ? 'success' : 'failed'
      };
    } catch (error) {
      throw new Error(`Failed to top up credits: ${error.message}`);
    }
  }

  async upload(content: string, identifier: Uint8Array): Promise<UploadResponse> {
    try {
      // Treat content as a string for proper signing and serialization
      const salt = randomBytes(32).toString('hex');

      // Convert identifier to proper hex format for the API
      const identifierHex = Buffer.from(identifier).toString('hex').padStart(64, '0');

      // Create the data that will be signed (matching Python example)
      const dataToSign = {
        content: content,
        salt: salt
      };

      // Sign the request
      const signature = await this.signRequest(dataToSign);

      // Create the full request data
      const requestData = {
        content: content,
        account_id: this.wallet.address,
        identifier: identifierHex,
        salt: salt,
        signature: signature
      };

      // Make the request
      try {
        const response = await axios.post<UploadResponse>(`${this.apiUrl}/upload`, requestData);
        return response.data;
      } catch (axiosError: any) {
        elizaLogger.error('Upload request failed:');
        elizaLogger.error(`Status: ${axiosError.response?.status}`);
        elizaLogger.error(`Response data:`, axiosError.response?.data);
        throw new Error(`Upload request failed: ${axiosError.response?.data?.error || axiosError.message}`);
      }
    } catch (error: any) {
      elizaLogger.error('Error in upload method:', error);
      throw error;
    }
  }

  async getStatus(jobId: string): Promise<StatusResponse> {
    try {
      const response = await axios.get<StatusResponse>(`${this.apiUrl}/status/${jobId}`);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get status: ${error.message}`);
    }
  }

  async waitForStatus(
    jobId: string,
    targetStatus: string = "CONFIRMED" || "FINALIZED",
    maxChecks: number = MAX_STATUS_CHECKS,
    checkInterval: number = STATUS_CHECK_INTERVAL,
    initialDelay: number = INITIAL_RETRIEVAL_DELAY
  ): Promise<StatusResponse> {
    console.log(`Waiting ${initialDelay} seconds before first status check...`);
    await new Promise(resolve => setTimeout(resolve, initialDelay * 1000));

    let checks = 0;
    while (checks < maxChecks) {
      const statusResponse = await this.getStatus(jobId);
      const currentStatus = statusResponse.status;
      console.log(`Current status: ${currentStatus}`);

      if (currentStatus === targetStatus) {
        return statusResponse;
      } else if (currentStatus === "FAILED") {
        throw new Error(`Job failed: ${statusResponse.error || 'Unknown error'}`);
      }

      checks++;
      if (checks < maxChecks) {
        console.log(`Waiting ${checkInterval} seconds before next check... (${checks}/${maxChecks})`);
        await new Promise(resolve => setTimeout(resolve, checkInterval * 1000));
      }
    }

    throw new Error(`Timeout waiting for status ${targetStatus} after ${maxChecks} checks`);
  }

  async retrieve(
    options: {
      jobId?: string;
      requestId?: string;
      batchHeaderHash?: string;
      blobIndex?: number;
      waitForCompletion?: boolean;
    }
  ): Promise<any> {
    try {
      const { jobId, requestId, batchHeaderHash, blobIndex, waitForCompletion = false } = options;

      // If using jobId and waitForCompletion is false, wait for the job to complete
      let finalRequestId = requestId;
      if (jobId && waitForCompletion) {
        const status = await this.waitForStatus(jobId);
        finalRequestId = status.request_id;
        if (!finalRequestId) {
          throw new Error("No request_id in completed status");
        }
      }

      // Prepare request data
      const requestData: any = {};
      if (finalRequestId) {
        requestData.request_id = finalRequestId;
      } else if (jobId) {
        requestData.job_id = jobId;
      } else if (batchHeaderHash && blobIndex !== undefined) {
        requestData.batch_header_hash = batchHeaderHash;
        requestData.blob_index = blobIndex;
      } else {
        throw new Error(
          "Must provide either jobId, requestId, or both batchHeaderHash and blobIndex"
        );
      }

      // Make retrieval request
      const response = await axios.post(`${this.apiUrl}/retrieve`, requestData, {
        responseType: 'arraybuffer'
      });

      // Try to parse as JSON first
      try {
        const textContent = new TextDecoder().decode(response.data);
        return JSON.parse(textContent);
      } catch {
        // If not JSON, return as Uint8Array
        return new Uint8Array(response.data);
      }
    } catch (error) {
      throw new Error(`Failed to retrieve content: ${error.message}`);
    }
  }
}

export function getClient(config?: EigenDAClientConfig): EigenDAClient {
  // Ensure we're using the same config priority as in environment.ts
  const clientConfig: EigenDAClientConfig = {
    apiUrl: config?.apiUrl || process.env.API_URL || DEFAULT_API_URL,
    rpcUrl: config?.rpcUrl || process.env.BASE_RPC_URL || DEFAULT_RPC_URL,
    privateKey: config?.privateKey || process.env.EIGENDA_PRIVATE_KEY,
    creditsContractAddress: config?.creditsContractAddress || process.env.CREDITS_CONTRACT_ADDRESS || DEFAULT_CREDITS_CONTRACT_ADDRESS,
  };
  return new EigenDAClient(clientConfig);
}