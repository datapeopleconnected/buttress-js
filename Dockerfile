# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS builder

ENV APP_TYPE=all

ENV BUTTRESS_APP_PATH=/opt/buttress

WORKDIR /opt/buttress

COPY . .

RUN npm ci
RUN npm run build

# Production stage
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y git openssh-client && apt-get clean

COPY --from=builder /opt/buttress/bin /opt/buttress/bin
COPY --from=builder /opt/buttress/node_modules /opt/buttress/node_modules
COPY --from=builder /opt/buttress/dist /opt/buttress/dist
COPY --from=builder /opt/buttress/LICENSE /opt/buttress/LICENSE
COPY --from=builder /opt/buttress/package.json /opt/buttress/package.json

RUN mkdir -p /opt/buttress/app_data

WORKDIR /opt/buttress

CMD ["./bin/buttress.sh"]