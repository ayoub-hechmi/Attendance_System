"""
Celery tasks — runs in the worker process, handles the AI pipeline
so the FastAPI server stays non-blocking.
"""
import asyncio
import logging

import httpx
import numpy as np
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.pool import NullPool

from app.celery_app import celery_app
from app.core.config import settings
from app.models.models import Attendance, AttendanceWindow, FaceVector, Student
from app.services.ai_client import cosine_similarity, detect_face, embed_face
from app.services.vector_backup import write_vector_backup

logger = logging.getLogger(__name__)


def _make_session():
    engine = create_async_engine(settings.database_url, poolclass=NullPool)
    return async_sessionmaker(engine, expire_on_commit=False)


@celery_app.task(bind=True, max_retries=2)
def process_scan(self, image_bytes: bytes, window_id: int, student_number: str):
    try:
        asyncio.run(_async_process(image_bytes, window_id, student_number))
    except Exception as exc:
        logger.error("process_scan failed: %s", exc)
        raise self.retry(exc=exc, countdown=2)


async def _async_process(image_bytes: bytes, window_id: int, student_number: str):
    Session = _make_session()
    async with Session() as db:
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
        await db.refresh(attendance)

        logger.info("Marked student %s present (score=%.3f)", student_number, best_score)

        # 7. Expand dataset — Option 2: centroid check, Option 5: source tag
        all_vecs = (await db.execute(
            select(FaceVector).where(FaceVector.student_id == student.id)
        )).scalars().all()
        enrolled_vecs = [fv for fv in all_vecs if (fv.source or "enrolled") == "enrolled"]
        if enrolled_vecs:
            mat = np.array([list(fv.embedding) for fv in enrolled_vecs], dtype=np.float32)
            centroid = mat.mean(axis=0)
            c_norm = np.linalg.norm(centroid)
            v = np.array(live_vector, dtype=np.float32)
            v_norm = np.linalg.norm(v)
            centroid_sim = float(np.dot(v / v_norm, centroid / c_norm)) if c_norm and v_norm else 0.0
        else:
            centroid_sim = 1.0

        if centroid_sim >= settings.face_similarity_threshold:
            db.add(FaceVector(student_id=student.id, embedding=live_vector, source="scan"))
            await db.commit()
            all_vecs = (await db.execute(
                select(FaceVector).where(FaceVector.student_id == student.id)
            )).scalars().all()

        if settings.vectors_backup_dir:
            await asyncio.to_thread(
                write_vector_backup,
                settings.vectors_backup_dir,
                student.id, student.student_number, student.name,
                [list(fv.embedding) for fv in all_vecs],
            )

        # 8. Notify teacher dashboard via HTTP → FastAPI → WebSocket
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(
                    f"{settings.backend_url}/internal/broadcast/{window.class_id}",
                    json={
                        "event": "student_present",
                        "student_id": student.id,
                        "student_name": student.name,
                        "student_number": student.student_number,
                        "similarity_score": round(best_score, 4),
                        "scanned_at": attendance.scanned_at.isoformat() if attendance.scanned_at else None,
                    },
                )
        except Exception as e:
            logger.warning("WebSocket broadcast failed (non-critical): %s", e)
