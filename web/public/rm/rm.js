/**
 * First National Bank — Relationship Manager (RM) Executive Suite Client Logic
 * Handles executive authentication, customer invitation dispatch,
 * magic link generation, pipeline tracking, and email previews.
 */

let currentRmToken = localStorage.getItem("fnb_rm_token");
let currentRmProfile = null;
let pipelineData = [];

// Initialize on DOM Ready
document.addEventListener("DOMContentLoaded", () => {
    checkRmAuthSession();

    // Auto-dismiss login alerts on input
    const idInput = document.getElementById("rmStaffId");
    const pwdInput = document.getElementById("rmPassword");
    const hideAlert = () => {
        const alertBox = document.getElementById("rmLoginAlert");
        if (alertBox) alertBox.style.display = "none";
    };
    if (idInput) idInput.addEventListener("input", hideAlert);
    if (pwdInput) pwdInput.addEventListener("input", hideAlert);

    // Real-time duplicate CRN checking
    const inviteCrnInput = document.getElementById("inviteCrn");
    if (inviteCrnInput) {
        let crnTimer = null;
        inviteCrnInput.addEventListener("input", () => {
            clearTimeout(crnTimer);
            crnTimer = setTimeout(checkCrnInputAvailability, 280);
        });
        inviteCrnInput.addEventListener("blur", checkCrnInputAvailability);
    }

    // ── mal.ai INTERACTIVE 3D CARD TILT & GLARE TRACKING ──
    const rmLoginWrap = document.getElementById("rmLoginView");
    const rmCard = document.getElementById("rmLoginCard");
    const rmGlare = rmCard ? rmCard.querySelector(".rm-card-glare") : null;

    if (rmLoginWrap && rmCard) {
        rmLoginWrap.addEventListener("mousemove", (e) => {
            if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            const rect = rmCard.getBoundingClientRect();
            const cardX = rect.left + rect.width / 2;
            const cardY = rect.top + rect.height / 2;
            const mouseX = e.clientX - cardX;
            const mouseY = e.clientY - cardY;

            const rotateX = (-mouseY / (rect.height / 2)) * 4.5;
            const rotateY = (mouseX / (rect.width / 2)) * 4.5;

            rmCard.style.transform = `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateY(-2px)`;

            if (rmGlare) {
                const glarePos = Math.max(10, Math.min(90, ((e.clientX - rect.left) / rect.width) * 100));
                rmGlare.style.background = `linear-gradient(90deg, transparent, rgba(0, 210, 255, 0.4) ${glarePos - 25}%, rgba(255, 255, 255, 0.9) ${glarePos}%, rgba(0, 210, 255, 0.4) ${glarePos + 25}%, transparent)`;
            }
        });

        rmLoginWrap.addEventListener("mouseleave", () => {
            rmCard.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0px)";
            if (rmGlare) {
                rmGlare.style.background = "linear-gradient(90deg, transparent, rgba(0, 210, 255, 0.65), rgba(255, 255, 255, 0.85), rgba(0, 210, 255, 0.65), transparent)";
            }
        });
    }

    // Initialize 3D Tilt for all Dashboard Cards & Metrics
    initRmCardsTilt();
});

function initRmCardsTilt() {
    const cards = document.querySelectorAll(".rm-card, .rm-metric-card, .rm-modal-card");
    cards.forEach(card => {
        if (card._hasTiltListener) return;
        card._hasTiltListener = true;

        card.addEventListener("mousemove", (e) => {
            if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            const rect = card.getBoundingClientRect();
            const cardX = rect.left + rect.width / 2;
            const cardY = rect.top + rect.height / 2;
            const mouseX = e.clientX - cardX;
            const mouseY = e.clientY - cardY;

            const rotateX = (-mouseY / (rect.height / 2)) * 2.5;
            const rotateY = (mouseX / (rect.width / 2)) * 2.5;

            card.style.transform = `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateY(-3px)`;
        });

        card.addEventListener("mouseleave", () => {
            card.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0px)";
        });
    });
}

