#!/bin/bash

readonly BASE_DIR="$(dirname "$(realpath -s "$0")")"

# Start the first process
$BASE_DIR/app.js 2>&1 &

# Start the second process
$BASE_DIR/app-socket.js 2>&1 &

# Wait for any process to exit
wait -n

# Exit with status of process that exited first
exit $?