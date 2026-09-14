/**
 * First National Bank — Resilient Dual-Engine Database Layer
 * Supports:
 *   1. Direct PostgreSQL TCP Pool (when valid DATABASE_URL is reachable)
 *   2. Supabase Cloud Database REST Engine (active HTTPS connection with Supabase Cloud)
 *   3. Synchronous in-memory mirror for sub-millisecond local caching & resilience
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const config = require("./config");
const memStore = require("./memStore");
const supabaseClient = require("./supabaseClient");

let pool = null;
let useDatabase = false;
let engineType = "none"; // 'postgres' | 'supabase_rest' | 'in_memory'

async function initDb() {
  // ── Engine 1: Try Direct PostgreSQL TCP Connection ──
  if (config.DATABASE_URL && config.DATABASE_URL.trim() !== "") {
    try {
      const isLocalhost = config.DATABASE_URL.includes("localhost") || config.DATABASE_URL.includes("127.0.0.1");
      const tempPool = new Pool({
        connectionString: config.DATABASE_URL,
        ssl: isLocalhost ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 4000
      });

      tempPool.on("error", (err) => {
        console.error("[DATABASE] Unexpected pg pool client error:", err.message);
      });

      await tempPool.query("SELECT NOW()");

      pool = tempPool;
      useDatabase = true;
      engineType = "postgres";

      // Auto-migrate schema.sql if exists
      const schemaFile = path.join(__dirname, "../db/schema.sql");
      if (fs.existsSync(schemaFile)) {
        try {
          const schemaSql = fs.readFileSync(schemaFile, "utf8");
          await pool.query(schemaSql);
        } catch (mErr) {
          console.warn("[DATABASE] Schema sync note:", mErr.message);
        }
      }

      console.log("✅ [DATABASE] Connected to PostgreSQL TCP Pool (engine: postgres)");
      return;
    } catch (tcpErr) {
      console.warn(`ℹ️  [DATABASE] Direct PostgreSQL TCP inactive (${tcpErr.message}).`);
    }
  }

  // ── Engine 2: Activate Supabase Cloud REST Engine ──
  try {
    const isSupabaseLive = await supabaseClient.ping();
    if (isSupabaseLive) {
      useDatabase = true;
      engineType = "supabase_rest";
      console.log("✅ [DATABASE] Connected to Supabase Cloud Database via REST Engine (tables: rm_customer_invitations, corporate_onboarding_applications, application_documents, corporate_audit_logs)");
      return;
    }
  } catch (restErr) {
    console.warn("[DATABASE] Supabase REST check warning:", restErr.message);
  }

  // ── Engine 3: Local In-Memory Fallback ──
  console.log("ℹ️  [DATABASE] Running with high-speed in-memory repository.");
  useDatabase = false;
  engineType = "in_memory";
}

// Initialize asynchronously on boot
const initPromise = initDb();

/**
 * Intelligent SQL-to-Supabase REST routing for legacy db.query calls
 */
