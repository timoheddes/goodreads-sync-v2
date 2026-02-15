FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create data and tmp directories
RUN mkdir -p /app/data /app/data/tmp

CMD ["node", "src/index.js"]
