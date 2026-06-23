"""HTTP client for calling the AGPL-isolated AI worker."""
import io
from typing import Optional

import httpx
import numpy as np
from PIL import Image

from app.core.config import settings


async def detect_face(image_bytes: bytes) -> Optional[list[int]]:
    """Call the AI worker to detect a face. Returns [x1,y1,x2,y2] or None."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{settings.ai_worker_url}/detect",
            files={"image": ("frame.jpg", image_bytes, "image/jpeg")},
        )
        resp.raise_for_status()
        data = resp.json()
        return data["bbox"] if data["face_found"] else None


async def embed_face(image_bytes: bytes, bbox: list[int]) -> list[float]:
    """Crop face using bbox, then get 512D ArcFace embedding from AI worker."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    x1, y1, x2, y2 = bbox
    # Add 10% padding around the face crop
    w, h = img.size
    pad_x = int((x2 - x1) * 0.1)
    pad_y = int((y2 - y1) * 0.1)
    crop = img.crop((
        max(0, x1 - pad_x),
        max(0, y1 - pad_y),
        min(w, x2 + pad_x),
        min(h, y2 + pad_y),
    ))
    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=90)
    buf.seek(0)

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{settings.ai_worker_url}/embed",
            files={"image": ("face.jpg", buf.read(), "image/jpeg")},
        )
        resp.raise_for_status()
        return resp.json()["embedding"]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    va, vb = np.array(a), np.array(b)
    return float(np.dot(va, vb) / (np.linalg.norm(va) * np.linalg.norm(vb)))
