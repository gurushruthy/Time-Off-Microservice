FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm install
RUN npm rebuild better-sqlite3
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "dist/src/main"]
