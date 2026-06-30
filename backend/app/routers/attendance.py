import io
import logging
from datetime import datetime, timedelta, timezone
from typing import List

import httpx
from PIL import Image, ImageEnhance
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models.models import Attendance, AttendanceWindow, Class, ClassStudent, FaceVector, Student
from app.routers.auth import get_current_teacher
from app.services.ai_client import cosine_similarity, detect_face, detect_face_fast, embed_face
from app.services.websocket_manager import manager
from app.tasks import process_scan

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/attendance", tags=["attendance"])


async def _students_in_class(class_id: int, db: AsyncSession):
    """Return all Student objects in a class via the class_students junction table."""
    ids_result = await db.execute(
        select(ClassStudent.student_id).where(ClassStudent.class_id == class_id)
    )
    student_ids = [row[0] for row in ids_result.all()]
    if not student_ids:
        return []
    return (await db.execute(select(Student).where(Student.id.in_(student_ids)))).scalars().all()


async def _best_match(live_vector, class_id: int, db: AsyncSession):
    """Return (student, score) for the best face match in a class, or (None, 0)."""
    students = await _students_in_class(class_id, db)
    best_score = 0.0
    best_student = None
    for student in students:
        vecs = (await db.execute(select(FaceVector).where(FaceVector.student_id == student.id))).scalars().all()
        if not vecs:
            continue
        score = max(cosine_similarity(live_vector, fv.embedding) for fv in vecs)
        logger.info("Face match score for %s: %.4f (threshold: %.2f)", student.name, score, settings.face_similarity_threshold)
        if score > best_score:
            best_score = score
            best_student = student
    return best_student, best_score


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
    student, score = await _best_match(live_vector, window.class_id, db)

    if student and score >= settings.face_similarity_threshold:
        return {"found": True, "bbox": bbox, "name": student.name, "student_number": student.student_number, "score": round(score * 100, 1)}
    return {"found": False, "bbox": bbox, "name": None, "score": None}


@router.post("/scan-sync")
async def scan_face_sync(
    image: UploadFile = File(...),
    window_id: int = Form(...),
    db: AsyncSession = Depends(get_db),
):
    window = await db.get(AttendanceWindow, window_id)
    if not window or not window.is_open or datetime.now(timezone.utc) > window.closes_at:
        return {"status": "error", "message": "Attendance session is not open or has expired."}

    image_bytes = await image.read()
    bbox = await detect_face(image_bytes)
    if not bbox:
        return {"status": "no_face", "message": "No face detected. Look directly at the camera and try again."}

    live_vector = await embed_face(image_bytes, bbox)
    student, score = await _best_match(live_vector, window.class_id, db)

    if not student or score < settings.face_similarity_threshold:
        return {"status": "not_recognised", "message": "Face not recognised. Make sure you are enrolled in this class."}

    existing = (await db.execute(
        select(Attendance).where(Attendance.student_id == student.id, Attendance.window_id == window_id)
    )).scalar_one_or_none()
    if existing:
        return {"status": "already_present", "message": f"{student.name} is already marked present for this session."}

    attendance = Attendance(student_id=student.id, window_id=window_id, status="present", similarity_score=score)
    db.add(attendance)
    await db.commit()

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
    window = await db.get(AttendanceWindow, window_id)
    if not window or not window.is_open or datetime.now(timezone.utc) > window.closes_at:
        raise HTTPException(status_code=400, detail="This attendance session is not open.")

    # Re-use an existing student if the student number already exists globally
    student = (await db.execute(
        select(Student).where(Student.student_number == student_number.strip())
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
        student = Student(name=name.strip(), student_number=student_number.strip())
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
                db.add(FaceVector(student_id=student.id, embedding=await embed_face(aug_bytes, bbox)))
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


@router.websocket("/ws/{class_id}")
async def websocket_endpoint(websocket: WebSocket, class_id: int):
    await manager.connect(websocket, class_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, class_id)