// ── TOAST NOTIFICATIONS ──
function showRmToast(message, type = "success") {
    const container = document.getElementById("rmToastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `rm-toast ${type}`;
    const icon = type === "success" ? "&#x2705;" : (type === "error" ? "&#x274C;" : "&#x2139;");
    toast.innerHTML = `<span style="font-size:16px;">${icon}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(40px)";
        toast.style.transition = "all 0.3s ease";
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ── AUTHENTICATED FETCH HELPER ──
async function rmFetch(url, options = {}) {
    options.headers = options.headers || {};
    const token = currentRmToken || localStorage.getItem("fnb_rm_token");
    if (token) {
        options.headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(url, options);
    if (res.status === 401) {
        handleRmSignOut();
        showRmToast("RM Executive session expired. Please sign in again.", "error");
        throw new Error("Unauthorized: RM session expired.");
    }
    return res;
}

// ── AUTHENTICATION ──
function checkRmAuthSession() {
    if (currentRmToken) {
        try {
            const cachedProfile = localStorage.getItem("fnb_rm_profile");
            if (cachedProfile) {
                currentRmProfile = JSON.parse(cachedProfile);
                showDashboardView();
                return;
            }
        } catch (e) {}
    }
    showLoginView();
}

function showLoginView() {
    const loginView = document.getElementById("rmLoginView");
    const dashView = document.getElementById("rmDashboardView");
    if (loginView) loginView.style.display = "flex";
    if (dashView) dashView.style.display = "none";
}

function showDashboardView() {
    const loginView = document.getElementById("rmLoginView");
    const dashView = document.getElementById("rmDashboardView");
    if (loginView) loginView.style.display = "none";
    if (dashView) dashView.style.display = "flex";

    if (currentRmProfile) {
        const nameEl = document.getElementById("rmTopName");
        const roleEl = document.getElementById("rmTopRole");
        if (nameEl) nameEl.textContent = currentRmProfile.name || "Phanee";
        if (roleEl) roleEl.textContent = currentRmProfile.role || "Senior Relationship Manager \u00B7 Corporate Banking";
    }

    fetchInvitations();
    initRmCardsTilt();

    // Start real-time pipeline polling for live step and status sync
    if (!window._rmPipelinePoll) {
        window._rmPipelinePoll = setInterval(() => {
            const dashView = document.getElementById("rmDashboardView");
            if (dashView && dashView.style.display !== "none") {
                fetchInvitations();
            }
        }, 3000);
    }
}

async function handleRmLoginSubmit(ev) {
    ev.preventDefault();
    const staffId = document.getElementById("rmStaffId").value;
    const password = document.getElementById("rmPassword").value;
    const alertBox = document.getElementById("rmLoginAlert");

    try {
        const res = await fetch("/api/v1/rm/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ staffId, password })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || "Authentication failed.");
        }

        currentRmToken = data.token;
        currentRmProfile = data.profile;
        localStorage.setItem("fnb_rm_token", currentRmToken);
        localStorage.setItem("fnb_rm_profile", JSON.stringify(currentRmProfile));

        showRmToast(`Executive session authenticated. Welcome back, ${currentRmProfile.name || 'Phanee'}.`, "success");
        showDashboardView();
    } catch (err) {
        if (alertBox) {
            alertBox.className = "rm-alert-box error";
            alertBox.innerHTML = `
                <div style="display:flex;align-items:flex-start;gap:8px;justify-content:space-between;">
                    <div>
                        <strong style="color:#fca5a5;display:block;margin-bottom:2px;font-size:13px;">&#x26A0; Authentication Notice</strong>
                        <span style="color:#e2e8f0;font-size:12px;line-height:1.4;">${err.message}</span>
                    </div>
                    <button type="button" onclick="document.getElementById('rmLoginAlert').style.display='none'" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;line-height:1;">&times;</button>
                </div>
            `;
            alertBox.style.display = "block";
        }
    }
}

function toggleRmPasswordVisibility() {
    const pwdInput = document.getElementById("rmPassword");
    const eyeIcon = document.getElementById("pwdEyeIcon");
    const toggleText = document.getElementById("pwdToggleText");
    if (!pwdInput) return;
    if (pwdInput.type === "password") {
        pwdInput.type = "text";
        if (eyeIcon) eyeIcon.textContent = "🙈";
        if (toggleText) toggleText.textContent = "Hide Password";
    } else {
        pwdInput.type = "password";
        if (eyeIcon) eyeIcon.textContent = "👁️";
        if (toggleText) toggleText.textContent = "Show Password";
    }
}

function handleRmSignOut() {
    localStorage.removeItem("fnb_rm_token");
    localStorage.removeItem("fnb_rm_profile");
    currentRmToken = null;
    currentRmProfile = null;
    showLoginView();
    showRmToast("RM Executive Session terminated.", "info");
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ── REAL-TIME CRN AVAILABILITY CHECK ──
async function checkCrnInputAvailability() {
    const crnInput = document.getElementById("inviteCrn");
    const feedback = document.getElementById("crnFeedback");
    const hint = document.getElementById("crnHint");
    if (!crnInput || !feedback) return;

    const val = crnInput.value.trim().toUpperCase();
    if (!val) {
        feedback.style.display = "none";
        feedback.innerHTML = "";
        crnInput.classList.remove("is-invalid", "is-valid");
        if (hint) hint.style.display = "block";
        return;
    }

    // 1. Instant local check against loaded pipelineData
    const localMatch = pipelineData.find(inv => (inv.crn || "").trim().toUpperCase() === val);
    if (localMatch) {
        crnInput.classList.add("is-invalid");
        crnInput.classList.remove("is-valid");
        feedback.style.display = "block";
        feedback.className = "crn-feedback error";
        feedback.innerHTML = `⚠️ <strong>Duplicate CRN:</strong> Already registered for <strong>${escapeHtml(localMatch.company_name || 'Existing Client')}</strong> (${escapeHtml(localMatch.email || '')}). Use 'Update Details' or 'Resend' in the pipeline table below.`;
        if (hint) hint.style.display = "none";
        return;
    }

    // 2. Server verification check
    try {
        const res = await rmFetch(`/api/v1/rm/check-crn/${encodeURIComponent(val)}`);
        const data = await res.json();
        if (data.exists && data.existing) {
            crnInput.classList.add("is-invalid");
            crnInput.classList.remove("is-valid");
            feedback.style.display = "block";
            feedback.className = "crn-feedback error";
            feedback.innerHTML = `⚠️ <strong>Duplicate CRN:</strong> Already registered for <strong>${escapeHtml(data.existing.company_name || 'Corporate Entity')}</strong> (${escapeHtml(data.existing.email || '')}).`;
            if (hint) hint.style.display = "none";
        } else {
            crnInput.classList.remove("is-invalid");
            crnInput.classList.add("is-valid");
            feedback.style.display = "block";
            feedback.className = "crn-feedback success";
            feedback.innerHTML = `✓ CRN <strong>${escapeHtml(val)}</strong> is available for new invitation`;
            if (hint) hint.style.display = "none";
        }
    } catch (e) {
        // Silently continue if network check fails
    }
}

// ── CUSTOMER INVITATION DISPATCH ──
async function handleDispatchInvite(ev) {
    ev.preventDefault();

    const crn = document.getElementById("inviteCrn").value.trim();
    const email = document.getElementById("inviteEmail").value.trim();
    const companyName = document.getElementById("inviteCompany").value.trim();
    const tradeName = (document.getElementById("inviteTrade")?.value || "").trim();
    const contactPerson = document.getElementById("inviteContact").value.trim();
    const phone = document.getElementById("invitePhone").value.trim();
    const notes = document.getElementById("inviteNotes").value.trim();

    const cleanCrn = crn.toUpperCase();
    const crnInput = document.getElementById("inviteCrn");
    const feedback = document.getElementById("crnFeedback");

    // Client-side pre-check against loaded pipeline data
    const localExisting = pipelineData.find(inv => (inv.crn || "").trim().toUpperCase() === cleanCrn);
    if (localExisting) {
        showRmToast(`Duplicate CRN: "${cleanCrn}" already exists for ${localExisting.company_name || 'Client'}. Please use 'Update Details' or 'Resend' in the pipeline table below.`, "error");
        if (crnInput) {
            crnInput.classList.add("is-invalid");
            crnInput.classList.remove("is-valid");
            crnInput.focus();
        }
        if (feedback) {
            feedback.style.display = "block";
            feedback.className = "crn-feedback error";
            feedback.innerHTML = `⚠️ <strong>Duplicate CRN:</strong> Already registered for <strong>${escapeHtml(localExisting.company_name || 'Client')}</strong> (${escapeHtml(localExisting.email || '')}). Use 'Update Details' or 'Resend' instead.`;
        }
        return;
    }

    const submitBtn = document.getElementById("btnDispatchInvite");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = "<span class=\"btn-label\">&#x23F3; Issuing Corporate Invitation &amp; Generating Link&hellip;</span>";
    }

    try {
        const res = await rmFetch("/api/v1/rm/invite", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                crn,
                email,
                companyName,
                tradeName,
                contactPerson,
                phone,
                notes
            })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            if (data.code === "DUPLICATE_CRN" || res.status === 409) {
                if (crnInput) {
                    crnInput.classList.add("is-invalid");
                    crnInput.classList.remove("is-valid");
                    crnInput.focus();
                }
                if (feedback) {
                    feedback.style.display = "block";
                    feedback.className = "crn-feedback error";
                    feedback.innerHTML = `⚠️ <strong>Duplicate CRN:</strong> ${escapeHtml(data.error || 'An onboarding record already exists for this CRN.')}`;
                }
            }
            throw new Error(data.error || "Failed to issue corporate onboarding invitation.");
        }

        // Show Success Box with generated link
        displayGeneratedInvite(data.invitation, data.inviteLink);
        showRmToast(`Corporate onboarding invitation issued to ${email} for CRN ${crn}.`, "success");

        if (crnInput) {
            crnInput.classList.remove("is-invalid", "is-valid");
        }
        if (feedback) {
            feedback.style.display = "none";
            feedback.innerHTML = "";
        }

        // Refresh pipeline table
        fetchInvitations();
    } catch (err) {
        showRmToast(err.message, "error");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = "<span class=\"btn-label\">Issue Corporate Onboarding Invitation &amp; Access Link &rarr;</span>";
        }
    }
}

function displayGeneratedInvite(invitation, inviteLink) {
    const successCard = document.getElementById("inviteSuccessCard");
    const linkInput = document.getElementById("generatedLinkInput");
    const btnTest = document.getElementById("btnTestCustomerLink");
    const chipCrn = document.getElementById("chipCrn");
    const chipCuid = document.getElementById("chipCuid");
    const chipEmail = document.getElementById("chipEmail");

    if (linkInput) linkInput.value = inviteLink;
    if (btnTest) btnTest.href = inviteLink;
    if (chipCrn) chipCrn.textContent = invitation.crn;
    if (chipCuid) chipCuid.textContent = invitation.company_uid || ('CUID-' + (invitation.crn || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (chipEmail) chipEmail.textContent = invitation.email;

    if (successCard) {
        successCard.style.display = "block";
        successCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
}

function copyGeneratedLink() {
    const input = document.getElementById("generatedLinkInput");
    if (!input || !input.value) return;

    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
        showRmToast("Customer Onboarding Access Link copied to clipboard!", "success");
    }).catch(() => {
        document.execCommand("copy");
        showRmToast("Customer Link copied!", "success");
    });
}

function resetInviteForm() {
    document.getElementById("rmInviteForm").reset();
    const successCard = document.getElementById("inviteSuccessCard");
    if (successCard) successCard.style.display = "none";
    const feedback = document.getElementById("crnFeedback");
    if (feedback) {
        feedback.style.display = "none";
        feedback.innerHTML = "";
    }
    const crnInput = document.getElementById("inviteCrn");
    if (crnInput) {
        crnInput.classList.remove("is-invalid", "is-valid");
    }
    const hint = document.getElementById("crnHint");
    if (hint) {
        hint.style.display = "block";
    }
}

function focusInviteForm() {
    const section = document.getElementById("dispatchSection");
    if (section) section.scrollIntoView({ behavior: "smooth" });
    const crnInput = document.getElementById("inviteCrn");
    if (crnInput) crnInput.focus();
}

// ── PIPELINE & INVITATIONS TABLE ──
async function fetchInvitations() {
    const tbody = document.getElementById("pipelineTableBody");
    try {
        const res = await rmFetch("/api/v1/rm/invitations");
        const data = await res.json();
        if (data.success && Array.isArray(data.invitations)) {
            pipelineData = data.invitations;
            renderPipelineTable(pipelineData);
            updatePipelineMetrics(pipelineData);
        }
    } catch (err) {
        console.error("[RM] Failed to load pipeline:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#f87171;padding:24px;">Failed to load live pipeline. Click Refresh to retry.</td></tr>`;
        }
    }
}

