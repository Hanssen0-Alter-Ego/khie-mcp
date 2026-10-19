# Materialize ccc-workspace with scripts/prepare-workspace.mjs before building.
# The digest was resolved from the official Node 24.19.0 bookworm-slim image.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /build
RUN npm install --global pnpm@11.8.0 --ignore-scripts --no-audit --no-fund
COPY ccc-workspace/package.json ccc-workspace/pnpm-lock.yaml ccc-workspace/pnpm-workspace.yaml ./
COPY ccc-workspace/packages/core/ ./packages/core/
COPY ccc-workspace/packages/libp2p/ ./packages/libp2p/
COPY ccc-workspace/packages/khie-mcp/ ./packages/khie-mcp/
RUN pnpm --filter @ckb-ccc/khie-mcp... install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @ckb-ccc/core --filter @ckb-ccc/libp2p build \
    && pnpm --filter @ckb-ccc/khie-mcp build \
    && pnpm --filter @ckb-ccc/khie-mcp lint \
    && pnpm --filter @ckb-ccc/khie-mcp test \
    && pnpm --filter @ckb-ccc/khie-mcp test:demo
# Keep the existing workspace layout and frozen dependency graph. Legacy pnpm
# deploy can resolve ranges again; a production-only frozen install avoids that.
RUN CI=true pnpm --filter @ckb-ccc/khie-mcp... install --prod --frozen-lockfile --ignore-scripts \
    && ln -s packages/khie-mcp/dist /build/dist \
    && chmod -R a+rX /build

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
LABEL org.opencontainers.image.source="https://github.com/Hanssen0-Alter-Ego/khie-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Experimental user-owned Khie wallet MCP session-resume bridge"
ARG VCS_REF=uncommitted
LABEL org.opencontainers.image.revision=$VCS_REF
WORKDIR /app
COPY --from=build /build/ ./
RUN mkdir -p /app/container /app/provenance \
    && chmod 0755 /app/container /app/provenance
COPY --chmod=0444 container/entrypoint.sh /app/container/entrypoint.sh
COPY --chmod=0444 LICENSE NOTICE.md UPSTREAM.json /app/provenance/
ENV NODE_ENV=production KHIE_CONFIG_FILE=/run/khie/config.json
USER 1000:1000
EXPOSE 8787
ENTRYPOINT ["/bin/sh", "/app/container/entrypoint.sh"]
CMD ["serve"]
