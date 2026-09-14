/**
 * First National Bank Microservice: Corporate Onboarding Service (Port 3003)
 * Manages the 7-step corporate onboarding lifecycle, auto-save state machine,
 * validation, and compliance verification submission.
 */

const express = require("express");
const crypto = require("crypto");
const config = require("../../shared/config");
const memStore = require("../../shared/memStore");
const db = require("../../shared/db");
const supabaseClient = require("../../shared/supabaseClient");
const { requireAuth } = require("../auth-service");
const { logAuditEvent, resolveCompanyUid, getAuditTrail } = require("../../shared/audit");

const router = express.Router();

// ════════════════════════════════════════════════════════════════
// STRICT SUBMISSION COMPLETENESS VALIDATION (server-side mirror
// of the client gate). The application cannot reach 'submitted'
// unless every stage is complete and all declarations are ticked.
// ════════════════════════════════════════════════════════════════
function validateApplicationCompleteness(fd) {
  const errors = [];
  const req = (cond, step, field, message) => { if (!cond) errors.push({ step, field, message }); };
  const filled = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const isPlaceholder = (v, p) => !filled(v) || String(v).trim().toUpperCase().startsWith(p);

  // Stage 1: Documents — the 3 recommended KYC documents must be uploaded
  const docs = fd.documents || fd.step1_documents || [];
  docs.slice(0, 3).forEach((d, i) => {
    const docName = d.title || d.label || "Document " + (i + 1);
    req(d.is_uploaded || d.uploaded, 1, d.id || "doc_" + (i + 1), 'Document "' + docName + '" is not uploaded');
  });

  // Stage 2: Company details
  const s2 = fd.step2 || {};
  req(filled(s2.crn), 2, "crn", "Company Registration Number (CRN) is required");
  req(filled(s2.company_name || s2.companyName), 2, "company_name", "Registered Company Name is required");
  req(filled(s2.legal_type || s2.legalType), 2, "legal_type", "Legal Type is required");
  req(filled(s2.issue_date || s2.issueDate), 2, "issue_date", "Licence Issue Date is required");
  req(filled(s2.expiry_date || s2.expiryDate), 2, "expiry_date", "Licence Expiry Date is required");
  req(filled(s2.issued_by || s2.issuedBy), 2, "issued_by", "Licence Issuing Authority is required");
  req(filled(s2.contact_person || s2.contactPerson), 2, "contact_person", "Contact Person is required");
  req(filled(s2.email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s2.email), 2, "email", "A valid Registered Email is required");
  req(filled(s2.phone), 2, "phone", "Phone Number is required");
  req(filled(s2.address), 2, "address", "Registered Address is required");
  req(filled(s2.vat_trn || s2.vatTrn), 2, "vat_trn", "VAT / TRN is required");

  // Stage 3: UBO details
  const ubos = fd.ubos || [];
  req(ubos.length > 0, 3, "ubos", "At least one Ultimate Beneficial Owner must be added");
  ubos.forEach((u, i) => {
    const n = i + 1;
    req(filled(u.fullName || u.name) && !isPlaceholder(u.fullName || u.name, "UBO "), 3, "ubo_" + n + "_name", "UBO " + n + ": full name is required");
    req(filled(u.nationality), 3, "ubo_" + n + "_nationality", "UBO " + n + ": nationality is required");
    req(filled(u.idPassportNumber || u.passportNumber) && !isPlaceholder(u.idPassportNumber || u.passportNumber, "PASS-"), 3, "ubo_" + n + "_passport", "UBO " + n + ": passport / ID number is required");
    req(filled(u.dob) && u.dob !== "1985-06-15", 3, "ubo_" + n + "_dob", "UBO " + n + ": date of birth is required");
    req(Number(u.shareholdingPct || u.percentage) > 0, 3, "ubo_" + n + "_share", "UBO " + n + ": shareholding percentage is required");
  });

  // Stage 4: Ownership — rows must total 100%
  const own = fd.ownership_structure || fd.ownership || [];
  req(own.length > 0, 4, "ownership", "Ownership structure must have at least one shareholder row");
  const totalPct = own.reduce((t, r) => t + (Number(r.percentage) || 0), 0);
  req(own.length === 0 || Math.round(totalPct) === 100, 4, "ownership_total", "Total shareholding must equal exactly 100% (currently " + totalPct + "%)");

  // Stage 5: Roles
  const roles = fd.roles || {};
  req(filled(roles.maker), 5, "maker", "Primary Maker (initiator) must be assigned");
  req(filled(roles.checker), 5, "checker", "Primary Checker (authorizer) must be assigned");
  req(!filled(roles.maker) || !filled(roles.checker) || roles.maker !== roles.checker, 5, "roles_distinct", "Maker and Checker must be different people");

  // Stage 6: FATCA / CRS
  const tax = fd.tax || fd.tax_compliance || {};
  req(filled(tax.entity_classification || tax.entityClassification || tax.fatca_class), 6, "fatca_class", "FATCA entity classification is required");
  req(tax.crs_confirmed === true || tax.crsConfirmed === true || tax.crs_fi !== undefined, 6, "crs", "CRS confirmation is required");
  req(!(tax.is_us_person || tax.us_person || tax.isUsPerson) || filled(tax.us_tin || tax.usTin), 6, "us_tin", "US TIN is required for US persons");

  // Stage 7: Declarations — all ticked
  const dec = fd.declarations || {};
  req(dec.d1 === true, 7, "d1", "Declaration 1 (accuracy of information) must be ticked");
  req(dec.d2 === true, 7, "d2", "Declaration 2 (terms & conditions) must be ticked");
  req(dec.d3 === true, 7, "d3", "Declaration 3 (data privacy consent) must be ticked");

  return { ok: errors.length === 0, errors };
}

