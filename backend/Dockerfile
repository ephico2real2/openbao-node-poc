# Build from the repository root:  docker build -f backend/Dockerfile .
FROM docker.io/library/node:22-alpine

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi \
 && npm cache clean --force

COPY backend/src ./src
COPY backend/scripts ./scripts
COPY frontend /app/frontend

ENV NODE_ENV=production \
    STATIC_DIR=/app/frontend

# Numeric UID (the image's "node" user) so Kubernetes can verify runAsNonRoot.
# On OpenShift the restricted SCC replaces it with an arbitrary UID; the app
# never writes to its own files, so that works unchanged.
USER 1000
EXPOSE 3000
CMD ["node", "src/server.js"]
