CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS classes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    teacher_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students (
    id SERIAL PRIMARY KEY,
    student_number VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(200) UNIQUE,
    class_id INTEGER REFERENCES classes(id),
    enrolled_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS face_vectors (
    id SERIAL PRIMARY KEY,
    student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
    embedding vector(512) NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'enrolled',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast cosine similarity index
CREATE INDEX IF NOT EXISTS face_vectors_embedding_idx
    ON face_vectors USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- B-tree index for efficient lookup by student_id
CREATE INDEX IF NOT EXISTS idx_face_vectors_student_id
    ON face_vectors(student_id);

CREATE TABLE IF NOT EXISTS attendance_windows (
    id SERIAL PRIMARY KEY,
    class_id INTEGER REFERENCES classes(id),
    opened_at TIMESTAMPTZ DEFAULT NOW(),
    closes_at TIMESTAMPTZ NOT NULL,
    is_open BOOLEAN DEFAULT TRUE,
    date DATE DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    student_id INTEGER REFERENCES students(id),
    window_id INTEGER REFERENCES attendance_windows(id),
    scanned_at TIMESTAMPTZ DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'present',
    similarity_score FLOAT,
    UNIQUE(student_id, window_id)
);

CREATE TABLE IF NOT EXISTS teachers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(200) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_students (
    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (class_id, student_id)
);

-- No seed data — create your first teacher account via POST /api/v1/auth/register
