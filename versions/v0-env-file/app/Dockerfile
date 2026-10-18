# v0 of Secure Notes (the "before" picture). Never published.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
COPY public ./public
USER 1000
EXPOSE 3000
CMD ["node", "server.js"]
