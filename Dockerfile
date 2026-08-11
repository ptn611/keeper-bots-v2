FROM public.ecr.aws/docker/library/node:24 AS builder

# Set working dir first so all paths are relative to /app
WORKDIR /app

# Copy keeper-bots-v2 (build context must be the drift-dex monorepo root)
COPY ./keeper-bots-v2 .

# Build local monorepo packages referenced via file: deps in package.json
# Order matters: protocol-v2/sdk is a dep of velocity-common/common-ts and jit-proxy/ts/sdk
COPY ./protocol-v2/sdk ./protocol-v2/sdk
WORKDIR /app/protocol-v2/sdk
RUN yarn && yarn build

COPY ./velocity-common/common-ts ./velocity-common/common-ts
WORKDIR /app/velocity-common/common-ts
RUN bun install && bun run build

COPY ./jit-proxy/ts/sdk ./jit-proxy/ts/sdk
WORKDIR /app/jit-proxy/ts/sdk
RUN yarn && yarn build

# Install keeper-bots-v2 with local deps
WORKDIR /app
RUN yarn install
RUN node esbuild.config.js

FROM public.ecr.aws/docker/library/node:24-alpine
# 'bigint-buffer' native lib for performance
RUN apk add python3 make g++ --virtual .build &&\
    npm install -C /lib bigint-buffer @triton-one/yellowstone-grpc@5.0.2 helius-laserstream rpc-websockets@7.10.0 &&\
    apk del .build &&\
    rm -rf /root/.cache/ /root/.npm /usr/local/lib/node_modules
# Create symlinks for .cjs -> .js to satisfy both import styles
RUN ln -s /lib/node_modules/rpc-websockets/dist/lib/client.js /lib/node_modules/rpc-websockets/dist/lib/client.cjs &&\
    ln -s /lib/node_modules/rpc-websockets/dist/lib/client/websocket.js /lib/node_modules/rpc-websockets/dist/lib/client/websocket.cjs
COPY --from=builder /app/lib/ ./lib/

EXPOSE 9464

CMD ["node", "./lib/index.js"]
