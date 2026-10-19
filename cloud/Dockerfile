FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/principia
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3 && npm install --global @openai/codex @anthropic-ai/claude-code
COPY src ./src
COPY cloud ./cloud
COPY vite.cloud.config.ts ./
RUN npx vite build --config vite.cloud.config.ts && mkdir -p /data/home /workspace && chown -R node:node /data /workspace
ENV SHELL=/bin/bash HOME=/data/home HOST=0.0.0.0 PORT=8787 PRINCIPIA_DATA_DIR=/data PRINCIPIA_WORKSPACE=/workspace
USER node
EXPOSE 8787
CMD ["node", "cloud/server.mjs"]
