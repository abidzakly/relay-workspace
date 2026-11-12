#!/bin/sh
# The dashboard refuses to bind anything but 127.0.0.1, which Docker cannot publish.
# socat bridges container port 8080 to it; compose publishes 8080 on the HOST's 127.0.0.1 only,
# so the dashboard is still reachable from this machine alone. The Host header passes through
# unchanged (127.0.0.1:3000), so the server's Host/Origin allowlist keeps working.
set -eu

socat TCP-LISTEN:8080,fork,reuseaddr TCP:127.0.0.1:"${DASHBOARD_PORT:-3000}" &

exec node dist/index.js "$@"
