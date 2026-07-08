from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
import bcrypt
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models.models import Teacher

router = APIRouter(prefix="/auth", tags=["auth"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


class Token(BaseModel):
    access_token: str
    token_type: str


def create_access_token(data: dict) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode({**data, "exp": expire}, settings.secret_key, algorithm=settings.algorithm)


async def get_current_teacher(token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        teacher_id: int = payload.get("sub")
        if teacher_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    teacher = await db.get(Teacher, int(teacher_id))
    if teacher is None:
        raise credentials_exception
    return teacher


def get_password_hash(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(12)).decode()


class TeacherRegister(BaseModel):
    name: str
    email: str
    password: str


@router.post("/register", status_code=201)
async def register(body: TeacherRegister, db: AsyncSession = Depends(get_db)):
    name = body.name.strip()
    email = body.email.strip().lower()
    if not name or len(name) > 150:
        raise HTTPException(status_code=422, detail="Name must be between 1 and 150 characters.")
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters.")
    existing = (await db.execute(select(Teacher).where(Teacher.email == email))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    teacher = Teacher(name=name, email=email, password_hash=get_password_hash(body.password))
    db.add(teacher)
    await db.commit()
    await db.refresh(teacher)
    return {"id": teacher.id, "name": teacher.name, "email": teacher.email}


@router.post("/token", response_model=Token)
async def login(form: OAuth2PasswordRequestForm = Depends(), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Teacher).where(Teacher.email == form.username.strip().lower()))
    teacher = result.scalar_one_or_none()
    if not teacher or not verify_password(form.password, teacher.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    token = create_access_token({"sub": str(teacher.id)})
    return {"access_token": token, "token_type": "bearer"}
