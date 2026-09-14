-- =======================================================
-- Core Activation Handoff (STP) — mirror of the onboarding
-- tables with a `_core` suffix. When a journey reaches
-- ACCOUNT ACTIVATED, the verified onboarding data (company
-- name, CRN, emails, contact, documents, UBOs, ownership,
-- mandates, tax, declarations) is copied verbatim into these
-- tables. Core account opening then uses the SAME registered
-- name / CRN captured during onboarding — the real-time
-- banking straight-through technique (no re-keying).
-- Idempotent; run after 04_core_ops.sql.
-- =======================================================

-- 1. Master — mirrors corporate_onboarding_applications
CREATE TABLE IF NOT EXISTS corporate_onboarding_applications_core (
    id BIGSERIAL PRIMARY KEY,
    company_uid VARCHAR(64) UNIQUE,
    application_ref VARCHAR(64) UNIQUE,
    crn VARCHAR(64) NOT NULL,
    registered_email VARCHAR(255) NOT NULL,
    current_step INT DEFAULT 7,
    status VARCHAR(32) NOT NULL DEFAULT 'account_activated',
    company_name TEXT,
    trade_name TEXT,
    legal_type TEXT,
    licence_issue_date TEXT,
    licence_expiry_date TEXT,
    licence_issued_by TEXT,
    vat_trn TEXT,
    contact_person TEXT,
    phone TEXT,
    address TEXT,
    form_data JSONB DEFAULT '{}'::jsonb,
    cif_number VARCHAR(32),
    dedicated_bic VARCHAR(16),
    account_number VARCHAR(32),
    activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_apps_core_crn ON corporate_onboarding_applications_core (crn);
CREATE INDEX IF NOT EXISTS idx_apps_core_cuid ON corporate_onboarding_applications_core (company_uid);

-- 2-8. Stage mirrors — same shape as the onboarding stage tables
CREATE TABLE IF NOT EXISTS step1_documents_core (
    id BIGSERIAL PRIMARY KEY,
    company_uid VARCHAR(64) NOT NULL,
    application_ref VARCHAR(64) NOT NULL,
    document_type VARCHAR(64) NOT NULL,
    file_name TEXT,
    file_type VARCHAR(64) DEFAULT 'application/pdf',
    file_size BIGINT DEFAULT 0,
    file_data_base64 TEXT,
    ocr_status VARCHAR(32) DEFAULT 'verified',
    verification_status VARCHAR(32) DEFAULT 'approved',
    extracted_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step1_core_cuid ON step1_documents_core (company_uid);

CREATE TABLE IF NOT EXISTS step2_company_info_core (
    company_uid VARCHAR(64) PRIMARY KEY,
    application_ref VARCHAR(64) NOT NULL,
    crn VARCHAR(64) NOT NULL,
    company_name TEXT NOT NULL,
    trade_name TEXT,
    legal_type VARCHAR(128),
    licence_issued_by TEXT,
    licence_issue_date TEXT,
    licence_expiry_date TEXT,
    vat_trn VARCHAR(64),
    contact_person TEXT,
    registered_email VARCHAR(255),
    phone VARCHAR(64),
    registered_address TEXT,
    operating_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS step3_ubo_details_core (
    id BIGSERIAL PRIMARY KEY,
    company_uid VARCHAR(64) NOT NULL,
    application_ref VARCHAR(64) NOT NULL,
    full_name TEXT NOT NULL,
    nationality VARCHAR(64) DEFAULT 'AE',
    id_type VARCHAR(32) DEFAULT 'passport',
    id_number VARCHAR(64),
    date_of_birth DATE,
    share_percentage NUMERIC(5, 2) DEFAULT 0.00,
    is_pep BOOLEAN DEFAULT FALSE,
    pep_details TEXT,
    biometric_status VARCHAR(32) DEFAULT 'verified',
    residential_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step3_core_cuid ON step3_ubo_details_core (company_uid);

CREATE TABLE IF NOT EXISTS step4_ownership_core (
    company_uid VARCHAR(64) PRIMARY KEY,
    application_ref VARCHAR(64) NOT NULL,
    has_holding_company BOOLEAN DEFAULT FALSE,
    parent_company_name TEXT,
    parent_company_country VARCHAR(64),
    total_shares_percentage NUMERIC(5, 2) DEFAULT 100.00,
    ownership_hierarchy JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS step5_roles_core (
    company_uid VARCHAR(64) PRIMARY KEY,
    application_ref VARCHAR(64) NOT NULL,
    signing_power VARCHAR(64) DEFAULT 'sole',
    dual_authorization_threshold NUMERIC(18, 2) DEFAULT 50000.00,
    maker_checker_enabled BOOLEAN DEFAULT TRUE,
    primary_maker_email VARCHAR(255),
    primary_checker_email VARCHAR(255),
    daily_transfer_limit NUMERIC(18, 2) DEFAULT 250000.00,
    single_transaction_limit NUMERIC(18, 2) DEFAULT 100000.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS step6_fatca_crs_core (
    company_uid VARCHAR(64) PRIMARY KEY,
    application_ref VARCHAR(64) NOT NULL,
    is_us_person BOOLEAN DEFAULT FALSE,
    us_tin VARCHAR(64),
    giin_number VARCHAR(64),
    fatca_classification VARCHAR(128) DEFAULT 'Active NFFE',
    crs_tax_residency_country VARCHAR(64) DEFAULT 'AE',
    foreign_tin VARCHAR(64),
    source_of_wealth TEXT,
    source_of_funds TEXT,
    expected_annual_turnover NUMERIC(18, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS step7_review_submit_core (
    company_uid VARCHAR(64) PRIMARY KEY,
    application_ref VARCHAR(64) NOT NULL,
    agreed_terms BOOLEAN DEFAULT TRUE,
    agreed_accuracy_warranties BOOLEAN DEFAULT TRUE,
    agreed_data_privacy BOOLEAN DEFAULT TRUE,
    signatory_name TEXT,
    signatory_email VARCHAR(255),
    docusign_envelope_id VARCHAR(128),
    signature_hash TEXT,
    ip_address VARCHAR(64),
    user_agent TEXT,
    signed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
