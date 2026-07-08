from datetime import datetime, date
from sqlalchemy import Boolean, Column, Date, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint, Table
from sqlalchemy.orm import relationship
from pgvector.sqlalchemy import Vector

from app.core.database import Base


class Teacher(Base):
    __tablename__ = "teachers"
    id = Column(Integer, primary_key=True)
    name = Column(String(150), nullable=False)
    email = Column(String(200), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    classes = relationship("Class", back_populates="teacher")


class ClassStudent(Base):
    __tablename__ = "class_students"
    class_id = Column(Integer, ForeignKey("classes.id", ondelete="CASCADE"), primary_key=True)
    student_id = Column(Integer, ForeignKey("students.id", ondelete="CASCADE"), primary_key=True)
    added_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class Class(Base):
    __tablename__ = "classes"
    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    teacher_id = Column(Integer, ForeignKey("teachers.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    teacher = relationship("Teacher", back_populates="classes")
    windows = relationship("AttendanceWindow", back_populates="class_")


class Student(Base):
    __tablename__ = "students"
    id = Column(Integer, primary_key=True)
    student_number = Column(String(50), unique=True, nullable=False)
    name = Column(String(150), nullable=False)
    email = Column(String(200), unique=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=True)
    enrolled_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    face_vectors = relationship("FaceVector", back_populates="student", cascade="all, delete-orphan")
    attendances = relationship("Attendance", back_populates="student")


class FaceVector(Base):
    __tablename__ = "face_vectors"
    id = Column(Integer, primary_key=True)
    student_id = Column(Integer, ForeignKey("students.id", ondelete="CASCADE"))
    embedding = Column(Vector(512), nullable=False)
    source = Column(String(20), nullable=False, server_default="enrolled")
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    student = relationship("Student", back_populates="face_vectors")


class AttendanceWindow(Base):
    __tablename__ = "attendance_windows"
    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classes.id"))
    opened_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    closes_at = Column(DateTime(timezone=True), nullable=False)
    is_open = Column(Boolean, default=True)
    date = Column(Date, default=date.today)
    class_ = relationship("Class", back_populates="windows")
    attendances = relationship("Attendance", back_populates="window")


class Attendance(Base):
    __tablename__ = "attendance"
    __table_args__ = (UniqueConstraint("student_id", "window_id"),)
    id = Column(Integer, primary_key=True)
    student_id = Column(Integer, ForeignKey("students.id"))
    window_id = Column(Integer, ForeignKey("attendance_windows.id"))
    scanned_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    status = Column(String(20), default="present")
    similarity_score = Column(Float)
    student = relationship("Student", back_populates="attendances")
    window = relationship("AttendanceWindow", back_populates="attendances")