async function handleSupabaseRestQuery(text, params = []) {
  const sql = text.replace(/\s+/g, " ").trim();
  const sqlUpper = sql.toUpperCase();

  // 1. rm_customer_invitations queries
  if (sqlUpper.includes("FROM RM_CUSTOMER_INVITATIONS")) {
    if (sqlUpper.startsWith("SELECT") && sqlUpper.includes("CRN =") && sqlUpper.includes("EMAIL =")) {
      const crn = params[0];
      const email = params[1];
      const invite = await supabaseClient.getInvitation(crn, email);
      return { rows: invite ? [invite] : [] };
    }
    if (sqlUpper.startsWith("SELECT") && sqlUpper.includes("CRN =") && sqlUpper.includes("COMPANY_UID")) {
      const crn = params[0];
      const invite = await supabaseClient.getInvitationByCrn(crn);
      return { rows: invite && invite.company_uid ? [{ company_uid: invite.company_uid }] : [] };
    }
    if (sqlUpper.startsWith("SELECT") && (sqlUpper.includes("CRN =") || sqlUpper.includes("CRN="))) {
      const crn = params[0];
      const invite = await supabaseClient.getInvitationByCrn(crn);
      return { rows: invite ? [invite] : [] };
    }
    if (sqlUpper.startsWith("SELECT")) {
      const list = await supabaseClient.listInvitations();
      return { rows: list };
    }
  }

  if (sqlUpper.startsWith("INSERT INTO RM_CUSTOMER_INVITATIONS")) {
    // Parameterized insert from rm-service
    // [crn, email, company_uid, company_name, contact_person, phone, rm_name, rm_id, invite_token, status, invite_link, notes]
    const inviteRecord = {
      crn: params[0],
      email: params[1],
      company_uid: params[2],
      company_name: params[3],
      contact_person: params[4],
      phone: params[5],
      rm_name: params[6],
      rm_id: params[7],
      invite_token: params[8],
      status: params[9] || "invited",
      invite_link: params[10],
      notes: params[11] || ""
    };
    const saved = await supabaseClient.saveInvitation(inviteRecord);
    return { rows: [saved] };
  }

  if (sqlUpper.startsWith("DELETE FROM RM_CUSTOMER_INVITATIONS")) {
    const crn = params[0];
    const email = params[1];
    await supabaseClient.deleteInvitation(crn, email);
    return { rows: [] };
  }

  // 2. corporate_onboarding_applications queries
  if (sqlUpper.includes("FROM CORPORATE_ONBOARDING_APPLICATIONS")) {
    if (sqlUpper.startsWith("SELECT") && sqlUpper.includes("APPLICATION_REF =")) {
      const app = await supabaseClient.getApplication(params[0]);
      return { rows: app ? [app] : [] };
    }
    if (sqlUpper.startsWith("SELECT") && sqlUpper.includes("CRN =") && sqlUpper.includes("REGISTERED_EMAIL")) {
      const app = await supabaseClient.getApplicationByCrnAndEmail(params[0], params[1]);
      return { rows: app ? [app] : [] };
    }
    if (sqlUpper.startsWith("SELECT") && (sqlUpper.includes("CRN =") || sqlUpper.includes("CRN="))) {
      const app = await supabaseClient.getApplicationByCrn(params[0]);
      return { rows: app ? [app] : [] };
    }
    if (sqlUpper.startsWith("SELECT") && sqlUpper.includes("COMPANY_UID =")) {
      const app = await supabaseClient.getApplicationByUid(params[0]);
      return { rows: app ? [app] : [] };
    }
    if (sqlUpper.startsWith("SELECT") && sqlUpper.includes("CURRENT_STEP >=")) {
      const list = await supabaseClient.listApplications({ current_step_gte: 6 });
      return { rows: list };
    }
    if (sqlUpper.startsWith("SELECT")) {
      const list = await supabaseClient.listApplications();
      return { rows: list };
    }
  }

  if (sqlUpper.startsWith("INSERT INTO CORPORATE_ONBOARDING_APPLICATIONS")) {
    // [appRef, cleanCrn, company_uid, cleanEmail, formDataStr, legalType, companyName, tradeName]
    const formData = typeof params[4] === "string" ? JSON.parse(params[4] || "{}") : (params[4] || {});
    const appRecord = {
      application_ref: params[0],
      crn: params[1],
      company_uid: params[2],
      registered_email: params[3],
      form_data: formData,
      legal_type: params[5],
      company_name: params[6],
      trade_name: params[7] || params[6],
      status: "draft",
      current_step: 1
    };
    const saved = await supabaseClient.saveApplication(appRecord);
    return { rows: [saved] };
  }

  if (sqlUpper.startsWith("UPDATE CORPORATE_ONBOARDING_APPLICATIONS")) {
    // Parameters in application-service save:
    // [application_ref, resolvedStep, resolvedStatus, formDataStr, companyName, tradeName, legalType, issueDate, expiryDate, issuedBy, vatTrn, contactPerson, phone, address, resolvedCompanyUid]
    const appRef = params[0];
    const formData = typeof params[3] === "string" ? JSON.parse(params[3] || "{}") : (params[3] || {});
    const updates = {
      current_step: params[1],
      status: params[2],
      form_data: formData,
      company_name: params[4] || undefined,
      trade_name: params[5] || undefined,
      legal_type: params[6] || undefined,
      licence_issue_date: params[7] || undefined,
      licence_expiry_date: params[8] || undefined,
      licence_issued_by: params[9] || undefined,
      vat_trn: params[10] || undefined,
      contact_person: params[11] || undefined,
      phone: params[12] || undefined,
      address: params[13] || undefined,
      company_uid: params[14] || undefined
    };
    // Filter out undefined
    Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);

    const updated = await supabaseClient.updateApplication(appRef, updates);
    return { rows: updated ? [updated] : [] };
  }

  // 3. step1_documents & application_documents queries
  if (sqlUpper.includes("FROM STEP1_DOCUMENTS") || sqlUpper.includes("FROM APPLICATION_DOCUMENTS")) {
    if ((sqlUpper.startsWith("SELECT ID FROM STEP1_DOCUMENTS") || sqlUpper.startsWith("SELECT ID FROM APPLICATION_DOCUMENTS")) && sqlUpper.includes("DOCUMENT_TYPE =")) {
      const appRef = params[0];
      const docType = params[1];
      const docs = await supabaseClient.listDocuments(appRef);
      const matched = docs.find(d => d.document_type === docType);
      return { rows: matched ? [{ id: matched.id }] : [] };
    }
    if (sqlUpper.startsWith("SELECT") && sqlUpper.includes("APPLICATION_REF =") && sqlUpper.includes("ID =")) {
      const doc = await supabaseClient.getDocument(params[0], params[1]);
      return { rows: doc ? [doc] : [] };
    }
    if (sqlUpper.startsWith("SELECT") && sqlUpper.includes("APPLICATION_REF =")) {
      const docs = await supabaseClient.listDocuments(params[0]);
      return { rows: docs };
    }
  }

  if (sqlUpper.startsWith("INSERT INTO STEP1_DOCUMENTS") || sqlUpper.startsWith("INSERT INTO APPLICATION_DOCUMENTS")) {
    // [activeAppRef, companyUid, document_type, file_name, file_type, file_size, file_data_base64]
    const docRecord = {
      application_ref: params[0],
      company_uid: params[1],
      document_type: params[2],
      file_name: params[3],
      file_type: params[4],
      file_size: params[5],
      file_data_base64: params[6]
    };
    const saved = await supabaseClient.saveDocument(docRecord);
    return { rows: [saved] };
  }

  if (sqlUpper.startsWith("UPDATE STEP1_DOCUMENTS") || sqlUpper.startsWith("UPDATE APPLICATION_DOCUMENTS")) {
    // [file_name, file_type, file_size, file_data_base64, companyUid, existing.rows[0].id]
    const saved = await supabaseClient.saveDocument({
      id: params[5],
      file_name: params[0],
      file_type: params[1],
      file_size: params[2],
      file_data_base64: params[3],
      company_uid: params[4]
    });
    return { rows: [saved] };
  }

  if (sqlUpper.startsWith("DELETE FROM STEP1_DOCUMENTS") || sqlUpper.startsWith("DELETE FROM APPLICATION_DOCUMENTS")) {
    const docId = params[0];
    const appRef = params[1];
    await supabaseClient.deleteDocument(docId, appRef);
    return { rows: [] };
  }

  // 4. corporate_audit_logs queries
  if (sqlUpper.startsWith("INSERT INTO CORPORATE_AUDIT_LOGS") || sqlUpper.startsWith("INSERT INTO MOBILE_AUDIT_LOGS")) {
    const record = {
      id: params[0],
      company_uid: params[1],
      action_type: params[2],
      actor_id: params[3],
      actor_name: params[4],
      actor_role: params[5],
      target_crn: params[6],
      target_email: params[7],
      target_company: params[8],
      details: params[9],
      status: params[10],
      device_info: params[11],
      ip_address: params[12],
      channel: params[13]
    };
    const saved = await supabaseClient.logAudit(record);
    return { rows: [saved] };
  }

  if (sqlUpper.includes("FROM CORPORATE_AUDIT_LOGS")) {
    const companyUid = params[0];
    const crn = params[1];
    const limit = params[2] || 100;
    const logs = await supabaseClient.getAuditLogs(companyUid, crn, limit);
    return { rows: logs };
  }

  // 5. rm_users queries
  if (sqlUpper.includes("FROM RM_USERS")) {
    const cleanUser = (params[0] || "").trim().toLowerCase();
    const memUser = memStore.getRmUser(cleanUser);
    return { rows: memUser ? [memUser] : [] };
  }
  if (sqlUpper.startsWith("INSERT INTO RM_USERS")) {
    const cleanUser = (params[0] || "").trim().toLowerCase();
    const cleanPassword = (params[1] || "GringottsBank@324").trim();
    const memUser = memStore.saveRmUser({
      username: cleanUser,
      password: cleanPassword,
      password_hash: cleanPassword,
      full_name: params[2] || cleanUser,
      email: params[3] || `${cleanUser}@fnb-us.com`,
      role: params[4] || "Senior Relationship Manager · Corporate Banking",
      branch: params[5] || "Diagon Alley Financial Center"
    });
    return { rows: [memUser] };
  }

  // 6. account_transactions
  if (sqlUpper.startsWith("INSERT INTO ACCOUNT_TRANSACTIONS")) {
    // banking-service parameter order: txRef, swiftUetr, accountId, accountNumber,
    // companyUid, type, amount, currency, counterpartyName, counterpartyIban,
    // description, category, status, channel
    const saved = await supabaseClient.saveTransaction({
      transaction_ref: params[0],
      swift_uetr: params[1],
      account_number: params[3],
      company_uid: params[4],
      type: params[5],
      amount: params[6],
      currency: params[7],
      counterparty_name: params[8],
      counterparty_iban: params[9],
      description: params[10],
      category: params[11],
      status: params[12],
      channel: params[13]
    });
    const tx = saved || { id: Date.now() };
    memStore.transactions.unshift(tx);
    return { rows: [tx] };
  }

  if (sqlUpper.includes("FROM ACCOUNT_TRANSACTIONS")) {
    const userCuid = params.length > 1 ? String(params[0] || "").trim().toUpperCase() : null;
    const limit = parseInt(params[params.length - 1], 10) || 20;

    if (userCuid) {
      // Tenant-isolated: pull transactions for each account of this company from Supabase
      const companyAccounts = await supabaseClient.getAccounts(userCuid);
      let supaTxs = [];
      for (const acc of companyAccounts) {
        const accTxs = await supabaseClient.getTransactions(acc.account_number);
        supaTxs = supaTxs.concat(accTxs);
      }
      if (supaTxs.length > 0) {
        supaTxs.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        // Mirror into memory so the transfer fallback stays consistent
        supaTxs.forEach(t => {
          if (t.transaction_ref && !memStore.transactions.some(m => m.transaction_ref === t.transaction_ref)) {
            memStore.transactions.push(t);
          }
        });
        return { rows: supaTxs.slice(0, limit) };
      }
      const callerAccounts = new Set(companyAccounts.map(a => a.account_number));
      for (const acc of memStore.accounts.values()) {
        if (!acc.company_uid || acc.company_uid.toUpperCase() === userCuid) {
          callerAccounts.add(acc.account_number);
        }
      }
      const list = memStore.transactions.filter(t =>
        (t.company_uid && t.company_uid.toUpperCase() === userCuid) ||
        (t.account_number && callerAccounts.has(t.account_number))
      );
      return { rows: list.slice(0, limit) };
    }

    // RM / admin view: all transactions
    const allTxs = await supabaseClient.listAllTransactions(limit);
    if (allTxs.length > 0) {
      return { rows: allTxs.slice(0, limit) };
    }
    return { rows: memStore.transactions.slice(0, limit) };
  }

  // 7. corporate_accounts
  if (sqlUpper.includes("FROM CORPORATE_ACCOUNTS")) {
    if (sqlUpper.includes("ACCOUNT_NUMBER =") || sqlUpper.includes("ACCOUNT_NUMBER=")) {
      const accNum = String(params[0] || "").trim();
      // Prefer the persistent Supabase record, fall back to the in-memory mirror
      const supaAcc = await supabaseClient.getAccountByNumber(accNum);
      if (supaAcc) {
        memStore.accounts.set(supaAcc.account_number, supaAcc);
        return { rows: [supaAcc] };
      }
      let acc = memStore.accounts.get(accNum);
      if (!acc) {
        for (const a of memStore.accounts.values()) {
          if (a.account_number === accNum) { acc = a; break; }
        }
      }
      return { rows: acc ? [acc] : [] };
    }
    const accounts = await supabaseClient.listAllAccounts();
    if (!accounts || accounts.length === 0) {
      return { rows: Array.from(memStore.accounts.values()) };
    }
    accounts.forEach(a => { if (a.account_number) memStore.accounts.set(a.account_number, a); });
    return { rows: accounts };
  }

  if (sqlUpper.startsWith("UPDATE CORPORATE_ACCOUNTS")) {
    // UPDATE corporate_accounts SET balance = balance - $1, available_balance = available_balance - $1, updated_at = NOW() WHERE account_number = $2 AND available_balance >= $1 RETURNING *
    const deductAmount = parseFloat(params[0]);
    const accNum = String(params[1] || "").trim();

    // Source of truth is the persistent Supabase account row
    let acc = await supabaseClient.getAccountByNumber(accNum);
    if (!acc) {
      acc = memStore.accounts.get(accNum);
      if (!acc) {
        for (const a of memStore.accounts.values()) {
          if (a.account_number === accNum) { acc = a; break; }
        }
      }
    }
    if (acc) {
      const avail = parseFloat(acc.available_balance || acc.balance || 0);
      if (avail >= deductAmount) {
        const newBalance = Number((parseFloat(acc.balance) - deductAmount).toFixed(2));
        const newAvail = Number((avail - deductAmount).toFixed(2));

        // Persist the debit to Supabase
        try {
          const patchRes = await supabaseClient.request(
            `corporate_accounts?account_number=eq.${encodeURIComponent(accNum)}`,
            {
              method: "PATCH",
              headers: { "Prefer": "return=representation" },
              body: { balance: newBalance, available_balance: newAvail, updated_at: new Date().toISOString() }
            }
          );
          if (Array.isArray(patchRes.data) && patchRes.data.length > 0) {
            acc = patchRes.data[0];
          } else {
            acc.balance = newBalance;
            acc.available_balance = newAvail;
            acc.updated_at = new Date().toISOString();
          }
        } catch (e) {
          console.warn("[SUPABASE ROUTER] Account balance PATCH notice:", e.message);
          acc.balance = newBalance;
          acc.available_balance = newAvail;
          acc.updated_at = new Date().toISOString();
        }
        memStore.accounts.set(acc.account_number || accNum, acc);
        return { rows: [acc] };
      }
    }
    return { rows: [] };
  }

  console.warn(`[SUPABASE ROUTER] Unhandled query pattern: "${text.substring(0, 80)}..."`);
  return { rows: [] };
}

