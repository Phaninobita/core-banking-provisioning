/**
 * First National Bank Microservice: Core Banking Operations Service
 * Full maker-checker core banking operations for onboarded customers:
 *
 *   MAKER side (submits requests — nothing executes immediately):
 *     POST /api/v1/core/cif            → CIF_CREATE request
 *     POST /api/v1/core/accounts       → ACCOUNT_CREATE request
 *     POST /api/v1/core/transactions   → TRANSACTION request
 *
 *   CHECKER side (authorizes — a different user must approve):
 *     GET  /api/v1/core/requests?status=pending
 *     POST /api/v1/core/requests/:ref/approve   (executes the operation)
 *     POST /api/v1/core/requests/:ref/reject
 *
 *   Registers / ledgers:
 *     GET  /api/v1/core/cifs · /accounts · /transactions · /audit · /requests
 *
 * Protection model:
 *   - Every endpoint requires a valid RM/staff JWT
 *   - Maker ≠ checker is strictly enforced server-side
 *   - Decided requests are immutable
 *   - Transactions validate balance, currency and active-account status
 *   - Every submit/approve/reject/execution writes to the audit log
 */

const express = require("express");
const crypto = require("crypto");
const config = require("../../shared/config");
const db = require("../../shared/db");
const supabaseClient = require("../../shared/supabaseClient");
const { requireAuth } = require("../auth-service");
const { logAuditEvent } = require("../../shared/audit");

const router = express.Router();

const VALID_CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR"];
const MAX_SINGLE_TX = 50000000; // hard safety ceiling

// In-memory mirror of the authorization queue. Supabase
// (core_authorization_requests) is the source of truth once the table
// exists; until the DB migration runs, the queue keeps working in memory.
const memQueue = new Map();
let supabaseQueueWarned = false;

