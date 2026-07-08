import asyncio
import io
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import List

import numpy as np

import httpx
from PIL import Image, ImageEnhance
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.limiter import limiter
from app.models.models import Attendance, AttendanceWindow, Class, ClassStudent, FaceVector, Student
from app.routers.auth import get_current_teacher
from app.services.ai_client import check_worker_health, cosine_similarity, detect_face, detect_face_fast, detect_face_for_scan, embed_face
from app.services.vector_backup import write_vector_backup
from app.services.websocket_manager import manager
from app.tasks import process_scan

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/attendance", tags=["attendance"])

_NAME_RE = re.compile(r'^[\w\s\-\'\.À-ɏЀ-ӿ؀-ۿ]{2,100}$', re.UNICODE)
_NUM_RE  = re.compile(r'^[A-Za-z0-9\-_]{2,50}$')


def _validate_name(name: str) -> str:
    name = name.strip()
    if not name or len(name) > 100:
        raise HTTPException(status_code=422, detail="Name must be between 2 and 100 characters.")
    if re.search(r'[<>]', name):
        raise HTTPException(status_code=422, detail="Name contains invalid characters.")
    return name


def _validate_student_number(num: str) -> str:
    num = num.strip()
    if not _NUM_RE.match(num):
        raise HTTPException(
            status_code=422,
            detail="Student number must be 2–50 characters and contain only letters, digits, hyphens, or underscores.",
        )
    return num


async def _students_in_class(class_id: int, db: AsyncSession):
    """Return all Student objects in a class via the class_students junction table."""
    ids_result = await db.execute(
        select(ClassStudent.student_id).where(ClassStudent.class_id == class_id)
    )
    student_ids = [row[0] for row in ids_result.all()]
    if not student_ids:
        return []
    return (await db.execute(select(Student).where(Student.id.in_(student_ids)))).scalars().all()


def _centroid_sim(live_vector: list, enrolled_vecs: list) -> float:
    """Cosine similarity between live_vector and the centroid of enrolled_vecs."""
    if not enrolled_vecs:
        return 1.0  # nothing to check against — let it through
    mat = np.array([list(fv.embedding) for fv in enrolled_vecs], dtype=np.float32)
    centroid = mat.mean(axis=0)
    c_norm = np.linalg.norm(centroid)
    v = np.array(live_vector, dtype=np.float32)
    v_norm = np.linalg.norm(v)
    if c_norm == 0 or v_norm == 0:
        return 0.0
    return float(np.dot(v / v_norm, centroid / c_norm))


async def _best_match(live_vector, class_id: int, db: AsyncSession):
    """Return (student, best_score, second_best_score).

    Option 5: enrolled vectors count at full weight; scan-derived at 0.5×.
    This prevents scan-accumulated embeddings from overriding the ground-truth
    enrolled profile.
    """
    students = await _students_in_class(class_id, db)
    scores = []
    for student in students:
        vecs = (await db.execute(select(FaceVector).where(FaceVector.student_id == student.id))).scalars().all()
        if not vecs:
            continue

        enrolled = [fv for fv in vecs if (fv.source or "enrolled") == "enrolled"]
        scan    = [fv for fv in vecs if (fv.source or "enrolled") == "scan"]

        e_score = max((cosine_similarity(live_vector, fv.embedding) for fv in enrolled), default=0.0)
        s_score = max((cosine_similarity(live_vector, fv.embedding) for fv in scan),     default=0.0)
        score   = max(e_score, s_score * 0.5)

        logger.info(
            "Face match: %s enrolled=%.4f scan=%.4f weighted=%.4f (threshold=%.2f)",
            student.name, e_score, s_score, score, settings.face_similarity_threshold,
        )
        scores.append((score, student))

    if not scores:
        return None, 0.0, 0.0

    scores.sort(key=lambda x: x[0], reverse=True)
    best_score, best_student = scores[0]
    second_best = scores[1][0] if len(scores) > 1 else 0.0
    return best_student, best_score, second_best


async def _notify_teacher(class_id: int, student, score: float):
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            await client.post(
                f"{settings.backend_url}/internal/broadcast/{class_id}",
                json={
                    "event": "student_present",
                    "student_id": student.id,
                    "student_name": student.name,
                    "student_number": student.student_number,
                    "similarity_score": round(score, 4),
                    "scanned_at": datetime.now(timezone.utc).isoformat(),
                },
            )
    except Exception:
        pass


