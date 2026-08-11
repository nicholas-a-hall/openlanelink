FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY *.js ./
COPY src ./src
EXPOSE 3001
USER node
CMD ["node", "server.js"]
