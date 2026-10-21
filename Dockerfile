# AegisCode AI — deployment image
#
# One image carries: the core + the server + the web UI.
# No external dependencies — so no build stage is needed.
#
# Isolation note: inside an unprivileged container unshare is rejected
# (CAP_SYS_ADMIN is missing), and the system documents that in every report as
# network_namespace: "none" with the reason — no isolation is ever claimed that
# does not exist.

FROM node:20-alpine

WORKDIR /app

# Copy only the packages — tests and docs are not shipped to production.
COPY core/package.json ./core/
COPY server/package.json ./server/
COPY core/src ./core/src
COPY core/bin ./core/bin
COPY core/fixtures ./core/fixtures
COPY core/scenarios ./core/scenarios
COPY server/src ./server/src
COPY server/bin ./server/bin
COPY web ./web

# The unprivileged user: even if someone compromises the code under test, it
# holds no privileges on the system.
RUN addgroup -S ac && adduser -S ac -G ac && mkdir -p /data && chown -R ac:ac /data
USER ac

ENV NODE_ENV=production
EXPOSE 8080
VOLUME ["/data"]

# TCP check only — port 8080 listens after token validation succeeds and the
# server has booted. (/api/health is deliberately auth-protected, so it is not
# used here.)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD nc -z 127.0.0.1 8080 || exit 1

CMD ["node", "server/bin/aegiscode-server.js", "--host", "0.0.0.0", "--port", "8080", "--data", "/data"]
