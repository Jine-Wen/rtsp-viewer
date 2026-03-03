# RTSP Stream Viewer — MediaMTX Edition

A maritime fleet monitoring web application that bridges RTSP cameras to a browser via **MediaMTX** (WebRTC / HLS) and manages multi-vessel telemetry in real time.

---

## 📐 Architecture

```
RTSP Camera(s)
      │
      ▼
MediaMTX  ──────────────────────────────────────────────
  ├─ RTSP  : 554 (TCP) / 8554 (UDP)
  ├─ RTMP  : 1935
  ├─ HLS   : http://localhost:8888/<path>/index.m3u8
  ├─ WebRTC: http://localhost:8889/<path>
  └─ API   : http://localhost:9997
      │
      ▼
FastAPI Backend  (port 8080)
  ├─ Stream CRUD  → syncs paths to MediaMTX
  ├─ Vessel CRUD  → persisted in vessels.json
  └─ Telemetry    → UDP listener + TCP registration per vessel
                    broadcast via WebSocket /ws/telemetry/{vessel_id}
      │
      ▼
Browser Frontend  http://localhost:8080
  ├─ WebRTC / HLS player
  ├─ Multi-grid layout  (1 / 4 / 9 / 16 tiles)
  └─ Telemetry dashboard
```

---

##  Project Structure

```
rtsp-viewer/
├── mediamtx.yml            # MediaMTX configuration
├── start-linux.sh          # One-click start script (Linux)
├── stop.sh                 # Stop all services
├── backend/
│   ├── main.py             # FastAPI application entry point
│   ├── config.py           # Path & port constants
│   ├── models.py           # Pydantic data models
│   ├── streams.py          # StreamManager (status polling, persistence)
│   ├── mediamtx.py         # MediaMTX YAML sync, ffprobe, GPU detection
│   ├── vessels.py          # Vessel CRUD helpers
│   ├── telemetry.py        # Multi-vessel telemetry (UDP + WebSocket)
│   ├── streams.json        # Stream config (auto-generated)
│   ├── vessels.json        # Vessel config (auto-generated)
│   ├── requirements.txt
│   └── routes/
│       ├── health.py       # GET /api/health, /api/mediamtx/stats
│       ├── streams.py      # CRUD /api/streams
│       ├── vessels.py      # CRUD /api/vessels
│       └── telemetry.py    # WS /ws/telemetry/{id}, GET /api/telemetry/status
└── frontend/
    ├── index.html
    ├── css/
    │   ├── main.css
    │   └── telemetry.css
    └── js/
        ├── app.js
        └── telemetry.js
```

---

## ✅ Prerequisites

| Requirement | Version |
|-------------|---------|
| Python      | 3.10+   |
| MediaMTX    | latest  |
| ffmpeg / ffprobe | 4.0+ (optional, for stream probing) |
| Browser     | Chrome / Edge / Firefox (HLS.js / WebRTC support) |

---

## 🚀 Quick Start

### 1. Install MediaMTX

