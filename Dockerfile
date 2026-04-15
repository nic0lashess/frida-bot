FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
