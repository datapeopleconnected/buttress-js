#!/bin/bash

# Buttress - The federated real-time open data platform
# Copyright (C) 2016-2024 Data People Connected LTD.
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
