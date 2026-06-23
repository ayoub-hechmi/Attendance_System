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
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast cosine similarity index
CREATE INDEX IF NOT EXISTS face_vectors_embedding_idx
    ON face_vectors USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

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

-- Seed a demo class and teacher (password: "demo1234")
INSERT INTO teachers (name, email, password_hash)
VALUES ('Demo Teacher', 'teacher@demo.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMUJqxDvb8tX0yY5Jq5vK5pX4W')
ON CONFLICT DO NOTHING;

INSERT INTO classes (name, teacher_id)
VALUES ('CS101 - Introduction to Computer Science', 1)
ON CONFLICT DO NOTHING;
