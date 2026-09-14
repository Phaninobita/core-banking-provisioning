/**
 * First National Bank Audit & Compliance Subsystem
 * Unified audit event logging and real-time ledger for Web and Mobile channels.
 * Maps every compliance event to the canonical corporate entity via company_uid.
 */

const crypto = require("crypto");
const db = require("./db");
const memStore = require("./memStore");

/**
 * Derives or normalizes a canonical company_uid from given input or CRN.
 * Supports both resolveCompanyUid("CUID-1", "CRN-1") and resolveCompanyUid({ company_uid, crn })
 */
function resolveCompanyUid(firstArg, secondArg) {
  let companyUid = "";
  let crn = "";

  if (firstArg && typeof firstArg === "object") {
    companyUid = firstArg.company_uid || firstArg.companyUid;
    crn = firstArg.crn;
  } else {
    companyUid = firstArg;
    crn = secondArg;
  }

  if (companyUid && typeof companyUid === "string" && companyUid.trim() !== "") {
    return companyUid.trim().toUpperCase();
  }
  if (crn && typeof crn === "string" && crn.trim() !== "") {
    return "CUID-" + crn.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  }
  return "CUID-CORPORATE";
}

/**
 * Logs a compliance audit event into PostgreSQL and in-memory store.
 * Supports aliases (crn, actor, target, metadata) for convenient calling across microservices.
 */
async function logAuditEvent({
  company_uid,
  action_type,
  actor_id,
  actor_name,
  actor_role = "Authorized Signatory",
  actor,
  target_crn,
  crn,
  target_email,
  target_company,
  target,
  details,
  metadata,
  status = "SUCCESS",
  device_info = "Web Portal (Chrome / Secure HTTPS)",
  user_agent,
  ip_address = "127.0.0.1",
  channel = "web"
}) {
  const resolvedCrn = (target_crn || crn || "").toString().trim();
  const resolvedCompanyUid = resolveCompanyUid(company_uid, resolvedCrn);
  const logId = "aud_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
  const nowIso = new Date().toISOString();

  const resolvedActor = (actor_id || actor || "corporate_user").toString();
  const resolvedTargetEmail = target_email || (target && target.includes("@") ? target : null);
  const resolvedTargetComp = target_company || (target && !target.includes("@") ? target : null);

  const metaStr = metadata ? (typeof metadata === "object" ? JSON.stringify(metadata) : String(metadata)) : "";
  const resolvedDetails = details || (metaStr ? `Event ${action_type}: ${metaStr}` : `Corporate event ${action_type}`);

  const auditRecord = {
    id: logId,
    company_uid: resolvedCompanyUid,
    action_type: (action_type || "ACTION").toUpperCase(),
    actor_id: resolvedActor,
    actor_name: actor_name || actor || "Authorized Signatory",
    actor_role: actor_role || "Corporate User",
    actor: resolvedActor,
    target_crn: resolvedCrn || null,
    target_email: resolvedTargetEmail,
    target_company: resolvedTargetComp,
    target: target || resolvedTargetEmail || resolvedTargetComp || resolvedCrn || null,
    details: resolvedDetails,
    metadata: metadata || null,
    status: status || "SUCCESS",
    device_info: device_info || user_agent || "Web Portal",
    user_agent: user_agent || device_info || "Web Portal",
    ip_address: ip_address || "127.0.0.1",
    channel: channel || "web",
    created_at: nowIso,
    timestamp: nowIso
  };

  // 1. Save in high-speed in-memory store
  memStore.recordAuditLog(auditRecord);

  // 2. Persist in Supabase / PostgreSQL corporate_audit_logs & mobile_audit_logs
  try {
    await db.ready();
    if (db.isConnected()) {
      await db.logAudit(auditRecord);
    }
  } catch (dbErr) {
    console.warn("[AUDIT SYSTEM] DB log notice:", dbErr.message);
  }

  return auditRecord;
}

/**
 * Fetches the audit trail for a company filtered by company_uid or CRN
 */
async function getAuditTrail({ company_uid, crn, limit = 100 }) {
  const resolvedCompanyUid = resolveCompanyUid(company_uid, crn);
  const cleanCrn = crn ? crn.trim() : null;

  try {
    await db.ready();
    if (db.isConnected()) {
      const logs = await db.getAuditLogs(resolvedCompanyUid, cleanCrn, limit);
      if (logs && logs.length > 0) {
        return logs;
      }
    }
  } catch (e) {
    console.warn("[AUDIT SYSTEM] Query error:", e.message);
  }

  // Fallback to in-memory store
  return memStore.getAuditLogs(resolvedCompanyUid, cleanCrn, limit);
}

module.exports = {
  resolveCompanyUid,
  logAuditEvent,
  getAuditTrail
};
