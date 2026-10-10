# Official Node image. Pin the patch release and Debian family for repeatable builds.
FROM node:24.21.0-bookworm-slim AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN FRONTEND_ATLAS_DB_PATH=/tmp/frontend-atlas-build.sqlite \
      FRONTEND_ATLAS_ALLOW_DB_INITIALIZE=1 npm run db:migrate:runtime \
    && FRONTEND_ATLAS_DEPLOYMENT_MODE=hosted \
       NEXT_PUBLIC_FRONTEND_ATLAS_DEPLOYMENT_MODE=hosted \
       FRONTEND_ATLAS_DB_PATH=/tmp/frontend-atlas-build.sqlite \
       npm run local:build

FROM node:24.21.0-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    FRONTEND_ATLAS_LOCAL_MODE=1 \
    NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE=1 \
    FRONTEND_ATLAS_DEPLOYMENT_MODE=hosted \
    NEXT_PUBLIC_FRONTEND_ATLAS_DEPLOYMENT_MODE=hosted \
    FRONTEND_ATLAS_DB_PATH=/data/coach.sqlite \
    FRONTEND_ATLAS_BIND_HOST=0.0.0.0 \
    FRONTEND_ATLAS_APP_PORT=3000

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/scripts/local-app.mjs /app/scripts/local-runner-utils.mjs ./scripts/
COPY --from=build /app/scripts/migrate-sqlite.mjs /app/scripts/validate-deployment-config.mjs \
  /app/scripts/container-start.mjs /app/scripts/backup-sqlite.mjs /app/scripts/restore-sqlite.mjs ./scripts/
COPY --from=build /app/src/content ./src/content
COPY --from=build /app/src/lib/db ./src/lib/db
COPY --from=build /app/next.config.ts /app/tsconfig.json ./

RUN mkdir -p /data /app/.next/cache \
    && chown -R node:node /app /data \
    && chmod 1777 /app/.next/cache

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "scripts/container-start.mjs"]
