FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY astro.config.mjs tsconfig.json ./
COPY src ./src
COPY public ./public
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY distribution/astro-adapter.mjs ./distribution/astro-adapter.mjs
COPY distribution/runtime ./distribution/runtime
COPY openapi-docs ./openapi-docs
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321
WORKDIR /app
COPY COPYRIGHT.md LICENSE THIRD_PARTY_NOTICES.md ./
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/distribution/runtime ./distribution/runtime
COPY --from=build /app/openapi-docs ./openapi-docs
RUN mkdir -p /app/data/mail-attachments && chown -R node:node /app/data
USER node
EXPOSE 4321 2525
CMD ["node", "distribution/runtime/start.mjs"]
