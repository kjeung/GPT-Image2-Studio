#!/bin/sh
# Container entrypoint for GPT-Image2-Studio.
#
# Starts the retention GC in the background, then hands PID 1 over to the
# application via exec so that `docker stop` reaches it directly. The GC is
# optional and never gates startup: if it dies, the studio keeps serving.
set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "${STUDIO_RETENTION_ENABLED:-1}" != "0" ]; then
  node "$SCRIPT_DIR/retention-gc.mjs" --daemon &
fi

exec "$@"
