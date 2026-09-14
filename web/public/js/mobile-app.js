/**
 * First National Bank Platform — Interactive Mobile Banking App Simulator (iPhone 16 Pro)
 * Powers the interactive smartphone preview, mobile FaceID biometric login,
 * virtual card carousel, mobile Base64 document camera scanner, and mobile wire transfers.
 */

(function () {
    const MobileApp = {
        isUnlocked: false,
        activeCardIndex: 0,
        activeSubView: 'home',
        summaryData: null,

        async init() {
            this.renderPhoneUI();
            this.setupListeners();
            await this.refreshData();
        },

        renderPhoneUI() {
            const container = document.getElementById('mobileScreenContent');
            if (!container) return;

            container.innerHTML = `
                <!-- Slide-down iOS Push Notification -->
                <div id="mobilePushToast" class="mobile-push-toast">
                    <div class="m-push-hdr">
                        <span id="mPushTitle" class="m-push-title">Gringotts Bank Security</span>
                        <span id="mPushTime" class="m-push-time">now</span>
                    </div>
                    <div id="mPushBody" class="m-push-body">Welcome to Gringotts Bank Mobile (Diagon Alley).</div>
                </div>

                <!-- 1. Biometric Lock Screen -->
                <div id="mLockView" class="m-lock-screen" style="display:${this.isUnlocked ? 'none' : 'flex'};">
                    <div class="m-lock-logo" aria-label="Gringotts Bank Logo">
                        <img src="/images/bank-logo-dragon.png?v=2" alt="Gringotts Bank Logo" class="m-lock-logo-img">
                    </div>
                    <h2 style="margin:0 0 4px;font-size:20px;font-weight:800;">Gringotts Mobile</h2>
                    <p style="color:#94a3b8;font-size:12px;margin:0 0 16px;">Diagon Alley &bull; Hogwarts Vaults &amp; Clearing</p>
                    
                    <div id="mobileFaceIdRadar" class="faceid-radar">
                        <span style="font-size:36px;">&#x1F464;</span>
                    </div>

                    <button type="button" id="mobileUnlockBioBtn" class="btn btn-primary" style="width:100%;border-radius:24px;padding:12px;font-weight:700;font-size:13px;" onclick="MobileApp.handleBiometricUnlock()">
                        👁️ Unlock with FaceID
                    </button>
                    <div style="font-size:10px;color:#64748b;margin-top:14px;text-align:center;">
                        Secure Biometric Verification Active
                    </div>
                </div>

                <!-- 2. Main Mobile Banking Interface -->
                <div id="mMainView" style="display:${this.isUnlocked ? 'flex' : 'none'};flex-direction:column;height:100%;">
                    
                    <!-- Top Bar inside phone -->
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                        <div>
                            <div style="font-size:10px;color:#94a3b8;font-weight:700;">CORPORATE CLIENT</div>
                            <div style="font-weight:800;font-size:14px;color:#f8fafc;" id="mClientName">Corporate Client</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <span style="background:rgba(16,185,129,0.2);color:#34d399;font-size:9px;padding:2px 6px;border-radius:10px;font-weight:800;">VIP GOLD</span>
                            <button type="button" class="btn-m-card-action" onclick="MobileApp.lockApp()" title="Lock phone" style="padding:2px 6px;">🔒</button>
                        </div>
                    </div>

                    <!-- SUBVIEW: HOME -->
                    <div id="mSub_home" class="m-subview active">
                        <!-- Primary Balance Card -->
                        <div class="mobile-balance-card">
                            <div class="mbc-shimmer"></div>
                            <div style="font-size:10px;color:rgba(255,255,255,0.8);font-weight:700;text-transform:uppercase;">Primary Treasury Account</div>
                            <div id="mPrimaryBalance" style="font-size:24px;font-weight:800;margin:6px 0;letter-spacing:-0.5px;">—</div>
                            <div id="mPrimaryIban" style="font-size:10px;color:rgba(255,255,255,0.85);font-family:monospace;">—</div>
                        </div>

                        <!-- Virtual Cards Carousel -->
                        <div class="m-cards-carousel">
                            <div class="m-cards-track" id="mCardsContainer">
                                <!-- Virtual Cards injected here -->
                            </div>
                            <div class="m-card-controls">
                                <div style="display:flex;gap:4px;">
                                    <button type="button" class="btn-m-card-action" onclick="MobileApp.revealCardDetails()">👁️ Details</button>
                                    <button type="button" class="btn-m-card-action" onclick="MobileApp.toggleFreezeCard()">❄️ Freeze</button>
                                </div>
                                <div style="display:flex;gap:4px;">
                                    <button type="button" class="btn-m-card-action" onclick="MobileApp.prevCard()">◀</button>
                                    <button type="button" class="btn-m-card-action" onclick="MobileApp.nextCard()">▶</button>
                                </div>
                            </div>
                        </div>

                        <!-- Quick Actions -->
                        <div class="mobile-quick-actions">
                            <button type="button" class="mq-btn" onclick="MobileApp.switchSubView('transfer')">
                                <span style="font-size:16px;">⚡</span>
                                <span>Send</span>
                            </button>
                            <button type="button" class="mq-btn" onclick="MobileApp.switchSubView('scanner')">
                                <span style="font-size:16px;">📷</span>
                                <span>KYC Scan</span>
                            </button>
                            <button type="button" class="mq-btn" onclick="MobileApp.switchSubView('fx')">
                                <span style="font-size:16px;">💱</span>
                                <span>Live FX</span>
                            </button>
                            <button type="button" class="mq-btn" onclick="MobileApp.showMobilePushNotification('E-Statement', 'March 2026 Audit Statement exported to PDF.')">
                                <span style="font-size:16px;">📑</span>
                                <span>Report</span>
                            </button>
                        </div>

                        <!-- Recent Mobile Activity -->
                        <div style="font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;">Recent Activity</div>
                        <div id="mTransactionsList" class="mobile-tx-list">
                            <!-- Populated dynamically -->
                        </div>
                    </div>

                    <!-- SUBVIEW: TRANSFER -->
                    <div id="mSub_transfer" class="m-subview">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
                            <button type="button" class="btn-m-card-action" onclick="MobileApp.switchSubView('home')">← Back</button>
                            <h4 style="margin:0;font-size:14px;color:#f8fafc;">Instant Mobile Wire</h4>
                        </div>

                        <form id="mTransferForm" onsubmit="MobileApp.handleMobileTransfer(event)">
                            <div class="field" style="margin-bottom:10px;">
                                <label style="font-size:10px;">Beneficiary Name</label>
                                <input type="text" id="mTransferBeneficiary" placeholder="DP World Logistics" style="padding:8px;font-size:12px;" required>
                            </div>
                            <div class="field" style="margin-bottom:10px;">
                                <label style="font-size:10px;">IBAN</label>
                                <input type="text" id="mTransferIbanInput" placeholder="AE44033000008892100412" style="padding:8px;font-size:12px;" required>
                            </div>
                            <div class="g2" style="margin-bottom:12px;gap:8px;">
                                <div class="field">
                                    <label style="font-size:10px;">Amount</label>
                                    <input type="number" step="0.01" id="mTransferAmountInput" placeholder="10000" style="padding:8px;font-size:12px;" required>
                                </div>
                                <div class="field">
                                    <label style="font-size:10px;">Currency</label>
                                    <select id="mTransferCurrencyInput" style="padding:8px;font-size:12px;">
                                        <option value="AED">AED</option>
                                        <option value="USD">USD</option>
                                    </select>
                                </div>
                            </div>
                            <button type="submit" id="btnMobileSend" class="btn btn-primary" style="width:100%;border-radius:16px;padding:10px;font-weight:700;font-size:13px;justify-content:center;">
                                ⚡ Send Wire Payment
                            </button>
                        </form>
                    </div>

                    <!-- SUBVIEW: SCANNER -->
                    <div id="mSub_scanner" class="m-subview">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
                            <button type="button" class="btn-m-card-action" onclick="MobileApp.switchSubView('home')">← Back</button>
                            <h4 style="margin:0;font-size:14px;color:#f8fafc;">KYC Document Scanner</h4>
                        </div>
                        <p style="font-size:11px;color:#94a3b8;margin:0 0 12px;">Capture and submit corporate documents securely.</p>

                        <div style="display:flex;gap:6px;margin-bottom:10px;">
                            <button type="button" class="btn-m-card-action" style="flex:1;padding:6px 4px;font-size:10px;" onclick="MobileApp.handleMobileScannerUpload('passport')">📸 Scan Passport</button>
                            <button type="button" class="btn-m-card-action" style="flex:1;padding:6px 4px;font-size:10px;" onclick="MobileApp.handleMobileScannerUpload('licence')">📑 Scan Licence</button>
                        </div>

                        <div class="field" style="margin-bottom:10px;">
                            <input type="file" accept="image/*,.pdf" style="font-size:11px;" onchange="if(this.files[0]) MobileApp.handleMobileScannerUpload(this.files[0])">
                        </div>

                        <div id="mScannerPreview" style="margin-top:6px;min-height:90px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.04);border-radius:10px;padding:8px;">
                            <span style="font-size:11px;color:#64748b;">Ready to scan document</span>
                        </div>
                        <div id="mScannerStatus"></div>
                    </div>

                    <!-- SUBVIEW: FX -->
                    <div id="mSub_fx" class="m-subview">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
                            <button type="button" class="btn-m-card-action" onclick="MobileApp.switchSubView('home')">← Back</button>
                            <h4 style="margin:0;font-size:14px;color:#f8fafc;">Live FX Rates Feed</h4>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <div class="mtx-item"><span>USD/AED</span> <strong style="color:#10b981;">3.6725</strong></div>
                            <div class="mtx-item"><span>EUR/AED</span> <strong style="color:#10b981;">4.0210</strong></div>
                            <div class="mtx-item"><span>GBP/AED</span> <strong style="color:#f43f5e;">4.7180</strong></div>
                            <div class="mtx-item"><span>SAR/AED</span> <strong style="color:#10b981;">0.9790</strong></div>
                            <div class="mtx-item"><span>EUR/USD</span> <strong style="color:#10b981;">1.0945</strong></div>
                        </div>
                    </div>

                    <!-- Bottom Nav Bar -->
                    <div class="m-bottom-nav" style="margin-top:auto;">
                        <button type="button" class="m-nav-btn active" data-view="home" onclick="MobileApp.switchSubView('home')">
                            <span>🏠</span>
                            <span>Home</span>
                        </button>
                        <button type="button" class="m-nav-btn" data-view="transfer" onclick="MobileApp.switchSubView('transfer')">
                            <span>⚡</span>
                            <span>Send</span>
                        </button>
                        <button type="button" class="m-nav-btn" data-view="scanner" onclick="MobileApp.switchSubView('scanner')">
                            <span>📷</span>
                            <span>Scan</span>
                        </button>
                        <button type="button" class="m-nav-btn" data-view="fx" onclick="MobileApp.switchSubView('fx')">
                            <span>💱</span>
                            <span>FX</span>
                        </button>
                    </div>
                </div>
            `;
        },

        setupListeners() {
            // Event listeners
        },

        async refreshData() {
            try {
                const res = await ApexApi.getMobileSummary();
                if (res.success) {
                    this.summaryData = res;
                    this.renderDashboardData(res);
                }
            } catch (err) {
                console.error('[MOBILE APP] Failed to load mobile summary:', err);
            }
        },

        renderDashboardData(data) {
            const balEl = document.getElementById('mPrimaryBalance');
            const ibanEl = document.getElementById('mPrimaryIban');
            const clientEl = document.getElementById('mClientName');

            if (balEl && data.primaryBalance) {
                balEl.textContent = 'AED ' + Number(data.primaryBalance.balance).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });
            }
            if (ibanEl && data.primaryBalance?.iban) {
                ibanEl.textContent = data.primaryBalance.iban;
            }
            if (clientEl && data.client?.name) {
                clientEl.textContent = data.client.name;
            }

            this.renderVirtualCards(data.virtualCards || []);
            this.renderMobileTransactions(data.recentTransactions || []);
        },

        renderVirtualCards(cards) {
            const container = document.getElementById('mCardsContainer');
            if (!container || cards.length === 0) return;

            container.innerHTML = cards.map((card, idx) => `
                <div class="m-card-item ${idx === this.activeCardIndex ? 'active' : ''}" style="background: ${card.gradient};" id="mCard_${idx}">
                    <div class="m-card-header">
                        <span class="m-card-badge">${card.type}</span>
                        <span class="m-card-chip">💳</span>
                    </div>
                    <div class="m-card-number" id="mCardNum_${idx}">${card.cardNumber}</div>
                    <div class="m-card-footer">
                        <div>
                            <div class="m-card-label">CARDHOLDER</div>
                            <div class="m-card-val">${card.cardholder}</div>
                        </div>
                        <div>
                            <div class="m-card-label">EXPIRES</div>
                            <div class="m-card-val">${card.expiry}</div>
                        </div>
                    </div>
                </div>
            `).join('');
        },

        nextCard() {
            const count = this.summaryData?.virtualCards?.length || 2;
            this.activeCardIndex = (this.activeCardIndex + 1) % count;
            this.updateCardVisibility();
        },

        prevCard() {
            const count = this.summaryData?.virtualCards?.length || 2;
            this.activeCardIndex = (this.activeCardIndex - 1 + count) % count;
            this.updateCardVisibility();
        },

        updateCardVisibility() {
            document.querySelectorAll('.m-card-item').forEach((el, idx) => {
                el.classList.toggle('active', idx === this.activeCardIndex);
            });
        },

        revealCardDetails() {
            const numEl = document.getElementById(`mCardNum_${this.activeCardIndex}`);
            if (!numEl) return;

            if (numEl.dataset.revealed === 'true') {
                numEl.textContent = '•••• •••• •••• 8842';
                numEl.dataset.revealed = 'false';
            } else {
                numEl.textContent = '4532 8901 2294 8842';
                numEl.dataset.revealed = 'true';
                setTimeout(() => {
                    if (numEl.dataset.revealed === 'true') {
                        numEl.textContent = '•••• •••• •••• 8842';
                        numEl.dataset.revealed = 'false';
                    }
                }, 8000);
            }
        },

        toggleFreezeCard() {
            const activeCardEl = document.getElementById(`mCard_${this.activeCardIndex}`);
            if (!activeCardEl) return;
            const isFrozen = activeCardEl.classList.toggle('frozen');

            if (isFrozen) {
                this.showMobilePushNotification('Card Frozen', 'Virtual card temporarily frozen for international transactions.');
            } else {
                this.showMobilePushNotification('Card Active', 'Virtual card unfrozen and active for clearing.');
            }
        },

        renderMobileTransactions(txs) {
            const container = document.getElementById('mTransactionsList');
            if (!container) return;

            if (txs.length === 0) {
                container.innerHTML = '<div style="text-align:center;padding:12px;color:#94a3b8;font-size:11px;">No transactions recorded yet</div>';
                return;
            }

            container.innerHTML = txs.slice(0, 4).map(tx => {
                const isCredit = tx.type === 'credit';
                const sign = isCredit ? '+' : '-';
                const color = isCredit ? '#10b981' : '#f43f5e';
                return `
                    <div class="mtx-item">
                        <div>
                            <div style="font-weight:700;font-size:12px;color:#f8fafc;">${tx.counterparty_name}</div>
                            <div style="font-size:10px;color:#94a3b8;">${new Date(tx.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} &bull; ${tx.channel || 'portal'}</div>
                        </div>
                        <div style="font-weight:800;font-size:12px;color:${color};font-family:monospace;">
                            ${sign} ${tx.currency} ${Number(tx.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </div>
                    </div>
                `;
            }).join('');
        },

        async handleBiometricUnlock() {
            const radar = document.getElementById('mobileFaceIdRadar');
            const bioBtn = document.getElementById('mobileUnlockBioBtn');

            if (radar) radar.classList.add('scanning');
            if (bioBtn) bioBtn.disabled = true;

            try {
                const res = await ApexApi.loginMobileBiometric();
                if (res.success) {
                    setTimeout(() => {
                        if (radar) radar.classList.remove('scanning');
                        this.isUnlocked = true;
                        const lockView = document.getElementById('mLockView');
                        const mainView = document.getElementById('mMainView');
                        if (lockView) lockView.style.display = 'none';
                        if (mainView) mainView.style.display = 'flex';
                        if (bioBtn) bioBtn.disabled = false;

                        if (typeof showToast === 'function') {
                            showToast('FaceID Verified. Logged in to Mobile Banking.', 'Biometric Auth', 'success', 3000);
                        }

                        this.showMobilePushNotification(
                            'FaceID Biometric Login Verified',
                            'Authenticated on iPhone 16 Pro simulator & session token issued.'
                        );
                    }, 700);
                }
            } catch (err) {
                if (radar) radar.classList.remove('scanning');
                if (bioBtn) bioBtn.disabled = false;
                if (typeof showToast === 'function') {
                    showToast('Biometric unlock failed: ' + err.message, 'Auth Error', 'error');
                }
            }
        },

        lockApp() {
            this.isUnlocked = false;
            const lockView = document.getElementById('mLockView');
            const mainView = document.getElementById('mMainView');
            if (lockView) lockView.style.display = 'flex';
            if (mainView) mainView.style.display = 'none';
        },

        switchSubView(viewName) {
            this.activeSubView = viewName;
            document.querySelectorAll('.m-subview').forEach(v => v.classList.remove('active'));
            const target = document.getElementById(`mSub_${viewName}`);
            if (target) target.classList.add('active');

            document.querySelectorAll('.m-nav-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.view === viewName);
            });
        },

        async handleMobileTransfer(e) {
            if (e) e.preventDefault();
            const btn = document.getElementById('btnMobileSend');
            const originalText = btn ? btn.innerHTML : '⚡ Send Wire Payment';

            const counterpartyName = document.getElementById('mTransferBeneficiary')?.value?.trim();
            const counterpartyIban = document.getElementById('mTransferIbanInput')?.value?.trim();
            const amount = document.getElementById('mTransferAmountInput')?.value;
            const currency = document.getElementById('mTransferCurrencyInput')?.value || 'AED';

            if (!counterpartyName || !counterpartyIban || !amount) {
                alert('Please enter Beneficiary Name, IBAN, and Amount');
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerHTML = 'Clearing via Central Bank...';
            }

            try {
                const res = await ApexApi.executeTransfer({
                    counterpartyName,
                    counterpartyIban,
                    amount: parseFloat(amount),
                    currency,
                    description: 'Mobile Corporate Payment',
                    channel: 'mobile'
                });

                if (res.success) {
                    this.showMobilePushNotification(
                        '⚡ Payment Sent Successfully',
                        `${currency} ${parseFloat(amount).toLocaleString()} sent to ${counterpartyName}. Ref: ${res.transaction.transaction_ref}`
                    );

                    // Reset form & return to home
                    document.getElementById('mTransferAmountInput').value = '';
                    this.switchSubView('home');

                    await this.refreshData();
                    if (window.LiveBanking && typeof window.LiveBanking.refreshAccounts === 'function') {
                        window.LiveBanking.refreshAccounts();
                        window.LiveBanking.refreshTransactions();
                    }
                }
            } catch (err) {
                alert(err.message || 'Mobile transfer failed.');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                }
            }
        },

        async handleMobileScannerUpload(fileOrPreset) {
            const previewContainer = document.getElementById('mScannerPreview');
            const statusEl = document.getElementById('mScannerStatus');

            if (statusEl) statusEl.innerHTML = '<span style="color:#38bdf8;font-size:11px;">🔄 Processing &amp; Uploading...</span>';

            if (fileOrPreset instanceof File) {
                const file = fileOrPreset;
                const reader = new FileReader();
                reader.onload = async (e) => {
                    await this.persistMobileDoc(e.target.result, file.name, 'mobile_kyc_document');
                };
                reader.readAsDataURL(file);
            } else if (fileOrPreset === 'passport') {
                const base64Data = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><rect width="400" height="260" fill="%231e293b" rx="12"/><rect x="15" y="15" width="370" height="230" fill="%230f172a" rx="8" stroke="%2338bdf8" stroke-width="2"/><text x="35" y="45" fill="%2338bdf8" font-family="sans-serif" font-weight="bold" font-size="16">PASSPORT / TRAVEL DOCUMENT</text><circle cx="65" cy="115" r="35" fill="%23334155"/><text x="65" y="122" fill="%2394a3b8" font-size="28" text-anchor="middle">&#x1F464;</text><text x="120" y="90" fill="%23f8fafc" font-family="sans-serif" font-size="14">Name: VANCE, ALEXANDER J</text><text x="120" y="115" fill="%23f8fafc" font-family="sans-serif" font-size="14">Nat: BRITISH (GBR)</text><text x="120" y="140" fill="%23f8fafc" font-family="sans-serif" font-size="14">Doc No: P98421054</text><rect x="30" y="180" width="340" height="45" fill="%23020617" rx="4"/><text x="40" y="200" fill="%2310b981" font-family="monospace" font-size="12">P&lt;GBRVANCE&lt;&lt;ALEXANDER&lt;JAMES&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;</text><text x="40" y="215" fill="%2310b981" font-family="monospace" font-size="12">P984210547GBR8406152M3106148&lt;&lt;&lt;&lt;&lt;&lt;&lt;02</text></svg>';
                await this.persistMobileDoc(base64Data, 'Executive_Passport_Scan.jpg', 'passport_scan');
            } else if (fileOrPreset === 'licence') {
                const base64Data = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><rect width="400" height="260" fill="%23064e3b" rx="12"/><rect x="15" y="15" width="370" height="230" fill="%23022c22" rx="8" stroke="%2310b981" stroke-width="2"/><text x="35" y="45" fill="%2334d399" font-family="sans-serif" font-weight="bold" font-size="16">COMMERCIAL TRADE LICENCE</text><text x="35" y="90" fill="%23f8fafc" font-family="sans-serif" font-size="14">Entity: First National Holdings Inc</text><text x="35" y="115" fill="%23f8fafc" font-family="sans-serif" font-size="14">CRN: 509077205 &bull; Det: Active</text><text x="35" y="140" fill="%23f8fafc" font-family="sans-serif" font-size="14">Authority: Delaware Division of Corporations</text><text x="35" y="165" fill="%23f8fafc" font-family="sans-serif" font-size="14">Status: Verified &bull; Expiry: 2028-11-30</text></svg>';
                await this.persistMobileDoc(base64Data, 'Corporate_Trade_Licence.jpg', 'trade_licence');
            }
        },

        async persistMobileDoc(base64Data, fileName, docType) {
            const previewContainer = document.getElementById('mScannerPreview');
            const statusEl = document.getElementById('mScannerStatus');

            if (previewContainer) {
                previewContainer.innerHTML = `<img src="${base64Data}" style="width:100%;max-height:110px;border-radius:6px;border:1px solid #38bdf8;object-fit:contain;" alt="Scanned Document">`;
            }

            try {
                const res = await ApexApi.uploadDocumentBase64({
                    docType,
                    fileName,
                    fileType: 'image/jpeg',
                    fileSize: base64Data.length,
                    base64Data
                });

                if (res.success) {
                    if (statusEl) {
                        statusEl.innerHTML = `
                            <div style="background:rgba(16,185,129,0.2);border:1px solid #10b981;border-radius:6px;padding:6px;margin-top:6px;text-align:center;">
                                <strong style="color:#10b981;font-size:11px;">🟢 Verified &amp; Saved</strong>
                                <div style="font-size:9px;color:#e2e8f0;margin-top:2px;">Reference: ${res.document.id}</div>
                            </div>
                        `;
                    }
                    this.showMobilePushNotification('Document Uploaded', `${fileName} verified and saved securely.`);
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.innerHTML = `<span style="color:#ef4444;font-size:10px;">Storage Error: ${err.message}</span>`;
                }
            }
        },

        showMobilePushNotification(title, body) {
            const toast = document.getElementById('mobilePushToast');
            const titleEl = document.getElementById('mPushTitle');
            const bodyEl = document.getElementById('mPushBody');
            const timeEl = document.getElementById('mPushTime');

            if (!toast) return;

            if (titleEl) titleEl.textContent = title;
            if (bodyEl) bodyEl.textContent = body;
            if (timeEl) timeEl.textContent = 'now';

            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 4500);
        }
    };

    window.MobileApp = MobileApp;
})();

