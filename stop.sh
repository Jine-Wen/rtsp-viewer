#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "Stopping RTSP Stream Viewer services..."

# Kill MediaMTX
if pgrep -f "mediamtx.*mediamtx.yml" > /dev/null; then
    pkill -f "mediamtx.*mediamtx.yml"
    echo "✓ MediaMTX stopped"
fi

# Kill Python backend
if pgrep -f "uvicorn.*main:app" > /dev/null; then
    pkill -f "uvicorn.*main:app"
    echo "✓ Backend stopped"
fi

echo "All services stopped"
