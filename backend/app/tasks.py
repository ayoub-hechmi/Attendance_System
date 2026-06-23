"""
Celery tasks — runs in the worker process, handles the AI pipeline
so the FastAPI server stays non-blocking.
"""
import asyncio
import logging

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker

from app.celery_app import celery_app
from app.core.config import settings
from app.models.models import Attendance, AttendanceWindow, FaceVector, Student
from app.services.ai_client import cosine_similarity, detect_face, embed_face
from app.services.websocket_manager import manager

logger = logging.getLogger(__name__)

_engine = create_async_engine(settings.database_url)
_Session = async_sessionmaker(_engine, expire_on_commit=False)


@celery_app.task(bind=True, max_retries=2)
def process_scan(self, image_bytes: bytes, window_id: int, student_number: str):
    """
    Full pipeline: YOLO detect → ArcFace embed → DB cosine search → mark attendance.
    Runs synchronously in a Celery worker; uses asyncio.run for async DB calls.
    """
    try:
        asyncio.run(_async_process(image_bytes, window_id, student_number))
    except Exception as exc:
        logger.error("process_scan failed: %s", exc)
        raise self.retry(exc=exc, countdown=2)


async def _async_process(image_bytes: bytes, window_id: int, student_number: str):
    async with _Session() as db:
        # 1. Verify window is still open
        window = await db.get(AttendanceWindow, window_id)
        if not window or not window.is_open:
            logger.info("Window %s is closed, discarding scan", window_id)
            return

        # 2. Detect face via AI worker
        bbox = await detect_face(image_bytes)
        if bbox is None:
            logger.info("No face detected for student %s", student_number)
            return

        # 3. Get embedding
        live_vector = await embed_face(image_bytes, bbox)

        # 4. Find the student by student number
        result = await db.execute(
            select(Student).where(Student.student_number == student_number)
        )
        student = result.scalar_one_or_none()
        if student is None:
            logger.warning("Student number %s not in DB", student_number)
            return

        # 5. Cosine similarity search against all enrolled vectors for this student
        vectors_result = await db.execute(
            select(FaceVector).where(FaceVector.student_id == student.id)
        )
        enrolled_vectors = vectors_result.scalars().all()

        if not enrolled_vectors:
            logger.warning("No enrolled face vectors for student %s", student_number)
            return

        best_score = max(
            cosine_similarity(live_vector, fv.embedding) for fv in enrolled_vectors
        )

        if best_score < settings.face_similarity_threshold:
            logger.info(
                "Face mismatch for student %s (score=%.3f, threshold=%.2f)",
                student_number, best_score, settings.face_similarity_threshold,
            )
            return

        # 6. Record attendance (ignore duplicate — student may retry)
        existing = await db.execute(
            select(Attendance).where(
                Attendance.student_id == student.id,
                Attendance.window_id == window_id,
            )
        )
        if existing.scalar_one_or_none():
            logger.info("Student %s already marked present", student_number)
            return

        attendance = Attendance(
            student_id=student.id,
            window_id=window_id,
            status="present",
            similarity_score=best_score,
        )
        db.add(attendance)
        await db.commit()

        # 7. Notify teacher dashboard via WebSocket
        await manager.broadcast(
            window.class_id,
            {
                "event": "student_present",
                "student_id": student.id,
                "student_name": student.name,
                "student_number": student.student_number,
                "similarity_score": round(best_score, 4),
                "scanned_at": attendance.scanned_at.isoformat(),
            },
        )
        logger.info("Marked student %s present (score=%.3f)", student_number, best_score)
