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
