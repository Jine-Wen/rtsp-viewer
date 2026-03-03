"""遙測 WebSocket & API 路由 — 多船版本"""

import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from pydantic import BaseModel

from telemetry import telemetry_manager, VesselBroadcaster
from vessels import load_vessels, save_vessels

logger = logging.getLogger(__name__)

router = APIRouter()


# ── WebSocket：前端訂閱特定船隻的遙測 ────────────────────────────────────────

@router.websocket("/ws/telemetry/{vessel_id}")
async def ws_telemetry(websocket: WebSocket, vessel_id: str):
    """前端連線此 WebSocket 即時接收指定船隻的遙測資料"""
    broadcaster = telemetry_manager.get_broadcaster(vessel_id)
    if not broadcaster:
        # 該船沒有遙測連線，但仍允許 WebSocket 連線（之後啟動遙測時會收到資料）
        # 建立一個臨時的 broadcaster 給它掛著
        await websocket.accept()
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        return

    await broadcaster.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        broadcaster.disconnect(websocket)
    except Exception:
        broadcaster.disconnect(websocket)


# ── REST API ─────────────────────────────────────────────────────────────────

@router.get("/api/telemetry/status")
async def telemetry_status_all():
    """回傳所有船隻遙測連線狀態"""
    return telemetry_manager.all_status()


@router.get("/api/telemetry/status/{vessel_id}")
async def telemetry_status_vessel(vessel_id: str):
    """回傳指定船隻的遙測連線狀態"""
    link = telemetry_manager.get_link(vessel_id)
    if not link:
        return {
            "vessel_id": vessel_id,
            "running": False,
            "ws_clients": 0,
            "latest": None,
            "message": "No telemetry configured for this vessel"
        }
    return link.status_dict()


class TelemetryConfigRequest(BaseModel):
    telemetry_ip: str
    telemetry_tcp_port: int = 10000
    telemetry_udp_port: int = 0  # 0 = 自動分配


@router.post("/api/telemetry/config/{vessel_id}")
async def update_vessel_telemetry(vessel_id: str, cfg: TelemetryConfigRequest):
    """
    動態更新指定船隻的遙測設定。
    - 更新 vessels.json 中的欄位
    - 若 telemetry_ip 非空，立即啟動（或重啟）該船的遙測連線
    - 若 telemetry_ip 為空，停止該船的遙測
    """
    # 更新 vessels.json
    vessels = load_vessels()
    vessel = next((v for v in vessels if v["id"] == vessel_id), None)
    if not vessel:
        raise HTTPException(status_code=404, detail=f"Vessel '{vessel_id}' not found")

    vessel["telemetry_ip"] = cfg.telemetry_ip
    vessel["telemetry_tcp_port"] = cfg.telemetry_tcp_port
    vessel["telemetry_udp_port"] = cfg.telemetry_udp_port
    save_vessels(vessels)

    # 啟動或停止遙測連線
    if cfg.telemetry_ip:
        result = await telemetry_manager.restart_vessel(
            vessel_id, cfg.telemetry_ip, cfg.telemetry_tcp_port, cfg.telemetry_udp_port
        )
        logger.info(f"[Telemetry] Started/restarted {vessel_id}: {cfg.telemetry_ip}:{cfg.telemetry_tcp_port}")
        return {"status": "started", **result}
    else:
        await telemetry_manager.stop_vessel(vessel_id)
        logger.info(f"[Telemetry] Stopped {vessel_id}")
        return {"status": "stopped", "vessel_id": vessel_id}


@router.delete("/api/telemetry/{vessel_id}")
async def stop_vessel_telemetry(vessel_id: str):
    """停止指定船隻的遙測連線（不修改 vessels.json）"""
    await telemetry_manager.stop_vessel(vessel_id)
    return {"status": "stopped", "vessel_id": vessel_id}
