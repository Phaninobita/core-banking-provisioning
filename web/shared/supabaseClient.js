/**
 * First National Bank — Supabase Cloud Database Client
 * Direct, authenticated REST client connecting Node.js backend with Supabase PostgreSQL.
 * Provides resilient persistence for corporate onboarding applications, customer invitations,
 * Base64 document storage, corporate accounts, and audit ledgers.
 */

const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const config = require("./config");

class SupabaseClient {
  constructor() {
    this.baseUrl = (config.SUPABASE_URL || "https://uvfdokzjdwwjpsxuuyey.supabase.co").replace(/\/+$/, "");
    // Prefer the service_role key for server-side core banking writes (bypasses RLS);
    // fall back to the anon key when no service key is configured.
    this.apiKey = config.SUPABASE_SERVICE_KEY || config.SUPABASE_ANON_KEY || "";
    this.projectHost = new URL(this.baseUrl).hostname;
    this.isOperational = false;
  }

  /**
   * Performs an authenticated HTTPS request against the Supabase PostgREST API
   */
  async request(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const headers = {
      "apikey": this.apiKey,
      "Authorization": `Bearer ${this.apiKey}`,
      "Accept": "application/json",
      ...(options.headers || {})
    };

    let bodyData = null;
    if (options.body !== undefined && options.body !== null) {
      bodyData = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyData);
    }

