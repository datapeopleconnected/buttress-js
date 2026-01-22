# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS builder

ENV APP_TYPE=all

WORKDIR /opt/buttress

COPY . .

RUN npm ci
RUN npm run build

# Production stage
FROM node:20-bookworm-slim

COPY --from=builder /opt/buttress/bin /opt/buttress/bin
COPY --from=builder /opt/buttress/node_modules /opt/buttress/node_modules
COPY --from=builder /opt/buttress/dist /opt/buttress/dist
COPY --from=builder /opt/buttress/LICENSE /opt/buttress/LICENSE
COPY --from=builder /opt/buttress/package.json /opt/buttress/package.json

RUN mkdir -p /opt/buttress/app_data

WORKDIR /opt/buttress

RUN ls -la

CMD ["./bin/buttress.sh"]