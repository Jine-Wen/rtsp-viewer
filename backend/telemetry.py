"""
多船遙測管理器
- 每艘設定了 telemetry_ip 的船隻，各自擁有獨立的 UDP 監聽 + TCP 登記迴圈
- 每艘船有獨立的 WebSocket 廣播器，前端透過 /ws/telemetry/{vessel_id} 訂閱
- TelemetryManager 提供新增/移除/重啟個別船隻遙測連線的能力
"""

import json
import struct
import socket
import asyncio
import logging
import time
from typing import Dict, Optional

from fastapi import WebSocket
from fastapi.websockets import WebSocketState

from config import TELEMETRY_UDP_PORT_BASE
from vessels import load_vessels

logger = logging.getLogger(__name__)

# ── 封包解析 ──────────────────────────────────────────────────────────────────

_GEAR_MAP = {'0': 'F', '1': 'N', '2': 'R', '3': 'X'}


def _decode_gear(code: int) -> str:
    return 'N/A' if code == 0xF else _GEAR_MAP.get(str(code), 'Unknown')


def parse_telemetry_packet(data: bytes) -> dict | None:
    """解析船上 UDP 封包（0xA1 控制資料 / 0xAA GPS），回傳 dict 或 None"""
    if not data:
        return None
    header = data[0]

    # 0xA1：引擎 + 控制資料（74 bytes）
    if header == 0xA1 and len(data) == 74:
        try:
            unpacked = struct.unpack('<BBiiiiBBB16siiiffffffB', data)
            (_, length,
             left_rpm, right_rpm, left_lever, right_lever,
             gear_byte, autopilot_mode, led_byte,
             control_status_raw,
             throttle, steering, rudder,
             sog, cog, heading, roll, pitch, yaw,
             end) = unpacked
            if end != 0xB1 or length != 71:
                return None
            control_status = control_status_raw.decode('utf-8', errors='ignore').rstrip('\x00').strip()
            return {
                "type": "control",
                "left_rpm": left_rpm,        "right_rpm": right_rpm,
                "left_lever": left_lever,    "right_lever": right_lever,
                "left_gear": _decode_gear((gear_byte >> 4) & 0xF),
                "right_gear": _decode_gear(gear_byte & 0xF),
                "autopilot_mode": autopilot_mode,
                "neutral_led": (led_byte >> 4) & 0xF,
                "active_led":  led_byte & 0xF,
                "control_status": control_status,
                "throttle": abs(throttle),   "steering": steering,   "rudder": rudder,
                "sog": round(sog, 2),        "cog": round(cog, 2),
                "heading": round(heading, 2),"roll": round(roll, 2),
                "pitch": round(pitch, 2),    "yaw": round(yaw, 2),
            }
        except Exception as e:
            logger.warning(f"[UDP:CTRL] parse error: {e}")
            return None

    # 0xAA：GPS 資料（31 bytes）
    elif header == 0xAA and len(data) == 31:
        try:
            _, length, seq, stamp, lat, lon, end = struct.unpack('<BBIdddB', data)
            if end != 0xBB or length != 28:
                return None
            return {"type": "gps", "lat": lat, "lon": lon}
        except Exception as e:
            logger.warning(f"[UDP:GPS] parse error: {e}")
            return None

    return None


# ── 單船 WebSocket 廣播器 ────────────────────────────────────────────────────

class VesselBroadcaster:
    """管理單一船隻的 WebSocket 連線並廣播遙測資料"""

    def __init__(self, vessel_id: str):
        self.vessel_id = vessel_id
        self._connections: list[WebSocket] = []
        self._latest: dict = {}

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self._connections.append(ws)
        if self._latest:
            try:
                await ws.send_json(self._latest)
            except Exception:
                pass

    def disconnect(self, ws: WebSocket):
        self._connections = [c for c in self._connections if c is not ws]

    async def broadcast(self, data: dict):
        self._latest = data
        if not self._connections:
            return
        # 預先序列化一次 JSON，避免每個 client 都 json.dumps
        payload = json.dumps(data)
        dead = []

        async def _send(ws):
            try:
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.send_text(payload)
            except Exception:
                dead.append(ws)

        # 並行發送給所有 client
        await asyncio.gather(*[_send(ws) for ws in self._connections],
                             return_exceptions=True)
        for ws in dead:
            self.disconnect(ws)

    @property
    def client_count(self) -> int:
        return len(self._connections)

    @property
    def latest(self) -> dict:
        return self._latest


# ── 單船 UDP Protocol ────────────────────────────────────────────────────────

