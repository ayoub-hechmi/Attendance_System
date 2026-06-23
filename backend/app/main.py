from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import attendance, auth, enrollment

app = FastAPI(
    title="Attendance System API",
    description="AI-powered face recognition attendance backend",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict to your domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(attendance.router, prefix="/api/v1")
app.include_router(enrollment.router, prefix="/api/v1")


@app.get("/health")
async def health():
    return {"status": "ok"}
