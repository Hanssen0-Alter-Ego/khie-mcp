#!/bin/sh
set -eu
umask 077
command="${1:-serve}"
if [ "$#" -gt 0 ]; then shift; fi
case "$command" in
  serve|enroll|authorize)
    exec node /app/dist/cli.js "$command" "$@"
    ;;
  demo)
    # Explicit wildcard binding inside the private container network. Compose
    # publishes only to the host loopback address; auth/Host checks stay enabled.
    export KHIE_LISTEN_HOST=0.0.0.0
    exec node /app/dist/demo.js "$@"
    ;;
  smoke|read-probe)
    if [ "$command" = read-probe ]; then command=readProbe; fi
    exec node "/app/dist/$command.js" "$@"
    ;;
  *)
    echo 'Use serve, enroll, authorize, demo, smoke, or read-probe.' >&2
    exit 2
    ;;
esac
