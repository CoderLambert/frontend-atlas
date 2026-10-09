FROM node:24-bookworm-slim AS build

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
    && FRONTEND_ATLAS_DB_PATH=/tmp/frontend-atlas-build.sqlite npm run local:build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    FRONTEND_ATLAS_DB_PATH=/data/coach.sqlite

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/content ./src/content
COPY --from=build /app/src/lib/db ./src/lib/db
COPY --from=build /app/next.config.ts /app/tsconfig.json ./

RUN mkdir -p /data /home/node/.config/frontend-atlas \
    && chown -R node:node /app /data /home/node/.config/frontend-atlas

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/coach/sessions/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npm run db:migrate:runtime && exec npm run local:start"]
