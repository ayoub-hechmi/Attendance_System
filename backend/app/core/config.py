from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://attendance_user:change_me@localhost:5432/attendance_db"
    redis_url: str = "redis://localhost:6379/0"
    ai_worker_url: str = "http://localhost:8001"
    backend_url: str = "http://localhost:8000"
    secret_key: str = "change_me"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 8
    face_similarity_threshold: float = 0.80
    face_match_margin: float = 0.08
    attendance_window_minutes: int = 3
    vectors_backup_dir: str = ""

    class Config:
        env_file = ".env"


settings = Settings()
