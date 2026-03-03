# RTSP Stream Viewer - FastAPI Backend (MediaMTX Edition)
# Modular entry point

import logging

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from config import FRONTEND_DIR
from streams import StreamManager
from telemetry import telemetry_manager
from routes import health, vessels, streams as streams_routes, telemetry

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# -- App ----------------------------------------------------------------------

app = FastAPI(title="RTSP Stream Viewer API", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -- StreamManager ------------------------------------------------------------

manager = StreamManager()
streams_routes.init(manager)

# -- Routers ------------------------------------------------------------------

app.include_router(health.router)
app.include_router(vessels.router)
app.include_router(streams_routes.router)
app.include_router(telemetry.router)

# -- Static & index -----------------------------------------------------------

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", response_class=FileResponse)
async def root():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/index.html", response_class=FileResponse)
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


# -- Lifecycle ----------------------------------------------------------------

@app.on_event("startup")
async def startup_event():
    await telemetry_manager.start_all()
    logger.info("[Startup] Telemetry manager started")


@app.on_event("shutdown")
async def shutdown_event():
    await telemetry_manager.stop_all()
    logger.info("Shutting down")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