class VesselUDPProtocol(asyncio.DatagramProtocol):
    """接收某艘船的 UDP 封包，解析後節流廣播給該船的 WebSocket 客戶端"""

    BROADCAST_INTERVAL = 0.05  # 最小廣播間隔 = 20 FPS

    def __init__(self, vessel_id: str, broadcaster: VesselBroadcaster,
                 loop: asyncio.AbstractEventLoop):
        self.vessel_id = vessel_id
        self._broadcaster = broadcaster
        self._loop = loop
        self._last_broadcast = 0.0
        self._pending = None
        self._flush_handle = None

    def datagram_received(self, data: bytes, addr):
        parsed = parse_telemetry_packet(data)
        if not parsed:
            return
        parsed["vessel_id"] = self.vessel_id

        now = time.monotonic()
        if now - self._last_broadcast >= self.BROADCAST_INTERVAL:
            self._last_broadcast = now
            self._pending = None
            if self._flush_handle:
                self._flush_handle.cancel()
                self._flush_handle = None
            asyncio.ensure_future(self._broadcaster.broadcast(parsed))
        else:
            self._pending = parsed
            if not self._flush_handle:
                delay = self.BROADCAST_INTERVAL - (now - self._last_broadcast)
                self._flush_handle = self._loop.call_later(delay, self._flush)

    def _flush(self):
        """延遲發送暫存的最新資料"""
        self._flush_handle = None
        if self._pending:
            data = self._pending
            self._pending = None
            self._last_broadcast = time.monotonic()
            asyncio.ensure_future(self._broadcaster.broadcast(data))

    def error_received(self, exc):
        logger.warning(f"[UDP:{self.vessel_id}] error: {exc}")


# ── 單船連線封裝 ──────────────────────────────────────────────────────────────

class VesselTelemetryLink:
    """封裝單艘船的完整遙測連線：UDP 端點 + TCP 登記 + 廣播器"""

    def __init__(self, vessel_id: str, vessel_ip: str, tcp_port: int, udp_port: int):
        self.vessel_id = vessel_id
        self.vessel_ip = vessel_ip
        self.tcp_port = tcp_port
        self.udp_port = udp_port
        self.broadcaster = VesselBroadcaster(vessel_id)
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._tcp_task: Optional[asyncio.Task] = None
        self._running = False

    async def start(self, loop: asyncio.AbstractEventLoop):
        """啟動 UDP 監聽 + TCP 登記迴圈"""
        if self._running:
            return
        self._running = True

        try:
            transport, _ = await loop.create_datagram_endpoint(
                lambda: VesselUDPProtocol(self.vessel_id, self.broadcaster, loop),
                local_addr=("0.0.0.0", self.udp_port),
            )
            self._transport = transport
            logger.info(f"[Telemetry:{self.vessel_id}] UDP listening on port {self.udp_port}")
        except OSError as e:
            logger.error(f"[Telemetry:{self.vessel_id}] Cannot bind UDP port {self.udp_port}: {e}")
            self._running = False
            return

        self._tcp_task = asyncio.create_task(self._tcp_register_loop(loop))

    async def stop(self):
        """停止此船的遙測連線"""
        self._running = False
        if self._tcp_task and not self._tcp_task.done():
            self._tcp_task.cancel()
            try:
                await self._tcp_task
            except asyncio.CancelledError:
                pass
        if self._transport:
            self._transport.close()
            self._transport = None
        logger.info(f"[Telemetry:{self.vessel_id}] stopped")

    async def _tcp_register_loop(self, loop: asyncio.AbstractEventLoop):
        """每 3 秒向船上 TCP port 發送「本機IP:UDP_PORT」登記訊息（全非阻塞）"""
        # 用 UDP trick 取得本機對外 IP（不實際傳送資料）
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((self.vessel_ip, self.tcp_port))
            local_ip = s.getsockname()[0]
            s.close()
        except Exception:
            local_ip = "127.0.0.1"

        register_msg = f"{local_ip}:{self.udp_port}\n".encode()
        logger.info(
            f"[Telemetry:{self.vessel_id}] Register as {local_ip}:{self.udp_port}"
            f" → vessel {self.vessel_ip}:{self.tcp_port}"
        )

        reader, writer = None, None

        while self._running:
            # ── 確保連線 ──
            if writer is None:
                try:
                    reader, writer = await asyncio.wait_for(
                        asyncio.open_connection(self.vessel_ip, self.tcp_port),
                        timeout=3.0
                    )
                    logger.info(f"[Telemetry:{self.vessel_id}] TCP connected (async)")
                except (OSError, asyncio.TimeoutError) as e:
                    logger.warning(f"[Telemetry:{self.vessel_id}] TCP connect failed: {e}")
                    reader, writer = None, None
                    await asyncio.sleep(3)
                    continue

            # ── 發送登記訊息 ──
            try:
                writer.write(register_msg)
                await writer.drain()
                logger.debug(f"[Telemetry:{self.vessel_id}] Registered")
            except Exception as e:
                logger.warning(f"[Telemetry:{self.vessel_id}] TCP send failed: {e}")
                try:
                    writer.close()
                    await writer.wait_closed()
                except Exception:
                    pass
                reader, writer = None, None
                await asyncio.sleep(1)
                continue

            # ── 嘗試讀取回應（非阻塞，有就讀、沒有就跳過）──
            try:
                resp = await asyncio.wait_for(reader.read(256), timeout=0.05)
                if not resp:
                    raise ConnectionResetError("vessel closed connection")
            except asyncio.TimeoutError:
                pass
            except Exception as e:
                logger.warning(f"[Telemetry:{self.vessel_id}] TCP recv error: {e}")
                try:
                    writer.close()
                    await writer.wait_closed()
                except Exception:
                    pass
                reader, writer = None, None

            await asyncio.sleep(3)

    @property
    def is_running(self) -> bool:
        return self._running

    def status_dict(self) -> dict:
        return {
            "vessel_id": self.vessel_id,
            "vessel_ip": self.vessel_ip,
            "tcp_port": self.tcp_port,
            "udp_port": self.udp_port,
            "running": self._running,
            "ws_clients": self.broadcaster.client_count,
            "latest": self.broadcaster.latest or None,
        }


