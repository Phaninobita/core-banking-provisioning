/**
 * First National Bank Microservice: Core Banking Provisioning Service
 * Converts approved (onboarded) corporate applications into fully provisioned
 * core banking customers:
 *   1. Creates the Customer Information File (CIF) master record
 *   2. Opens core corporate account(s) in Supabase
 *   3. Assigns one dedicated SWIFT BIC to the customer
 *   4. Links account(s) to the CIF & BIC so the customer portal can transact
 *
 * All records are persisted in Supabase (customer_information_files,
 * customer_bic_registry, corporate_accounts) with in-memory mirroring for
 * resilience.
 */

const express = require("express");
const config = require("../../shared/config");
const memStore = require("../../shared/memStore");
const db = require("../../shared/db");
const supabaseClient = require("../../shared/supabaseClient");
const { requireAuth } = require("../auth-service");
const { logAuditEvent } = require("../../shared/audit");

const router = express.Router();

/**
 * Core provisioning routine. Idempotent — safe to call repeatedly for the
 * same company. Accepts an application row (from Supabase) or a plain object.
 */
async function provisionCorporateCustomer(application, options = {}) {
  const company_uid = (application.company_uid || `CUID-${String(application.crn || "").replace(/[^A-Z0-9]/gi, "")}`).toUpperCase();
  const company_name = application.company_name || "Corporate Customer";
  const openingBalance = options.openingBalance != null ? Number(options.openingBalance) : 1000000.00;
  const currencies = options.currencies || ["AED"];

  // ── Step 1: Customer Information File (CIF) ──
  let cif = await supabaseClient.getCif(company_uid);
  if (!cif) {
    const bicPreview = supabaseClient.generateDedicatedBic(company_uid);
    cif = await supabaseClient.saveCif({
      company_uid,
      application_ref: application.application_ref || null,
      crn: application.crn || null,
      company_name,
      trade_name: application.trade_name || null,
      legal_type: application.legal_type || null,
      registered_email: application.registered_email || null,
      contact_person: application.contact_person || null,
      phone: application.phone || null,
      address: application.address || null,
      dedicated_bic: bicPreview,
      profile_data: {
        source: "core_provisioning",
        application_status: application.status || "approved",
        onboarded_at: new Date().toISOString()
      }
    });
  }

  // ── Step 2: Dedicated BIC assignment ──
  let bicRecord = await supabaseClient.getDedicatedBic(company_uid);
  if (!bicRecord) {
    bicRecord = await supabaseClient.assignDedicatedBic({
      company_uid,
      cif_number: cif.cif_number,
      company_name
    });
  }
  const dedicatedBic = (bicRecord && bicRecord.bic) || (cif && cif.dedicated_bic) || null;

  // Keep the CIF row in sync with the assigned BIC
  if (cif && dedicatedBic && cif.dedicated_bic !== dedicatedBic) {
    cif = await supabaseClient.saveCif({ ...cif, dedicated_bic: dedicatedBic });
  }

  // ── Step 3: Core corporate account(s) ──
  const accounts = [];
  for (const currency of currencies) {
    const suffix = currencies.length > 1 ? ` (${currency})` : "";
    let account = null;

    // Reuse an existing account in this currency if already provisioned
    const existingAccounts = await supabaseClient.getAccounts(company_uid);
    account = existingAccounts.find(a => a.currency === currency);
    if (!account) {
      account = await supabaseClient.createCorporateAccount({
        company_uid,
        cif_number: cif.cif_number,
        bic: dedicatedBic,
        currency,
        // STP: the account is opened under the EXACT name captured during
        // onboarding — same company name, same CRN, no re-keying.
        account_name: options.accountName || `${company_name}${suffix}`,
        account_type: "Corporate Checking",
        balance: openingBalance,
        available_balance: openingBalance,
        application_ref: application.application_ref || null
      });
    }
    accounts.push(account);

    // Mirror into in-memory store so the customer portal works instantly
    if (account && account.account_number) {
      memStore.accounts.set(account.account_number, account);
    }
  }

  // ── Step 4: Core activation handoff (STP) ──
  // Copy the entire verified onboarding record — master application, company
  // info, UBOs, ownership, mandates, tax, declarations and documents — into
  // the `*_core` mirror tables. This is the real-time banking technique: the
  // core runs on the same data the customer entered, never re-typed.
  let activation = { ok: false };
  try {
    activation = await supabaseClient.activateCoreHandoff(application);
    // Stamp the activation result on the master _core record
    if (activation.ok && accounts[0]) {
      await supabaseClient.request(
        `corporate_onboarding_applications_core?company_uid=eq.${encodeURIComponent(company_uid)}`,
        {
          method: "PATCH",
          headers: { "Prefer": "return=minimal" },
          body: {
            cif_number: cif.cif_number,
            dedicated_bic: dedicatedBic,
            account_number: accounts[0].account_number,
            updated_at: new Date().toISOString()
          }
        }
      ).catch(() => {});
    }
  } catch (e) {
    console.warn("[PROVISIONING SERVICE] Core activation handoff notice:", e.message);
  }

  return {
    company_uid,
    cif,
    dedicated_bic: dedicatedBic,
    bic_record: bicRecord,
    accounts,
    core_activation: activation
  };
}

