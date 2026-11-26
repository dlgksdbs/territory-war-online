FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js friends.js ./
COPY public ./public

EXPOSE 3000
USER node
CMD ["node", "server.js"]