function renderPipelineTable(invitations) {
    const tbody = document.getElementById("pipelineTableBody");
    if (!tbody) return;

    if (invitations.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align:center; padding:36px; color:var(--rm-text-muted);">
                    No customer invitations found. Use the dispatcher above to issue an onboarding link.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = invitations.map((inv, idx) => {
        const dateStr = inv.created_at ? new Date(inv.created_at).toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }) : "Recently";

        // Canonical 3-stage journey: Link Initiated → In Progress / Under Review → Account Activated
        const coreDone = inv.core_provisioned === true || inv.core_provisioned === 'true';
        const canonical = coreDone || ["completed", "approved", "account_activated"].includes(inv.status)
            ? "account_activated"
            : (["invited", "link_initiated"].includes(inv.status) ? "link_initiated" : "in_progress_under_review");

        const statusClass = canonical;
        const statusLabel = canonical === "account_activated" ? "&#x2705; Account Activated" :
                           (canonical === "link_initiated" ? "&#x1F517; Link Initiated" : "&#x23F3; In Progress / Under Review");

        const stepText = inv.current_step ? `Step ${inv.current_step} of 7` : "Step 1 of 7";
        const cuid = inv.company_uid || ('CUID-' + (inv.crn || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));

        return `
            <tr>
                <td>
                    <span style="color:#f59e0b; font-family:monospace; font-weight:700; font-size:11.5px; background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.25); padding:2px 6px; border-radius:4px;">${cuid}</span>
                </td>
                <td>
                    <strong style="color:#ffffff; font-family:monospace; font-size:13px;">${inv.crn}</strong>
                </td>
                <td>
                    <div style="font-weight:700; color:#ffffff;">${inv.company_name}</div>
                    <div style="font-size:12px; color:var(--rm-text-muted);">&#x1F464; ${inv.contact_person || 'Signatory'}</div>
                </td>
                <td>
                    <span style="color:#93c5fd;">${inv.email}</span>
                    ${inv.phone ? `<div style="font-size:11.5px; color:var(--rm-text-muted);">&#x1F4DE; ${inv.phone}</div>` : ''}
                </td>
                <td>
                    <span style="font-size:12px; font-weight:600; color:#e2e8f0;">${stepText}</span>
                    ${inv.application_ref ? `<div style="font-size:10.5px; color:#38bdf8;">${inv.application_ref}</div>` : ''}
                </td>
                <td>
                    <span class="rm-badge ${statusClass}">${statusLabel}</span>
                </td>
                <td style="color:var(--rm-text-muted); font-size:12px;">
                    ${dateStr}
                </td>
                <td style="text-align:right;">
                    <div class="rm-action-btns">
                        <button class="rm-btn-action" onclick="openUpdateDetailsByIndex(${idx})" style="color:#38bdf8;" title="Update Customer Email &amp; Details">
                            &#x270F;&#xFE0F; Update Details
                        </button>
                        <button class="rm-btn-action" onclick="resendInvite('${encodeURIComponent(inv.crn)}', '${encodeURIComponent(inv.email)}')" style="color:#10b981;" title="Resend Notification Email">
                            &#x2709; Resend
                        </button>
                        <button class="rm-btn-action delete" onclick="deleteInvite('${encodeURIComponent(inv.crn)}', '${encodeURIComponent(inv.email)}')" title="Revoke Invitation">
                            &#x2715;
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}

function updatePipelineMetrics(invitations) {
    const total = invitations.length;
    let inProgress = 0;
    let inReview = 0;
    let activated = 0;

    // Canonical 3-stage journey buckets
    let linkInitiated = 0;
    invitations.forEach(inv => {
        if (inv.journey_status === "account_activated") activated++;
        else if (inv.journey_status === "link_initiated") linkInitiated++;
        else inProgress++; // in_progress_under_review
    });
    inReview = linkInitiated;

    const mTotal = document.getElementById("metricTotalInvited");
    const mProg = document.getElementById("metricInProgress");
    const mRev = document.getElementById("metricInReview");
    const mAct = document.getElementById("metricActivated");

    if (mTotal) mTotal.textContent = total;
    if (mProg) mProg.textContent = inProgress;
    if (mRev) mRev.textContent = inReview;
    if (mAct) mAct.textContent = activated;
}

function filterPipelineTable() {
    const searchVal = document.getElementById("pipelineSearch").value.toLowerCase().trim();
    if (!searchVal) {
        renderPipelineTable(pipelineData);
        return;
    }

    const filtered = pipelineData.filter(inv => 
        (inv.crn && inv.crn.toLowerCase().includes(searchVal)) ||
        (inv.email && inv.email.toLowerCase().includes(searchVal)) ||
        (inv.company_name && inv.company_name.toLowerCase().includes(searchVal)) ||
        (inv.contact_person && inv.contact_person.toLowerCase().includes(searchVal)) ||
        (inv.status && inv.status.toLowerCase().includes(searchVal))
    );

    renderPipelineTable(filtered);
}

function openUpdateDetailsByIndex(idx) {
    const inv = pipelineData[idx];
    if (!inv) return;
    const crnInput = document.getElementById("editCrn");
    const emailInput = document.getElementById("editEmail");
    const compInput = document.getElementById("editCompany");
    const contactInput = document.getElementById("editContact");
    const phoneInput = document.getElementById("editPhone");
    const origCrn = document.getElementById("editOriginalCrn");
    const origEmail = document.getElementById("editOriginalEmail");

    if (origCrn) origCrn.value = inv.crn || '';
    if (origEmail) origEmail.value = inv.email || '';
    if (crnInput) crnInput.value = inv.crn || '';
    if (emailInput) emailInput.value = inv.email || '';
    if (compInput) compInput.value = inv.company_name || '';
    if (contactInput) contactInput.value = inv.contact_person || '';
    if (phoneInput) phoneInput.value = inv.phone || '';

    const modal = document.getElementById("updateDetailsModal");
    if (modal) modal.style.display = "flex";
}

function closeUpdateDetailsModal(ev) {
    if (ev && ev.target && ev.target.id !== "updateDetailsModal") return;
    const modal = document.getElementById("updateDetailsModal");
    if (modal) modal.style.display = "none";
}

async function handleUpdateDetailsSubmit(ev) {
    ev.preventDefault();
    const originalCrn = document.getElementById("editOriginalCrn").value;
    const originalEmail = document.getElementById("editOriginalEmail").value;
    const newEmail = document.getElementById("editEmail").value.trim();
    const companyName = document.getElementById("editCompany").value.trim();
    const contactPerson = document.getElementById("editContact").value.trim();
    const phone = document.getElementById("editPhone").value.trim();
    const resendImmediate = document.getElementById("editResendImmediate").checked;

    const btn = document.getElementById("btnSaveUpdatedDetails");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = "&#x23F3; Updating Customer Details&hellip;";
    }

    try {
        const res = await rmFetch("/api/v1/rm/update-details", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                originalCrn,
                originalEmail,
                newEmail,
                companyName,
                contactPerson,
                phone,
                resendImmediate
            })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || "Failed to update customer details.");
        }

        showRmToast(data.message || "Customer details updated successfully.", "success");
        closeUpdateDetailsModal();
        fetchInvitations();
    } catch (err) {
        showRmToast(err.message, "error");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = "&#x1F4BE; Save &amp; Update Customer";
        }
    }
}

