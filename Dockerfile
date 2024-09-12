FROM --platform=linux/amd64 node:22-alpine3.19 AS base
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production YARN_VERSION=4.4.1

RUN apk update && apk upgrade && apk add --no-cache libc6-compat && apk add dumb-init
RUN corepack enable && corepack prepare yarn@${YARN_VERSION}
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

FROM base AS builder

# Create app directory
WORKDIR /app
COPY . .
COPY package.json yarn.lock .yarnrc.yml ./
#COPY .yarn ./.yarn
RUN yarn install --immutable

# Build the app (in standalone mode based on next.config.js)
RUN yarn build

FROM base AS runner
WORKDIR /app
COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs

CMD ["node", "dist/index.js"]