Download the binary from the [MediaMTX releases page](https://github.com/bluenviron/mediamtx/releases) and place it somewhere on your `$PATH`:

```bash
# Example for Linux amd64
wget https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_linux_amd64.tar.gz
tar -xzf mediamtx_linux_amd64.tar.gz
sudo mv mediamtx /usr/local/bin/
```

### 2. Clone / Enter the project

```bash
cd /home/jetseaai/rtsp-viewer
```

### 3. Start all services

```bash
chmod +x start-linux.sh
./start-linux.sh
```

> **No manual setup needed.** The script automatically handles everything:
> - ✅ Verifies `mediamtx` is installed
> - ✅ Creates `backend/venv/` if it does not exist
> - ✅ Installs / updates Python dependencies from `requirements.txt`
> - ✅ Starts **MediaMTX** with `mediamtx.yml` (logs → `mediamtx.log`)
> - ✅ Starts **FastAPI** backend with `uvicorn` on port **8080** (logs → `/tmp/backend.log`)

### 4. Open the web UI

```
http://localhost:8080
```

Interactive API docs (Swagger UI):

```
http://localhost:8080/docs
```

### 5. Stop all services

```bash
./stop.sh
```

---

## 🌐 Service Ports

| Service         | Port | URL |
|-----------------|------|-----|
| Web UI / API    | 8080 | http://localhost:8080 |
| MediaMTX HLS    | 8888 | http://localhost:8888/<path>/index.m3u8 |
| MediaMTX WebRTC | 8889 | http://localhost:8889/<path> |
| MediaMTX API    | 9997 | http://localhost:9997/v3/paths/list |
| RTSP (TCP)      | 554  | rtsp://localhost:554/<path> |
| RTSP (UDP)      | 8554 | — |
| RTMP            | 1935 | rtmp://localhost/<path> |

---

## 🔌 REST API Reference

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Backend + MediaMTX connectivity check |
| GET | `/api/mediamtx/stats` | MediaMTX address summary |

### Streams

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/streams`            | List all streams with status |
| POST   | `/api/streams`            | Add a new stream |
| GET    | `/api/streams/{id}`       | Get one stream |
| PUT    | `/api/streams/{id}`       | Update a stream |
| DELETE | `/api/streams/{id}`       | Delete a stream |
| POST   | `/api/streams/{id}/start` | Manually start a stream |
| POST   | `/api/streams/{id}/stop`  | Manually stop a stream |

**Stream body example:**

```json
{
  "id": "cam1",
  "name": "Bow Camera",
  "rtsp_url": "rtsp://192.168.1.100:554/live",
  "group": "vessel-01",
  "role": "main"
}
```

### Vessels

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/vessels`      | List all vessels |
| POST   | `/api/vessels`      | Add a vessel |
| PUT    | `/api/vessels/{id}` | Update a vessel |
| DELETE | `/api/vessels/{id}` | Delete a vessel |

**Vessel body example:**

```json
{
  "id": "vessel-01",
  "name": "JetseaAI-01",
  "icon": "🚢",
  "meta": "Fleet unit 01",
  "telemetry_ip": "10.8.0.10",
  "telemetry_tcp_port": 10000,
  "telemetry_udp_port": 0
}
```

> Set `telemetry_ip` to an empty string to disable telemetry for that vessel.  
> Set `telemetry_udp_port` to `0` to let the system auto-assign a UDP port starting from `10100`.

### Telemetry

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/telemetry/status`      | Status of all vessel telemetry links |
| GET | `/api/telemetry/status/{id}` | Status of one vessel |
| POST | `/api/telemetry/start/{id}` | Start telemetry for a vessel |
| POST | `/api/telemetry/stop/{id}`  | Stop telemetry for a vessel |
| WS  | `/ws/telemetry/{vessel_id}` | Real-time telemetry stream (WebSocket) |

**WebSocket message types:**

- `type: "control"` — Engine RPM, lever position, gear, autopilot, throttle, steering, rudder, SOG, COG, heading, roll, pitch, yaw.
- `type: "gps"` — Latitude and longitude.

---

## 🖥 Frontend Features

| Feature | Description |
|---------|-------------|
| **Live stream** | WebRTC (preferred) with HLS fallback via HLS.js |
| **Grid layout** | 1 / 4 / 9 / 16 tile multi-view |
| **Main panel** | Click any thumbnail in the sidebar to promote it to the main window |
| **Stream management** | Add, edit, delete streams; set RTSP URL, name, and group |
| **Batch control** | Start all / Stop all streams at once |
| **Live status indicator** | Auto-refreshes stream online/offline status every 3 seconds |
| **Telemetry dashboard** | Per-vessel real-time data (RPM, gear, GPS, heading, etc.) |
| **Persistence** | Stream and vessel configs survive restarts (`streams.json`, `vessels.json`) |

---

## 🛠 Manual Setup (advanced, without the shell script)

> If you prefer to start services individually instead of using `start-linux.sh`.

```bash
# 1. Create and activate virtual environment
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 2. Start MediaMTX (from project root)
cd ..
mediamtx mediamtx.yml &

# 3. Start the backend
cd backend
uvicorn main:app --host 0.0.0.0 --port 8080
```

---

## 📝 Logs

| Service | Log location |
|---------|-------------|
| MediaMTX | `mediamtx.log` (project root) |
| FastAPI backend | `/tmp/backend.log` |

```bash
# Follow MediaMTX log
tail -f mediamtx.log

# Follow backend log
tail -f /tmp/backend.log
```

---

## 📦 Python Dependencies

| Package | Version |
|---------|---------|
| fastapi | 0.111.0 |
| uvicorn[standard] | 0.30.1 |
| pydantic | 2.7.1 |
| httpx | 0.25.0 |
| websockets | ≥ 12.0 |
| python-multipart | 0.0.9 |
