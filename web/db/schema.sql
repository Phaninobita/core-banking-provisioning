-- First National Bank Corporate Account Portal & Core Banking Mesh
-- Database Schema for PostgreSQL / Supabase
-- Canonical Corporate Identifier: company_uid across all tables

-- =======================================================
-- 1. Corporate Onboarding Applications Table
-- =======================================================
CREATE TABLE IF NOT EXISTS corporate_onboarding_applications (
    id BIGSERIAL PRIMARY KEY,
    company_uid VARCHAR(64),
    application_ref VARCHAR(64) UNIQUE NOT NULL,
    crn VARCHAR(64) NOT NULL,
    registered_email VARCHAR(255) NOT NULL,
    current_step INT NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT 'draft',
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
    form_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upgrades for corporate_onboarding_applications
ALTER TABLE corporate_onboarding_applications ADD COLUMN IF NOT EXISTS company_uid VARCHAR(64);
ALTER TABLE corporate_onboarding_applications ADD COLUMN IF NOT EXISTS contact_person TEXT;
ALTER TABLE corporate_onboarding_applications ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE corporate_onboarding_applications ADD COLUMN IF NOT EXISTS address TEXT;

CREATE INDEX IF NOT EXISTS idx_corp_apps_company_uid 
ON corporate_onboarding_applications (company_uid);

CREATE INDEX IF NOT EXISTS idx_corp_apps_cuid_id 
ON corporate_onboarding_applications (company_uid, id);

CREATE INDEX IF NOT EXISTS idx_corp_apps_crn_email 
ON corporate_onboarding_applications (crn, registered_email);

CREATE INDEX IF NOT EXISTS idx_corp_apps_app_ref 
ON corporate_onboarding_applications (application_ref);

-- =======================================================
-- 2. Relationship Manager (RM) Customer Invitations Table
-- =======================================================
CREATE TABLE IF NOT EXISTS rm_customer_invitations (
    id BIGSERIAL PRIMARY KEY,
    company_uid VARCHAR(64),
    crn VARCHAR(64) NOT NULL,
    email VARCHAR(255) NOT NULL,
    company_name TEXT NOT NULL,
    contact_person TEXT,
    phone TEXT,
    rm_name TEXT DEFAULT 'Phanee (Senior RM)',
    rm_id TEXT DEFAULT 'RM-PHANEE',
    invite_token VARCHAR(64) NOT NULL,
    status VARCHAR(32) DEFAULT 'invited',
    invite_link TEXT,
    notes TEXT,
    current_step INT DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (crn, email)
);

ALTER TABLE rm_customer_invitations ADD COLUMN IF NOT EXISTS company_uid VARCHAR(64);
ALTER TABLE rm_customer_invitations ADD COLUMN IF NOT EXISTS contact_person TEXT;
ALTER TABLE rm_customer_invitations ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE rm_customer_invitations ADD COLUMN IF NOT EXISTS current_step INT DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_rm_inv_company_uid 
ON rm_customer_invitations (company_uid);

CREATE INDEX IF NOT EXISTS idx_rm_inv_cuid_id 
ON rm_customer_invitations (company_uid, id);

CREATE INDEX IF NOT EXISTS idx_rm_inv_crn_email 
ON rm_customer_invitations (crn, email);

-- =======================================================
-- 3. Base64 Documents Vault Table
-- =======================================================
CREATE TABLE IF NOT EXISTS application_documents (
    id BIGSERIAL PRIMARY KEY,
    company_uid VARCHAR(64),
    application_ref VARCHAR(64) NOT NULL,
    document_type VARCHAR(64) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(64) NOT NULL,
    file_size INT NOT NULL,
    file_data_base64 TEXT NOT NULL,
    ocr_status VARCHAR(32) DEFAULT 'completed',
    extracted_metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE application_documents ADD COLUMN IF NOT EXISTS company_uid VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_app_docs_company_uid 
ON application_documents (company_uid);

CREATE INDEX IF NOT EXISTS idx_app_docs_cuid_id 
ON application_documents (company_uid, id);

CREATE INDEX IF NOT EXISTS idx_app_docs_ref 
ON application_documents (application_ref);

CREATE INDEX IF NOT EXISTS idx_app_docs_type 
ON application_documents (application_ref, document_type);

-- =======================================================
-- 4. Core Banking Accounts Table (Live Banking)
-- =======================================================
CREATE TABLE IF NOT EXISTS corporate_accounts (
    id BIGSERIAL PRIMARY KEY,
    company_uid VARCHAR(64),
    account_number VARCHAR(32) UNIQUE NOT NULL,
    iban VARCHAR(64) UNIQUE NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'AED',
    account_name VARCHAR(255) NOT NULL,
    account_type VARCHAR(64) NOT NULL DEFAULT 'Corporate Checking',
    balance NUMERIC(18, 2) NOT NULL DEFAULT 0.00,
    available_balance NUMERIC(18, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    application_ref VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE corporate_accounts ADD COLUMN IF NOT EXISTS company_uid VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_corp_acc_company_uid 
ON corporate_accounts (company_uid);

CREATE INDEX IF NOT EXISTS idx_corp_acc_cuid_id 
ON corporate_accounts (company_uid, id);

-- =======================================================
-- 5. Banking Transactions Ledger Table
-- =======================================================
CREATE TABLE IF NOT EXISTS account_transactions (
    id BIGSERIAL PRIMARY KEY,
    company_uid VARCHAR(64),
    transaction_ref VARCHAR(64) UNIQUE NOT NULL,
    swift_uetr VARCHAR(64),
    account_id BIGINT REFERENCES corporate_accounts(id),
    account_number VARCHAR(32) NOT NULL,
    type VARCHAR(32) NOT NULL, -- 'credit', 'debit', 'wire_transfer', 'fx_exchange'
    amount NUMERIC(18, 2) NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'AED',
    counterparty_name VARCHAR(255),
    counterparty_iban VARCHAR(64),
    description TEXT,
    category VARCHAR(64),
    status VARCHAR(32) NOT NULL DEFAULT 'settled',
    channel VARCHAR(32) NOT NULL DEFAULT 'portal', -- 'portal', 'mobile', 'swift_gpi'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE account_transactions ADD COLUMN IF NOT EXISTS company_uid VARCHAR(64);
ALTER TABLE account_transactions ADD COLUMN IF NOT EXISTS swift_uetr VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_acc_tx_company_uid 
ON account_transactions (company_uid);

CREATE INDEX IF NOT EXISTS idx_acc_tx_cuid_id 
ON account_transactions (company_uid, id);

CREATE INDEX IF NOT EXISTS idx_acc_tx_acc_num 
ON account_transactions (account_number);

-- =======================================================
-- 6. Comprehensive Corporate & Compliance Audit Trail Table
-- Compatible with both Web applications and Mobile application
-- =======================================================
CREATE TABLE IF NOT EXISTS corporate_audit_logs (
    id TEXT PRIMARY KEY,
    company_uid VARCHAR(64),
    action_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    actor_role TEXT,
    target_crn TEXT,
    target_email TEXT,
    target_company TEXT,
    details TEXT,
    status TEXT DEFAULT 'SUCCESS',
    device_info TEXT,
    ip_address TEXT,
    channel TEXT DEFAULT 'web', -- 'web' or 'mobile'
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE corporate_audit_logs ADD COLUMN IF NOT EXISTS company_uid VARCHAR(64);
ALTER TABLE corporate_audit_logs ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'web';

CREATE INDEX IF NOT EXISTS idx_audit_company_uid 
ON corporate_audit_logs (company_uid);

CREATE INDEX IF NOT EXISTS idx_audit_cuid_id 
ON corporate_audit_logs (company_uid, id);

CREATE INDEX IF NOT EXISTS idx_audit_created_at 
ON corporate_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_action_type 
ON corporate_audit_logs (action_type);

CREATE INDEX IF NOT EXISTS idx_audit_target_crn 
ON corporate_audit_logs (target_crn);

-- Backward compatibility for mobile_audit_logs (if mobile client queries mobile_audit_logs)
CREATE TABLE IF NOT EXISTS public.mobile_audit_logs (
    id TEXT PRIMARY KEY,
    company_uid VARCHAR(64),
    action_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    actor_role TEXT,
    target_crn TEXT,
    target_email TEXT,
    target_company TEXT,
    details TEXT,
    status TEXT DEFAULT 'SUCCESS',
    device_info TEXT,
    ip_address TEXT,
    channel TEXT DEFAULT 'mobile',
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.mobile_audit_logs ADD COLUMN IF NOT EXISTS company_uid VARCHAR(64);
ALTER TABLE public.mobile_audit_logs ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'mobile';

CREATE INDEX IF NOT EXISTS idx_mobile_audit_company_uid 
ON public.mobile_audit_logs (company_uid);

-- =======================================================
-- 7. Relationship Manager Executives & Staff Table
-- =======================================================
-- Passwords are maintained in plain text for seamless demonstration & verification.
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

-- =======================================================
-- 8. Automated Backfill for company_uid on Existing Data
-- Standard deterministic format: 'CUID-' + clean uppercase CRN
-- =======================================================
DO $$
BEGIN
    -- Backfill corporate_onboarding_applications
    UPDATE corporate_onboarding_applications
    SET company_uid = 'CUID-' || UPPER(REGEXP_REPLACE(crn, '[^a-zA-Z0-9]', '', 'g'))
    WHERE company_uid IS NULL OR company_uid = '';

    -- Backfill rm_customer_invitations
    UPDATE rm_customer_invitations
    SET company_uid = 'CUID-' || UPPER(REGEXP_REPLACE(crn, '[^a-zA-Z0-9]', '', 'g'))
    WHERE company_uid IS NULL OR company_uid = '';

    -- Backfill application_documents from applications
    UPDATE application_documents d
    SET company_uid = a.company_uid
    FROM corporate_onboarding_applications a
    WHERE d.application_ref = a.application_ref
      AND (d.company_uid IS NULL OR d.company_uid = '');

    -- Backfill corporate_accounts
    UPDATE corporate_accounts acc
    SET company_uid = a.company_uid
    FROM corporate_onboarding_applications a
    WHERE acc.application_ref = a.application_ref
      AND (acc.company_uid IS NULL OR acc.company_uid = '');

    -- Backfill account_transactions
    UPDATE account_transactions tx
    SET company_uid = acc.company_uid
    FROM corporate_accounts acc
    WHERE tx.account_id = acc.id
      AND (tx.company_uid IS NULL OR tx.company_uid = '');

    -- Backfill corporate_audit_logs & mobile_audit_logs
    UPDATE corporate_audit_logs
    SET company_uid = 'CUID-' || UPPER(REGEXP_REPLACE(target_crn, '[^a-zA-Z0-9]', '', 'g'))
    WHERE (company_uid IS NULL OR company_uid = '') AND target_crn IS NOT NULL;

    UPDATE mobile_audit_logs
    SET company_uid = 'CUID-' || UPPER(REGEXP_REPLACE(target_crn, '[^a-zA-Z0-9]', '', 'g'))
    WHERE (company_uid IS NULL OR company_uid = '') AND target_crn IS NOT NULL;

    -- =======================================================
    -- 9. Enforce NOT NULL and UNIQUE Primary Constraints
    -- =======================================================
    -- Enforce on corporate_onboarding_applications
    BEGIN
        ALTER TABLE corporate_onboarding_applications ALTER COLUMN company_uid SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
        ALTER TABLE corporate_onboarding_applications ADD CONSTRAINT uq_corp_apps_company_uid UNIQUE (company_uid);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- Enforce on rm_customer_invitations
    BEGIN
        ALTER TABLE rm_customer_invitations ALTER COLUMN company_uid SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
        ALTER TABLE rm_customer_invitations ADD CONSTRAINT uq_rm_inv_company_uid UNIQUE (company_uid);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- Enforce NOT NULL on child tables
    BEGIN
        ALTER TABLE application_documents ALTER COLUMN company_uid SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
        ALTER TABLE corporate_accounts ALTER COLUMN company_uid SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
        ALTER TABLE account_transactions ALTER COLUMN company_uid SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
        ALTER TABLE corporate_audit_logs ALTER COLUMN company_uid SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
END $$;

-- Automatic updated_at trigger function
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS trg_corp_apps_updated_at ON corporate_onboarding_applications;
CREATE TRIGGER trg_corp_apps_updated_at
BEFORE UPDATE ON corporate_onboarding_applications
FOR EACH ROW
EXECUTE FUNCTION update_modified_column();

DROP TRIGGER IF EXISTS trg_app_docs_updated_at ON application_documents;
CREATE TRIGGER trg_app_docs_updated_at
BEFORE UPDATE ON application_documents
FOR EACH ROW
EXECUTE FUNCTION update_modified_column();

-- =======================================================
-- 10. Enterprise 7-Stage Domain Tables (Keyed on company_uid)
-- Ordered 1-to-7 Matching Onboarding UI Stepper Flow:
--   1. step1_documents        (Documents)
--   2. step2_company_info     (Company Info)
--   3. step3_ubo_details      (UBO Details)
--   4. step4_ownership        (Ownership)
--   5. step5_roles            (Roles)
--   6. step6_fatca_crs        (FATCA / CRS)
--   7. step7_review_submit    (Review & Submit)
-- =======================================================

-- Step 1: Documents (Document Vault & OCR Verification)
CREATE TABLE IF NOT EXISTS step1_documents (
    id BIGSERIAL PRIMARY KEY,
    company_uid VARCHAR(64) NOT NULL,
    application_ref VARCHAR(64) NOT NULL,
    document_type VARCHAR(64) NOT NULL,
    file_name TEXT NOT NULL,
    file_type VARCHAR(64) DEFAULT 'application/pdf',
    file_size BIGINT DEFAULT 0,
    file_data_base64 TEXT,
    ocr_status VARCHAR(32) DEFAULT 'verified',
    verification_status VARCHAR(32) DEFAULT 'approved',
    extracted_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step1_company_uid ON step1_documents (company_uid);
CREATE INDEX IF NOT EXISTS idx_step1_app_ref ON step1_documents (application_ref);

-- Step 2: Company Info (Corporate Profile & Licences)
CREATE TABLE IF NOT EXISTS step2_company_info (
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step2_app_ref ON step2_company_info (application_ref);
CREATE INDEX IF NOT EXISTS idx_step2_crn ON step2_company_info (crn);

-- Step 3: UBO Details (Beneficial Owners & Signatories)
CREATE TABLE IF NOT EXISTS step3_ubo_details (
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step3_company_uid ON step3_ubo_details (company_uid);
CREATE INDEX IF NOT EXISTS idx_step3_app_ref ON step3_ubo_details (application_ref);

-- Step 4: Ownership (Holding Hierarchy & Entities)
CREATE TABLE IF NOT EXISTS step4_ownership (
    company_uid VARCHAR(64) PRIMARY KEY,
    application_ref VARCHAR(64) NOT NULL,
    has_holding_company BOOLEAN DEFAULT FALSE,
    parent_company_name TEXT,
    parent_company_country VARCHAR(64),
    total_shares_percentage NUMERIC(5, 2) DEFAULT 100.00,
    ownership_hierarchy JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step4_app_ref ON step4_ownership (application_ref);

-- Step 5: Roles (Signing Powers & Governance Limits)
CREATE TABLE IF NOT EXISTS step5_roles (
    company_uid VARCHAR(64) PRIMARY KEY,
    application_ref VARCHAR(64) NOT NULL,
    signing_power VARCHAR(64) NOT NULL DEFAULT 'sole',
    dual_authorization_threshold NUMERIC(18, 2) DEFAULT 50000.00,
    maker_checker_enabled BOOLEAN DEFAULT TRUE,
    primary_maker_email VARCHAR(255),
    primary_checker_email VARCHAR(255),
    daily_transfer_limit NUMERIC(18, 2) DEFAULT 250000.00,
    single_transaction_limit NUMERIC(18, 2) DEFAULT 100000.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step5_app_ref ON step5_roles (application_ref);

-- Step 6: FATCA / CRS (Tax Residency & Source of Wealth)
CREATE TABLE IF NOT EXISTS step6_fatca_crs (
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step6_app_ref ON step6_fatca_crs (application_ref);

-- Step 7: Review & Submit (E-Signatures & Warranties)
CREATE TABLE IF NOT EXISTS step7_review_submit (
    company_uid VARCHAR(64) PRIMARY KEY,
    application_ref VARCHAR(64) NOT NULL,
    agreed_terms BOOLEAN NOT NULL DEFAULT TRUE,
    agreed_accuracy_warranties BOOLEAN NOT NULL DEFAULT TRUE,
    agreed_data_privacy BOOLEAN NOT NULL DEFAULT TRUE,
    signatory_name TEXT NOT NULL,
    signatory_email VARCHAR(255) NOT NULL,
    docusign_envelope_id VARCHAR(128),
    signature_hash TEXT,
    ip_address VARCHAR(64),
    user_agent TEXT,
    signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step7_app_ref ON step7_review_submit (application_ref);

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
-- =======================================================
-- Row Level Security policies for the backend API (anon key path)
-- The Node backend writes CIFs, accounts, transactions and the
-- authorization queue directly. If you set SUPABASE_SERVICE_KEY in
-- Railway, this file is optional (service role bypasses RLS).
-- Idempotent — safe to re-run.
-- =======================================================

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'corporate_accounts',
        'account_transactions',
        'corporate_onboarding_applications',
        'rm_customer_invitations',
        'customer_information_files',
        'customer_bic_registry',
        'core_authorization_requests'
    ] LOOP
        EXECUTE FORMAT('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

        EXECUTE FORMAT('DROP POLICY IF EXISTS %I ON public.%I', 'api_full_access_' || t, t);
        EXECUTE FORMAT(
            'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)',
            'api_full_access_' || t, t
        );
    END LOOP;
END $$;
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
