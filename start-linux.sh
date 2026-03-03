#!/bin/bash
# JetseaAI RTSP Stream Viewer - 啟動腳本 (Linux)
# 使用方式: ./start-linux.sh

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   傑海航運 Fleet Monitor  v2.0       ║"
echo "  ║   JetseaAI RTSP Viewer - Starting    ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── Step 1: 確認 MediaMTX ────────────────────────────
echo -e "${YELLOW}[1/4]${NC} 確認 MediaMTX..."
if ! command -v mediamtx &> /dev/null; then
    echo -e "${RED}✗ MediaMTX 未安裝，請先執行安裝步驟${NC}"
    exit 1
fi
echo -e "${GREEN}✓ MediaMTX $(mediamtx --version 2>&1 | head -1)${NC}"

# ── Step 2: 確認 Python venv ─────────────────────────
echo -e "${YELLOW}[2/4]${NC} 確認 Python 環境..."
if [ ! -d "backend/venv" ]; then
    echo -e "${YELLOW}  建立 venv...${NC}"
    python3 -m venv backend/venv
fi
echo -e "${YELLOW}  安裝/更新套件...${NC}"
backend/venv/bin/pip install -q -r backend/requirements.txt
echo -e "${GREEN}✓ Python 環境就緒${NC}"

# ── Step 3: 啟動 MediaMTX ────────────────────────────
echo -e "${YELLOW}[3/4]${NC} 啟動 MediaMTX..."
pkill -x mediamtx 2>/dev/null && sleep 1

mediamtx "$PROJECT_DIR/mediamtx.yml" > "$PROJECT_DIR/mediamtx.log" 2>&1 &
MEDIAMTX_PID=$!
sleep 2

if ps -p $MEDIAMTX_PID > /dev/null 2>&1; then
    echo -e "${GREEN}✓ MediaMTX 已啟動 (PID: $MEDIAMTX_PID)${NC}"
    echo -e "  HLS:    http://localhost:8888"
    echo -e "  WebRTC: http://localhost:8889"
    echo -e "  API:    http://localhost:9997"
else
    echo -e "${RED}✗ MediaMTX 啟動失敗，查看 mediamtx.log:${NC}"
    tail -10 "$PROJECT_DIR/mediamtx.log"
    exit 1
fi

# ── Step 4: 啟動 FastAPI Backend ─────────────────────
echo -e "${YELLOW}[4/4]${NC} 啟動 FastAPI Backend..."
pkill -f "uvicorn main:app" 2>/dev/null && sleep 1

cd "$PROJECT_DIR/backend"
./venv/bin/uvicorn main:app --host 0.0.0.0 --port 8080 > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 2

if ps -p $BACKEND_PID > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Backend 已啟動 (PID: $BACKEND_PID)${NC}"
else
    echo -e "${RED}✗ Backend 啟動失敗:${NC}"
    tail -10 /tmp/backend.log
    exit 1
fi

# ── 完成 ─────────────────────────────────────────────
cd "$PROJECT_DIR"
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✓ 所有服務啟動完成                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  🌐 前端介面:   ${CYAN}http://localhost:8080${NC}"
echo -e "  📡 MediaMTX:   ${CYAN}http://localhost:8889/test-local${NC}  (WebRTC 測試)"
echo -e "  📋 API 文件:   ${CYAN}http://localhost:8080/docs${NC}"
echo ""
echo -e "  📝 Log:  tail -f $PROJECT_DIR/mediamtx.log"
echo -e "  🛑 停止: ./stop.sh"
echo ""
