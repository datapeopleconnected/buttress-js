#!/bin/bash

readonly BASE_DIR="$(dirname "$(realpath -s "$0")")"

# Take in first param as APP_TYPE
APP_TYPE="${APP_TYPE:-ALL}"
# Convert string to uppercase
APP_TYPE=${APP_TYPE^^}

echo "Launching APP_TYPE: ${APP_TYPE}"

if [ "$APP_TYPE" == "REST" ]
then
  $BASE_DIR/app.sh 2>&1 &
elif [ "$APP_TYPE" == "SOCK" ]
then
  $BASE_DIR/app-socket.sh 2>&1 &
elif [ "$APP_TYPE" == "LAMB" ]
then
  $BASE_DIR/app-lambda.sh 2>&1 &
else
  # Start the first process
  echo "Starting REST"
  $BASE_DIR/app.sh 2>&1 &

  # Start the second process
  echo "Starting Socket"
  $BASE_DIR/app-socket.sh 2>&1 &

  # Start the third process
  echo "Starting Lambda"
  $BASE_DIR/app-lambda.sh 2>&1 &
fi

# Wait for any process to exit
wait -n

# Exit with status of process that exited first
exit $?