@router.get("/window/{window_id}/status")
async def window_status(window_id: int, db: AsyncSession = Depends(get_db)):
    window = await db.get(AttendanceWindow, window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    remaining = (window.closes_at - datetime.now(timezone.utc)).total_seconds()
    return {
        "id": window.id,
        "class_id": window.class_id,
        "is_open": window.is_open,
        "closes_at": window.closes_at.isoformat(),
        "remaining_seconds": max(0, int(remaining)),
    }


@router.post("/detect-only")
async def detect_only(image: UploadFile = File(...)):
    bbox = await detect_face_fast(await image.read())
    return {"bbox": bbox}


@router.post("/identify")
async def identify_face(
    image: UploadFile = File(...),
    window_id: int = Form(...),
    db: AsyncSession = Depends(get_db),
):
    window = await db.get(AttendanceWindow, window_id)
    if not window:
        return {"found": False, "bbox": None, "name": None}

    image_bytes = await image.read()
    bbox = await detect_face(image_bytes)
    if not bbox:
        return {"found": False, "bbox": None, "name": None}

    live_vector = await embed_face(image_bytes, bbox)
    student, score, second = await _best_match(live_vector, window.class_id, db)

    margin_ok = (score - second) >= settings.face_match_margin
    if student and score >= settings.face_similarity_threshold and margin_ok:
        return {"found": True, "bbox": bbox, "name": student.name, "student_number": student.student_number, "score": round(score * 100, 1)}
    return {"found": False, "bbox": bbox, "name": None, "score": None}


@router.post("/scan-sync")
@limiter.limit("1/5 seconds")
async def scan_face_sync(
    request: Request,
    image: UploadFile = File(...),
    window_id: int = Form(...),
    db: AsyncSession = Depends(get_db),
):
    window = await db.get(AttendanceWindow, window_id)
    if not window or not window.is_open or datetime.now(timezone.utc) > window.closes_at:
        return {"status": "error", "message": "Attendance session is not open or has expired."}

    image_bytes = await image.read()

    # Full detection: multi-face guard + anti-spoofing
    detection = await detect_face_for_scan(image_bytes)

    if not detection.get("face_found"):
        return {"status": "no_face", "message": "No face detected. Look directly at the camera and try again."}

    if detection.get("multi_face"):
        face_count = detection.get("face_count", "multiple")
        return {
            "status": "multi_face",
            "message": f"{face_count} faces detected. Only one person should be in view.",
        }

    if detection.get("is_real") is False:
        return {
            "status": "spoof_detected",
            "message": "Liveness check failed. Use your real face — photos or screens are not accepted.",
        }

    bbox = detection.get("bbox")
    if not bbox:
        return {"status": "no_face", "message": "No face detected. Look directly at the camera and try again."}

    live_vector = await embed_face(image_bytes, bbox)
    student, score, second = await _best_match(live_vector, window.class_id, db)

    margin_ok = (score - second) >= settings.face_match_margin
    if not student or score < settings.face_similarity_threshold or not margin_ok:
        logger.info(
            "Scan rejected: score=%.4f threshold=%.2f margin=%.4f (needed %.2f)",
            score, settings.face_similarity_threshold, score - second, settings.face_match_margin,
        )
        return {"status": "not_recognised", "message": "Face not recognised. Make sure you are enrolled in this class."}

    existing = (await db.execute(
        select(Attendance).where(Attendance.student_id == student.id, Attendance.window_id == window_id)
    )).scalar_one_or_none()
    if existing:
        return {"status": "already_present", "student_name": student.name, "message": f"{student.name} is already marked present for this session."}

    attendance = Attendance(student_id=student.id, window_id=window_id, status="present", similarity_score=score)
    db.add(attendance)
    await db.commit()

    # Option 2 + 5: only save scan embedding if it is close to the enrolled centroid,
    # and tag it as scan-derived so _best_match weights it at 0.5×.
    all_vecs = (await db.execute(
        select(FaceVector).where(FaceVector.student_id == student.id)
    )).scalars().all()
    enrolled_vecs = [fv for fv in all_vecs if (fv.source or "enrolled") == "enrolled"]
    if _centroid_sim(live_vector, enrolled_vecs) >= settings.face_similarity_threshold:
        db.add(FaceVector(student_id=student.id, embedding=live_vector, source="scan"))
        await db.commit()
    else:
        logger.info("Scan embedding for %s rejected by centroid check", student.name)

    if settings.vectors_backup_dir:
        all_vecs = (await db.execute(
            select(FaceVector).where(FaceVector.student_id == student.id)
        )).scalars().all()
        await asyncio.to_thread(
            write_vector_backup,
            settings.vectors_backup_dir,
            student.id, student.student_number, student.name,
            [list(fv.embedding) for fv in all_vecs],
        )

    await _notify_teacher(window.class_id, student, score)
    return {"status": "present", "student_name": student.name, "message": f"Welcome, {student.name}! You are now marked present."}


@router.post("/window/open")
async def open_window(
    class_id: int,
    duration_minutes: int = None,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    cls = await db.get(Class, class_id)
    if not cls or cls.teacher_id != teacher.id:
        raise HTTPException(status_code=403, detail="Not your class")

    mins = duration_minutes if duration_minutes and duration_minutes > 0 else settings.attendance_window_minutes
    closes_at = datetime.now(timezone.utc) + timedelta(minutes=mins)
    window = AttendanceWindow(class_id=class_id, closes_at=closes_at)
    db.add(window)
    await db.commit()
    await db.refresh(window)

    await manager.broadcast(class_id, {
        "event": "window_opened",
        "window_id": window.id,
        "closes_at": closes_at.isoformat(),
        "minutes": mins,
    })
    return {"window_id": window.id, "closes_at": closes_at.isoformat()}


@router.post("/window/{window_id}/close")
async def close_window(
    window_id: int,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    window = await db.get(AttendanceWindow, window_id)
    if not window:
        raise HTTPException(status_code=404)
    window.is_open = False
    await db.commit()
    await manager.broadcast(window.class_id, {"event": "window_closed", "window_id": window_id})
    return {"status": "closed"}


@router.post("/window/{window_id}/mark/{student_id}")
async def manual_mark_present(
    window_id: int,
    student_id: int,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    """Manually mark a student as present (teacher override)."""
    window = await db.get(AttendanceWindow, window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    student = await db.get(Student, student_id)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    existing = (await db.execute(
        select(Attendance).where(Attendance.student_id == student_id, Attendance.window_id == window_id)
    )).scalar_one_or_none()
    if existing:
        return {"status": "already_present"}

    db.add(Attendance(student_id=student_id, window_id=window_id, status="present", similarity_score=1.0))
    await db.commit()
    await _notify_teacher(window.class_id, student, 1.0)
    return {"status": "marked_present"}


@router.get("/history")
async def get_history(
    class_id: int,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    """List past attendance sessions for a class with present/total counts."""
    cls = await db.get(Class, class_id)
    if not cls or cls.teacher_id != teacher.id:
        raise HTTPException(status_code=403, detail="Not your class")

    windows = (await db.execute(
        select(AttendanceWindow)
        .where(AttendanceWindow.class_id == class_id)
        .order_by(AttendanceWindow.opened_at.desc())
    )).scalars().all()

    total_students_result = await db.execute(
        select(ClassStudent.student_id).where(ClassStudent.class_id == class_id)
    )
    total_students = len(total_students_result.all())

    result = []
    for w in windows:
        present = (await db.execute(
            select(Attendance).where(Attendance.window_id == w.id)
        )).scalars().all()
        result.append({
            "id": w.id,
            "date": w.date.isoformat() if w.date else None,
            "opened_at": w.opened_at.isoformat(),
            "closes_at": w.closes_at.isoformat(),
            "is_open": w.is_open,
            "present_count": len(present),
            "total_count": total_students,
        })
    return result


@router.get("/window/{window_id}/roster")
async def get_roster(
    window_id: int,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    window = await db.get(AttendanceWindow, window_id)
    if not window:
        raise HTTPException(status_code=404)

    students = await _students_in_class(window.class_id, db)
    attendance_rows = (await db.execute(
        select(Attendance.student_id, Attendance.scanned_at).where(Attendance.window_id == window_id)
    )).all()
    scanned_at_by_student = {row[0]: row[1] for row in attendance_rows}

    return {
        "window": {"id": window.id, "is_open": window.is_open, "closes_at": window.closes_at.isoformat()},
        "roster": [
            {
                "id": s.id,
                "name": s.name,
                "student_number": s.student_number,
                "status": "present" if s.id in scanned_at_by_student else "absent",
                "scanned_at": scanned_at_by_student[s.id].isoformat() if s.id in scanned_at_by_student else None,
            }
            for s in students
        ],
    }


@router.post("/scan")
async def scan_face(
    image: UploadFile = File(...),
    student_number: str = Form(...),
    window_id: int = Form(...),
    db: AsyncSession = Depends(get_db),
):
    window = await db.get(AttendanceWindow, window_id)
    if not window or not window.is_open or datetime.now(timezone.utc) > window.closes_at:
        raise HTTPException(status_code=403, detail="Attendance window is not open")

    recent = (await db.execute(
        select(Attendance).where(
            Attendance.window_id == window_id,
            Attendance.student_id == select(Student.id).where(Student.student_number == student_number).scalar_subquery(),
        )
    )).scalar_one_or_none()
    if recent:
        return {"status": "already_marked", "message": "You are already marked present."}

    image_bytes = await image.read()
    process_scan.delay(image_bytes, window_id, student_number)
    return {"status": "queued", "message": "Processing your scan, please wait..."}


@router.post("/self-enroll")
async def self_enroll(
    name: str = Form(...),
    student_number: str = Form(...),
    window_id: int = Form(...),
    images: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Student self-enrollment via QR link: create account, store face, mark present."""
    name           = _validate_name(name)
    student_number = _validate_student_number(student_number)

    window = await db.get(AttendanceWindow, window_id)
    if not window or not window.is_open or datetime.now(timezone.utc) > window.closes_at:
        raise HTTPException(status_code=400, detail="This attendance session is not open.")

    # Re-use an existing student if the student number already exists globally
    student = (await db.execute(
        select(Student).where(Student.student_number == student_number)
    )).scalar_one_or_none()

    if student:
        # Add to this class if not already enrolled
        already_in = (await db.execute(
            select(ClassStudent).where(
                ClassStudent.class_id == window.class_id,
                ClassStudent.student_id == student.id,
            )
        )).scalar_one_or_none()
        if not already_in:
            db.add(ClassStudent(class_id=window.class_id, student_id=student.id))
    else:
        student = Student(name=name, student_number=student_number)
        db.add(student)
        await db.flush()
        db.add(ClassStudent(class_id=window.class_id, student_id=student.id))

    # Store face vectors with brightness augmentation — same pipeline as teacher enrollment
    # Each photo → 3 brightness variants → up to 15 vectors for 5 poses
    _BRIGHTNESS = [1.0, 0.70, 1.25]
    enrolled = 0
    for img in images:
        try:
            image_bytes = await img.read()
            bbox = await detect_face(image_bytes)
            if not bbox:
                continue
            base = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            for factor in _BRIGHTNESS:
                if factor == 1.0:
                    aug_bytes = image_bytes
                else:
                    buf = io.BytesIO()
                    ImageEnhance.Brightness(base).enhance(factor).save(buf, format="JPEG", quality=90)
                    aug_bytes = buf.getvalue()
                db.add(FaceVector(student_id=student.id, embedding=await embed_face(aug_bytes, bbox), source="enrolled"))
                enrolled += 1
        except Exception:
            continue

    if enrolled == 0:
        await db.rollback()
        raise HTTPException(status_code=422, detail="No face detected in your photos. Please retake in good lighting.")

    # Mark attendance (skip if already present)
    existing = (await db.execute(
        select(Attendance).where(
            Attendance.student_id == student.id,
            Attendance.window_id == window_id,
        )
    )).scalar_one_or_none()
    if not existing:
        db.add(Attendance(student_id=student.id, window_id=window_id, status="present", similarity_score=1.0))

    await db.commit()
    await _notify_teacher(window.class_id, student, 1.0)
    return {"status": "present", "student_name": student.name}


@router.post("/window/{window_id}/reopen")
async def reopen_window(
    window_id: int,
    extra_minutes: int = 5,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    """Re-open a closed attendance window, extending it by extra_minutes from now."""
    window = await db.get(AttendanceWindow, window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    cls = await db.get(Class, window.class_id)
    if not cls or cls.teacher_id != teacher.id:
        raise HTTPException(status_code=403, detail="Not your class")
    extra = max(1, min(120, extra_minutes))
    window.is_open  = True
    window.closes_at = datetime.now(timezone.utc) + timedelta(minutes=extra)
    await db.commit()
    await manager.broadcast(window.class_id, {
        "event": "window_reopened",
        "window_id": window.id,
        "closes_at": window.closes_at.isoformat(),
    })
    return {"window_id": window.id, "closes_at": window.closes_at.isoformat()}


@router.get("/queue-depth")
async def queue_depth(teacher=Depends(get_current_teacher)):
    """Returns the Celery task queue depth so the dashboard can show a warning if it backs up."""
    try:
        import redis as redis_sync
        r = redis_sync.Redis.from_url(settings.redis_url, socket_connect_timeout=1)
        depth = int(r.llen("celery"))
        r.close()
        return {"depth": depth, "status": "ok"}
    except Exception:
        return {"depth": -1, "status": "error"}


@router.get("/worker-health")
async def worker_health():
    """Checks whether the AI worker is reachable. Used by the student app on load."""
    alive = await check_worker_health()
    if not alive:
        return {"status": "unavailable"}
    return {"status": "ok"}


@router.websocket("/ws/{class_id}")
async def websocket_endpoint(websocket: WebSocket, class_id: int):
    await manager.connect(websocket, class_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, class_id)