    const fullPath = path.startsWith("/rest/v1") ? path : `/rest/v1/${path.replace(/^\/+/, "")}`;

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.projectHost,
          path: fullPath,
          method,
          headers,
          timeout: options.timeout || 12000
        },
        (res) => {
          let rawData = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            rawData += chunk;
          });
          res.on("end", () => {
            const statusCode = res.statusCode;
            let parsed = null;
            if (rawData && rawData.trim().length > 0) {
              try {
                parsed = JSON.parse(rawData);
              } catch (e) {
                parsed = rawData;
              }
            }

            if (statusCode >= 200 && statusCode < 300) {
              resolve({ statusCode, data: parsed, headers: res.headers });
            } else if (statusCode === 404) {
              resolve({ statusCode: 404, data: null, notFound: true });
            } else {
              const errMsg = (parsed && (parsed.message || parsed.error || parsed.details)) || `Supabase REST error HTTP ${statusCode}`;
              const err = new Error(errMsg);
              err.statusCode = statusCode;
              err.responseBody = parsed;
              reject(err);
            }
          });
        }
      );

      req.on("error", (err) => {
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy(new Error(`Supabase request timed out after ${options.timeout || 12000}ms`));
      });

      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    });
  }

  /**
   * Health ping to check connectivity with Supabase Cloud
   */
  async ping() {
    try {
      const res = await this.request("rm_customer_invitations?limit=1", { method: "GET" });
      this.isOperational = res.statusCode >= 200 && res.statusCode < 300;
      return this.isOperational;
    } catch (e) {
      this.isOperational = false;
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RELATIONSHIP MANAGER INVITATIONS (rm_customer_invitations)
  // ══════════════════════════════════════════════════════════════════════════

  async saveInvitation(invite) {
    const crn = (invite.crn || "").trim().toUpperCase();
    const email = (invite.email || "").trim().toLowerCase();
    const nowIso = new Date().toISOString();

    const record = {
      crn,
      email,
      company_name: (invite.company_name || invite.companyName || "").trim(),
      contact_person: (invite.contact_person || invite.contactPerson || "Authorized Signatory").trim(),
      phone: (invite.phone || "").trim(),
      rm_name: invite.rm_name || invite.rmName || "Phanee (Senior Relationship Manager)",
      rm_id: invite.rm_id || invite.rmId || "RM-PHANEE",
      invite_token: invite.invite_token || invite.inviteToken || ("inv_" + crypto.randomBytes(12).toString("hex")),
      status: invite.status || "invited",
      invite_link: invite.invite_link || invite.inviteLink || `https://phanee.up.railway.app/`,
      notes: (invite.notes || "").trim(),
      company_uid: (invite.company_uid || `CUID-${crn.replace(/[^A-Z0-9]/g, "")}`).toUpperCase(),
      current_step: invite.current_step || 1,
      updated_at: nowIso
    };

    const res = await this.request("rm_customer_invitations?on_conflict=crn,email", {
      method: "POST",
      headers: {
        "Prefer": "resolution=merge-duplicates,return=representation"
      },
      body: record
    });

    return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : record;
  }

  async getInvitation(crn, email) {
    if (!crn || !email) return null;
    const cleanCrn = encodeURIComponent(crn.trim().toUpperCase());
    const cleanEmail = encodeURIComponent(email.trim().toLowerCase());

    const res = await this.request(`rm_customer_invitations?crn=eq.${cleanCrn}&email=eq.${cleanEmail}&select=*&limit=1`);
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0];
    }
    return null;
  }

  async getInvitationByCrn(crn) {
    if (!crn) return null;
    const cleanCrn = encodeURIComponent(crn.trim().toUpperCase());
    const res = await this.request(`rm_customer_invitations?crn=eq.${cleanCrn}&select=*&limit=1`);
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0];
    }
    return null;
  }

  async getInvitationByEmail(email) {
    if (!email) return null;
    const cleanEmail = encodeURIComponent(email.trim().toLowerCase());
    const res = await this.request(`rm_customer_invitations?email=eq.${cleanEmail}&select=*&limit=1`);
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0];
    }
    return null;
  }

  async listInvitations() {
    const res = await this.request("rm_customer_invitations?select=*&order=created_at.desc");
    return Array.isArray(res.data) ? res.data : [];
  }

  async deleteInvitation(crn, email) {
    if (!crn || !email) return false;
    const cleanCrn = encodeURIComponent(crn.trim().toUpperCase());
    const cleanEmail = encodeURIComponent(email.trim().toLowerCase());
    await this.request(`rm_customer_invitations?crn=eq.${cleanCrn}&email=eq.${cleanEmail}`, {
      method: "DELETE"
    });
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CORPORATE ONBOARDING APPLICATIONS (corporate_onboarding_applications)
  // ══════════════════════════════════════════════════════════════════════════

  async saveApplication(app) {
    const nowIso = new Date().toISOString();
    const application_ref = app.application_ref;
    if (!application_ref) {
      throw new Error("application_ref is required to save an application.");
    }

    const payload = {
      application_ref,
      crn: (app.crn || "").trim(),
      company_uid: (app.company_uid || `CUID-${(app.crn || "").replace(/[^A-Z0-9]/gi, "")}`).toUpperCase(),
      registered_email: (app.registered_email || app.email || "").trim().toLowerCase(),
      current_step: typeof app.current_step === "number" ? app.current_step : 1,
      status: app.status || "draft",
      company_name: app.company_name || app.companyName || null,
      trade_name: app.trade_name || app.tradeName || app.company_name || null,
      legal_type: app.legal_type || app.legalType || null,
      licence_issue_date: app.licence_issue_date || null,
      licence_expiry_date: app.licence_expiry_date || null,
      licence_issued_by: app.licence_issued_by || null,
      vat_trn: app.vat_trn || null,
      contact_person: app.contact_person || null,
      phone: app.phone || null,
      form_data: app.form_data || {},
      updated_at: nowIso
    };

    const res = await this.request("corporate_onboarding_applications?on_conflict=application_ref", {
      method: "POST",
      headers: {
        "Prefer": "resolution=merge-duplicates,return=representation"
      },
      body: payload
    });

    return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
  }

  async updateApplication(application_ref, updates) {
    if (!application_ref) throw new Error("application_ref is required to update application.");
    const cleanRef = encodeURIComponent(application_ref.trim());
    const payload = {
      ...updates,
      updated_at: new Date().toISOString()
    };

    const res = await this.request(`corporate_onboarding_applications?application_ref=eq.${cleanRef}`, {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation"
      },
      body: payload
    });

    return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
  }

  async getApplication(application_ref) {
    if (!application_ref) return null;
    const cleanRef = encodeURIComponent(application_ref.trim());
    const res = await this.request(`corporate_onboarding_applications?application_ref=eq.${cleanRef}&select=*&limit=1`);
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0];
    }
    return null;
  }

  async getApplicationByCrnAndEmail(crn, email) {
    if (!crn || !email) return null;
    const cleanCrn = encodeURIComponent(crn.trim());
    const cleanEmail = encodeURIComponent(email.trim().toLowerCase());
    const res = await this.request(`corporate_onboarding_applications?crn=eq.${cleanCrn}&registered_email=eq.${cleanEmail}&select=*&limit=1`);
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0];
    }
    return null;
  }

  async getApplicationByCrn(crn) {
    if (!crn) return null;
    const cleanCrn = encodeURIComponent(crn.trim().toUpperCase());
    const res = await this.request(`corporate_onboarding_applications?crn=eq.${cleanCrn}&select=*&limit=1`);
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0];
    }
    return null;
  }

  async getApplicationByEmail(email) {
    if (!email) return null;
    const cleanEmail = encodeURIComponent(email.trim().toLowerCase());
    const res = await this.request(`corporate_onboarding_applications?registered_email=eq.${cleanEmail}&select=*&limit=1`);
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0];
    }
    return null;
  }

  async getApplicationByUid(company_uid) {
    if (!company_uid) return null;
    const cleanUid = encodeURIComponent(company_uid.trim().toUpperCase());
    const res = await this.request(`corporate_onboarding_applications?company_uid=eq.${cleanUid}&select=*&limit=1`);
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0];
    }
    return null;
  }

  async listApplications(filter = {}) {
    let query = "corporate_onboarding_applications?select=*&order=created_at.desc";
    if (filter.current_step_gte) {
      query += `&current_step=gte.${filter.current_step_gte}`;
    }
    const res = await this.request(query);
    return Array.isArray(res.data) ? res.data : [];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1 DOCUMENTS (step1_documents)
  // ══════════════════════════════════════════════════════════════════════════

  async saveDocument(doc) {
    const {
      id,
      application_ref,
      company_uid,
      document_type,
      file_name,
      file_type,
      file_size,
      file_data_base64,
      ocr_status,
      verification_status,
      extracted_data
    } = doc;

    const activeAppRef = application_ref || "AB-2026-DEMO01";
    const activeCompUid = (company_uid || "CUID-CORPORATE").toUpperCase();
    const cleanRef = encodeURIComponent(activeAppRef);
    const cleanType = encodeURIComponent(document_type || "document");

    // Check if doc exists in step1_documents
    let existing = null;
    if (id) {
      existing = { id };
    } else {
      const checkRes = await this.request(`step1_documents?application_ref=eq.${cleanRef}&document_type=eq.${cleanType}&select=id&limit=1`);
      if (checkRes.data && Array.isArray(checkRes.data) && checkRes.data.length > 0) {
        existing = checkRes.data[0];
      }
    }

    const payload = {
      application_ref: activeAppRef,
      company_uid: activeCompUid,
      document_type: document_type || "trade_license",
      file_name: file_name || "document.pdf",
      file_type: file_type || "application/pdf",
      file_size: file_size || (file_data_base64 ? file_data_base64.length : 0),
      file_data_base64: file_data_base64 || null,
      ocr_status: ocr_status || "verified",
      verification_status: verification_status || "approved",
      extracted_data: extracted_data || {},
      updated_at: new Date().toISOString()
    };

    if (existing && existing.id) {
      const updateRes = await this.request(`step1_documents?id=eq.${existing.id}`, {
        method: "PATCH",
        headers: { "Prefer": "return=representation" },
        body: payload
      });
      return Array.isArray(updateRes.data) && updateRes.data.length > 0 ? updateRes.data[0] : { id: existing.id, ...payload };
    } else {
      const insertRes = await this.request("step1_documents", {
        method: "POST",
        headers: { "Prefer": "return=representation" },
        body: payload
      });
      return Array.isArray(insertRes.data) && insertRes.data.length > 0 ? insertRes.data[0] : payload;
    }
  }

  async listDocuments(application_ref, company_uid) {
    const docMap = new Map();

    // 1. Query by company_uid if available (returns all documents for this corporate client)
    if (company_uid) {
      const cleanUid = encodeURIComponent(company_uid.trim());
      const compRes = await this.request(
        `step1_documents?company_uid=eq.${cleanUid}&select=*&order=created_at.desc`
      );
      if (Array.isArray(compRes.data)) {
        compRes.data.forEach(d => { if (d && d.id) docMap.set(d.id, d); });
      }
    }

    // 2. Query by application_ref if available
    if (application_ref) {
      const cleanRef = encodeURIComponent(application_ref.trim());
      const res = await this.request(
        `step1_documents?application_ref=eq.${cleanRef}&select=*&order=created_at.desc`
      );
      if (Array.isArray(res.data)) {
        res.data.forEach(d => { if (d && d.id) docMap.set(d.id, d); });
      } else {
        const fallbackRes = await this.request(
          `application_documents?application_ref=eq.${cleanRef}&select=*&order=created_at.desc`
        );
        if (Array.isArray(fallbackRes.data)) {
          fallbackRes.data.forEach(d => { if (d && d.id && !docMap.has(d.id)) docMap.set(d.id, d); });
        }
      }
    }

    // Sort newest first
    const docs = Array.from(docMap.values()).sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return tb - ta;
    });

    return docs;
  }

  async listDocumentsByCompanyUid(company_uid) {
    if (!company_uid) return [];
    const cleanUid = encodeURIComponent(company_uid.trim());
    const res = await this.request(
      `step1_documents?company_uid=eq.${cleanUid}&select=*&order=created_at.desc`
    );
    return Array.isArray(res.data) ? res.data : [];
  }

  async getDocument(id, application_ref, company_uid) {
    if (!id) return null;
    const strId = String(id).trim();

    // 1. Numeric Primary Key Lookup (e.g. 5, 6, 13)
    if (/^\d+$/.test(strId)) {
      const numId = parseInt(strId, 10);
      const directRes = await this.request(`step1_documents?id=eq.${numId}&select=*&limit=1`);
      if (directRes.data && Array.isArray(directRes.data) && directRes.data.length > 0) {
        return directRes.data[0];
      }
      const fallbackRes = await this.request(`application_documents?id=eq.${numId}&select=*&limit=1`);
      if (fallbackRes.data && Array.isArray(fallbackRes.data) && fallbackRes.data.length > 0) {
        return fallbackRes.data[0];
      }
    }

    // 2. Document Type or File Name Lookup (e.g. 'trade_licence', 'certificate_of_incorporation', 'board_resolution')
    const cleanId = encodeURIComponent(strId);

    // Scoped by company_uid
    if (company_uid) {
      const cleanUid = encodeURIComponent(company_uid.trim());
      const res = await this.request(`step1_documents?company_uid=eq.${cleanUid}&document_type=eq.${cleanId}&select=*&order=created_at.desc&limit=1`);
      if (res.data && Array.isArray(res.data) && res.data.length > 0) return res.data[0];
      const resFile = await this.request(`step1_documents?company_uid=eq.${cleanUid}&file_name=eq.${cleanId}&select=*&order=created_at.desc&limit=1`);
      if (resFile.data && Array.isArray(resFile.data) && resFile.data.length > 0) return resFile.data[0];
    }

    // Scoped by application_ref
    if (application_ref) {
      const cleanRef = encodeURIComponent(application_ref.trim());
      const res = await this.request(`step1_documents?application_ref=eq.${cleanRef}&document_type=eq.${cleanId}&select=*&order=created_at.desc&limit=1`);
      if (res.data && Array.isArray(res.data) && res.data.length > 0) return res.data[0];
      const resFile = await this.request(`step1_documents?application_ref=eq.${cleanRef}&file_name=eq.${cleanId}&select=*&order=created_at.desc&limit=1`);
      if (resFile.data && Array.isArray(resFile.data) && resFile.data.length > 0) return resFile.data[0];
    }

    // General match by document_type or file_name
    const genType = await this.request(`step1_documents?document_type=eq.${cleanId}&select=*&order=created_at.desc&limit=1`);
    if (genType.data && Array.isArray(genType.data) && genType.data.length > 0) return genType.data[0];

    const genFile = await this.request(`step1_documents?file_name=eq.${cleanId}&select=*&order=created_at.desc&limit=1`);
    if (genFile.data && Array.isArray(genFile.data) && genFile.data.length > 0) return genFile.data[0];

    return null;
  }

  async deleteDocument(id, application_ref) {
    let query = `step1_documents?id=eq.${id}`;
    if (application_ref) {
      query += `&application_ref=eq.${encodeURIComponent(application_ref)}`;
    }
    await this.request(query, { method: "DELETE" });
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPLIANCE AUDIT LOGS (corporate_audit_logs & mobile_audit_logs)
  // ══════════════════════════════════════════════════════════════════════════

  async logAudit(logRecord) {
    const id = logRecord.id || ("aud_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"));
    const nowIso = new Date().toISOString();

    const record = {
      id,
      company_uid: logRecord.company_uid || null,
      action_type: (logRecord.action_type || "ACTION").toUpperCase(),
      actor_id: (logRecord.actor_id || logRecord.actor || "corporate_user").toString(),
      actor_name: logRecord.actor_name || "Authorized Signatory",
      actor_role: logRecord.actor_role || "Corporate User",
      target_crn: logRecord.target_crn || logRecord.crn || null,
      target_email: logRecord.target_email || null,
      target_company: logRecord.target_company || null,
      details: logRecord.details || "",
      status: logRecord.status || "SUCCESS",
      device_info: logRecord.device_info || logRecord.user_agent || "Web Portal",
      ip_address: logRecord.ip_address || "127.0.0.1",
      channel: logRecord.channel || "web",
      created_at: nowIso
    };

    // 1. Write to corporate_audit_logs
    try {
      await this.request("corporate_audit_logs", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: record
      });
    } catch (e) {
      console.warn("[SUPABASE] corporate_audit_logs insert notice:", e.message);
    }

    // 2. Mirror to mobile_audit_logs for mobile app synchronization
    try {
      const mobileRecord = {
        id,
        company_uid: record.company_uid,
        action_type: record.action_type,
        actor_id: record.actor_id,
        actor_name: record.actor_name,
        actor_role: record.actor_role,
        target_crn: record.target_crn,
        target_email: record.target_email,
        target_company: record.target_company,
        details: record.details,
        status: record.status,
        device_info: record.device_info,
        ip_address: record.ip_address,
        channel: record.channel,
        created_at: nowIso,
        timestamp: nowIso
      };
      await this.request("mobile_audit_logs", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: mobileRecord
      });
    } catch (e) {
      // ignore
    }

    return record;
  }

  async getAuditLogs(company_uid, crn, limit = 100) {
    let query = `corporate_audit_logs?select=*&order=created_at.desc&limit=${limit}`;
    if (company_uid && crn) {
      const cleanUid = encodeURIComponent(company_uid.trim().toUpperCase());
      const cleanCrn = encodeURIComponent(crn.trim());
      query += `&or=(company_uid.eq.${cleanUid},target_crn.eq.${cleanCrn})`;
    } else if (company_uid) {
      query += `&company_uid=eq.${encodeURIComponent(company_uid.trim().toUpperCase())}`;
    } else if (crn) {
      query += `&target_crn=eq.${encodeURIComponent(crn.trim())}`;
    }

    try {
      const res = await this.request(query);
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      console.warn("[SUPABASE] getAuditLogs notice:", e.message);
      return [];
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CORE BANKING ACCOUNTS & TRANSACTIONS
  // ══════════════════════════════════════════════════════════════════════════

  async getAccounts(company_uid) {
    if (!company_uid) return [];
    const cleanUid = encodeURIComponent(company_uid.trim().toUpperCase());
    try {
      const res = await this.request(`corporate_accounts?company_uid=eq.${cleanUid}&select=*`);
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  async listAllAccounts() {
    try {
      const res = await this.request("corporate_accounts?select=*&order=id.asc");
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  async listCifs() {
    try {
      const res = await this.request("customer_information_files?select=*&order=created_at.desc");
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  async listAllTransactions(limit = 500) {
    try {
      const res = await this.request(`account_transactions?select=*&order=created_at.desc&limit=${limit}`);
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  // ── Maker-Checker Authorization Queue (core_authorization_requests) ──

  async saveAuthRequest(req) {
    if (!req || !req.request_ref) return null;
    const payload = {
      request_ref: req.request_ref,
      request_type: req.request_type,
      payload: req.payload || {},
      status: req.status || "pending",
      maker_id: req.maker_id,
      maker_name: req.maker_name || null,
      maker_comment: req.maker_comment || null,
      checker_id: req.checker_id || null,
      checker_name: req.checker_name || null,
      checker_comment: req.checker_comment || null,
      result_ref: req.result_ref || null,
      company_uid: req.company_uid || null,
      decided_at: req.decided_at || null,
      updated_at: new Date().toISOString()
    };
    const res = await this.request("core_authorization_requests?on_conflict=request_ref", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: payload
    });
    return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
  }

  async listAuthRequests(status, limit = 200) {
    let query = `core_authorization_requests?select=*&order=created_at.desc&limit=${limit}`;
    if (status) query += `&status=eq.${encodeURIComponent(status)}`;
    try {
      const res = await this.request(query);
      return Array.isArray(res.data) ? res.data : null;
    } catch (e) {
      return null; // table missing → caller falls back to memory
    }
  }

  async patchAuthRequest(request_ref, updates) {
    const clean = encodeURIComponent(String(request_ref).trim());
    try {
      const res = await this.request(`core_authorization_requests?request_ref=eq.${clean}`, {
        method: "PATCH",
        headers: { "Prefer": "return=representation" },
        body: { ...updates, updated_at: new Date().toISOString() }
      });
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  async getTransactions(account_number) {
    if (!account_number) return [];
    const cleanAcc = encodeURIComponent(String(account_number).trim());
    try {
      const res = await this.request(`account_transactions?account_number=eq.${cleanAcc}&select=*&order=created_at.desc`);
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7-STEP CORPORATE ONBOARDING TABLES (Keyed on company_uid)
  // ══════════════════════════════════════════════════════════════════════════

  // Step 1: Documents
  async saveStep1Document(doc) {
    if (!doc || !doc.company_uid) return null;
    const cleanUid = doc.company_uid.trim().toUpperCase();
    const payload = {
      ...doc,
      company_uid: cleanUid,
      updated_at: new Date().toISOString()
    };
    try {
      const res = await this.request("step1_documents", {
        method: "POST",
        headers: { "Prefer": "return=representation" },
        body: payload
      });
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
    } catch (e) {
      return payload;
    }
  }

  async getStep1Documents(companyUid) {
    if (!companyUid) return [];
    const cleanUid = encodeURIComponent(companyUid.trim().toUpperCase());
    try {
      const res = await this.request(`step1_documents?company_uid=eq.${cleanUid}&select=*&order=created_at.desc`);
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  // Step 2: Company Info
  async saveStep2CompanyInfo(info) {
    if (!info || !info.company_uid) return null;
    const cleanUid = info.company_uid.trim().toUpperCase();
    const payload = { ...info, company_uid: cleanUid, updated_at: new Date().toISOString() };
    try {
      const res = await this.request("step2_company_info?on_conflict=company_uid", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: payload
      });
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
    } catch (e) {
      return payload;
    }
  }

  async getStep2CompanyInfo(companyUid) {
    if (!companyUid) return null;
    const cleanUid = encodeURIComponent(companyUid.trim().toUpperCase());
    try {
      const res = await this.request(`step2_company_info?company_uid=eq.${cleanUid}&select=*&limit=1`);
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  // Step 3: UBO Details
  async saveStep3UboDetails(companyUid, ubos) {
    if (!companyUid) return [];
    const cleanUid = companyUid.trim().toUpperCase();
    const list = Array.isArray(ubos) ? ubos : (ubos ? [ubos] : []);
    const payload = list.map(u => ({
      ...u,
      company_uid: cleanUid,
      updated_at: new Date().toISOString()
    }));
    try {
      const res = await this.request("step3_ubo_details", {
        method: "POST",
        headers: { "Prefer": "return=representation" },
        body: payload
      });
      return Array.isArray(res.data) ? res.data : payload;
    } catch (e) {
      return payload;
    }
  }

  async getStep3UboDetails(companyUid) {
    if (!companyUid) return [];
    const cleanUid = encodeURIComponent(companyUid.trim().toUpperCase());
    try {
      const res = await this.request(`step3_ubo_details?company_uid=eq.${cleanUid}&select=*`);
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  // Step 4: Ownership
  async saveStep4Ownership(ownership) {
    if (!ownership || !ownership.company_uid) return null;
    const cleanUid = ownership.company_uid.trim().toUpperCase();
    const payload = { ...ownership, company_uid: cleanUid, updated_at: new Date().toISOString() };
    try {
      const res = await this.request("step4_ownership?on_conflict=company_uid", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: payload
      });
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
    } catch (e) {
      return payload;
    }
  }

  async getStep4Ownership(companyUid) {
    if (!companyUid) return null;
    const cleanUid = encodeURIComponent(companyUid.trim().toUpperCase());
    try {
      const res = await this.request(`step4_ownership?company_uid=eq.${cleanUid}&select=*&limit=1`);
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  // Step 5: Roles
  async saveStep5Roles(roles) {
    if (!roles || !roles.company_uid) return null;
    const cleanUid = roles.company_uid.trim().toUpperCase();
    const payload = { ...roles, company_uid: cleanUid, updated_at: new Date().toISOString() };
    try {
      const res = await this.request("step5_roles?on_conflict=company_uid", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: payload
      });
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
    } catch (e) {
      return payload;
    }
  }

  async getStep5Roles(companyUid) {
    if (!companyUid) return null;
    const cleanUid = encodeURIComponent(companyUid.trim().toUpperCase());
    try {
      const res = await this.request(`step5_roles?company_uid=eq.${cleanUid}&select=*&limit=1`);
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  // Step 6: FATCA / CRS
  async saveStep6FatcaCrs(tax) {
    if (!tax || !tax.company_uid) return null;
    const cleanUid = tax.company_uid.trim().toUpperCase();
    const payload = { ...tax, company_uid: cleanUid, updated_at: new Date().toISOString() };
    try {
      const res = await this.request("step6_fatca_crs?on_conflict=company_uid", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: payload
      });
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
    } catch (e) {
      return payload;
    }
  }

  async getStep6FatcaCrs(companyUid) {
    if (!companyUid) return null;
    const cleanUid = encodeURIComponent(companyUid.trim().toUpperCase());
    try {
      const res = await this.request(`step6_fatca_crs?company_uid=eq.${cleanUid}&select=*&limit=1`);
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  // Step 7: Review & Submit
  async saveStep7ReviewSubmit(decl) {
    if (!decl || !decl.company_uid) return null;
    const cleanUid = decl.company_uid.trim().toUpperCase();
    const payload = { ...decl, company_uid: cleanUid, updated_at: new Date().toISOString() };
    try {
      const res = await this.request("step7_review_submit?on_conflict=company_uid", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: payload
      });
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
    } catch (e) {
      return payload;
    }
  }

  async getStep7ReviewSubmit(companyUid) {
    if (!companyUid) return null;
    const cleanUid = encodeURIComponent(companyUid.trim().toUpperCase());
    try {
      const res = await this.request(`step7_review_submit?company_uid=eq.${cleanUid}&select=*&limit=1`);
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CORE PROVISIONING: CIF, DEDICATED BIC & CORPORATE ACCOUNTS
  // ══════════════════════════════════════════════════════════════════════════

  // Generate a unique CIF number: CIF + 8 digits (deterministic from company_uid)
  generateCifNumber(company_uid) {
    const hash = crypto.createHash("sha256").update(String(company_uid).toUpperCase()).digest("hex");
    return "CIF" + parseInt(hash.substring(0, 10), 16).toString().padStart(8, "0").substring(0, 8);
  }

  // Generate a dedicated 11-character SWIFT-style BIC: 4 bank + 2 country + 2 location + 3 customer-unique
  generateDedicatedBic(company_uid) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const hash = crypto.createHash("sha256").update("bic:" + String(company_uid).toUpperCase()).digest();
    const customerCode = [0, 1, 2].map(i => alphabet[hash[i] % 26]).join("");
    return `FNBKAE2X${customerCode}`;
  }

  async saveCif(cif) {
    if (!cif || !cif.company_uid) return null;
    const cleanUid = cif.company_uid.trim().toUpperCase();
    const payload = {
      cif_number: cif.cif_number || this.generateCifNumber(cleanUid),
      company_uid: cleanUid,
      application_ref: cif.application_ref || null,
      crn: cif.crn || null,
      company_name: cif.company_name || null,
      trade_name: cif.trade_name || null,
      legal_type: cif.legal_type || null,
      registered_email: (cif.registered_email || "").trim().toLowerCase() || null,
      contact_person: cif.contact_person || null,
      phone: cif.phone || null,
      address: cif.address || null,
      customer_type: cif.customer_type || "CORPORATE",
      customer_segment: cif.customer_segment || "Corporate Banking",
      risk_rating: cif.risk_rating || "LOW",
      kyc_status: cif.kyc_status || "passed",
      onboarding_status: cif.onboarding_status || "onboarded",
      dedicated_bic: cif.dedicated_bic || null,
      rm_id: cif.rm_id || "RM-PHANEE",
      rm_name: cif.rm_name || "Phanee (Senior Relationship Manager)",
      profile_data: cif.profile_data || {},
      status: cif.status || "active",
      updated_at: new Date().toISOString()
    };

    const res = await this.request("customer_information_files?on_conflict=company_uid", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: payload
    });
    return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
  }

  async getCif(company_uid) {
    if (!company_uid) return null;
    const cleanUid = encodeURIComponent(company_uid.trim().toUpperCase());
    try {
      const res = await this.request(`customer_information_files?company_uid=eq.${cleanUid}&select=*&limit=1`);
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  async getCifByNumber(cif_number) {
    if (!cif_number) return null;
    const clean = encodeURIComponent(cif_number.trim());
    try {
      const res = await this.request(`customer_information_files?cif_number=eq.${clean}&select=*&limit=1`);
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  async assignDedicatedBic(assignment) {
    if (!assignment || !assignment.company_uid) return null;
    const cleanUid = assignment.company_uid.trim().toUpperCase();
    const payload = {
      bic: assignment.bic || this.generateDedicatedBic(cleanUid),
      bic_type: "dedicated_customer",
      company_uid: cleanUid,
      cif_number: assignment.cif_number || null,
      company_name: assignment.company_name || null,
      branch_code: assignment.branch_code || "XXX",
      country_code: assignment.country_code || "AE",
      status: assignment.status || "active",
      updated_at: new Date().toISOString()
    };

    const res = await this.request("customer_bic_registry?on_conflict=company_uid", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: payload
    });
    return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
  }

  async getDedicatedBic(company_uid) {
    if (!company_uid) return null;
    const cleanUid = encodeURIComponent(company_uid.trim().toUpperCase());
    try {
      const res = await this.request(`customer_bic_registry?company_uid=eq.${cleanUid}&select=*&limit=1`);
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  async createCorporateAccount(account) {
    if (!account || !account.company_uid) throw new Error("company_uid is required to create an account.");

    const cleanUid = account.company_uid.trim().toUpperCase();
    let accountNumber = account.account_number;
    if (!accountNumber) {
      const hash = crypto.createHash("md5").update(cleanUid + ":" + (account.currency || "AED")).digest("hex");
      accountNumber = "70" + parseInt(hash, 16).toString().substring(0, 8);
    }
    const iban = account.iban || `AE29033000${accountNumber}`;

    // Idempotent: return the existing account if this company already holds this account_number
    const existing = await this.getAccountByNumber(accountNumber);
    if (existing) return existing;

    const payload = {
      company_uid: cleanUid,
      cif_number: account.cif_number || null,
      bic: account.bic || null,
      account_number: accountNumber,
      iban,
      currency: account.currency || "AED",
      account_name: account.account_name || "Corporate Checking",
      account_type: account.account_type || "Corporate Checking",
      balance: account.balance != null ? account.balance : 1000000.00,
      available_balance: account.available_balance != null ? account.available_balance : 1000000.00,
      status: account.status || "active",
      application_ref: account.application_ref || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const res = await this.request("corporate_accounts?on_conflict=account_number", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: payload
    });
    return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
  }

  async getAccountByNumber(account_number) {
    if (!account_number) return null;
    const clean = encodeURIComponent(String(account_number).trim());
    try {
      const res = await this.request(`corporate_accounts?account_number=eq.${clean}&select=*&limit=1`);
      return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
      return null;
    }
  }

  async saveTransaction(tx) {
    if (!tx || !tx.account_number) return null;
    const payload = {
      transaction_ref: tx.transaction_ref || ("TX-" + crypto.randomBytes(4).toString("hex").toUpperCase()),
      swift_uetr: tx.swift_uetr || null,
      company_uid: tx.company_uid || null,
      account_number: tx.account_number,
      type: tx.type || "credit",
      amount: tx.amount,
      currency: tx.currency || "AED",
      counterparty_name: tx.counterparty_name || null,
      counterparty_iban: tx.counterparty_iban || null,
      description: tx.description || null,
      category: tx.category || "Commercial Payment",
      status: tx.status || "settled",
      channel: tx.channel || "portal",
      created_at: new Date().toISOString()
    };
    const res = await this.request("account_transactions?on_conflict=transaction_ref", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: payload
    });
    return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : payload;
  }

  // ── Backward Compatibility Method Aliases ──
  async saveCompanyProfile(profile) { return this.saveStep2CompanyInfo(profile); }
  async getCompanyProfile(companyUid) { return this.getStep2CompanyInfo(companyUid); }
  async saveUbos(companyUid, ubos) { return this.saveStep3UboDetails(companyUid, ubos); }
  async getUbos(companyUid) { return this.getStep3UboDetails(companyUid); }
  async saveOwnershipStructure(s) { return this.saveStep4Ownership(s); }
  async getOwnershipStructure(companyUid) { return this.getStep4Ownership(companyUid); }
  async saveGovernanceMandates(m) { return this.saveStep5Roles(m); }
  async getGovernanceMandates(companyUid) { return this.getStep5Roles(companyUid); }
  async saveTaxCompliance(t) { return this.saveStep6FatcaCrs(t); }
  async getTaxCompliance(companyUid) { return this.getStep6FatcaCrs(companyUid); }
  async saveDeclarations(d) { return this.saveStep7ReviewSubmit(d); }
  async getDeclarations(companyUid) { return this.getStep7ReviewSubmit(companyUid); }
}

const supabaseClient = new SupabaseClient();
module.exports = supabaseClient;
