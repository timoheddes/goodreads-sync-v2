#!/bin/bash

# $1 = name
# $2 = goodreads_id
# $3 = path
# $4 = email (optional)

docker exec -it book-sync node src/add-user.js "$1" "$2" "$3" "$4"