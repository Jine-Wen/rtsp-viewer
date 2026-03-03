"""Vessel（船隻）CRUD 工具函數"""

import json
import logging
from typing import List

from config import VESSELS_FILE

logger = logging.getLogger(__name__)


def load_vessels() -> List[dict]:
    if VESSELS_FILE.exists():
        try:
            with open(VESSELS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load vessels: {e}")
    return []


def save_vessels(vessels: List[dict]):
    try:
        with open(VESSELS_FILE, 'w', encoding='utf-8') as f:
            json.dump(vessels, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Failed to save vessels: {e}")
