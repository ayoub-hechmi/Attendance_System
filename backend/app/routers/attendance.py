from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models.models import Attendance, AttendanceWindow, Class, Student
from app.routers.auth import get_current_teacher
from app.services.websocket_manager import manager
from app.tasks import process_scan

router = APIRouter(prefix="/attendance", tags=["attendance"])


@router.post("/window/open")
async def open_window(
    class_id: int,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    """Teacher opens a 3-minute attendance window."""
    cls = await db.get(Class, class_id)
    if not cls or cls.teacher_id != teacher.id:
        raise HTTPException(status_code=403, detail="Not your class")

    closes_at = datetime.utcnow() + timedelta(minutes=settings.attendance_window_minutes)
    window = AttendanceWindow(class_id=class_id, closes_at=closes_at)
    db.add(window)
    await db.commit()
    await db.refresh(window)

    await manager.broadcast(class_id, {
        "event": "window_opened",
        "window_id": window.id,
        "closes_at": closes_at.isoformat(),
        "minutes": settings.attendance_window_minutes,
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


@router.post("/scan")
async def scan_face(
    image: UploadFile = File(...),
    student_number: str = Form(...),
    window_id: int = Form(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Student endpoint — called from the PWA.
    Validates the window is open, then queues the AI pipeline via Celery.
    Returns immediately so the student sees a fast response.
    """
    window = await db.get(AttendanceWindow, window_id)
    if not window or not window.is_open or datetime.utcnow() > window.closes_at:
        raise HTTPException(status_code=403, detail="Attendance window is not open")

    # Per-student cooldown check (max 3 scan attempts per session)
    recent = await db.execute(
        select(Attendance).where(
            Attendance.window_id == window_id,
            Attendance.student_id == (
                select(Student.id).where(Student.student_number == student_number).scalar_subquery()
            ),
        )
    )
    if recent.scalar_one_or_none():
        return {"status": "already_marked", "message": "You are already marked present."}

    image_bytes = await image.read()
    process_scan.delay(image_bytes, window_id, student_number)

    return {"status": "queued", "message": "Processing your scan, please wait..."}


@router.get("/window/{window_id}/roster")
async def get_roster(
    window_id: int,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    """Return all students in the class with their present/absent status."""
    window = await db.get(AttendanceWindow, window_id)
    if not window:
        raise HTTPException(status_code=404)

    students_result = await db.execute(
        select(Student).where(Student.class_id == window.class_id)
    )
    students = students_result.scalars().all()

    present_result = await db.execute(
        select(Attendance.student_id).where(Attendance.window_id == window_id)
    )
    present_ids = {row[0] for row in present_result.all()}

    return {
        "window": {
            "id": window.id,
            "is_open": window.is_open,
            "closes_at": window.closes_at.isoformat(),
        },
        "roster": [
            {
                "id": s.id,
                "name": s.name,
                "student_number": s.student_number,
                "status": "present" if s.id in present_ids else "absent",
            }
            for s in students
        ],
    }


@router.websocket("/ws/{class_id}")
async def websocket_endpoint(websocket: WebSocket, class_id: int):
    """Teacher dashboard connects here for real-time updates."""
    await manager.connect(websocket, class_id)
    try:
        while True:
            await websocket.receive_text()  # keep connection alive
    except WebSocketDisconnect:
        manager.disconnect(websocket, class_id)
