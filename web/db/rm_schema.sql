-- ==============================================================================
-- First National Bank Relationship Manager (RM) Customer Onboarding Schema
-- Table: rm_customer_invitations
-- Composite Primary Key: (crn, email)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS rm_customer_invitations (
    crn VARCHAR(64) NOT NULL,
    email VARCHAR(255) NOT NULL,
    company_name TEXT NOT NULL,
    contact_person VARCHAR(255),
    phone VARCHAR(64),
    rm_name VARCHAR(128) NOT NULL DEFAULT 'Michael Vance (VP Corporate Banking)',
    rm_id VARCHAR(64) NOT NULL DEFAULT 'RM-FNB-9042',
    invite_token VARCHAR(128) UNIQUE NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'invited', -- invited | viewed | in_progress | completed
    invite_link TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (crn, email)
);

CREATE INDEX IF NOT EXISTS idx_rm_invites_status ON rm_customer_invitations (status);
CREATE INDEX IF NOT EXISTS idx_rm_invites_token ON rm_customer_invitations (invite_token);

-- ==============================================================================
-- Table: rm_users (Relationship Manager Executives & Staff)
-- ==============================================================================
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


