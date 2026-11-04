FROM node:24-slim

# shortcut: amd64 only, switch to a per-TARGETARCH download when deploying on arm
ARG SUPERCRONIC_URL=https://github.com/aptible/supercronic/releases/download/v0.2.51/supercronic-linux-amd64
ARG SUPERCRONIC_SHA256=cc232108374e8e2b537045f2d5eaa1229f619db314c3ba6a14d38b35dc0aa123
RUN node --input-type=module -e '\
  import { createHash } from "node:crypto"; \
  import { writeFileSync } from "node:fs"; \
  const body = Buffer.from(await (await fetch(process.env.SUPERCRONIC_URL)).arrayBuffer()); \
  if (createHash("sha256").update(body).digest("hex") !== process.env.SUPERCRONIC_SHA256) throw new Error("supercronic checksum mismatch"); \
  writeFileSync("/usr/local/bin/supercronic", body, { mode: 0o755 });'

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib ./lib
COPY jobs ./jobs
COPY config ./config
COPY prompts ./prompts
COPY crontab ./

ENV TZ=Asia/Taipei
USER node
CMD ["supercronic", "/app/crontab"]
