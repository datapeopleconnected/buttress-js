# syntax=docker/dockerfile:1
FROM node:18-bullseye-slim

WORKDIR /code

ENV APP_TYPE=all

WORKDIR /code
COPY . .

RUN ls -la

COPY package.json package.json
RUN npm install
RUN npm run build

CMD ["./bin/buttress.sh"]