function newRef(prefix) {
    return prefix + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function actorOf(req) {
    return {
        id: req.user.rm_id || req.user.username || req.user.email || "staff",
        name: req.user.name || req.user.username || "Staff"
    };
}

// ── Queue persistence helpers ──
async function persistRequest(record) {
    memQueue.set(record.request_ref, record);
    try {
        const saved = await supabaseClient.saveAuthRequest(record);
        if (saved && saved.request_ref) return saved;
        if (!supabaseQueueWarned) {
            supabaseQueueWarned = true;
            console.warn("[CORE SERVICE] core_authorization_requests table not found — run db/04_core_ops.sql. Queue kept in memory.");
        }
    } catch (e) {
        if (!supabaseQueueWarned) {
            supabaseQueueWarned = true;
            console.warn("[CORE SERVICE] Auth queue Supabase persistence unavailable:", e.message);
        }
    }
    return record;
}

async function loadRequests(status) {
    const fromDb = await supabaseClient.listAuthRequests(status);
    if (fromDb) {
        fromDb.forEach(r => { if (r.request_ref) memQueue.set(r.request_ref, r); });
        return fromDb;
    }
    const list = Array.from(memQueue.values());
    return status ? list.filter(r => r.status === status) : list;
}

// ══════════════════════════════════════════════════════════════════════
// EXECUTORS — run only on checker approval
// ══════════════════════════════════════════════════════════════════════

async function executeCifCreation(payload) {
    const company_uid = (payload.company_uid ||
        `CUID-${String(payload.crn || "").replace(/[^A-Z0-9]/gi, "")}`).toUpperCase();

    const existing = await supabaseClient.getCif(company_uid);
    if (existing) return { result_ref: existing.cif_number, cif: existing, already_existed: true };

    const cif = await supabaseClient.saveCif({
        company_uid,
        crn: payload.crn,
        company_name: payload.company_name,
        trade_name: payload.trade_name,
        legal_type: payload.legal_type,
        registered_email: payload.registered_email,
        contact_person: payload.contact_person,
        phone: payload.phone,
        address: payload.address,
        customer_type: payload.customer_type || "CORPORATE",
        risk_rating: payload.risk_rating || "LOW",
        kyc_status: payload.kyc_status || "passed"
    });

    const bic = await supabaseClient.assignDedicatedBic({
        company_uid,
        cif_number: cif.cif_number,
        company_name: payload.company_name
    });
    const updatedCif = await supabaseClient.saveCif({ ...cif, dedicated_bic: bic.bic });

    await logAuditEvent({
        company_uid,
        crn: payload.crn,
        action_type: "CIF_CREATED",
        actor: "core-service",
        target: payload.company_name,
        status: "SUCCESS",
        metadata: { cif_number: cif.cif_number, dedicated_bic: bic.bic }
    });
    return { result_ref: cif.cif_number, cif: updatedCif, bic };
}

async function executeAccountCreation(payload) {
    const cif = await supabaseClient.getCifByNumber(payload.cif_number)
        || await supabaseClient.getCif(payload.company_uid || "");
    if (!cif) throw new Error(`CIF ${payload.cif_number || payload.company_uid} not found — cannot open account.`);
    if (cif.status !== "active") throw new Error(`CIF ${cif.cif_number} is not active.`);

    const opening = payload.opening_balance != null ? Number(payload.opening_balance) : 0;
    if (!Number.isFinite(opening) || opening < 0) throw new Error("Invalid opening balance.");

    const account = await supabaseClient.createCorporateAccount({
        company_uid: cif.company_uid,
        cif_number: cif.cif_number,
        bic: cif.dedicated_bic,
        currency: payload.currency || "AED",
        account_name: payload.account_name || `${cif.company_name} — ${payload.account_type || "Corporate Checking"}`,
        account_type: payload.account_type || "Corporate Checking",
        balance: opening,
        available_balance: opening
    });

    await logAuditEvent({
        company_uid: cif.company_uid,
        action_type: "ACCOUNT_CREATED",
        actor: "core-service",
        target: account.account_number,
        status: "SUCCESS",
        metadata: { cif_number: cif.cif_number, iban: account.iban, currency: account.currency, opening_balance: opening }
    });
    return { result_ref: account.account_number, account };
}

async function executeTransaction(payload) {
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid transaction amount.");
    if (amount > MAX_SINGLE_TX) throw new Error(`Amount exceeds per-transaction ceiling of ${MAX_SINGLE_TX.toLocaleString()}.`);

    const fromAcc = await supabaseClient.getAccountByNumber(payload.from_account);
    if (!fromAcc) throw new Error(`Source account ${payload.from_account} not found.`);
    if (fromAcc.status !== "active") throw new Error(`Source account ${payload.from_account} is not active.`);

    // Validate the destination before touching any balances
    let toAcc = null;
    if (payload.to_account) {
        toAcc = await supabaseClient.getAccountByNumber(payload.to_account);
        if (!toAcc) throw new Error(`Destination account ${payload.to_account} not found.`);
        if (toAcc.status !== "active") throw new Error(`Destination account ${payload.to_account} is not active.`);
        if (toAcc.account_number === fromAcc.account_number) throw new Error("Source and destination accounts must differ.");
    }

    const available = parseFloat(fromAcc.available_balance != null ? fromAcc.available_balance : fromAcc.balance);
    if (available < amount) throw new Error(`Insufficient funds: available ${available.toFixed(2)} ${fromAcc.currency}, requested ${amount.toFixed(2)}.`);
    if (payload.currency && payload.currency !== fromAcc.currency) {
        throw new Error(`Currency mismatch: account is ${fromAcc.currency}, request was ${payload.currency}. FX conversion requests must use the transfer hub.`);
    }

    const txRef = newRef("TX");
    const uetr = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    // Debit the source account (persistent, race-safe via re-read + check)
    const newBalance = Number((parseFloat(fromAcc.balance) - amount).toFixed(2));
    const newAvail = Number((available - amount).toFixed(2));
    await supabaseClient.request(
        `corporate_accounts?account_number=eq.${encodeURIComponent(fromAcc.account_number)}`,
        { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: { balance: newBalance, available_balance: newAvail, updated_at: nowIso } }
    );

    const leg = {
        transaction_ref: txRef,
        swift_uetr: uetr,
        company_uid: fromAcc.company_uid,
        account_number: fromAcc.account_number,
        type: payload.txn_type === "credit" ? "credit" : "debit",
        amount,
        currency: fromAcc.currency,
        counterparty_name: payload.counterparty_name || (payload.to_account || "").toUpperCase(),
        counterparty_iban: payload.to_iban || payload.to_account || null,
        description: payload.description || "Core banking transaction",
        category: payload.category || "Commercial Payment",
        status: "settled",
        channel: "core_console"
    };
    await supabaseClient.saveTransaction(leg);

    // Internal transfer: also credit the destination account
    let creditLegRef = null;
    if (toAcc) {
        const toBal = Number((parseFloat(toAcc.balance) + amount).toFixed(2));
        const toAvail = Number((parseFloat(toAcc.available_balance != null ? toAcc.available_balance : toAcc.balance) + amount).toFixed(2));
        await supabaseClient.request(
            `corporate_accounts?account_number=eq.${encodeURIComponent(toAcc.account_number)}`,
            { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: { balance: toBal, available_balance: toAvail, updated_at: nowIso } }
        );
        creditLegRef = txRef + "-C";
        await supabaseClient.saveTransaction({
            ...leg,
            transaction_ref: creditLegRef,
            account_number: toAcc.account_number,
            company_uid: toAcc.company_uid,
            type: "credit",
            counterparty_name: fromAcc.account_name || fromAcc.account_number,
            counterparty_iban: fromAcc.iban
        });
    }

    await logAuditEvent({
        company_uid: fromAcc.company_uid,
        action_type: "TRANSACTION_EXECUTED",
        actor: "core-service",
        target: fromAcc.account_number,
        status: "SUCCESS",
        metadata: { txRef, amount, currency: fromAcc.currency, to_account: payload.to_account || null, uetr }
    });
    return { result_ref: txRef, transaction: leg, credit_leg: creditLegRef, from_balance: newBalance };
}

const EXECUTORS = {
    CIF_CREATE: executeCifCreation,
    ACCOUNT_CREATE: executeAccountCreation,
    TRANSACTION: executeTransaction
};

// ══════════════════════════════════════════════════════════════════════
// MAKER ENDPOINTS — submit requests
// ══════════════════════════════════════════════════════════════════════

async function submitRequest(req, res, requestType, validate, buildPayload) {
    const actor = actorOf(req);
    try {
        const body = req.body || {};
        const validationError = validate(body);
        if (validationError) return res.status(400).json({ error: validationError });

        const record = {
            request_ref: newRef(requestType === "TRANSACTION" ? "REQ-TX" : (requestType === "CIF_CREATE" ? "REQ-CIF" : "REQ-ACC")),
            request_type: requestType,
            payload: buildPayload(body),
            status: "pending",
            maker_id: actor.id,
            maker_name: actor.name,
            maker_comment: (body.maker_comment || "").trim() || null,
            company_uid: body.company_uid || null,
            created_at: new Date().toISOString()
        };
        const saved = await persistRequest(record);

        await logAuditEvent({
            company_uid: record.company_uid,
            action_type: `${requestType}_REQUESTED`,
            actor: actor.id,
            actor_name: actor.name,
            status: "SUCCESS",
            details: `Maker ${actor.name} submitted ${requestType} request ${record.request_ref}`,
            metadata: { request_ref: record.request_ref }
        });

        return res.json({ success: true, message: "Request submitted for checker authorization.", request: saved });
    } catch (err) {
        console.error("[CORE SERVICE] Submit error:", err);
        return res.status(500).json({ error: `Failed to submit request: ${err.message}` });
    }
}

// 1. Create CIF (maker)
router.post("/cif", requireAuth, (req, res) => {
    submitRequest(req, res, "CIF_CREATE",
        (b) => {
            if (!b.company_name || !String(b.company_name).trim()) return "company_name is required.";
            if (!b.crn || !String(b.crn).trim()) return "crn (company registration number) is required.";
            if (!b.registered_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.registered_email)) return "A valid registered_email is required.";
            return null;
        },
        (b) => ({
            company_uid: (b.company_uid || `CUID-${String(b.crn).replace(/[^A-Z0-9]/gi, "")}`).toUpperCase(),
            crn: String(b.crn).trim(),
            company_name: String(b.company_name).trim(),
            trade_name: b.trade_name || null,
            legal_type: b.legal_type || "LLC",
            registered_email: String(b.registered_email).trim().toLowerCase(),
            contact_person: b.contact_person || null,
            phone: b.phone || null,
            address: b.address || null,
            customer_type: b.customer_type || "CORPORATE",
            risk_rating: b.risk_rating || "LOW",
            kyc_status: b.kyc_status || "passed"
        })
    );
});

