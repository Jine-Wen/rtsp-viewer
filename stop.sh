#!/bin/bash

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "Stopping RTSP Stream Viewer services..."

# Kill MediaMTX
if pgrep -x "mediamtx" > /dev/null 2>&1; then
    pkill -x "mediamtx" 2>/dev/null
    sleep 1
    pkill -9 -x "mediamtx" 2>/dev/null || true
    echo "✓ MediaMTX stopped"
fi

# Kill Python backend（先 SIGTERM，等 2 秒，再 SIGKILL 確保 port 釋放）
if pgrep -f "uvicorn.*main:app" > /dev/null 2>&1; then
    pkill -f "uvicorn.*main:app" 2>/dev/null || true
    sleep 2
    pkill -9 -f "uvicorn.*main:app" 2>/dev/null || true
    echo "✓ Backend stopped"
fi

echo "All services stopped"
