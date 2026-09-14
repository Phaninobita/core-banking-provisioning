/**
 * First National Bank Relationship Manager (RM) Service
 * Microservice handling RM executive authentication, customer invitation dispatch,
 * magic link generation with composite key (CRN, Email), and real-time pipeline telemetry.
 */

const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../../shared/config");
const memStore = require("../../shared/memStore");
const db = require("../../shared/db");
const { resolveCompanyUid, logAuditEvent, getAuditTrail } = require("../../shared/audit");
const { hashPassword, verifyPassword, escapeHtml } = require("../../shared/security");

const router = express.Router();

// Middleware: Require Authenticated RM Executive Session
function requireRmAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: RM Executive authentication session required." });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    if (!decoded.is_rm && decoded.role !== "RM" && !decoded.rm_id) {
      return res.status(403).json({ error: "Forbidden: RM Executive privileges required." });
    }
    req.rmUser = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid or expired RM session token." });
  }
}

// Telemetry tracker
router.use((req, res, next) => {
  if (memStore.metrics && memStore.metrics.serviceRequests) {
    memStore.metrics.serviceRequests.rm = (memStore.metrics.serviceRequests.rm || 0) + 1;
  }
  next();
});

/**
 * POST /api/v1/rm/login
 * RM Executive Authentication against rm_users table / memStore
 */
router.post("/login", async (req, res) => {
  const { staffId, password } = req.body;
  if (!staffId || !password) {
    return res.status(400).json({ error: "Staff ID / Username and Security Passkey are required." });
  }

  const cleanUser = staffId.trim().toLowerCase();
  let userRecord = null;

  // 1. Check PostgreSQL rm_users table if connected
  if (db.isConnected()) {
    try {
      const dbRes = await db.query(
        "SELECT * FROM rm_users WHERE LOWER(TRIM(username)) = $1 OR LOWER(TRIM(email)) = $1 LIMIT 1",
        [cleanUser]
      );
      if (dbRes.rows && dbRes.rows.length > 0) {
        userRecord = dbRes.rows[0];
      }
    } catch (e) {
      console.warn("[RM-SERVICE] DB user lookup notice:", e.message);
    }
  }

  // 2. Fallback to in-memory store
  if (!userRecord) {
    userRecord = memStore.getRmUser(cleanUser);
  }

  if (!userRecord || userRecord.status !== "active") {
    return res.status(401).json({
      error: `Authentication failed: Username "${staffId.trim()}" not found. Please verify your credentials or contact administrator.`,
      code: "INVALID_RM_USER"
    });
  }

  // 3. Password check using constant-time cryptographic verification
  const inputPassword = (password || "").trim();
  const storedPasswordHash = (userRecord.password_hash || userRecord.password || "").trim();

  const isMatch = verifyPassword(inputPassword, storedPasswordHash);

  if (!isMatch) {
    return res.status(401).json({
      error: "Authentication failed: Incorrect Executive Security Passkey. Please try again.",
      code: "INVALID_RM_PASSWORD"
    });
  }

  // Upgrade legacy plaintext password to secure scrypt hash
  if (storedPasswordHash && !storedPasswordHash.includes(":")) {
    const upgradedHash = hashPassword(inputPassword);
    userRecord.password_hash = upgradedHash;
    if (db.isConnected()) {
      db.query("UPDATE rm_users SET password_hash = $1 WHERE LOWER(TRIM(username)) = $2", [upgradedHash, cleanUser]).catch(() => {});
    }
  }

  const sessionToken = jwt.sign(
    {
      rm_id: "RM-" + userRecord.username.toUpperCase(),
      username: userRecord.username,
      name: userRecord.full_name || "Phanee",
      role: userRecord.role || "Senior Relationship Manager · Corporate Banking",
      email: userRecord.email,
      is_rm: true
    },
    config.JWT_SECRET,
    { expiresIn: "8h" }
  );

  const rmProfile = {
    rm_id: "RM-" + userRecord.username.toUpperCase(),
    username: userRecord.username,
    name: userRecord.full_name || "Phanee",
    role: userRecord.role || "Senior Relationship Manager · Corporate Banking",
    department: "Institutional Clients Group",
    branch: userRecord.branch || "New York Financial Center",
    email: userRecord.email
  };

  return res.json({
    success: true,
    message: "RM Executive Authentication successful.",
    token: sessionToken,
    profile: rmProfile
  });
});

/**
 * POST /api/v1/rm/users
 * Provision additional Relationship Managers or staff members into rm_users table (Requires RM Auth)
 */
