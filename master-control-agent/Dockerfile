# Master Control agent — lightweight, single-purpose. Built on ai.matthewstevens.org,
# run on a1 (10.0.0.12). No shell tool, no browser, no framework: just node + fetch.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-package-lock typescript@5 @types/node@22
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
# /opt/data holds the seen-set (mc-seen.json). Mount a volume here.
RUN mkdir -p /opt/data
ENTRYPOINT ["./entrypoint.sh"]
CMD ["daemon"]
