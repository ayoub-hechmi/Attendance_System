FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Pre-download the YOLO face model at build time so startup is instant
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n-face.pt')"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
