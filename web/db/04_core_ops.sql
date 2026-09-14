-- =======================================================
-- Core Banking Operations: Maker-Checker Authorization Queue
-- Every CIF creation, account opening and transaction goes in
-- as a request by a MAKER and is executed only after a
-- different user (CHECKER) approves it. Full audit trail.
-- Idempotent; run after 03_core_provisioning.sql.
-- =======================================================

CREATE TABLE IF NOT EXISTS core_authorization_requests (
    id BIGSERIAL PRIMARY KEY,
    request_ref VARCHAR(32) UNIQUE NOT NULL,
    request_type VARCHAR(32) NOT NULL,          -- CIF_CREATE | ACCOUNT_CREATE | TRANSACTION
    payload JSONB NOT NULL DEFAULT '{}'::jsonb, -- full request details
    status VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    maker_id VARCHAR(64) NOT NULL,
    maker_name TEXT,
    maker_comment TEXT,
    checker_id VARCHAR(64),
    checker_name TEXT,
    checker_comment TEXT,
    result_ref TEXT,                            -- created cif_number / account_number / transaction_ref
    company_uid VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_core_auth_status ON core_authorization_requests (status);
CREATE INDEX IF NOT EXISTS idx_core_auth_type ON core_authorization_requests (request_type);
CREATE INDEX IF NOT EXISTS idx_core_auth_maker ON core_authorization_requests (maker_id);
CREATE INDEX IF NOT EXISTS idx_core_auth_created ON core_authorization_requests (created_at DESC);

DROP TRIGGER IF EXISTS trg_core_auth_updated_at ON core_authorization_requests;
CREATE TRIGGER trg_core_auth_updated_at
BEFORE UPDATE ON core_authorization_requests
FOR EACH ROW EXECUTE FUNCTION update_modified_column();
