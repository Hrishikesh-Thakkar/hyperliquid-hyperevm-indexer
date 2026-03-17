# ---------------------------------------------------------------------------
# Build stage — compile TypeScript inside the image for reproducible builds
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Production stage — minimal runtime image
# ---------------------------------------------------------------------------
FROM node:20-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Default: all-in-one (API + indexer + matcher).
# Override per service:
#   api:     CMD ["node", "dist/cmd/api.js"]
#   worker:  CMD ["node", "dist/cmd/worker.js"]
CMD ["node", "dist/index.js"]
