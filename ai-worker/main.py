"""
AI Worker — AGPL-isolated microservice.
  POST /detect       → RetinaFace (accurate, for embedding pipeline)
  POST /detect-fast  → OpenCV Haar (fast, for live bbox display only)
  POST /embed        → ArcFace 512-D embedding (quality-adaptive, robust to lighting/occlusion)
"""
import logging
from contextlib import asynccontextmanager

import cv2
import numpy as np
from deepface import DeepFace
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _extract_bbox(face_objs, img_w, img_h, min_size=20, min_confidence=0.90):
    """Pick largest valid face from DeepFace extract_faces result, with 10% padding.
    min_confidence filters out false positives (walls, patterns) from RetinaFace."""
    valid = [f for f in face_objs
             if f["facial_area"]["w"] > min_size
             and f["facial_area"]["h"] > min_size
             and f.get("confidence", 1.0) >= min_confidence]
    if not valid:
        return None
    best = max(valid, key=lambda f: f["facial_area"]["w"] * f["facial_area"]["h"])
    fa = best["facial_area"]
    pad = int(min(fa["w"], fa["h"]) * 0.10)
    x1 = max(0, fa["x"] - pad)
    y1 = max(0, fa["y"] - pad)
    x2 = min(img_w, fa["x"] + fa["w"] + pad)
    y2 = min(img_h, fa["y"] + fa["h"] + pad)
    return [x1, y1, x2, y2]


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Warming up models (may download weights on first run)...")
    dummy_small = np.zeros((64, 64, 3), dtype=np.uint8)
    dummy_face = np.zeros((160, 160, 3), dtype=np.uint8)

    # Haar cascade warm-up (fast detector)
    try:
        DeepFace.extract_faces(img_path=dummy_small, detector_backend="opencv",
                               enforce_detection=False, align=False)
    except Exception:
        pass

    # RetinaFace warm-up — downloads ~1.7 MB model on first run
    try:
        DeepFace.extract_faces(img_path=dummy_small, detector_backend="retinaface",
                               enforce_detection=False, align=False)
    except Exception:
        pass

    # ArcFace warm-up — downloads ~137 MB model on first run
    try:
        DeepFace.represent(img_path=dummy_face, model_name="ArcFace",
                           enforce_detection=False, detector_backend="skip")
    except Exception:
        pass

    logger.info("AI worker ready.")
    yield


app = FastAPI(
    title="AI Worker — Face Detection & Embedding",
    description="AGPL-isolated DeepFace microservice",
    version="3.0.0",
    lifespan=lifespan,
)


def decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    return img


@app.post("/detect")
async def detect_face(image: UploadFile = File(...)):
    """
    Accurate face detection using RetinaFace (neural network).
    Used by /identify and /scan-sync — accuracy matters here.
    ~300 ms on CPU, almost no false positives.
    """
    raw = await image.read()
    try:
        img = decode_image(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image data")

    h, w = img.shape[:2]
    try:
        face_objs = DeepFace.extract_faces(
            img_path=img,
            detector_backend="retinaface",
            enforce_detection=False,
            align=False,
        )
    except Exception as e:
        logger.warning("RetinaFace detection failed: %s", e)
        return JSONResponse({"face_found": False, "bbox": None})

    bbox = _extract_bbox(face_objs, w, h)
    if bbox is None:
        return JSONResponse({"face_found": False, "bbox": None})
    return {"face_found": True, "bbox": bbox}


@app.post("/detect-fast")
async def detect_face_fast(image: UploadFile = File(...)):
    """
    Fast face detection using OpenCV Haar cascade.
    Used only by /detect-only for the live bounding-box display.
    ~30 ms on CPU. Higher false-positive rate than RetinaFace but fine for display.
    """
    raw = await image.read()
    try:
        img = decode_image(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image data")

    h, w = img.shape[:2]
    try:
        face_objs = DeepFace.extract_faces(
            img_path=img,
            detector_backend="opencv",
            enforce_detection=False,
            align=False,
        )
    except Exception as e:
        logger.warning("OpenCV detection failed: %s", e)
        return JSONResponse({"face_found": False, "bbox": None})

    bbox = _extract_bbox(face_objs, w, h)
    if bbox is None:
        return JSONResponse({"face_found": False, "bbox": None})
    return {"face_found": True, "bbox": bbox}


@app.post("/detect-scan")
async def detect_face_for_scan(image: UploadFile = File(...)):
    """
    RetinaFace detection with multi-face guard and anti-spoofing.
    Used only for the final /scan-sync call — not the live identify loop.
    Returns face_count so the backend can reject multi-face frames.
    Anti-spoofing is best-effort: if the model download fails, is_real is null.
    """
    raw = await image.read()
    try:
        img = decode_image(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image data")

    h, w = img.shape[:2]

    try:
        face_objs = DeepFace.extract_faces(
            img_path=img,
            detector_backend="retinaface",
            enforce_detection=False,
            align=False,
        )
    except Exception as e:
        logger.warning("RetinaFace scan detection failed: %s", e)
        return JSONResponse({"face_found": False, "bbox": None, "face_count": 0,
                             "is_real": None, "multi_face": False})

    valid = [f for f in face_objs
             if f["facial_area"]["w"] > 20
             and f["facial_area"]["h"] > 20
             and f.get("confidence", 1.0) >= 0.90]

    face_count = len(valid)

    if face_count == 0:
        return JSONResponse({"face_found": False, "bbox": None, "face_count": 0,
                             "is_real": None, "multi_face": False})

    if face_count > 1:
        return JSONResponse({"face_found": True, "bbox": None, "face_count": face_count,
                             "is_real": None, "multi_face": True})

    bbox = _extract_bbox(valid, w, h)

    # Anti-spoofing — best effort; fall back gracefully if model is unavailable
    is_real = None
    antispoof_score = None
    try:
        spoof_objs = DeepFace.extract_faces(
            img_path=img,
            detector_backend="retinaface",
            enforce_detection=False,
            align=False,
            anti_spoofing=True,
        )
        if spoof_objs:
            is_real = spoof_objs[0].get("is_real", None)
            antispoof_score = spoof_objs[0].get("antispoof_score", None)
    except Exception as e:
        logger.warning("Anti-spoofing check skipped (model unavailable): %s", e)

    return {
        "face_found": True,
        "bbox": bbox,
        "face_count": 1,
        "is_real": is_real,
        "antispoof_score": antispoof_score,
        "multi_face": False,
    }


@app.post("/embed")
async def embed_face(image: UploadFile = File(...)):
    """512-D ArcFace embedding for a pre-cropped face image."""
    raw = await image.read()
    try:
        img = decode_image(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image data")

    try:
        result = DeepFace.represent(
            img_path=img,
            model_name="ArcFace",
            enforce_detection=False,
            detector_backend="skip",
        )
        vector = result[0]["embedding"]
    except Exception as e:
        logger.error("Embedding failed: %s", e)
        raise HTTPException(status_code=422, detail=f"Embedding failed: {e}")

    return {"embedding": vector, "dimensions": len(vector)}


@app.get("/health")
async def health():
    return {"status": "ok"}
