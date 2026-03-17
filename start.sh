#!/bin/bash
NODE=/opt/homebrew/opt/node@22/bin/node
DIR="/Users/danielthompson/Coding/IB - V.O."

echo "Starting backend..."
$NODE "$DIR/server/index.js" &

echo "Starting frontend..."
$NODE "$DIR/client/node_modules/.bin/vite" "$DIR/client" --port 5173 &

echo "Done — open http://localhost:5173"
wait