async function resendInvite(rawCrn, rawEmail) {
    const crn = decodeURIComponent(rawCrn);
    const email = decodeURIComponent(rawEmail);
    showRmToast(`Dispatching invitation email to ${email}...`, "info");
    try {
        const res = await rmFetch(`/api/v1/rm/resend/${encodeURIComponent(crn)}/${encodeURIComponent(email)}`, {
            method: "POST"
        });
        const data = await res.json();
        if (data.success) {
            showRmToast(data.message || `Invitation email successfully re-dispatched to ${email}.`, "success");
            fetchInvitations();
        } else {
            throw new Error(data.error || "Failed to resend invitation.");
        }
    } catch (err) {
        showRmToast(err.message, "error");
    }
}

async function deleteInvite(crn, email) {
    if (!confirm(`Are you sure you want to revoke the onboarding invitation for CRN ${crn} (${email})?`)) {
        return;
    }

    try {
        const res = await rmFetch(`/api/v1/rm/invitations/${encodeURIComponent(crn)}/${encodeURIComponent(email)}`, {
            method: "DELETE"
        });
        const data = await res.json();
        if (data.success) {
            showRmToast("Invitation revoked successfully.", "info");
            fetchInvitations();
        } else {
            throw new Error(data.error || "Failed to revoke.");
        }
    } catch (err) {
        showRmToast(err.message, "error");
    }
}

