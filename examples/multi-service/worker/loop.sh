#!/bin/sh
set -eu
while true; do
  echo "worker heartbeat at $(date -u +%FT%TZ)"
  sleep 10
done
