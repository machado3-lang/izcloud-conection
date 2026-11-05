# Dockerfile — iZCloud (Node + Express)
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
# 3100 = API/UI. 443 = canal iDCloud (REP). A Railway expoe so a PORT web; o
# canal precisa de um relay TCP/IP fixo (ver docs/PROTOCOLOS.md §13).
EXPOSE 3100 443
CMD ["node", "server.js"]
