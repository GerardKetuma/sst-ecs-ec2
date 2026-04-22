FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install hono @hono/node-server --omit=dev
COPY index.js ./
EXPOSE 3000
CMD ["node", "index.js"]
