# Test container for the ModuleWarden gate.
#
# This container intentionally has no network access to the public
# internet; it can only reach the MW gate over the private bridge
# network defined in docker-compose.yml. The filesystem is read-only
# with a small tmpfs at /tmp so any malicious postinstall script could
# not persist a payload even if --ignore-scripts were bypassed.

FROM node:22-alpine

WORKDIR /work

# Pre-copy package.json + .npmrc + the test harness so the layer cache
# survives across runs.
COPY package.json .npmrc expected.json test-gate.sh ./

# bash and curl are needed by the test harness for verdict assertions
# against the gate's status API.
RUN apk add --no-cache bash curl jq

# Ensure the test script is executable.
RUN chmod +x test-gate.sh

# The container's entrypoint runs the gate-verification test.
ENTRYPOINT ["bash", "/work/test-gate.sh"]
