"""MediaMTX 設定檔管理：yml 讀寫、ffprobe 探測、GPU 偵測、自動轉碼策略"""

import subprocess
import logging
import yaml

from config import MEDIAMTX_YML

logger = logging.getLogger(__name__)


# ── GPU 偵測 ──────────────────────────────────────────────────────────────────

def check_gpu() -> bool:
    """檢查 NVIDIA GPU 是否可用（nvidia-smi 執行成功且有裝置）"""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0 and result.stdout.strip() != ""
    except Exception:
        return False


# ── ffprobe 探測 ──────────────────────────────────────────────────────────────

def probe_stream(rtsp_url: str) -> dict:
    """用 ffprobe 探測 RTSP 來源的編碼格式和解析度

    回傳 {'codec': str, 'width': int, 'height': int}
    """
    info = {"codec": "h264", "width": 0, "height": 0}
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-rtsp_transport", "tcp",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_name,width,height",
                "-of", "csv=p=0",
                rtsp_url,
            ],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0 and result.stdout.strip():
            parts = result.stdout.strip().split(",")
            if len(parts) >= 3:
                info["codec"] = parts[0].strip()
                info["width"] = int(parts[1].strip())
                info["height"] = int(parts[2].strip())
            logger.info(f"[probe] {rtsp_url} → codec={info['codec']}, {info['width']}x{info['height']}")
    except Exception as e:
        logger.warning(f"[probe] Failed to probe {rtsp_url}: {e}")
    return info


# ── YAML 讀寫 ─────────────────────────────────────────────────────────────────

