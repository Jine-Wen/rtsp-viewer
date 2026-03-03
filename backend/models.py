"""Pydantic 資料模型"""

from typing import Optional
from pydantic import BaseModel


class StreamConfig(BaseModel):
    id: str
    name: str
    rtsp_url: str
    group: str = "default"
    role: str = "main"


class StreamResponse(BaseModel):
    id: str
    name: str
    rtsp_url: str
    group: str
    role: str
    status: str
    webrtc_url: Optional[str]
    hls_url: Optional[str]
    rtsp_url_playback: Optional[str]
    last_checked: str


class VesselConfig(BaseModel):
    id: str
    name: str
    icon: str = "🚢"
    meta: str = ""
    telemetry_ip: str = ""            # 船上 VPN IP（空 = 不連線遙測）
    telemetry_tcp_port: int = 10000   # 船上 TCP 登記 port
    telemetry_udp_port: int = 0       # 本機 UDP 監聽 port（0 = 自動分配）
