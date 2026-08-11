# Pironman runs on a Raspberry Pi 5: build for linux/arm64 and listen on port 80.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so only runtime deps are carried forward.
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80

# Baked in so /health can report which build is answering. Without it a redeploy
# cannot be distinguished from the outgoing container still serving.
ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA

# The platform requires the image to carry curl or wget so a healthcheck can
# run, and its own injected check uses curl. Alpine ships only busybox wget.
RUN apk add --no-cache curl

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 80

# Runs as root deliberately: the platform requires port 80, and binding a port
# below 1024 needs either root or CAP_NET_BIND_SERVICE, which the container is
# not guaranteed to keep. A non-root USER here fails with EACCES at startup.

# Lets the platform tell a started container from a ready one, so a redeploy
# does not cut over before the new one can serve.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
  --start-interval=250ms \
  CMD curl -fsS http://localhost:80/health || exit 1

# Hosted mode is multi-tenant: each business's credentials arrive with its
# request, so no Revolut secret beyond the service signing key is in the image
# (and that one is injected as an environment variable, never baked in).
CMD ["node", "dist/index.js", "--http"]
