FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/gear/native
RUN npm install --global pnpm@11.7.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY run.mjs dsh-policy.mjs ./
WORKDIR /app
ENTRYPOINT []
