# AI Face Recognition Attendance System

Automated classroom attendance powered by deep learning. Teachers open a timed session, students scan a QR code with their phone, and the system marks them present via face recognition — no app install required.

## Features

- **Face recognition** — DeepFace with RetinaFace (detection) + ArcFace (512-dim embeddings)
- **Teacher dashboard** — manage classes, open sessions, view real-time roster, export to Excel
- **Student app** — mobile-first, opens via QR code in any browser (no install)
- **Self-enrollment** — unrecognised students can register on the spot via the QR flow
- **15 vectors per student** — 5 guided poses × 3 brightness augmentations for reliable recognition
- **WebSocket updates** — teacher dashboard refreshes in real time as students check in
- **Excel export** — class name, date, time, per-student check-in timestamps

## Architecture

| Layer | Technology | Port |
|-------|-----------|------|
| Student App | React + Vite (HTTPS) | 5173 |
| Teacher Dashboard | React + Vite (HTTP) | 5174 |
| Backend API | FastAPI + SQLAlchemy async | 8000 |
| AI Worker | DeepFace 0.0.93 (Docker) | 8001 |
| Database | PostgreSQL + pgvector | 5432 |
| Task Queue | Celery + Redis | — |

All services run on the **local Wi-Fi network** — no cloud dependency.

## Prerequisites

- Python 3.11+
- Node.js 18+
- Docker Desktop
- PostgreSQL 15+
- Redis
- [mkcert](https://github.com/FiloSottile/mkcert) (for HTTPS on the student app)

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/attendance-system.git
cd attendance-system
```

### 2. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
cp .env.example .env            # then edit .env with your DB credentials
```

### 3. AI Worker (Docker)

```bash
docker compose up ai-worker -d
```

### 4. Frontend — student app (requires HTTPS for camera)

```bash
cd frontend/student-app
npm install
mkcert -install
mkcert localhost 192.168.x.x   # use your local Wi-Fi IP
# rename the generated files to cert.pem and key.pem in this folder
npm run dev
```

### 5. Frontend — teacher dashboard

```bash
cd frontend/teacher-dashboard
npm install
npm run dev
```

### 6. Start everything

```powershell
# From repo root (Windows)
.\start-dev.ps1
```

This script auto-detects your Wi-Fi IP, writes it to `backend/.host_ip`, and launches all services.

## Database

Schema is in `db/init.sql`. Run it once against your PostgreSQL instance:

```bash
psql -U postgres -f db/init.sql
```

Default demo teacher account: `teacher@demo.com` / `demo1234`

## Project Structure

```
attendance-system/
├── backend/                  # FastAPI application
│   ├── app/
│   │   ├── core/             # config.py, database.py
│   │   ├── models/           # SQLAlchemy ORM models
│   │   ├── routers/          # attendance, enrollment, auth endpoints
│   │   ├── services/         # ai_client, websocket_manager
│   │   └── tasks.py          # Celery face-processing jobs
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── student-app/          # Mobile-first React app (HTTPS :5173)
│   └── teacher-dashboard/    # Teacher control panel (HTTP :5174)
├── ai-worker/                # DeepFace Docker microservice
│   ├── Dockerfile
│   └── main.py
├── db/
│   └── init.sql              # Database schema
├── docker-compose.yml
└── start-dev.ps1             # Windows dev launcher
```

## How Face Recognition Works

1. **Detect** — RetinaFace locates and crops the face from the video frame
2. **Align** — Facial landmarks normalised to a canonical pose
3. **Embed** — ArcFace produces a 512-dimension vector
4. **Search** — pgvector cosine similarity against all enrolled student vectors
5. **Match** — Threshold ≥ 0.60 confirms identity and marks attendance

No photos are stored — only the embedding vector is saved to the database.
