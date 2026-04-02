"""MediaMTX 設定檔管理：yml 讀寫、ffprobe 探測、GPU 偵測、自動轉碼策略"""

import subprocess
import logging
import yaml

from config import MEDIAMTX_YML

logger = logging.getLogger(__name__)


# ── GPU 偵測 ──────────────────────────────────────────────────────────────────

def check_gpu() -> bool:
    """檢查 NVIDIA GPU 是否可用：
    1. nvidia-smi 確認有 GPU 裝置
    2. 實際執行 ffmpeg -hwaccel cuda 確認 CUDA 可初始化
    """
    try:
        smi = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        )
        if not (smi.returncode == 0 and smi.stdout.strip()):
            return False
    except Exception:
        return False

    # 實際測試 CUDA 是否可以初始化（nvidia-smi 正常但 CUDA 仍可能失敗）
    try:
        cuda_test = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
                "-f", "lavfi", "-i", "nullsrc=s=128x128",
                "-vframes", "1", "-f", "null", "-",
            ],
            capture_output=True, text=True, timeout=10,
        )
        ok = cuda_test.returncode == 0 and "CUDA_ERROR" not in cuda_test.stderr
        if not ok:
            logger.warning(f"[GPU] CUDA init failed: {cuda_test.stderr[:200]}")
        return ok
    except Exception as e:
        logger.warning(f"[GPU] CUDA test failed: {e}")
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
                # ── H264 + GPU + 需要縮放：檢查寬度後智能縮放
                # NOTE: h264_nvenc 最大支援寬度 4096
                # 如果寬度 > 4096，縮放至 3840；否則縮放至 1920
                target_width = 3840 if width > 4096 else 1920
                scale_filter = f'scale={target_width}:-2'
                
                ffmpeg_cmd = (
                    f"ffmpeg -rtsp_transport tcp"
                    f" -fflags nobuffer+discardcorrupt -flags low_delay"
                    f" -probesize 32 -analyzeduration 0"
                    f" -i {rtsp_url}"
                    f' -vf "{scale_filter}"'
                    f" -c:v libx264 -tune zerolatency -preset superfast -crf 28"
                    f" -threads 8 -g 30 -sc_threshold 0 -an"
                    f" -f rtsp rtsp://localhost:8554/{stream_id}"
                )
                timeout = "30s"
                mode = f"scale→libx264 ({width}→{target_width}px CPU encode)"
                logger.warning(f"[{stream_id}] H264 {width}x{height} → auto-scaled to {target_width}px + CPU encode")

            else:
                # ── CPU fallback（GPU 不可用）──
                # 如果需要縮放，智能選擇目標寬度：
                # - 寬度 > 4096: 縮放至 3840
                # - 寬度 1920-4096: 縮放至 1920
                # - 寬度 < 1920: 不縮放
                if needs_scale:
                    target_width = 3840 if width > 4096 else 1920
                    scale_filter = f' -vf "scale={target_width}:-2"'
                    logger.warning(f"[{stream_id}] {codec} {width}x{height} → auto-scaled to {target_width}px")
                else:
                    scale_filter = ""
                
                ffmpeg_cmd = (
                    f"ffmpeg -rtsp_transport tcp"
                    f" -fflags nobuffer+discardcorrupt -flags low_delay"
                    f" -probesize 32 -analyzeduration 0"
                    f" -i {rtsp_url}{scale_filter}"
                    f" -c:v libx264 -tune zerolatency -preset superfast -crf 28"
                    f" -threads 8 -g 30 -sc_threshold 0 -r 30 -vsync cfr -an"
                    f" -f rtsp rtsp://localhost:8554/{stream_id}"
                )
                timeout = "30s"
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


# ── 按需啟動 MediaMTX ────────────────────────────────────────────────────────

import os
import signal
from config import MEDIAMTX_YML

_mediamtx_process: subprocess.Popen | None = None


def is_running() -> bool:
    """檢查 MediaMTX 是否正在執行（先檢查內部 process，再用 pgrep 確認）"""
    global _mediamtx_process
    if _mediamtx_process is not None:
        ret = _mediamtx_process.poll()
        if ret is None:
            return True  # 仍在執行中
        else:
            _mediamtx_process = None  # 已退出，清掉引用
    # 用 pgrep 確認是否有外部啟動的 mediamtx 程序
    try:
        result = subprocess.run(["pgrep", "-x", "mediamtx"],
                                capture_output=True, text=True)
        return result.returncode == 0
    except Exception:
        return False


def ensure_running(yml_path: str | None = None, log_path: str | None = None) -> bool:
    """若 MediaMTX 尚未執行則啟動它，已在執行則直接回傳 True。

    Returns:
        True  → MediaMTX 已在執行（或成功啟動）
        False → 啟動失敗
    """
    global _mediamtx_process

    if is_running():
        logger.info("[MediaMTX] already running, skip start")
        return True

    # 決定 yml 路徑（預設與 MEDIAMTX_YML 相同）
    cfg_path = yml_path or str(MEDIAMTX_YML)
    # log 寫到 mediamtx.log（與 yml 同目錄）
    if log_path is None:
        log_path = str(MEDIAMTX_YML.parent / "mediamtx.log")

    logger.info(f"[MediaMTX] starting: mediamtx {cfg_path}")
    try:
        log_file = open(log_path, "a")
        _mediamtx_process = subprocess.Popen(
            ["mediamtx", cfg_path],
            stdout=log_file,
            stderr=log_file,
        )
        # 等最多 5 秒確認啟動
        for _ in range(10):
            import time
            time.sleep(0.5)
            if _mediamtx_process.poll() is not None:
                logger.error("[MediaMTX] process exited immediately")
                _mediamtx_process = None
                return False
            # 嘗試連線 API
            try:
                r = subprocess.run(
                    ["curl", "-sf", "http://localhost:9997/v3/paths/list"],
                    capture_output=True, timeout=2,
                )
                if r.returncode == 0:
                    logger.info(f"[MediaMTX] started (PID {_mediamtx_process.pid})")
                    return True
            except Exception:
                pass
        logger.warning("[MediaMTX] started but API not yet ready (continuing anyway)")
        return True
    except FileNotFoundError:
        logger.error("[MediaMTX] 'mediamtx' command not found, please install MediaMTX first")
        return False
    except Exception as e:
        logger.error(f"[MediaMTX] failed to start: {e}")
        return False


