"""Admin portal for enrolling students and uploading face photos."""
import io

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.models import FaceVector, Student
from app.routers.auth import get_current_teacher
from app.services.ai_client import detect_face, embed_face

router = APIRouter(prefix="/enrollment", tags=["enrollment"])


class StudentCreate(BaseModel):
    student_number: str
    name: str
    email: str | None = None
    class_id: int


@router.post("/students")
async def create_student(
    body: StudentCreate,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    student = Student(
        student_number=body.student_number,
        name=body.name,
        email=body.email,
        class_id=body.class_id,
    )
    db.add(student)
    await db.commit()
    await db.refresh(student)
    return {"id": student.id, "student_number": student.student_number, "name": student.name}


@router.post("/students/{student_id}/face")
async def upload_face(
    student_id: int,
    photo: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    """
    Upload a face photo for enrollment.
    Runs YOLO detect → ArcFace embed and stores the vector.
    Call this 2-3 times with different photos for better accuracy.
    """
    student = await db.get(Student, student_id)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    image_bytes = await photo.read()

    bbox = await detect_face(image_bytes)
    if bbox is None:
        raise HTTPException(status_code=422, detail="No face detected in photo. Use a clear, well-lit front-facing photo.")

    embedding = await embed_face(image_bytes, bbox)

    fv = FaceVector(student_id=student_id, embedding=embedding)
    db.add(fv)
    await db.commit()

    return {
        "status": "enrolled",
        "student_id": student_id,
        "vector_id": fv.id,
        "tip": "Upload 2-3 photos from different angles for better accuracy.",
    }
