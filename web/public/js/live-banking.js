/**
 * First National Bank Platform — Live Core Banking & FX Controller
 * Manages real-time corporate balances, live FX rate feeds, instant wire transfers,
 * and SWIFT GPI transaction ledger.
 */

(function () {
    const LiveBanking = {
        accounts: [],
        transactions: [],
        fxRates: {},
        fxInterval: null,
        activeFilter: 'all',

        async init() {
            await this.refreshAccounts();
            await this.refreshTransactions();
            await this.refreshFxRates();
            this.startFxLiveTicker();
            this.setupEventListeners();
        },

        setupEventListeners() {
            const transferForm = document.getElementById('wireTransferForm') || document.querySelector('#liveBankingHub form');
            if (transferForm && !transferForm.dataset.bound) {
                transferForm.dataset.bound = 'true';
                transferForm.addEventListener('submit', (e) => this.handleWireTransferSubmit(e));
            }

            // Quick preset beneficiary buttons
            document.querySelectorAll('.btn-preset-beneficiary').forEach(btn => {
                btn.addEventListener('click', () => {
                    const name = btn.dataset.name;
                    const iban = btn.dataset.iban;
                    const nameInput = document.getElementById('wireRecipientName') || document.getElementById('transferBeneficiaryName');
                    const ibanInput = document.getElementById('wireRecipientIban') || document.getElementById('transferBeneficiaryIban');
                    if (nameInput) nameInput.value = name;
                    if (ibanInput) ibanInput.value = iban;
                });
            });
        },

        async refreshAccounts() {
            try {
                const res = await ApexApi.getAccounts();
                if (res.success && res.accounts) {
                    this.accounts = res.accounts;
                    this.renderAccounts(res.accounts, res.totalLiquidityAED);
                    this.populateAccountDropdown(res.accounts);
                }
            } catch (err) {
                console.error('[LIVE BANKING] Failed to fetch accounts:', err);
            }
        },
        loadAccounts() { return this.refreshAccounts(); },

        renderAccounts(accounts, totalLiquidity) {
            const container = document.getElementById('corpAccountsGrid') || document.getElementById('liveAccountsGrid');
            const totalLiquidityEl = document.getElementById('totalLiquidityDisplay') || document.getElementById('totalLiquidityValue');

            if (totalLiquidityEl && totalLiquidity) {
                totalLiquidityEl.textContent = 'AED ' + Number(totalLiquidity).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });
            }

            if (!container) return;

            const currencySymbols = { AED: 'AED', USD: '$', EUR: '€', GBP: '£' };
            const cardThemes = {
                AED: { cardClass: 'corp-card-indigo', grad: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 40%, #4338ca 100%)' },
                USD: { cardClass: 'corp-card-emerald', grad: 'linear-gradient(135deg, #064e3b 0%, #065f46 40%, #059669 100%)' },
                EUR: { cardClass: 'corp-card-violet', grad: 'linear-gradient(135deg, #1e293b 0%, #0f766e 50%, #0d9488 100%)' }
            };

            container.innerHTML = accounts.map(acc => {
                const sym = currencySymbols[acc.currency] || acc.currency;
                const theme = cardThemes[acc.currency] || { cardClass: 'corp-card-indigo', grad: 'linear-gradient(135deg, #1e293b, #334155)' };
                const balanceFormatted = Number(acc.balance).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });
                const availFormatted = Number(acc.available_balance || acc.balance).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });

                return `
                    <div class="corp-card ${theme.cardClass}" style="background: ${theme.grad};">
                        <div class="corp-card-header">
                            <div>
                                <span class="corp-card-type">${acc.account_type || 'Corporate Treasury'}</span>
                                <div style="font-size:16px;font-weight:700;color:#ffffff;margin-top:4px;">${acc.account_name}</div>
                            </div>
                            <span class="corp-card-curr">${acc.currency}</span>
                        </div>
                        <div class="corp-card-balance">
                            <div class="balance-amount">${sym} ${balanceFormatted}</div>
                            <div class="balance-avail">Available Liquidity: ${sym} ${availFormatted}</div>
                        </div>
                        <div class="corp-card-footer">
                            <span>IBAN: ${acc.iban}</span>
                            <button type="button" class="btn-copy-iban" onclick="LiveBanking.copyIban('${acc.iban}')" title="Copy IBAN">&#x1F4CB; Copy</button>
                        </div>
                    </div>
                `;
            }).join('');
        },

        populateAccountDropdown(accounts) {
            const select = document.getElementById('transferFromAccount');
            if (!select) return;

            select.innerHTML = accounts.map(acc => `
                <option value="${acc.account_number}">
                    ${acc.currency} — ${acc.account_name} (${acc.currency} ${Number(acc.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })})
                </option>
            `).join('');
        },

        copyIban(iban) {
            navigator.clipboard.writeText(iban).then(() => {
                if (typeof showToast === 'function') {
                    showToast(`IBAN copied: ${iban}`, 'Copied to Clipboard', 'success', 2000);
                }
            });
        },

        async refreshTransactions() {
            try {
                const res = await ApexApi.getTransactions();
                if (res.success && res.transactions) {
                    this.transactions = res.transactions;
                    this.renderTransactions();
                }
            } catch (err) {
                console.error('[LIVE BANKING] Failed to fetch transactions:', err);
            }
        },
        loadTransactions() { return this.refreshTransactions(); },

        renderTransactions() {
            const tableBody = document.getElementById('liveTxTableBody') || document.getElementById('transactionsTableBody');
            if (!tableBody) return;

            let filtered = this.transactions;
            if (this.activeFilter === 'credits') {
                filtered = filtered.filter(t => t.type === 'credit');
            } else if (this.activeFilter === 'debits') {
                filtered = filtered.filter(t => t.type === 'debit' || t.type === 'wire_transfer');
            } else if (this.activeFilter === 'mobile') {
                filtered = filtered.filter(t => t.channel === 'mobile');
            }

            if (filtered.length === 0) {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted);">
                            No transactions found matching this filter.
                        </td>
                    </tr>
                `;
                return;
            }

            tableBody.innerHTML = filtered.map(tx => {
                const isCredit = tx.type === 'credit';
                const sign = isCredit ? '+' : '-';
                const amountClass = isCredit ? 'tx-credit' : 'tx-debit';
                const dateStr = new Date(tx.timestamp).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });

                return `
                    <tr class="tx-row">
                        <td>
                            <div style="font-weight:600;color:var(--text-primary);">${tx.counterparty_name}</div>
                            <div style="font-size:11px;color:var(--text-muted);font-family:monospace;">${tx.counterparty_iban || 'Direct Clearing'}</div>
                        </td>
                        <td>
                            <span class="tx-category-badge">${tx.category || 'Commercial'}</span>
                        </td>
                        <td>
                            <span class="tx-channel-badge ${tx.channel === 'mobile' ? 'mobile-badge' : ''}">${tx.channel || 'portal'}</span>
                        </td>
                        <td style="text-align:right;">
                            <span class="${amountClass}">
                                ${sign} ${tx.currency} ${Number(tx.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                        </td>
                        <td>
                            <span style="font-size:11px;color:#34d399;font-weight:700;">● Settled</span>
                            <div style="font-size:10px;color:var(--text-muted);">${dateStr}</div>
                        </td>
                    </tr>
                `;
            }).join('');
        },

        setTransactionFilter(filter) {
            this.activeFilter = filter;
            document.querySelectorAll('.btn-tx-filter').forEach(btn => {
                if (btn.dataset.filter === filter) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
            this.renderTransactions();
        },

        async refreshFxRates() {
            try {
                const res = await ApexApi.getFxRates();
                if (res.success && res.rates) {
                    this.fxRates = res.rates;
                    this.renderFxStream(res.rates);
                }
            } catch (err) {
                console.error('[LIVE BANKING] Failed to fetch FX rates:', err);
            }
        },

        renderFxStream(rates) {
            const stream = document.getElementById('fxStreamTicker');
            if (!stream) return;

            stream.innerHTML = Object.values(rates).map(r => `
                <span class="fx-pair-item">
                    <span class="fx-pair-symbol">${r.pair}</span>
                    <span class="fx-pair-rate">${r.rate.toFixed(4)}</span>
                    <span class="${r.change24h.startsWith('-') ? 'fx-down' : 'fx-up'}">
                        ${r.change24h.startsWith('-') ? '▼' : '▲'} ${r.change24h}
                    </span>
                </span>
            `).join('');
        },

        startFxLiveTicker() {
            if (this.fxInterval) clearInterval(this.fxInterval);
            this.fxInterval = setInterval(() => {
                this.refreshFxRates();
            }, 7500);
        },

        async handleWireTransferSubmit(e) {
            if (e) e.preventDefault();
            const fromAccount = document.getElementById('transferFromAccount')?.value;
            const counterpartyName = (document.getElementById('wireRecipientName') || document.getElementById('transferBeneficiaryName'))?.value?.trim();
            const counterpartyIban = (document.getElementById('wireRecipientIban') || document.getElementById('transferBeneficiaryIban'))?.value?.trim();
            const amount = (document.getElementById('wireAmount') || document.getElementById('transferAmount'))?.value;
            const description = (document.getElementById('wireMemo') || document.getElementById('transferDescription'))?.value?.trim() || 'Commercial Settlement';

            if (!counterpartyName || !counterpartyIban || !amount) {
                if (typeof showToast === 'function') {
                    showToast('Please fill in Beneficiary Name, IBAN, and Amount.', 'Required Fields', 'warning');
                }
                return;
            }

            const submitBtn = document.querySelector('#liveBankingHub form button[type="submit"]') || document.getElementById('btnSubmitTransfer');
            const originalText = submitBtn ? submitBtn.innerHTML : '⚡ Authorize & Execute Wire';

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '🔄 Clearing with Fedwire FTS...';
            }

            try {
                const res = await ApexApi.executeTransfer({
                    fromAccount,
                    counterpartyName,
                    counterpartyIban,
                    amount: parseFloat(amount),
                    currency: 'AED',
                    description,
                    channel: 'portal'
                });

                if (res.success) {
                    if (typeof showToast === 'function') {
                        showToast(`Wire transfer of AED ${parseFloat(amount).toLocaleString()} settled via Central Bank FTS! Ref: ${res.transaction.transaction_ref}`, 'Payment Cleared', 'success', 5000);
                    }

                    // Reset form fields
                    const amtInput = document.getElementById('wireAmount') || document.getElementById('transferAmount');
                    if (amtInput) amtInput.value = '';
                    const memoInput = document.getElementById('wireMemo') || document.getElementById('transferDescription');
                    if (memoInput) memoInput.value = '';

                    // Refresh balances and transaction ledger
                    await this.refreshAccounts();
                    await this.refreshTransactions();

                    // If mobile simulator is open, update it
                    if (window.MobileApp && typeof window.MobileApp.refreshData === 'function') {
                        window.MobileApp.refreshData();
                    }
                }
            } catch (err) {
                if (typeof showToast === 'function') {
                    showToast(err.message || 'Transfer failed. Check account balance.', 'Transfer Error', 'error', 4000);
                }
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = originalText;
                }
            }
        },

        handleTransferSubmit(e) {
            return this.handleWireTransferSubmit(e);
        }
    };

    window.LiveBanking = LiveBanking;
})();
