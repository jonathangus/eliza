# @elizaos/plugin-eigenda - EigenDA Plugin for Eliza

The EigenDA plugin enables interaction with EigenDA's data availability layer through Eliza. It provides functionality for uploading data, retrieving data, and checking upload status on the EigenDA network.

## Features

- Upload data to EigenDA network
- Retrieve data using job ID, request ID, or batch header hash + blob index
- Check upload status
- Automatic identifier management
- Automatic balance monitoring and top-up
- Support for text, JSON, and binary data

## Installation

```bash
npm install @elizaos/plugin-eigenda
```

## Configuration

The plugin requires certain environment variables to be set. You can set these in your `.env` file or through your runtime environment:

```env
# Required
EVM_PRIVATE_KEY=your_private_key

# Optional (defaults provided)
API_URL=http://3.220.4.143:5000
BASE_RPC_URL=https://base.drpc.org
CREDITS_CONTRACT_ADDRESS=0x0CC001F1bDe9cd129092d4d24D935DB985Ce42A9
EIGENDA_IDENTIFIER=your_hex_identifier  # Optional: Use a specific identifier for all operations
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EVM_PRIVATE_KEY` | Yes | - | Private key for signing transactions |
| `API_URL` | No | `http://3.220.4.143:5000` | EigenDA API endpoint |
| `BASE_RPC_URL` | No | `https://base.drpc.org` | Base network RPC URL |
| `CREDITS_CONTRACT_ADDRESS` | No | `0x0CC001F1bDe9cd129092d4d24D935DB985Ce42A9` | Credits contract address on Base |
| `EIGENDA_IDENTIFIER` | No | - | Hex-encoded identifier to use for all operations |

## Usage

### Uploading Data

```typescript
// Upload text data
await runtime.execute("UPLOAD_DATA", {
    content: "Hello, EigenDA!"
});

// Upload JSON data
await runtime.execute("UPLOAD_DATA", {
    content: JSON.stringify({
        name: "Test Object",
        values: [1, 2, 3]
    })
});

// Upload with specific identifier (overrides EIGENDA_IDENTIFIER from env)
await runtime.execute("UPLOAD_DATA", {
    content: "Hello, EigenDA!",
    identifier: "0x1234567890abcdef"
});
```

### Checking Status

```typescript
await runtime.execute("GET_STATUS", {
    jobId: "abc123def456"
});
```

### Retrieving Data

```typescript
// Retrieve by job ID
await runtime.execute("RETRIEVE_DATA", {
    jobId: "abc123def456"
});

// Retrieve by request ID
await runtime.execute("RETRIEVE_DATA", {
    requestId: "xyz789"
});

// Retrieve by batch header hash and blob index
await runtime.execute("RETRIEVE_DATA", {
    batchHeaderHash: "0xabcdef...",
    blobIndex: 0
});
```

## Important Notes

1. **Processing Time**: Data uploads typically require 5-10 minutes of processing time before they are available for retrieval.

2. **Balance Management**: The plugin automatically checks your balance and tops up with 0.01 ETH if it falls below the threshold.

3. **Identifiers**: The plugin handles identifiers in the following priority:
   - Uses identifier provided in the action call if specified
   - Uses `EIGENDA_IDENTIFIER` from environment if set
   - Uses an existing identifier from the account if available
   - Creates a new identifier if none exists

4. **Data Types**: The plugin supports:
   - Text data
   - JSON data (automatically stringified)
   - Binary data

## Example Workflow

```typescript
// 1. Upload data
const uploadResult = await runtime.execute("UPLOAD_DATA", {
    content: "Hello, EigenDA!"
});
const jobId = uploadResult.content.job_id;

// 2. Check status
await runtime.execute("GET_STATUS", {
    jobId
});

// 3. Retrieve data (after processing is complete)
await runtime.execute("RETRIEVE_DATA", {
    jobId
});
```

## Error Handling

The plugin includes comprehensive error handling for:
- Invalid configuration
- Network issues
- Insufficient balance
- Invalid data formats
- Failed uploads/retrievals

Error messages are descriptive and include specific details about what went wrong.

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For support, please open an issue in the repository or contact the EigenDA team.

