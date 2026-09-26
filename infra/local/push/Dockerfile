FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "server.mjs"]
