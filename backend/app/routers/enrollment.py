"""Admin portal for enrolling students and uploading face photos."""
import io

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from PIL import Image, ImageEnhance
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.models import Attendance, AttendanceWindow, Class, ClassStudent, FaceVector, Student
from app.routers.auth import get_current_teacher
from app.services.ai_client import detect_face, embed_face

_BRIGHTNESS_FACTORS = [1.0, 0.70, 1.25]
_MIN_MEAN_BRIGHTNESS = 15
_MAX_MEAN_BRIGHTNESS = 235

router = APIRouter(prefix="/enrollment", tags=["enrollment"])


class StudentCreate(BaseModel):
    student_number: str
    name: str
    email: str | None = None
    class_id: int | None = None


class StudentUpdate(BaseModel):
    name: str | None = None
    student_number: str | None = None


class ClassCreate(BaseModel):
    name: str


# ── Classes ───────────────────────────────────────────────────────────────────

@router.get("/classes")
async def list_classes(
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    result = await db.execute(select(Class).where(Class.teacher_id == teacher.id))
    return [{"id": c.id, "name": c.name} for c in result.scalars().all()]


@router.post("/classes")
async def create_class(
    body: ClassCreate,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    cls = Class(name=body.name, teacher_id=teacher.id)
    db.add(cls)
    await db.commit()
    await db.refresh(cls)
    return {"id": cls.id, "name": cls.name}


@router.post("/classes/{class_id}/students/{student_id}")
async def add_student_to_class(
    class_id: int,
    student_id: int,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    cls = await db.get(Class, class_id)
    if not cls or cls.teacher_id != teacher.id:
        raise HTTPException(status_code=403, detail="Not your class")
    student = await db.get(Student, student_id)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    existing = (await db.execute(
        select(ClassStudent).where(
            ClassStudent.class_id == class_id,
            ClassStudent.student_id == student_id,
        )
    )).scalar_one_or_none()
    if existing:
        return {"status": "already_in_class"}
    db.add(ClassStudent(class_id=class_id, student_id=student_id))
    await db.commit()
    return {"status": "added"}


@router.delete("/classes/{class_id}/students/{student_id}", status_code=204)
async def remove_student_from_class(
    class_id: int,
    student_id: int,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    cls = await db.get(Class, class_id)
    if not cls or cls.teacher_id != teacher.id:
        raise HTTPException(status_code=403, detail="Not your class")
    await db.execute(delete(ClassStudent).where(
        ClassStudent.class_id == class_id,
        ClassStudent.student_id == student_id,
    ))
    # If the student is no longer in any class, remove them entirely
    remaining = (await db.execute(
        select(func.count()).where(ClassStudent.student_id == student_id)
    )).scalar_one()
    if remaining == 0:
        await db.execute(delete(Attendance).where(Attendance.student_id == student_id))
        await db.execute(delete(FaceVector).where(FaceVector.student_id == student_id))
        await db.execute(delete(Student).where(Student.id == student_id))
    await db.commit()


# ── Students ──────────────────────────────────────────────────────────────────

@router.get("/students/search")
async def search_students(
    q: str = Query(""),
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    """Global search across all students by name or student number."""
    if len(q) < 1:
        return []
    pattern = f"%{q}%"
    result = await db.execute(
        select(Student).where(
            (Student.name.ilike(pattern)) | (Student.student_number.ilike(pattern))
        ).limit(20)
    )
    students = result.scalars().all()
    face_counts = {}
    for s in students:
        fv_result = await db.execute(select(FaceVector).where(FaceVector.student_id == s.id))
        face_counts[s.id] = len(fv_result.scalars().all())
    return [
        {
            "id": s.id,
            "name": s.name,
            "student_number": s.student_number,
            "face_enrolled": face_counts.get(s.id, 0) > 0,
        }
        for s in students
    ]


@router.get("/students")
async def list_students(
    class_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    # Students in this class via junction table
    ids_result = await db.execute(
        select(ClassStudent.student_id).where(ClassStudent.class_id == class_id)
    )
    student_ids = [row[0] for row in ids_result.all()]
    if not student_ids:
        return []

    students = (await db.execute(
        select(Student).where(Student.id.in_(student_ids))
    )).scalars().all()

    # Face counts
    face_counts = {}
    for s in students:
        fv_result = await db.execute(select(FaceVector).where(FaceVector.student_id == s.id))
        face_counts[s.id] = len(fv_result.scalars().all())

    # Attendance stats
    total_sessions = (await db.execute(
        select(func.count(AttendanceWindow.id)).where(AttendanceWindow.class_id == class_id)
    )).scalar() or 0

    attendance_counts = {}
    latest_enrollment = {}
    for s in students:
        count = (await db.execute(
            select(func.count(Attendance.id))
            .join(AttendanceWindow, Attendance.window_id == AttendanceWindow.id)
            .where(
                Attendance.student_id == s.id,
                AttendanceWindow.class_id == class_id,
            )
        )).scalar() or 0
        attendance_counts[s.id] = count

        latest = (await db.execute(
            select(func.max(FaceVector.created_at)).where(FaceVector.student_id == s.id)
        )).scalar()
        latest_enrollment[s.id] = latest

    return [
        {
            "id": s.id,
            "student_number": s.student_number,
            "name": s.name,
            "email": s.email,
            "face_enrolled": face_counts.get(s.id, 0) > 0,
            "face_count": face_counts.get(s.id, 0),
            "sessions_attended": attendance_counts.get(s.id, 0),
            "sessions_total": total_sessions,
            "last_enrolled_at": latest_enrollment[s.id].isoformat() if latest_enrollment.get(s.id) else None,
        }
        for s in students
    ]


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
    await db.flush()
    if body.class_id:
        db.add(ClassStudent(class_id=body.class_id, student_id=student.id))
    await db.commit()
    await db.refresh(student)
    return {"id": student.id, "student_number": student.student_number, "name": student.name}


@router.put("/students/{student_id}")
async def update_student(
    student_id: int,
    body: StudentUpdate,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    student = await db.get(Student, student_id)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    if body.name is not None:
        student.name = body.name
    if body.student_number is not None:
        student.student_number = body.student_number
    await db.commit()
    return {"id": student.id, "name": student.name, "student_number": student.student_number}


@router.post("/students/{student_id}/face")
async def upload_face(
    student_id: int,
    photo: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    student = await db.get(Student, student_id)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    image_bytes = await photo.read()
    bbox = await detect_face(image_bytes)
    if bbox is None:
        raise HTTPException(status_code=422, detail="No face detected in photo. Use a clear, well-lit front-facing photo.")

    import numpy as np
    base_img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    vectors_stored = 0

    for factor in _BRIGHTNESS_FACTORS:
        if factor == 1.0:
            aug_img = base_img
            aug_bytes = image_bytes
        else:
            aug_img = ImageEnhance.Brightness(base_img).enhance(factor)
            buf = io.BytesIO()
            aug_img.save(buf, format="JPEG", quality=90)
            aug_bytes = buf.getvalue()

        mean_brightness = np.array(aug_img).mean()
        if not (_MIN_MEAN_BRIGHTNESS <= mean_brightness <= _MAX_MEAN_BRIGHTNESS):
            continue

        embedding = await embed_face(aug_bytes, bbox)
        db.add(FaceVector(student_id=student_id, embedding=embedding))
        vectors_stored += 1

    await db.commit()
    return {"status": "enrolled", "student_id": student_id, "vectors_stored": vectors_stored}


@router.delete("/students/{student_id}", status_code=204)
async def delete_student(
    student_id: int,
    db: AsyncSession = Depends(get_db),
    teacher=Depends(get_current_teacher),
):
    student = await db.get(Student, student_id)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    await db.execute(delete(Attendance).where(Attendance.student_id == student_id))
    await db.execute(delete(FaceVector).where(FaceVector.student_id == student_id))
    await db.execute(delete(ClassStudent).where(ClassStudent.student_id == student_id))
    await db.delete(student)
    await db.commit()