// 1. Get Current User Application
router.get("/current", requireAuth, async (req, res) => {
  memStore.metrics.serviceRequests.applications++;
  const { application_ref } = req.user;

  try {
    let applicationRecord = null;
    await db.ready();
    if (db.isConnected()) {
      applicationRecord = await db.getApplication(application_ref);
    }
    if (!applicationRecord) {
      applicationRecord = memStore.applications.get(application_ref) || null;
    }

    if (!applicationRecord) {
      return res.status(404).json({ error: "Application profile not found." });
    }

    // Ensure company_uid is assigned
    applicationRecord.company_uid = resolveCompanyUid(applicationRecord.company_uid || req.user.company_uid, applicationRecord.crn);

    // Ensure company_name, contact_person, and phone reflect the RM invitation record if available
    const rmInv = memStore.getRmInvitation(applicationRecord.crn, applicationRecord.registered_email);
    if (rmInv) {
      if (rmInv.company_uid && !applicationRecord.company_uid) {
        applicationRecord.company_uid = rmInv.company_uid;
      }
      if (rmInv.company_name && (!applicationRecord.company_name || applicationRecord.company_name === "Apex Global Holdings Ltd")) {
        applicationRecord.company_name = rmInv.company_name;
        applicationRecord.trade_name = rmInv.company_name;
      }
      if (rmInv.contact_person && !applicationRecord.contact_person) {
        applicationRecord.contact_person = rmInv.contact_person;
      }
      if (rmInv.phone && !applicationRecord.phone) {
        applicationRecord.phone = rmInv.phone;
      }
      if (applicationRecord.form_data && applicationRecord.form_data.step2) {
        applicationRecord.form_data.step2.company_uid = applicationRecord.company_uid;
        if (!applicationRecord.form_data.step2.contact_person && rmInv.contact_person) {
          applicationRecord.form_data.step2.contact_person = rmInv.contact_person;
        }
        if (!applicationRecord.form_data.step2.phone && rmInv.phone) {
          applicationRecord.form_data.step2.phone = rmInv.phone;
        }
      }
    } else if (applicationRecord.form_data && applicationRecord.form_data.step2) {
      applicationRecord.form_data.step2.company_uid = applicationRecord.company_uid;
    }

    // Augment with normalized 7-step domain data
    const cuid = applicationRecord.company_uid;
    const s1Docs = memStore.getStep1Documents(cuid);
    applicationRecord.stages = {
      // 7 Steps matching UI flow order
      step1_documents: s1Docs.length > 0 ? s1Docs : (memStore.documents ? Array.from(memStore.documents.values()).filter(d => d.company_uid === cuid || d.application_ref === application_ref) : []),
      step2_company_info: memStore.getStep2CompanyInfo(cuid),
      step3_ubo_details: memStore.getStep3UboDetails(cuid),
      step4_ownership: memStore.getStep4Ownership(cuid),
      step5_roles: memStore.getStep5Roles(cuid),
      step6_fatca_crs: memStore.getStep6FatcaCrs(cuid),
      step7_review_submit: memStore.getStep7ReviewSubmit(cuid),

      // Aliases for backward compatibility
      stage1_documents: s1Docs.length > 0 ? s1Docs : (memStore.documents ? Array.from(memStore.documents.values()).filter(d => d.company_uid === cuid || d.application_ref === application_ref) : []),
      stage2_profile: memStore.getStep2CompanyInfo(cuid),
      stage3_ubos: memStore.getStep3UboDetails(cuid),
      stage4_ownership: memStore.getStep4Ownership(cuid),
      stage5_mandates: memStore.getStep5Roles(cuid),
      stage6_tax_compliance: memStore.getStep6FatcaCrs(cuid),
      stage7_declarations: memStore.getStep7ReviewSubmit(cuid)
    };

    return res.json({
      success: true,
      company_uid: applicationRecord.company_uid,
      data: applicationRecord,
      service: "application-service"
    });
  } catch (err) {
    console.error("[APPLICATION SERVICE] Fetch error:", err);
    return res.status(500).json({ error: "Failed to load application data." });
  }
});

