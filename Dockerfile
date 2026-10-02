FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "src/server.js"]
