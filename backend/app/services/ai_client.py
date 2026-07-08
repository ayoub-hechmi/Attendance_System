"""HTTP client for calling the AGPL-isolated AI worker."""
import io
import logging
from typing import Optional

import httpx
import numpy as np
from fastapi import HTTPException
from PIL import Image

from app.core.config import settings

logger = logging.getLogger(__name__)


async def check_worker_health() -> bool:
    """Returns True if the AI worker is reachable and healthy."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{settings.ai_worker_url}/health")
            return resp.status_code == 200
    except Exception:
        return False


async def detect_face(image_bytes: bytes) -> Optional[list[int]]:
    """RetinaFace detection — accurate, used for embedding pipeline."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{settings.ai_worker_url}/detect",
                files={"image": ("frame.jpg", image_bytes, "image/jpeg")},
            )
            resp.raise_for_status()
            data = resp.json()
            return data["bbox"] if data["face_found"] else None
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail="Face recognition service is unavailable. Please try again in a moment.",
        )


async def detect_face_fast(image_bytes: bytes) -> Optional[list[int]]:
    """OpenCV Haar detection — fast, used for live bbox display only."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{settings.ai_worker_url}/detect-fast",
                files={"image": ("frame.jpg", image_bytes, "image/jpeg")},
            )
            resp.raise_for_status()
            data = resp.json()
            return data["bbox"] if data["face_found"] else None
    except httpx.ConnectError:
        return None


async def detect_face_for_scan(image_bytes: bytes) -> dict:
    """RetinaFace detection with multi-face count and anti-spoofing for final scan.

    Returns dict with keys: face_found, bbox, face_count, is_real, multi_face.
    Raises HTTP 503 if the AI worker is unreachable.
    """
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(
                f"{settings.ai_worker_url}/detect-scan",
                files={"image": ("frame.jpg", image_bytes, "image/jpeg")},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail="Face recognition service is unavailable. Please try again in a moment.",
        )


async def embed_face(image_bytes: bytes, bbox: list[int]) -> list[float]:
    """Crop face using bbox, then get 512D ArcFace embedding from AI worker."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    x1, y1, x2, y2 = bbox
    # bbox already has 10% padding from the ai-worker — crop directly
    crop = img.crop((x1, y1, x2, y2))
    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=90)
    buf.seek(0)

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{settings.ai_worker_url}/embed",
            files={"image": ("face.jpg", buf.read(), "image/jpeg")},
        )
        resp.raise_for_status()
        return resp.json()["embedding"]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    va, vb = np.array(a), np.array(b)
    return float(np.dot(va, vb) / (np.linalg.norm(va) * np.linalg.norm(vb)))
