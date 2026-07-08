# AI Face Recognition Attendance System

Automated attendance tracking for classroom use. The teacher opens a timed session on their dashboard and displays a QR code. Students scan the QR with their phone, the browser opens a camera view, and the system recognises their face and marks them present — no app install required.

---

## How it works

1. Teacher creates a class, enrolls students (or students self-enroll via the QR flow), and opens an attendance session.
2. Students scan the QR code with their phone camera and open the link in the browser.
3. The student app activates the front camera, runs face recognition, and auto-checks the student in within seconds.
4. The teacher's live roster updates in real time via WebSocket.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Phone / Browser                                 │
│  Student App  (React + Vite  :5173  HTTPS)       │
│  Teacher Dashboard  (React + Vite  :5174)        │
└─────────────────┬────────────────────────────────┘
                  │  REST + WebSocket
┌─────────────────▼────────────────────────────────┐
│  FastAPI Backend  (:8000)                        │
│  Celery Worker    (async task queue)             │
└──────┬───────────────┬──────────────┬────────────┘
       │               │              │
  ┌────▼─────┐   ┌─────▼──────┐  ┌───▼───┐
  │ AI Worker│   │ PostgreSQL │  │ Redis │
  │  :8001   │   │ + pgvector │  │ :6379 │
  │ DeepFace │   │   :5432    │  └───────┘
  └──────────┘   └────────────┘
```

**Face recognition pipeline:** RetinaFace detection → ArcFace 512-dim embedding → pgvector cosine similarity search → match / record attendance.

No face photos are stored — only 512-dimensional embedding vectors.

All services run on the local network. No cloud dependency.

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | runs the backend, database, AI worker, and Redis |
| [Node.js 18+](https://nodejs.org/) | runs the two React dev servers |
| [mkcert](https://github.com/FiloSottile/mkcert) | generates trusted HTTPS certificates (required for camera on mobile) |

---

## Setup

### 1. Clone the repository

```bash
git clone <repo-url>
cd attendance-system
```

### 2. Create the environment file

Create a file named `.env` in the project root (next to `docker-compose.yml`):

```env
POSTGRES_USER=attendance_user
POSTGRES_PASSWORD=choose_a_strong_password
SECRET_KEY=choose_a_random_string_of_at_least_64_characters
```

The remaining settings (`FACE_SIMILARITY_THRESHOLD`, `FACE_MATCH_MARGIN`, `ATTENDANCE_WINDOW_MINUTES`) are already set in `docker-compose.yml` and do not need to be repeated here unless you want to override them.

### 3. Start the backend services

```bash
docker compose up -d
```

On first run, Docker builds the images and the AI worker downloads the DeepFace model weights (~500 MB). This takes **3–5 minutes**. Subsequent starts are instant.

Check that all five services are running:

```bash
docker compose ps
```

### 4. Set up HTTPS for the student app

Browsers require HTTPS to access the camera. Use `mkcert` to generate a locally-trusted certificate.

```bash
# Install the local Certificate Authority once per machine
mkcert -install

# Find your local network IP
# Windows:  ipconfig  (look for "IPv4 Address" under your Wi-Fi adapter)
# macOS:    ipconfig getifaddr en0
# Linux:    hostname -I

# Generate the certificate (replace 192.168.x.x with your actual IP)
cd frontend/student-app
mkcert localhost 127.0.0.1 192.168.x.x

# Rename to the expected filenames
mv localhost+2-key.pem key.pem
mv localhost+2.pem cert.pem
cd ../..
```

> The teacher dashboard does not need HTTPS (no camera), so you can skip this for that app.

### 5. Install frontend dependencies and start the dev servers

**Terminal 1 — Student app:**
```bash
cd frontend/student-app
npm install
npm run dev
```
Accessible at `https://localhost:5173` from the same machine, and at `https://192.168.x.x:5173` from student phones on the same Wi-Fi.

**Terminal 2 — Teacher dashboard:**
```bash
cd frontend/teacher-dashboard
npm install
npm run dev
```
Accessible at `http://localhost:5174`.

### 6. Create the first teacher account

```bash
curl -X POST http://localhost:8000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Your Name","email":"you@example.com","password":"yourpassword"}'
```

You can now log in at `http://localhost:5174`.

---

## Student phone setup (one-time per device)

Students' phones need to trust the mkcert Certificate Authority before the HTTPS connection works.

1. Find the CA file on the machine running the app:
   ```bash
   mkcert -CAROOT
   ```
2. Share the `rootCA.pem` file from that folder (email, QR code, USB, etc.).
3. Install it on the phone:
   - **Android:** open the file → Settings → Security → Install certificate
   - **iOS:** tap the file → Settings → General → VPN & Device Management → install

This is a one-time step per device.

---

## Everyday use

```bash
# Start backend (if not already running)
docker compose up -d

# Student app
cd frontend/student-app && npm run dev

# Teacher dashboard
cd frontend/teacher-dashboard && npm run dev
```

Data persists in Docker volumes between restarts. To stop all backend services:

```bash
docker compose down
```

---

## Project structure

```
attendance-system/
├── backend/
│   └── app/
│       ├── core/           # config, database connection
│       ├── models/         # SQLAlchemy ORM models
│       ├── routers/        # attendance, enrollment, auth endpoints
│       ├── services/       # AI client, WebSocket manager, vector backup
│       └── tasks.py        # Celery async face-processing tasks
├── ai-worker/              # DeepFace microservice (RetinaFace + ArcFace)
├── frontend/
│   ├── student-app/        # Student PWA (React + Vite, HTTPS :5173)
│   └── teacher-dashboard/  # Teacher UI (React + Vite, :5174)
├── db/
│   └── init.sql            # Schema creation + pgvector setup
├── docker-compose.yml
├── .env                    # Not committed — create from the template above
└── .env.example            # Reference for environment variables
```

---

## Configuration

Tunable values are set as environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `FACE_SIMILARITY_THRESHOLD` | `0.60` | Minimum cosine similarity to accept a match (0–1) |
| `FACE_MATCH_MARGIN` | `0.08` | Required gap between the best and second-best match score |
| `ATTENDANCE_WINDOW_MINUTES` | `3` | Default session duration in minutes |

---

## Troubleshooting

**AI worker is slow on first start**
Normal — it downloads RetinaFace and ArcFace model weights (~500 MB). Monitor with:
```bash
docker compose logs -f ai-worker
```

**"Camera requires HTTPS" on student phone**
Make sure you generated the mkcert certificate (`key.pem` / `cert.pem` in `frontend/student-app/`) and that the phone has the CA installed (see Student phone setup above). Open the link with `https://` not `http://`.

**Backend returns 500 errors after pulling an update**
A database migration may be needed. Run:
```bash
docker compose exec db psql -U attendance_user -d attendance_db -c \
  "ALTER TABLE face_vectors ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'enrolled';"
docker compose restart backend celery-worker
```

**Student not recognised**
- Make sure the student completed enrollment (10 frames across 5 guided poses).
- Try better lighting — avoid strong backlight or very dim conditions.
- If scores are consistently below 60%, re-enroll under different lighting conditions.