function closeEmailPreview() {
    const modal = document.getElementById("emailPreviewModal");
    if (modal) modal.style.display = "none";
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

let activeRmAuditTarget = { companyUid: "", crn: "", companyName: "" };

async function openRmAuditModal(companyUid, crn, companyName) {
    activeRmAuditTarget = { companyUid, crn, companyName };
    const modal = document.getElementById("rmAuditModal");
    if (!modal) return;
    modal.style.display = "flex";

    const titleEl = document.getElementById("rmAuditTitle");
    const subEl = document.getElementById("rmAuditSub");
    if (titleEl) titleEl.innerHTML = `Audit Trail: <strong>${escapeHtml(companyName || crn)}</strong> <span style="font-size:12px; color:#f59e0b; font-family:monospace; margin-left:8px;">${companyUid}</span>`;
    if (subEl) subEl.textContent = `Activity and verification history for CRN ${crn}`;

    await refreshRmAudit();
}

function closeRmAuditModal(ev) {
    const modal = document.getElementById("rmAuditModal");
    if (modal) modal.style.display = "none";
}

async function refreshRmAudit() {
    const content = document.getElementById("rmAuditContent");
    const countEl = document.getElementById("rmAuditCount");
    if (!content) return;

    content.innerHTML = `<div style="text-align:center; padding:32px; color:var(--rm-text-muted);">Loading activity and audit history...</div>`;

    try {
        const { companyUid, crn } = activeRmAuditTarget;
        const q = companyUid ? `company_uid=${encodeURIComponent(companyUid)}` : `crn=${encodeURIComponent(crn)}`;
        const res = await rmFetch(`/api/v1/rm/audit-trail?${q}`);
        const data = await res.json();

        const logs = data.auditTrail || [];
        if (countEl) countEl.textContent = logs.length;
        renderRmAuditTrail(logs);
    } catch (err) {
        content.innerHTML = `<div style="text-align:center; padding:24px; color:#f87171;">Failed to load audit trail: ${escapeHtml(err.message || String(err))}</div>`;
    }
}

function renderRmAuditTrail(logs) {
    const content = document.getElementById("rmAuditContent");
    if (!content) return;

    if (!logs || logs.length === 0) {
        content.innerHTML = `<div style="text-align:center; padding:36px; color:var(--rm-text-muted);">No audit events recorded for this entity yet.</div>`;
        return;
    }

    const actionColors = {
        CUSTOMER_LOGIN: '#38bdf8',
        CUSTOMER_OTP_REQUESTED: '#f59e0b',
        APPLICATION_SAVE: '#10b981',
        APPLICATION_SUBMITTED: '#a855f7',
        STEP_PROGRESSION: '#06b6d4',
        DOCUMENT_UPLOADED: '#ec4899',
        INVITATION_DISPATCHED: '#eab308',
        INVITATION_RESENT: '#38bdf8',
        DB_SYNC: '#60a5fa',
        PIPELINE_SYNC: '#60a5fa'
    };

    const actionLabels = {
        CUSTOMER_LOGIN: 'Client Login',
        CUSTOMER_OTP_REQUESTED: 'Security Code Sent',
        APPLICATION_SAVE: 'Application Saved',
        APPLICATION_SUBMITTED: 'Application Submitted',
        STEP_PROGRESSION: 'Step Completed',
        DOCUMENT_UPLOADED: 'Document Uploaded',
        INVITATION_DISPATCHED: 'Invitation Sent',
        INVITATION_RESENT: 'Invitation Re-sent',
        DB_SYNC: 'Records Synchronized',
        PIPELINE_SYNC: 'Pipeline Synchronized'
    };

    const tableHtml = `
        <table class="rm-table" style="font-size:12px;">
            <thead>
                <tr>
                    <th>Timestamp</th>
                    <th>Channel</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Target / Step</th>
                    <th>Status</th>
                    <th>IP &amp; Device</th>
                </tr>
            </thead>
            <tbody>
                ${logs.map(l => {
                    const timeStr = l.timestamp || l.created_at || '';
                    const formatted = timeStr ? new Date(timeStr).toLocaleString('en-GB', {
                        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                    }) : '-';
                    const channelBadge = l.channel === 'mobile' 
                        ? `<span style="background:rgba(168,85,247,0.15); border:1px solid rgba(168,85,247,0.3); color:#c084fc; font-weight:600; padding:2px 6px; border-radius:4px; font-size:11px;">📱 Mobile</span>`
                        : `<span style="background:rgba(56,189,248,0.15); border:1px solid rgba(56,189,248,0.3); color:#38bdf8; font-weight:600; padding:2px 6px; border-radius:4px; font-size:11px;">💻 Web</span>`;
                    const color = actionColors[l.action_type] || '#94a3b8';
                    const displayAction = actionLabels[l.action_type] || (l.action_type ? l.action_type.replace(/_/g, ' ') : 'Activity');
                    const statusStr = (l.status === 'SUCCESS' || !l.status)
                        ? `<span style="color:#10b981; font-weight:600;">✓ SUCCESS</span>`
                        : `<span style="color:#ef4444; font-weight:600;">✕ ${escapeHtml(l.status)}</span>`;
                    const metaStr = l.metadata ? (typeof l.metadata === 'object' ? Object.entries(l.metadata).map(([k,v]) => `${k}:${v}`).join(', ') : String(l.metadata)) : '';

                    return `
                        <tr>
                            <td style="font-family:monospace; color:#cbd5e1; white-space:nowrap;">${formatted}</td>
                            <td>${channelBadge}</td>
                            <td>
                                <span style="font-weight:700; color:${color};">${escapeHtml(displayAction)}</span>
                                ${metaStr ? `<div style="font-size:10.5px; color:var(--rm-text-muted); max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(metaStr)}">${escapeHtml(metaStr)}</div>` : ''}
                            </td>
                            <td style="color:#e2e8f0; font-family:monospace;">${escapeHtml(l.actor || '-')}</td>
                            <td style="color:var(--rm-text-muted);">${escapeHtml(l.target || l.event_type || '-')}</td>
                            <td>${statusStr}</td>
                            <td style="font-family:monospace; font-size:11px; color:var(--rm-text-muted);">
                                <div>${escapeHtml(l.ip_address || '127.0.0.1')}</div>
                                <div style="font-size:10px; color:#475569; max-width:140px; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(l.user_agent || '')}">${escapeHtml((l.user_agent || '').substring(0, 22))}</div>
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;

    content.innerHTML = tableHtml;
}
