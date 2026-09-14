/**
 * First National Bank — Core Banking Application Controller
 * Full maker-checker operations console:
 *   Create CIF · Create Account · Process Transactions · Authorization Queue
 *   Customers · Accounts · Ledger · Audit
 */

(function () {
    const TOKEN_KEY = 'core_session_token';
    const PROFILE_KEY = 'core_profile';

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (n, ccy) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (ccy ? ' ' + ccy : '');
    const when = (iso) => iso ? new Date(iso).toLocaleString() : '—';

    let token = '';
    let profile = {};
    let cifs = [];
    let accounts = [];

    function getToken() { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''; }
    function saveSession(t, p) {
        token = t;
        localStorage.setItem(TOKEN_KEY, t); sessionStorage.setItem(TOKEN_KEY, t);
        localStorage.setItem(PROFILE_KEY, JSON.stringify(p || {}));
    }
    function loadProfile() { try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); } catch (e) { return {}; } }
    function clearSession() {
        token = '';
        localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(PROFILE_KEY);
    }

    async function api(endpoint, options = {}) {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(endpoint, { ...options, headers });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (res.status === 401) { clearSession(); showLogin(); }
            throw new Error(data.error || `Request failed (${res.status})`);
        }
        return data;
    }

    function toast(msg, isError = false) {
        const el = $('toast');
        el.textContent = msg;
        el.style.display = 'block';
        el.style.borderColor = isError ? 'rgba(239,68,68,0.5)' : 'rgba(212,175,55,0.4)';
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.style.display = 'none'; }, 3600);
    }

    function formMsg(idOk, idErr, msg, isError = false) {
        $(idErr).style.display = isError && msg ? 'block' : 'none';
        if (isError) $(idErr).textContent = msg || '';
        $(idOk).style.display = !isError && msg ? 'block' : 'none';
        if (!isError) $(idOk).textContent = msg || '';
    }

    // ── Auth gate ──
    function showLogin() {
        $('viewLogin').style.display = ''; // restore rm-login-wrap flex centering
        $('shell').classList.remove('active');
    }
    function showApp() {
        $('viewLogin').style.display = 'none';
        $('shell').style.display = '';
        $('shell').classList.add('active');
        profile = loadProfile();
        $('whoName').textContent = profile.name || 'RM Executive';
        $('whoRole').textContent = profile.role || 'Staff';
        refreshAll();
    }

    async function login() {
        const staffId = $('loginUser').value.trim();
        const password = $('loginPass').value.trim();
        const errBox = $('loginError');
        errBox.style.display = 'none';
        if (!staffId || !password) { errBox.textContent = 'Enter your Staff ID and passkey.'; errBox.style.display = 'block'; return; }
        const btn = $('btnLogin');
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Authenticating…';
        try {
            const res = await fetch('/api/v1/rm/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ staffId, password })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success || !data.token) throw new Error(data.error || 'Authentication failed.');
            saveSession(data.token, data.profile);
            showApp();
        } catch (err) {
            errBox.textContent = err.message; errBox.style.display = 'block';
        } finally { btn.disabled = false; btn.innerHTML = '<span class="btn-label">Sign In &rarr;</span>'; }
    }

    // ── Navigation ──
    const TITLES = {
        dashboard: ['Dashboard', 'Core banking overview'],
        createCif: ['Create CIF', 'Register a new corporate customer (maker → checker)'],
        createAccount: ['Create Account', 'Open a core account against an approved CIF (maker → checker)'],
        transactions: ['Process Transaction', 'Internal transfer or external wire (maker → checker)'],
        authorizations: ['Authorization Queue', 'Approve or reject maker requests as checker'],
        customers: ['Customers (CIF)', 'Customer Information File register'],
        accounts: ['Account Register', 'All core accounts'],
        ledger: ['Transaction Ledger', 'Settled debit & credit legs'],
        audit: ['Audit Log', 'Full action trail']
    };
    function go(view) {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
        document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + view));
        $('viewTitle').textContent = (TITLES[view] || ['Dashboard'])[0];
        $('viewSubtitle').textContent = (TITLES[view] || ['', ''])[1];
        refreshAll();
    }

    // ── Data loading ──
    async function refreshAll() {
        if (!token) return;
        try {
            const [reqRes, cifRes, accRes, txRes, auditRes] = await Promise.all([
                api('/api/v1/core/requests'),
                api('/api/v1/core/cifs'),
                api('/api/v1/core/accounts'),
                api('/api/v1/core/transactions?limit=100'),
                api('/api/v1/core/audit?limit=100').catch(() => ({ logs: [] }))
            ]);
            const requests = reqRes.requests || [];
            cifs = cifRes.cifs || [];
            accounts = accRes.accounts || [];
            const txs = txRes.transactions || [];
            const logs = auditRes.logs || [];
            const pending = requests.filter(r => r.status === 'pending');

            $('pendingCount').textContent = pending.length;
            $('pendingCount').style.display = pending.length > 0 ? 'inline-block' : 'none';
            $('authPendingBadge').textContent = pending.length + ' pending';

            $('dCustomers').textContent = cifs.length;
            $('dAccounts').textContent = accounts.length;
            $('dPending').textContent = pending.length;
            $('dTxToday').textContent = txs.length;

            renderPendingTable(pending, 'dashPendingBody', false);
            renderAuthQueue(pending, requests);
            renderCifs(); renderAccounts(); renderLedger(txs); renderAudit(logs);
            fillSelectors();
        } catch (err) {
            toast(err.message, true);
        }
    }

    function summarize(payload, type) {
        const p = payload || {};
        if (type === 'CIF_CREATE') return `${p.company_name || ''} · CRN ${p.crn || ''} · ${p.registered_email || ''}`;
        if (type === 'ACCOUNT_CREATE') return `${p.cif_number || p.company_uid || ''} · ${p.currency || 'AED'} ${p.account_type || 'Corporate Checking'} · opening ${fmt(p.opening_balance)}`;
        if (type === 'TRANSACTION') return `${p.from_account || ''} → ${p.to_account || p.to_iban || ''} · ${fmt(p.amount)}${p.description ? ' · ' + p.description : ''}`;
        return JSON.stringify(p).slice(0, 120);
    }

    function renderPendingTable(pending, bodyId, withActions) {
        const tbody = $(bodyId);
        if (pending.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty">No pending requests — all clear. ✅</td></tr>';
            return;
        }
        tbody.innerHTML = pending.map(r => `
            <tr>
                <td class="mono">${esc(r.request_ref)}</td>
                <td><span class="badge ${esc(r.request_type)}">${esc(r.request_type)}</span></td>
                <td>${esc(summarize(r.payload, r.request_type))}</td>
                <td>${esc(r.maker_name || r.maker_id)}</td>
                <td>${esc(when(r.created_at))}</td>
                ${withActions ? '<td class="row-actions"><button class="btn-green" data-approve="' + esc(r.request_ref) + '">✔ Approve</button><button class="btn-red" data-reject="' + esc(r.request_ref) + '">✖ Reject</button></td>' : '<td></td>'}
            </tr>
        `).join('');
        if (withActions) {
            tbody.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => decide(b.dataset.approve, 'approve', b)));
            tbody.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => decide(b.dataset.reject, 'reject', b)));
        }
    }

    function renderAuthQueue(pending, all) {
        renderPendingTable(pending, 'authBody', true);
        const decided = all.filter(r => r.status !== 'pending').slice(0, 30);
        const tbody = $('authHistoryBody');
        if (decided.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty">No decisions yet.</td></tr>';
            return;
        }
        tbody.innerHTML = decided.map(r => `
            <tr>
                <td class="mono">${esc(r.request_ref)}</td>
                <td><span class="badge ${esc(r.request_type)}">${esc(r.request_type)}</span></td>
                <td><span class="badge ${esc(r.status)}">${esc(r.status)}</span></td>
                <td>${esc(r.maker_name || r.maker_id)}</td>
                <td>${esc(r.checker_name || r.checker_id || '—')}</td>
                <td class="mono">${esc(r.result_ref || r.checker_comment || '—')}</td>
            </tr>
        `).join('');
    }

    async function decide(ref, action, btn) {
        if (action === 'reject' && !confirm(`Reject request ${ref}?`)) return;
        btn.disabled = true;
        try {
            const res = await api(`/api/v1/core/requests/${encodeURIComponent(ref)}/${action}`, { method: 'POST', body: JSON.stringify({}) });
            toast(res.message || `Request ${action}d.`);
            await refreshAll();
        } catch (err) {
            toast(err.message, true);
            btn.disabled = false;
        }
    }

    function renderCifs() {
        const tbody = $('cifsBody');
        if (cifs.length === 0) { tbody.innerHTML = '<tr><td colspan="8" class="empty">No CIFs yet — create one from “Create CIF”.</td></tr>'; return; }
        tbody.innerHTML = cifs.map(c => `
            <tr>
                <td class="mono">${esc(c.cif_number)}</td>
                <td>${esc(c.company_name || '—')}</td>
                <td class="mono">${esc(c.crn || '—')}</td>
                <td>${esc(c.registered_email || '—')}</td>
                <td>${esc(c.risk_rating || 'LOW')}</td>
                <td><span class="badge ${esc(c.kyc_status || 'passed')}">${esc(c.kyc_status || 'passed')}</span></td>
                <td class="mono">${esc(c.dedicated_bic || '—')}</td>
                <td><span class="badge ${esc(c.status || 'active')}">${esc(c.status || 'active')}</span></td>
            </tr>
        `).join('');
    }

    function renderAccounts() {
        const tbody = $('accountsBody');
        if (accounts.length === 0) { tbody.innerHTML = '<tr><td colspan="9" class="empty">No core accounts yet — open one from “Create Account”.</td></tr>'; return; }
        tbody.innerHTML = accounts.map(a => `
            <tr>
                <td class="mono">${esc(a.account_number)}</td>
                <td class="mono">${esc(a.iban || '—')}</td>
                <td>${esc(a.account_name || '—')}</td>
                <td class="mono">${esc(a.cif_number || a.company_uid || '—')}</td>
                <td>${esc(a.currency)}</td>
                <td><b>${fmt(a.balance, a.currency)}</b></td>
                <td>${fmt(a.available_balance, a.currency)}</td>
                <td class="mono">${esc(a.bic || '—')}</td>
                <td><span class="badge ${esc(a.status)}">${esc(a.status)}</span></td>
            </tr>
        `).join('');
    }

    function renderLedger(txs) {
        const tbody = $('ledgerBody');
        if (txs.length === 0) { tbody.innerHTML = '<tr><td colspan="9" class="empty">No transactions yet.</td></tr>'; return; }
        tbody.innerHTML = txs.slice(0, 100).map(t => `
            <tr>
                <td class="mono">${esc(t.transaction_ref)}</td>
                <td class="mono">${esc(t.account_number)}</td>
                <td><span class="badge ${t.type === 'credit' ? 'approved' : 'ACCOUNT_CREATE'}">${esc(t.type)}</span></td>
                <td style="color:${t.type === 'credit' ? '#6ee7a0' : '#fca5a5'};"><b>${t.type === 'credit' ? '+' : '−'}${fmt(t.amount, t.currency)}</b></td>
                <td>${esc(t.currency)}</td>
                <td>${esc(t.counterparty_name || t.counterparty_iban || '—')}</td>
                <td>${esc(t.description || '—')}</td>
                <td><span class="badge ${esc(t.status)}">${esc(t.status)}</span></td>
                <td>${esc(when(t.created_at))}</td>
            </tr>
        `).join('');
    }

    function renderAudit(logs) {
        const tbody = $('auditBody');
        if (logs.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="empty">Audit trail empty.</td></tr>'; return; }
        tbody.innerHTML = logs.slice(0, 100).map(l => `
            <tr>
                <td>${esc(when(l.created_at))}</td>
                <td class="mono">${esc(l.action_type)}</td>
                <td>${esc(l.actor_name || l.actor_id)}</td>
                <td>${esc(l.target_company || l.target_crn || l.target_email || '—')}</td>
                <td>${esc((l.details || '').slice(0, 140))}</td>
                <td><span class="badge ${esc((l.status || 'SUCCESS').toLowerCase())}">${esc(l.status || 'SUCCESS')}</span></td>
            </tr>
        `).join('');
    }

    function fillSelectors() {
        const accCif = $('accCif');
        const active = cifs.filter(c => (c.status || 'active') === 'active');
        accCif.innerHTML = active.length
            ? active.map(c => `<option value="${esc(c.cif_number)}">${esc(c.company_name)} — ${esc(c.cif_number)}</option>`).join('')
            : '<option value="">No approved CIFs — create one first</option>';

        const opts = accounts.filter(a => a.status === 'active')
            .map(a => `<option value="${esc(a.account_number)}">${esc(a.account_number)} · ${esc(a.currency)} · bal ${fmt(a.balance)}${a.account_name ? ' · ' + esc(a.account_name) : ''}</option>`)
            .join('');
        $('txFrom').innerHTML = opts || '<option value="">No active accounts</option>';
        $('txTo').innerHTML = opts || '<option value="">No active accounts</option>';
    }

    // ── Makers ──
    async function submitCif() {
        formMsg('cifOk', 'cifError', '');
        const btn = $('btnSubmitCif');
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Submitting…';
        try {
            const res = await api('/api/v1/core/cif', {
                method: 'POST',
                body: JSON.stringify({
                    company_name: $('cifCompanyName').value.trim(),
                    crn: $('cifCrn').value.trim(),
                    registered_email: $('cifEmail').value.trim(),
                    trade_name: $('cifTradeName').value.trim() || undefined,
                    legal_type: $('cifLegalType').value,
                    risk_rating: $('cifRisk').value,
                    contact_person: $('cifContact').value.trim() || undefined,
                    phone: $('cifPhone').value.trim() || undefined,
                    address: $('cifAddress').value.trim() || undefined,
                    maker_comment: $('cifComment').value.trim() || undefined
                })
            });
            formMsg('cifOk', 'cifError', `✔ ${res.message} Reference: ${res.request.request_ref} — awaiting checker authorization.`, false);
            ['cifCompanyName', 'cifCrn', 'cifEmail', 'cifTradeName', 'cifContact', 'cifPhone', 'cifAddress', 'cifComment'].forEach(id => { $(id).value = ''; });
            toast('CIF request submitted to checker.');
            await refreshAll();
        } catch (err) {
            formMsg('cifOk', 'cifError', err.message, true);
        } finally { btn.disabled = false; btn.innerHTML = '<span class="btn-label">➕ Submit CIF Request (to Checker)</span>'; }
    }

    async function submitAccount() {
        formMsg('accOk', 'accError', '');
        const cif = $('accCif').value;
        if (!cif) { formMsg('accOk', 'accError', 'Select a customer CIF (create & approve a CIF first).', true); return; }
        const btn = $('btnSubmitAccount');
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Submitting…';
        try {
            const res = await api('/api/v1/core/accounts', {
                method: 'POST',
                body: JSON.stringify({
                    cif_number: cif,
                    currency: $('accCurrency').value,
                    account_type: $('accType').value,
                    account_name: $('accName').value.trim() || undefined,
                    opening_balance: parseFloat($('accOpening').value || '0'),
                    maker_comment: $('accComment').value.trim() || undefined
                })
            });
            formMsg('accOk', 'accError', `✔ ${res.message} Reference: ${res.request.request_ref}`, false);
            toast('Account request submitted to checker.');
            await refreshAll();
        } catch (err) {
            formMsg('accOk', 'accError', err.message, true);
        } finally { btn.disabled = false; btn.innerHTML = '<span class="btn-label">💳 Submit Account Request (to Checker)</span>'; }
    }

    async function submitTx() {
        formMsg('txOk', 'txError', '');
        const mode = $('txMode').value;
        const body = {
            from_account: $('txFrom').value,
            amount: parseFloat($('txAmount').value),
            description: $('txDesc').value.trim() || undefined,
            counterparty_name: $('txBene').value.trim() || undefined,
            maker_comment: $('txComment').value.trim() || undefined
        };
        if (mode === 'internal') body.to_account = $('txTo').value;
        else { body.to_iban = $('txIban').value.trim(); }

        const btn = $('btnSubmitTx');
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Submitting…';
        try {
            const res = await api('/api/v1/core/transactions', { method: 'POST', body: JSON.stringify(body) });
            formMsg('txOk', 'txError', `✔ ${res.message} Reference: ${res.request.request_ref}`, false);
            $('txAmount').value = ''; $('txDesc').value = ''; $('txBene').value = ''; $('txIban').value = ''; $('txComment').value = '';
            toast('Transaction request submitted to checker.');
            await refreshAll();
        } catch (err) {
            formMsg('txOk', 'txError', err.message, true);
        } finally { btn.disabled = false; btn.innerHTML = '<span class="btn-label">💸 Submit Transaction Request (to Checker)</span>'; }
    }

    // ── Wire-up ──
    document.querySelectorAll('.nav-item').forEach(n => n.addEventListener('click', () => go(n.dataset.view)));
    $('btnLogin').addEventListener('click', login);
    $('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    $('loginUser').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginPass').focus(); });
    $('btnLogout').addEventListener('click', () => { clearSession(); showLogin(); });
    $('btnRefresh').addEventListener('click', refreshAll);
    $('btnSubmitCif').addEventListener('click', submitCif);
    $('btnSubmitAccount').addEventListener('click', submitAccount);
    $('btnSubmitTx').addEventListener('click', submitTx);
    $('txMode').addEventListener('change', () => {
        const internal = $('txMode').value === 'internal';
        $('txToWrap').style.display = internal ? 'block' : 'none';
        $('txIbanWrap').style.display = internal ? 'none' : 'block';
    });

    token = getToken();
    if (token) { showApp(); } else { showLogin(); }
})();
