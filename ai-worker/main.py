"""
AI Worker — AGPL-isolated microservice.
Exposes two endpoints:
  POST /detect  → runs YOLOv8-face, returns bounding box of the largest face
  POST /embed   → runs DeepFace ArcFace on a pre-cropped face, returns 512D vector
Keeping YOLO and embedding logic here isolates AGPL-3.0 code from the main backend.
"""
import io
import logging
from contextlib import asynccontextmanager
from typing import Optional

import cv2
import numpy as np
from deepface import DeepFace
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image
from ultralytics import YOLO

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

yolo_model: Optional[YOLO] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global yolo_model
    logger.info("Loading YOLOv8-face model...")
    # yolov8n-face is a face-specific variant — not the general COCO model
    yolo_model = YOLO("yolov8n-face.pt")
    logger.info("Model loaded.")
    yield
    yolo_model = None


app = FastAPI(
    title="AI Worker — Face Detection & Embedding",
    description="AGPL-isolated YOLO + DeepFace microservice",
    version="1.0.0",
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
    Detect the largest face in the image.
    Returns bounding box [x1, y1, x2, y2] in pixel coordinates.
    """
    raw = await image.read()
    try:
        img = decode_image(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image data")

    results = yolo_model(img, conf=0.5, verbose=False)
    boxes = results[0].boxes

    if boxes is None or len(boxes) == 0:
        return JSONResponse({"face_found": False, "bbox": None})

    # Pick the largest bounding box (most prominent face)
    areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in boxes.xyxy.tolist()]
    best = boxes.xyxy[int(np.argmax(areas))].tolist()
    x1, y1, x2, y2 = [int(v) for v in best]

    return {"face_found": True, "bbox": [x1, y1, x2, y2]}


@app.post("/embed")
async def embed_face(image: UploadFile = File(...)):
    """
    Generate a 512-dimensional ArcFace embedding for a pre-cropped face image.
    The main backend is responsible for cropping using /detect first.
    """
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
            detector_backend="skip",  # already cropped by YOLO
        )
        vector = result[0]["embedding"]  # list of 512 floats
    except Exception as e:
        logger.error("Embedding failed: %s", e)
        raise HTTPException(status_code=422, detail=f"Embedding failed: {e}")

    return {"embedding": vector, "dimensions": len(vector)}


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": yolo_model is not None}
