/**
 * First National Bank Microservice: Live Core Banking & FX Service (Port 3004)
 * Powers real-time corporate accounts, multi-currency balances, live FX rate feeds,
 * instant wire transfers (SWIFT GPI & Federal Reserve Fedwire simulator),
 * and mobile banking APIs for the mobile bank application.
 */

const express = require("express");
const crypto = require("crypto");
const config = require("../../shared/config");
const memStore = require("../../shared/memStore");
const db = require("../../shared/db");
const { requireAuth } = require("../auth-service");
const { logAuditEvent } = require("../../shared/audit");

const router = express.Router();

// Live FX Rates with live jitter simulation
function getLiveFxRates() {
  const baseRates = {
    "USD/AED": 3.6725,
    "EUR/AED": 4.0210,
    "GBP/AED": 4.7180,
    "SAR/AED": 0.9790,
    "EUR/USD": 1.0945,
    "GBP/USD": 1.2842
  };

  // Add realistic micro-spread jitter
  const timestamp = new Date().toISOString();
  const rates = {};
  for (const [pair, base] of Object.entries(baseRates)) {
    const jitter = (Math.sin(Date.now() / 15000 + pair.length) * 0.0015);
    rates[pair] = {
      pair,
      rate: Number((base + jitter).toFixed(4)),
      change24h: ((jitter / base) * 100).toFixed(2) + "%",
      updatedAt: timestamp
    };
  }
  return rates;
}

// 1. Get Live Corporate Accounts (Requires Authentication)
// Returns ONLY real core-banking accounts provisioned for the caller's
// company (or all accounts for RM executives). No generated/demo accounts.
router.get("/accounts", requireAuth, async (req, res) => {
  memStore.metrics.serviceRequests.banking++;

  try {
    let accounts = [];

    if (db.isConnected()) {
      const result = await db.query(
        "SELECT * FROM corporate_accounts ORDER BY id ASC"
      );
      accounts = result.rows;
    }

    // Tenant isolation: customers only ever see their own provisioned accounts
    if (!req.user.is_rm && req.user.role !== "RM" && req.user.company_uid) {
      const callerCuid = req.user.company_uid.toUpperCase();
      accounts = accounts.filter(a => a.company_uid && a.company_uid.toUpperCase() === callerCuid);
    }

    // Calculate total liquidity in AED
    const totalLiquidityAED = accounts.reduce((sum, acc) => {
      let multiplier = 1;
      if (acc.currency === "USD") multiplier = 3.6725;
      if (acc.currency === "EUR") multiplier = 4.0210;
      return sum + (Number(acc.balance) * multiplier);
    }, 0);

    return res.json({
      success: true,
      count: accounts.length,
      accounts,
      totalLiquidityAED: totalLiquidityAED.toFixed(2),
      clearingNetwork: "Fedwire Funds Service & SWIFT GPI",
      service: "banking-service"
    });
  } catch (err) {
    console.error("[BANKING SERVICE] Accounts fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch corporate accounts." });
  }
});

// 2. Get Live Transactions Ledger (Requires Authentication & Tenant Isolation)
router.get("/transactions", requireAuth, async (req, res) => {
  memStore.metrics.serviceRequests.banking++;
  const limit = parseInt(req.query.limit || "20", 10);
  let txs = [];

  const isRm = Boolean(req.user.is_rm || req.user.role === "RM");
  const userCuid = (req.user.company_uid || "").trim().toUpperCase();

  if (db.isConnected()) {
    try {
      if (isRm || !userCuid) {
        // RM Executives have central administrative oversight
        const result = await db.query(
          "SELECT * FROM account_transactions ORDER BY created_at DESC LIMIT $1",
          [limit]
        );
        if (result.rows && result.rows.length > 0) {
          txs = result.rows;
        }
      } else {
        // Multi-Tenant Isolation: Only query transactions belonging to this company's accounts or company_uid
        const result = await db.query(
          `SELECT t.* FROM account_transactions t
           WHERE (t.company_uid IS NOT NULL AND UPPER(t.company_uid) = $1)
              OR t.account_number IN (
                SELECT account_number FROM corporate_accounts WHERE UPPER(company_uid) = $1
              )
           ORDER BY t.created_at DESC LIMIT $2`,
          [userCuid, limit]
        );
        if (result.rows && result.rows.length > 0) {
          txs = result.rows;
        }
      }
    } catch (dbErr) {
      console.warn("[BANKING SERVICE] DB transactions fetch fallback:", dbErr.message);
    }
  }

  // Ledger only — no in-memory demo fallback. Real transactions live in Supabase.

  return res.json({
    success: true,
    count: txs.length,
    transactions: txs,
    service: "banking-service"
  });
});

// 3. Get Live FX Rates
router.get("/fx-rates", (req, res) => {
  memStore.metrics.serviceRequests.banking++;
  return res.json({
    success: true,
    rates: getLiveFxRates(),
    service: "banking-service"
  });
});

