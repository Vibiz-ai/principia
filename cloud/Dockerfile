# Principia Cloud: the control plane and the agent runtime in one Node 24 process (CLOUD.md §4), plus the Open Passport
# host sources for one-container hosts (PRINCIPIA_PASSPORT=embedded: Render, Fly). Published as
# ghcr.io/vibiz-ai/principia-cloud (.github/workflows/cloud-images.yml). Build from the repo root with the Open Passport
# repository as a named context:
#   docker build -f cloud/Dockerfile --build-context open-passport=https://github.com/Vibiz-ai/open-passport.git#main .
#   (or: docker compose -f cloud/compose.yml -f cloud/compose.build.yml up --build -d)
# The published image (.github/workflows/cloud-images.yml) builds from one pinned Open Passport commit
# (OPEN_PASSPORT_COMMIT there), not from main.
# CLI versions are pinned (CLOUD.md §7.2, §11 supply chain). Bump them deliberately and record them in cloud/README.md.

FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/principia
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY src ./src
COPY cloud ./cloud
COPY vite.*.config.ts tsconfig*.json ./
RUN npx vite build --config vite.cloud.config.ts \
 && npx vite build --config vite.console.config.ts \
 && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.306
ARG CODEX_VERSION=0.163.0
ARG GEMINI_CLI_VERSION=0.65.0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/* \
 && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
 && npm cache clean --force
WORKDIR /opt/principia
COPY --from=build /opt/principia/package.json ./package.json
COPY --from=build /opt/principia/node_modules ./node_modules
COPY --from=build /opt/principia/out-cloud ./out-cloud
COPY cloud ./cloud
# the unchanged Open Passport reference host (zero dependencies: Node 24 runs its TypeScript directly)
COPY --from=open-passport packages/js /opt/open-passport/packages/js
COPY --from=open-passport packages/server /opt/open-passport/packages/server
# CLOUD.md §7.8: the control plane runs as root (compose keeps six capabilities) and starts every agent process as
# `agent` (1001), which cannot read /secrets, control.db or the runtime's databases. The embedded passport host runs
# as `passport` (1002).
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /opt/principia/out-cloud/control.mjs "$@"\n' > /usr/local/bin/principia-cloud \
 && chmod 755 /usr/local/bin/principia-cloud \
 && groupadd --system --gid 1001 agent && useradd --system --uid 1001 --gid 1001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin agent \
 && groupadd --system --gid 1002 passport && useradd --system --uid 1002 --gid 1002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin passport \
 && mkdir -p /data/home /workspace /secrets /passport-secrets \
 && chmod 711 /data /workspace && chmod 700 /data/home /secrets /passport-secrets \
 && chmod -R a+rX /opt/open-passport /opt/principia
ENV NODE_ENV=production SHELL=/bin/bash HOME=/data/home HOST=0.0.0.0 PORT=8787 \
    PRINCIPIA_DATA_DIR=/data PRINCIPIA_WORKSPACE=/workspace PRINCIPIA_SECRETS_DIR=/secrets PRINCIPIA_CONSOLE_DIR=/opt/principia/out-cloud/console \
    PRINCIPIA_AGENT_UID=1001 PRINCIPIA_PASSPORT_UID=1002 PRINCIPIA_PASSPORT_SRC=/opt/open-passport
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "out-cloud/control.mjs"]