def yml_load() -> dict:
    with open(MEDIAMTX_YML, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def yml_save(cfg: dict):
    with open(MEDIAMTX_YML, "w", encoding="utf-8") as f:
        yaml.dump(cfg, f, allow_unicode=True, default_flow_style=False,
                  sort_keys=False, indent=2)


# ── 工具函數 ──────────────────────────────────────────────────────────────────

def is_hls_url(url: str) -> bool:
    """rtsp_url 是否指向本機 HLS 路徑（MediaMTX 內建）"""
    return url.startswith("http://localhost:8888") or url.startswith("http://127.0.0.1:8888")


# ── 自動同步 mediamtx.yml ─────────────────────────────────────────────────────

def sync_path(stream_id: str, rtsp_url: str):
    """新增或更新 mediamtx.yml 裡的路徑設定（僅限 RTSP/RTMP 外部來源）

    自動處理：
    - 探測來源編碼格式 (H264/HEVC) 和解析度
    - HEVC 來源 → GPU 硬體解碼 (hevc_cuvid) + GPU 縮放 (scale_cuda)
    - 寬度 > 1920 → 自動縮放至 1920
    - 使用 CRF 品質模式避免 VBV underflow
    - GPU 不可用時自動 fallback 到 CPU
    """
    if is_hls_url(rtsp_url):
        return  # 內建 HLS 路徑，不需要寫 yml

    try:
        cfg = yml_load()
        if not cfg.get("paths"):
            cfg["paths"] = {}

        # 如果該 path 已存在且已手動設定，跳過自動覆寫
        existing = cfg["paths"].get(stream_id)
        if existing and existing.get("_manual"):
            logger.info(f"[{stream_id}] Skipping auto-sync (manual override)")
            return

        is_rtsp = rtsp_url.lower().startswith("rtsp")

        if is_rtsp:
            gpu_ok = check_gpu()
            probe = probe_stream(rtsp_url)
            codec = probe["codec"]
            width = probe["width"]
            height = probe["height"]
            is_hevc = codec in ("hevc", "h265")
            needs_scale = width > 1920

            if gpu_ok and is_hevc:
                # ── HEVC + GPU：GPU 解碼 + GPU 縮放 + CPU 編碼 ──
                vf = (
                    '-vf "scale_cuda=1920:-2,hwdownload,format=nv12"'
                    if needs_scale
                    else '-vf "hwdownload,format=nv12"'
                )
                ffmpeg_cmd = (
                    f"ffmpeg -rtsp_transport tcp"
                    f" -fflags nobuffer+discardcorrupt -flags low_delay"
                    f" -hwaccel cuda -hwaccel_output_format cuda -c:v hevc_cuvid"
                    f" -i {rtsp_url} {vf}"
                    f" -c:v libx264 -tune zerolatency -preset ultrafast -crf 23 -g 30 -an"
                    f" -f rtsp rtsp://localhost:8554/{stream_id}"
                )
                timeout = "30s"
                mode = "hevc_cuvid→scale_cuda→libx264"
                logger.info(f"[{stream_id}] HEVC {width}x{height} → GPU decode + scale + CPU encode")

            elif gpu_ok and not is_hevc and not needs_scale:
                # ── H264 + GPU + 正常解析度：GPU 編碼 ──
                ffmpeg_cmd = (
                    f"ffmpeg -rtsp_transport tcp"
                    f" -fflags nobuffer+discardcorrupt -flags low_delay"
                    f" -probesize 32 -analyzeduration 0"
                    f" -i {rtsp_url}"
                    f" -c:v h264_nvenc -preset:v p1 -tune:v ll -zerolatency 1"
                    f" -b:v 2000k -maxrate 3000k -bufsize 4000k -g 30 -an"
                    f" -f rtsp rtsp://localhost:8554/{stream_id}"
                )
                timeout = "30s"
                mode = "h264_nvenc (GPU)"
                logger.info(f"[{stream_id}] H264 {width}x{height} → GPU encode")

            elif gpu_ok and not is_hevc and needs_scale:
                # ── H264 + GPU + 需要縮放：CPU 縮放 + GPU 編碼 ──
                ffmpeg_cmd = (
                    f"ffmpeg -rtsp_transport tcp"
                    f" -fflags nobuffer+discardcorrupt -flags low_delay"
                    f" -probesize 32 -analyzeduration 0"
                    f" -i {rtsp_url}"
                    f' -vf "scale=1920:-2"'
                    f" -c:v h264_nvenc -preset:v p1 -tune:v ll -zerolatency 1"
                    f" -b:v 2000k -maxrate 3000k -bufsize 4000k -g 30 -an"
                    f" -f rtsp rtsp://localhost:8554/{stream_id}"
                )
                timeout = "30s"
                mode = "scale→h264_nvenc (GPU)"
                logger.info(f"[{stream_id}] H264 {width}x{height} → scale + GPU encode")

            else:
                # ── CPU fallback（GPU 不可用）──
                scale_filter = ' -vf "scale=1920:-2"' if needs_scale else ""
                ffmpeg_cmd = (
                    f"ffmpeg -rtsp_transport tcp"
                    f" -fflags nobuffer+discardcorrupt -flags low_delay"
                    f" -probesize 32 -analyzeduration 0"
                    f" -i {rtsp_url}{scale_filter}"
                    f" -c:v libx264 -tune zerolatency -preset ultrafast -crf 23 -g 30 -an"
                    f" -f rtsp rtsp://localhost:8554/{stream_id}"
                )
                timeout = "15s"
                mode = "libx264 (CPU fallback)"
                logger.warning(f"[{stream_id}] {codec} {width}x{height} → CPU encode (no GPU)")

            path_cfg = {
                "runOnDemand": ffmpeg_cmd,
                "runOnDemandRestart": True,
                "runOnDemandStartTimeout": timeout,
                "runOnDemandCloseAfter": "10s",
            }
        else:
            # RTMP / HTTP 等非 RTSP 來源，直接用 source 模式
            path_cfg = {
                "source": rtsp_url,
                "sourceOnDemand": True,
                "sourceOnDemandCloseAfter": "10s",
            }
            mode = "source"

        cfg["paths"][stream_id] = path_cfg
        yml_save(cfg)
        logger.info(f"mediamtx.yml ← [{stream_id}] {rtsp_url} ({mode})")
    except Exception as e:
        logger.error(f"Failed to sync mediamtx.yml for {stream_id}: {e}")


def remove_path(stream_id: str):
    """從 mediamtx.yml 移除路徑設定"""
    try:
        cfg = yml_load()
        paths = cfg.get("paths") or {}
        if stream_id in paths:
            del paths[stream_id]
            cfg["paths"] = paths
            yml_save(cfg)
            logger.info(f"mediamtx.yml ✕ [{stream_id}]")
    except Exception as e:
        logger.error(f"Failed to remove {stream_id} from mediamtx.yml: {e}")
