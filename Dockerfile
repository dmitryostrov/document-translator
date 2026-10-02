FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.2
USER root
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
RUN mkdir -p /data /auth /ipc && chown bun:bun /data /auth /ipc
USER bun
ENV DATA_DIR=/data PORT=3100 FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/api.ts"]
