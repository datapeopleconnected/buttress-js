# syntax=docker/dockerfile:1
FROM node:fermium-bullseye-slim

WORKDIR /code

ENV APP_TYPE=all

ARG NPM_TOKEN
COPY .npmrc .npmrc
COPY package.json package.json
RUN npm install
RUN rm -f .npmrc

WORKDIR /code
COPY . .

CMD ["./bin/buttress.sh"]