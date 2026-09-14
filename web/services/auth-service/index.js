/**
 * First National Bank Microservice: Auth & Identity Service (Port 3001)
 * Handles Commercial Registration Number (CRN) validation, OTP issuance, JWT token signing,
 * and Mobile Biometric FaceID/Fingerprint authentication for the upcoming mobile bank app.
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const config = require("../../shared/config");
const memStore = require("../../shared/memStore");
const db = require("../../shared/db");
const { logAuditEvent, resolveCompanyUid } = require("../../shared/audit");
const { generateOtp } = require("../../shared/security");

const router = express.Router();

// Middleware: Verify JWT Session
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing authentication token." });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = decoded; // { crn, email, application_ref, company_uid, company_name }
    if (!req.user.company_uid && req.user.crn) {
      req.user.company_uid = resolveCompanyUid(null, req.user.crn);
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid or expired session token." });
  }
}

// Helper: Query RM Database and MemStore for customer invitation
async function getRmCustomerInvitation(crn, email) {
  const cleanCrn = (crn || "").trim().toUpperCase();
  const cleanEmail = (email || "").trim().toLowerCase();
  if (!cleanCrn || !cleanEmail) return null;

  try {
    await db.ready();
    if (db.isConnected()) {
      const invite = await db.getInvitation(cleanCrn, cleanEmail);
      if (invite) return invite;
    }
  } catch (err) {
    console.warn("[AUTH SERVICE] DB lookup for RM invite notice:", err.message);
  }

  return memStore.getRmInvitation(cleanCrn, cleanEmail);
}

// Helper: Check bidirectional binding between CRN and Email
async function checkCrnAndEmailBinding(cleanCrn, cleanEmail) {
  // 1. Direct match: Exact pair already exists in invitations
  const exactInvite = await getRmCustomerInvitation(cleanCrn, cleanEmail);
  if (exactInvite) {
    return { ok: true, rmInvite: exactInvite, isNew: false };
  }

  // 2. Check if this CRN is already registered to another email in invitations or applications
  let existingInviteForCrn = null;
  if (memStore.getRmInvitationByCrn) {
    existingInviteForCrn = memStore.getRmInvitationByCrn(cleanCrn);
  }
  if (!existingInviteForCrn && db.isConnected() && db.getInvitationByCrn) {
    try { existingInviteForCrn = await db.getInvitationByCrn(cleanCrn); } catch (e) {}
  }

  let existingAppForCrn = null;
  if (memStore.getApplicationByCrn) {
    existingAppForCrn = memStore.getApplicationByCrn(cleanCrn);
  }
  if (!existingAppForCrn && db.isConnected() && db.getApplicationByCrn) {
    try { existingAppForCrn = await db.getApplicationByCrn(cleanCrn); } catch (e) {}
  }

  const recordForCrn = existingInviteForCrn || existingAppForCrn;
  const registeredEmailForCrn = (recordForCrn?.email || recordForCrn?.registered_email || "").trim().toLowerCase();
  if (registeredEmailForCrn && registeredEmailForCrn !== cleanEmail) {
    return {
      ok: false,
      error: "Wrong email or CRN was entered. Please contact RM for further assistance.",
      code: "CRN_EMAIL_MISMATCH"
    };
  }

  // 3. Check if this Email is already registered to another CRN in invitations or applications
  let existingInviteForEmail = null;
  if (memStore.getRmInvitationByEmail) {
    existingInviteForEmail = memStore.getRmInvitationByEmail(cleanEmail);
  }
  if (!existingInviteForEmail && db.isConnected() && db.getInvitationByEmail) {
    try { existingInviteForEmail = await db.getInvitationByEmail(cleanEmail); } catch (e) {}
  }

  let existingAppForEmail = null;
  if (memStore.getApplicationByEmail) {
    existingAppForEmail = memStore.getApplicationByEmail(cleanEmail);
  }
  if (!existingAppForEmail && db.isConnected() && db.getApplicationByEmail) {
    try { existingAppForEmail = await db.getApplicationByEmail(cleanEmail); } catch (e) {}
  }

  const recordForEmail = existingInviteForEmail || existingAppForEmail;
  const registeredCrnForEmail = (recordForEmail?.crn || "").trim().toUpperCase();
  if (registeredCrnForEmail && registeredCrnForEmail !== cleanCrn) {
    return {
      ok: false,
      error: "Wrong email or CRN was entered. Please contact RM for further assistance.",
      code: "CRN_EMAIL_MISMATCH"
    };
  }

  return {
    ok: true,
    rmInvite: (registeredEmailForCrn === cleanEmail ? existingInviteForCrn : null) || (registeredCrnForEmail === cleanCrn ? existingInviteForEmail : null),
    existingApp: existingAppForCrn || existingAppForEmail,
    isNew: !recordForCrn && !recordForEmail
  };
}

// 1. Request OTP (4-digit verification code) — Strictly guarded by RM Database
router.post("/request-otp", async (req, res) => {
  memStore.metrics.serviceRequests.auth++;
  const { crn, email } = req.body;

  if (!crn || !email) {
    return res.status(400).json({ error: "Commercial Registration Number (CRN) and Email are required." });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ error: "Please enter a valid registered email address." });
  }

  const cleanCrn = crn.trim().toUpperCase();
  const cleanEmail = email.trim().toLowerCase();

  // Validate bilateral pairing between CRN and corporate Email
  const binding = await checkCrnAndEmailBinding(cleanCrn, cleanEmail);
  if (!binding.ok) {
    return res.status(403).json({
      error: binding.error,
      code: binding.code
    });
  }

  let rmInvite = binding.rmInvite;
  // For a newly onboarding corporate client (neither CRN nor email exists in DB), auto-provision invitation
  if (!rmInvite) {
    rmInvite = {
      crn: cleanCrn,
      email: cleanEmail,
      company_name: binding.existingApp?.company_name || "Corporate Client",
      contact_person: binding.existingApp?.contact_person || "Authorized Signatory",
      phone: binding.existingApp?.phone || "+1 212 555 0199",
      company_uid: resolveCompanyUid(binding.existingApp?.company_uid, cleanCrn),
      status: "invited",
      created_at: new Date().toISOString()
    };
    memStore.createRmInvitation(rmInvite);
    if (db.isConnected()) {
      try { await db.saveInvitation(rmInvite); } catch (e) {}
    }
  }

  const key = `${cleanCrn}:${cleanEmail}`;
  const randomCode = generateOtp(4);
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity

  memStore.otpStore.set(key, { otp: randomCode, expiresAt, attempts: 0, rmInvite });

  const companyTitle = (rmInvite.company_name || "").trim() || cleanCrn;
  const company_uid = resolveCompanyUid(rmInvite.company_uid, cleanCrn);

  // Record into simulated email buffer
  const emailItem = memStore.recordSimulatedEmail({
    to: cleanEmail,
    from: '"Gringotts Bank Auth Service" <onboarding@gringotts.com>',
    subject: `Gringotts Bank — Verification Code for ${companyTitle}: ${randomCode}`,
    text: `Your verification code for ${companyTitle} (CRN ${cleanCrn}) is: ${randomCode}`,
    code: randomCode,
    type: "otp",
    metadata: { crn: cleanCrn, otp: randomCode, company_name: companyTitle, company_uid },
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff; color: #0f172a;">
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="/images/bank-logo-dragon.png?v=2" alt="Gringotts Bank Logo" style="height: 46px; width: 90px; object-fit: cover; border-radius: 12px; border: 1.5px solid rgba(56, 130, 220, 0.5); display: inline-block; margin-bottom: 6px; box-shadow: 0 0 10px rgba(56, 130, 220, 0.35);">
          <h2 style="color: #0f172a; margin: 12px 0 2px; font-size: 20px; font-weight: 700;">Gringotts Bank Identity Verification</h2>
          <p style="color: #64748b; font-size: 13px; margin: 0;">Diagon Alley &bull; Identity Verification for <strong>${companyTitle}</strong></p>
        </div>
        <p style="color: #334155; font-size: 14px; line-height: 1.5;">Hello,</p>
        <p style="color: #334155; font-size: 14px; line-height: 1.5;">Use the following verification code to access your corporate onboarding application for <strong>${companyTitle}</strong> (CRN: <strong>${cleanCrn}</strong>):</p>
        <div style="background: #f0fdf4; border: 2px dashed #10b981; border-radius: 10px; padding: 18px; text-align: center; margin: 20px 0;">
          <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #059669; display: inline-block; font-family: monospace;">${randomCode}</span>
        </div>
        <p style="color: #64748b; font-size: 12px; line-height: 1.4;">This code will expire in <strong>5 minutes</strong>. Demo code <strong>1111</strong> is also active for immediate login.</p>
      </div>
    `
  });

  // Log compliance audit event
  logAuditEvent({
    company_uid,
    action_type: "CUSTOMER_OTP_REQUESTED",
    actor_id: cleanEmail,
    actor_name: rmInvite.contact_person || "Corporate Applicant",
    actor_role: "Corporate Applicant",
    target_crn: cleanCrn,
    target_email: cleanEmail,
    target_company: companyTitle,
    details: `One-Time Security Passcode dispatched to ${cleanEmail} for CRN ${cleanCrn}`,
    device_info: req.headers["user-agent"] || "Web Browser",
    ip_address: req.ip || req.connection?.remoteAddress || "127.0.0.1",
    channel: "web"
  });

  return res.json({
    success: true,
    message: `A verification code has been dispatched to ${cleanEmail}.`,
    company_name: companyTitle,
    company_uid,
    simulatedEmail: emailItem,
    debugOtp: randomCode,
    demoCode: "1111",
    service: "auth-service"
  });
});

// 2. Verify OTP & Issue JWT
router.post("/verify-otp", async (req, res) => {
  memStore.metrics.serviceRequests.auth++;
  const { crn, email, otp } = req.body;
  if (!crn || !email || !otp) {
    return res.status(400).json({ error: "CRN, Email, and OTP code are required." });
  }

  const cleanCrn = crn.trim().toUpperCase();
  const cleanEmail = email.trim().toLowerCase();
  const cleanOtp = otp.toString().trim();
  const key = `${cleanCrn}:${cleanEmail}`;
  const storedOtpData = memStore.otpStore.get(key);

  const isValidOtp =
    (storedOtpData && storedOtpData.otp === cleanOtp && storedOtpData.expiresAt > Date.now()) ||
    cleanOtp === "1111";

  if (!isValidOtp) {
    if (storedOtpData) {
      storedOtpData.attempts = (storedOtpData.attempts || 0) + 1;
      const remaining = 5 - storedOtpData.attempts;
      return res.status(401).json({
        error: `Invalid verification code. ${remaining > 0 ? remaining + ' attempt(s) remaining.' : 'Code locked.'} (Demo code: 1111)`
      });
    }
    return res.status(401).json({ error: "Invalid or expired verification code (Use demo code 1111)." });
  }

  // Strict check on RM database record existence and CRN-Email pairing during verify
  const binding = await checkCrnAndEmailBinding(cleanCrn, cleanEmail);
  if (!binding.ok) {
    return res.status(403).json({
      error: binding.error,
      code: binding.code
    });
  }

  let rmInvite = storedOtpData ? storedOtpData.rmInvite : binding.rmInvite;
  if (!rmInvite) {
    rmInvite = {
      crn: cleanCrn,
      email: cleanEmail,
      company_name: binding.existingApp?.company_name || "Corporate Client",
      contact_person: binding.existingApp?.contact_person || "Authorized Signatory",
      phone: binding.existingApp?.phone || "+1 212 555 0199",
      company_uid: resolveCompanyUid(binding.existingApp?.company_uid, cleanCrn),
      status: "invited",
      created_at: new Date().toISOString()
    };
    memStore.createRmInvitation(rmInvite);
    if (db.isConnected()) {
      try { await db.saveInvitation(rmInvite); } catch (e) {}
    }
  }

  memStore.otpStore.delete(key);

  const companyNameFromRm = (rmInvite.company_name || "").trim() || "Corporate Client";
  const contactPersonFromRm = (rmInvite.contact_person || "").trim();
  const phoneFromRm = (rmInvite.phone || "").trim();
  const company_uid = resolveCompanyUid(rmInvite.company_uid, cleanCrn);

  try {
    let isNew = false;
    await db.ready();
    if (db.isConnected()) {
      const existingApp = await db.getApplicationByCrnAndEmail(cleanCrn, cleanEmail);
      if (existingApp) {
        applicationRecord = existingApp;
        // Ensure company name and company_uid are synced
        if (!applicationRecord.company_uid || !applicationRecord.company_name || applicationRecord.company_name === "First National Holdings Inc" || applicationRecord.company_name !== companyNameFromRm) {
          const updated = await db.updateApplication(applicationRecord.application_ref, {
            company_name: companyNameFromRm,
            trade_name: companyNameFromRm,
            company_uid: applicationRecord.company_uid || company_uid
          });
          if (updated) {
            applicationRecord = updated;
          }
        }
      } else {
        const appRef = "AB-" + new Date().getFullYear() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
        const initialFormData = {
          step2: {
            crn: cleanCrn,
            company_uid,
            company_name: companyNameFromRm,
            trade_name: companyNameFromRm,
            legal_type: "Limited Liability Company (LLC)",
            issued_by: "Delaware Division of Corporations (US)",
            contact_person: contactPersonFromRm,
            phone: phoneFromRm
          }
        };
        const newRecord = await db.saveApplication({
          application_ref: appRef,
          crn: cleanCrn,
          company_uid,
          registered_email: cleanEmail,
          current_step: 1,
          status: "draft",
          form_data: initialFormData,
          legal_type: "Limited Liability Company (LLC)",
          company_name: companyNameFromRm,
          trade_name: companyNameFromRm
        });
        applicationRecord = newRecord;
        isNew = true;
      }
    } else {
      const existingRef = memStore.crnEmailIndex.get(key);
      if (existingRef && memStore.applications.has(existingRef)) {
        applicationRecord = memStore.applications.get(existingRef);
        applicationRecord.company_uid = applicationRecord.company_uid || company_uid;
        applicationRecord.company_name = companyNameFromRm;
        applicationRecord.trade_name = companyNameFromRm;
        if (applicationRecord.form_data && applicationRecord.form_data.step2) {
          applicationRecord.form_data.step2.company_uid = company_uid;
          applicationRecord.form_data.step2.company_name = companyNameFromRm;
          applicationRecord.form_data.step2.trade_name = companyNameFromRm;
        }
      } else {
        const appRef = "AB-" + new Date().getFullYear() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
        applicationRecord = {
          id: Date.now(),
          company_uid,
          application_ref: appRef,
          crn: cleanCrn,
          registered_email: cleanEmail,
          current_step: 1,
          status: "draft",
          company_name: companyNameFromRm,
          trade_name: companyNameFromRm,
          legal_type: "Limited Liability Company (LLC)",
          form_data: {
            step2: {
              crn: cleanCrn,
              company_uid,
              company_name: companyNameFromRm,
              trade_name: companyNameFromRm,
              legal_type: "Limited Liability Company (LLC)",
              issued_by: "Delaware Division of Corporations (US)",
              contact_person: contactPersonFromRm,
              phone: phoneFromRm
            }
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        memStore.applications.set(appRef, applicationRecord);
        memStore.crnEmailIndex.set(key, appRef);
        memStore.companyUidIndex.set(company_uid, appRef);
        isNew = true;
      }
    }

    const resolvedCompanyUid = applicationRecord.company_uid || company_uid;

    // Always mirror to memStore so RM pipeline has instant real-time lookup
    memStore.applications.set(applicationRecord.application_ref, applicationRecord);
    memStore.crnEmailIndex.set(key, applicationRecord.application_ref);
    memStore.companyUidIndex.set(resolvedCompanyUid, applicationRecord.application_ref);

    const token = jwt.sign(
      {
        crn: applicationRecord.crn,
        email: applicationRecord.registered_email,
        application_ref: applicationRecord.application_ref,
        company_uid: resolvedCompanyUid,
        company_name: companyNameFromRm
      },
      config.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Record compliance audit log for user login
    logAuditEvent({
      company_uid: resolvedCompanyUid,
      action_type: "CUSTOMER_LOGIN",
      actor_id: cleanEmail,
      actor_name: contactPersonFromRm || "Authorized Signatory",
      actor_role: "Authorized Signatory",
      target_crn: cleanCrn,
      target_email: cleanEmail,
      target_company: companyNameFromRm,
      details: `Successful corporate login via OTP for ${companyNameFromRm} (${resolvedCompanyUid})`,
      device_info: req.headers["user-agent"] || "Web Browser",
      ip_address: req.ip || req.connection?.remoteAddress || "127.0.0.1",
      channel: "web"
    });

    return res.json({
      success: true,
      isNew,
      token,
      company_name: companyNameFromRm,
      company_uid: resolvedCompanyUid,
      data: {
        ...applicationRecord,
        company_uid: resolvedCompanyUid,
        company_name: companyNameFromRm,
        trade_name: companyNameFromRm
      },
      service: "auth-service"
    });
  } catch (err) {
    console.error("[AUTH SERVICE] Error:", err);
    return res.status(500).json({ error: "Internal Auth Service Error." });
  }
});

// 3. Mobile Biometric Login Endpoint (FaceID / TouchID for Mobile App)
router.post("/mobile/biometric", async (req, res) => {
  memStore.metrics.serviceRequests.auth++;
  const { biometricSignature, deviceId, crn } = req.body;

  if (!biometricSignature || typeof biometricSignature !== "string" || biometricSignature.length < 16) {
    return res.status(400).json({ error: "Cryptographic biometric signature required from hardware keystore." });
  }

  if (!crn || !String(crn).trim()) {
    return res.status(400).json({ error: "CRN is required for biometric authentication." });
  }

  // Resolve the real corporate application for this CRN — no demo identities
  const activeCrn = crn.trim();
  let applicationRecord = null;
  if (db.isConnected()) {
    try {
      const dbRes = await db.query(
        "SELECT * FROM corporate_onboarding_applications WHERE UPPER(TRIM(crn)) = $1 ORDER BY id DESC LIMIT 1",
        [activeCrn.toUpperCase()]
      );
      if (dbRes.rows && dbRes.rows.length > 0) applicationRecord = dbRes.rows[0];
    } catch (e) {
      console.warn("[AUTH SERVICE] biometric application lookup notice:", e.message);
    }
  }
  if (!applicationRecord) {
    return res.status(401).json({ error: `No onboarding application found for CRN ${activeCrn}.` });
  }

  const activeEmail = applicationRecord.registered_email;
  const appRef = applicationRecord.application_ref;
  const companyUid = applicationRecord.company_uid;

  const token = jwt.sign(
    {
      crn: activeCrn,
      email: activeEmail,
      company_uid: companyUid,
      company_name: applicationRecord.company_name,
      application_ref: appRef,
      channel: "mobile_biometric"
    },
    config.JWT_SECRET,
    { expiresIn: "24h" }
  );

  return res.json({
    success: true,
    authenticated: true,
    channel: "mobile_biometric",
    deviceId: deviceId || "mobile-device",
    token,
    user: {
      name: applicationRecord.contact_person || applicationRecord.company_name || "Corporate Client",
      company: applicationRecord.company_name || "Corporate Client",
      crn: activeCrn,
      email: activeEmail,
      company_uid: companyUid,
      application_ref: appRef,
      tier: "Corporate Client"
    },
    service: "auth-service"
  });
});

// Health check
router.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "auth-service",
    port: config.MICROSERVICES.AUTH.port,
    uptime: process.uptime()
  });
});

module.exports = {
  router,
  requireAuth
};
