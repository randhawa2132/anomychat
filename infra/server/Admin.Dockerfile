FROM node:22-alpine
WORKDIR /app
COPY infra/local/admin-server.mjs infra/local/admin.html infra/local/admin.js infra/local/admin.css /app/infra/local/
USER node
EXPOSE 5174
CMD ["node", "/app/infra/local/admin-server.mjs"]
