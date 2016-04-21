#!/bin/sh

FOREVER="forever start"

if [ "$1" = "-n" ]; then
    FOREVER="nodejs"
fi

exec $FOREVER index.js -c gitter-config.yaml -p 3511
