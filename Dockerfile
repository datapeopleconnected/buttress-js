# syntax=docker/dockerfile:1
FROM node:18-bullseye-slim

WORKDIR /code

ENV APP_TYPE=all

COPY package.json package.json
RUN npm install

WORKDIR /code
COPY . .

CMD ["./bin/buttress.sh"]