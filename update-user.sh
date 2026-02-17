#!/bin/bash

# Usage: ./update-user.sh "104614681" --email "alice@example.com"
#        ./update-user.sh "104614681" --name "Alice B" --email "alice@example.com"

docker exec -it book-sync node src/update-user.js "$@"
