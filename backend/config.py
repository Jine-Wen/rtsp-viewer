"""共用設定與路徑常數"""

from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
STREAMS_FILE = Path(__file__).parent / "streams.json"
VESSELS_FILE = Path(__file__).parent / "vessels.json"
FRONTEND_DIR = PROJECT_DIR / "frontend"
MEDIAMTX_API = "http://localhost:9997"
MEDIAMTX_YML = PROJECT_DIR / "mediamtx.yml"

# ── 遙測設定 ─────────────────────────────────────────────────────
# 每艘船的 telemetry_ip / telemetry_tcp_port / telemetry_udp_port
# 現在儲存在 vessels.json 每筆資料中
# 以下為自動分配 UDP port 的起始值
TELEMETRY_UDP_PORT_BASE = 10100      # 自動分配起始 port
