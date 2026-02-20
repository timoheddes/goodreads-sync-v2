FROM node:20-alpine

WORKDIR /app

# Chromium for browser-based downloads (Cloudflare TLS fingerprint bypass)
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create data and tmp directories
RUN mkdir -p /app/data /app/data/tmp

CMD ["node", "src/index.js"]