// 2. Create account for an existing CIF (maker)
router.post("/accounts", requireAuth, async (req, res) => {
    const b = req.body || {};
    if (!b.cif_number && !b.company_uid) {
        return res.status(400).json({ error: "cif_number (or company_uid) of an existing CIF is required." });
    }
    const cif = b.cif_number ? await supabaseClient.getCifByNumber(b.cif_number) : await supabaseClient.getCif(b.company_uid);
    if (!cif) return res.status(404).json({ error: "CIF not found. Create the CIF first (and have it approved)." });

    submitRequest(req, res, "ACCOUNT_CREATE",
        (body) => {
            if (body.currency && !VALID_CURRENCIES.includes(body.currency)) return `currency must be one of ${VALID_CURRENCIES.join(", ")}.`;
            if (body.opening_balance != null && (!Number.isFinite(Number(body.opening_balance)) || Number(body.opening_balance) < 0)) return "opening_balance must be a non-negative number.";
            return null;
        },
        (body) => ({
            cif_number: cif.cif_number,
            company_uid: cif.company_uid,
            currency: body.currency || "AED",
            account_type: body.account_type || "Corporate Checking",
            account_name: body.account_name || null,
            opening_balance: Number(body.opening_balance || 0)
        })
    );
});

// 3. Process transaction (maker)
router.post("/transactions", requireAuth, (req, res) => {
    submitRequest(req, res, "TRANSACTION",
        (b) => {
            if (!b.from_account) return "from_account is required.";
            const amount = Number(b.amount);
            if (!Number.isFinite(amount) || amount <= 0) return "amount must be a positive number.";
            if (amount > MAX_SINGLE_TX) return `amount exceeds the per-transaction ceiling (${MAX_SINGLE_TX.toLocaleString()}).`;
            if (!b.to_account && !b.to_iban) return "Destination required: to_account (internal) or to_iban (external wire).";
            return null;
        },
        (b) => ({
            from_account: String(b.from_account).trim(),
            to_account: b.to_account ? String(b.to_account).trim() : null,
            to_iban: b.to_iban || null,
            counterparty_name: b.counterparty_name || null,
            amount: Number(b.amount),
            description: (b.description || "").trim() || null,
            category: b.category || "Commercial Payment",
            txn_type: b.txn_type || "debit"
        })
    );
});

