# Both processes ship from one image. Web and worker share almost all of their
# code — the difference is which entrypoint runs — so two images would only add
# a way for them to drift apart at deploy time.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# postgresql-client provides pg_dump and psql for the backup and restore
# scripts. tzdata matters more than it looks: without it the container cannot
# resolve Asia/Tashkent and every staff-visible timestamp silently falls back
# five hours to UTC.
RUN apk add --no-cache postgresql-client tzdata

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The generated migration SQL. dist/db/migrate.js resolves this at ../../drizzle,
# so without it the container starts but cannot create or update the schema.
COPY drizzle ./drizzle

# Never run as root. node:alpine ships an unprivileged "node" user.
USER node

# Overridden per service in docker-compose.yml.
CMD ["node", "dist/web/main.js"]
