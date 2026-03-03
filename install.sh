#!/bin/bash
# JetseaAI RTSP Stream Viewer - Install Script (Linux)
# Usage: ./install.sh

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   JetseaAI RTSP Viewer - Install     ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── Step 1: System packages ──────────────────────────
echo -e "${YELLOW}[1/4]${NC} Installing system packages (ffmpeg, python3-venv)..."
sudo apt update -qq
sudo apt install -y ffmpeg python3-venv python3-pip curl wget
echo -e "${GREEN}✓ System packages installed${NC}"

# ── Step 2: MediaMTX ─────────────────────────────────
echo -e "${YELLOW}[2/4]${NC} Installing MediaMTX..."
if command -v mediamtx &> /dev/null; then
    echo -e "${GREEN}✓ MediaMTX already installed, skipping${NC}"
else
    ARCH=$(uname -m)
    case $ARCH in
        x86_64)  MTX_ARCH="amd64" ;;
        aarch64) MTX_ARCH="arm64v8" ;;
        armv7l)  MTX_ARCH="armv7" ;;
        *)
            echo -e "${RED}✗ Unsupported architecture: $ARCH${NC}"
            exit 1
            ;;
    esac

    MTX_VERSION=$(curl -s https://api.github.com/repos/bluenviron/mediamtx/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
    MTX_URL="https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/mediamtx_${MTX_VERSION}_linux_${MTX_ARCH}.tar.gz"

    echo -e "  Downloading MediaMTX ${MTX_VERSION} (${MTX_ARCH})..."
    wget -q --show-progress "$MTX_URL" -O /tmp/mediamtx.tar.gz
    tar -xzf /tmp/mediamtx.tar.gz -C /tmp mediamtx
    sudo mv /tmp/mediamtx /usr/local/bin/
    rm /tmp/mediamtx.tar.gz
    echo -e "${GREEN}✓ MediaMTX ${MTX_VERSION} installed${NC}"
fi

# ── Step 3: Python venv ──────────────────────────────
echo -e "${YELLOW}[3/4]${NC} Creating Python virtual environment..."
if [ ! -d "backend/venv" ]; then
    python3 -m venv backend/venv
    echo -e "${GREEN}✓ venv created${NC}"
else
    echo -e "${GREEN}✓ venv already exists, skipping${NC}"
fi

# ── Step 4: Python packages ──────────────────────────
echo -e "${YELLOW}[4/4]${NC} Installing Python packages..."
backend/venv/bin/pip install -q --upgrade pip
backend/venv/bin/pip install -q -r backend/requirements.txt
echo -e "${GREEN}✓ Python packages installed${NC}"

# ── Done ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✓ Installation complete!            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Verification:"
echo -e "    ffmpeg   : $(ffmpeg -version 2>&1 | head -1)"
echo -e "    mediamtx : $(mediamtx --version 2>&1 | head -1)"
echo -e "    python3  : $(python3 --version)"
echo ""
echo -e "  🚀 Start the service:"
echo -e "    ${CYAN}./start-linux.sh${NC}"
echo ""
