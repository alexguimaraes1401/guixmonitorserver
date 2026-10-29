FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV JT808_PORT=7611
ENV JT808_AUTH_CODE=local-test-auth
ENV DASHBOARD_PORT=8080
ENV JT1078_RTSP_BASE_URL=rtsp://mediamtx:8554

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY src ./src
COPY web ./web

USER node

EXPOSE 7611/tcp
EXPOSE 8080/tcp
EXPOSE 1078/tcp

CMD ["node", "src/server.js"]
