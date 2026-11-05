FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY openapi ./openapi
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY openapi ./openapi
# After npm ci so sha changes do not bust the dependency layer.
# Baked at image build (compose/build-arg). Exposed only as /healthz.sha — nothing else.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}
EXPOSE 3000
CMD ["node", "dist/index.js"]
