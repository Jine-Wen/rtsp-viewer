"""Stream（串流）API 路由"""

import re
import asyncio
import logging
from datetime import datetime

import httpx
from fastapi import APIRouter, HTTPException

from config import MEDIAMTX_API
from models import StreamConfig
from streams import StreamManager
import mediamtx

logger = logging.getLogger(__name__)

router = APIRouter()

# StreamManager 全域單例，由 main.py 注入
manager: StreamManager = None  # type: ignore


def init(stream_manager: StreamManager):
    """由 main.py 呼叫，注入 StreamManager 實例"""
    global manager
    manager = stream_manager


def _extract_mediamtx_path(hls_url: str) -> str:
    """從 HLS URL 中抽出 MediaMTX path 名稱"""
    m = (
        re.search(r'localhost:8888/([^/]+)', hls_url)
        or re.search(r'127\.0\.0\.1:8888/([^/]+)', hls_url)
    )
    return m.group(1) if m else ""


# ── CRUD ──────────────────────────────────────────────────────────────────────

@router.get("/api/streams")
async def get_streams():
    return manager.get_all_streams()


@router.post("/api/streams")
async def create_stream(stream: StreamConfig):
    try:
        result = manager.add_stream(stream)
        mediamtx.sync_path(stream.id, stream.rtsp_url)
        return manager.get_stream_response(result)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/streams/{stream_id}")
async def get_stream(stream_id: str):
    try:
        return manager.get_stream(stream_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.put("/api/streams/{stream_id}")
async def update_stream(stream_id: str, stream: StreamConfig):
    try:
        result = manager.update_stream(stream_id, stream)
        mediamtx.sync_path(stream_id, stream.rtsp_url)
        return manager.get_stream_response(result)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/api/streams/{stream_id}")
async def delete_stream(stream_id: str):
    try:
        manager.delete_stream(stream_id)
        mediamtx.remove_path(stream_id)
        return {"status": "deleted", "id": stream_id}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Start / Stop / Refresh ────────────────────────────────────────────────────

@router.post("/api/streams/{stream_id}/start")
async def start_stream(stream_id: str):
    """啟動串流：依 URL 類型決定啟動方式"""
    if stream_id not in manager.streams:
        raise HTTPException(status_code=404, detail=f"Stream {stream_id} not found")

    stream = manager.streams[stream_id]
    rtsp_url = stream.rtsp_url
    manager.manual_stopped.discard(stream_id)

    # Case 1: HLS URL → 內建/轉播路徑
    if rtsp_url.startswith("http://localhost:8888") or rtsp_url.startswith("http://127.0.0.1:8888"):
        mtx_path = _extract_mediamtx_path(rtsp_url)
        if not mtx_path:
            raise HTTPException(status_code=400, detail=f"Cannot parse MediaMTX path from URL: {rtsp_url}")
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{MEDIAMTX_API}/v3/paths/get/{mtx_path}")
                if resp.status_code == 200 and resp.json().get("ready"):
                    manager.stream_status[stream_id] = {
                        "status": "online",
                        "last_checked": datetime.now().isoformat(),
                    }
                    logger.info(f"Stream {stream_id} online via HLS path '{mtx_path}'")
                    return {"status": "started", "id": stream_id}

                # 嘗試用 PATCH 觸發重啟
                patch_resp = await client.patch(
                    f"{MEDIAMTX_API}/v3/config/paths/patch/{mtx_path}", json={}
                )
                logger.info(f"Patch {mtx_path}: {patch_resp.status_code}")

                for _ in range(5):
                    await asyncio.sleep(1)
                    chk = await client.get(f"{MEDIAMTX_API}/v3/paths/get/{mtx_path}")
                    if chk.status_code == 200 and chk.json().get("ready"):
                        manager.stream_status[stream_id] = {
                            "status": "online",
                            "last_checked": datetime.now().isoformat(),
                        }
                        return {"status": "started", "id": stream_id}

                raise HTTPException(status_code=503, detail=f"MediaMTX path '{mtx_path}' not ready")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # Case 2: RTSP URL → runOnDemand
    manager.stream_status[stream_id] = {
        "status": "starting",
        "last_checked": datetime.now().isoformat(),
    }
    logger.info(f"Stream {stream_id} marked as starting (runOnDemand will trigger on first WHEP connect)")
    return {"status": "starting", "id": stream_id}


@router.post("/api/streams/{stream_id}/stop")
async def stop_stream(stream_id: str):
    """停止串流"""
    if stream_id not in manager.streams:
        raise HTTPException(status_code=404, detail=f"Stream {stream_id} not found")

    manager.manual_stopped.add(stream_id)
    manager.stream_status[stream_id] = {
        "status": "offline",
        "last_checked": datetime.now().isoformat(),
    }

    stream = manager.streams[stream_id]
    if stream.rtsp_url.startswith("http://localhost:8888") or stream.rtsp_url.startswith("http://127.0.0.1:8888"):
        logger.info(f"Stream {stream_id} marked stopped (internal path)")
    else:
        logger.info(f"Stream {stream_id} marked stopped (runOnDemand will auto-stop when no viewers)")

    return {"status": "stopped", "id": stream_id}


@router.get("/api/streams/{stream_id}/refresh")
async def refresh_stream_status(stream_id: str):
    try:
        status = await manager._check_stream_online(stream_id)
        manager.stream_status[stream_id] = {
            "status": "online" if status else "offline",
            "last_checked": datetime.now().isoformat(),
        }
        return manager.get_stream(stream_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
