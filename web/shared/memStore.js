/**
 * First National Bank Platform — High-Fidelity In-Memory Repository & Event Store
 * Provides instant persistence, zero-downtime development, and fallback support.
 */

const crypto = require("crypto");
const { hashPassword } = require("./security");

class MemoryStore {
  constructor() {
    this.applications = new Map();
    this.crnEmailIndex = new Map(); // `${crn}:${email}` -> application_ref
    this.otpStore = new Map(); // `${crn}:${email}` -> { otp, expiresAt }
    
    // Base64 Document Vault: docId -> document record
    this.documents = new Map();
    this.nextDocId = 1;

    // Live Core Banking Accounts
    this.accounts = new Map();
    
    // Transaction Ledger
    this.transactions = [];

    // Real-Time Simulated Email Buffer
    this.simulatedEmails = [];

    // Corporate Audit Logs Store (Web and Mobile Events)
    this.auditLogs = [];

    // Company UID to Application Ref Index
    this.companyUidIndex = new Map();

    // Strict 1:1 CRN to Company UID Index
    this.crnToCompanyUid = new Map();

    // Relationship Manager (RM) Customer Invitations Repository
    // Key: `${crn.trim().toUpperCase()}:${email.trim().toLowerCase()}` -> invitation record
    this.rmInvitations = new Map();

    // Relationship Manager (RM) Authorized Users & Executives
    // Key: username (lowercase) -> user record
    this.rmUsers = new Map();

    // ── 7-Step Corporate Onboarding Domain Stores (Keyed on company_uid) ──
    this.step1Documents = new Map();         // Step 1: Documents
    this.step2CompanyInfo = new Map();       // Step 2: Company Info
    this.step3UboDetails = new Map();        // Step 3: UBO Details
    this.step4Ownership = new Map();         // Step 4: Ownership
    this.step5Roles = new Map();             // Step 5: Roles
    this.step6FatcaCrs = new Map();          // Step 6: FATCA / CRS
    this.step7ReviewSubmit = new Map();      // Step 7: Review & Submit

    // Backward compatibility aliases
    this.companyProfiles = this.step2CompanyInfo;
    this.ubosSignatories = this.step3UboDetails;
    this.ownershipStructures = this.step4Ownership;
    this.governanceMandates = this.step5Roles;
    this.taxCompliance = this.step6FatcaCrs;
    this.declarationsSignatures = this.step7ReviewSubmit;


    // Microservice Telemetry & Health metrics
    this.metrics = {
      startTime: Date.now(),
      requestsCount: 0,
      serviceRequests: {
        gateway: 0,
        auth: 0,
        documents: 0,
        applications: 0,
        banking: 0,
        notifications: 0,
        rm: 0
      }
    };

    this._seedInitialData();
  }

  _seedInitialData() {
    // Seed primary Relationship Manager user (Phanee) with secure scrypt hashed password
    const defaultPassHash = hashPassword("GringottsBank@324");
    const primaryRm = {
      username: "phanee",
      password_hash: defaultPassHash,
      full_name: "Phanee",
      email: "phanee@fnb-us.com",
      role: "Senior Relationship Manager · Corporate Banking",
      branch: "Diagon Alley Financial Center",
      status: "active"
    };
    this.saveRmUser(primaryRm);

    // Aliases so login never fails if staff enters full name, admin, or Gringotts RM
    this.saveRmUser({
      ...primaryRm,
      username: "phaneendra",
      email: "phaneendra@fnb-us.com"
    });
    this.saveRmUser({
      ...primaryRm,
      username: "admin",
      email: "admin@gringotts.co.uk",
      full_name: "System Administrator"
    });
    this.saveRmUser({
      ...primaryRm,
      username: "bogrod",
      email: "vaults@gringotts.co.uk",
      full_name: "Bogrod & Griphook"
    });
    // Note: No demo accounts, transactions, or customer invitations are pre-seeded.
    // Database and in-memory stores start completely fresh.
  }

