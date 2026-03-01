# ---- Build stage ----
FROM node:20-slim AS build

# tree-sitter native addons need python3, make, g++
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY tsconfig.json ./
COPY src ./src
COPY vendor ./vendor
RUN npm run build

# ---- Prod dependencies stage ----
FROM node:20-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# ---- Production stage ----
FROM node:20-slim

# git + ca-certificates needed at runtime for git_url source extraction (simple-git)
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules (with native addons already built)
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist
# Copy vendored Leiden algorithm (loaded at runtime via createRequire)
COPY vendor ./vendor
# Copy migration SQL files (needed at runtime by the migration runner)
COPY src/db/migrations ./dist/db/migrations

# Entrypoint runs migrations then starts the server
COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["./docker-entrypoint.sh"]