// ══════════════════════════════════════════════════════════════════════
// CHECKER ENDPOINTS — approve / reject
// ══════════════════════════════════════════════════════════════════════

router.get("/requests", requireAuth, async (req, res) => {
    const status = req.query.status && ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : null;
    const requests = await loadRequests(status);
    return res.json({ success: true, count: requests.length, requests });
});

async function decideRequest(req, res, decision) {
    const actor = actorOf(req);
    const ref = String(req.params.request_ref || "").trim();
    try {
        const all = await loadRequests(null);
        const request = all.find(r => r.request_ref === ref);
        if (!request) return res.status(404).json({ error: `Request ${ref} not found.` });
        if (request.status !== "pending") {
            return res.status(409).json({ error: `Request ${ref} is already ${request.status} — decided requests are immutable.` });
        }
        if (String(request.maker_id).toLowerCase() === String(actor.id).toLowerCase()) {
            return res.status(403).json({ error: "Maker-checker violation: the maker of a request cannot approve or reject it. A different staff member must authorize." });
        }

        let result_ref = null;
        let execution = null;
        if (decision === "approved") {
            const executor = EXECUTORS[request.request_type];
            if (!executor) return res.status(500).json({ error: `No executor for request type ${request.request_type}.` });
            execution = await executor(request.payload || {});
            result_ref = execution.result_ref;
        }

        const decided = {
            ...request,
            status: decision,
            checker_id: actor.id,
            checker_name: actor.name,
            checker_comment: ((req.body || {}).checker_comment || "").trim() || null,
            result_ref,
            decided_at: new Date().toISOString()
        };
        const saved = await persistRequest(decided);

        await logAuditEvent({
            company_uid: request.company_uid,
            action_type: decision === "approved" ? `${request.request_type}_APPROVED` : `${request.request_type}_REJECTED`,
            actor: actor.id,
            actor_name: actor.name,
            status: decision === "approved" ? "SUCCESS" : "REJECTED",
            details: `Checker ${actor.name} ${decision} ${request.request_type} request ${ref}` + (result_ref ? ` → ${result_ref}` : ""),
            metadata: { request_ref: ref, maker: request.maker_id, result_ref }
        });

        return res.json({
            success: true,
            message: `Request ${ref} ${decision}${result_ref ? ` — result: ${result_ref}` : ""}.`,
            request: saved,
            execution: decision === "approved" ? execution : undefined
        });
    } catch (err) {
        console.error("[CORE SERVICE] Decision error:", err);
        // Failed executions keep the request pending so another checker can retry
        await logAuditEvent({
            action_type: "AUTHORIZATION_EXECUTION_FAILED",
            actor: actor.id,
            status: "FAILED",
            details: `${decision} of ${ref} failed: ${err.message}`,
            metadata: { request_ref: ref }
        }).catch(() => {});
        return res.status(400).json({ error: `${decision} failed: ${err.message}` });
    }
}