// ── 1. Provision an onboarded application into the core (RM / admin or service call) ──
router.post("/provision", requireAuth, async (req, res) => {
  memStore.metrics.serviceRequests.banking++;
  const { application_ref, company_uid, crn, openingBalance, currencies } = req.body || {};

  // Only RM executives / admins may provision core accounts
  const isRm = Boolean(req.user.is_rm || req.user.role === "RM" || req.user.role === "ADMIN");
  if (!isRm) {
    return res.status(403).json({ error: "Forbidden: only RM executives can provision core banking customers." });
  }

  try {
    // Resolve the source application (priority: application_ref > company_uid > crn)
    let application = null;
    if (application_ref) {
      application = await supabaseClient.getApplication(application_ref);
    } else if (company_uid) {
      application = await supabaseClient.getApplicationByUid(company_uid);
    } else if (crn) {
      application = await supabaseClient.getApplicationByCrn(crn);
    }
    if (!application && company_uid) {
      application = { company_uid, company_name: req.body.company_name || "Corporate Customer" };
    }
    if (!application) {
      return res.status(404).json({ error: "Onboarding application not found. Provide application_ref, company_uid or crn." });
    }

    const result = await provisionCorporateCustomer(application, { openingBalance, currencies });

    // RM approval: mark the application APPROVED so the journey flips to
    // "Account Activated" and the customer portal shows the live accounts.
    if (application.application_ref) {
      await supabaseClient.updateApplication(application.application_ref, { status: "approved" }).catch(e => {
        console.warn("[PROVISIONING SERVICE] Status update notice:", e.message);
      });
      memStore.applications.set(application.application_ref, { ...(memStore.applications.get(application.application_ref) || {}), status: "approved" });
    }

    await logAuditEvent({
      company_uid: result.company_uid,
      crn: application.crn,
      channel: "portal",
      action_type: "CORE_PROVISIONING",
      actor: req.user.email || req.user.name || "RM Executive",
      target: application.company_name || result.company_uid,
      status: "SUCCESS",
      ip_address: req.ip || "127.0.0.1",
      user_agent: req.headers["user-agent"] || "Provisioning-Service",
      metadata: {
        cif_number: result.cif && result.cif.cif_number,
        dedicated_bic: result.dedicated_bic,
        accounts: result.accounts.map(a => a.account_number)
      }
    });

    return res.json({
      success: true,
      message: "Corporate customer fully provisioned in core banking (CIF + accounts + dedicated BIC).",
      provisioned: true,
      ...result,
      service: "provisioning-service"
    });
  } catch (err) {
    console.error("[PROVISIONING SERVICE] Provision error:", err);
    return res.status(500).json({ error: `Provisioning failed: ${err.message}` });
  }
});

// Canonical journey statuses (the only three the business tracks):
//   link_initiated            → invitation sent, customer has not progressed
//   in_progress_under_review  → onboarding steps underway or submitted for review
//   account_activated         → approved and fully provisioned in core banking
function canonicalJourneyStatus(status, coreProvisioned) {
    if (coreProvisioned || status === "approved" || status === "completed" || status === "account_activated") {
        return "account_activated";
    }
    if (status === "invited" || status === "link_initiated") {
        return "link_initiated";
    }
    return "in_progress_under_review"; // draft, in_progress, submitted, review
}