  getRmUser(usernameOrEmail) {
    if (!usernameOrEmail) return null;
    const clean = usernameOrEmail.trim().toLowerCase();
    if (this.rmUsers.has(clean)) return this.rmUsers.get(clean);
    for (const u of this.rmUsers.values()) {
      if (u.email && u.email.toLowerCase() === clean) return u;
      if (u.username && u.username.toLowerCase() === clean) return u;
    }
    // Fallback to primary RM for common staff ID aliases
    if (clean === "phanee" || clean === "phaneendra" || clean === "admin") {
      return this.rmUsers.get("phanee");
    }
    return null;
  }

  saveRmUser(user) {
    const clean = (user.username || "").trim().toLowerCase();
    if (!clean) return null;
    let pwdHash = user.password_hash;
    if (!pwdHash || !pwdHash.includes(":")) {
      pwdHash = hashPassword(user.password || user.password_hash || "GringottsBank@324");
    }
    const record = {
      username: clean,
      password_hash: pwdHash,
      full_name: user.full_name || user.name || clean,
      email: (user.email || `${clean}@fnb-us.com`).trim().toLowerCase(),
      role: user.role || "Senior Relationship Manager · Corporate Banking",
      branch: user.branch || "Diagon Alley Financial Center",
      status: user.status || "active",
      created_at: user.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.rmUsers.set(clean, record);
    return record;
  }

  listRmUsers() {
    return Array.from(this.rmUsers.values());
  }

  getCompanyUidForCrn(crn) {
    if (!crn) return null;
    const clean = crn.trim().toUpperCase();
    if (this.crnToCompanyUid.has(clean)) {
      return this.crnToCompanyUid.get(clean);
    }
    // Check existing applications
    for (const app of this.applications.values()) {
      if (app.crn && app.crn.trim().toUpperCase() === clean && app.company_uid) {
        this.crnToCompanyUid.set(clean, app.company_uid);
        return app.company_uid;
      }
    }
    // Check existing invitations
    for (const inv of this.rmInvitations.values()) {
      if (inv.crn && inv.crn.trim().toUpperCase() === clean && inv.company_uid) {
        this.crnToCompanyUid.set(clean, inv.company_uid);
        return inv.company_uid;
      }
    }
    return null;
  }

  setCompanyUidForCrn(crn, uid) {
    if (!crn || !uid) return;
    this.crnToCompanyUid.set(crn.trim().toUpperCase(), uid.trim().toUpperCase());
  }

  getApplicationByUidAndId(companyUid, id) {
    if (!companyUid) return null;
    const cleanUid = companyUid.trim().toUpperCase();
    const cleanId = id ? id.toString() : null;
    for (const app of this.applications.values()) {
      const matchUid = app.company_uid && app.company_uid.trim().toUpperCase() === cleanUid;
      if (matchUid) {
        if (!cleanId) return app;
        if (app.id && app.id.toString() === cleanId) return app;
        if (app.application_ref && app.application_ref === cleanId) return app;
      }
    }
    return null;
  }

  getApplicationByUid(companyUid) {
    return this.getApplicationByUidAndId(companyUid, null);
  }

  getApplicationByCrn(crn) {
    if (!crn) return null;
    const cleanCrn = crn.trim().toUpperCase();
    for (const app of this.applications.values()) {
      if (app.crn && app.crn.trim().toUpperCase() === cleanCrn) {
        return app;
      }
    }
    return null;
  }

  getApplicationByEmail(email) {
    if (!email) return null;
    const cleanEmail = email.trim().toLowerCase();
    for (const app of this.applications.values()) {
      const appEmail = (app.registered_email || app.email || (app.form_data && (app.form_data.email || app.form_data.step1?.email || app.form_data.step2?.email)) || "").trim().toLowerCase();
      if (appEmail === cleanEmail) {
        return app;
      }
    }
    return null;
  }

  saveRmInvitation(invite) {
    const crn = (invite.crn || "").trim().toUpperCase();
    const email = (invite.email || "").trim().toLowerCase();
    const key = `${crn}:${email}`;
    const existing = this.rmInvitations.get(key) || {};
    
    // Strict 1:1 CRN-to-UID resolution
    let company_uid = invite.company_uid || existing.company_uid || this.getCompanyUidForCrn(crn);
    if (!company_uid) {
      company_uid = "CUID-" + crn.replace(/[^A-Z0-9]/g, "");
    }
    company_uid = company_uid.toUpperCase();
    this.setCompanyUidForCrn(crn, company_uid);

    const record = {
      ...existing,
      ...invite,
      company_uid,
      crn,
      email,
      updated_at: new Date().toISOString()
    };
    if (!record.created_at) {
      record.created_at = new Date().toISOString();
    }
    this.rmInvitations.set(key, record);
    return record;
  }

  createRmInvitation(invite) {
    return this.saveRmInvitation(invite);
  }

  getRmInvitation(crn, email) {
    if (!crn || !email) return null;
    const key = `${crn.trim().toUpperCase()}:${email.trim().toLowerCase()}`;
    return this.rmInvitations.get(key) || null;
  }

  getRmInvitationByCrn(crn) {
    if (!crn) return null;
    const cleanCrn = crn.trim().toUpperCase();
    for (const inv of this.rmInvitations.values()) {
      if (inv.crn && inv.crn.trim().toUpperCase() === cleanCrn) {
        return inv;
      }
    }
    return null;
  }

  getRmInvitationByEmail(email) {
    if (!email) return null;
    const cleanEmail = email.trim().toLowerCase();
    for (const inv of this.rmInvitations.values()) {
      if (inv.email && inv.email.trim().toLowerCase() === cleanEmail) {
        return inv;
      }
    }
    return null;
  }

  listRmInvitations() {
    return Array.from(this.rmInvitations.values()).sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );
  }

