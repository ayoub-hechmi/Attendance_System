import socket

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.routers import attendance, auth, enrollment
from app.services.websocket_manager import manager

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


@app.get("/api/v1/server-ip")
async def server_ip():
    """Returns the host's LAN IP for the teacher dashboard share link.
    start-dev.ps1 writes the Wi-Fi adapter IP to backend/.host_ip — that file
    is the authoritative source, avoiding env-var inheritance issues on Windows."""
    import os
    # Primary: file written by start-dev.ps1 (most reliable on Windows)
    host_ip_file = os.path.join(os.path.dirname(__file__), "..", ".host_ip")
    try:
        with open(host_ip_file, "r") as f:
            ip = f.read().strip()
            if ip:
                return {"ip": ip}
    except FileNotFoundError:
        pass
    # Secondary: env var (set explicitly in the start-dev.ps1 -Command string)
    host_ip = os.environ.get("HOST_IP", "").strip()
    if host_ip:
        return {"ip": host_ip}
    # Last resort: UDP socket trick (may pick wrong interface on Windows+WSL/Docker)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "localhost"
    finally:
        s.close()
    return {"ip": ip}


@app.post("/internal/broadcast/{class_id}")
async def internal_broadcast(class_id: int, request: Request):
    """Called by Celery worker to push WebSocket events to teacher dashboards."""
    message = await request.json()
    await manager.broadcast(class_id, message)
    return {"ok": True}