// 2. Save Application Progress (IDOR Protected via JWT application_ref)
router.post("/save", requireAuth, async (req, res) => {
  memStore.metrics.serviceRequests.applications++;
  const application_ref = req.user.application_ref;
  const { current_step, status, form_data } = req.body;

  try {
    let existingRecord = null;
    await db.ready();
    if (db.isConnected()) {
      existingRecord = await db.getApplication(application_ref);
    }
    if (!existingRecord) {
      existingRecord = memStore.applications.get(application_ref);
    }
    if (!existingRecord) {
      return res.status(404).json({ error: "Application record not found." });
    }

    let resolvedStatus = existingRecord.status;
    if (status && typeof status === "string" && status.trim() !== "") {
      resolvedStatus = status.trim();
    }

    const resolvedStep = typeof current_step === "number" ? current_step : existingRecord.current_step;

    const resolvedCompanyUid = req.body.company_uid || resolveCompanyUid(existingRecord.company_uid || req.user.company_uid, existingRecord.crn);
    const existingFormData = existingRecord.form_data || {};
    const incomingFormData = form_data || {};
    const mergedFormData = {
      ...existingFormData,
      ...incomingFormData
    };
    if (mergedFormData.step2) {
      mergedFormData.step2.company_uid = resolvedCompanyUid;
    }

    // ── SERVER-SIDE SUBMISSION GATE ──
    // A submission (status=submitted) is only accepted when every required
    // field across all 7 stages is present and every declaration checkbox is
    // ticked. Incomplete applications are rejected with the missing list and
    // their status remains in-progress — saved data is never discarded.
    if (resolvedStatus === "submitted") {
      const completeness = validateApplicationCompleteness(mergedFormData);
      if (!completeness.ok) {
        return res.status(400).json({
          error: "Application incomplete — every required field in all 7 stages must be filled and all declarations ticked before submission.",
          code: "APPLICATION_INCOMPLETE",
          missing: completeness.errors
        });
      }
    }

    let updatedRecord = null;
    const s2 = mergedFormData.step2 || {};
    const payload = {
      application_ref,
      company_uid: resolvedCompanyUid,
      crn: existingRecord.crn,
      registered_email: existingRecord.registered_email,
      current_step: resolvedStep,
      status: resolvedStatus,
      form_data: mergedFormData,
      company_name: s2.company_name || s2.companyName || existingRecord.company_name || null,
      trade_name: s2.trade_name || s2.tradeName || existingRecord.trade_name || null,
      legal_type: s2.legal_type || s2.legalType || existingRecord.legal_type || null,
      licence_issue_date: s2.issue_date || s2.issueDate || existingRecord.licence_issue_date || null,
      licence_expiry_date: s2.expiry_date || s2.expiryDate || existingRecord.licence_expiry_date || null,
      licence_issued_by: s2.issued_by || s2.issuedBy || existingRecord.licence_issued_by || null,
      vat_trn: s2.vat_trn || s2.vatTrn || existingRecord.vat_trn || null,
      contact_person: s2.contact_person || s2.contactPerson || existingRecord.contact_person || null,
      phone: s2.phone || existingRecord.phone || null,
      address: s2.address || existingRecord.address || null
    };

    if (db.isConnected()) {
      try {
        updatedRecord = await db.saveApplication(payload);
      } catch (saveErr) {
        console.warn("[APPLICATION SERVICE] Cloud save warning:", saveErr.message);
      }
    }

    if (!updatedRecord) {
      updatedRecord = { ...existingRecord, ...payload, updated_at: new Date().toISOString() };
    }

    // Always mirror to in-memory store
    memStore.applications.set(application_ref, updatedRecord);
    memStore.companyUidIndex.set(resolvedCompanyUid, application_ref);

    const targetCrn = existingRecord.crn || updatedRecord.crn;
    const targetEmail = existingRecord.registered_email || req.user?.email || updatedRecord.registered_email;

    if (targetCrn && targetEmail) {
      const crnKey = `${targetCrn.trim().toUpperCase()}:${targetEmail.trim().toLowerCase()}`;
      memStore.crnEmailIndex.set(crnKey, application_ref);

      // Immediately sync in-memory invitation status & current_step
      const memInv = memStore.rmInvitations.get(crnKey);
      if (memInv) {
        memInv.current_step = resolvedStep;
        memInv.application_ref = application_ref;
        if (resolvedStatus === "submitted" || resolvedStatus === "approved") {
          memInv.status = resolvedStatus === "approved" ? "completed" : "review";
        } else if (resolvedStep > 1) {
          memInv.status = "in_progress";
        }
      }
    }

    // Sync real-time step and status to rm_customer_invitations in DB
    if (db.isConnected() && targetCrn && targetEmail) {
      try {
        const cleanCrn = encodeURIComponent(targetCrn.trim().toUpperCase());
        const cleanEmail = encodeURIComponent(targetEmail.trim().toLowerCase());
        const invStatus = resolvedStatus === 'submitted' || resolvedStatus === 'approved'
          ? (resolvedStatus === 'approved' ? 'completed' : 'review')
          : (resolvedStep > 1 ? 'in_progress' : 'invited');

        await supabaseClient.request(`rm_customer_invitations?crn=eq.${cleanCrn}&email=eq.${cleanEmail}`, {
          method: "PATCH",
          headers: { "Prefer": "return=minimal" },
          body: {
            current_step: resolvedStep,
            status: invStatus,
            application_ref,
            updated_at: new Date().toISOString()
          }
        });
      } catch (patchErr) {
        console.warn("[APPLICATION SERVICE] Invitation step sync notice:", patchErr.message);
      }
    }

    if (!updatedRecord.company_uid) {
      updatedRecord.company_uid = resolvedCompanyUid;
    }

    // ── Live Request Context & Identifiers ──
    const targetComp = updatedRecord.company_name || existingRecord.company_name;
    const targetContact = updatedRecord.contact_person || existingRecord.contact_person || "Authorized Signatory";
    const userAgent = req.headers["user-agent"] || "Web Browser";
    const clientIp = req.ip || req.connection?.remoteAddress || "127.0.0.1";

    // ── 7-Step Corporate Onboarding Data Synchronization (Anchored on company_uid) ──
    const cuid = resolvedCompanyUid;

    // Step 2: Company Info
    if (mergedFormData.step2) {
      const s2 = mergedFormData.step2;
      const profileData = {
        company_uid: cuid,
        application_ref,
        crn: s2.crn || existingRecord.crn,
        company_name: s2.company_name || s2.companyName || existingRecord.company_name,
        trade_name: s2.trade_name || s2.tradeName || existingRecord.trade_name,
        legal_type: s2.legal_type || s2.legalType || existingRecord.legal_type,
        licence_issued_by: s2.issued_by || s2.issuedBy || existingRecord.licence_issued_by,
        licence_issue_date: s2.issue_date || s2.issueDate || existingRecord.licence_issue_date,
        licence_expiry_date: s2.expiry_date || s2.expiryDate || existingRecord.licence_expiry_date,
        vat_trn: s2.vat_trn || s2.vatTrn || existingRecord.vat_trn,
        contact_person: s2.contact_person || s2.contactPerson || existingRecord.contact_person,
        registered_email: s2.email || existingRecord.registered_email,
        phone: s2.phone || existingRecord.phone,
        registered_address: s2.registered_address || s2.address || existingRecord.address,
        operating_address: s2.operating_address || s2.registered_address || s2.address || existingRecord.address
      };
      memStore.saveStep2CompanyInfo(cuid, profileData);
      supabaseClient.saveStep2CompanyInfo(profileData).catch(() => {});
    }

    // Step 3: UBO Details
    if (mergedFormData.step3 && (mergedFormData.step3.ubos || Array.isArray(mergedFormData.step3))) {
      const ubosList = Array.isArray(mergedFormData.step3) ? mergedFormData.step3 : (mergedFormData.step3.ubos || []);
      const mappedUbos = ubosList.map((u, i) => ({
        company_uid: cuid,
        application_ref,
        full_name: u.full_name || u.name || `Beneficial Owner ${i + 1}`,
        nationality: u.nationality || "AE",
        id_type: u.id_type || u.idType || "passport",
        id_number: u.id_number || u.idNumber || "",
        date_of_birth: u.date_of_birth || u.dob || null,
        share_percentage: parseFloat(u.share_percentage || u.percentage || 0),
        is_pep: Boolean(u.is_pep || u.isPep),
        pep_details: u.pep_details || u.pepDetails || "",
        biometric_status: u.biometric_status || "verified",
        residential_address: u.residential_address || u.address || ""
      }));
      memStore.saveStep3UboDetails(cuid, mappedUbos);
      supabaseClient.saveStep3UboDetails(cuid, mappedUbos).catch(() => {});
    }

    // Step 4: Ownership
    if (mergedFormData.step4) {
      const s4 = mergedFormData.step4;
      const ownershipData = {
        company_uid: cuid,
        application_ref,
        has_holding_company: Boolean(s4.has_holding_company || s4.hasHolding),
        parent_company_name: s4.parent_company_name || s4.parentCompany || "",
        parent_company_country: s4.parent_company_country || s4.parentCountry || "",
        total_shares_percentage: parseFloat(s4.total_shares_percentage || 100),
        ownership_hierarchy: s4.hierarchy || s4.shareholders || []
      };
      memStore.saveStep4Ownership(cuid, ownershipData);
      supabaseClient.saveStep4Ownership(ownershipData).catch(() => {});
    }

    // Step 5: Roles
    if (mergedFormData.step5) {
      const s5 = mergedFormData.step5;
      const mandateData = {
        company_uid: cuid,
        application_ref,
        signing_power: s5.signing_power || s5.signingPower || "sole",
        dual_authorization_threshold: parseFloat(s5.dual_authorization_threshold || s5.threshold || 50000),
        maker_checker_enabled: s5.maker_checker_enabled !== false,
        primary_maker_email: s5.maker_email || s5.makerEmail || "",
        primary_checker_email: s5.checker_email || s5.checkerEmail || "",
        daily_transfer_limit: parseFloat(s5.daily_limit || s5.dailyLimit || 250000),
        single_transaction_limit: parseFloat(s5.single_limit || s5.singleLimit || 100000)
      };
      memStore.saveStep5Roles(cuid, mandateData);
      supabaseClient.saveStep5Roles(mandateData).catch(() => {});
    }

    // Step 6: FATCA / CRS
    if (mergedFormData.step6) {
      const s6 = mergedFormData.step6;
      const taxData = {
        company_uid: cuid,
        application_ref,
        is_us_person: Boolean(s6.is_us_person || s6.isUsPerson),
        us_tin: s6.us_tin || s6.usTin || "",
        giin_number: s6.giin || s6.giinNumber || "",
        fatca_classification: s6.fatca_classification || s6.fatcaClassification || "Active NFFE",
        crs_tax_residency_country: s6.tax_residency || s6.crsCountry || "AE",
        foreign_tin: s6.foreign_tin || s6.foreignTin || "",
        source_of_wealth: s6.source_of_wealth || s6.sourceOfWealth || "Commercial Trading Revenue",
        source_of_funds: s6.source_of_funds || s6.sourceOfFunds || "Operating Account Turnover",
        expected_annual_turnover: parseFloat(s6.annual_turnover || s6.expectedTurnover || 5000000)
      };
      memStore.saveStep6FatcaCrs(cuid, taxData);
      supabaseClient.saveStep6FatcaCrs(taxData).catch(() => {});
    }

    // Step 7: Review & Submit
    if (mergedFormData.step7 || resolvedStatus === "submitted") {
      const s7 = mergedFormData.step7 || {};
      const declData = {
        company_uid: cuid,
        application_ref,
        agreed_terms: s7.agreed_terms !== false,
        agreed_accuracy_warranties: s7.agreed_warranties !== false,
        agreed_data_privacy: s7.agreed_privacy !== false,
        signatory_name: s7.signatory_name || targetContact,
        signatory_email: s7.signatory_email || targetEmail,
        docusign_envelope_id: s7.docusign_envelope_id || `ENV-${Date.now()}`,
        signature_hash: s7.signature_hash || crypto.createHash("sha256").update(`${cuid}:${Date.now()}`).digest("hex"),
        ip_address: clientIp,
        user_agent: userAgent,
        signed_at: new Date().toISOString()
      };
      memStore.saveStep7ReviewSubmit(cuid, declData);
      supabaseClient.saveStep7ReviewSubmit(declData).catch(() => {});
    }



    // ── Auto Core Banking Provisioning on Approval ──
    // When an application is marked 'approved' (onboarded), create its CIF,
    // core corporate account(s) and dedicated BIC in Supabase automatically.
    if (resolvedStatus === "approved") {
      try {
        const { provisionCorporateCustomer } = require("../provisioning-service");
        const provisioned = await provisionCorporateCustomer({
          ...existingRecord,
          company_uid: resolvedCompanyUid,
          status: resolvedStatus
        });
        logAuditEvent({
          company_uid: resolvedCompanyUid,
          action_type: "CORE_PROVISIONING",
          actor_id: req.user.email || existingRecord.registered_email,
          actor_name: targetContact,
          actor_role: "Automated Onboarding Engine",
          target_crn: existingRecord.crn,
          target_email: existingRecord.registered_email,
          target_company: targetComp,
          details: `Core banking provisioned on approval — CIF ${provisioned.cif && provisioned.cif.cif_number}, dedicated BIC ${provisioned.dedicated_bic}, ${provisioned.accounts.length} account(s) opened`,
          device_info: userAgent,
          ip_address: clientIp,
          channel: "web"
        });
        console.log(`[APPLICATION SERVICE] Auto-provisioned ${resolvedCompanyUid}: CIF=${provisioned.cif && provisioned.cif.cif_number} BIC=${provisioned.dedicated_bic}`);
      } catch (provErr) {
        console.warn("[APPLICATION SERVICE] Auto-provisioning failed (manual RM provisioning still available):", provErr.message);
      }
    }

    // ── Live Audit Logging for Application Progress ──
    if (resolvedStatus === "submitted") {
      logAuditEvent({
        company_uid: resolvedCompanyUid,
        action_type: "APPLICATION_SUBMITTED",
        actor_id: req.user.email || existingRecord.registered_email,
        actor_name: targetContact,
        actor_role: "Authorized Signatory",
        target_crn: existingRecord.crn,
        target_email: existingRecord.registered_email,
        target_company: targetComp,
        details: `Corporate onboarding application ${application_ref} completed and submitted for compliance verification`,
        device_info: userAgent,
        ip_address: clientIp,
        channel: "web"
      });

      const recipientEmail = (existingRecord && existingRecord.registered_email) || (req.user && req.user.email) || "admin@corporate.com";
      memStore.recordSimulatedEmail({
        to: recipientEmail,
        from: '"Gringotts Bank Corporate Onboarding" <onboarding@gringotts.com>',
        subject: `Gringotts Bank — Corporate Application Received (${application_ref})`,
        type: "application_submitted",
        metadata: { application_ref, company_uid: resolvedCompanyUid },
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff; color: #0f172a;">
            <div style="text-align: center; margin-bottom: 20px;">
              <img src="/images/bank-logo-dragon.png?v=2" alt="Gringotts Bank Logo" style="height: 46px; width: 90px; object-fit: cover; border-radius: 12px; border: 1.5px solid rgba(56, 130, 220, 0.5); display: inline-block; margin-bottom: 6px; box-shadow: 0 0 10px rgba(56, 130, 220, 0.35);">
              <h2 style="color: #0f172a; margin: 12px 0 2px; font-size: 20px; font-weight: 700;">Gringotts Bank Corporate Portal</h2>
              <p style="color: #64748b; font-size: 13px; margin: 0;">Diagon Alley &bull; Application Confirmation</p>
            </div>
            <p style="color: #334155; font-size: 14px; line-height: 1.5;">Dear Corporate Customer,</p>
            <p style="color: #334155; font-size: 14px; line-height: 1.5;">Your corporate account application for <strong>${targetComp}</strong> (Corporate ID: <strong>${resolvedCompanyUid}</strong>) has been received and logged into our vault compliance verification queue.</p>
            <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 10px; padding: 16px; margin: 18px 0; text-align: center;">
              <span style="font-size: 11px; color: #166534; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px;">Application Reference</span><br>
              <span style="font-size: 24px; font-weight: 800; color: #15803d; letter-spacing: 1px; font-family: monospace;">${application_ref}</span>
            </div>
            <p style="color: #475569; font-size: 13px; line-height: 1.5;">Our compliance and onboarding desk will complete the verification within 1–2 business days. Your assigned Relationship Manager is <strong>Bogrod &amp; Griphook</strong> (vaults@gringotts.co.uk &bull; +44 20 7946 0190 &bull; Diagon Alley).</p>
          </div>
        `,
        text: `Gringotts Bank: Application ${application_ref} received successfully at Diagon Alley.`
      });
    } else if (resolvedStep !== existingRecord.current_step) {
      logAuditEvent({
        company_uid: resolvedCompanyUid,
        action_type: "STEP_PROGRESSION",
        actor_id: req.user.email || existingRecord.registered_email,
        actor_name: targetContact,
        actor_role: "Authorized Signatory",
        target_crn: existingRecord.crn,
        target_email: existingRecord.registered_email,
        target_company: targetComp,
        details: `Corporate onboarding advanced from Step ${existingRecord.current_step} to Step ${resolvedStep} of 7`,
        device_info: userAgent,
        ip_address: clientIp,
        channel: "web"
      });
    } else {
      logAuditEvent({
        company_uid: resolvedCompanyUid,
        action_type: "APPLICATION_SAVE",
        actor_id: req.user.email || existingRecord.registered_email,
        actor_name: targetContact,
        actor_role: "Authorized Signatory",
        target_crn: existingRecord.crn,
        target_email: existingRecord.registered_email,
        target_company: targetComp,
        details: `Draft progress saved for Step ${resolvedStep} (${targetComp})`,
        device_info: userAgent,
        ip_address: clientIp,
        channel: "web"
      });
    }

    return res.json({
      success: true,
      company_uid: resolvedCompanyUid,
      data: updatedRecord,
      service: "application-service"
    });
  } catch (err) {
    console.error("[APPLICATION SERVICE] Save error:", err);
    return res.status(500).json({ error: "Failed to persist application progress." });
  }
});

// 3. Live Audit Trail Endpoint for Web Application
router.get("/audit-trail", requireAuth, async (req, res) => {
  memStore.metrics.serviceRequests.applications++;
  try {
    const company_uid = req.user.company_uid || resolveCompanyUid(null, req.user.crn);
    const crn = req.user.crn;
    const limit = parseInt(req.query.limit, 10) || 100;
    const logs = await getAuditTrail({ company_uid, crn, limit });
    return res.json({
      success: true,
      company_uid,
      crn,
      count: logs.length,
      logs
    });
  } catch (err) {
    console.error("[APPLICATION SERVICE] Audit trail error:", err);
    return res.status(500).json({ error: "Failed to retrieve audit trail." });
  }
});

// 4. Custom Client-Side Audit Event Endpoint
router.post("/audit", requireAuth, async (req, res) => {
  try {
    const { action_type, details, status } = req.body;
    const company_uid = req.user.company_uid || resolveCompanyUid(null, req.user.crn);
    const auditEntry = await logAuditEvent({
      company_uid,
      action_type: action_type || "CLIENT_INTERACTION",
      actor_id: req.user.email || "applicant",
      actor_name: req.user.company_name || "Authorized Signatory",
      actor_role: "Authorized Signatory",
      target_crn: req.user.crn,
      target_email: req.user.email,
      target_company: req.user.company_name,
      details: details || "Web interaction event recorded",
      status: status || "SUCCESS",
      device_info: req.headers["user-agent"] || "Web Browser",
      ip_address: req.ip || req.connection?.remoteAddress || "127.0.0.1",
      channel: "web"
    });
    return res.json({ success: true, log: auditEntry });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// 5. Dual-Key Application Record Query: SELECT * FROM corporate_onboarding_applications WHERE company_uid = $1 AND id = $2 (Requires Auth & Tenant Check)
router.get("/record/:company_uid/:id", requireAuth, async (req, res) => {
  const { company_uid, id } = req.params;
  if (!company_uid || !id) {
    return res.status(400).json({ error: "Both company_uid and id are required parameters." });
  }

  // Tenant Isolation Check: Applicant may only access their own company record; RM executives have full oversight
  const userCuid = (req.user.company_uid || "").trim().toUpperCase();
  const targetCuid = (company_uid || "").trim().toUpperCase();
  if (!req.user.is_rm && req.user.role !== "RM" && userCuid !== targetCuid) {
    return res.status(403).json({ error: "Forbidden: Access to corporate application record denied." });
  }

  try {
    let record = null;
    if (db.isConnected()) {
      const isNumericId = /^\d+$/.test(id);
      const queryText = isNumericId
        ? "SELECT * FROM corporate_onboarding_applications WHERE company_uid = $1 AND id = $2 LIMIT 1"
        : "SELECT * FROM corporate_onboarding_applications WHERE company_uid = $1 AND application_ref = $2 LIMIT 1";
      const result = await db.query(queryText, [company_uid.trim().toUpperCase(), id.trim()]);
      if (result.rows && result.rows.length > 0) {
        record = result.rows[0];
      }
    }

    if (!record && memStore.getApplicationByUidAndId) {
      record = memStore.getApplicationByUidAndId(company_uid, id);
    }

    if (!record) {
      return res.status(404).json({ error: `Application record not found for company_uid ${company_uid} and id ${id}` });
    }

    return res.json({
      success: true,
      company_uid: record.company_uid,
      id: record.id,
      application_ref: record.application_ref,
      data: record
    });
  } catch (err) {
    console.error("[APPLICATION SERVICE] Dual-key lookup error:", err);
    return res.status(500).json({ error: "Failed to retrieve application record." });
  }
});

// 6. Corporate Application Record Query by Corporate UID (Requires Auth & Tenant Check)
router.get("/by-uid/:company_uid", requireAuth, async (req, res) => {
  const { company_uid } = req.params;
  if (!company_uid) {
    return res.status(400).json({ error: "company_uid parameter is required." });
  }

  // Tenant Isolation Check: Applicant may only access their own company record; RM executives have full oversight
  const userCuid = (req.user.company_uid || "").trim().toUpperCase();
  const targetCuid = (company_uid || "").trim().toUpperCase();
  if (!req.user.is_rm && req.user.role !== "RM" && userCuid !== targetCuid) {
    return res.status(403).json({ error: "Forbidden: Access to corporate application record denied." });
  }

  try {
    let record = null;
    if (db.isConnected()) {
      const result = await db.query(
        "SELECT * FROM corporate_onboarding_applications WHERE company_uid = $1 ORDER BY id DESC LIMIT 1",
        [company_uid.trim().toUpperCase()]
      );
      if (result.rows && result.rows.length > 0) {
        record = result.rows[0];
      }
    }

    if (!record && memStore.getApplicationByUid) {
      record = memStore.getApplicationByUid(company_uid);
    }

    if (!record) {
      return res.status(404).json({ error: `Application record not found for company_uid ${company_uid}` });
    }

    return res.json({
      success: true,
      company_uid: record.company_uid,
      id: record.id,
      application_ref: record.application_ref,
      data: record
    });
  } catch (err) {
    console.error("[APPLICATION SERVICE] Corporate UID lookup error:", err);
    return res.status(500).json({ error: "Failed to retrieve corporate record." });
  }
});

// ── Dedicated Stage API Endpoints (Stage-by-Stage Access by company_uid) ──
router.get("/stages/:stageName", requireAuth, async (req, res) => {
  memStore.metrics.serviceRequests.applications++;
  const cuid = req.user.company_uid;
  const { stageName } = req.params;

  if (!cuid) {
    return res.status(400).json({ error: "Company UID not found in session." });
  }

  let data = null;
  switch (stageName.toLowerCase()) {
    case "step1":
    case "step1_documents":
    case "documents":
    case "stage1":
      data = memStore.getStep1Documents(cuid);
      if (!data || data.length === 0) data = await supabaseClient.getStep1Documents(cuid);
      if (!data || data.length === 0) data = memStore.documents ? Array.from(memStore.documents.values()).filter(d => d.company_uid === cuid || d.application_ref === req.user.application_ref) : [];
      break;
    case "step2":
    case "step2_company_info":
    case "company_info":
    case "company-info":
    case "profile":
    case "stage2":
      data = memStore.getStep2CompanyInfo(cuid) || await supabaseClient.getStep2CompanyInfo(cuid);
      break;
    case "step3":
    case "step3_ubo_details":
    case "ubo_details":
    case "ubo-details":
    case "ubos":
    case "stage3":
      data = memStore.getStep3UboDetails(cuid);
      if (!data || data.length === 0) data = await supabaseClient.getStep3UboDetails(cuid);
      break;
    case "step4":
    case "step4_ownership":
    case "ownership":
    case "stage4":
      data = memStore.getStep4Ownership(cuid) || await supabaseClient.getStep4Ownership(cuid);
      break;
    case "step5":
    case "step5_roles":
    case "roles":
    case "mandates":
    case "governance":
    case "stage5":
      data = memStore.getStep5Roles(cuid) || await supabaseClient.getStep5Roles(cuid);
      break;
    case "step6":
    case "step6_fatca_crs":
    case "fatca_crs":
    case "fatca-crs":
    case "tax":
    case "stage6":
      data = memStore.getStep6FatcaCrs(cuid) || await supabaseClient.getStep6FatcaCrs(cuid);
      break;
    case "step7":
    case "step7_review_submit":
    case "review_submit":
    case "review-submit":
    case "declarations":
    case "signatures":
    case "stage7":
      data = memStore.getStep7ReviewSubmit(cuid) || await supabaseClient.getStep7ReviewSubmit(cuid);
      break;
    default:
      return res.status(404).json({ error: `Unknown stage name '${stageName}'. Valid stages: step1_documents, step2_company_info, step3_ubo_details, step4_ownership, step5_roles, step6_fatca_crs, step7_review_submit.` });
  }

  return res.json({
    success: true,
    company_uid: cuid,
    stage: stageName,
    data,
    service: "application-service"
  });
});

// Health check
router.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "application-service",
    port: config.MICROSERVICES.APPLICATIONS.port,
    uptime: process.uptime()
  });
});

module.exports = { router };
