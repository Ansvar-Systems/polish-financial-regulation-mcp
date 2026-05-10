# ─────────────────────────────────────────────────────────────────────────────
# Polish Financial Regulation MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t polish-financial-regulation-mcp .
# Run:    docker run --rm -p 3000:3000 polish-financial-regulation-mcp
#
# The image expects a pre-built database at /app/data/knf.db.
# Override with KNF_DB_PATH for a custom location.
#
# IMPORTANT: production stage MUST `COPY --from=builder /app/node_modules`
# instead of re-running `npm ci`. `npm ci --ignore-scripts` strips the
# better-sqlite3 postinstall (which fetches/builds the native .node binding)
# and the runtime errors with `Could not locate the bindings file` on every
# SQLite tool call. See sector-mcp-binding-recovery 2026-05-10 handover.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + install full deps (incl. native bindings) ---
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
# NOTE: no --ignore-scripts — better-sqlite3 postinstall must run so that the
# native .node binding ends up under node_modules/better-sqlite3/build/.
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV KNF_DB_PATH=/app/data/knf.db

# Carry over node_modules from builder (preserves better-sqlite3 binding).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ dist/
COPY package.json ./

# Database baked into image. ghcr-build.yml provisions data/database.db from
# the GitHub Release asset `database.db.gz`; this COPY then renames to knf.db.
COPY data/database.db data/knf.db

RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
