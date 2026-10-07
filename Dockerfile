FROM node:24-bookworm-slim

# ca-certificates: without it Python's urllib cannot verify ALSAP / Trans-Technik TLS
# and an in-app catalog update would scrape nothing from them.
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 4173

CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "4173"]
