# First stage - fastembed layer
FROM h4ckermike/fastembed-js:feature-arm64_v2 AS fastembed

# Install Rust and build tools
RUN apt-get update && \
    apt-get install -y curl pkg-config libssl-dev build-essential && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Add cargo to PATH
ENV PATH="/root/.cargo/bin:${PATH}"

# Install pnpm and install dependencies to get the ARM64 tokenizers
RUN cd /node_modules/fastembed && pnpm install

# Build the tokenizers
RUN cd /node_modules/fastembed/node_modules/@anush008/tokenizers && \
    cargo build && \
    cp /node_modules/fastembed/node_modules/@anush008/tokenizers/target/debug/libanush008_tokenizers.so /node_modules/fastembed/node_modules/@anush008/tokenizers/tokenizers.linux-arm64-gnu.node


    # Use a specific Node.js version for better reproducibility
FROM --platform=linux/arm64 node:23.3.0-slim AS builder

# Install pnpm globally and necessary build tools
RUN npm install -g pnpm@9.4.0 && \
    apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y \
        git \
        python3 \
        python3-pip \
        curl \
        node-gyp \
        ffmpeg \
        libtool-bin \
        autoconf \
        automake \
        libopus-dev \
        make \
        g++ \
        build-essential \
        libcairo2-dev \
        libjpeg-dev \
        libpango1.0-dev \
        libgif-dev \
        openssl \
        libssl-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set Python 3 as the default python
RUN ln -sf /usr/bin/python3 /usr/bin/python

# Set the working directory
WORKDIR /app

# Copy application code
COPY . .

# Install dependencies
RUN pnpm install --no-frozen-lockfile

# Build the project
RUN pnpm run build && pnpm prune --prod

# Create directories for tokenizers
RUN mkdir -p /app/node_modules/@anush008/tokenizers

# Copy the ARM64 tokenizers from the fastembed stage to both locations
COPY --from=fastembed /node_modules/fastembed/node_modules/@anush008/tokenizers/tokenizers.linux-arm64-gnu.node /app/node_modules/@anush008/tokenizers/

# Make sure the binaries are executable
RUN chmod +x /app/node_modules/@anush008/tokenizers/tokenizers.linux-arm64-gnu.node


# Final runtime image
FROM --platform=linux/arm64 node:23.3.0-slim

# Install runtime dependencies
RUN npm install -g pnpm@9.4.0 && \
    apt-get update && \
    apt-get install -y \
        git \
        python3 \
        ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy built artifacts and production dependencies from the builder stage
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/.npmrc ./
COPY --from=builder /app/turbo.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/client ./client
COPY --from=builder /app/lerna.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/characters ./characters

# Expose necessary ports
EXPOSE 3000 5173

# Command to start the application
CMD ["sh", "-c", "pnpm start & pnpm start:client"]
 