"""健康檢查 & MediaMTX 狀態 API"""

import httpx
from datetime import datetime
from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.get("/api/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            response = await client.get("http://localhost:8888/")
            mediamtx_ok = response.status_code in (200, 404)
    except Exception:
        mediamtx_ok = False

    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "mediamtx": "connected" if mediamtx_ok else "disconnected",
    }


@router.get("/api/mediamtx/stats")
async def mediamtx_stats():
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get("http://localhost:8888/")
            if response.status_code in (200, 404):
                return {
                    "status": "ok",
                    "timestamp": datetime.now().isoformat(),
                    "hls_address": "http://localhost:8888",
                    "webrtc_address": "http://localhost:8889",
                }
            else:
                raise HTTPException(status_code=500, detail="MediaMTX unavailable")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"MediaMTX unavailable: {str(e)}")
