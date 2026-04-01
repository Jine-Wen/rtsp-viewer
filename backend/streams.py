"""StreamManager：串流狀態管理與 MediaMTX 整合"""

import re
import json
import asyncio
import threading
import logging

import httpx

from datetime import datetime
from typing import List

from config import STREAMS_FILE, MEDIAMTX_API
from models import StreamConfig, StreamResponse
import mediamtx as _mediamtx_mod

logger = logging.getLogger(__name__)


class StreamManager:
    def __init__(self):
        self.streams: dict[str, StreamConfig] = {}
        self.stream_status: dict[str, dict] = {}
        self.manual_stopped: set = set()
        self._load_streams()
        self._status_thread = threading.Thread(target=self._check_status_loop, daemon=True)
        self._status_thread.start()
        logger.info("StreamManager initialized")

    # ── 持久化 ────────────────────────────────────────────────────────────────

    def _load_streams(self):
        if STREAMS_FILE.exists():
            try:
                with open(STREAMS_FILE, 'r') as f:
                    data = json.load(f)
                    self.streams = {s['id']: StreamConfig(**s) for s in data}
                logger.info(f"Loaded {len(self.streams)} streams")
            except Exception as e:
                logger.error(f"Failed to load streams: {e}")

    def _save_streams(self):
        try:
            with open(STREAMS_FILE, 'w') as f:
                json.dump([s.dict() for s in self.streams.values()], f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save streams: {e}")

    # ── MediaMTX 狀態查詢 ─────────────────────────────────────────────────────

    async def _check_stream_online(self, stream_id: str) -> bool:
        """Check if stream is ready via MediaMTX API."""
        try:
            stream = self.streams.get(stream_id)
            if stream:
                ru = stream.rtsp_url
                if ru.startswith("http://localhost:8888") or ru.startswith("http://127.0.0.1:8888"):
                    m = re.search(r'(?:localhost|127\.0\.0\.1):8888/([^/]+)', ru)
                    mtx_path = m.group(1) if m else stream_id
                else:
                    mtx_path = stream_id
            else:
                mtx_path = stream_id

            async with httpx.AsyncClient(timeout=3) as client:
                response = await client.get(f"{MEDIAMTX_API}/v3/paths/get/{mtx_path}")
                if response.status_code == 200:
                    return response.json().get("ready", False)
                return False
        except Exception as e:
            logger.debug(f"Stream {stream_id} check failed: {e}")
            return False

    def _check_status_loop(self):
        async def check_all():
            while True:
                try:
                    # MediaMTX 未執行時，跳過 HTTP 查詢，直接標記所有非 manual_stopped 的
                    # stream 為 offline，避免每個 httpx 請求逾時 3 秒卡住 event loop
                    if not _mediamtx_mod.is_running():
                        now_iso = datetime.now().isoformat()
                        for stream_id in list(self.streams.keys()):
                            self.stream_status[stream_id] = {
                                "status": "offline",
                                "last_checked": now_iso,
                            }
                        await asyncio.sleep(5)
                        continue

                    for stream_id in list(self.streams.keys()):
                        if stream_id in self.manual_stopped:
                            self.stream_status[stream_id] = {
                                "status": "offline",
                                "last_checked": datetime.now().isoformat(),
                            }
                            continue
                        status = await self._check_stream_online(stream_id)
                        self.stream_status[stream_id] = {
                            "status": "online" if status else "offline",
                            "last_checked": datetime.now().isoformat(),
                        }
                    await asyncio.sleep(5)
                except Exception as e:
                    logger.error(f"Status check error: {e}")
                    await asyncio.sleep(5)

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(check_all())
        finally:
            loop.close()

    # ── CRUD ──────────────────────────────────────────────────────────────────

    def add_stream(self, stream: StreamConfig) -> StreamConfig:
        self.streams[stream.id] = stream
        self._save_streams()
        logger.info(f"Added stream: {stream.id}")
        return stream

    def update_stream(self, stream_id: str, stream: StreamConfig) -> StreamConfig:
        if stream_id not in self.streams:
            raise ValueError(f"Stream {stream_id} not found")
        self.streams[stream_id] = stream
        self._save_streams()
        return stream

    def delete_stream(self, stream_id: str):
        if stream_id not in self.streams:
            raise ValueError(f"Stream {stream_id} not found")
        del self.streams[stream_id]
        if stream_id in self.stream_status:
            del self.stream_status[stream_id]
        self._save_streams()

    # ── 回應組裝 ──────────────────────────────────────────────────────────────

    def get_stream_response(self, stream_config: StreamConfig) -> StreamResponse:
        status_info = self.stream_status.get(
            stream_config.id,
            {"status": "unknown", "last_checked": datetime.now().isoformat()},
        )
        ru = stream_config.rtsp_url
        if ru.startswith("http://localhost:8888") or ru.startswith("http://127.0.0.1:8888"):
            hls_url = ru
            m = re.search(r'(?:localhost|127\.0\.0\.1):8888/([^/]+)', ru)
            webrtc_path = m.group(1) if m else stream_config.id
        else:
            hls_url = f"http://localhost:8888/{stream_config.id}/index.m3u8"
            webrtc_path = stream_config.id

        return StreamResponse(
            id=stream_config.id,
            name=stream_config.name,
            rtsp_url=stream_config.rtsp_url,
            group=stream_config.group,
            role=stream_config.role,
            status=status_info["status"],
            webrtc_url=f"http://localhost:8889/{webrtc_path}/whep",
            hls_url=hls_url,
            rtsp_url_playback=f"rtsp://localhost:8554/{webrtc_path}",
            last_checked=status_info["last_checked"],
        )

    def get_all_streams(self) -> List[StreamResponse]:
        return [self.get_stream_response(s) for s in self.streams.values()]

    def get_stream(self, stream_id: str) -> StreamResponse:
        if stream_id not in self.streams:
            raise ValueError(f"Stream {stream_id} not found")
        return self.get_stream_response(self.streams[stream_id])
