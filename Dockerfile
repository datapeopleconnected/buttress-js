# syntax=docker/dockerfile:1
FROM node:fermium-bullseye-slim
WORKDIR /code
COPY . .
RUN npm install
CMD ["./bin/buttress.sh"]