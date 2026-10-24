FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY db ./db
USER node
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