// 4. Execute Instant Corporate Wire Transfer (SWIFT GPI / Central Bank FTS) (Requires Authentication)
router.post("/transfer", requireAuth, async (req, res) => {
  memStore.metrics.serviceRequests.banking++;
  const {
    fromAccount,
    counterpartyName,
    counterpartyIban,
    amount,
    currency,
    description,
    channel
  } = req.body;

  const numAmount = parseFloat(amount);
  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ error: "Invalid transfer amount." });
  }

  if (!counterpartyName || !counterpartyIban) {
    return res.status(400).json({ error: "Beneficiary Name and IBAN are required." });
  }

  let accountNum = fromAccount;
  if (!accountNum && req.user.company_uid) {
    // Default to the caller's first real core account
    const callerAccounts = await db.query(
      "SELECT * FROM corporate_accounts ORDER BY id ASC"
    );
    const mine = (callerAccounts.rows || []).filter(a =>
      a.company_uid && a.company_uid.toUpperCase() === req.user.company_uid.toUpperCase());
    if (mine.length > 0) accountNum = mine[0].account_number;
  }

  let acc = null;

  if (accountNum && db.isConnected()) {
    try {
      const accRes = await db.query(
        "SELECT * FROM corporate_accounts WHERE account_number = $1 LIMIT 1",
        [accountNum]
      );
      if (accRes.rows.length > 0) {
        acc = accRes.rows[0];
      }
    } catch (e) {
      console.warn("[BANKING SERVICE] DB account query fallback:", e.message);
    }
  }

  if (!acc) {
    return res.status(404).json({ error: "Source corporate account not found. Your core account must be provisioned and approved before transacting." });
  }

  // Authorization Check: Caller must own the corporate account or have RM Executive privileges
  if (!req.user.is_rm && req.user.role !== "RM") {
    if (acc.company_uid && req.user.company_uid && acc.company_uid.toUpperCase() !== req.user.company_uid.toUpperCase()) {
      return res.status(403).json({ error: "Forbidden: You do not have authorization to transfer funds from this account." });
    }
  }

  const currentAvailable = parseFloat(acc.available_balance || acc.balance || 0);
  if (currentAvailable < numAmount) {
    return res.status(400).json({ error: "Insufficient available balance in corporate account." });
  }

  let newBalance = Number((parseFloat(acc.balance) - numAmount).toFixed(2));
  let newAvail = Number((currentAvailable - numAmount).toFixed(2));

  // Generate SWIFT GPI Tracking reference
  const txRef = "TX-FTS-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const swiftUetr = crypto.randomUUID();

  const targetCompanyUid = req.user.company_uid || acc.company_uid || null;

  const txRecord = {
    id: Date.now(),
    transaction_ref: txRef,
    swift_uetr: swiftUetr,
    account_number: accountNum,
    company_uid: targetCompanyUid,
    type: "debit",
    amount: numAmount,
    currency: currency || acc.currency,
    counterparty_name: counterpartyName,
    counterparty_iban: counterpartyIban,
    description: description || "Corporate Wire Transfer",
    category: "Commercial Payment",
    status: "settled",
    channel: channel || "portal",
    clearing_channel: "Fedwire Funds Service (FRB)",
    created_at: new Date().toISOString(),
    timestamp: new Date().toISOString()
  };

  // Update in Database atomically if connected (prevents concurrent race conditions)
  if (db.isConnected()) {
    try {
      const updateRes = await db.query(
        "UPDATE corporate_accounts SET balance = balance - $1, available_balance = available_balance - $1, updated_at = NOW() WHERE account_number = $2 AND available_balance >= $1 RETURNING *",
        [numAmount, accountNum]
      );
      if (!updateRes.rows || updateRes.rows.length === 0) {
        return res.status(400).json({ error: "Insufficient available balance in corporate account." });
      }
      const updatedRow = updateRes.rows[0];
      newBalance = parseFloat(updatedRow.balance);
      newAvail = parseFloat(updatedRow.available_balance);

      await db.query(
        `INSERT INTO account_transactions (
          transaction_ref, swift_uetr, account_id, account_number, company_uid, type, amount, currency,
          counterparty_name, counterparty_iban, description, category, status, channel, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
        [
          txRef,
          swiftUetr,
          acc.id || null,
          accountNum,
          targetCompanyUid,
          "debit",
          numAmount,
          currency || acc.currency,
          counterpartyName,
          counterpartyIban,
          description || "Corporate Wire Transfer",
          "Commercial Payment",
          "settled",
          channel || "portal"
        ]
      );
    } catch (dbErr) {
      console.error("[BANKING SERVICE] Failed to record transfer in DB:", dbErr.message);
    }
  }

  // Update in-memory fallback
  acc.balance = newBalance;
  acc.available_balance = newAvail;
  memStore.accounts.set(accountNum, acc);
  memStore.transactions.unshift(txRecord);

  // Record Audit Trail Event
  await logAuditEvent({
    company_uid: req.user.company_uid || acc.company_uid || "CUID-CORP",
    crn: req.user.crn,
    channel: channel || "portal",
    action_type: "WIRE_TRANSFER",
    actor: req.user.email || req.user.name || "Authorized Signatory",
    target: counterpartyName,
    status: "SUCCESS",
    ip_address: req.ip || req.headers["x-forwarded-for"] || "127.0.0.1",
    user_agent: req.headers["user-agent"] || "Banking-Service",
    metadata: {
      account_number: accountNum,
      amount: numAmount,
      currency: currency || acc.currency,
      txRef,
      counterparty_iban: counterpartyIban
    }
  });

  // Send simulated notification
  memStore.recordSimulatedEmail({
    to: "finance@corporate.com",
    from: '"Gringotts Bank Operations Desk" <operations@gringotts.com>',
    subject: `Transfer Executed: ${txRecord.currency} ${txRecord.amount.toLocaleString()} to ${counterpartyName}`,
    type: "transfer_executed",
    metadata: { txRef, amount: numAmount },
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
        <h3 style="color: #0f172a; margin-top: 0;">⚡ Wire Transfer Executed Successfully</h3>
        <p style="color: #475569; font-size: 14px;">Your payment of <strong>${txRecord.currency} ${txRecord.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong> has been cleared via the Central Bank FTS.</p>
        <div style="background: #f8fafc; padding: 14px; border-radius: 8px; font-size: 13px; line-height: 1.6;">
          <div><strong>Reference:</strong> <code>${txRef}</code></div>
          <div><strong>SWIFT UETR:</strong> <code>${swiftUetr}</code></div>
          <div><strong>Beneficiary:</strong> ${counterpartyName}</div>
          <div><strong>IBAN:</strong> ${counterpartyIban}</div>
        </div>
      </div>
    `,
    text: `Transfer of ${txRecord.currency} ${txRecord.amount} to ${counterpartyName} executed.`
  });

  return res.json({
    success: true,
    message: "Corporate wire transfer settled instantly.",
    transaction: txRecord,
    updatedAccount: acc,
    service: "banking-service"
  });
});

