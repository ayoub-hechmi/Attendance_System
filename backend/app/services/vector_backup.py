"""Shared utility: write face-vector backups to VECTORS_BACKUP_DIR."""
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)


def write_vector_backup(backup_dir: str, student_id: int, student_number: str,
                        student_name: str, embeddings: list) -> None:
    """Write/update the .npz for one student and refresh manifest.json (blocking I/O)."""
    root = Path(backup_dir)
    vectors_dir = root / "vectors"
    vectors_dir.mkdir(parents=True, exist_ok=True)

    safe_num = "".join(c if c.isalnum() or c in "-_" else "_" for c in student_number)
    npz_path = vectors_dir / f"{safe_num}.npz"

    arr = np.array(embeddings, dtype=np.float32)
    np.savez_compressed(str(npz_path), embeddings=arr)

    manifest_path = root / "manifest.json"
    manifest: dict = {}
    if manifest_path.exists():
        try:
            with open(manifest_path, encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}

    manifest[str(student_id)] = {
        "student_id": student_id,
        "student_number": student_number,
        "name": student_name,
        "vector_count": len(embeddings),
        "backup_file": f"vectors/{safe_num}.npz",
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    logger.info(
        "Backup: %d vectors for student %s → %s",
        len(embeddings), student_number, npz_path.name,
    )