router.post("/users", requireRmAuth, async (req, res) => {
  try {
    const { username, password, fullName, email, role, branch } = req.body;
    if (!username || !password || !fullName || !email) {
      return res.status(400).json({ error: "Username, password, fullName, and email are required." });
    }

    const cleanUser = username.trim().toLowerCase();
    const cleanEmail = email.trim().toLowerCase();
    const cleanRole = role ? role.trim() : "Senior Relationship Manager · Corporate Banking";
    const cleanBranch = branch ? branch.trim() : "New York Financial Center";
    const securePasswordHash = hashPassword(password.trim());

    let created = null;
    if (db.isConnected()) {
      try {
        const insertRes = await db.query(`
          INSERT INTO rm_users (username, password_hash, full_name, email, role, branch, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'active')
          ON CONFLICT (username) DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            full_name = EXCLUDED.full_name,
            email = EXCLUDED.email,
            role = EXCLUDED.role,
            branch = EXCLUDED.branch
          RETURNING *
        `, [cleanUser, securePasswordHash, fullName.trim(), cleanEmail, cleanRole, cleanBranch]);
        if (insertRes.rows && insertRes.rows.length > 0) {
          created = insertRes.rows[0];
        }
      } catch (dbErr) {
        console.warn("[RM-SERVICE] DB insert user warning:", dbErr.message);
      }
    }

    const memRecord = memStore.saveRmUser({
      username: cleanUser,
      password_hash: securePasswordHash,
      full_name: fullName.trim(),
      email: cleanEmail,
      role: cleanRole,
      branch: cleanBranch
    });

    return res.status(201).json({
      success: true,
      message: `User ${cleanUser} registered successfully in rm_users table.`,
      user: created || memRecord
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to create RM user." });
  }
});

/**
 * GET /api/v1/rm/invitations
 * Retrieve all customer invitations & cross-reference onboarding progress (Requires RM Auth)
 */
router.get("/invitations", requireRmAuth, async (req, res) => {
  try {
    let invitations = [];
    await db.ready();

    if (db.isConnected()) {
      try {
        invitations = await db.listInvitations();
      } catch (dbErr) {
        console.warn("[RM-SERVICE] DB Query error, using memory fallback:", dbErr.message);
        invitations = memStore.listRmInvitations();
      }
    } else {
      invitations = memStore.listRmInvitations();
    }

    // Query latest applications from DB and in-memory store for real-time step tracking
    let allApps = [];
    if (db.isConnected()) {
      try {
        allApps = await db.listApplications();
      } catch (appErr) {
        console.warn("[RM-SERVICE] Notice querying DB applications:", appErr.message);
      }
    }

    const appByCrnEmail = new Map();
    const appByUid = new Map();

    for (const app of allApps) {
      if (app.crn && app.registered_email) {
        const key = `${app.crn.trim().toUpperCase()}:${app.registered_email.trim().toLowerCase()}`;
        appByCrnEmail.set(key, app);
      }
      if (app.company_uid) {
        appByUid.set(app.company_uid.trim().toUpperCase(), app);
      }
    }

    // Merge in-memory applications
    for (const [ref, app] of memStore.applications.entries()) {
      const crn = app.crn || "";
      const email = app.registered_email || "";
      if (crn && email) {
        const key = `${crn.trim().toUpperCase()}:${email.trim().toLowerCase()}`;
        appByCrnEmail.set(key, app);
      }
      if (app.company_uid) {
        appByUid.set(app.company_uid.trim().toUpperCase(), app);
      }
    }

    // Cross-reference with application records for real-time progress
    invitations = invitations.map(inv => {
      const crnKey = `${(inv.crn || "").trim().toUpperCase()}:${(inv.email || "").trim().toLowerCase()}`;
      const uidKey = (inv.company_uid || "").trim().toUpperCase();
      const app = appByCrnEmail.get(crnKey) || (uidKey ? appByUid.get(uidKey) : null);

      const companyUid = inv.company_uid || (app ? app.company_uid : null) || resolveCompanyUid({ crn: inv.crn, company_uid: inv.company_uid });

      // Determine true latest step: if application has advanced, use the highest step
      const appStep = (app && typeof app.current_step === "number") ? app.current_step : 0;
      const invStep = (typeof inv.current_step === "number") ? inv.current_step : 0;
      const effectiveStep = Math.max(appStep, invStep, 1);

      // Determine real-time journey status
      let effectiveStatus = inv.status || "invited";
      if (app) {
        if (app.status === "approved" || app.status === "completed") {
          effectiveStatus = "completed";
        } else if (app.status === "submitted" || app.status === "review") {
          effectiveStatus = "review";
        } else if (effectiveStep > 1 || app.status === "in_progress") {
          effectiveStatus = "in_progress";
        }
      } else if (effectiveStep > 1) {
        effectiveStatus = "in_progress";
      }

      return {
        ...inv,
        company_uid: companyUid,
        current_step: effectiveStep,
        application_ref: inv.application_ref || (app ? app.application_ref : null),
        status: effectiveStatus
      };
    });


    // Enrich with core provisioning state so the journey shows the canonical
    // "Account Activated" stage once the customer exists in core banking.
    try {
      const supabaseClient = require("../../shared/supabaseClient");
      const cifs = await supabaseClient.listCifs();
      const provisionedUids = new Set(cifs.map(c => String(c.company_uid || "").toUpperCase()));
      invitations = invitations.map(inv => {
        const uid = String(inv.company_uid || "").toUpperCase();
        const coreProvisioned = provisionedUids.has(uid);
        const s = inv.status;
        const journey_status = coreProvisioned || ["completed", "approved", "account_activated"].includes(s)
          ? "account_activated"
          : (["invited", "link_initiated"].includes(s) ? "link_initiated" : "in_progress_under_review");
        return { ...inv, core_provisioned: coreProvisioned, journey_status };
      });
    } catch (coreErr) {
      console.warn("[RM-SERVICE] Core enrichment notice:", coreErr.message);
    }

    return res.json({
      success: true,
      count: invitations.length,
      invitations
    });
  } catch (err) {
    console.error("[RM-SERVICE] Failed to fetch invitations:", err);
    return res.status(500).json({ error: "Failed to retrieve RM customer invitations." });
  }
});

/**
 * GET /api/v1/rm/check-crn/:crn
 * Validate whether a CRN is available or already registered/invited (Requires RM Auth)
 */
router.get("/check-crn/:crn", requireRmAuth, async (req, res) => {
  try {
    const rawCrn = req.params.crn || "";
    const cleanCrn = decodeURIComponent(rawCrn).trim().toUpperCase();
    if (!cleanCrn) {
      return res.json({ exists: false, crn: "" });
    }

    await db.ready();
    let existing = memStore.getRmInvitationByCrn ? memStore.getRmInvitationByCrn(cleanCrn) : null;

    if (!existing && db.isConnected()) {
      try {
        existing = await db.getInvitationByCrn(cleanCrn);
      } catch (e) {}
      if (!existing) {
        try {
          const allInvs = await db.listInvitations();
          existing = allInvs.find(i => i.crn && i.crn.trim().toUpperCase() === cleanCrn) || null;
        } catch (e) {}
      }
    }

    if (!existing) {
      if (memStore.getApplicationByCrn) {
        existing = memStore.getApplicationByCrn(cleanCrn);
      }
      if (!existing && db.isConnected()) {
        try {
          existing = await db.getApplicationByCrn(cleanCrn);
        } catch (e) {}
        if (!existing) {
          try {
            const allApps = await db.listApplications();
            existing = allApps.find(a => a.crn && a.crn.trim().toUpperCase() === cleanCrn) || null;
          } catch (e) {}
        }
      }
    }

    if (existing) {
      return res.json({
        exists: true,
        crn: cleanCrn,
        existing: {
          crn: cleanCrn,
          company_name: existing.company_name || existing.companyName || "",
          email: existing.email || existing.registered_email || "",
          company_uid: existing.company_uid || "",
          status: existing.status || "invited",
          current_step: existing.current_step || 1
        }
      });
    }

    return res.json({ exists: false, crn: cleanCrn });
  } catch (err) {
    return res.status(500).json({ error: "Failed to check CRN availability." });
  }
});

/**
 * POST /api/v1/rm/invite
 * Create and dispatch a new customer onboarding invitation link (Requires RM Auth)
 * Composite Primary Key: (crn, email), Canonical Corporate Key: company_uid
 */
router.post("/invite", requireRmAuth, async (req, res) => {
  try {
    const { crn, email, companyName, tradeName, trade_name, contactPerson, phone, notes, company_uid } = req.body;

    if (!crn || !crn.trim()) {
      return res.status(400).json({ error: "Commercial Registration Number (CRN) is required." });
    }
    if (!email || !email.trim() || !email.includes("@")) {
      return res.status(400).json({ error: "A valid corporate customer email is required." });
    }
    if (!companyName || !companyName.trim()) {
      return res.status(400).json({ error: "Company Legal Name is required." });
    }

    const cleanCrn = crn.trim().toUpperCase();
    const cleanEmail = email.trim().toLowerCase();
    const cleanTrade = (tradeName || trade_name || "").trim();

    // ── Enforce Duplicate CRN Validation ──
    await db.ready();
    let existingInvite = memStore.getRmInvitationByCrn ? memStore.getRmInvitationByCrn(cleanCrn) : null;
    if (!existingInvite && db.isConnected()) {
      try {
        existingInvite = await db.getInvitationByCrn(cleanCrn);
      } catch (dbErr) {
        console.warn("[RM-SERVICE] Notice checking duplicate CRN in DB invitations:", dbErr.message);
      }
      if (!existingInvite) {
        try {
          const allInvs = await db.listInvitations();
          existingInvite = allInvs.find(i => i.crn && i.crn.trim().toUpperCase() === cleanCrn) || null;
        } catch (e) {}
      }
    }

    let existingApp = null;
    if (memStore.getApplicationByCrn) {
      existingApp = memStore.getApplicationByCrn(cleanCrn);
    }
    if (!existingApp && db.isConnected()) {
      try {
        existingApp = await db.getApplicationByCrn(cleanCrn);
      } catch (dbErr) {
        console.warn("[RM-SERVICE] Notice checking duplicate CRN in DB applications:", dbErr.message);
      }
      if (!existingApp) {
        try {
          const allApps = await db.listApplications();
          existingApp = allApps.find(a => a.crn && a.crn.trim().toUpperCase() === cleanCrn) || null;
        } catch (e) {}
      }
    }

    const existingRecord = existingInvite || existingApp;
    if (existingRecord) {
      const existingCompany = (existingRecord.company_name || existingRecord.companyName || companyName || "Existing Corporate Entity").trim();
      const existingEmail = (existingRecord.email || existingRecord.registered_email || "").trim();
      const existingUid = existingRecord.company_uid || "";
      const existingStatus = existingRecord.status || "invited";
      const existingStep = existingRecord.current_step || 1;

      console.warn(`[RM-SERVICE] ⚠️ Invitation dispatch rejected: CRN "${cleanCrn}" already exists for "${existingCompany}" (${existingEmail}).`);

      return res.status(409).json({
        success: false,
        error: `Duplicate CR Number: An onboarding invitation or application already exists for CRN "${cleanCrn}" (${existingCompany}${existingEmail ? " · " + existingEmail : ""}). Please use "Update Details" or "Resend" in the pipeline table below.`,
        code: "DUPLICATE_CRN",
        existing: {
          crn: cleanCrn,
          company_name: existingCompany,
          email: existingEmail,
          company_uid: existingUid,
          status: existingStatus,
          current_step: existingStep
        }
      });
    }

    // Enforce 1:1 Corporate UID resolution: lookup from DB or memStore, else generate canonical CUID
    let companyUid = "";
    if (db.isConnected()) {
      try {
        const invCorp = await db.query(
          "SELECT company_uid FROM rm_customer_invitations WHERE crn = $1 AND company_uid IS NOT NULL AND company_uid != '' LIMIT 1",
          [cleanCrn]
        );
        if (invCorp.rows && invCorp.rows.length > 0) {
          companyUid = invCorp.rows[0].company_uid;
        } else {
          const appCorp = await db.query(
            "SELECT company_uid FROM corporate_onboarding_applications WHERE crn = $1 AND company_uid IS NOT NULL AND company_uid != '' LIMIT 1",
            [cleanCrn]
          );
          if (appCorp.rows && appCorp.rows.length > 0) {
            companyUid = appCorp.rows[0].company_uid;
          }
        }
      } catch (dbErr) {
        console.warn("[RM-SERVICE] Error querying existing corporate UID:", dbErr.message);
      }
    }

    if (!companyUid) {
      companyUid = memStore.getCompanyUidForCrn ? memStore.getCompanyUidForCrn(cleanCrn) : "";
    }
    if (!companyUid) {
      companyUid = resolveCompanyUid({ crn: cleanCrn });
    }
    if (memStore.setCompanyUidForCrn) {
      memStore.setCompanyUidForCrn(cleanCrn, companyUid);
    }

    const inviteToken = "inv_" + crypto.randomBytes(12).toString("hex");

    // Construct clean and secure customer portal onboarding URL (Zero PII parameters exposed in URL)
    const host = req.get("host") || "localhost:3000";
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const inviteLink = `${protocol}://${host}/`;

    const inviteRecord = {
      crn: cleanCrn,
      email: cleanEmail,
      company_uid: companyUid,
      company_name: companyName.trim(),
      trade_name: cleanTrade,
      contact_person: (contactPerson || "Authorized Signatory").trim(),
      phone: (phone || "").trim(),
      rm_name: req.body.rmName || "Phanee (Senior Relationship Manager)",
      rm_id: req.body.rmId || "RM-PHANEE",
      invite_token: inviteToken,
      status: "invited",
      invite_link: inviteLink,
      notes: (notes || "").trim(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Save to Supabase Cloud Database table rm_customer_invitations (Composite Key: crn, email)
    await db.ready();
    if (db.isConnected()) {
      try {
        await db.saveInvitation(inviteRecord);
      } catch (dbErr) {
        console.warn("[RM-SERVICE] DB Insert warning, saving in memory store:", dbErr.message);
      }
    }

    // Always mirror in high-speed in-memory repository
    memStore.saveRmInvitation(inviteRecord);

    // Record Audit Trail Event
    await logAuditEvent({
      company_uid: companyUid,
      crn: cleanCrn,
      channel: "web",
      action_type: "INVITATION_DISPATCHED",
      actor: inviteRecord.rm_name,
      target: cleanEmail,
      status: "SUCCESS",
      ip_address: req.ip || req.headers["x-forwarded-for"] || "127.0.0.1",
      user_agent: req.headers["user-agent"] || "RM-Portal",
      metadata: {
        rm_id: inviteRecord.rm_id,
        company_name: inviteRecord.company_name,
        invite_token: inviteToken,
        phone: inviteRecord.phone
      }
    });

    // Dispatch simulated VIP corporate invitation email
    const emailSubject = `Invitation to Onboard: Gringotts Bank Corporate Vault & Banking Package for ${inviteRecord.company_name}`;
    memStore.recordSimulatedEmail({
      to: cleanEmail,
      from: '"Bogrod & Griphook — Gringotts Bank Diagon Alley" <vaults@gringotts.co.uk>',
      subject: emailSubject,
      type: "rm_invitation",
      metadata: { crn: cleanCrn, email: cleanEmail, inviteLink },
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 620px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
          <div style="background: linear-gradient(135deg, #090e17 0%, #1e293b 100%); padding: 32px 28px; text-align: center; border-bottom: 2px solid #f59e0b;">
              <img src="/images/bank-logo-dragon.png?v=2" alt="Gringotts Bank Logo" style="height: 46px; width: 90px; object-fit: cover; border-radius: 12px; border: 1.5px solid rgba(56, 130, 220, 0.5); display: inline-block; margin-bottom: 12px; box-shadow: 0 0 12px rgba(56, 130, 220, 0.4);">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.02em;">Gringotts Bank Institutional &amp; Vault Services</h1>
            <p style="color: #cbd5e1; font-size: 13px; margin: 6px 0 0;">Diagon Alley &bull; In reference with Hogwarts Financial Council</p>
          </div>
          <div style="padding: 32px 28px;">
            <h2 style="color: #0f172a; font-size: 18px; margin-top: 0;">Dear ${inviteRecord.contact_person},</h2>
            <p style="color: #334155; font-size: 14px; line-height: 1.6;">
              On behalf of Gringotts Bank (Diagon Alley), it is our pleasure to invite <strong>${inviteRecord.company_name}</strong> (CRN: ${cleanCrn}) to complete digital onboarding for our multi-currency corporate banking accounts, Galleon reserves, and Hogwarts treasury solutions.
            </p>
            <div style="background: #f8fafc; border: 1.5px dashed #f59e0b; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
              <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #92400e; margin-bottom: 8px;">Your Unique Corporate Access Details</div>
              <div style="font-size: 14px; color: #1e293b; margin-bottom: 4px;"><strong>Commercial Reg. No. (CRN):</strong> <code style="background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${cleanCrn}</code></div>
              <div style="font-size: 14px; color: #1e293b; margin-bottom: 16px;"><strong>Registered Email:</strong> <code style="background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${cleanEmail}</code></div>
              <a href="${inviteLink}" style="display: inline-block; background: #0284c7; color: #ffffff; font-weight: 700; font-size: 14px; text-decoration: none; padding: 12px 28px; border-radius: 8px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3);">
                🚀 Launch Direct Customer Onboarding Portal
              </a>
            </div>
            <p style="color: #64748b; font-size: 12px; line-height: 1.6;">
              Direct Portal URL:<br>
              <a href="${inviteLink}" style="color: #0284c7; word-break: break-all;">${inviteLink}</a>
            </p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;">
            <div style="display: flex; align-items: center; gap: 14px;">
              <div>
                <strong style="color: #0f172a; font-size: 13px;">Bogrod &amp; Griphook</strong><br>
                <span style="font-size: 12px; color: #64748b;">Senior Vault Masters — Diagon Alley Branch &bull; Gringotts Bank</span><br>
                <span style="font-size: 11px; color: #94a3b8;">📞 +44 20 7946 0190 · ✉️ vaults@gringotts.co.uk</span>
              </div>
            </div>
          </div>
        </div>
      `
    });

    return res.status(201).json({
      success: true,
      message: `Invitation successfully dispatched to ${cleanEmail} for CRN ${cleanCrn}.`,
      invitation: inviteRecord,
      inviteLink
    });
  } catch (err) {
    console.error("[RM-SERVICE] Error creating invitation:", err);
    return res.status(500).json({ error: "Failed to create and dispatch customer invitation." });
  }
});

/**
 * POST /api/v1/rm/resend/:crn/:email
 * Re-dispatches the onboarding invitation email (Requires RM Auth)
 */
router.post("/resend/:crn/:email", requireRmAuth, async (req, res) => {
  try {
    const rawCrn = req.params.crn || "";
    const rawEmail = req.params.email || "";
    const cleanCrn = decodeURIComponent(rawCrn).trim().toUpperCase();
    const cleanEmail = decodeURIComponent(rawEmail).trim().toLowerCase();

    await db.ready();
    let invite = memStore.getRmInvitation(cleanCrn, cleanEmail);
    if (!invite && memStore.getRmInvitationByCrn) {
      invite = memStore.getRmInvitationByCrn(cleanCrn);
    }

    if (!invite && db.isConnected()) {
      try {
        invite = await db.getInvitation(cleanCrn, cleanEmail);
        if (!invite && db.getInvitationByCrn) {
          invite = await db.getInvitationByCrn(cleanCrn);
        }
      } catch (dbErr) {
        console.warn("[RM-SERVICE] DB lookup warning in resend:", dbErr.message);
      }
    }

    if (!invite && db.isConnected()) {
      try {
        const all = await db.listInvitations();
        invite = all.find(i => 
          (i.crn && i.crn.trim().toUpperCase() === cleanCrn) ||
          (i.email && i.email.trim().toLowerCase() === cleanEmail)
        );
      } catch (e) {}
    }

    if (!invite) {
      invite = {
        crn: cleanCrn,
        email: cleanEmail,
        company_name: "Corporate Client",
        contact_person: "Authorized Signatory",
        status: "invited"
      };
      memStore.saveRmInvitation(invite);
      if (db.isConnected()) {
        try { await db.saveInvitation(invite); } catch (e) {}
      }
    }

    const host = req.get("host") || "localhost:3000";
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const portalUrl = `${protocol}://${host}/`;
    const companyTitle = (invite.company_name || "").trim() || "Corporate Client";
    const targetEmail = (invite.email || cleanEmail).trim().toLowerCase();

    // Dispatch rich invitation email and trigger real-time Yopmail delivery
    const emailSubject = `Invitation to Onboard: Gringotts Bank Corporate Vault & Banking Package for ${companyTitle}`;
    memStore.recordSimulatedEmail({
      to: targetEmail,
      from: '"Bogrod & Griphook — Gringotts Bank Diagon Alley" <vaults@gringotts.co.uk>',
      subject: emailSubject,
      type: "rm_invitation_reminder",
      metadata: { crn: invite.crn, email: targetEmail, inviteLink: portalUrl },
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 620px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
          <div style="background: linear-gradient(135deg, #090e17 0%, #1e293b 100%); padding: 32px 28px; text-align: center; border-bottom: 2px solid #f59e0b;">
              <img src="/images/bank-logo-dragon.png?v=2" alt="Gringotts Bank Logo" style="height: 46px; width: 90px; object-fit: cover; border-radius: 12px; border: 1.5px solid rgba(56, 130, 220, 0.5); display: inline-block; margin-bottom: 12px; box-shadow: 0 0 12px rgba(56, 130, 220, 0.4);">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.02em;">Gringotts Bank Institutional &amp; Vault Services</h1>
            <p style="color: #cbd5e1; font-size: 13px; margin: 6px 0 0;">Diagon Alley &bull; In reference with Hogwarts Financial Council</p>
          </div>
          <div style="padding: 32px 28px;">
            <h2 style="color: #0f172a; font-size: 18px; margin-top: 0;">Dear ${invite.contact_person || 'Authorized Signatory'},</h2>
            <p style="color: #334155; font-size: 14px; line-height: 1.6;">
              On behalf of Gringotts Bank (Diagon Alley), this is a reminder to complete your digital onboarding for <strong>${companyTitle}</strong> (CRN: ${invite.crn}).
            </p>
            <div style="background: #f8fafc; border: 1.5px dashed #f59e0b; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
              <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #92400e; margin-bottom: 8px;">Your Unique Corporate Access Details</div>
              <div style="font-size: 14px; color: #1e293b; margin-bottom: 4px;"><strong>Commercial Reg. No. (CRN):</strong> <code style="background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${invite.crn}</code></div>
              <div style="font-size: 14px; color: #1e293b; margin-bottom: 16px;"><strong>Registered Email:</strong> <code style="background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${targetEmail}</code></div>
              <a href="${portalUrl}" style="display: inline-block; background: #0284c7; color: #ffffff; font-weight: 700; font-size: 14px; text-decoration: none; padding: 12px 28px; border-radius: 8px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3);">
                🚀 Launch Direct Customer Onboarding Portal
              </a>
            </div>
            <p style="color: #64748b; font-size: 12px; line-height: 1.6;">
              Direct Portal URL:<br>
              <a href="${portalUrl}" style="color: #0284c7; word-break: break-all;">${portalUrl}</a>
            </p>
          </div>
        </div>
      `
    });

    console.log(`[RM-SERVICE] Invitation successfully re-dispatched to ${targetEmail} for CRN ${cleanCrn}`);

    return res.json({
      success: true,
      message: `Invitation email successfully re-dispatched to ${targetEmail}.`,
      inviteLink: portalUrl
    });
  } catch (err) {
    console.error("[RM-SERVICE] Error in resend:", err);
    return res.status(500).json({ error: "Failed to resend invitation." });
  }
});

/**
 * POST /api/v1/rm/update-details
 * Updates customer onboarding details (Email, Company, Contact, Phone) and optionally re-dispatches invitation (Requires RM Auth)
 */
router.post("/update-details", requireRmAuth, async (req, res) => {
  try {
    const { originalCrn, originalEmail, newEmail, companyName, contactPerson, phone, resendImmediate } = req.body;

    if (!originalCrn || !originalEmail) {
      return res.status(400).json({ error: "Original CRN and Email are required." });
    }
    if (!newEmail || !newEmail.trim() || !newEmail.includes("@")) {
      return res.status(400).json({ error: "A valid customer email address is required." });
    }

    const cleanCrn = decodeURIComponent(originalCrn).trim().toUpperCase();
    const cleanOldEmail = decodeURIComponent(originalEmail).trim().toLowerCase();
    const cleanNewEmail = decodeURIComponent(newEmail).trim().toLowerCase();

    await db.ready();
    let existing = memStore.getRmInvitation(cleanCrn, cleanOldEmail);
    if (!existing && memStore.getRmInvitationByCrn) {
      existing = memStore.getRmInvitationByCrn(cleanCrn);
    }
    if (!existing && db.isConnected()) {
      try {
        existing = await db.getInvitation(cleanCrn, cleanOldEmail);
        if (!existing && db.getInvitationByCrn) {
          existing = await db.getInvitationByCrn(cleanCrn);
        }
      } catch (dbErr) {
        console.warn("[RM-SERVICE] DB lookup warning in update-details:", dbErr.message);
      }
    }

    const company_uid = existing?.company_uid || resolveCompanyUid({ crn: cleanCrn });
    const host = req.get("host") || "localhost:3000";
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const portalUrl = `${protocol}://${host}/`;

    const updatedRecord = {
      crn: cleanCrn,
      email: cleanNewEmail,
      company_uid,
      company_name: (companyName || existing?.company_name || "Corporate Client").trim(),
      trade_name: existing?.trade_name || (companyName || "").trim(),
      contact_person: (contactPerson || existing?.contact_person || "Authorized Signatory").trim(),
      phone: (phone || existing?.phone || "").trim(),
      rm_name: existing?.rm_name || "Phanee (Senior Relationship Manager)",
      rm_id: existing?.rm_id || "RM-PHANEE",
      invite_token: existing?.invite_token || ("inv_" + crypto.randomBytes(12).toString("hex")),
      status: existing?.status || "invited",
      invite_link: portalUrl,
      notes: existing?.notes || "",
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (db.isConnected()) {
      try {
        if (cleanOldEmail !== cleanNewEmail) {
          await db.deleteInvitation(cleanCrn, cleanOldEmail);
        }
        await db.saveInvitation(updatedRecord);
      } catch (dbErr) {
        console.warn("[RM-SERVICE] DB update invitation warning:", dbErr.message);
      }
    }

    if (cleanOldEmail !== cleanNewEmail) {
      memStore.deleteRmInvitation(cleanCrn, cleanOldEmail);
    }
    memStore.saveRmInvitation(updatedRecord);

    // Update associated application if exists
    try {
      if (db.isConnected()) {
        const app = await db.getApplicationByCrnAndEmail(cleanCrn, cleanOldEmail) || await db.getApplicationByCrn(cleanCrn);
        if (app) {
          await db.updateApplication(app.application_ref, {
            registered_email: cleanNewEmail,
            company_name: updatedRecord.company_name
          });
        }
      }
    } catch (appErr) {
      console.warn("[RM-SERVICE] App update notice:", appErr.message);
    }

    let emailDispatched = false;
    if (resendImmediate !== false) {
      const emailSubject = `Invitation to Onboard: Gringotts Bank Corporate Vault & Banking Package for ${updatedRecord.company_name}`;
      memStore.recordSimulatedEmail({
        to: cleanNewEmail,
        from: '"Bogrod & Griphook — Gringotts Bank Diagon Alley" <vaults@gringotts.co.uk>',
        subject: emailSubject,
        type: "rm_invitation",
        metadata: { crn: cleanCrn, email: cleanNewEmail, inviteLink: portalUrl },
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 620px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
            <div style="background: linear-gradient(135deg, #090e17 0%, #1e293b 100%); padding: 32px 28px; text-align: center; border-bottom: 2px solid #f59e0b;">
              <img src="/images/bank-logo-dragon.png?v=2" alt="Gringotts Bank Logo" style="height: 46px; width: 90px; object-fit: cover; border-radius: 12px; border: 1.5px solid rgba(56, 130, 220, 0.5); display: inline-block; margin-bottom: 12px; box-shadow: 0 0 12px rgba(56, 130, 220, 0.4);">
              <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.02em;">Gringotts Bank Institutional &amp; Vault Services</h1>
              <p style="color: #cbd5e1; font-size: 13px; margin: 6px 0 0;">Diagon Alley &bull; In reference with Hogwarts Financial Council</p>
            </div>
            <div style="padding: 32px 28px;">
              <h2 style="color: #0f172a; font-size: 18px; margin-top: 0;">Dear ${updatedRecord.contact_person},</h2>
              <p style="color: #334155; font-size: 14px; line-height: 1.6;">
                Your corporate onboarding invitation for <strong>${updatedRecord.company_name}</strong> (CRN: ${cleanCrn}) has been updated with this registered email address.
              </p>
              <div style="background: #f8fafc; border: 1.5px dashed #f59e0b; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
                <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #92400e; margin-bottom: 8px;">Your Unique Corporate Access Details</div>
                <div style="font-size: 14px; color: #1e293b; margin-bottom: 4px;"><strong>Commercial Reg. No. (CRN):</strong> <code style="background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${cleanCrn}</code></div>
                <div style="font-size: 14px; color: #1e293b; margin-bottom: 16px;"><strong>Registered Email:</strong> <code style="background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${cleanNewEmail}</code></div>
                <a href="${portalUrl}" style="display: inline-block; background: #0284c7; color: #ffffff; font-weight: 700; font-size: 14px; text-decoration: none; padding: 12px 28px; border-radius: 8px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3);">
                  🚀 Launch Direct Customer Onboarding Portal
                </a>
              </div>
              <p style="color: #64748b; font-size: 12px; line-height: 1.6;">
                Direct Portal URL:<br>
                <a href="${portalUrl}" style="color: #0284c7; word-break: break-all;">${portalUrl}</a>
              </p>
            </div>
          </div>
        `
      });
      emailDispatched = true;
    }

    return res.json({
      success: true,
      message: `Customer details updated successfully.${emailDispatched ? ` Onboarding invitation dispatched to ${cleanNewEmail}.` : ""}`,
      invitation: updatedRecord
    });
  } catch (err) {
    console.error("[RM-SERVICE] Error updating details:", err);
    return res.status(500).json({ error: "Failed to update customer details." });
  }
});

/**
 * DELETE /api/v1/rm/invitations/:crn/:email
 * Revokes customer invitation (Requires RM Auth)
 */
router.delete("/invitations/:crn/:email", requireRmAuth, async (req, res) => {
  try {
    const { crn, email } = req.params;
    const cleanCrn = crn.trim().toUpperCase();
    const cleanEmail = email.trim().toLowerCase();

    await db.ready();
    if (db.isConnected()) {
      try {
        await db.deleteInvitation(cleanCrn, cleanEmail);
      } catch (e) {
        console.warn("[RM-SERVICE] DB Delete error:", e.message);
      }
    }

    memStore.deleteRmInvitation(cleanCrn, cleanEmail);

    return res.json({
      success: true,
      message: `Invitation for CRN ${cleanCrn} (${cleanEmail}) revoked successfully.`
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to revoke invitation." });
  }
});

/**
 * GET /api/v1/rm/verify-invite
 * Validates invite from customer portal when loading ?crn=...&email=...
 */
router.get("/verify-invite", async (req, res) => {
  try {
    const { crn, email } = req.query;
    if (!crn || !email) {
      return res.status(400).json({ valid: false, error: "CRN and Email required" });
    }

    let invite = null;
    await db.ready();
    if (db.isConnected()) {
      try {
        invite = await db.getInvitation(crn, email);
      } catch (e) {}
    }

    if (!invite) {
      invite = memStore.getRmInvitation(crn, email);
    }

    if (invite) {
      // Mark viewed or in_progress
      invite.status = "in_progress";
      memStore.saveRmInvitation(invite);

      const companyUid = invite.company_uid || resolveCompanyUid({ crn: invite.crn, company_uid: invite.company_uid });

      return res.json({
        valid: true,
        invitation: {
          crn: invite.crn,
          email: invite.email,
          company_uid: companyUid,
          companyName: invite.company_name,
          contactPerson: invite.contact_person,
          rmName: invite.rm_name
        }
      });
    }

    return res.json({
      valid: false,
      message: "No specific RM invitation record found, but standard corporate onboarding is available."
    });
  } catch (err) {
    return res.status(500).json({ valid: false, error: "Verification error" });
  }
});

/**
 * GET /api/v1/rm/audit-trail
 * Query complete audit trail by company_uid or crn for the RM command center (Requires RM Auth)
 */
router.get("/audit-trail", requireRmAuth, async (req, res) => {
  try {
    const { company_uid, crn, limit } = req.query;
    if (!company_uid && !crn) {
      return res.status(400).json({ error: "Query parameter company_uid or crn is required." });
    }

    const resolvedUid = company_uid || resolveCompanyUid({ crn });
    const logs = await getAuditTrail({
      company_uid: resolvedUid,
      crn,
      limit: parseInt(limit, 10) || 100
    });

    return res.json({
      success: true,
      company_uid: resolvedUid,
      count: logs.length,
      auditTrail: logs
    });
  } catch (err) {
    console.error("[RM-SERVICE] Error fetching audit trail:", err);
    return res.status(500).json({ error: "Failed to retrieve audit trail." });
  }
});

module.exports = {
  router,
  requireRmAuth
};