def stop() -> bool:
    """停止 MediaMTX 程序（本 process 啟動的 + 系統上所有 mediamtx）"""
    global _mediamtx_process
    stopped = False

    if _mediamtx_process is not None:
        try:
            _mediamtx_process.terminate()
            _mediamtx_process.wait(timeout=5)
            logger.info("[MediaMTX] terminated")
            stopped = True
        except Exception as e:
            logger.warning(f"[MediaMTX] terminate error: {e}")
            try:
                _mediamtx_process.kill()
            except Exception:
                pass
        finally:
            _mediamtx_process = None

    # 清除系統上其他 mediamtx 程序
    try:
        subprocess.run(["pkill", "-x", "mediamtx"], capture_output=True)
        stopped = True
    except Exception:
        pass

    return stopped


# ── 自動修復：監控日誌並修復失敗的配置 ────────────────────────────────────────

def auto_fix_stream_config(stream_id: str, error_msg: str) -> bool:
    """
    監控 MediaMTX 日誌，偵測常見錯誤並自動修復配置。
    
    支援的自動修復：
    - 寬度超過編碼器限制 → 自動縮放
    - 編碼器不支援 → 自動改用 CPU 編碼
    - GPU 不可用 → 自動 fallback CPU
    
    回傳 True 如果修復成功並已重新載入配置
    """
    try:
        cfg = yml_load()
        paths = cfg.get("paths") or {}
        
        if stream_id not in paths:
            logger.warning(f"[auto_fix] Stream {stream_id} not found in config")
            return False
        
        path_cfg = paths[stream_id]
        runOnDemand = path_cfg.get("runOnDemand", "")
        
        logger.info(f"[auto_fix] Attempting to fix {stream_id}: {error_msg[:80]}")
        
        # ── 錯誤 1: 寬度超過 4096 (h264_nvenc 限制) ──
        if "Width" in error_msg and "exceeds 4096" in error_msg:
            if "h264_nvenc" in runOnDemand:
                logger.warning(f"[auto_fix] {stream_id} h264_nvenc failed due to width → switching to CPU encode with scale")
                # 改用 CPU 編碼並自動縮放
                new_cmd = runOnDemand.replace("-c:v h264_nvenc", "-vf \"scale=3840:-2\" -c:v libx264")
                path_cfg["runOnDemand"] = new_cmd
                paths[stream_id] = path_cfg
                cfg["paths"] = paths
                yml_save(cfg)
                logger.info(f"[auto_fix] {stream_id} config updated (h264_nvenc→libx264 with scale)")
                return True
        
        # ── 錯誤 2: No capable devices found (GPU 不可用) ──
        if "No capable devices found" in error_msg or "CUDA" in error_msg:
            if "h264_nvenc" in runOnDemand or "hevc_cuvid" in runOnDemand:
                logger.warning(f"[auto_fix] {stream_id} GPU encoding failed → switching to CPU encode")
                # 改用 CPU 編碼
                new_cmd = runOnDemand
                # 移除 NVIDIA 特定參數
                new_cmd = new_cmd.replace("-hwaccel cuda -hwaccel_output_format cuda -c:v hevc_cuvid", "")
                new_cmd = new_cmd.replace("-c:v h264_nvenc -preset:v p1 -tune:v ll -zerolatency 1", "-c:v libx264 -tune zerolatency -preset superfast")
                # 如果還沒有 libx264，添加
                if "-c:v libx264" not in new_cmd:
                    new_cmd = new_cmd.replace("-c:v h264", "-c:v libx264")
                path_cfg["runOnDemand"] = new_cmd
                paths[stream_id] = path_cfg
                cfg["paths"] = paths
                yml_save(cfg)
                logger.info(f"[auto_fix] {stream_id} config updated (GPU→CPU encode)")
                return True
        
        # ── 錯誤 3: Frame rate too high ──
        if "Frame rate very high" in error_msg or "rate too high" in error_msg:
            if "-vsync 2" not in runOnDemand and "-vsync cfr" not in runOnDemand:
                logger.warning(f"[auto_fix] {stream_id} frame rate issue → adding vsync cfr")
                new_cmd = runOnDemand.replace(" -an -f rtsp", " -r 30 -vsync cfr -an -f rtsp")
                path_cfg["runOnDemand"] = new_cmd
                paths[stream_id] = path_cfg
                cfg["paths"] = paths
                yml_save(cfg)
                logger.info(f"[auto_fix] {stream_id} config updated (added -vsync cfr)")
                return True
        
        logger.info(f"[auto_fix] No auto-fix available for: {error_msg[:100]}")
        return False
    except Exception as e:
        logger.error(f"[auto_fix] Failed to auto-fix {stream_id}: {e}")
        return False