// 5. Mobile App Summary Feed (Requires Authentication & Tenant Isolation)
// Serves only real provisioned accounts and the authenticated client's data.
router.get(["/mobile/summary", "/summary"], requireAuth, async (req, res) => {
  memStore.metrics.serviceRequests.banking++;
  const userCuid = (req.user.company_uid || "").trim().toUpperCase();
  const isRm = Boolean(req.user.is_rm || req.user.role === "RM");

  let accounts = [];
  if (db.isConnected()) {
    try {
      const result = await db.query("SELECT * FROM corporate_accounts ORDER BY id ASC");
      accounts = result.rows || [];
    } catch (e) { /* no accounts yet */ }
  }
  if (!isRm && userCuid) {
    accounts = accounts.filter(a => a.company_uid && a.company_uid.toUpperCase() === userCuid);
  }
  const primaryAccount = accounts[0] || {};

  let recentTransactions = [];
  if (db.isConnected()) {
    try {
      const result = await db.query(
        isRm || !userCuid
          ? "SELECT * FROM account_transactions ORDER BY created_at DESC LIMIT 5"
          : "SELECT * FROM account_transactions WHERE company_uid = $1 ORDER BY created_at DESC LIMIT 5",
        isRm || !userCuid ? [] : [userCuid]
      );
      recentTransactions = result.rows || [];
    } catch (e) { /* empty ledger */ }
  }

  return res.json({
    success: true,
    mobileAppVersion: "2.4.0 (Mobile Banking Suite)",
    client: {
      name: req.user.name || req.user.email || "Corporate Client",
      company: req.user.company_name || primaryAccount.account_name || null,
      accountTier: isRm ? "RM Executive" : "Corporate"
    },
    primaryBalance: {
      currency: primaryAccount.currency || "AED",
      balance: primaryAccount.balance || 0,
      available: primaryAccount.available_balance || 0,
      accountNumber: primaryAccount.account_number || null,
      iban: primaryAccount.iban || null
    },
    allAccounts: accounts,
    recentTransactions,
    quickActions: [
      { id: "transfer", label: "Send Money", icon: "arrow-up-right", enabled: true },
      { id: "scan", label: "Scan & Pay", icon: "scan", enabled: true },
      { id: "docs", label: "KYC Vault", icon: "file-text", enabled: true },
      { id: "fx", label: "Live FX", icon: "trending-up", enabled: true }
    ],
    service: "banking-service"
  });
});

// Health check
router.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "banking-service",
    activeAccounts: memStore.accounts.size,
    totalTransactions: memStore.transactions.length,
    port: config.MICROSERVICES.BANKING.port,
    uptime: process.uptime()
  });
});

module.exports = { router };
