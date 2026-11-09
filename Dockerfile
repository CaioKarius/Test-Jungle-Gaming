FROM oven/bun:1.2
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000
# SIGTERM is forwarded by Bun to Nest's shutdown hooks (graceful drain).
CMD ["bun", "run", "src/main.ts"]
