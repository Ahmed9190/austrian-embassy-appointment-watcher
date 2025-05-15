# Use a lightweight Node.js image
FROM node:24.0.1-alpine3.21


# Install any system dependencies needed for Node.js
RUN apk --no-cache add \
  ca-certificates

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
