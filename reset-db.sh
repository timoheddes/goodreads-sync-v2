#!/bin/bash

# Usage: ./reset-db.sh --confirm   (keeps users)
#        ./reset-db.sh --all       (removes everything)

docker exec -it book-sync node src/reset-db.js "$1"