# ── TelemetryManager（全域管理器）────────────────────────────────────────────

class TelemetryManager:
    """管理所有船隻的遙測連線"""

    def __init__(self):
        self._links: Dict[str, VesselTelemetryLink] = {}
        self._next_auto_port = TELEMETRY_UDP_PORT_BASE
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def _alloc_port(self) -> int:
        """分配一個尚未使用的 UDP port"""
        used = {link.udp_port for link in self._links.values()}
        port = self._next_auto_port
        while port in used:
            port += 1
        self._next_auto_port = port + 1
        return port

    async def start_all(self):
        """從 vessels.json 讀取所有有 telemetry_ip 的船隻並啟動連線"""
        self._loop = asyncio.get_event_loop()
        vessels = load_vessels()
        started = 0
        for v in vessels:
            ip = v.get("telemetry_ip", "")
            if not ip:
                continue
            vid = v["id"]
            tcp_port = v.get("telemetry_tcp_port", 10000)
            udp_port = v.get("telemetry_udp_port", 0)
            if udp_port == 0:
                udp_port = self._alloc_port()
            await self.start_vessel(vid, ip, tcp_port, udp_port)
            started += 1
        logger.info(f"[TelemetryManager] Started {started} vessel telemetry links")

    async def start_vessel(self, vessel_id: str, vessel_ip: str,
                           tcp_port: int = 10000, udp_port: int = 0):
        """啟動單一船隻的遙測連線（若已存在則先停止再重啟）"""
        if not self._loop:
            self._loop = asyncio.get_event_loop()
        if vessel_id in self._links:
            await self._links[vessel_id].stop()
        if udp_port == 0:
            udp_port = self._alloc_port()
        link = VesselTelemetryLink(vessel_id, vessel_ip, tcp_port, udp_port)
        self._links[vessel_id] = link
        await link.start(self._loop)
        return link.status_dict()

    async def stop_vessel(self, vessel_id: str):
        """停止單一船隻的遙測連線"""
        link = self._links.pop(vessel_id, None)
        if link:
            await link.stop()

    async def stop_all(self):
        """停止所有遙測連線"""
        for link in list(self._links.values()):
            await link.stop()
        self._links.clear()

    async def restart_vessel(self, vessel_id: str, vessel_ip: str,
                             tcp_port: int, udp_port: int = 0):
        """重啟單一船隻連線（更新 IP/Port 後）"""
        return await self.start_vessel(vessel_id, vessel_ip, tcp_port, udp_port)

    def get_broadcaster(self, vessel_id: str) -> Optional[VesselBroadcaster]:
        """取得特定船隻的廣播器（供 WebSocket route 使用）"""
        link = self._links.get(vessel_id)
        return link.broadcaster if link else None

    def get_link(self, vessel_id: str) -> Optional[VesselTelemetryLink]:
        return self._links.get(vessel_id)

    def all_status(self) -> list:
        return [link.status_dict() for link in self._links.values()]

    def vessel_ids(self) -> list:
        return list(self._links.keys())


# 全域單例
telemetry_manager = TelemetryManager()
