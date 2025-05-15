# Use a lightweight Node.js image
FROM node:23.11.0-alpine3.19

# Install any system dependencies needed for Node.js
RUN apk --no-cache add \
  ca-certificates

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
