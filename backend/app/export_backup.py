"""
One-shot export: dump all face vectors from the DB to VECTORS_BACKUP_DIR.
Run inside the backend container:
    docker compose exec backend python /app/app/export_backup.py
"""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings
from app.models.models import FaceVector, Student

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


async def export_all() -> None:
    backup_dir = settings.vectors_backup_dir
    if not backup_dir:
        logger.error("VECTORS_BACKUP_DIR is not set. Set it in the environment and retry.")
        return

    root = Path(backup_dir)
    vectors_dir = root / "vectors"
    vectors_dir.mkdir(parents=True, exist_ok=True)

    engine = create_async_engine(settings.database_url, poolclass=NullPool)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    manifest: dict = {}
    total_students = 0
    total_vectors = 0

    async with Session() as db:
        students = (await db.execute(select(Student))).scalars().all()

        for student in students:
            fvs = (await db.execute(
                select(FaceVector).where(FaceVector.student_id == student.id)
            )).scalars().all()

            if not fvs:
                logger.info("  skip %-20s — no face vectors enrolled", student.student_number)
                continue

            embeddings = np.array([list(fv.embedding) for fv in fvs], dtype=np.float32)
            safe_num = "".join(c if c.isalnum() or c in "-_" else "_" for c in student.student_number)
            npz_path = vectors_dir / f"{safe_num}.npz"
            np.savez_compressed(str(npz_path), embeddings=embeddings)

            manifest[str(student.id)] = {
                "student_id": student.id,
                "student_number": student.student_number,
                "name": student.name,
                "vector_count": len(fvs),
                "backup_file": f"vectors/{safe_num}.npz",
                "last_updated": datetime.now(timezone.utc).isoformat(),
            }
            total_students += 1
            total_vectors += len(fvs)
            logger.info("  saved %-20s  %d vectors → %s", student.student_number, len(fvs), npz_path.name)

    with open(root / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    await engine.dispose()
    logger.info("\nDone. %d students, %d vectors total → %s", total_students, total_vectors, root)


if __name__ == "__main__":
    asyncio.run(export_all())
