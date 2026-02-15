#!/bin/bash

# $1 = name
# $2 = goodreads_id
# $3 = path

docker exec -it book-sync node src/add-user.js "$1" "$2" "$3"