const db = {
  get pool() {
    return pool;
  },
  get engineType() {
    return engineType;
  },
  ready() {
    return initPromise;
  },
  isConnected() {
    return useDatabase;
  },
  async query(text, params = []) {
    await initPromise;
    if (useDatabase) {
      if (engineType === "postgres" && pool) {
        return pool.query(text, params);
      }
      if (engineType === "supabase_rest") {
        return handleSupabaseRestQuery(text, params);
      }
    }
    throw new Error("Database not connected, use memory store fallback");
  },

  // ── High-Level Entity Helpers ──
  async saveInvitation(invite) {
    await initPromise;
    return supabaseClient.saveInvitation(invite);
  },
  async getInvitation(crn, email) {
    await initPromise;
    return supabaseClient.getInvitation(crn, email);
  },
  async getInvitationByCrn(crn) {
    await initPromise;
    if (useDatabase && engineType === "postgres" && pool) {
      try {
        const res = await pool.query("SELECT * FROM rm_customer_invitations WHERE UPPER(TRIM(crn)) = $1 LIMIT 1", [crn.trim().toUpperCase()]);
        return res.rows && res.rows.length > 0 ? res.rows[0] : null;
      } catch (err) {
        console.warn("[DATABASE] pool.query error in getInvitationByCrn:", err.message);
      }
    }
    return supabaseClient.getInvitationByCrn(crn);
  },
  async getInvitationByEmail(email) {
    await initPromise;
    if (useDatabase && engineType === "postgres" && pool) {
      try {
        const res = await pool.query("SELECT * FROM rm_customer_invitations WHERE LOWER(TRIM(email)) = $1 LIMIT 1", [email.trim().toLowerCase()]);
        return res.rows && res.rows.length > 0 ? res.rows[0] : null;
      } catch (err) {
        console.warn("[DATABASE] pool.query error in getInvitationByEmail:", err.message);
      }
    }
    return supabaseClient.getInvitationByEmail(email);
  },
  async listInvitations() {
    await initPromise;
    return supabaseClient.listInvitations();
  },
  async deleteInvitation(crn, email) {
    await initPromise;
    return supabaseClient.deleteInvitation(crn, email);
  },

  async saveApplication(app) {
    await initPromise;
    return supabaseClient.saveApplication(app);
  },
  async updateApplication(ref, updates) {
    await initPromise;
    return supabaseClient.updateApplication(ref, updates);
  },
  async getApplication(ref) {
    await initPromise;
    return supabaseClient.getApplication(ref);
  },
  async getApplicationByCrnAndEmail(crn, email) {
    await initPromise;
    if (useDatabase && engineType === "postgres" && pool) {
      try {
        const res = await pool.query("SELECT * FROM corporate_onboarding_applications WHERE UPPER(TRIM(crn)) = $1 AND LOWER(TRIM(registered_email)) = $2 LIMIT 1", [crn.trim().toUpperCase(), email.trim().toLowerCase()]);
        return res.rows && res.rows.length > 0 ? res.rows[0] : null;
      } catch (err) {
        console.warn("[DATABASE] pool.query error in getApplicationByCrnAndEmail:", err.message);
      }
    }
    return supabaseClient.getApplicationByCrnAndEmail(crn, email);
  },
  async getApplicationByCrn(crn) {
    await initPromise;
    if (useDatabase && engineType === "postgres" && pool) {
      try {
        const res = await pool.query("SELECT * FROM corporate_onboarding_applications WHERE UPPER(TRIM(crn)) = $1 LIMIT 1", [crn.trim().toUpperCase()]);
        return res.rows && res.rows.length > 0 ? res.rows[0] : null;
      } catch (err) {
        console.warn("[DATABASE] pool.query error in getApplicationByCrn:", err.message);
      }
    }
    return supabaseClient.getApplicationByCrn(crn);
  },
  async getApplicationByEmail(email) {
    await initPromise;
    if (useDatabase && engineType === "postgres" && pool) {
      try {
        const res = await pool.query("SELECT * FROM corporate_onboarding_applications WHERE LOWER(TRIM(registered_email)) = $1 LIMIT 1", [email.trim().toLowerCase()]);
        return res.rows && res.rows.length > 0 ? res.rows[0] : null;
      } catch (err) {
        console.warn("[DATABASE] pool.query error in getApplicationByEmail:", err.message);
      }
    }
    return supabaseClient.getApplicationByEmail(email);
  },
  async getApplicationByUid(uid) {
    await initPromise;
    return supabaseClient.getApplicationByUid(uid);
  },
  async listApplications(filter = {}) {
    await initPromise;
    return supabaseClient.listApplications(filter);
  },

  async saveDocument(doc) {
    await initPromise;
    return supabaseClient.saveDocument(doc);
  },
  async getDocument(id, appRef, companyUid) {
    await initPromise;
    return supabaseClient.getDocument(id, appRef, companyUid);
  },
  async listDocuments(appRef, companyUid) {
    await initPromise;
    return supabaseClient.listDocuments(appRef, companyUid);
  },
  async deleteDocument(id, appRef) {
    await initPromise;
    return supabaseClient.deleteDocument(id, appRef);
  },

  async logAudit(record) {
    await initPromise;
    return supabaseClient.logAudit(record);
  },
  async getAuditLogs(uid, crn, limit) {
    await initPromise;
    return supabaseClient.getAuditLogs(uid, crn, limit);
  }
};

module.exports = db;
