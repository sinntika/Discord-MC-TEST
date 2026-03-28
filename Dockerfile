FROM node:18-alpine
RUN apk add --no-cache python3 make g++ cmake
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
CMD ["node", "index.js"]
