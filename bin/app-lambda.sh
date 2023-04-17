#!/bin/bash

# Buttress - The federated real-time open data platform
# Copyright (C) 2016-2022 Data Performance Consultancy LTD.
# <https://dataperformanceconsultancy.com/>
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

cd $( dirname -- "$0"; )

FILE="../dist/bin/app-lambda.js"
if [ ! -f "$FILE" ]; then
	echo -e "😱😱 Oh no, unable to find built files for app-lambda! Please run '\033[1mnpm run build\033[0m' first!"
	exit;
fi

node $FILE