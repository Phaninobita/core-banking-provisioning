# Core Banking Provisioning — CIF, Accounts & Dedicated BIC

When a corporate onboarding application is **approved**, the platform now
automatically provisions the customer into core banking:

1. **CIF (Customer Information File)** — master customer record
   (`customer_information_files`, one per `company_uid`)
2. **Core corporate account(s)** — opened in `corporate_accounts`, linked to
   the CIF and the customer's dedicated BIC
3. **Dedicated SWIFT BIC** — one unique BIC per customer
   (`customer_bic_registry`, e.g. `FNBKAE2XK7Q`), stamped on the CIF and on
   every core account so the customer portal can transact

## One-time database migration

The three new objects must be created in your Supabase project. Either:

```bash
# Option A: run the migration runner (needs DATABASE_URL in web/.env)
cd web
node db/migrate.js        # schema.sql already includes 03_core_provisioning.sql
```

or **Option B**: paste `web/db/03_core_provisioning.sql` into the Supabase
Dashboard → SQL Editor → Run.

## API Endpoints (mounted at `/api/v1/provisioning`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/provision` | RM/Admin JWT | Provision an onboarded application. Body: `{ application_ref }` or `{ company_uid }` or `{ crn }`; optional `openingBalance`, `currencies: ["AED","USD"]`. Idempotent. |
| GET | `/profile/:company_uid` | JWT (tenant-isolated) | Full core profile: CIF + dedicated BIC + accounts |
| GET | `/cif/:company_uid` | JWT | CIF record only |
| GET | `/bic/:company_uid` | JWT | Dedicated BIC record only |
| POST | `/bic/assign` | RM/Admin JWT | (Re)assign a dedicated BIC and stamp it on CIF + all accounts |

### Example

```bash
curl -X POST https://<your-host>/api/v1/provisioning/provision \
  -H "Authorization: Bearer <rm-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"application_ref": "AB-2026-0001", "openingBalance": 500000, "currencies": ["AED"]}'
```

## Auto-provisioning hook

`application-service` calls the provisioning routine automatically whenever an
application's status is saved as `approved` (see the `CORE_PROVISIONING`
handler in `web/services/application-service/index.js`). If it fails, RM can
still provision manually via `POST /api/v1/provisioning/provision`.
