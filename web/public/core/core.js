/**
 * First National Bank — Core Banking Console Controller
 * RM-facing screen to provision onboarded corporate applications into core
 * banking: CIF creation, core account opening and dedicated BIC assignment.
 */

(function () {
    const TOKEN_KEY = 'core_session_token';
    const PROFILE_KEY = 'core_profile';

    const $ = (id) => document.getElementById(id);

    function getToken() {
        return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
    }
    function setToken(token, profile) {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(PROFILE_KEY, JSON.stringify(profile || {}));
    }
    function getProfile() {
        try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); } catch (e) { return {}; }
    }
    function clearSession() {
        localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(PROFILE_KEY);
    }

    async function api(endpoint, options = {}) {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        const token = getToken();
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
        el._t = setTimeout(() => { el.style.display = 'none'; }, 3200);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function showLogin() {
        $('viewLogin').classList.remove('hidden');
        $('viewMain').classList.add('hidden');
    }
    function showMain() {
        $('viewLogin').classList.add('hidden');
        $('viewMain').classList.remove('hidden');
        const p = getProfile();
        $('whoAmI').textContent = p.name ? `${p.name} · ${p.role || 'RM Executive'}` : 'RM Executive';
        refreshAll();
    }

    // ── Login ──
    async function login() {
        const staffId = $('loginUser').value.trim();
        const password = $('loginPass').value.trim();
        const errBox = $('loginError');
        errBox.style.display = 'none';
        if (!staffId || !password) {
            errBox.textContent = 'Enter your Staff ID and Executive Security Passkey.';
            errBox.style.display = 'block';
            return;
        }
        const btn = $('btnLogin');
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Authenticating…';
        try {
            const res = await fetch('/api/v1/rm/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ staffId, password })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success || !data.token) {
                throw new Error(data.error || 'Authentication failed.');
            }
            setToken(data.token, data.profile);
            showMain();
        } catch (err) {
            errBox.textContent = err.message;
            errBox.style.display = 'block';
        } finally {
            btn.disabled = false; btn.textContent = 'Sign In to Core Console';
        }
    }

    // ── Applications queue ──
    let applications = [];
    async function loadApplications() {
        const tbody = $('appsTbody');
        tbody.innerHTML = '<tr><td colspan="8" class="empty">Loading applications…</td></tr>';
        try {
            const res = await api('/api/v1/provisioning/applications');
            applications = res.applications || [];
            renderApplications();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="8" class="empty">${esc(err.message)}</td></tr>`;
        }
    }

    function renderApplications() {
        const tbody = $('appsTbody');
        if (applications.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty">No onboarding applications found yet.</td></tr>';
            return;
        }
        tbody.innerHTML = applications.map(a => `
            <tr>
                <td class="mono">${esc(a.application_ref)}</td>
                <td>${esc(a.company_name || a.trade_name || '—')}</td>
                <td class="mono">${esc(a.crn)}</td>
                <td>${esc(a.registered_email || '')}</td>
                <td><span class="badge ${esc(a.status)}">${esc(a.status)}</span></td>
                <td>${esc(a.current_step)}/7</td>
                <td>${a.core_provisioned
                    ? '<span class="badge provisioned">Provisioned</span>'
                    : '<span class="badge not-provisioned">Not in core</span>'}</td>
                <td>${a.core_provisioned
                    ? `<button class="btn ghost small" data-view="${esc(a.company_uid || '')}" data-ref="${esc(a.application_ref)}">View</button>`
                    : `<button class="btn small" data-provision="${esc(a.application_ref)}">⚡ Provision</button>`}</td>
            </tr>
        `).join('');

        tbody.querySelectorAll('[data-provision]').forEach(btn =>
            btn.addEventListener('click', () => provisionApplication(btn.dataset.provision, btn)));
        tbody.querySelectorAll('[data-view]').forEach(btn =>
            btn.addEventListener('click', () => viewProvisioned(btn.dataset.view)));
    }

    // ── Provision an application ──
    async function provisionApplication(applicationRef, btn) {
        const panel = $('provisionResult');
        panel.style.display = 'block';
        panel.innerHTML = '<h3>Provisioning into core banking…</h3>';
        btn.disabled = true;
        try {
            const res = await api('/api/v1/provisioning/provision', {
                method: 'POST',
                body: JSON.stringify({ application_ref: applicationRef })
            });
            const cif = res.cif || {};
            const accs = res.accounts || [];
            panel.innerHTML = `
                <h3>✅ ${esc((res.cif && res.cif.company_name) || 'Corporate customer')} provisioned in core banking</h3>
                <div class="kv"><span class="k">CIF Number</span><span class="v mono">${esc(cif.cif_number)}</span></div>
                <div class="kv"><span class="k">Dedicated BIC</span><span class="v mono">${esc(res.dedicated_bic)}</span></div>
                <div class="kv"><span class="k">Company UID</span><span class="v mono">${esc(res.company_uid)}</span></div>
                ${accs.map(a => `
                    <div class="acc-row">
                        <strong>${esc(a.account_name || 'Corporate Checking')}</strong><br>
                        Account&nbsp;<span class="mono">${esc(a.account_number)}</span> ·
                        IBAN&nbsp;<span class="mono">${esc(a.iban)}</span><br>
                        ${esc(a.currency)} balance&nbsp;<strong>${Number(a.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
                        · status&nbsp;${esc(a.status)}
                    </div>`).join('')}
                <p style="margin-top:10px;font-size:12.5px;color:#93a1b8;">
                    The customer can now sign in to the Customer Portal and transact from these accounts.
                </p>`;
            toast('Core provisioning complete — CIF + account(s) + dedicated BIC created.');
            await refreshAll();
        } catch (err) {
            panel.innerHTML = `<h3 style="color:#fca5a5;">⚠️ Provisioning failed</h3><div style="font-size:13px;color:#fca5a5;">${esc(err.message)}</div>`;
            toast(err.message, true);
            btn.disabled = false;
        }
    }

    // ── Core customers view ──
    let customers = [];
    async function loadCustomers() {
        const grid = $('customersGrid');
        grid.innerHTML = '<div class="empty">Loading core customers…</div>';
        try {
            const res = await api('/api/v1/provisioning/customers');
            customers = res.customers || [];
            renderCustomers();
        } catch (err) {
            grid.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
        }
    }

    function renderCustomers() {
        const grid = $('customersGrid');
        if (customers.length === 0) {
            grid.innerHTML = '<div class="empty">No CIF records yet — provision an onboarded application from the Applications Queue.</div>';
            return;
        }
        grid.innerHTML = customers.map(c => `
            <div class="customer-card">
                <h3>${esc(c.company_name || c.trade_name || 'Corporate Customer')}</h3>
                <div class="uid mono">${esc(c.company_uid)}</div>
                <div class="kv"><span class="k">CIF Number</span><span class="v mono">${esc(c.cif_number)}</span></div>
                <div class="kv"><span class="k">Dedicated BIC</span><span class="v mono">${esc(c.dedicated_bic || '—')}</span></div>
                <div class="kv"><span class="k">KYC / Risk</span><span class="v">${esc(c.kyc_status || 'passed')} · ${esc(c.risk_rating || 'LOW')}</span></div>
                <div class="kv"><span class="k">Status</span><span class="v"><span class="badge ${esc(c.status || 'active')}">${esc(c.status || 'active')}</span></span></div>
                ${(c.accounts || []).map(a => `
                    <div class="acc-row">
                        <strong>${esc(a.account_name || 'Corporate Checking')}</strong><br>
                        Account&nbsp;<span class="mono">${esc(a.account_number)}</span> ·
                        IBAN&nbsp;<span class="mono">${esc(a.iban)}</span><br>
                        ${esc(a.currency)}&nbsp;<strong>${Number(a.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
                        · BIC&nbsp;<span class="mono">${esc(a.bic || c.dedicated_bic || '—')}</span>
                    </div>`).join('')}
            </div>
        `).join('');
    }

    async function viewProvisioned(companyUid) {
        if (!companyUid) return;
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'customers'));
        $('tab-applications').classList.add('hidden');
        $('tab-customers').classList.remove('hidden');
        await loadCustomers();
    }

    async function refreshAll() {
        await Promise.all([loadApplications(), loadCustomers()]);
        const approved = applications.filter(a => a.status === 'approved').length;
        const accountCount = customers.reduce((n, c) => n + ((c.accounts || []).length), 0);
        $('statApplications').textContent = applications.length;
        $('statApproved').textContent = approved;
        $('statCustomers').textContent = customers.length;
        $('statAccounts').textContent = accountCount;
    }

    // ── Wire-up ──
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            $('tab-applications').classList.toggle('hidden', tab.dataset.tab !== 'applications');
            $('tab-customers').classList.toggle('hidden', tab.dataset.tab !== 'customers');
        });
    });
    $('btnLogin').addEventListener('click', login);
    $('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    $('loginUser').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginPass').focus(); });
    $('btnLogout').addEventListener('click', () => { clearSession(); showLogin(); });
    $('btnRefreshApps').addEventListener('click', refreshAll);
    $('btnRefreshCustomers').addEventListener('click', refreshAll);

    if (getToken()) { showMain(); } else { showLogin(); }
})();
