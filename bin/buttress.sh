#!/bin/bash

# Buttress - The federated real-time open data platform
# Copyright (C) 2016-2026 Data People Connected LTD.
# <https://www.dpc-ltd.com/>
# 
# This file is part of Buttress.
# Buttress is free software: you can redistribute it and/or modify it under the
# terms of the GNU Affero General Public Licence as published by the Free Software
# Foundation, either version 3 of the Licence, or (at your option) any later version.
# Buttress is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
# without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
# See the GNU Affero General Public Licence for more details.
# You should have received a copy of the GNU Affero General Public Licence along with
# this program. If not, see <http://www.gnu.org/licenses/>.

readonly BASE_DIR="$(dirname "$(realpath -s "$0")")"

# Take in first param as APP_TYPE
APP_TYPE="${APP_TYPE:-ALL}"
# Convert string to uppercase
APP_TYPE=${APP_TYPE^^}

echo "Launching APP_TYPE: ${APP_TYPE}"

NAMES=()
PIDS=()
STOPPING=

start() {
  # Don't start anything once we've been asked to stop
  [ -n "$STOPPING" ] && return

  echo "Starting $1"
  "$BASE_DIR/$2" 2>&1 &
  NAMES+=("$1")
  PIDS+=("$!")
}

# Ask every process to shut down cleanly. This always sends SIGTERM, as until an app script has exec'd
# node it's a background job of this shell, and those ignore SIGINT. It can run more than once, as a trap
# can fire between starting a process and adding it to PIDS, and node ignores repeats.
stop() {
  STOPPING=1

  kill -TERM "${PIDS[@]}" 2>/dev/null
}

trap 'echo "Received SIGTERM, stopping"; stop' TERM
trap 'echo "Received SIGINT, stopping"; stop' INT

if [ "$APP_TYPE" == "REST" ]
then
  start REST app.sh
elif [ "$APP_TYPE" == "SPR" ]
then
  start SPR app-spr.sh
elif [ "$APP_TYPE" == "SOCK" ]
then
  start Socket app-socket.sh
elif [ "$APP_TYPE" == "LAMB" ]
then
  start Lambda app-lambda.sh
else
  start REST app.sh
  start SPR app-spr.sh
  start Socket app-socket.sh
  start Lambda app-lambda.sh
fi

# Wait for any process to exit, or for a signal, then stop the rest
wait -n
stop

# Exit with the first non-zero status, or 0 if every process stopped cleanly
STATUS=0
for i in "${!PIDS[@]}"; do
  # wait returns early when a signal is trapped, so keep waiting until the process has gone
  while kill -0 "${PIDS[$i]}" 2>/dev/null; do wait "${PIDS[$i]}"; done
  wait "${PIDS[$i]}"
  CODE=$?

  echo "${NAMES[$i]} exited with status $CODE"
  [ "$STATUS" -eq 0 ] && STATUS=$CODE
done

exit $STATUS
