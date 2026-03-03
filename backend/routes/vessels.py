"""Vessel（船隻）API 路由"""

from fastapi import APIRouter, HTTPException

from models import VesselConfig
from vessels import load_vessels, save_vessels

router = APIRouter()


@router.get("/api/vessels")
async def get_vessels():
    return load_vessels()


@router.post("/api/vessels")
async def create_vessel(vessel: VesselConfig):
    vessels = load_vessels()
    if any(v['id'] == vessel.id for v in vessels):
        raise HTTPException(status_code=400, detail=f"Vessel '{vessel.id}' already exists")
    vessels.append(vessel.dict())
    save_vessels(vessels)
    return vessel


@router.put("/api/vessels/{vessel_id}")
async def update_vessel(vessel_id: str, vessel: VesselConfig):
    vessels = load_vessels()
    idx = next((i for i, v in enumerate(vessels) if v['id'] == vessel_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail=f"Vessel '{vessel_id}' not found")
    vessels[idx] = vessel.dict()
    save_vessels(vessels)
    return vessel


@router.delete("/api/vessels/{vessel_id}")
async def delete_vessel(vessel_id: str):
    vessels = load_vessels()
    vessels = [v for v in vessels if v['id'] != vessel_id]
    save_vessels(vessels)
    return {"status": "deleted", "id": vessel_id}
