# Buttress v2.x in Docker. One image, two services: REST (deploy/app.js) and sockets (deploy/socket-app.js).
# Node 14 is what v2.x instances have run on in production (package.json's engines field predates that).
FROM node:14-bullseye AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx gulp build && npm prune --production

FROM node:14-bullseye-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/deploy ./deploy
USER node
# node-env-obj reads config.json from the working directory and ../.production.env (mounted at /app)
WORKDIR /app/deploy
CMD ["node", "app.js"]