// ── 1b. Onboarded applications queue for the Core Banking Console (RM only) ──
router.get("/applications", requireAuth, async (req, res) => {
  const isRm = Boolean(req.user.is_rm || req.user.role === "RM" || req.user.role === "ADMIN");
  if (!isRm) {
    return res.status(403).json({ error: "Forbidden: only RM executives can view the applications queue." });
  }
  try {
    const applications = await supabaseClient.listApplications();
    // Enrich with core provisioning status (CIF exists?)
    const customers = await supabaseClient.listCifs();
    const provisionedUids = new Set(customers.map(c => (c.company_uid || "").toUpperCase()));
    const enriched = applications.map(a => {
      const coreProvisioned = provisionedUids.has(String(a.company_uid || "").toUpperCase());
      return {
        ...a,
        core_provisioned: coreProvisioned,
        journey_status: canonicalJourneyStatus(a.status, coreProvisioned)
      };
    });
    return res.json({
      success: true,
      count: enriched.length,
      applications: enriched,
      service: "provisioning-service"
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to load applications: ${err.message}` });
  }
});

// ── 1c. All provisioned core customers with CIF, BIC & accounts (RM only) ──
router.get("/customers", requireAuth, async (req, res) => {
  const isRm = Boolean(req.user.is_rm || req.user.role === "RM" || req.user.role === "ADMIN");
  if (!isRm) {
    return res.status(403).json({ error: "Forbidden: only RM executives can view core customers." });
  }
  try {
    const cifs = await supabaseClient.listCifs();
    const customers = await Promise.all(cifs.map(async (cif) => {
      const uid = cif.company_uid;
      const [bicRecord, accounts] = await Promise.all([
        supabaseClient.getDedicatedBic(uid),
        supabaseClient.getAccounts(uid)
      ]);
      return {
        ...cif,
        dedicated_bic: bicRecord ? bicRecord.bic : cif.dedicated_bic,
        accounts
      };
    }));
    return res.json({
      success: true,
      count: customers.length,
      customers,
      service: "provisioning-service"
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to load core customers: ${err.message}` });
  }
});

// ── 2. Get full core banking profile (CIF + BIC + accounts) for a company ──
router.get("/profile/:company_uid", requireAuth, async (req, res) => {
  const company_uid = String(req.params.company_uid || "").trim().toUpperCase();

  // Tenant isolation: non-RM users can only read their own company profile
  const isRm = Boolean(req.user.is_rm || req.user.role === "RM");
  if (!isRm && req.user.company_uid && req.user.company_uid.toUpperCase() !== company_uid) {
    return res.status(403).json({ error: "Forbidden: access to this corporate profile denied." });
  }

  try {
    const [cif, bicRecord, accounts] = await Promise.all([
      supabaseClient.getCif(company_uid),
      supabaseClient.getDedicatedBic(company_uid),
      supabaseClient.getAccounts(company_uid)
    ]);

    return res.json({
      success: true,
      company_uid,
      cif,
      dedicated_bic: bicRecord ? bicRecord.bic : (cif ? cif.dedicated_bic : null),
      bic_record: bicRecord,
      accounts,
      provisioned: Boolean(cif && accounts.length > 0),
      service: "provisioning-service"
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to load profile: ${err.message}` });
  }
});

// ── 3. Get CIF record ──
router.get("/cif/:company_uid", requireAuth, async (req, res) => {
  const cif = await supabaseClient.getCif(req.params.company_uid);
  if (!cif) return res.status(404).json({ error: "CIF record not found for this company." });
  return res.json({ success: true, cif, service: "provisioning-service" });
});

// ── 4. Get / reassign the dedicated BIC ──
router.get("/bic/:company_uid", requireAuth, async (req, res) => {
  const bicRecord = await supabaseClient.getDedicatedBic(req.params.company_uid);
  if (!bicRecord) return res.status(404).json({ error: "No dedicated BIC assigned to this company." });
  return res.json({ success: true, bic: bicRecord, service: "provisioning-service" });
});

router.post("/bic/assign", requireAuth, async (req, res) => {
  const isRm = Boolean(req.user.is_rm || req.user.role === "RM" || req.user.role === "ADMIN");
  if (!isRm) {
    return res.status(403).json({ error: "Forbidden: only RM executives can assign BICs." });
  }
  const { company_uid, company_name, cif_number } = req.body || {};
  if (!company_uid) return res.status(400).json({ error: "company_uid is required." });

  try {
    const record = await supabaseClient.assignDedicatedBic({ company_uid, company_name, cif_number });

    // Propagate the BIC onto CIF and all core accounts
    const cif = await supabaseClient.getCif(company_uid);
    if (cif) await supabaseClient.saveCif({ ...cif, dedicated_bic: record.bic });
    const accounts = await supabaseClient.getAccounts(company_uid);
    for (const acc of accounts) {
      await supabaseClient.request(`corporate_accounts?account_number=eq.${encodeURIComponent(acc.account_number)}`, {
        method: "PATCH",
        headers: { "Prefer": "return=representation" },
        body: { bic: record.bic, updated_at: new Date().toISOString() }
      });
    }

    return res.json({ success: true, bic: record, accounts_updated: accounts.length, service: "provisioning-service" });
  } catch (err) {
    return res.status(500).json({ error: `BIC assignment failed: ${err.message}` });
  }
});

// ── 5. Health ──
router.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "provisioning-service",
    database: db.engineType,
    port: config.MICROSERVICES.PROVISIONING ? config.MICROSERVICES.PROVISIONING.port : 3006,
    uptime: process.uptime()
  });
});

module.exports = { router, provisionCorporateCustomer };
