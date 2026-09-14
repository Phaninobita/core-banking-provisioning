-- =======================================================
-- Core Banking Provisioning: Customer Information File (CIF)
-- & Dedicated BIC Registry
-- Runs after 02_create_stage_tables.sql (idempotent).
-- =======================================================

-- 1. Customer Information File (CIF) — the master customer record
--    created for every onboarded (approved) corporate applicant.
CREATE TABLE IF NOT EXISTS customer_information_files (
    id BIGSERIAL PRIMARY KEY,
    cif_number VARCHAR(32) UNIQUE NOT NULL,
    company_uid VARCHAR(64) UNIQUE NOT NULL,
    application_ref VARCHAR(64),
    crn VARCHAR(64),
    company_name TEXT,
    trade_name TEXT,
    legal_type TEXT,
    registered_email VARCHAR(255),
    contact_person TEXT,
    phone TEXT,
    address TEXT,
    customer_type VARCHAR(64) NOT NULL DEFAULT 'CORPORATE',
    customer_segment VARCHAR(64) DEFAULT 'Corporate Banking',
    risk_rating VARCHAR(32) DEFAULT 'LOW',
    kyc_status VARCHAR(32) NOT NULL DEFAULT 'passed',
    onboarding_status VARCHAR(32) NOT NULL DEFAULT 'onboarded',
    dedicated_bic VARCHAR(16),
    rm_id TEXT DEFAULT 'RM-PHANEE',
    rm_name TEXT DEFAULT 'Phanee (Senior Relationship Manager)',
    profile_data JSONB DEFAULT '{}'::jsonb,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cif_company_uid ON customer_information_files (company_uid);
CREATE INDEX IF NOT EXISTS idx_cif_cif_number ON customer_information_files (cif_number);
CREATE INDEX IF NOT EXISTS idx_cif_application_ref ON customer_information_files (application_ref);

DROP TRIGGER IF EXISTS trg_cif_updated_at ON customer_information_files;
CREATE TRIGGER trg_cif_updated_at
BEFORE UPDATE ON customer_information_files
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

-- 2. Dedicated BIC Registry — one SWIFT BIC assigned per onboarded
--    corporate customer for their portal transactions.
CREATE TABLE IF NOT EXISTS customer_bic_registry (
    id BIGSERIAL PRIMARY KEY,
    bic VARCHAR(16) UNIQUE NOT NULL,
    bic_type VARCHAR(32) NOT NULL DEFAULT 'dedicated_customer',
    company_uid VARCHAR(64) UNIQUE NOT NULL,
    cif_number VARCHAR(32),
    company_name TEXT,
    branch_code VARCHAR(32) DEFAULT 'XXX',
    country_code VARCHAR(8) DEFAULT 'AE',
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bic_registry_company_uid ON customer_bic_registry (company_uid);
CREATE INDEX IF NOT EXISTS idx_bic_registry_bic ON customer_bic_registry (bic);

-- 3. Link core accounts to their CIF and dedicated BIC
ALTER TABLE corporate_accounts ADD COLUMN IF NOT EXISTS cif_number VARCHAR(32);
ALTER TABLE corporate_accounts ADD COLUMN IF NOT EXISTS bic VARCHAR(16);

CREATE INDEX IF NOT EXISTS idx_corp_acc_cif ON corporate_accounts (cif_number);
CREATE INDEX IF NOT EXISTS idx_corp_acc_bic ON corporate_accounts (bic);
