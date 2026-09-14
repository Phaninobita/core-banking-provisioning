-- ============================================================================
-- First National Bank â€” Clean Database Seed
-- Dedicated Table: rm_users (Relationship Manager Executives & Staff)
-- ============================================================================

CREATE TABLE IF NOT EXISTS rm_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL DEFAULT 'GringottsBank@324',
    password_hash VARCHAR(255) NOT NULL DEFAULT 'GringottsBank@324',
    full_name VARCHAR(128) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(128) NOT NULL DEFAULT 'Senior Relationship Manager · Corporate Banking',
    branch VARCHAR(128) DEFAULT 'Diagon Alley Financial Center',
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rm_users_username ON rm_users (LOWER(username));

-- Primary RM Executive: Phanee / Plain-Text Password: GringottsBank@324
INSERT INTO rm_users (username, password, password_hash, full_name, email, role, branch, status)
VALUES (
    'phanee',
    'GringottsBank@324',
    'GringottsBank@324',
    'Phanee',
    'phanee@fnb-us.com',
    'Senior Relationship Manager · Corporate Banking',
    'Diagon Alley Financial Center',
    'active'
)
ON CONFLICT (username) DO UPDATE SET
    password = EXCLUDED.password,
    password_hash = EXCLUDED.password_hash,
    full_name = EXCLUDED.full_name,
    email = EXCLUDED.email;