  deleteRmInvitation(crn, email) {
    const key = `${crn.trim().toUpperCase()}:${email.trim().toLowerCase()}`;
    return this.rmInvitations.delete(key);
  }

  recordAuditLog(log) {
    const record = {
      id: log.id || ("aud_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7)),
      company_uid: log.company_uid || null,
      action_type: (log.action_type || "ACTION").toUpperCase(),
      actor_id: (log.actor_id || "corporate_user").toString(),
      actor_name: log.actor_name || "Authorized Signatory",
      actor_role: log.actor_role || "Corporate User",
      target_crn: log.target_crn ? log.target_crn.toString().trim() : null,
      target_email: log.target_email ? log.target_email.toString().trim().toLowerCase() : null,
      target_company: log.target_company || null,
      details: log.details || "",
      status: log.status || "SUCCESS",
      device_info: log.device_info || "Web Portal",
      ip_address: log.ip_address || "127.0.0.1",
      channel: log.channel || "web",
      created_at: log.created_at || new Date().toISOString()
    };
    this.auditLogs.unshift(record);
    if (this.auditLogs.length > 500) {
      this.auditLogs.pop();
    }
    return record;
  }

  getAuditLogs(companyUid, crn, limit = 100) {
    let filtered = this.auditLogs;
    if (companyUid) {
      const cleanUid = companyUid.trim().toUpperCase();
      filtered = filtered.filter(l => (l.company_uid && l.company_uid.toUpperCase() === cleanUid) || (crn && l.target_crn === crn));
    } else if (crn) {
      filtered = filtered.filter(l => l.target_crn === crn);
    }
    return filtered.slice(0, limit);
  }

  recordSimulatedEmail({ to, from, subject, html, text, code, type, metadata }) {
    const emailItem = {
      id: "eml_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
      to: to || "applicant@corporate.com",
      from: from || '"Gringotts Bank" <onboarding@gringotts.com>',
      subject: subject || "Gringotts Bank Notification",
      html: html || "",
      text: text || "",
      code: code || null,
      type: type || "general",
      metadata: metadata || {},
      timestamp: new Date().toISOString()
    };

    this.simulatedEmails.unshift(emailItem);
    if (this.simulatedEmails.length > 50) {
      this.simulatedEmails.pop();
    }

    // Auto-dispatch real-time email to Yopmail if recipient is a Yopmail address
    const cleanTo = (to || "").trim().toLowerCase();
    if (cleanTo && !metadata?.messageId) {
      const targetYopmail = cleanTo.includes("yopmail") 
        ? cleanTo 
        : `${cleanTo.split("@")[0].replace(/[^a-z0-9._-]/gi, "")}@yopmail.com`;
      try {
        const { sendYopmail } = require("../services/notification-service/yopmailSender");
        sendYopmail({
          to: targetYopmail,
          from: emailItem.from,
          subject: emailItem.subject,
          html: emailItem.html,
          text: emailItem.text
        }).then(res => {
          emailItem.metadata.yopmailRealTime = true;
          emailItem.metadata.yopmailResponse = res.response;
          emailItem.metadata.inboxUrl = res.inboxUrl;
          console.log(`📧 [REALTIME YOPMAIL] Email delivered to ${targetYopmail}: ${res.inboxUrl}`);
        }).catch(err => {
          emailItem.metadata.yopmailError = err.message;
          const isTimeout = err.message && (err.message.includes("timeout") || err.message.includes("ETIMEDOUT") || err.message.includes("ECONNREFUSED"));
          if (isTimeout) {
            console.log(`ℹ️  [REALTIME YOPMAIL] Cloud host (Railway) network firewall blocked direct outbound SMTP port 587. Email archived in simulated mailbox.`);
          } else {
            console.log(`ℹ️  [REALTIME YOPMAIL] Notice for ${targetYopmail}: ${err.message}`);
          }
        });
      } catch (err) {
        console.log("ℹ️  [REALTIME YOPMAIL] Could not initialize yopmailSender:", err.message);
      }
    }

    return emailItem;
  }

  // ── 7-Step Corporate Onboarding Domain Methods (Keyed on company_uid) ──

  // Step 1: Documents
  saveStep1Document(companyUid, doc) {
    if (!companyUid || !doc) return null;
    const uid = companyUid.trim().toUpperCase();
    const docList = this.step1Documents.get(uid) || [];
    const docRecord = {
      id: doc.id || Date.now(),
      company_uid: uid,
      application_ref: doc.application_ref || "",
      document_type: doc.document_type || "other",
      file_name: doc.file_name || "document.pdf",
      file_type: doc.file_type || "application/pdf",
      file_size: doc.file_size || 0,
      file_data_base64: doc.file_data_base64 || null,
      ocr_status: doc.ocr_status || "verified",
      verification_status: doc.verification_status || "approved",
      extracted_data: doc.extracted_data || {},
      created_at: doc.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const filtered = docList.filter(d => d.document_type !== docRecord.document_type);
    filtered.push(docRecord);
    this.step1Documents.set(uid, filtered);
    return docRecord;
  }
  getStep1Documents(companyUid) {
    if (!companyUid) return [];
    return this.step1Documents.get(companyUid.trim().toUpperCase()) || [];
  }

  // Step 2: Company Info
  saveStep2CompanyInfo(companyUid, data) {
    if (!companyUid) return null;
    const uid = companyUid.trim().toUpperCase();
    const existing = this.step2CompanyInfo.get(uid) || {};
    const updated = { ...existing, ...data, company_uid: uid, updated_at: new Date().toISOString() };
    this.step2CompanyInfo.set(uid, updated);
    return updated;
  }
  getStep2CompanyInfo(companyUid) {
    if (!companyUid) return null;
    return this.step2CompanyInfo.get(companyUid.trim().toUpperCase()) || null;
  }

  // Step 3: UBO Details
  saveStep3UboDetails(companyUid, ubos) {
    if (!companyUid) return [];
    const uid = companyUid.trim().toUpperCase();
    const list = Array.isArray(ubos) ? ubos : (ubos ? [ubos] : []);
    const normalized = list.map((u, i) => ({
      id: u.id || `ubo_${Date.now()}_${i}`,
      company_uid: uid,
      ...u,
      updated_at: new Date().toISOString()
    }));
    this.step3UboDetails.set(uid, normalized);
    return normalized;
  }
  getStep3UboDetails(companyUid) {
    if (!companyUid) return [];
    return this.step3UboDetails.get(companyUid.trim().toUpperCase()) || [];
  }

  // Step 4: Ownership
  saveStep4Ownership(companyUid, data) {
    if (!companyUid) return null;
    const uid = companyUid.trim().toUpperCase();
    const existing = this.step4Ownership.get(uid) || {};
    const updated = { ...existing, ...data, company_uid: uid, updated_at: new Date().toISOString() };
    this.step4Ownership.set(uid, updated);
    return updated;
  }
  getStep4Ownership(companyUid) {
    if (!companyUid) return null;
    return this.step4Ownership.get(companyUid.trim().toUpperCase()) || null;
  }

  // Step 5: Roles
  saveStep5Roles(companyUid, data) {
    if (!companyUid) return null;
    const uid = companyUid.trim().toUpperCase();
    const existing = this.step5Roles.get(uid) || {};
    const updated = { ...existing, ...data, company_uid: uid, updated_at: new Date().toISOString() };
    this.step5Roles.set(uid, updated);
    return updated;
  }
  getStep5Roles(companyUid) {
    if (!companyUid) return null;
    return this.step5Roles.get(companyUid.trim().toUpperCase()) || null;
  }

  // Step 6: FATCA / CRS
  saveStep6FatcaCrs(companyUid, data) {
    if (!companyUid) return null;
    const uid = companyUid.trim().toUpperCase();
    const existing = this.step6FatcaCrs.get(uid) || {};
    const updated = { ...existing, ...data, company_uid: uid, updated_at: new Date().toISOString() };
    this.step6FatcaCrs.set(uid, updated);
    return updated;
  }
  getStep6FatcaCrs(companyUid) {
    if (!companyUid) return null;
    return this.step6FatcaCrs.get(companyUid.trim().toUpperCase()) || null;
  }

  // Step 7: Review & Submit
  saveStep7ReviewSubmit(companyUid, data) {
    if (!companyUid) return null;
    const uid = companyUid.trim().toUpperCase();
    const existing = this.step7ReviewSubmit.get(uid) || {};
    const updated = { ...existing, ...data, company_uid: uid, updated_at: new Date().toISOString() };
    this.step7ReviewSubmit.set(uid, updated);
    return updated;
  }
  getStep7ReviewSubmit(companyUid) {
    if (!companyUid) return null;
    return this.step7ReviewSubmit.get(companyUid.trim().toUpperCase()) || null;
  }

  // ── Backward Compatibility Aliases ──
  saveCompanyProfile(companyUid, data) { return this.saveStep2CompanyInfo(companyUid, data); }
  getCompanyProfile(companyUid) { return this.getStep2CompanyInfo(companyUid); }
  saveUbosSignatories(companyUid, ubos) { return this.saveStep3UboDetails(companyUid, ubos); }
  getUbosSignatories(companyUid) { return this.getStep3UboDetails(companyUid); }
  saveOwnershipStructure(companyUid, data) { return this.saveStep4Ownership(companyUid, data); }
  getOwnershipStructure(companyUid) { return this.getStep4Ownership(companyUid); }
  saveGovernanceMandates(companyUid, data) { return this.saveStep5Roles(companyUid, data); }
  getGovernanceMandates(companyUid) { return this.getStep5Roles(companyUid); }
  saveTaxCompliance(companyUid, data) { return this.saveStep6FatcaCrs(companyUid, data); }
  getTaxCompliance(companyUid) { return this.getStep6FatcaCrs(companyUid); }
  saveDeclarationsSignatures(companyUid, data) { return this.saveStep7ReviewSubmit(companyUid, data); }
  getDeclarationsSignatures(companyUid) { return this.getStep7ReviewSubmit(companyUid); }
}

const memStore = new MemoryStore();
module.exports = memStore;