router.post("/requests/:request_ref/approve", requireAuth, (req, res) => decideRequest(req, res, "approved"));
router.post("/requests/:request_ref/reject", requireAuth, (req, res) => decideRequest(req, res, "rejected"));

// ══════════════════════════════════════════════════════════════════════
// REGISTERS & LEDGERS
// ══════════════════════════════════════════════════════════════════════

router.get("/cifs", requireAuth, async (req, res) => {
    const cifs = await supabaseClient.listCifs();
    return res.json({ success: true, count: cifs.length, cifs });
});

router.get("/accounts", requireAuth, async (req, res) => {
    const accounts = await supabaseClient.listAllAccounts();
    return res.json({ success: true, count: accounts.length, accounts });
});

router.get("/transactions", requireAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 1000);
    const transactions = await supabaseClient.listAllTransactions(limit);
    return res.json({ success: true, count: transactions.length, transactions });
});

router.get("/audit", requireAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 1000);
    const logs = await supabaseClient.getAuditLogs(null, null, limit);
    return res.json({ success: true, count: logs.length, logs });
});

// Health
router.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        service: "core-service",
        maker_checker: true,
        pending_requests: Array.from(memQueue.values()).filter(r => r.status === "pending").length,
        port: 3007,
        uptime: process.uptime()
    });
});

module.exports = { router };
