# Dockerfile — iZCloud (Node + Express)
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3100
CMD ["node", "server.js"]
