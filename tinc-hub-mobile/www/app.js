/**
 * TincNote Mobile — Ana Uygulama Mantığı (app.js)
 * Aydınlık Tema, Floating Sidebar Drawer, Çoklu Not Defteri ve Akordeon Hiyerarşi
 */

let activeView = 'ozet'; // 'page', 'ozet', 'kasa', 'trash', 'settings'
let activeNotebookId = 1;
let activePageId = null;
let activePageObj = null;
let openCategoryIds = new Set();
let activeVaultScope = 'all';
let activeVaultFolder = null;
let currentFinancePeriod = '';
let currentFinanceFilter = 'all';
let currentProjectTab = 'milestones';
let currentProjectData = null;
let projectConceptSaveTimeout = null;
let noteSaveTimeout = null;
let newPageType = 'checklist';

function formatMoney(amount) {
    const num = parseFloat(amount) || 0;
    return num.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sanitizeRichHtml(html) {
    if (!html || typeof html !== 'string') return '';
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const dangerousTags = ['script', 'iframe', 'object', 'embed', 'form', 'link', 'style'];
        dangerousTags.forEach(tag => {
            const elements = doc.querySelectorAll(tag);
            elements.forEach(el => el.remove());
        });
        const allElements = doc.querySelectorAll('*');
        allElements.forEach(el => {
            const attrs = Array.from(el.attributes);
            for (const attr of attrs) {
                const name = attr.name.toLowerCase();
                const val = (attr.value || '').trim().toLowerCase();
                if (name.startsWith('on') || val.startsWith('javascript:') || val.startsWith('data:text/html')) {
                    el.removeAttribute(attr.name);
                }
            }
        });
        return doc.body.innerHTML;
    } catch (e) {
        return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    }
}

async function uploadPastedImageMobile(blob, editor) {
    if (!blob) return;
    showMobileToast('📷 Görsel yükleniyor...');
    const formData = new FormData();
    formData.append('image', blob, 'paste_mobile_' + Date.now() + '.png');
    try {
        const res = await window.appSync.apiFetch('/notes/api/upload_image', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.ok && data.url) {
            editor.focus();
            document.execCommand('insertHTML', false, `<p><img src="${data.url}" alt="Görsel" style="max-width:100%; border-radius:8px; margin:8px 0;" /></p><p><br></p>`);
            onRichNoteInput();
            showMobileToast('📷 Görsel eklendi ✓');
        } else {
            showMobileToast('Görsel sunucuya yüklenemedi');
        }
    } catch (e) {
        showMobileToast('Görsel aktarımı başarısız');
    }
}

function exportPageToPdf() {
    if (!activePageObj) {
        showMobileToast('Yazdırılacak açık sayfa yok');
        return;
    }
    window.print();
}

function setBottomNavActive(navId) {
    document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.remove('active'));
    const btn = document.getElementById(navId);
    if (btn) btn.classList.add('active');
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. IndexedDB Başlat
    await window.appStorage.init();

    // 2. Finans Dönemi
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    currentFinancePeriod = `${y}-${m}`;

    // 3. Aktif Defteri Al
    activeNotebookId = (await window.appStorage.getActiveNotebookId()) || 1;

    // 4. Senkronizasyon Durum Dinleyicisi
    window.appSync.onStatusChange((status, msg) => {
        updateSyncBadge(status, msg);
    });

    // 5. Tarih Gösterimi
    updateDateDisplay();

    // Sanal Klavye Tespiti (Alt menünün formları örtmesini engeller)
    if (window.visualViewport) {
        const initialH = window.visualViewport.height;
        window.visualViewport.addEventListener('resize', () => {
            if (window.visualViewport.height < initialH * 0.78) {
                document.body.classList.add('keyboard-open');
            } else {
                document.body.classList.remove('keyboard-open');
            }
        });
    }
    document.addEventListener('focusin', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
            document.body.classList.add('keyboard-open');
        }
    });
    document.addEventListener('focusout', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
            setTimeout(() => {
                const active = document.activeElement;
                if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA' && !active.isContentEditable)) {
                    document.body.classList.remove('keyboard-open');
                }
            }, 150);
        }
    });

    // 6. Sol Çekmece Ağacını (Defterler & Kategoriler & Sayfalar) Yükle
    await reloadDrawerNavigation();

    // 7. İlk Görünüm: Widget tıklaması varsa oraya git, yoksa Özet
    isAppReady = true;

    let targetAction = null;
    let targetPageId = 0;

    // A) Android Native köprüsünden bekleyen widget tıklaması var mı?
    if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.consumePendingAction) {
        try {
            targetAction = window.AndroidWidgetBridge.consumePendingAction();
            targetPageId = window.AndroidWidgetBridge.consumePendingPageId();
        } catch (e) {}
    }

    // B) Javascript tarafında bekleyen eylem var mı?
    if (!targetAction && window.pendingWidgetAction) {
        targetAction = window.pendingWidgetAction.action;
        targetPageId = window.pendingWidgetAction.extra;
        window.pendingWidgetAction = null;
    }

    if (targetAction === 'open_quick') {
        await openQuickNotesView();
    } else if (targetAction === 'quick_add') {
        await openQuickNotesView();
        setTimeout(() => {
            const input = document.getElementById('input-quick-task');
            if (input) {
                input.focus();
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 150);
    } else if (targetAction === 'open_page' && targetPageId > 0) {
        await openPage(targetPageId);
    } else {
        await openOverviewView();
    }

    // 7.5. Yerel depodaki görevleri ANINDA widget'a aktar (Beklemeden, çevrimdışı dahi çalışır)
    syncWidgetData();

    // 8. Arka Planda Eşitle (Sunucuya Bağlan)
    window.appSync.syncNow().then(async () => {
        await reloadDrawerNavigation();
        if (activeView === 'ozet') await renderOverview();
        else if (activeView === 'quick') await renderQuickNotesView();
        else if (activeView === 'page' && activePageId) await renderActivePage();
    }).catch(e => console.warn('İlk eşitleme arka plan:', e));

    // 9. Güncelleme Kontrolü (Sessiz)
    setTimeout(() => {
        if (window.appUpdater) window.appUpdater.checkForUpdates(true);
    }, 4000);

    // 10. Android Donanım Geri Tuşu Yönetimi (Stepped Back Navigation)
    setupBackButtonListener();
});

// ─────────────────────────────────────────────────────────────────────────────
// Donanım / Sistem Geri Tuşu Mantığı (Stepped Back Navigation)
// İstek:
// 1. Sayfa içindeyken geriye basınca: direkt çıkmasın, önce sol menüyü açsın.
// 2. Sol menü açıkken tekrar basınca: özet sayfasına dönsün ve menüyü kapatsın.
// 3. Özet sayfasında (menü kapalıyken) basınca: uygulamadan çıksın.
// ─────────────────────────────────────────────────────────────────────────────
function setupBackButtonListener() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        try {
            window.Capacitor.Plugins.App.addListener('backButton', () => {
                handleHardwareBack();
            });
        } catch (e) {
            console.warn("Capacitor App addListener error:", e);
        }
    }

    document.addEventListener('backbutton', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        handleHardwareBack();
    }, false);
}

function handleHardwareBack() {
    // 1. Açık herhangi bir modal varsa önce modalı kapat
    const activeModal = document.querySelector('.modal-overlay.active');
    if (activeModal) {
        activeModal.classList.remove('active');
        return;
    }

    const drawer = document.getElementById('sidebar-drawer');
    const isDrawerOpen = drawer && drawer.classList.contains('open');

    // 2. Sayfa, Kasa, Çöp veya Ayarlar görünümündeysek
    if (activeView !== 'ozet') {
        if (!isDrawerOpen) {
            // Adım 1: Önce sol menüyü aç
            toggleSidebar(true);
        } else {
            // Adım 2: Sol menü açıkken tekrar basılırsa özet sayfasına dön ve menüyü kapat
            toggleSidebar(false);
            openOverviewView();
        }
        return;
    }

    // 3. Özet sayfasındayken
    if (isDrawerOpen) {
        // Sol menü açıksa önce menüyü kapat
        toggleSidebar(false);
        return;
    }

    // Adım 3: Özet ekranında ve menü kapalıyken uygulamadan çık
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        window.Capacitor.Plugins.App.exitApp();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Android Ana Ekran Widget Köprüsü (Home Screen AppWidget Sync)
// ─────────────────────────────────────────────────────────────────────────────
async function syncWidgetData() {
    try {
        if (!window.AndroidWidgetBridge || !window.AndroidWidgetBridge.updateWidgetData) return;

        // Widget'tan gelen bekleyen tıklamalar varsa uygula
        if (window.AndroidWidgetBridge.getPendingWidgetToggles) {
            try {
                const pendingStr = window.AndroidWidgetBridge.getPendingWidgetToggles();
                if (pendingStr && pendingStr !== "[]") {
                    const toggles = JSON.parse(pendingStr);
                    for (const tog of toggles) {
                        await window.appStorage.toggleUnifiedTask(tog.task_type, tog.raw_id);
                    }
                    if (toggles.length > 0 && window.appSync) {
                        window.appSync.syncNow();
                    }
                }
            } catch (e) {
                console.warn("getPendingWidgetToggles error:", e);
            }
        }

        if (window.AndroidWidgetBridge.setServerUrl && window.appSync) {
            const serverUrl = await window.appSync.getServerUrl();
            if (serverUrl) {
                window.AndroidWidgetBridge.setServerUrl(serverUrl);
            }
        }

        if (window.AndroidWidgetBridge.setAuthToken && window.appStorage) {
            const token = await window.appStorage.getSetting('auth_token', '');
            window.AndroidWidgetBridge.setAuthToken(token || '');
        }

        const tasks = await window.appStorage.getUnifiedTasks();
        const allQuickNotes = await window.appStorage.getAll('quick_notes');
        const activeQuickNotes = allQuickNotes.filter(n => !n._deleted && n.content);
        const activeTasks = tasks.filter(t => !t.is_done && t.type !== 'quick_note');

        const payload = {
            total_count: activeTasks.length,
            tasks: tasks,
            quick_notes: activeQuickNotes
        };

        window.AndroidWidgetBridge.updateWidgetData(JSON.stringify(payload));
    } catch (e) {
        console.warn("syncWidgetData error:", e);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        syncWidgetData();
    }
});

window.pendingWidgetAction = null;
let isAppReady = false;

window.handleWidgetAction = (action, extra) => {
    if (!isAppReady) {
        window.pendingWidgetAction = { action, extra };
        return;
    }
    if (action === 'open_page' && extra && extra > 0) {
        openPage(parseInt(extra, 10));
    } else if (action === 'quick_add_task' || action === 'quick_add') {
        openQuickNotesView().then(() => {
            const input = document.getElementById('input-quick-task');
            if (input) {
                input.focus();
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    } else if (action === 'quick_add_note') {
        openQuickNotesView().then(() => {
            const input = document.getElementById('input-quick-note');
            if (input) {
                input.focus();
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    } else {
        openQuickNotesView();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// ⚡ Hızlı Notlar & Görevler Görünümü (Quick Hub)
// ─────────────────────────────────────────────────────────────────────────────
let quickNotesDebounce = null;

async function openQuickNotesView() {
    switchMainView('quick');
    toggleSidebar(false);

    const navQuick = document.getElementById('drawer-nav-quick');
    if (navQuick) navQuick.classList.add('active');

    document.getElementById('top-title').innerHTML = `<span>⚡</span> Hızlı Notlar &amp; Görevler`;
    document.getElementById('top-subtitle').innerText = 'Hızlı Notlar, Görevler ve Tarih Sıralı İşler';

    await renderQuickNotesView();
}

async function renderQuickNotesView() {
    // 1. Basit Hızlı Notlar Listesi (Quick Notes Inbox)
    const quickNotes = await window.appStorage.getQuickNotesList(activeNotebookId);
    const notesCountTag = document.getElementById('quick-notes-count-tag');
    if (notesCountTag) notesCountTag.innerText = `${quickNotes.length} Not`;

    const notesListEl = document.getElementById('quick-notes-list');
    if (notesListEl) {
        if (quickNotes.length === 0) {
            notesListEl.innerHTML = `<div class="empty-hint">Henüz hızlı not eklenmedi. Yukarıdan hemen yazıp ekleyin ✨</div>`;
        } else {
            notesListEl.innerHTML = quickNotes.map(n => {
                const timeStr = n.created_at ? new Date(n.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
                return `
                    <div class="overview-item" style="padding:10px 12px; display:flex; align-items:flex-start; justify-content:space-between; gap:10px; border-radius:10px; margin-bottom:6px; cursor:pointer;" onclick="openEditQuickNoteModal(${n.id})" data-quick-note-id="${n.id}">
                        <div style="flex:1; min-width:0;">
                            <div style="font-size:0.9rem; color:var(--text); white-space:pre-wrap; word-break:break-word; line-height:1.4;">
                                ${escapeHtml(n.content)}
                            </div>
                            <div style="font-size:0.72rem; color:var(--muted); margin-top:4px; display:flex; align-items:center; gap:8px;">
                                <span>🕒 ${timeStr}</span>
                                ${n.remind_at ? `<span style="color:#7c3aed; font-weight:600;">⏰ ${escapeHtml(n.remind_at.substring(5, 16))}</span>` : ''}
                            </div>
                        </div>
                        <div style="display:flex; gap:6px; flex-shrink:0;">
                            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openTransferQuickNoteModal(${n.id})" title="Sayfaya Aktar" style="padding:4px 8px; font-size:0.78rem;">📁 Aktar</button>
                            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); deleteQuickNoteFromUI(${n.id})" title="Sil" style="padding:4px 8px; color:var(--danger);">🗑️</button>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // 2. Doğrudan Hızlı Görevler (Hızlı Notlar ve Görevler kategorisindeki 'Hızlı Görevler' sayfası)
    let quickPage = await getOrCreateQuickPage();
    let quickItems = [];
    if (quickPage) {
        quickItems = await window.appStorage.getItems(quickPage.id);
    }
    const directActive = quickItems.filter(i => !i.is_done);
    const directDone = quickItems.filter(i => i.is_done);

    const countTag = document.getElementById('quick-tasks-count-tag');
    if (countTag) countTag.innerText = `${directActive.length} Görev`;

    const directListEl = document.getElementById('quick-direct-tasks-list');
    if (directListEl) {
        if (quickItems.length === 0) {
            directListEl.innerHTML = `<div class="empty-hint">Henüz hızlı görev eklenmedi. Yukarıdan hemen yazıp ekleyin ✨</div>`;
        } else {
            let html = '';
            if (directActive.length === 0) {
                html += `<div class="empty-hint" style="padding:12px 10px;">Harika! Tüm aktif görevler tamamlandı 🎉</div>`;
            } else {
                html += directActive.map(it => renderQuickTaskCardHtml(it)).join('');
            }

            if (directDone.length > 0) {
                html += `
                    <div class="completed-accordion-header" onclick="toggleCompletedQuickTasks()" style="margin-top:10px; cursor:pointer; user-select:none; display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:var(--surface2, #f1f5f9); border:1px solid var(--border); border-radius:8px; font-size:0.8rem; font-weight:700; color:var(--muted);">
                        <span>${showCompletedQuickTasks ? '▾' : '▸'} ${directDone.length} Tamamlanan Görev</span>
                        <span style="font-size:0.72rem; opacity:0.8;">${showCompletedQuickTasks ? 'Gizle' : 'Göster'}</span>
                    </div>
                    <div id="quick-completed-container" style="display:${showCompletedQuickTasks ? 'block' : 'none'}; margin-top:6px;">
                        ${directDone.map(it => renderQuickTaskCardHtml(it)).join('')}
                    </div>
                `;
            }
            directListEl.innerHTML = html;
        }
    }

    // 3. Kategori ve Sayfalardan Gelen Görevler (Tarih Sıralı)
    const unifiedTasks = await window.appStorage.getUnifiedTasks();
    const externalTasks = unifiedTasks.filter(t => t.type !== 'quick_note' && (!quickPage || t.page_id !== quickPage.id));

    const unifiedListEl = document.getElementById('quick-unified-tasks-list');
    if (unifiedListEl) {
        if (externalTasks.length === 0) {
            unifiedListEl.innerHTML = `<div class="empty-hint">Diğer sayfalarda bekleyen görev veya vadesi yaklaşan ödeme yok ✨</div>`;
        } else {
            unifiedListEl.innerHTML = externalTasks.map(t => {
                let badgeColor = 'var(--text-secondary)';
                if (t.due_badge && t.due_badge.includes('Gecikmiş')) badgeColor = 'var(--danger)';
                else if (t.due_badge && (t.due_badge.includes('Yarın') || t.due_badge.includes('Bugün'))) badgeColor = '#d97706';
                else if (t.due_badge && t.due_badge.includes('Hızlı Görev')) badgeColor = 'var(--accent)';
                else if (t.due_badge && t.due_badge.startsWith('⏰')) badgeColor = '#7c3aed';

                return `
                    <div class="overview-item" style="padding:10px 12px; margin-bottom:6px; cursor:pointer;" onclick="openEditUnifiedTaskModal('${t.type}', ${t.raw_id}, ${t.page_id})">
                        <div style="display:flex; align-items:center; gap:10px; overflow:hidden; flex:1;">
                            <div class="checkbox-custom ${t.is_done ? 'checked' : ''}" onclick="event.stopPropagation(); toggleUnifiedTaskFromUI('${t.type}', ${t.raw_id})">
                                ${t.is_done ? '✓' : ''}
                            </div>
                            <div style="overflow:hidden; display:flex; flex-direction:column; gap:2px;">
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:0.9rem; color:var(--text); ${t.is_done ? 'text-decoration:line-through; opacity:0.6;' : ''}">
                                    ${escapeHtml(t.title)}
                                </span>
                                <div style="display:flex; align-items:center; gap:6px; font-size:0.75rem;">
                                    ${t.due_badge ? `<span style="font-weight:700; color:${badgeColor};">${escapeHtml(t.due_badge)}</span>` : ''}
                                    <span style="color:var(--muted);">📁 ${escapeHtml(t.page_title)}</span>
                                </div>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <span style="color:var(--muted); font-size:0.8rem;">➔</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    syncWidgetData();
    initQuickViewLongPressDrag();
}

let showCompletedQuickTasks = false;

function toggleCompletedQuickTasks() {
    showCompletedQuickTasks = !showCompletedQuickTasks;
    const container = document.getElementById('quick-completed-container');
    const header = document.querySelector('.completed-accordion-header span');
    if (container) {
        container.style.display = showCompletedQuickTasks ? 'block' : 'none';
    }
    if (header) {
        const count = container ? container.querySelectorAll('.checklist-item-card').length : 0;
        header.innerHTML = `${showCompletedQuickTasks ? '▾' : '▸'} ${count} Tamamlanan Görev`;
    }
}

function renderQuickTaskCardHtml(it) {
    return `
        <div class="checklist-item-card ${it.is_done ? 'done' : ''}" style="margin-bottom:6px; cursor:pointer;" onclick="openEditItemModal(${it.id}, null, true)" data-item-id="${it.id}">
            <div class="checkbox-custom ${it.is_done ? 'checked' : ''}" onclick="event.stopPropagation(); toggleQuickDirectItem(${it.id})" title="${it.is_done ? 'Tamamlanmadı yap' : 'Tamamla'}">
                ${it.is_done ? '✓' : ''}
            </div>
            <div class="checklist-item-body" onclick="event.stopPropagation(); openEditItemModal(${it.id}, null, true)">
                <div class="checklist-item-title" style="${it.is_done ? 'text-decoration:line-through; opacity:0.6;' : ''}">${escapeHtml(it.title)}</div>
                ${it.remind_at ? `<div class="checklist-item-meta"><span class="meta-badge reminder" style="background:#f5f3ff; color:#7c3aed; border:1px solid #ddd6fe;">⏰ ${escapeHtml(it.remind_at.substring(5, 16))}</span></div>` : ''}
            </div>
            <div class="checklist-item-actions" style="display:flex; align-items:center; gap:4px;">
                <button class="item-action-btn" onclick="event.stopPropagation(); deleteQuickDirectItem(${it.id})" title="Sil" style="color:var(--danger); font-size:0.9rem;">🗑️</button>
            </div>
        </div>
    `;
}

let _lastQuickNoteModalOpenTime = 0;
async function openEditQuickNoteModal(id, content = null) {
    if (Date.now() - _lastQuickNoteModalOpenTime < 350) return;
    _lastQuickNoteModalOpenTime = Date.now();

    const idInput = document.getElementById('edit-quick-note-id');
    if (idInput) idInput.value = id;
    const txt = document.getElementById('edit-quick-note-content');
    const dtInput = document.getElementById('edit-quick-note-remind-at');
    if (txt && content) txt.value = content;
    openModal('modal-edit-quick-note');

    try {
        const note = await window.appStorage.get('quick_notes', Number(id)) || await window.appStorage.get('quick_notes', id);
        if (txt) {
            if (content !== null && content !== undefined && content !== '') {
                txt.value = content;
            } else {
                txt.value = note ? note.content : '';
            }
            setTimeout(() => { txt.focus(); }, 120);
        }
        if (dtInput) {
            dtInput.value = (note && note.remind_at) ? note.remind_at.substring(0, 16).replace(' ', 'T') : '';
        }
    } catch (e) {
        console.warn('openEditQuickNoteModal fetch error:', e);
    }
}

function setEditQuickNotePreset(daysAhead, hour, minute) {
    const dtInput = document.getElementById('edit-quick-note-remind-at');
    if (!dtInput) return;
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, minute, 0, 0);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    dtInput.value = `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

async function submitEditQuickNote() {
    const id = Number(document.getElementById('edit-quick-note-id').value);
    const content = document.getElementById('edit-quick-note-content').value.trim();
    const dtInput = document.getElementById('edit-quick-note-remind-at');
    const remindAtRaw = dtInput ? dtInput.value : '';
    if (!id || !content) return;

    const note = await window.appStorage.get('quick_notes', id);
    if (note) {
        note.content = content;
        note.remind_at = remindAtRaw ? (remindAtRaw.replace('T', ' ') + ':00') : null;
        note._dirty = true;
        note.updated_at = new Date().toISOString();
        await window.appStorage.put('quick_notes', note);

        if (note.remind_at && window.AndroidWidgetBridge && window.AndroidWidgetBridge.scheduleTaskAlarm) {
            try {
                window.AndroidWidgetBridge.scheduleTaskAlarm(note.id, note.content.substring(0, 35), note.remind_at, 'none', 0);
            } catch(e) {}
        } else if (!note.remind_at && window.AndroidWidgetBridge && window.AndroidWidgetBridge.cancelTaskAlarm) {
            try { window.AndroidWidgetBridge.cancelTaskAlarm(note.id); } catch(e) {}
        }
    }
    closeModal('modal-edit-quick-note');
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
    showMobileToast('Not güncellendi ✓');
}

async function deleteQuickNoteFromModal() {
    const id = Number(document.getElementById('edit-quick-note-id').value);
    if (!id) return;
    if (!confirm('Bu notu silmek istediğinize emin misiniz?')) return;
    await window.appStorage.deleteQuickNote(id);
    closeModal('modal-edit-quick-note');
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
    showMobileToast('Not silindi');
}

// Görev / Madde Düzenleme
let currentEditingItemId = null;
let currentEditingItemIsQuick = false;

function setEditItemQuickReminder(daysAhead, hour, minute) {
    const dtInput = document.getElementById('edit-item-remind-at');
    if (!dtInput) return;
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, minute, 0, 0);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    dtInput.value = `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function clearEditItemReminder() {
    const dtInput = document.getElementById('edit-item-remind-at');
    if (dtInput) dtInput.value = '';
}

let _lastItemModalOpenTime = 0;
async function openEditItemModal(id, title = null, isQuick = false) {
    if (Date.now() - _lastItemModalOpenTime < 350) return;
    _lastItemModalOpenTime = Date.now();

    try {
        currentEditingItemId = id;
        currentEditingItemIsQuick = isQuick;
        const idInput = document.getElementById('edit-item-id');
        const quickInput = document.getElementById('edit-item-is-quick');
        const titleInput = document.getElementById('edit-item-title');
        const qtyInput = document.getElementById('edit-item-qty');
        const priceInput = document.getElementById('edit-item-price');
        const urlInput = document.getElementById('edit-item-url');
        const descInput = document.getElementById('edit-item-desc');
        const dtInput = document.getElementById('edit-item-remind-at');
        const recSelect = document.getElementById('edit-item-recurrence');

        if (idInput) idInput.value = id;
        if (quickInput) quickInput.value = isQuick ? '1' : '0';
        if (titleInput && title) titleInput.value = title;

        // Hemen modalı aç (kullanıcı dokunur dokunmaz açılsın)
        openModal('modal-edit-item');
        if (titleInput) setTimeout(() => titleInput.focus(), 100);

        let item = null;
        if (window.appStorage) {
            try {
                item = await window.appStorage.get('items', Number(id));
                if (!item) item = await window.appStorage.get('items', String(id));
                if (!item) item = await window.appStorage.get('items', id);
            } catch (err) {
                console.warn('Item storage fetch warning:', err);
            }
        }

        if (titleInput) {
            if (title !== null && title !== undefined && title !== '') {
                titleInput.value = title;
            } else {
                titleInput.value = item ? (item.title || '') : '';
            }
        }
        if (qtyInput) qtyInput.value = (item && item.quantity) ? item.quantity : '';
        if (priceInput) priceInput.value = (item && item.price) ? item.price : '';
        if (urlInput) urlInput.value = (item && item.url) ? item.url : '';
        if (descInput) descInput.value = (item && item.description) ? item.description : '';

        if (dtInput) {
            dtInput.value = (item && item.remind_at) ? item.remind_at.substring(0, 16).replace(' ', 'T') : '';
        }
        if (recSelect) {
            recSelect.value = (item && item.recurrence) ? item.recurrence : 'none';
        }
    } catch (e) {
        console.error('openEditItemModal error:', e);
        openModal('modal-edit-item');
    }
}

async function openEditUnifiedTaskModal(taskType, rawId, pageId) {
    if (window._suppressClickUntil && Date.now() < window._suppressClickUntil) return;
    if (taskType === 'checklist') {
        await openEditItemModal(rawId, null, (activeView === 'quick'));
    } else if (taskType === 'finance') {
        const item = await window.appStorage.get('finance', rawId);
        const currentTitle = item ? item.title : '';
        const newTitle = prompt('Ödeme başlığını düzenle:', currentTitle);
        if (newTitle && newTitle.trim() && newTitle.trim() !== currentTitle) {
            if (item) {
                item.title = newTitle.trim();
                item._dirty = true;
                item.updated_at = new Date().toISOString();
                await window.appStorage.put('finance', item);
                if (activeView === 'quick') await renderQuickNotesView();
                else if (activeView === 'ozet') await renderOverview();
                if (window.appSync) window.appSync.syncNow();
                showMobileToast('Ödeme güncellendi ✓');
            }
        }
    }
}

async function submitEditItem() {
    const id = Number(document.getElementById('edit-item-id').value);
    const isQuick = document.getElementById('edit-item-is-quick').value === '1';
    const title = document.getElementById('edit-item-title').value.trim();
    const qty = document.getElementById('edit-item-qty')?.value.trim() || '';
    const price = document.getElementById('edit-item-price')?.value.trim() || '';
    const url = document.getElementById('edit-item-url')?.value.trim() || '';
    const desc = document.getElementById('edit-item-desc')?.value.trim() || '';
    const dtInput = document.getElementById('edit-item-remind-at');
    const recSelect = document.getElementById('edit-item-recurrence');
    const remindAtRaw = dtInput ? dtInput.value : '';
    const recurrence = recSelect ? recSelect.value : 'none';

    if (!id || !title) return;

    let item = await window.appStorage.get('items', id);
    if (!item) item = await window.appStorage.get('items', String(id));
    if (item) {
        item.title = title;
        item.quantity = qty;
        item.price = price;
        item.url = url;
        item.description = desc;
        if (remindAtRaw) {
            const remindAtStr = remindAtRaw.replace('T', ' ') + (remindAtRaw.length === 16 ? ':00' : '');
            item.remind_at = remindAtStr;
            item.recurrence = recurrence;
            await window.appStorage.setItemReminder(item.id, remindAtStr, recurrence);
            if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.scheduleTaskAlarm) {
                try {
                    window.AndroidWidgetBridge.scheduleTaskAlarm(item.id, item.title, remindAtStr, recurrence, item.page_id || 0);
                } catch(e) {}
            }
            if (window.appSync) {
                window.appSync.getServerUrl().then(sUrl => {
                    if (sUrl) {
                        window.appStorage.getSetting('auth_token', '').then(tok => {
                            fetch(`${sUrl}/notes/api/items/${item.id}`, {
                                method: 'PUT',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': tok ? `Bearer ${tok}` : '',
                                    'X-Auth-Token': tok || ''
                                },
                                body: JSON.stringify({
                                    title: item.title,
                                    quantity: qty,
                                    price: price,
                                    url: url,
                                    description: desc,
                                    remind_at: remindAtStr,
                                    recurrence: recurrence
                                })
                            }).catch(() => {});
                        });
                    }
                });
            }
        } else {
            item.remind_at = null;
            item.recurrence = 'none';
            if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.cancelTaskAlarm) {
                try { window.AndroidWidgetBridge.cancelTaskAlarm(item.id); } catch(e) {}
            }
            if (window.appSync) {
                window.appSync.getServerUrl().then(sUrl => {
                    if (sUrl) {
                        window.appStorage.getSetting('auth_token', '').then(tok => {
                            fetch(`${sUrl}/notes/api/items/${item.id}`, {
                                method: 'PUT',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': tok ? `Bearer ${tok}` : '',
                                    'X-Auth-Token': tok || ''
                                },
                                body: JSON.stringify({
                                    title: item.title,
                                    quantity: qty,
                                    price: price,
                                    url: url,
                                    description: desc,
                                    remind_at: '',
                                    recurrence: 'none'
                                })
                            }).catch(() => {});
                        });
                    }
                });
            }
        }
        item._dirty = true;
        item.updated_at = new Date().toISOString();
        await window.appStorage.put('items', item);
    }
    closeModal('modal-edit-item');
    if (isQuick || activeView === 'quick') {
        await renderQuickNotesView();
    } else if (activeView === 'ozet') {
        await renderOverview();
    } else if (activePageId) {
        await renderChecklistItems(activePageId);
    }
    if (window.appSync) window.appSync.syncNow();
    showMobileToast('Görev güncellendi ✓');
}

async function deleteItemFromEditModal() {
    const id = Number(document.getElementById('edit-item-id').value);
    const isQuick = document.getElementById('edit-item-is-quick').value === '1';
    if (!id) return;
    const item = await window.appStorage.get('items', id);
    await window.appStorage.deleteItem(id);
    closeModal('modal-edit-item');
    if (isQuick || activeView === 'quick') {
        await renderQuickNotesView();
    } else if (activeView === 'ozet') {
        await renderOverview();
    } else if (activePageId) {
        await renderChecklistItems(activePageId);
    }
    if (window.appSync) window.appSync.syncNow();
    if (item) {
        pushDeletedHistory('item', item, async () => {
            await window.appStorage.saveItem(item);
            if (isQuick || activeView === 'quick') await renderQuickNotesView();
            else if (activeView === 'ozet') await renderOverview();
            else if (activePageId) await renderChecklistItems(activePageId);
            if (window.appSync) window.appSync.syncNow();
        });
    }
}

async function addQuickNoteFromInput() {
    const input = document.getElementById('input-quick-note');
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;

    await window.appStorage.addQuickNote(content, activeNotebookId);
    input.value = '';
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}

async function deleteQuickNoteFromUI(noteId) {
    const note = await window.appStorage.get('quick_notes', noteId);
    await window.appStorage.deleteQuickNote(noteId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
    if (note) {
        pushDeletedHistory('quick_note', note, async () => {
            await window.appStorage.save('quick_notes', note);
            await renderQuickNotesView();
            if (window.appSync) window.appSync.syncNow();
        });
    }
}

async function openTransferQuickNoteModal(noteId) {
    const note = await window.appStorage.get('quick_notes', noteId);
    if (!note) return;

    document.getElementById('mobile-transfer-note-id').value = noteId;
    document.getElementById('mobile-transfer-note-preview').innerText = note.content;

    // Hedef sayfaları doldur
    const cats = await window.appStorage.getCategories(activeNotebookId);
    const catMap = {};
    cats.forEach(c => catMap[c.id] = c.name);

    const pages = await window.appStorage.getAll('pages');
    const activePages = pages.filter(p => !p._deleted && catMap[p.category_id]);
    const pageSelect = document.getElementById('mobile-transfer-target-page');
    if (pageSelect) {
        if (activePages.length === 0) {
            pageSelect.innerHTML = '<option value="">(Mevcut sayfa bulunamadı)</option>';
        } else {
            pageSelect.innerHTML = activePages.map(p => {
                const catName = catMap[p.category_id] || 'Dosya';
                const typeLabel = p.type === 'checklist' ? '✓ Görev Listesi' : '📝 Not';
                return `<option value="${p.id}">${escapeHtml(catName)} / ${escapeHtml(p.title)} (${typeLabel})</option>`;
            }).join('');
        }
    }

    // Hedef dosyaları doldur
    const catSelect = document.getElementById('mobile-transfer-target-category');
    if (catSelect) {
        catSelect.innerHTML = cats.map(c => `
            <option value="${c.id}">${c.icon || '📁'} ${escapeHtml(c.name)}</option>
        `).join('');
    }

    // Alanları sıfırla
    const titleInput = document.getElementById('mobile-transfer-new-page-title');
    if (titleInput) titleInput.value = '';
    toggleMobileTransferMode('existing');

    openModal('modal-transfer-quick-note');
}

function toggleMobileTransferMode(mode) {
    const existingDiv = document.getElementById('mobile-transfer-mode-existing');
    const newDiv = document.getElementById('mobile-transfer-mode-new');
    if (mode === 'existing') {
        if (existingDiv) existingDiv.style.display = 'block';
        if (newDiv) newDiv.style.display = 'none';
    } else {
        if (existingDiv) existingDiv.style.display = 'none';
        if (newDiv) newDiv.style.display = 'block';
    }
}

async function submitTransferQuickNote() {
    const noteId = Number(document.getElementById('mobile-transfer-note-id').value);
    if (!noteId) return;

    const modeRadios = document.getElementsByName('mobile-transfer-mode');
    let mode = 'existing';
    for (const r of modeRadios) {
        if (r.checked) mode = r.value;
    }

    if (mode === 'existing') {
        const pageId = Number(document.getElementById('mobile-transfer-target-page').value);
        if (!pageId) {
            alert('Lütfen bir hedef sayfa seçin.');
            return;
        }
        await window.appStorage.moveQuickNote(noteId, pageId, null, null);
    } else {
        const catId = Number(document.getElementById('mobile-transfer-target-category').value);
        const newTitle = document.getElementById('mobile-transfer-new-page-title').value.trim();
        if (!catId) {
            alert('Lütfen bir dosya seçin.');
            return;
        }
        if (!newTitle) {
            alert('Lütfen yeni sayfa için bir başlık girin.');
            return;
        }
        await window.appStorage.moveQuickNote(noteId, null, catId, newTitle);
    }

    closeModal('modal-transfer-quick-note');
    await renderQuickNotesView();
    if (activeView === 'ozet') await renderOverview();
    if (window.appSync) window.appSync.syncNow();
    if (typeof showToast === 'function') showToast('Not başarıyla aktarıldı ✓');
}

async function getOrCreateQuickPage() {
    const cats = await window.appStorage.getAll('categories');
    let quickCat = cats.find(c => (c.name === 'Hızlı Notlar ve Görevler' || c.name === 'Hızlı Notlar' || c.name === 'Genel Notlar') && (!c.notebook_id || Number(c.notebook_id) === Number(activeNotebookId)) && !c._deleted);
    if (!quickCat) {
        quickCat = {
            id: Date.now(),
            notebook_id: activeNotebookId,
            name: 'Hızlı Notlar ve Görevler',
            icon: '⚡',
            color: '#f59e0b',
            sort_order: 99,
            _dirty: true,
            _deleted: false,
            created_at: new Date().toISOString()
        };
        await window.appStorage.put('categories', quickCat);
    }
    const pages = await window.appStorage.getAll('pages');
    let page = pages.find(p => p.category_id === quickCat.id && !p._deleted);
    if (!page) {
        page = {
            id: Date.now() + 1,
            category_id: quickCat.id,
            title: 'Hızlı Görevler',
            type: 'checklist',
            icon: '⚡',
            content: '',
            sort_order: 1,
            is_archived: 0,
            _dirty: true,
            _deleted: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        await window.appStorage.put('pages', page);
    }
    return page;
}

function onQuickNotesInput(text) {
    // Eski textarea desteği için korundu
}

async function addQuickTaskFromInput() {
    const input = document.getElementById('input-quick-task');
    if (!input) return;
    const title = input.value.trim();
    if (!title) return;

    let quickPage = await getOrCreateQuickPage();
    if (!quickPage) return;

    await window.appStorage.addItem({
        page_id: quickPage.id,
        title: title,
        quantity: '',
        price: '',
        url: ''
    });

    input.value = '';
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}

async function toggleQuickDirectItem(itemId) {
    await window.appStorage.toggleItemDone(itemId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}

async function deleteQuickDirectItem(itemId) {
    const item = await window.appStorage.get('items', itemId);
    await window.appStorage.deleteItem(itemId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
    if (item) {
        pushDeletedHistory('item', item, async () => {
            await window.appStorage.saveItem(item);
            await renderQuickNotesView();
            if (window.appSync) window.appSync.syncNow();
        });
    }
}

async function toggleUnifiedTaskFromUI(taskType, rawId) {
    await window.appStorage.toggleUnifiedTask(taskType, rawId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}


// ─────────────────────────────────────────────────────────────────────────────
// Tarih ve Durum Rozeti
// ─────────────────────────────────────────────────────────────────────────────
function updateDateDisplay() {
    const el = document.getElementById('welcome-date-label');
    if (!el) return;
    const now = new Date();
    const opts = { weekday: 'long', day: 'numeric', month: 'long' };
    el.innerText = now.toLocaleDateString('tr-TR', opts);
}

function updateSyncBadge(status, msg) {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    badge.className = `sync-badge ${status}`;
    if (status === 'online') {
        badge.innerHTML = `🟢 <span>${msg || 'Eşitlendi'}</span>`;
    } else if (status === 'syncing') {
        badge.innerHTML = `🔄 <span>Eşitleniyor...</span>`;
    } else if (status === 'error') {
        badge.innerHTML = `⚠️ <span>Hata</span>`;
        badge.title = msg;
    } else {
        badge.innerHTML = `⚪ <span>Çevrimdışı</span>`;
        badge.title = msg;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sol Floating Drawer (Çekmece Menü) Aç / Kapa
// ─────────────────────────────────────────────────────────────────────────────
function toggleSidebar(open) {
    const drawer = document.getElementById('sidebar-drawer');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!drawer || !backdrop) return;

    if (open) {
        drawer.classList.add('open');
        backdrop.classList.add('active');
    } else {
        drawer.classList.remove('open');
        backdrop.classList.remove('active');
        closeNotebookDropdown();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Not Defteri Seçici Dropdown (OneNote Mantığı)
// ─────────────────────────────────────────────────────────────────────────────
async function toggleNotebookDropdown(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('drawer-nb-dropdown');
    if (!menu) return;
    const isOpen = menu.classList.contains('active');
    if (isOpen) {
        menu.classList.remove('active');
    } else {
        await renderNotebookDropdownMenu();
        menu.classList.add('active');
    }
}

function closeNotebookDropdown() {
    const menu = document.getElementById('drawer-nb-dropdown');
    if (menu) menu.classList.remove('active');
}

async function renderNotebookDropdownMenu() {
    const menu = document.getElementById('drawer-nb-dropdown');
    if (!menu) return;

    let notebooks = await window.appStorage.getNotebooks();
    if (notebooks.length === 0) {
        notebooks = [{ id: 1, name: 'Not Defterim', icon: '📓', is_default: 1 }];
    }

    let html = notebooks.map(nb => `
        <div class="notebook-item ${nb.id == activeNotebookId ? 'active' : ''}" onclick="selectNotebook(${nb.id})">
            <span style="display:flex; align-items:center; gap:6px;">
                <span>${nb.icon || '📓'}</span>
                <span>${escapeHtml(nb.name)}</span>
            </span>
            ${nb.id == activeNotebookId ? '<span>✓</span>' : ''}
        </div>
    `).join('');

    html += `
        <div class="notebook-add-item" onclick="openAddNotebookModal()">
            <span>＋</span> Yeni Not Defteri Ekle
        </div>
    `;

    menu.innerHTML = html;
}

async function selectNotebook(nbId) {
    activeNotebookId = nbId;
    await window.appStorage.setActiveNotebookId(nbId);
    closeNotebookDropdown();

    // Sunucuya da bildir
    try {
        await window.appSync.apiFetch('/notes/api/notebooks/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notebook_id: nbId })
        });
    } catch (e) {
        console.warn('Notebook switch bildirilemedi:', e);
    }

    await reloadDrawerNavigation();
    await openOverviewView();
    window.appSync.syncNow();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sol Çekmece Ağacı (Defter, Kategoriler, Sayfalar)
// ─────────────────────────────────────────────────────────────────────────────
async function reloadDrawerNavigation() {
    // 1. Defter Başlığını Güncelle
    let notebooks = await window.appStorage.getNotebooks();
    let curNb = notebooks.find(n => n.id == activeNotebookId);
    if (!curNb && notebooks.length > 0) {
        curNb = notebooks[0];
        activeNotebookId = curNb.id;
    }

    const nbNameEl = document.getElementById('drawer-nb-name');
    const nbIconEl = document.getElementById('drawer-nb-icon');
    if (nbNameEl) nbNameEl.innerText = curNb ? curNb.name : 'Not Defterim';
    if (nbIconEl) nbIconEl.innerText = curNb ? (curNb.icon || '📓') : '📓';

    // 2. Kategoriler ve Sayfalar Listesi
    const catContainer = document.getElementById('drawer-categories-list');
    if (!catContainer) return;

    let categories = await window.appStorage.getCategories(activeNotebookId);
    let allPages = await window.appStorage.getAll('pages');
    allPages = allPages.filter(p => !p._deleted);

    if (categories.length === 0) {
        catContainer.innerHTML = `
            <div style="text-align:center; padding:16px 8px; font-size:0.82rem; color:var(--muted);">
                Bu defterde dosya yok.<br>
                <button class="btn btn-ghost btn-sm" onclick="openAddCategoryModal()" style="color:var(--accent); font-weight:700; margin-top:4px;">
                    ＋ Dosya Ekle
                </button>
            </div>
        `;
        return;
    }

    // İlk kategori varsayılan olarak açık olsun
    if (openCategoryIds.size === 0 && categories.length > 0) {
        openCategoryIds.add(categories[0].id);
    }

    catContainer.innerHTML = categories.map(cat => {
        if (cat.is_divider || cat.icon === '―' || cat.name === '---' || (typeof cat.name === 'string' && cat.name.startsWith('---'))) {
            return `
                <div class="drawer-cat-divider-group" id="cat-group-${cat.id}" data-category-id="${cat.id}">
                    <div class="drawer-divider-line"></div>
                    ${cat.name && cat.name !== '---' && cat.name !== 'Ayraç' ? `<span class="drawer-divider-label">${escapeHtml(cat.name)}</span><div class="drawer-divider-line"></div>` : ''}
                    <button type="button" class="btn btn-ghost btn-xs drawer-divider-del" onclick="event.stopPropagation(); deleteCategoryDividerMobile(${cat.id})" title="Ayracı Sil">✕</button>
                </div>
            `;
        }

        const catPages = allPages.filter(p => p.category_id == cat.id).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        const isOpen = openCategoryIds.has(cat.id);
        const catColor = cat.color || '#3b82f6';

        let pagesHtml = catPages.map(page => {
            const pageDefIcon = page.type === 'checklist' ? '🛒' :
                                page.type === 'software' ? '💻' :
                                page.type === 'project' ? '🔬' :
                                page.type === 'finance' ? '💳' : '📝';
            const pageTypeLabel = page.type === 'checklist' ? 'Liste' :
                                  page.type === 'software' ? 'Yazılım' :
                                  page.type === 'project' ? 'Proje' :
                                  page.type === 'finance' ? 'Finans' : 'Not';
            return `
                <div class="drawer-page-item ${activePageId == page.id && activeView === 'page' ? 'active' : ''}" id="drawer-page-${page.id}" data-page-id="${page.id}" data-category-id="${cat.id}" onclick="openPage(${page.id})">
                    <span style="display:flex; align-items:center; gap:6px; overflow:hidden; text-overflow:ellipsis;">
                        <span>${page.icon || pageDefIcon}</span>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(page.title)}</span>
                    </span>
                    <span style="font-size:0.7rem; color:var(--muted);">${pageTypeLabel}</span>
                </div>
            `;
        }).join('');

        pagesHtml += `
            <div class="drawer-add-page-btn" onclick="openAddPageModal(${cat.id})">
                <span>＋</span> Yeni Sayfa / Liste Ekle
            </div>
        `;

        return `
            <div class="drawer-cat-group ${isOpen ? 'open' : ''}" id="cat-group-${cat.id}" data-category-id="${cat.id}" style="border-left: 4px solid ${catColor};">
                <div class="drawer-cat-header" id="drawer-cat-header-${cat.id}" data-category-id="${cat.id}" onclick="toggleCategoryAccordion(${cat.id})">
                    <div class="drawer-cat-title">
                        <span class="drawer-cat-arrow">▶</span>
                        <span style="font-size:1.05rem; line-height:1;">${cat.icon || '📁'}</span>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;">${escapeHtml(cat.name)}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <button type="button" class="btn btn-ghost btn-xs" style="padding:2px 5px; font-size:0.75rem; color:var(--muted);" title="Dosyayı Düzenle" onclick="event.stopPropagation(); openEditCategoryModal(${cat.id})">✏️</button>
                        <span style="font-size:0.75rem; color:${catColor}; background:${catColor}18; border:1px solid ${catColor}30; padding:1px 6px; border-radius:10px; font-weight:700;">
                            ${catPages.length}
                        </span>
                    </div>
                </div>
                <div class="drawer-cat-pages" id="drawer-cat-pages-${cat.id}" data-category-id="${cat.id}">
                    ${pagesHtml}
                </div>
            </div>
        `;
    }).join('');

    initMobileDrawerDragAndDrop();
}

function toggleCategoryAccordion(catId) {
    if (window._suppressClickUntil && Date.now() < window._suppressClickUntil) return;
    if (openCategoryIds.has(catId)) {
        openCategoryIds.delete(catId);
    } else {
        openCategoryIds.add(catId);
    }
    const group = document.getElementById(`cat-group-${catId}`);
    if (group) {
        group.classList.toggle('open');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Android Tarzı 1.5 Saniye Basılı Tutarak Sürükle-Bırak Yöneticisi
// ─────────────────────────────────────────────────────────────────────────────
let mobileDragState = null;
window._suppressClickUntil = 0;

// Sürükleme bittiğinde tıklamanın yanlışlıkla modal/sayfa açmasını engelleyen global yakalayıcı
window.addEventListener('click', function(e) {
    if (window._suppressClickUntil && Date.now() < window._suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return false;
    }
}, true);

function clearMobileDropIndicators() {
    document.querySelectorAll('.drop-target-above, .drop-target-below, .cat-drop-hover, .is-dragging, .android-lifted-item').forEach(el => {
        el.classList.remove('drop-target-above', 'drop-target-below', 'cat-drop-hover', 'is-dragging', 'android-lifted-item');
    });
}

// Genel 500ms Basılı Tutma (Drag) ve Anında Dokunma (Tap) Yöneticisi
function attachLongPressDragHandler(element, onActivate, onTap = null) {
    let holdTimer = null;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let isFired = false;
    let hasMoved = false;

    const onStart = (e) => {
        if (e.target.closest('button, input, textarea, select, .checkbox-custom, a, .drawer-divider-del, .item-action-btn')) return;
        const pt = e.touches ? e.touches[0] : e;
        startX = pt.clientX;
        startY = pt.clientY;
        startTime = Date.now();
        isFired = false;
        hasMoved = false;

        holdTimer = setTimeout(() => {
            isFired = true;
            window._suppressClickUntil = Date.now() + 600;
            if (navigator.vibrate) {
                try { navigator.vibrate([40, 30, 40]); } catch(err) {}
            }
            onActivate(element, pt.clientX, pt.clientY);
        }, 500); // 500ms Android launcher tarzı taşıma modu
    };

    const onMove = (e) => {
        if (isFired) return;
        const pt = e.touches ? e.touches[0] : e;
        if (Math.hypot(pt.clientX - startX, pt.clientY - startY) > 10) {
            hasMoved = true;
            clearTimeout(holdTimer);
        }
    };

    const onEnd = (e) => {
        clearTimeout(holdTimer);
        if (isFired) return;

        // Kullanıcı 500 ms'den kısa basıp bıraktıysa ve parmak kaymadıysa: BU KESİN BİR DOKUNMADIR!
        if (!hasMoved && (Date.now() - startTime) < 500) {
            if (typeof onTap === 'function') {
                window._suppressClickUntil = Date.now() + 350;
                onTap(element, e);
            }
        }
    };

    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchmove', onMove, { passive: true });
    element.addEventListener('touchend', onEnd, { passive: true });
    element.addEventListener('touchcancel', () => { clearTimeout(holdTimer); });

    // Masaüstü testleri için fare desteği
    element.addEventListener('mousedown', onStart);
    element.addEventListener('mousemove', onMove);
    element.addEventListener('mouseup', onEnd);
    element.addEventListener('mouseleave', () => { clearTimeout(holdTimer); });
}

// 1. Sol Çekmece: Kategori ve Sayfalar
function initMobileDrawerDragAndDrop() {
    const catContainer = document.getElementById('drawer-categories-list');
    if (!catContainer) return;

    // Dosyalar / Ayraclar
    const catHeaders = catContainer.querySelectorAll('.drawer-cat-header, .drawer-cat-divider-group');
    catHeaders.forEach(header => {
        attachLongPressDragHandler(header, (el, x, y) => {
            const isDivider = el.classList.contains('drawer-cat-divider-group');
            const groupEl = isDivider ? el : el.closest('.drawer-cat-group');
            if (!groupEl) return;
            startMobileDragSession({
                type: 'cat',
                itemEl: groupEl,
                itemId: groupEl.dataset.categoryId,
                sourceCatId: null,
                startX: x,
                startY: y,
                label: isDivider ? 'Ayraç' : (groupEl.querySelector('.drawer-cat-title span:nth-child(3)')?.innerText || 'Dosya'),
                icon: isDivider ? '―' : '📁'
            });
        }, (el) => {
            const groupEl = el.closest('.drawer-cat-group');
            if (groupEl && groupEl.dataset.categoryId) {
                toggleCategoryAccordion(groupEl.dataset.categoryId);
            }
        });
    });

    // Sayfalar
    const pageItems = catContainer.querySelectorAll('.drawer-page-item');
    pageItems.forEach(item => {
        attachLongPressDragHandler(item, (el, x, y) => {
            const titleSpan = el.querySelector('span:first-child span:last-child');
            startMobileDragSession({
                type: 'page',
                itemEl: el,
                itemId: el.dataset.pageId,
                sourceCatId: el.dataset.categoryId,
                startX: x,
                startY: y,
                label: titleSpan ? titleSpan.innerText : 'Sayfa',
                icon: '📄'
            });
        }, (el) => {
            if (el.dataset.pageId) {
                openPage(el.dataset.pageId);
            }
        });
    });
}

// 2. Sayfa İçi Maddeler (Checklist)
function initChecklistItemsLongPressDrag(pageId) {
    const cards = document.querySelectorAll('#page-items-list .checklist-item-card, #page-completed-list .checklist-item-card');
    cards.forEach(card => {
        attachLongPressDragHandler(card, (el, x, y) => {
            const titleEl = el.querySelector('.checklist-item-title');
            startMobileDragSession({
                type: 'checklist',
                pageId: pageId,
                itemEl: el,
                itemId: el.dataset.itemId,
                startX: x,
                startY: y,
                label: titleEl ? titleEl.innerText : 'Görev',
                icon: '☑️'
            });
        }, (el) => {
            // Anında dokunma ile Görev Detay / Düzenleme Modalı
            if (el.dataset.itemId) {
                const titleEl = el.querySelector('.checklist-item-title');
                openEditItemModal(el.dataset.itemId, titleEl ? titleEl.innerText.trim() : null, false);
            }
        });
    });
}

// 3. Hızlı Görevler & Hızlı Notlar
function initQuickViewLongPressDrag() {
    // Hızlı Görevler
    const taskList = document.getElementById('quick-direct-tasks-list');
    if (taskList) {
        const cards = taskList.querySelectorAll('.checklist-item-card');
        cards.forEach(card => {
            attachLongPressDragHandler(card, (el, x, y) => {
                const titleEl = el.querySelector('.checklist-item-title');
                startMobileDragSession({
                    type: 'quick_task',
                    itemEl: el,
                    itemId: el.dataset.itemId,
                    startX: x,
                    startY: y,
                    label: titleEl ? titleEl.innerText : 'Hızlı Görev',
                    icon: '☑️'
                });
            }, (el) => {
                if (el.dataset.itemId) {
                    openEditItemModal(el.dataset.itemId, null, true);
                }
            });
        });
    }

    // Hızlı Notlar
    const notesList = document.getElementById('quick-notes-list');
    if (notesList) {
        const notes = notesList.querySelectorAll('.overview-item[data-quick-note-id]');
        notes.forEach(note => {
            attachLongPressDragHandler(note, (el, x, y) => {
                const noteText = el.innerText.substring(0, 30);
                startMobileDragSession({
                    type: 'quick_note',
                    itemEl: el,
                    itemId: el.dataset.quickNoteId,
                    startX: x,
                    startY: y,
                    label: noteText,
                    icon: '📝'
                });
            }, (el) => {
                if (el.dataset.quickNoteId) {
                    openEditQuickNoteModal(el.dataset.quickNoteId);
                }
            });
        });
    }
}

// Sürükleme Oturumu Başlatıcı
function startMobileDragSession(config) {
    const { type, itemEl, itemId, sourceCatId, startX, startY, label, icon, pageId } = config;

    // Android tarzı ayrılma efekti
    itemEl.classList.add('android-lifted-item');

    // Takip eden hayalet öğe
    const ghost = document.createElement('div');
    ghost.className = 'drag-floating-ghost';
    ghost.innerHTML = `${icon} ${escapeHtml(label)}`;
    document.body.appendChild(ghost);
    ghost.style.left = (startX - 30) + 'px';
    ghost.style.top = (startY - 45) + 'px';

    mobileDragState = {
        type,
        itemEl,
        itemId,
        sourceCatId,
        pageId,
        ghost,
        lastTarget: null,
        lastPos: null,
        lastAction: null
    };

    const onMove = (e) => {
        if (!mobileDragState) return;
        const pt = e.touches ? e.touches[0] : e;
        if (e.cancelable) e.preventDefault();

        if (ghost) {
            ghost.style.left = (pt.clientX - 30) + 'px';
            ghost.style.top = (pt.clientY - 45) + 'px';
        }

        clearMobileDropIndicators();
        const elUnder = document.elementFromPoint(pt.clientX, pt.clientY);
        if (!elUnder) return;

        if (type === 'cat') {
            const hoverGroup = elUnder.closest('.drawer-cat-group, .drawer-cat-divider-group');
            if (hoverGroup && hoverGroup !== itemEl) {
                const rect = hoverGroup.getBoundingClientRect();
                const isAbove = (pt.clientY - rect.top) < rect.height / 2;
                hoverGroup.classList.add(isAbove ? 'drop-target-above' : 'drop-target-below');
                mobileDragState.lastTarget = hoverGroup;
                mobileDragState.lastPos = isAbove ? 'above' : 'below';
                mobileDragState.lastAction = 'reorderCat';
            }
        } else if (type === 'page') {
            const hoverCatHeader = elUnder.closest('.drawer-cat-header');
            if (hoverCatHeader && hoverCatHeader.dataset.categoryId !== sourceCatId) {
                hoverCatHeader.classList.add('cat-drop-hover');
                mobileDragState.lastTarget = hoverCatHeader;
                mobileDragState.lastAction = 'moveToCat';
                return;
            }

            const hoverPage = elUnder.closest('.drawer-page-item');
            if (hoverPage && hoverPage !== itemEl) {
                const rect = hoverPage.getBoundingClientRect();
                const isAbove = (pt.clientY - rect.top) < rect.height / 2;
                hoverPage.classList.add(isAbove ? 'drop-target-above' : 'drop-target-below');
                mobileDragState.lastTarget = hoverPage;
                mobileDragState.lastPos = isAbove ? 'above' : 'below';
                mobileDragState.lastAction = 'reorderPage';
            }
        } else if (type === 'checklist') {
            const hoverCard = elUnder.closest('.checklist-item-card');
            if (hoverCard && hoverCard !== itemEl) {
                const rect = hoverCard.getBoundingClientRect();
                const isAbove = (pt.clientY - rect.top) < rect.height / 2;
                hoverCard.classList.add(isAbove ? 'drop-target-above' : 'drop-target-below');
                mobileDragState.lastTarget = hoverCard;
                mobileDragState.lastPos = isAbove ? 'above' : 'below';
                mobileDragState.lastAction = 'reorderChecklist';
            }
        } else if (type === 'quick_task') {
            const hoverCard = elUnder.closest('.checklist-item-card');
            if (hoverCard && hoverCard !== itemEl) {
                const rect = hoverCard.getBoundingClientRect();
                const isAbove = (pt.clientY - rect.top) < rect.height / 2;
                hoverCard.classList.add(isAbove ? 'drop-target-above' : 'drop-target-below');
                mobileDragState.lastTarget = hoverCard;
                mobileDragState.lastPos = isAbove ? 'above' : 'below';
                mobileDragState.lastAction = 'reorderQuickTask';
            }
        } else if (type === 'quick_note') {
            const hoverNote = elUnder.closest('.overview-item[data-quick-note-id]');
            if (hoverNote && hoverNote !== itemEl) {
                const rect = hoverNote.getBoundingClientRect();
                const isAbove = (pt.clientY - rect.top) < rect.height / 2;
                hoverNote.classList.add(isAbove ? 'drop-target-above' : 'drop-target-below');
                mobileDragState.lastTarget = hoverNote;
                mobileDragState.lastPos = isAbove ? 'above' : 'below';
                mobileDragState.lastAction = 'reorderQuickNote';
            }
        }
    };

    const onEnd = async () => {
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);

        if (!mobileDragState) return;
        const state = mobileDragState;
        mobileDragState = null;

        if (state.ghost && state.ghost.parentNode) {
            state.ghost.parentNode.removeChild(state.ghost);
        }
        state.itemEl.classList.remove('android-lifted-item');
        clearMobileDropIndicators();

        window._suppressClickUntil = Date.now() + 600;

        if (!state.lastTarget || !state.lastAction) return;

        try {
            if (state.type === 'cat' && state.lastAction === 'reorderCat') {
                const catContainer = document.getElementById('drawer-categories-list');
                if (!catContainer) return;
                if (state.lastPos === 'above') {
                    catContainer.insertBefore(state.itemEl, state.lastTarget);
                } else {
                    catContainer.insertBefore(state.itemEl, state.lastTarget.nextSibling);
                }
                const catIds = Array.from(catContainer.querySelectorAll('.drawer-cat-group, .drawer-cat-divider-group'))
                    .map(el => parseInt(el.dataset.categoryId)).filter(Boolean);
                await window.appStorage.reorderCategories(catIds);
                if (window.appSync && window.appSync.isOnline) {
                    window.appSync.apiFetch('/notes/api/categories/reorder', {
                        method: 'POST',
                        body: JSON.stringify({ category_ids: catIds })
                    }).catch(()=>{});
                }
                showMobileToast('Dosya sırası güncellendi ✓');
            } else if (state.type === 'page') {
                const pageId = parseInt(state.itemId);
                if (state.lastAction === 'moveToCat') {
                    const targetCatId = parseInt(state.lastTarget.dataset.categoryId);
                    openCategoryIds.add(targetCatId);
                    const page = await window.appStorage.getPage(pageId);
                    if (page) {
                        page.category_id = targetCatId;
                        const targetPages = await window.appStorage.getPages(targetCatId);
                        page.sort_order = targetPages.length + 1;
                        await window.appStorage.savePage(page);
                    }
                    if (window.appSync && window.appSync.isOnline) {
                        window.appSync.apiFetch(`/notes/api/pages/${pageId}/move`, {
                            method: 'POST',
                            body: JSON.stringify({ category_id: targetCatId })
                        }).catch(()=>{});
                    }
                    await reloadDrawerNavigation();
                    showMobileToast('Sayfa yeni dosyaya aktarıldı ✓');
                } else if (state.lastAction === 'reorderPage') {
                    const targetParent = state.lastTarget.closest('.drawer-cat-pages');
                    if (!targetParent) return;
                    const targetCatId = parseInt(targetParent.dataset.categoryId);
                    if (state.lastPos === 'above') {
                        targetParent.insertBefore(state.itemEl, state.lastTarget);
                    } else {
                        targetParent.insertBefore(state.itemEl, state.lastTarget.nextSibling);
                    }
                    const pageIds = Array.from(targetParent.querySelectorAll('.drawer-page-item'))
                        .map(el => parseInt(el.dataset.pageId)).filter(Boolean);
                    await window.appStorage.reorderPages(targetCatId, pageIds);
                    if (window.appSync && window.appSync.isOnline) {
                        window.appSync.apiFetch('/notes/api/pages/reorder', {
                            method: 'POST',
                            body: JSON.stringify({ category_id: targetCatId, page_ids: pageIds })
                        }).catch(()=>{});
                    }
                    await reloadDrawerNavigation();
                    showMobileToast('Sayfa sırası güncellendi ✓');
                }
            } else if (state.type === 'checklist') {
                const listEl = document.getElementById('page-items-list');
                if (!listEl) return;
                if (state.lastPos === 'above') {
                    listEl.insertBefore(state.itemEl, state.lastTarget);
                } else {
                    listEl.insertBefore(state.itemEl, state.lastTarget.nextSibling);
                }
                const newIds = Array.from(listEl.querySelectorAll('.checklist-item-card'))
                    .map(el => parseInt(el.dataset.itemId)).filter(Boolean);
                await window.appStorage.reorderItems(state.pageId, newIds);
                if (window.appSync && window.appSync.isOnline) {
                    window.appSync.apiFetch(`/notes/api/pages/${state.pageId}/reorder`, {
                        method: 'POST',
                        body: JSON.stringify({ item_ids: newIds })
                    }).catch(()=>{});
                }
                showMobileToast('Madde sırası güncellendi ✓');
            } else if (state.type === 'quick_task') {
                const listEl = document.getElementById('quick-direct-tasks-list');
                if (!listEl) return;
                if (state.lastPos === 'above') {
                    listEl.insertBefore(state.itemEl, state.lastTarget);
                } else {
                    listEl.insertBefore(state.itemEl, state.lastTarget.nextSibling);
                }
                const newIds = Array.from(listEl.querySelectorAll('.checklist-item-card'))
                    .map(el => parseInt(el.dataset.itemId)).filter(Boolean);
                const quickPage = await getOrCreateQuickPage();
                if (quickPage) {
                    await window.appStorage.reorderItems(quickPage.id, newIds);
                    if (window.appSync && window.appSync.isOnline) {
                        window.appSync.apiFetch(`/notes/api/pages/${quickPage.id}/reorder`, {
                            method: 'POST',
                            body: JSON.stringify({ item_ids: newIds })
                        }).catch(()=>{});
                    }
                }
                showMobileToast('Hızlı görev sırası güncellendi ✓');
            } else if (state.type === 'quick_note') {
                const listEl = document.getElementById('quick-notes-list');
                if (!listEl) return;
                if (state.lastPos === 'above') {
                    listEl.insertBefore(state.itemEl, state.lastTarget);
                } else {
                    listEl.insertBefore(state.itemEl, state.lastTarget.nextSibling);
                }
                const newIds = Array.from(listEl.querySelectorAll('.overview-item[data-quick-note-id]'))
                    .map(el => parseInt(el.dataset.quickNoteId)).filter(Boolean);
                await window.appStorage.reorderQuickNotes(newIds);
                showMobileToast('Not sırası güncellendi ✓');
            }
        } catch (err) {
            console.error("Taşıma kaydetme hatası:", err);
        }
    };

    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: false });
    document.addEventListener('touchcancel', onEnd, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
}


// ─────────────────────────────────────────────────────────────────────────────
// Görünüm Değiştiriciler (View Switchers)
// ─────────────────────────────────────────────────────────────────────────────
function switchMainView(viewName) {
    activeView = viewName;
    document.querySelectorAll('.main-view').forEach(el => el.classList.remove('active'));

    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.add('active');

    // Çekmecedeki aktif linkleri sıfırla
    document.querySelectorAll('.drawer-nav-link').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.drawer-page-item').forEach(el => el.classList.remove('active'));

    // Üst Bar Ekle butonunun davranışını ayarla
    const addBtn = document.getElementById('btn-top-add');
    if (addBtn) {
        addBtn.style.display = (viewName === 'settings' || viewName === 'trash') ? 'none' : 'flex';
    }
}

async function openOverviewView() {
    switchMainView('ozet');
    toggleSidebar(false);

    const navOzet = document.getElementById('drawer-nav-ozet');
    if (navOzet) navOzet.classList.add('active');

    document.getElementById('top-title').innerHTML = `<span>📊</span> Genel Bakış`;
    document.getElementById('top-subtitle').innerText = document.getElementById('drawer-nb-name').innerText;

    await renderOverview();
}

async function openPage(pageId) {
    if (window._suppressClickUntil && Date.now() < window._suppressClickUntil) return;
    activePageId = pageId;
    switchMainView('page');
    toggleSidebar(false);

    await renderActivePage();
    await reloadDrawerNavigation(); // Aktif sayfa vurgusu için
}

async function openVaultView() {
    switchMainView('kasa');
    toggleSidebar(false);

    document.getElementById('top-title').innerHTML = `<span>🔐</span> Şifre Kasası`;
    document.getElementById('top-subtitle').innerText = 'Kişisel, Aile ve İş Şifreleri';

    await renderVaultGrid();
}

async function openTrashView() {
    switchMainView('trash');
    toggleSidebar(false);

    document.getElementById('top-title').innerHTML = `<span>🗑️</span> Çöp Kutusu`;
    document.getElementById('top-subtitle').innerText = 'Silinen Sayfalar ve Öğeler';

    await renderTrashList();
}

async function openSettingsView() {
    switchMainView('settings');
    toggleSidebar(false);

    document.getElementById('top-title').innerHTML = `<span>⚙️</span> Ayarlar`;
    document.getElementById('top-subtitle').innerText = 'Sunucu Bağlantısı & Sürüm';

    await loadSettingsUI();
}

function handleTopAddClick() {
    if (activeView === 'page' && activePageId && activePageObj) {
        if (activePageObj.type === 'checklist') {
            const input = document.getElementById('page-quick-input');
            if (input) input.focus();
        } else if (activePageObj.type === 'finance') {
            openAddFinanceModal();
        } else if (activePageObj.type === 'project') {
            if (currentProjectTab === 'materials') openAddMaterialModal();
            else openAddMilestoneModal();
        } else if (activePageObj.type === 'software') {
            if (currentSoftwareTab === 'tasks') openAddSoftwareTaskModal();
            else if (currentSoftwareTab === 'ideas') openAddSoftwareIdeaModal();
            else openAddSoftwareRuleModal();
        } else {
            const textarea = document.getElementById('page-note-content');
            if (textarea) textarea.focus();
        }
    } else if (activeView === 'kasa') {
        openVaultEditor(null);
    } else {
        openAddPageModal(null);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Sayfa Görünümü (Checklist, Not, Finans & Proje Detayı)
// ─────────────────────────────────────────────────────────────────────────────
async function renderActivePage() {
    if (!activePageId) return;

    const page = await window.appStorage.getPage(activePageId);
    if (!page || page._deleted) {
        await openOverviewView();
        return;
    }
    activePageObj = page;

    // Üst Bar Başlığı
    const categories = await window.appStorage.getAll('categories');
    const cat = categories.find(c => c.id == page.category_id);
    const catName = cat ? cat.name : 'Genel';

    const defaultIcon = page.type === 'checklist' ? '🛒' :
                        page.type === 'software' ? '💻' :
                        page.type === 'finance' ? '💳' :
                        page.type === 'project' ? '🔬' : '📝';

    document.getElementById('top-title').innerHTML = `<span>${page.icon || defaultIcon}</span> ${escapeHtml(page.title)}`;
    document.getElementById('top-subtitle').innerText = `${document.getElementById('drawer-nb-name').innerText} > ${catName}`;

    // Sayfa Başlık Kartı
    const catColor = (cat && cat.color) ? cat.color : '#3b82f6';
    const catBadge = document.getElementById('page-view-cat-badge');
    if (catBadge) {
        catBadge.innerText = (cat && cat.icon ? cat.icon + ' ' : '📁 ') + catName;
        catBadge.style.backgroundColor = catColor + '18';
        catBadge.style.color = catColor;
        catBadge.style.borderColor = catColor + '35';
    }
    document.getElementById('page-view-icon').innerText = page.icon || defaultIcon;
    document.getElementById('page-view-title-input').value = page.title || '';

    // Pin & Kilit Durumu
    const pinBtn = document.getElementById('m-btn-page-pin');
    if (pinBtn) {
        pinBtn.style.color = page.is_pinned ? 'var(--warning, #f59e0b)' : '';
        pinBtn.title = page.is_pinned ? 'Sabitlendi (Kaldırmak için tıkla)' : 'Başa Sabitle';
    }
    const lockBtn = document.getElementById('m-btn-page-lock');
    if (lockBtn) {
        lockBtn.style.color = page.is_locked ? 'var(--danger, #ef4444)' : '';
        lockBtn.title = page.is_locked ? 'Sayfa Kilitli' : 'Sayfayı Kilitle';
    }

    const lockedView = document.getElementById('mobile-locked-page-view');
    const unlocked = window[`unlocked_page_${page.id}`];
    const isChecklist = (page.type === 'checklist');
    const isNotes = (page.type === 'notes' || page.type === 'note');
    const isFinance = (page.type === 'finance');
    const isProject = (page.type === 'project');
    const isSoftware = (page.type === 'software');
    const softContainer = document.getElementById('page-software-container');

    if (page.is_locked && !unlocked) {
        if (lockedView) lockedView.style.display = 'block';
        document.getElementById('page-progress-wrap').style.display = 'none';
        document.getElementById('page-quick-add-box').style.display = 'none';
        document.getElementById('page-checklist-container').style.display = 'none';
        document.getElementById('page-note-container').style.display = 'none';
        document.getElementById('page-finance-container').style.display = 'none';
        document.getElementById('page-project-container').style.display = 'none';
        if (softContainer) softContainer.style.display = 'none';
        const pinInp = document.getElementById('m-locked-pin-input');
        if (pinInp) { pinInp.value = ''; pinInp.focus(); }
        return;
    } else {
        if (lockedView) lockedView.style.display = 'none';
    }

    document.getElementById('page-progress-wrap').style.display = isChecklist ? 'flex' : 'none';
    document.getElementById('page-quick-add-box').style.display = isChecklist ? 'flex' : 'none';
    document.getElementById('page-checklist-container').style.display = isChecklist ? 'flex' : 'none';
    document.getElementById('page-note-container').style.display = isNotes ? 'block' : 'none';
    document.getElementById('page-finance-container').style.display = isFinance ? 'flex' : 'none';
    document.getElementById('page-project-container').style.display = isProject ? 'flex' : 'none';
    if (softContainer) softContainer.style.display = isSoftware ? 'flex' : 'none';

    if (isChecklist) {
        await renderChecklistItems(page.id);
        fetchChecklistItemsFromServer(page.id);
    } else if (isFinance) {
        await renderFinancePage(page.id);
    } else if (isProject) {
        await renderProjectPage(page.id);
    } else if (isSoftware) {
        await renderSoftwarePage(page.id);
    } else {
        updateMobileWordGoalStats(page);
        loadMobileAttachmentsList(page.id);
        const richEditor = document.getElementById('page-rich-editor');
        const hiddenTa = document.getElementById('page-note-content');
        const rawContent = page.content || '';
        if (richEditor) {
            let htmlToRender = '';
            if (rawContent && !rawContent.trim().startsWith('<') && (rawContent.includes('**') || rawContent.includes('#') || rawContent.includes('- ') || rawContent.includes('\n'))) {
                htmlToRender = convertMarkdownToHtml(rawContent);
            } else {
                htmlToRender = rawContent;
            }
            richEditor.innerHTML = sanitizeRichHtml(htmlToRender);

            richEditor.onpaste = async (e) => {
                const items = (e.clipboardData || window.clipboardData)?.items;
                if (items) {
                    for (const item of items) {
                        if (item.type.indexOf('image') === 0) {
                            e.preventDefault();
                            const blob = item.getAsFile();
                            await uploadPastedImageMobile(blob, richEditor);
                            return;
                        }
                    }
                }
            };
        }
        if (hiddenTa) hiddenTa.value = rawContent;
        fetchPageDetailsFromServer(page.id);
        fetchPageBacklinksMobile(page.id);
    }
}

async function renderChecklistItems(pageId) {
    const items = await window.appStorage.getItems(pageId);
    const activeItems = items.filter(i => !i.is_done);
    const doneItems = items.filter(i => i.is_done);

    // İlerleme Çubuğu
    const total = items.length;
    const completed = doneItems.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const progressFill = document.getElementById('page-progress-fill');
    const progressText = document.getElementById('page-progress-text');
    const progressPct = document.getElementById('page-progress-percent');

    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.innerText = `${completed} / ${total} tamamlandı`;
    if (progressPct) progressPct.innerText = `%${pct}`;

    // Aktif Maddeler Listesi
    const listEl = document.getElementById('page-items-list');
    if (!listEl) return;

    if (activeItems.length === 0 && doneItems.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; padding:30px 10px; color:var(--muted); font-size:0.9rem;">
                Liste henüz boş.<br>Yukarıdaki kutudan ilk maddeyi ekleyin ✨
            </div>
        `;
    } else {
        listEl.innerHTML = activeItems.map(it => renderChecklistItemHtml(it)).join('');
    }

    // Tamamlananlar Bölümü
    const compSection = document.getElementById('completed-items-section');
    const compList = document.getElementById('page-completed-list');
    const compTitle = document.getElementById('completed-section-title');

    if (compSection && compList && compTitle) {
        if (doneItems.length > 0) {
            compSection.style.display = 'block';
            compTitle.innerText = `✓ Tamamlananlar (${doneItems.length})`;
            compList.innerHTML = doneItems.map(it => renderChecklistItemHtml(it)).join('');
        } else {
            compSection.style.display = 'none';
            compList.innerHTML = '';
        }
    }

    syncWidgetData();
    initChecklistItemsLongPressDrag(pageId);
}

function renderChecklistItemHtml(it) {
    let metaBadges = '';
    if (it.remind_at) {
        let displayRemind = it.remind_at;
        try {
            const dt = new Date(it.remind_at.replace(' ', 'T'));
            displayRemind = `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
        } catch(e) {}
        metaBadges += `<span class="meta-badge reminder" style="background:#f5f3ff; color:#7c3aed; border:1px solid #ddd6fe; cursor:pointer;" onclick="event.stopPropagation(); openEditItemModal(${it.id}, ${JSON.stringify(it.title || '').replace(/"/g, '&quot;')}, false)" title="Alarm ve Detayları Düzenle">⏰ ${displayRemind}</span>`;
    }
    if (it.price) metaBadges += `<span class="meta-badge price">💰 ${escapeHtml(it.price)}</span>`;
    if (it.quantity) metaBadges += `<span class="meta-badge" style="background:var(--surface2); color:var(--text-secondary);">${escapeHtml(it.quantity)}</span>`;
    if (it.url) metaBadges += `<a href="${escapeHtml(it.url)}" target="_system" class="meta-badge url" onclick="event.stopPropagation()">🔗 Link</a>`;

    const safeTitle = JSON.stringify(it.title || '').replace(/"/g, '&quot;');

    return `
        <div class="checklist-item-card ${it.is_done ? 'done' : ''}" id="item-card-${it.id}" style="cursor:pointer;" onclick="openEditItemModal(${it.id}, ${safeTitle}, false)" data-item-id="${it.id}">
            <div class="checkbox-custom ${it.is_done ? 'checked' : ''}" onclick="event.stopPropagation(); toggleItemDone(${it.id})" title="${it.is_done ? 'Tamamlanmadı yap' : 'Tamamla'}">
                ${it.is_done ? '✓' : ''}
            </div>
            <div class="checklist-item-body" onclick="event.stopPropagation(); openEditItemModal(${it.id}, ${safeTitle}, false)">
                <div class="checklist-item-title" style="${it.is_done ? 'text-decoration:line-through; opacity:0.6;' : ''}">${escapeHtml(it.title)}</div>
                ${metaBadges ? `<div class="checklist-item-meta">${metaBadges}</div>` : ''}
            </div>
            <div class="checklist-item-actions" style="display:flex; align-items:center; gap:4px;">
                <button class="item-action-btn" onclick="event.stopPropagation(); deletePageItem(${it.id})" title="Sil" style="color:var(--danger); font-size:0.9rem;">🗑️</button>
            </div>
        </div>
    `;
}

function toggleCompletedSection() {
    const list = document.getElementById('page-completed-list');
    const arrow = document.getElementById('completed-section-arrow');
    if (!list) return;
    const isHidden = list.style.display === 'none';
    list.style.display = isHidden ? 'flex' : 'none';
    if (arrow) arrow.innerText = isHidden ? '▼' : '▶';
}

async function quickAddCurrentPageItem() {
    const input = document.getElementById('page-quick-input');
    if (!input || !activePageId) return;
    const rawText = input.value.trim();
    if (!rawText) return;

    // Fiyat ve link ayrıştırma (Örn: "Süt 45 TL https://..." veya düz "Ekmek")
    let title = rawText;
    let price = '';
    let url = '';

    const urlMatch = rawText.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
        url = urlMatch[0];
        title = title.replace(url, '').trim();
    }

    const priceMatch = title.match(/(\d+([.,]\d+)?)\s*(TL|tl|₺)/);
    if (priceMatch) {
        price = priceMatch[0];
        title = title.replace(price, '').trim();
    }

    if (!title && url) title = 'İnternet Bağlantısı';

    const newItem = {
        page_id: activePageId,
        title: title || rawText,
        price: price,
        url: url,
        is_done: 0,
        sort_order: 999
    };

    input.value = '';
    await window.appStorage.saveItem(newItem);
    await renderChecklistItems(activePageId);

    // Arka planda sunucuya da ilet
    window.appSync.syncNow();
}

async function toggleItemDone(itemId) {
    await window.appStorage.toggleItemDone(itemId);
    await renderChecklistItems(activePageId);
    window.appSync.syncNow();
}

async function deletePageItem(itemId) {
    await window.appStorage.deleteItem(itemId);
    await renderChecklistItems(activePageId);
    window.appSync.syncNow();
}

async function updateCurrentPageTitle(newTitle) {
    if (!activePageId) return;
    const page = await window.appStorage.getPage(activePageId);
    if (page) {
        page.title = newTitle.trim() || 'İsimsiz Sayfa';
        await window.appStorage.savePage(page);
        document.getElementById('top-title').innerHTML = `<span>${page.icon || '📝'}</span> ${escapeHtml(page.title)}`;
        await reloadDrawerNavigation();
        window.appSync.syncNow();
    }
}

async function autoSaveCurrentNote(content, immediate = false) {
    if (!activePageId) return;
    clearTimeout(noteSaveTimeout);
    const doSave = async () => {
        const page = await window.appStorage.getPage(activePageId);
        if (page) {
            page.content = content;
            await window.appStorage.savePage(page);
            window.appSync.syncNow();
        }
    };
    if (immediate) {
        await doSave();
    } else {
        noteSaveTimeout = setTimeout(doSave, 350);
    }
}

function handleMobileRichNoteInput() {
    const editor = document.getElementById('page-rich-editor');
    const hiddenTa = document.getElementById('page-note-content');
    if (editor) {
        const html = editor.innerHTML;
        if (hiddenTa) hiddenTa.value = html;
        autoSaveCurrentNote(html);
    }
}

function formatMobileRichNote(cmd, val = null) {
    const editor = document.getElementById('page-rich-editor');
    if (!editor) return;
    editor.focus();
    document.execCommand(cmd, false, val);
    handleMobileRichNoteInput();
}

function insertMobileChecklistItem() {
    const editor = document.getElementById('page-rich-editor');
    if (!editor) return;
    editor.focus();
    const checkHtml = '<div style="margin:4px 0;"><label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" onclick="event.stopPropagation()"> <span>Yeni görev</span></label></div>';
    document.execCommand('insertHTML', false, checkHtml);
    handleMobileRichNoteInput();
}

async function triggerMobileAiActionize() {
    const editor = document.getElementById('page-rich-editor');
    if (!editor) return;
    const text = editor.innerText.trim();
    if (!text) {
        alert("Dönüştürülecek not içeriği boş!");
        return;
    }
    try {
        const res = await window.appSync.apiFetch('/notes/api/ai/actionize', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({text: text})
        });
        if (res.ok) {
            const data = await res.json();
            if (data.ok && data.tasks && data.tasks.length > 0) {
                let tasksHtml = '<div style="margin-top:12px; padding:10px; background:rgba(59,130,246,0.08); border-radius:8px; border-left:3px solid #3b82f6;"><p style="font-weight:700; margin:0 0 6px 0;">☑️ AI Tarafından Çıkarılan Görevler:</p><ul style="margin:0; padding-left:20px;">';
                data.tasks.forEach(t => {
                    tasksHtml += `<li>☐ ${escapeHtml(t.title)}</li>`;
                });
                tasksHtml += '</ul></div><br>';
                editor.focus();
                document.execCommand('insertHTML', false, tasksHtml);
                handleMobileRichNoteInput();
            }
        }
    } catch(e) {
        console.error("AI actionize error:", e);
    }
}

function convertMarkdownToHtml(md) {
    if (!md) return '';
    let html = escapeHtml(md);
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/\*\*(.*?)\*\*/gim, '<b>$1</b>');
    html = html.replace(/\*(.*?)\*/gim, '<i>$1</i>');
    html = html.replace(/`(.*?)`/gim, '<code>$1</code>');
    html = html.replace(/^- \[ \] (.*$)/gim, '<div style="margin:4px 0;"><label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox"> <span>$1</span></label></div>');
    html = html.replace(/^- \[x\] (.*$)/gim, '<div style="margin:4px 0;"><label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" checked> <span style="text-decoration:line-through; opacity:0.7;">$1</span></label></div>');
    html = html.replace(/^- (.*$)/gim, '<li>$1</li>');
    html = html.replace(/\[\[(.*?)\]\]/gim, '<a href="javascript:void(0)" onclick="openPageByTitle(\'$1\')" style="color:var(--primary); font-weight:600; text-decoration:underline;">📄 $1</a>');
    html = html.replace(/\n/g, '<br>');
    return html;
}

async function openPageByTitle(pageTitle) {
    if (!pageTitle) return;
    const pages = await window.appStorage.getAll('pages');
    const target = pages.find(p => p.title && p.title.toLowerCase().trim() === pageTitle.toLowerCase().trim());
    if (target) {
        await openPage(target.id);
    } else {
        alert(`"${pageTitle}" başlıklı sayfa bulunamadı.`);
    }
}

async function fetchPageBacklinksMobile(pageId) {
    const container = document.getElementById('page-backlinks-container');
    const list = document.getElementById('page-backlinks-list');
    const countEl = document.getElementById('backlinks-count');
    if (!container || !list) return;

    try {
        const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}/backlinks`);
        if (res.ok) {
            const data = await res.json();
            if (data.ok && data.backlinks && data.backlinks.length > 0) {
                if (countEl) countEl.innerText = data.count;
                list.innerHTML = data.backlinks.map(b => `
                    <div style="padding:6px 10px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; cursor:pointer; display:flex; align-items:center; justify-content:space-between;" onclick="openPage(${b.id})">
                        <span style="font-weight:600; font-size:0.85rem;">${b.icon || '📄'} ${escapeHtml(b.title)}</span>
                        <span style="font-size:0.75rem; color:var(--muted);">${b.category_name || ''}</span>
                    </div>
                `).join('');
                container.style.display = 'block';
                return;
            }
        }
    } catch(e) {}
    container.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sesli Dikte (Speech-to-Text / Web Speech API)
// ─────────────────────────────────────────────────────────────────────────────
let currentSpeechRecognition = null;

function toggleVoiceDictation(targetInputId, btnEl) {
    const input = document.getElementById(targetInputId);
    if (!input) return;

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        alert("Cihazınızda sesli dikte (Web Speech API) desteklenmiyor.");
        return;
    }

    if (currentSpeechRecognition) {
        currentSpeechRecognition.stop();
        currentSpeechRecognition = null;
        if (btnEl) btnEl.classList.remove('listening');
        return;
    }

    try {
        const rec = new SpeechRec();
        rec.lang = 'tr-TR';
        rec.continuous = false;
        rec.interimResults = true;

        if (btnEl) btnEl.classList.add('listening');
        currentSpeechRecognition = rec;

        let initialVal = input.value ? input.value + ' ' : '';

        rec.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }
            input.value = initialVal + (finalTranscript || interimTranscript);
        };

        rec.onerror = (e) => {
            if (btnEl) btnEl.classList.remove('listening');
            currentSpeechRecognition = null;
        };

        rec.onend = () => {
            if (btnEl) btnEl.classList.remove('listening');
            currentSpeechRecognition = null;
        };

        rec.start();
    } catch(err) {
        if (btnEl) btnEl.classList.remove('listening');
        currentSpeechRecognition = null;
    }
}

function toggleVoiceDictationRich(editorId, btnEl) {
    const editor = document.getElementById(editorId);
    if (!editor) return;

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        alert("Cihazınızda sesli dikte (Web Speech API) desteklenmiyor.");
        return;
    }

    if (currentSpeechRecognition) {
        currentSpeechRecognition.stop();
        currentSpeechRecognition = null;
        if (btnEl) btnEl.classList.remove('listening');
        return;
    }

    try {
        const rec = new SpeechRec();
        rec.lang = 'tr-TR';
        rec.continuous = false;
        rec.interimResults = false;

        if (btnEl) btnEl.classList.add('listening');
        currentSpeechRecognition = rec;

        rec.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            editor.focus();
            document.execCommand('insertText', false, ' ' + transcript);
            handleMobileRichNoteInput();
        };

        rec.onerror = (e) => {
            if (btnEl) btnEl.classList.remove('listening');
            currentSpeechRecognition = null;
        };

        rec.onend = () => {
            if (btnEl) btnEl.classList.remove('listening');
            currentSpeechRecognition = null;
        };

        rec.start();
    } catch(err) {
        if (btnEl) btnEl.classList.remove('listening');
        currentSpeechRecognition = null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobil Geri Al (Undo / Ctrl+Z) Yöneticisi
// ─────────────────────────────────────────────────────────────────────────────
window._deletedHistoryStack = [];
let undoMobileToastTimeout = null;

function pushDeletedHistory(type, data, restoreFn) {
    window._deletedHistoryStack.push({
        type: type,
        data: data,
        restore: restoreFn,
        timestamp: Date.now()
    });
    const label = (data.title || data.content || data.name || 'Öğe').substring(0, 22);
    showUndoToast(`"${label}" silindi`, restoreFn);
}

function showUndoToast(msg, restoreFn) {
    const toast = document.getElementById('undo-toast');
    if (!toast) return;
    toast.innerHTML = `
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🗑️ ${escapeHtml(msg)}</span>
        <button class="undo-toast-btn" onclick="undoLastDelete()">↩️ Geri Al</button>
    `;
    toast.style.display = 'flex';
    clearTimeout(undoMobileToastTimeout);
    undoMobileToastTimeout = setTimeout(() => {
        toast.style.display = 'none';
    }, 7000);
}

function hideUndoToast() {
    const toast = document.getElementById('undo-toast');
    if (toast) toast.style.display = 'none';
    clearTimeout(undoMobileToastTimeout);
}

async function undoLastDelete() {
    if (!window._deletedHistoryStack || window._deletedHistoryStack.length === 0) {
        return;
    }
    const last = window._deletedHistoryStack.pop();
    if (last && typeof last.restore === 'function') {
        await last.restore();
        hideUndoToast();
    }
}

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        const active = document.activeElement;
        const isEditing = active && (
            active.tagName === 'INPUT' || 
            active.tagName === 'TEXTAREA' || 
            active.isContentEditable
        );
        if (!isEditing && window._deletedHistoryStack && window._deletedHistoryStack.length > 0) {
            e.preventDefault();
            undoLastDelete();
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Sunucudan Taze Veri Çekme (Live Online Fallback & Update)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchChecklistItemsFromServer(pageId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (!isAlive) return;
        const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}/items`);
        if (res.ok) {
            const data = await res.json();
            if (data.items) {
                for (const it of data.items) {
                    await window.appStorage.put('items', { ...it, _dirty: false, _deleted: false });
                }
                if (activePageId == pageId && activeView === 'page') {
                    await renderChecklistItems(pageId);
                }
            }
        }
    } catch (e) {
        console.warn("fetchChecklistItemsFromServer error:", e);
    }
}

async function fetchPageDetailsFromServer(pageId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (!isAlive) return;
        const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}`);
        if (res.ok) {
            const data = await res.json();
            if (data.page) {
                await window.appStorage.put('pages', { ...data.page, _dirty: false, _deleted: false });
                if (activePageId == pageId && activeView === 'page') {
                    const noteContentEl = document.getElementById('page-note-content');
                    if (noteContentEl && noteContentEl.value !== data.page.content) {
                        noteContentEl.value = data.page.content || '';
                    }
                }
            }
        }
    } catch (e) {
        console.warn("fetchPageDetailsFromServer error:", e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finans & Bütçe İşleyicileri (Finance & Budget Handlers)
// ─────────────────────────────────────────────────────────────────────────────
async function renderFinancePage(pageId) {
    if (!pageId) pageId = activePageId;
    if (!pageId) return;

    // 1. Dönem başlığını güncelle
    const disp = document.getElementById('fin-period-display');
    if (disp) disp.innerText = currentFinancePeriod;

    // 2. İlk olarak yerel veriyi göster (Çevrimdışı desteği)
    const allFin = await window.appStorage.getAll('finances');
    let entries = allFin.filter(f => !f._deleted && f.page_id == pageId && (!f.period || f.period === currentFinancePeriod));

    calculateAndShowFinanceSummary(entries);
    renderFinanceListHtml(entries);

    // 3. Sunucuya bağlanıp taze veri çek
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}/finance?period=${currentFinancePeriod}`);
            if (res.ok) {
                const data = await res.json();
                if (data.entries) {
                    for (const fe of data.entries) {
                        await window.appStorage.put('finances', { ...fe, _dirty: false, _deleted: false });
                    }
                    entries = data.entries;
                    if (data.summary) {
                        applyFinanceSummary(data.summary, entries);
                    } else {
                        calculateAndShowFinanceSummary(entries);
                    }
                    renderFinanceListHtml(entries);
                }
            }
        }
    } catch (e) {
        console.warn("renderFinancePage server error:", e);
    }
}

function calculateAndShowFinanceSummary(entries) {
    const incomes = entries.filter(e => e.entry_type === 'income');
    const expenses = entries.filter(e => e.entry_type === 'expense');
    const totInc = incomes.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const totExp = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const unpaidExp = expenses.filter(e => !e.is_paid).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    applyFinanceSummary({
        total_income: totInc,
        total_expense: totExp,
        net_balance: totInc - totExp,
        unpaid_expense: unpaidExp,
        income_count: incomes.length,
        expense_count: expenses.length
    }, entries);
}

function applyFinanceSummary(summary, entries) {
    const elInc = document.getElementById('fin-kpi-income');
    const elIncSub = document.getElementById('fin-kpi-income-sub');
    const elExp = document.getElementById('fin-kpi-expense');
    const elExpSub = document.getElementById('fin-kpi-expense-sub');
    const elBal = document.getElementById('fin-kpi-balance');
    const elUnp = document.getElementById('fin-kpi-unpaid');
    const elUnpSub = document.getElementById('fin-kpi-unpaid-sub');

    if (elInc) elInc.innerText = `${formatMoney(summary.total_income)} TL`;
    if (elIncSub) elIncSub.innerText = `${summary.income_count || 0} kalem`;
    if (elExp) elExp.innerText = `${formatMoney(summary.total_expense)} TL`;
    if (elExpSub) elExpSub.innerText = `${summary.expense_count || 0} kalem`;
    if (elBal) elBal.innerText = `${formatMoney(summary.net_balance)} TL`;
    if (elUnp) elUnp.innerText = `${formatMoney(summary.unpaid_expense)} TL`;

    const unpaidCount = entries ? entries.filter(e => e.entry_type === 'expense' && !e.is_paid).length : 0;
    if (elUnpSub) elUnpSub.innerText = `${unpaidCount} bekleyen`;
}

function renderFinanceListHtml(entries) {
    const listEl = document.getElementById('page-finance-list');
    if (!listEl) return;

    let filtered = entries;
    if (currentFinanceFilter === 'expense') {
        filtered = entries.filter(e => e.entry_type === 'expense');
    } else if (currentFinanceFilter === 'income') {
        filtered = entries.filter(e => e.entry_type === 'income');
    } else if (currentFinanceFilter === 'unpaid') {
        filtered = entries.filter(e => e.entry_type === 'expense' && !e.is_paid);
    }

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; padding:30px 10px; color:var(--muted); font-size:0.9rem;">
                Bu dönemde finans kaydı bulunamadı.<br>Yukarıdaki ➕ Ekle butonuyla yeni kalem ekleyin.
            </div>
        `;
        return;
    }

    listEl.innerHTML = filtered.map(e => renderFinanceEntryCardHtml(e)).join('');
}

function renderFinanceEntryCardHtml(e) {
    const isExpense = e.entry_type === 'expense';
    const amountSign = isExpense ? '-' : '+';
    const amountClass = isExpense ? 'expense' : 'income';
    const typeIcon = isExpense ? '📉' : '📈';
    const isPaid = !!e.is_paid;

    let metaBadges = `<span class="fin-entry-pill">${escapeHtml(e.category || 'Genel')}</span>`;
    if (e.due_day) {
        metaBadges += `<span class="fin-entry-pill">📅 ${e.due_day}. gün</span>`;
    }
    if (e.is_recurring) {
        metaBadges += `<span class="fin-entry-pill">🔄 Düzenli</span>`;
    }
    if (e.notes) {
        metaBadges += `<span class="fin-entry-pill" title="${escapeHtml(e.notes)}">💬 ${escapeHtml(e.notes)}</span>`;
    }

    const payBtnHtml = isExpense ? `
        <button class="fin-pay-btn ${isPaid ? 'paid' : 'unpaid'}" onclick="toggleFinancePaid(${e.id})">
            ${isPaid ? '✓ Ödendi' : '⏳ Bekliyor'}
        </button>
    ` : `
        <span class="fin-entry-pill" style="color:var(--success); font-weight:700;">Gelir</span>
    `;

    return `
        <div class="fin-entry-card" id="fin-entry-${e.id}">
            <div class="fin-entry-left">
                <div class="fin-entry-title-row">
                    <span>${typeIcon}</span>
                    <span class="fin-entry-title">${escapeHtml(e.title)}</span>
                </div>
                <div class="fin-entry-meta">
                    ${metaBadges}
                </div>
            </div>
            <div class="fin-entry-right">
                <div class="fin-entry-amount ${amountClass}">${amountSign}${formatMoney(e.amount)} TL</div>
                <div style="display:flex; align-items:center; gap:6px;">
                    ${payBtnHtml}
                    <button class="btn-ghost" style="padding:4px; font-size:0.85rem;" onclick="deleteFinanceEntry(${e.id})" title="Sil">🗑️</button>
                </div>
            </div>
        </div>
    `;
}

function changeFinancePeriod(delta) {
    const parts = currentFinancePeriod.split('-');
    let year = parseInt(parts[0], 10) || new Date().getFullYear();
    let month = parseInt(parts[1], 10) || (new Date().getMonth() + 1);

    month += delta;
    if (month > 12) {
        month = 1;
        year += 1;
    } else if (month < 1) {
        month = 12;
        year -= 1;
    }

    currentFinancePeriod = `${year}-${String(month).padStart(2, '0')}`;
    renderFinancePage(activePageId);
}

function resetFinancePeriod() {
    const now = new Date();
    currentFinancePeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    renderFinancePage(activePageId);
}

function filterFinanceEntries(filter) {
    currentFinanceFilter = filter;
    ['all', 'expense', 'income', 'unpaid'].forEach(f => {
        const btn = document.getElementById(`fin-filter-${f}`);
        if (btn) btn.classList.toggle('active', f === filter);
    });
    renderFinancePage(activePageId);
}

function openAddFinanceModal() {
    document.getElementById('fin-add-title').value = '';
    document.getElementById('fin-add-amount').value = '';
    document.getElementById('fin-add-notes').value = '';
    document.getElementById('fin-add-dueday').value = '15';
    document.getElementById('fin-add-recurring').checked = true;
    openModal('modal-add-finance');
}

async function submitAddFinanceEntry() {
    const title = document.getElementById('fin-add-title').value.trim();
    const amount = parseFloat(document.getElementById('fin-add-amount').value) || 0;
    const type = document.getElementById('fin-add-type').value;
    const cat = document.getElementById('fin-add-cat').value.trim() || 'Genel';
    const dueDay = parseInt(document.getElementById('fin-add-dueday').value, 10) || 1;
    const isRecurring = document.getElementById('fin-add-recurring').checked;
    const notes = document.getElementById('fin-add-notes').value.trim();

    if (!title || amount <= 0) {
        alert('Lütfen geçerli bir açıklama ve tutar girin.');
        return;
    }

    const payload = {
        entry_type: type,
        title: title,
        amount: amount,
        category: cat,
        due_day: dueDay,
        is_recurring: isRecurring ? 1 : 0,
        period: currentFinancePeriod,
        notes: notes
    };

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/finance`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.ok) {
                    closeModal('modal-add-finance');
                    await renderFinancePage(activePageId);
                    window.appSync.syncNow();
                    return;
                }
            }
        }
    } catch (e) {
        console.warn("submitAddFinanceEntry server error, saving locally:", e);
    }

    const localEntry = {
        id: Date.now(),
        page_id: activePageId,
        ...payload,
        is_paid: 0,
        _dirty: true,
        _deleted: false
    };
    await window.appStorage.put('finances', localEntry);
    closeModal('modal-add-finance');
    await renderFinancePage(activePageId);
}

async function toggleFinancePaid(entryId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/finance/${entryId}/toggle`, { method: 'POST' });
        }
    } catch (e) {
        console.warn("toggleFinancePaid server error:", e);
    }

    const entry = await window.appStorage.get('finances', entryId);
    if (entry) {
        entry.is_paid = entry.is_paid ? 0 : 1;
        entry._dirty = true;
        await window.appStorage.put('finances', entry);
    }
    await renderFinancePage(activePageId);
}

async function deleteFinanceEntry(entryId) {
    if (!confirm('Bu finans kaydını silmek istediğinize emin misiniz?')) return;

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/finance/${entryId}`, { method: 'DELETE' });
        }
    } catch (e) {
        console.warn("deleteFinanceEntry server error:", e);
    }

    const entry = await window.appStorage.get('finances', entryId);
    if (entry) {
        entry._deleted = true;
        entry._dirty = true;
        await window.appStorage.put('finances', entry);
    }
    await renderFinancePage(activePageId);
}

async function copyRecurringFinanceFromPrev() {
    const parts = currentFinancePeriod.split('-');
    let year = parseInt(parts[0], 10);
    let month = parseInt(parts[1], 10);
    month -= 1;
    if (month < 1) {
        month = 12;
        year -= 1;
    }
    const prevPeriod = `${year}-${String(month).padStart(2, '0')}`;

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/finance/copy_recurring`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_period: prevPeriod, target_period: currentFinancePeriod })
            });
            const data = await res.json();
            if (data.ok) {
                alert(`${data.copied_count || 0} adet düzenli ödeme bu aya aktarıldı.`);
                await renderFinancePage(activePageId);
                return;
            }
        }
    } catch (e) {
        alert('Sunucuya bağlanılamadı: ' + e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Proje & Atölye İşleyicileri (Project Handlers)
// ─────────────────────────────────────────────────────────────────────────────
async function renderProjectPage(pageId) {
    if (!pageId) pageId = activePageId;
    if (!pageId) return;

    // Sunucudan veya yerelden proje verisini çek
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}/project`);
            if (res.ok) {
                const data = await res.json();
                if (data.ok && data.project) {
                    currentProjectData = data.project;
                    await window.appStorage.saveProject({
                        id: pageId,
                        page_id: pageId,
                        data: data.project
                    });
                }
            }
        }
    } catch (e) {
        console.warn("renderProjectPage server fetch error:", e);
    }

    if (!currentProjectData) {
        const cached = await window.appStorage.get('projects', pageId);
        if (cached && cached.data) {
            currentProjectData = cached.data;
        }
    }

    if (!currentProjectData) {
        currentProjectData = {
            details: { status: 'planning', concept: '' },
            milestones: [],
            materials: [],
            stats: { progress_pct: 0, total_milestones: 0, completed_milestones: 0, needed_materials: 0, total_mat_cost: 0 }
        };
    }

    const { details, milestones, materials, stats } = currentProjectData;

    // Header güncelleme
    const statusSelect = document.getElementById('project-status-select');
    if (statusSelect && details) statusSelect.value = details.status || 'planning';

    const progFill = document.getElementById('project-progress-fill');
    const kpiProg = document.getElementById('proj-kpi-prog');
    const kpiMs = document.getElementById('proj-kpi-ms');
    const kpiNeeded = document.getElementById('proj-kpi-needed');
    const kpiCost = document.getElementById('proj-kpi-cost');

    const pct = (stats && stats.progress_pct !== undefined) ? stats.progress_pct : 0;
    if (progFill) progFill.style.width = `${pct}%`;
    if (kpiProg) kpiProg.innerText = `%${pct}`;
    if (kpiMs) kpiMs.innerText = `${stats ? stats.completed_milestones : 0}/${stats ? stats.total_milestones : 0}`;
    if (kpiNeeded) kpiNeeded.innerText = stats ? stats.needed_materials : 0;
    if (kpiCost) kpiCost.innerText = `${formatMoney(stats ? stats.total_mat_cost : 0)} TL`;

    const conceptTextarea = document.getElementById('project-concept-content');
    if (conceptTextarea && details) conceptTextarea.value = details.concept || '';

    // Aşamalar Listesi
    const msList = document.getElementById('project-milestones-list');
    if (msList) {
        if (!milestones || milestones.length === 0) {
            msList.innerHTML = `
                <div style="text-align:center; padding:25px 10px; color:var(--muted); font-size:0.9rem;">
                    Henüz aşama eklenmemiş.<br>Yukarıdaki ➕ Aşama Ekle butonunu kullanın.
                </div>
            `;
        } else {
            msList.innerHTML = milestones.map(m => renderProjectMilestoneCardHtml(m)).join('');
        }
    }

    // Malzemeler Listesi
    const matList = document.getElementById('project-materials-list');
    if (matList) {
        if (!materials || materials.length === 0) {
            matList.innerHTML = `
                <div style="text-align:center; padding:25px 10px; color:var(--muted); font-size:0.9rem;">
                    Henüz malzeme listesi (BOM) eklenmemiş.<br>Yukarıdaki ➕ Malzeme Ekle butonunu kullanın.
                </div>
            `;
        } else {
            matList.innerHTML = materials.map(m => renderProjectMaterialCardHtml(m)).join('');
        }
    }
}

function renderProjectMilestoneCardHtml(m) {
    const isCompleted = m.status === 'completed';
    const statusLabels = {
        pending: '⏳ Bekliyor',
        in_progress: '⚙️ Devam',
        completed: '✅ Tamam'
    };
    const badgeLabel = statusLabels[m.status] || '⏳ Bekliyor';

    let stepsHtml = '';
    if (m.requirements) {
        const lines = m.requirements.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length > 0) {
            stepsHtml = `
                <div style="margin-top:6px; padding:6px 8px; background:var(--surface2); border-radius:6px; font-size:0.78rem;">
                    <div style="font-weight:700; color:var(--muted); margin-bottom:2px;">📋 Adımlar:</div>
                    ${lines.map(l => `<div>• ${escapeHtml(l)}</div>`).join('')}
                </div>
            `;
        }
    }

    return `
        <div class="project-milestone-card ${isCompleted ? 'completed' : ''}" id="milestone-card-${m.id}">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                <div style="display:flex; flex-direction:column; gap:2px; flex:1;">
                    <span class="ms-title" style="font-weight:700; font-size:0.95rem; color:var(--text);">${escapeHtml(m.title)}</span>
                    <div style="display:flex; gap:6px; align-items:center; font-size:0.75rem; color:var(--muted);">
                        ${m.target_date ? `<span>📅 ${escapeHtml(m.target_date)}</span>` : ''}
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <button class="mat-status-pill ${m.status === 'completed' ? 'available' : m.status === 'in_progress' ? 'ordered' : 'needed'}" onclick="toggleMilestoneStatus(${m.id})">
                        ${badgeLabel}
                    </button>
                    <button class="btn-ghost" style="padding:2px 4px; font-size:0.85rem;" onclick="deleteMilestone(${m.id})" title="Sil">🗑️</button>
                </div>
            </div>
            ${m.description ? `<div style="font-size:0.82rem; color:var(--text-secondary);">${escapeHtml(m.description)}</div>` : ''}
            ${stepsHtml}
        </div>
    `;
}

function renderProjectMaterialCardHtml(m) {
    const statusLabels = {
        needed: '🔍 Aranıyor',
        ordered: '📦 Sipariş',
        available: '✅ Elde Var'
    };
    const badgeLabel = statusLabels[m.status] || '🔍 Aranıyor';
    const unitPrice = parseFloat(m.unit_price) || 0;
    const qty = parseFloat(m.quantity) || 1;
    const totalPrice = unitPrice * qty;

    return `
        <div class="project-material-card" id="mat-card-${m.id}">
            <div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;">
                <div style="font-weight:700; font-size:0.92rem; color:var(--text);">${escapeHtml(m.name)}</div>
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:0.76rem; color:var(--muted);">
                    <span>Miktar: ${escapeHtml(String(m.quantity || '1'))}</span>
                    <span>•</span>
                    <span>Birim: ${formatMoney(unitPrice)} TL</span>
                    ${m.url ? `<a href="${escapeHtml(m.url)}" target="_system" style="color:var(--accent); text-decoration:none; font-weight:600;">🔗 Link</a>` : ''}
                </div>
                ${m.notes ? `<div style="font-size:0.75rem; color:var(--muted);">${escapeHtml(m.notes)}</div>` : ''}
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                <div style="font-size:0.95rem; font-weight:800; color:var(--text);">${formatMoney(totalPrice)} TL</div>
                <div style="display:flex; align-items:center; gap:4px;">
                    <button class="mat-status-pill ${m.status || 'needed'}" onclick="toggleMaterialStatus(${m.id})">
                        ${badgeLabel}
                    </button>
                    <button class="btn-ghost" style="padding:2px 4px; font-size:0.85rem;" onclick="deleteMaterial(${m.id})" title="Sil">🗑️</button>
                </div>
            </div>
        </div>
    `;
}

function switchProjectTab(tabName) {
    currentProjectTab = tabName;
    ['milestones', 'materials', 'concept'].forEach(t => {
        const btn = document.getElementById(`ptab-btn-${t}`);
        const pane = document.getElementById(`project-pane-${t}`);
        if (btn) btn.classList.toggle('active', t === tabName);
        if (pane) pane.style.display = (t === tabName) ? 'block' : 'none';
    });
}

async function updateProjectStatusFromUI(newStatus) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/project`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus })
            });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("updateProjectStatus error:", e);
    }
}

function autoSaveProjectConcept(content) {
    clearTimeout(projectConceptSaveTimeout);
    projectConceptSaveTimeout = setTimeout(async () => {
        try {
            const isAlive = await window.appSync.checkConnection();
            if (isAlive) {
                await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/project`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ concept: content })
                });
            }
        } catch (e) {
            console.warn("autoSaveProjectConcept error:", e);
        }
    }, 600);
}

function openAddMilestoneModal() {
    document.getElementById('ms-add-title').value = '';
    document.getElementById('ms-add-date').value = '';
    document.getElementById('ms-add-desc').value = '';
    document.getElementById('ms-add-reqs').value = '';
    document.getElementById('ms-add-status').value = 'pending';
    openModal('modal-add-milestone');
}

async function submitAddMilestoneEntry() {
    const title = document.getElementById('ms-add-title').value.trim();
    const date = document.getElementById('ms-add-date').value.trim();
    const status = document.getElementById('ms-add-status').value;
    const desc = document.getElementById('ms-add-desc').value.trim();
    const reqs = document.getElementById('ms-add-reqs').value.trim();

    if (!title) {
        alert('Lütfen aşama başlığı girin.');
        return;
    }

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/project/milestones`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title,
                    target_date: date,
                    status: status,
                    description: desc,
                    requirements: reqs
                })
            });
            if (res.ok) {
                closeModal('modal-add-milestone');
                await renderProjectPage(activePageId);
                return;
            }
        }
    } catch (e) {
        alert('Hata: ' + e.message);
    }
}

async function toggleMilestoneStatus(milestoneId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/milestones/${milestoneId}/toggle`, { method: 'POST' });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("toggleMilestoneStatus error:", e);
    }
}

async function deleteMilestone(milestoneId) {
    if (!confirm('Bu aşamayı silmek istediğinize emin misiniz?')) return;
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/milestones/${milestoneId}`, { method: 'DELETE' });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("deleteMilestone error:", e);
    }
}

function openAddMaterialModal() {
    document.getElementById('mat-add-name').value = '';
    document.getElementById('mat-add-qty').value = '1';
    document.getElementById('mat-add-price').value = '';
    document.getElementById('mat-add-status').value = 'needed';
    document.getElementById('mat-add-url').value = '';
    document.getElementById('mat-add-notes').value = '';
    openModal('modal-add-material');
}

async function submitAddMaterialEntry() {
    const name = document.getElementById('mat-add-name').value.trim();
    const qty = document.getElementById('mat-add-qty').value.trim() || '1';
    const price = parseFloat(document.getElementById('mat-add-price').value) || 0;
    const status = document.getElementById('mat-add-status').value;
    const url = document.getElementById('mat-add-url').value.trim();
    const notes = document.getElementById('mat-add-notes').value.trim();

    if (!name) {
        alert('Lütfen malzeme veya parça adı girin.');
        return;
    }

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/project/materials`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name,
                    quantity: qty,
                    unit_price: price,
                    status: status,
                    url: url,
                    notes: notes
                })
            });
            if (res.ok) {
                closeModal('modal-add-material');
                await renderProjectPage(activePageId);
                return;
            }
        }
    } catch (e) {
        alert('Hata: ' + e.message);
    }
}

async function toggleMaterialStatus(materialId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/materials/${materialId}/toggle`, { method: 'POST' });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("toggleMaterialStatus error:", e);
    }
}

async function deleteMaterial(materialId) {
    if (!confirm('Bu malzemeyi silmek istediğinize emin misiniz?')) return;
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/materials/${materialId}`, { method: 'DELETE' });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("deleteMaterial error:", e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Özet Dashboard Görünümü
// ─────────────────────────────────────────────────────────────────────────────
async function renderOverview() {
    const pages = await window.appStorage.getAll('pages');
    const activePages = pages.filter(p => !p._deleted);
    const items = await window.appStorage.getAll('items');
    const activeItems = items.filter(i => !i._deleted);
    const pendingItems = activeItems.filter(i => !i.is_done);
    const vault = await window.appStorage.getAll('vault');

    // KPI
    const elPages = document.getElementById('kpi-pages-count');
    const elTasks = document.getElementById('kpi-tasks-count');
    const elVault = document.getElementById('kpi-vault-count');

    if (elPages) elPages.innerText = activePages.length;
    if (elTasks) elTasks.innerText = pendingItems.length;
    if (elVault) elVault.innerText = vault.length;

    // Bekleyen Görevler
    const taskListEl = document.getElementById('overview-tasks-list');
    if (taskListEl) {
        if (pendingItems.length === 0) {
            taskListEl.innerHTML = `<div class="empty-hint">Bekleyen yapılacak görev yok ✨</div>`;
        } else {
            const pageMap = {};
            activePages.forEach(p => { pageMap[p.id] = p; });

            taskListEl.innerHTML = pendingItems.slice(0, 10).map(it => {
                const targetPage = pageMap[it.page_id];
                const pageTitle = targetPage ? targetPage.title : '';
                const clickAction = it.page_id ? `openPage(${it.page_id})` : `openQuickTasksView()`;
                const safeTitle = JSON.stringify(it.title || '').replace(/"/g, '&quot;');

                return `
                <div class="overview-item" style="cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; margin-bottom:6px; border-radius:10px; border:1px solid var(--border); background:var(--surface);" onclick="openEditItemModal(${it.id}, ${safeTitle}, false)" title="Görevi düzenlemek için dokunun">
                     <div style="display:flex; align-items:center; gap:10px; overflow:hidden; flex:1; min-width:0;">
                         <div class="checkbox-custom ${it.is_done ? 'checked' : ''}" onclick="event.stopPropagation(); toggleOverviewItemDone(${it.id})" title="${it.is_done ? 'Tamamlanmadı yap' : 'Tamamla'}">
                             ${it.is_done ? '✓' : ''}
                         </div>
                         <div style="overflow:hidden; display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;">
                             <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:0.92rem; color:var(--text); ${it.is_done ? 'text-decoration:line-through; opacity:0.6;' : ''}">
                                 ${escapeHtml(it.title)}
                             </span>
                             <div style="display:flex; align-items:center; gap:8px; font-size:0.75rem; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                 ${pageTitle ? `<span style="color:var(--primary); font-weight:600; cursor:pointer;" onclick="event.stopPropagation(); ${clickAction}" title="${escapeHtml(pageTitle)} listesine git">📁 ${escapeHtml(pageTitle)}</span>` : ''}
                                 ${it.remind_at ? `<span style="color:#7c3aed; font-weight:600;">⏰ ${escapeHtml(it.remind_at.substring(5, 16))}</span>` : ''}
                                 ${it.price ? `<span style="color:#059669; font-weight:600;">💰 ${escapeHtml(it.price)}</span>` : ''}
                                 ${it.quantity ? `<span>📦 ${escapeHtml(it.quantity)}</span>` : ''}
                             </div>
                         </div>
                     </div>
                     <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                         <span style="color:var(--muted); font-size:0.85rem; cursor:pointer; padding:4px 6px;" onclick="event.stopPropagation(); ${clickAction}" title="${pageTitle ? escapeHtml(pageTitle) + ' listesine git' : 'Listeye git'}">➔</span>
                     </div>
                 </div>
            `;}).join('');
        }
    }

    // Son Değiştirilen Sayfalar
    const recentListEl = document.getElementById('overview-recent-list');
    if (recentListEl) {
        if (activePages.length === 0) {
            recentListEl.innerHTML = `<div class="empty-hint">Henüz eklenmiş sayfa yok</div>`;
        } else {
            recentListEl.innerHTML = activePages.slice(0, 5).map(p => `
                <div class="overview-item" onclick="openPage(${p.id})">
                    <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
                        <span>${p.icon || '📝'}</span>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;">${escapeHtml(p.title)}</span>
                    </div>
                    <span style="font-size:0.72rem; color:var(--muted);">${p.type === 'checklist' ? 'Liste' : 'Not'}</span>
                </div>
            `).join('');
        }
    }

    syncWidgetData();
}

async function toggleOverviewItemDone(itemId) {
    const it = await window.appStorage.get('items', itemId);
    if (it) {
        it.is_done = it.is_done ? 0 : 1;
        it._dirty = true;
        await window.appStorage.put('items', it);
        await renderOverview();
        window.appSync.syncNow();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Şifre Kasası Görünümü
// ─────────────────────────────────────────────────────────────────────────────
function filterVaultScope(scope) {
    activeVaultScope = scope;
    document.querySelectorAll('.scope-pill').forEach(el => el.classList.remove('active'));
    event.target.classList.add('active');
    renderVaultGrid();
}

async function renderVaultGrid() {
    const grid = document.getElementById('vault-entries-grid');
    if (!grid) return;

    let entries = await window.appStorage.getAll('vault');
    entries = entries.filter(e => !e._deleted);

    if (activeVaultScope !== 'all') {
        entries = entries.filter(e => e.scope === activeVaultScope);
    }

    if (entries.length === 0) {
        grid.innerHTML = `<div class="empty-hint">Kayıtlı şifre bulunmuyor ✨</div>`;
        return;
    }

    grid.innerHTML = entries.map(e => `
        <div class="vault-card">
            <div class="vault-card-header">
                <div class="vault-card-title">
                    <span>${e.icon || '🔐'}</span>
                    <span>${escapeHtml(e.title)}</span>
                </div>
                <span class="meta-badge" style="background:var(--surface2); color:var(--muted);">${e.scope || 'Kişisel'}</span>
            </div>

            <div class="vault-field-row">
                <span style="color:var(--muted); font-size:0.8rem;">Kullanıcı:</span>
                <div style="display:flex; align-items:center; gap:6px;">
                    <span class="vault-field-val">${escapeHtml(e.username || '-')}</span>
                    <button class="item-action-btn" onclick="copyToClipboard('${escapeHtml(e.username || '')}')" title="Kopyala">📋</button>
                </div>
            </div>

            <div class="vault-field-row">
                <span style="color:var(--muted); font-size:0.8rem;">Şifre:</span>
                <div style="display:flex; align-items:center; gap:6px;">
                    <span class="vault-field-val" id="vault-pwd-${e.id}">••••••••</span>
                    <button class="item-action-btn" onclick="togglePasswordVisibility(${e.id}, '${escapeHtml(e.password || '')}')" title="Göster">👁️</button>
                    <button class="item-action-btn" onclick="copyToClipboard('${escapeHtml(e.password || '')}')" title="Kopyala">📋</button>
                </div>
            </div>
        </div>
    `).join('');
}

function togglePasswordVisibility(id, clearPwd) {
    const el = document.getElementById(`vault-pwd-${id}`);
    if (!el) return;
    if (el.innerText === '••••••••') {
        el.innerText = clearPwd;
    } else {
        el.innerText = '••••••••';
    }
}

function copyToClipboard(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        alert('Panoya kopyalandı! 📋');
    }).catch(() => {
        alert('Kopyalanamadı.');
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Çöp Kutusu Görünümü
// ─────────────────────────────────────────────────────────────────────────────
async function renderTrashList() {
    const list = document.getElementById('trash-items-list');
    if (!list) return;

    const allPages = await window.appStorage.getAll('pages');
    const deletedPages = allPages.filter(p => p._deleted);

    const allItems = await window.appStorage.getAll('items');
    const deletedItems = allItems.filter(i => i._deleted);

    if (deletedPages.length === 0 && deletedItems.length === 0) {
        list.innerHTML = `<div class="empty-hint">Çöp kutusu boş ✨</div>`;
        return;
    }

    let html = '';
    deletedPages.forEach(p => {
        html += `
            <div class="overview-item">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span>📄</span>
                    <span>${escapeHtml(p.title)} (Sayfa)</span>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="restorePage(${p.id})">Geri Yükle</button>
            </div>
        `;
    });

    deletedItems.forEach(i => {
        html += `
            <div class="overview-item">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span>☑️</span>
                    <span>${escapeHtml(i.title)} (Madde)</span>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="restoreItem(${i.id})">Geri Yükle</button>
            </div>
        `;
    });

    list.innerHTML = html;
}

async function restorePage(pageId) {
    const page = await window.appStorage.getPage(pageId);
    if (page) {
        page._deleted = false;
        page._dirty = true;
        await window.appStorage.savePage(page);
        await renderTrashList();
        await reloadDrawerNavigation();
        window.appSync.syncNow();
    }
}

async function restoreItem(itemId) {
    const item = await window.appStorage.get('items', itemId);
    if (item) {
        item._deleted = false;
        item._dirty = true;
        await window.appStorage.saveItem(item);
        await renderTrashList();
        window.appSync.syncNow();
    }
}

async function confirmEmptyTrash() {
    if (confirm('Çöp kutusundaki tüm silinmiş öğeleri kalıcı olarak temizlemek istediğinize emin misiniz?')) {
        const allPages = await window.appStorage.getAll('pages');
        for (const p of allPages.filter(p => p._deleted)) {
            await window.appStorage.delete('pages', p.id);
        }
        const allItems = await window.appStorage.getAll('items');
        for (const i of allItems.filter(i => i._deleted)) {
            await window.appStorage.delete('items', i.id);
        }
        await renderTrashList();
        alert('Çöp kutusu boşaltıldı.');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Ayarlar
// ─────────────────────────────────────────────────────────────────────────────
async function loadSettingsUI() {
    const url = await window.appSync.getServerUrl();
    const input = document.getElementById('cfg-server-url');
    if (input) input.value = url;

    // Sürüm etiketi
    const verLabel = document.getElementById('app-version-label');
    if (verLabel && window.appUpdater) {
        verLabel.innerText = `v${window.appUpdater.currentVersion}`;
    }

    // Depolama istatistikleri
    const statsEl = document.getElementById('storage-stats-label');
    if (statsEl) {
        const p = await window.appStorage.getAll('pages');
        const it = await window.appStorage.getAll('items');
        const v = await window.appStorage.getAll('vault');
        statsEl.innerText = `${p.length} Sayfa, ${it.length} Madde, ${v.length} Şifre (Yerel IndexedDB)`;
    }

    // Kullanıcı Oturum Bilgisi
    await refreshMobileAuthUI();
}

function quickFillHostIP() {
    const input = document.getElementById('cfg-server-url');
    if (input) input.value = 'http://192.168.1.10:9013';
}

async function saveSettingsFromUI(showAlert = true) {
    const input = document.getElementById('cfg-server-url');
    if (input) {
        let val = input.value.trim();
        if (val) {
            if (!val.startsWith('http://') && !val.startsWith('https://')) {
                val = 'http://' + val;
            }
            while (val.endsWith('/')) val = val.slice(0, -1);
            if (val.endsWith('/notes')) val = val.slice(0, -6);
            while (val.endsWith('/')) val = val.slice(0, -1);
        } else {
            val = 'http://192.168.1.10:9013';
        }
        input.value = val;
        await window.appStorage.setSetting('server_url', val);
        if (showAlert) {
            alert('Ayarlar kaydedildi! ✅');
        }
        window.appSync.syncNow();
    }
}

async function testConnectionFromUI() {
    const btn = document.getElementById('btn-test-conn');
    const diag = document.getElementById('connection-diag-box');
    if (btn) btn.innerText = 'Test ediliyor...';

    await saveSettingsFromUI(false);
    const targetUrl = await window.appSync.getServerUrl();
    const ok = await window.appSync.checkConnection();

    if (btn) btn.innerText = '🔌 Test Et';
    if (diag) {
        diag.style.display = 'block';
        if (ok) {
            diag.innerHTML = `🟢 <strong>Bağlantı Başarılı!</strong><br><span style="font-size:0.75rem; color:var(--text); opacity:0.85;">${escapeHtml(targetUrl)} adresine erişildi. Senkronizasyon devrede.</span>`;
            diag.style.color = 'var(--success)';
        } else {
            diag.innerHTML = `🔴 <strong>Bağlantı Kurulamadı!</strong><br><span style="font-size:0.75rem; color:var(--text); opacity:0.85;">Hedef: ${escapeHtml(targetUrl)}<br>Telefonunuzun aynı Wi-Fi ağında veya VPN'de olduğunu kontrol edin.</span>`;
            diag.style.color = 'var(--danger)';
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal İşlemleri (Defter, Kategori, Sayfa Ekleme)
// ─────────────────────────────────────────────────────────────────────────────
function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
}

function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
}

function openAddNotebookModal() {
    closeNotebookDropdown();
    openModal('modal-add-notebook');
}

async function submitCreateNotebook() {
    const nameInput = document.getElementById('new-nb-name');
    const iconInput = document.getElementById('new-nb-icon');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        alert('Lütfen defter adı yazın.');
        return;
    }

    const newNb = {
        id: Date.now(),
        name: name,
        icon: (iconInput ? iconInput.value.trim() : '') || '📓',
        sort_order: 99
    };

    await window.appStorage.saveNotebook(newNb);
    activeNotebookId = newNb.id;
    await window.appStorage.setActiveNotebookId(newNb.id);

    closeModal('modal-add-notebook');
    if (nameInput) nameInput.value = '';

    await reloadDrawerNavigation();
    await openOverviewView();
    window.appSync.syncNow();
}

function setCatColorPicker(inputId, previewId, color) {
    const el = document.getElementById(inputId);
    if (el) el.value = color;
    updateCatColorPreview(inputId, previewId);
}

function updateCatColorPreview(inputId, previewId) {
    const el = document.getElementById(inputId);
    const prev = document.getElementById(previewId);
    if (el && prev) {
        const c = el.value || '#3b82f6';
        prev.style.background = c + '18';
        prev.style.color = c;
        prev.style.borderColor = c + '35';
    }
}

async function addCategoryDividerMobile() {
    const label = prompt("Ayraç etiketi (isteğe bağlı, sadece çizgi için boş bırakın):", "");
    if (label === null) return;
    const name = label.trim() || '---';
    const newCat = {
        id: Date.now(),
        notebook_id: activeNotebookId,
        name: name,
        icon: '―',
        color: '#94a3b8',
        is_divider: 1,
        sort_order: 99
    };
    await window.appStorage.saveCategory(newCat);
    await reloadDrawerNavigation();
    window.appSync.syncNow();
    showMobileToast('Ayraç eklendi');
}

async function deleteCategoryDividerMobile(catId) {
    await window.appStorage.deleteCategory(catId);
    await reloadDrawerNavigation();
    window.appSync.syncNow();
    showMobileToast('Ayraç silindi');
}

function openAddCategoryModal() {
    const nameInput = document.getElementById('new-cat-name');
    const iconInput = document.getElementById('new-cat-icon');
    const iconPreview = document.getElementById('new-cat-icon-preview');
    const colorInput = document.getElementById('new-cat-color');
    if (nameInput) nameInput.value = '';
    if (iconInput) iconInput.value = '📁';
    if (iconPreview) iconPreview.innerText = '📁';
    if (colorInput) colorInput.value = '#3b82f6';
    updateCatColorPreview('new-cat-color', 'new-cat-color-preview');
    openModal('modal-add-category');
}

async function submitCreateCategory() {
    const nameInput = document.getElementById('new-cat-name');
    const iconInput = document.getElementById('new-cat-icon');
    const colorInput = document.getElementById('new-cat-color');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        alert('Lütfen dosya adı yazın.');
        return;
    }

    const newCat = {
        id: Date.now(),
        notebook_id: activeNotebookId,
        name: name,
        icon: (iconInput ? iconInput.value.trim() : '') || '📁',
        color: (colorInput ? colorInput.value : '') || '#3b82f6',
        sort_order: 99
    };

    await window.appStorage.saveCategory(newCat);
    openCategoryIds.add(newCat.id);

    closeModal('modal-add-category');
    if (nameInput) nameInput.value = '';

    await reloadDrawerNavigation();
    window.appSync.syncNow();
}

async function openEditCategoryModal(catId) {
    const cat = await window.appStorage.get('categories', catId);
    if (!cat) return;

    document.getElementById('edit-cat-id').value = cat.id;
    document.getElementById('edit-cat-name').value = cat.name || '';
    document.getElementById('edit-cat-icon').value = cat.icon || '📁';
    document.getElementById('edit-cat-color').value = cat.color || '#3b82f6';
    const preview = document.getElementById('edit-cat-icon-preview');
    if (preview) preview.innerText = cat.icon || '📁';
    updateCatColorPreview('edit-cat-color', 'edit-cat-color-preview');

    openModal('modal-edit-category');
}

async function submitEditCategory() {
    const catId = parseInt(document.getElementById('edit-cat-id').value, 10);
    const name = document.getElementById('edit-cat-name').value.trim();
    const icon = document.getElementById('edit-cat-icon').value.trim() || '📁';
    const color = document.getElementById('edit-cat-color').value || '#3b82f6';

    if (!name || !catId) {
        alert('Lütfen dosya adı yazın.');
        return;
    }

    const cat = await window.appStorage.get('categories', catId);
    if (!cat) return;

    cat.name = name;
    cat.icon = icon;
    cat.color = color;

    await window.appStorage.saveCategory(cat);
    closeModal('modal-edit-category');

    await reloadDrawerNavigation();
    if (activePageObj && activePageObj.category_id === catId) {
        await renderActivePage();
    }
    window.appSync.syncNow();
    showMobileToast('Dosya güncellendi');
}

async function submitDeleteCategoryFromModal() {
    const catId = parseInt(document.getElementById('edit-cat-id').value, 10);
    if (!catId) return;
    const cat = await window.appStorage.get('categories', catId);
    if (!cat) return;

    const pages = await window.appStorage.getPages(catId);
    if (pages.length > 0) {
        if (!confirm(`"${cat.name}" dosyası içinde ${pages.length} sayfa var. Dosyayı ve içindeki sayfaları silmek istediğinize emin misiniz?`)) return;
    } else {
        if (!confirm(`"${cat.name}" dosyasını silmek istediğinize emin misiniz?`)) return;
    }

    await window.appStorage.deleteCategory(catId);
    for (const p of pages) {
        await window.appStorage.deletePage(p.id);
    }
    closeModal('modal-edit-category');

    await reloadDrawerNavigation();
    if (activePageObj && activePageObj.category_id === catId) {
        await openOverviewView();
    }
    window.appSync.syncNow();
    showMobileToast('Dosya silindi');
}

function openAddPageModal(catId) {
    const catInput = document.getElementById('new-page-cat-id');
    if (catInput) catInput.value = catId || '';
    const titleInput = document.getElementById('new-page-title');
    if (titleInput) titleInput.value = '';
    selectNewPageType('checklist');
    openModal('modal-add-page');
}

const ACADEMIC_THESIS_TEMPLATE = `<h2>🎓 Tez &amp; Ödev Çalışma Masası</h2>
<p><b>Danışman / Öğretim Üyesi:</b> Prof. Dr. ...<br>
<b>Ders / Anabilim Dalı:</b> ...<br>
<b>Teslim Tarihi:</b> [Tarih Giriniz]<br>
<b>Aşama:</b> 🟡 Literatür Taraması &amp; Hipotez Belirleme</p>
<hr>
<h3>📋 Tez &amp; Ödev Yol Haritası (Kontrol Listesi)</h3>
<ul>
  <li>☐ Konu tespiti, problem tanımı ve danışman onayı</li>
  <li>☐ Literatür taraması (Yerli ve yabancı en az 15 makale incelemesi)</li>
  <li>☐ Araştırma soruları, amaç ve metodoloji belirleme</li>
  <li>☐ Veri toplama, anket, deney veya prototip kodlama</li>
  <li>☐ Giriş ve Kuramsal Çerçeve taslağının yazımı</li>
  <li>☐ Bulgular, İstatistiksel Analiz ve Tartışma yazımı</li>
  <li>☐ Sonuç, Değerlendirme ve Gelecek Çalışmalar</li>
  <li>☐ APA 7 / IEEE formatında kaynakça ve metin içi atıf kontrolü</li>
  <li>☐ Danışman inceleme revizyonları ve Turnitin intihal raporu (&lt;%15)</li>
  <li>☐ Ciltleme / PDF son teslimi ve jüri sunumu hazırlığı</li>
</ul>
<hr>
<h3>📚 Kaynakça &amp; İncelenen Makaleler</h3>
<ul>
  <li>📖 <b>Referans 1:</b> Yazar, A. (2025). <i>"Makale Başlığı"</i>, Bilim Dergisi. [Not: Metot için temel referans]</li>
  <li>📖 <b>Referans 2:</b> Smith, J. et al. (2024). <i>"Advanced Methodologies"</i>, IEEE Trans. [Not: İlgili çalışma]</li>
</ul>
<hr>
<h3>📝 Araştırma Notları, Alıntılar &amp; Karalamalar</h3>
<p>Laboratuvar notları, mülakat kayıtları, önemli formüller veya hocanın son geri bildirimlerini buraya yazabilirsiniz...</p>`;

function selectNewPageType(type) {
    newPageType = type;
    const btnCheck = document.getElementById('btn-type-checklist');
    const btnNotes = document.getElementById('btn-type-notes');
    const btnAcad = document.getElementById('btn-type-academic');
    const btnSoft = document.getElementById('btn-type-software');
    const btnFin = document.getElementById('btn-type-finance');
    const btnProj = document.getElementById('btn-type-project');

    if (btnCheck) btnCheck.classList.toggle('active', type === 'checklist');
    if (btnNotes) btnNotes.classList.toggle('active', type === 'notes');
    if (btnAcad) btnAcad.classList.toggle('active', type === 'academic');
    if (btnSoft) btnSoft.classList.toggle('active', type === 'software');
    if (btnFin) btnFin.classList.toggle('active', type === 'finance');
    if (btnProj) btnProj.classList.toggle('active', type === 'project');

    const typeIcons = {
        checklist: '🛒',
        notes: '📝',
        academic: '🎓',
        software: '💻',
        finance: '💳',
        project: '🔬'
    };

    const iconInput = document.getElementById('new-page-icon');
    const preview = document.getElementById('new-page-icon-preview');
    if (iconInput && typeIcons[type]) {
        iconInput.value = typeIcons[type];
        if (preview) preview.innerText = typeIcons[type];
    }
}

async function submitCreatePage() {
    const titleInput = document.getElementById('new-page-title');
    const catInput = document.getElementById('new-page-cat-id');
    const iconInput = document.getElementById('new-page-icon');
    const title = titleInput ? titleInput.value.trim() : '';

    if (!title) {
        alert('Lütfen sayfa başlığı yazın.');
        return;
    }

    let catId = catInput && catInput.value ? parseInt(catInput.value, 10) : null;
    if (!catId) {
        const cats = await window.appStorage.getCategories(activeNotebookId);
        const realCats = cats.filter(c => !c.is_divider && c.icon !== '―' && c.name !== '---' && !(c.name && c.name.startsWith('---')));
        if (realCats.length > 0) catId = realCats[0].id;
        else {
            const defaultCat = await window.appStorage.saveCategory({
                id: Date.now(),
                notebook_id: activeNotebookId,
                name: 'Hızlı Notlar',
                icon: '⚡'
            });
            catId = defaultCat.id;
        }
    }

    const typeIcons = {
        checklist: '🛒',
        notes: '📝',
        academic: '🎓',
        software: '💻',
        finance: '💳',
        project: '🔬'
    };

    let finalType = newPageType;
    let initialContent = '';
    let chosenIcon = (iconInput ? iconInput.value.trim() : '') || typeIcons[newPageType] || '📝';

    if (newPageType === 'academic') {
        finalType = 'notes';
        initialContent = ACADEMIC_THESIS_TEMPLATE;
        if (!chosenIcon || chosenIcon === '📝') chosenIcon = '🎓';
    }

    const newPage = {
        id: Date.now(),
        category_id: catId,
        title: title,
        type: finalType,
        icon: chosenIcon,
        content: initialContent,
        sort_order: 99
    };

    await window.appStorage.savePage(newPage);
    openCategoryIds.add(catId);

    closeModal('modal-add-page');
    if (titleInput) titleInput.value = '';

    await reloadDrawerNavigation();
    await openPage(newPage.id);
    window.appSync.syncNow();
}

function openPageOptionsModal() {
    openEditCurrentPageModal();
}

async function openEditCurrentPageModal() {
    if (!activePageId) return;
    await openEditPageModal(activePageId);
}

async function openEditPageModal(pageId) {
    const page = await window.appStorage.getPage(pageId);
    if (!page) return;

    document.getElementById('edit-page-id').value = page.id;
    document.getElementById('edit-page-title').value = page.title || '';
    document.getElementById('edit-page-icon').value = page.icon || '📝';
    const preview = document.getElementById('edit-page-icon-preview');
    if (preview) preview.innerText = page.icon || '📝';

    const catSelect = document.getElementById('edit-page-cat-select');
    if (catSelect) {
        const cats = await window.appStorage.getCategories(activeNotebookId);
        const realCats = cats.filter(c => !c.is_divider && c.icon !== '―' && c.name !== '---' && !(c.name && c.name.startsWith('---')));
        catSelect.innerHTML = realCats.map(c => `
            <option value="${c.id}" ${c.id == page.category_id ? 'selected' : ''}>${c.icon || '📁'} ${escapeHtml(c.name)}</option>
        `).join('');
    }

    openModal('modal-edit-page');
}

async function submitEditPageModal() {
    const pageId = parseInt(document.getElementById('edit-page-id').value, 10);
    const title = document.getElementById('edit-page-title').value.trim();
    const icon = document.getElementById('edit-page-icon').value.trim() || '📝';
    const catSelect = document.getElementById('edit-page-cat-select');
    const catId = catSelect ? parseInt(catSelect.value, 10) : null;

    if (!title || !pageId) {
        alert('Lütfen başlık yazın.');
        return;
    }

    const page = await window.appStorage.getPage(pageId);
    if (!page) return;

    page.title = title;
    page.icon = icon;
    if (catId) page.category_id = catId;

    await window.appStorage.savePage(page);
    closeModal('modal-edit-page');

    await reloadDrawerNavigation();
    if (activePageId === pageId) {
        await renderActivePage();
    }
    window.appSync.syncNow();
    showMobileToast('Sayfa güncellendi');
}

async function submitDeletePageFromModal() {
    const pageId = parseInt(document.getElementById('edit-page-id').value, 10);
    if (!pageId) return;
    const page = await window.appStorage.getPage(pageId);
    if (!page) return;

    if (!confirm(`"${page.title}" sayfasını silmek istediğinize emin misiniz?`)) return;

    await window.appStorage.deletePage(pageId);
    closeModal('modal-edit-page');

    await reloadDrawerNavigation();
    await openOverviewView();
    window.appSync.syncNow();
    showMobileToast('Sayfa silindi');
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable İkon / Emoji Seçici
// ─────────────────────────────────────────────────────────────────────────────
let currentIconTargetInputId = null;
let currentIconPreviewElId = null;

const ICON_PICKER_SETS = {
    genel: ['📁', '📂', '⭐', '📌', '🔖', '🏷️', '🎯', '✨', '🔥', '⚡', '💎', '🌟', '💼', '🗂️', '🔔', '📢', '🎁', '🏆'],
    soft: ['💻', '🖥️', '🚀', '⚙️', '🔧', '🛠️', '📦', '🤖', '🌐', '🔒', '🔀', '🗄️', '📱', '🐛', '⚡', '💾', '🔌', '📡', '🕹️', '🛡️', '🧪', '🔑', '🧬'],
    notes: ['📝', '📋', '📓', '📖', '💡', '🧠', '🗓️', '⏰', '📊', '📈', '✅', '📜', '📑', '🖋️', '🔍', '📚', '🎯', '🧾', '✏️', '📌'],
    life: ['🏠', '🛒', '💰', '💳', '🍔', '☕', '🚗', '🏥', '✈️', '🎨', '🎵', '🏃', '🍕', '🍳', '💊', '🏖️', '🚲', '⚽', '🌿', '🌱']
};

function openIconPicker(targetInputId, previewElId) {
    currentIconTargetInputId = targetInputId;
    currentIconPreviewElId = previewElId;
    filterIconPicker('all');
    openModal('modal-icon-picker');
}

function filterIconPicker(category) {
    ['all', 'genel', 'soft', 'notes', 'life'].forEach(c => {
        const btn = document.getElementById(`ipick-tab-${c}`);
        if (btn) btn.classList.toggle('active', c === category);
    });

    const grid = document.getElementById('icon-picker-grid');
    if (!grid) return;

    let emojis = [];
    if (category === 'all') {
        emojis = Array.from(new Set([
            ...ICON_PICKER_SETS.genel,
            ...ICON_PICKER_SETS.soft,
            ...ICON_PICKER_SETS.notes,
            ...ICON_PICKER_SETS.life
        ]));
    } else {
        emojis = ICON_PICKER_SETS[category] || [];
    }

    grid.innerHTML = emojis.map(em => `
        <button type="button" class="btn btn-ghost" style="font-size:1.6rem; padding:6px; border-radius:8px; display:flex; align-items:center; justify-content:center; border:1px solid var(--border);" onclick="selectIconFromPicker('${em}')">
            ${em}
        </button>
    `).join('');
}

function selectIconFromPicker(emoji) {
    if (currentIconTargetInputId) {
        const inp = document.getElementById(currentIconTargetInputId);
        if (inp) inp.value = emoji;
    }
    if (currentIconPreviewElId) {
        const prev = document.getElementById(currentIconPreviewElId);
        if (prev) prev.innerText = emoji;
    }
    closeModal('modal-icon-picker');
}

function applyCustomPickerIcon() {
    const customInp = document.getElementById('icon-picker-custom-input');
    const val = customInp ? customInp.value.trim() : '';
    if (val) {
        selectIconFromPicker(val);
        customInp.value = '';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kasa Modal İşlemleri
// ─────────────────────────────────────────────────────────────────────────────
function openVaultEditor(id) {
    document.getElementById('vault-edit-id').value = id || '';
    document.getElementById('vault-edit-title').value = '';
    document.getElementById('vault-edit-username').value = '';
    document.getElementById('vault-edit-password').value = '';
    document.getElementById('vault-edit-folder').value = '';
    document.getElementById('vault-modal-title').innerText = id ? '🔐 Şifreyi Düzenle' : '🔐 Yeni Şifre Kaydı';
    openModal('modal-vault-editor');
}

async function submitSaveVault() {
    const id = document.getElementById('vault-edit-id').value;
    const title = document.getElementById('vault-edit-title').value.trim();
    const username = document.getElementById('vault-edit-username').value.trim();
    const password = document.getElementById('vault-edit-password').value.trim();
    const scope = document.getElementById('vault-edit-scope').value;
    const folder = document.getElementById('vault-edit-folder').value.trim();

    if (!title) {
        alert('Lütfen başlık girin.');
        return;
    }

    const entry = {
        id: id ? parseInt(id, 10) : Date.now(),
        title: title,
        username: username,
        password: password,
        scope: scope,
        folder_name: folder,
        icon: '🔐'
    };

    await window.appStorage.saveVaultEntry(entry);
    closeModal('modal-vault-editor');
    await renderVaultGrid();
    window.appSync.syncNow();
}

// ─────────────────────────────────────────────────────────────────────────────
// Arama Modal
// ─────────────────────────────────────────────────────────────────────────────
function openSearchModal() {
    openModal('modal-search');
    const input = document.getElementById('global-search-input');
    if (input) {
        input.value = '';
        input.focus();
    }
    document.getElementById('global-search-results').innerHTML = '';
}

async function handleGlobalSearch(q) {
    const results = document.getElementById('global-search-results');
    if (!results) return;
    q = (q || '').trim().toLowerCase();
    if (!q) {
        results.innerHTML = '';
        return;
    }

    const pages = await window.appStorage.getAll('pages');
    const items = await window.appStorage.getAll('items');
    const vault = await window.appStorage.getAll('vault');

    const matchedPages = pages.filter(p => {
        if (p._deleted) return false;
        const titleMatch = (p.title || '').toLowerCase().includes(q);
        const contentMatch = (p.content || '').toLowerCase().includes(q);
        return titleMatch || contentMatch;
    });
    const matchedItems = items.filter(i => !i._deleted && (i.title || '').toLowerCase().includes(q));
    const matchedVault = vault.filter(v => !v._deleted && ((v.title || '').toLowerCase().includes(q) || (v.username || '').toLowerCase().includes(q)));

    let html = '';
    matchedPages.forEach(p => {
        const titleMatch = (p.title || '').toLowerCase().includes(q);
        let snippet = '';
        if (!titleMatch && p.content) {
            const clean = p.content.replace(/<[^>]*>/g, ' ');
            const idx = clean.toLowerCase().indexOf(q);
            if (idx !== -1) {
                const start = Math.max(0, idx - 18);
                const end = Math.min(clean.length, idx + q.length + 28);
                snippet = `<div style="font-size:0.75rem; color:var(--muted); margin-top:2px;">...${escapeHtml(clean.substring(start, end))}...</div>`;
            }
        }
        html += `
            <div class="overview-item" onclick="closeModal('modal-search'); openPage(${p.id})">
                <div style="text-align:left;">
                    <span style="font-weight:600;">${p.icon || '📝'} ${escapeHtml(p.title)} (Sayfa)</span>
                    ${snippet}
                </div>
                <span>➔</span>
            </div>
        `;
    });

    matchedItems.forEach(i => {
        html += `
            <div class="overview-item" onclick="closeModal('modal-search'); openPage(${i.page_id})">
                <span>☑️ ${escapeHtml(i.title)} (Madde)</span>
                <span>➔</span>
            </div>
        `;
    });

    matchedVault.forEach(v => {
        html += `
            <div class="overview-item" onclick="closeModal('modal-search'); openVaultView()">
                <span>🔐 ${escapeHtml(v.title)} (Kasa)</span>
                <span>➔</span>
            </div>
        `;
    });

    results.innerHTML = html || `<div class="empty-hint">Eşleşen sonuç bulunamadı</div>`;
}

// Yardımcı Güvenlik
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── Mobil Çoklu Kullanıcı & Oturum ──
let currentMobileAuthTab = 'login';

function switchMobileAuthTab(tab) {
    currentMobileAuthTab = tab;
    const btnLogin = document.getElementById('btn-m-tab-login');
    const btnReg = document.getElementById('btn-m-tab-reg');
    const regGroup = document.getElementById('mobile-reg-group');
    const submitBtn = document.getElementById('btn-m-auth-submit');
    const msg = document.getElementById('m-auth-msg');
    if (msg) msg.style.display = 'none';

    if (tab === 'login') {
        if (btnLogin) { btnLogin.classList.add('btn-primary'); btnLogin.classList.remove('btn-secondary'); }
        if (btnReg) { btnReg.classList.add('btn-secondary'); btnReg.classList.remove('btn-primary'); }
        if (regGroup) regGroup.style.display = 'none';
        if (submitBtn) submitBtn.innerText = '🔑 Giriş Yap';
    } else {
        if (btnLogin) { btnLogin.classList.add('btn-secondary'); btnLogin.classList.remove('btn-primary'); }
        if (btnReg) { btnReg.classList.add('btn-primary'); btnReg.classList.remove('btn-secondary'); }
        if (regGroup) regGroup.style.display = 'block';
        if (submitBtn) submitBtn.innerText = '✨ Hesap Oluştur';
    }
}

async function refreshMobileAuthUI() {
    const token = await window.appStorage.getSetting('auth_token', '');
    const userJson = await window.appStorage.getSetting('user_profile', '');
    const loggedInBox = document.getElementById('mobile-auth-logged-in');
    const formBox = document.getElementById('mobile-auth-form');

    if (token && userJson) {
        try {
            const user = JSON.parse(userJson);
            const nameEl = document.getElementById('mobile-user-name');
            const roleEl = document.getElementById('mobile-user-role');
            const tincIdEl = document.getElementById('mobile-tinc-id-badge');
            const verifyBox = document.getElementById('mobile-email-verify-box');

            if (nameEl) nameEl.innerText = user.display_name || user.username;
            if (roleEl) roleEl.innerText = `@${user.username} (${user.role || 'Kullanıcı'})`;
            if (tincIdEl) tincIdEl.innerText = user.tinc_id || 'TINC-DEFAULT';
            if (verifyBox) {
                verifyBox.style.display = (user.is_email_verified === 0 || user.is_email_verified === false) ? 'flex' : 'none';
            }

            if (loggedInBox) loggedInBox.style.display = 'block';
            if (formBox) formBox.style.display = 'none';
            return;
        } catch (e) {}
    }

    if (loggedInBox) loggedInBox.style.display = 'none';
    if (formBox) formBox.style.display = 'block';
}

function copyMobileTincID() {
    const badge = document.getElementById('mobile-tinc-id-badge');
    const id = badge ? badge.innerText.trim() : '';
    if (id) {
        navigator.clipboard.writeText(id).then(() => {
            showMobileToast(`TincID panoya kopyalandı: ${id}`);
        });
    }
}

async function downloadMobileDataTakeout() {
    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');
    const url = `${sUrl}/notes/api/auth/profile/export`;
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        window.open(url, '_system');
    } else {
        window.open(url, '_blank');
    }
    showMobileToast('Veri paketi (.ZIP) indiriliyor...');
}

async function revokeMobileOtherSessions() {
    if (!confirm('Bu cihaz hariç diğer tüm açık oturumları sonlandırmak istediğinize emin misiniz?')) return;
    try {
        const res = await window.appSync.apiFetch('/notes/api/auth/sessions/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all_other: true })
        });
        showMobileToast('Diğer tüm cihaz oturumları başarıyla kapatıldı! ✓');
    } catch (e) {
        showMobileToast('İşlem başarısız: ' + e.message);
    }
}

async function confirmMobileDeactivateAccount() {
    if (!confirm('Hesabınızı dondurmak (pasife almak) istediğinize emin misiniz? Giriş yaparak dilediğiniz zaman tekrar etkinleştirebilirsiniz.')) return;
    try {
        await window.appSync.apiFetch('/notes/api/auth/profile/deactivate', { method: 'POST' });
        await window.appSync.logout();
        await refreshMobileAuthUI();
        showMobileToast('Hesabınız donduruldu. Oturum kapatıldı.');
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

async function confirmMobileDeleteAccount() {
    const check = prompt('DİKKAT: Hesabınız ve tüm notlarınız, defterleriniz, dosyalarınız kalıcı olarak silinecektir!\nOnaylamak için büyük harflerle "SİL" yazın:');
    if (check !== 'SİL') {
        alert('İşlem iptal edildi.');
        return;
    }
    try {
        await window.appSync.apiFetch('/notes/api/auth/profile/delete', { method: 'POST' });
        await window.appSync.logout();
        await refreshMobileAuthUI();
        alert('Hesabınız ve tüm verileriniz kalıcı olarak silindi.');
        window.location.reload();
    } catch (e) {
        alert('Hata: ' + e.message);
    }
}

async function handleMobileGoogleSignIn() {
    // Google Sign-In: web popup veya prompt
    const email = prompt('Google Hesabı E-postanız:');
    if (!email) return;
    const name = email.split('@')[0];
    const sub = 'g_' + Math.abs(hashCode(email));
    const res = await window.appSync.loginWithOAuth('google', { email, name, sub });
    if (res.ok) {
        showMobileToast('Google ile giriş başarılı! ✓');
        await refreshMobileAuthUI();
        window.appSync.syncNow();
    } else {
        alert(res.error || 'Google girişi başarısız');
    }
}

async function handleMobileAppleSignIn() {
    const email = prompt('Apple Kimliği E-postanız:');
    if (!email) return;
    const name = email.split('@')[0];
    const sub = 'apple_' + Math.abs(hashCode(email));
    const res = await window.appSync.loginWithOAuth('apple', { email, name, user: sub });
    if (res.ok) {
        showMobileToast('Apple ile giriş başarılı! ✓');
        await refreshMobileAuthUI();
        window.appSync.syncNow();
    } else {
        alert(res.error || 'Apple girişi başarısız');
    }
}

async function triggerMobileTincSync() {
    const lbl = document.getElementById('tincsync-status-label');
    if (lbl) lbl.innerText = 'Eşitleniyor...';
    try {
        const res = await window.appSync.apiFetch('/notes/api/sync/tincsync/trigger', { method: 'POST' });
        const data = await res.json();
        if (lbl) lbl.innerText = data.synced ? '🟢 P2P Eşitlendi' : '🟡 Yerel Ağda Beklemede';
        showMobileToast(data.message || (data.synced ? 'TincSync ile başarıyla eşitlendi!' : 'TincSync hazır.'));
    } catch (e) {
        if (lbl) lbl.innerText = 'P2P Bağlantısı Hazır';
        showMobileToast('TincSync port 9015 dinlemede');
    }
}

async function handleMobileAuthSubmit() {
    const uInput = document.getElementById('m-auth-user');
    const pInput = document.getElementById('m-auth-pass');
    const dInput = document.getElementById('m-auth-display');
    const emailInput = document.getElementById('m-auth-email');
    const msg = document.getElementById('m-auth-msg');

    const u = uInput ? uInput.value.trim() : '';
    const p = pInput ? pInput.value.trim() : '';
    const displayName = dInput ? dInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';

    if (!u || !p) {
        if (msg) {
            msg.innerText = 'Lütfen kullanıcı adı ve şifre girin';
            msg.style.color = 'var(--danger)';
            msg.style.display = 'block';
        }
        return;
    }

    if (msg) {
        msg.innerText = 'İşlem yapılıyor...';
        msg.style.color = 'var(--primary)';
        msg.style.display = 'block';
    }

    let res;
    if (currentMobileAuthTab === 'login') {
        res = await window.appSync.login(u, p);
    } else {
        res = await window.appSync.register(u, p, displayName, email);
    }

    if (res.ok) {
        if (msg) {
            msg.innerText = 'Başarılı! Oturum açıldı.';
            msg.style.color = 'var(--success)';
        }
        if (pInput) pInput.value = '';
        await refreshMobileAuthUI();
        window.appSync.syncNow();

        if (res.verification_required) {
            openModal('modal-mobile-email-verify');
            if (res.code_demo) {
                const inp = document.getElementById('m-verify-code-input');
                if (inp) inp.value = res.code_demo;
                showMobileToast(`Demo Kodu: ${res.code_demo}`);
            }
        }
    } else {
        if (msg) {
            msg.innerText = res.error || 'İşlem başarısız';
            msg.style.color = 'var(--danger)';
        }
    }
}

async function handleMobileLogout() {
    if (confirm('Oturumu kapatmak istediğinize emin misiniz?')) {
        await window.appSync.logout();
        await refreshMobileAuthUI();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⏰ Görev Alarmı & Hatırlatıcı Yöneticisi
// ─────────────────────────────────────────────────────────────────────────────
let activeReminderItemId = null;

async function openItemReminderModal(itemId) {
    if (!itemId) return;
    activeReminderItemId = itemId;

    const item = await window.appStorage.get('items', itemId);
    if (!item) return;

    const idEl = document.getElementById('rem-item-id');
    const pageEl = document.getElementById('rem-page-id');
    const titleEl = document.getElementById('rem-task-title-preview');
    if (idEl) idEl.value = item.id;
    if (pageEl) pageEl.value = item.page_id || 0;
    if (titleEl) titleEl.innerText = item.title || 'İsimsiz Görev';

    const dtInput = document.getElementById('rem-datetime-input');
    const recSelect = document.getElementById('rem-recurrence-select');
    const delBtn = document.getElementById('btn-delete-item-reminder');

    if (recSelect) recSelect.value = item.recurrence || 'none';

    if (item.remind_at) {
        if (dtInput) dtInput.value = item.remind_at.substring(0, 16).replace(' ', 'T');
        if (delBtn) delBtn.style.display = 'block';
    } else {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        const yyyy = tomorrow.getFullYear();
        const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
        const dd = String(tomorrow.getDate()).padStart(2, '0');
        if (dtInput) dtInput.value = `${yyyy}-${mm}-${dd}T09:00`;
        if (delBtn) delBtn.style.display = 'none';
    }

    openModal('modal-item-reminder');
}

function setQuickReminderPreset(preset) {
    const dtInput = document.getElementById('rem-datetime-input');
    if (!dtInput) return;
    const now = new Date();

    if (preset === '1hour') {
        now.setHours(now.getHours() + 1);
    } else if (preset === 'tonight') {
        now.setHours(20, 0, 0, 0);
        if (now <= new Date()) {
            now.setDate(now.getDate() + 1);
        }
    } else if (preset === 'tomorrow') {
        now.setDate(now.getDate() + 1);
        now.setHours(9, 0, 0, 0);
    } else if (preset === 'nextweek') {
        const day = now.getDay();
        const diff = (7 - day + 1) % 7 || 7;
        now.setDate(now.getDate() + diff);
        now.setHours(9, 0, 0, 0);
    }

    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    dtInput.value = `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

async function submitSaveItemReminder() {
    if (!activeReminderItemId) return;
    const dtInput = document.getElementById('rem-datetime-input');
    const recSelect = document.getElementById('rem-recurrence-select');
    if (!dtInput || !dtInput.value) {
        alert("Lütfen geçerli bir hatırlatma tarihi ve saati seçin.");
        return;
    }

    const rawVal = dtInput.value;
    const remindAtStr = rawVal.replace('T', ' ') + ':00';
    const recurrence = recSelect ? recSelect.value : 'none';

    const item = await window.appStorage.get('items', activeReminderItemId);
    if (!item) return;

    // 1. Yerel IndexedDB'ye kaydet
    await window.appStorage.setItemReminder(item.id, remindAtStr, recurrence);

    // 2. Android Yerel Alarm & Bildirim Kur (AlarmManager)
    if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.scheduleTaskAlarm) {
        try {
            window.AndroidWidgetBridge.scheduleTaskAlarm(item.id, item.title, remindAtStr, recurrence, item.page_id || 0);
        } catch (e) {
            console.warn("scheduleTaskAlarm error:", e);
        }
    }

    // 3. Sunucuya ilet
    if (window.appSync) {
        window.appSync.getServerUrl().then(sUrl => {
            if (sUrl) {
                window.appStorage.getSetting('auth_token', '').then(tok => {
                    fetch(`${sUrl}/notes/api/items/${item.id}/reminder`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': tok ? `Bearer ${tok}` : '',
                            'X-Auth-Token': tok || ''
                        },
                        body: JSON.stringify({ remind_at: remindAtStr, recurrence: recurrence })
                    }).catch(() => {});
                });
            }
        });
    }

    closeModal('modal-item-reminder');
    showMobileToast("⏰ Alarm ve hatırlatıcı başarıyla kuruldu!");

    if (activePageId) renderChecklistItems(activePageId);
    renderQuickNotesView();
    renderOverview();
    syncWidgetData();
}

async function submitDeleteItemReminder() {
    if (!activeReminderItemId) return;

    const item = await window.appStorage.get('items', activeReminderItemId);
    if (!item) return;

    // 1. Yerel depolamadan kaldır
    await window.appStorage.deleteItemReminder(item.id);

    // 2. Android Yerel Alarmını İptal Et
    if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.cancelTaskAlarm) {
        try {
            window.AndroidWidgetBridge.cancelTaskAlarm(item.id);
        } catch (e) {
            console.warn("cancelTaskAlarm error:", e);
        }
    }

    // 3. Sunucudan sil
    if (window.appSync) {
        window.appSync.getServerUrl().then(sUrl => {
            if (sUrl) {
                window.appStorage.getSetting('auth_token', '').then(tok => {
                    fetch(`${sUrl}/notes/api/items/${item.id}/reminder`, {
                        method: 'DELETE',
                        headers: {
                            'Authorization': tok ? `Bearer ${tok}` : '',
                            'X-Auth-Token': tok || ''
                        }
                    }).catch(() => {});
                });
            }
        });
    }

    closeModal('modal-item-reminder');
    showMobileToast("Hatırlatıcı kaldırıldı.");

    if (activePageId) renderChecklistItems(activePageId);
    renderQuickNotesView();
    renderOverview();
    syncWidgetData();
}

function showMobileToast(msg) {
    let t = document.getElementById('mobile-quick-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'mobile-quick-toast';
        t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:10px 20px;border-radius:24px;font-size:0.88rem;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.3);z-index:99999;transition:opacity 0.3s;pointer-events:none;';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    setTimeout(() => { t.style.opacity = '0'; }, 2600);
}

// ─────────────────────────────────────────────────────────────────────────────
// Yazılım Projesi Yönetimi (TincSync & AI / CLI Agent Entegrasyonlu)
// ─────────────────────────────────────────────────────────────────────────────
let currentSoftwareTab = 'rules';
let currentSoftwareData = null;

async function renderSoftwarePage(pageId) {
    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${pageId}`, {
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || ''
            }
        });
        const json = await resp.json();
        if (json.ok && json.data) {
            currentSoftwareData = json.data;
        }
    } catch (e) {
        console.warn("Software project fetch error:", e);
    }

    if (!currentSoftwareData) {
        currentSoftwareData = {
            project: {
                page_id: pageId,
                repo_name: activePageObj ? activePageObj.title : 'Yazılım Projesi',
                repo_path: '/home/turan/101',
                branch: 'main',
                tech_stack: 'Python, Flask, SQLite',
                api_key: 'tn_agent_offline',
                system_architecture: ''
            },
            rules: [],
            tasks: [],
            ideas: [],
            commits: []
        };
    }

    const proj = currentSoftwareData.project || {};
    const rules = currentSoftwareData.rules || [];
    const tasks = currentSoftwareData.tasks || [];
    const ideas = currentSoftwareData.ideas || [];
    const commits = currentSoftwareData.commits || [];

    // Header & Meta
    const repoNameEl = document.getElementById('soft-repo-name');
    const branchEl = document.getElementById('soft-branch-badge');
    const repoPathEl = document.getElementById('soft-repo-path');
    const stackEl = document.getElementById('soft-tech-stack');

    if (repoNameEl) repoNameEl.innerText = proj.repo_name || activePageObj.title;
    if (branchEl) branchEl.innerText = proj.branch || 'main';
    if (repoPathEl) repoPathEl.innerText = proj.repo_path || '(Yerel depo dizini ayarlanmadı)';
    if (stackEl) stackEl.innerText = proj.tech_stack || 'Genel Yazılım';

    // Counts
    const cRules = document.getElementById('soft-count-rules');
    const cTasks = document.getElementById('soft-count-tasks');
    const cIdeas = document.getElementById('soft-count-ideas');
    const cCommits = document.getElementById('soft-count-commits');
    if (cRules) cRules.innerText = rules.length;
    if (cTasks) cTasks.innerText = tasks.length;
    if (cIdeas) cIdeas.innerText = ideas.length;
    if (cCommits) cCommits.innerText = commits.length;

    // AI & Agent Paneli
    const apiKeyDisp = document.getElementById('soft-api-key-display');
    const agentsUrlDisp = document.getElementById('soft-agents-url-display');
    const curlCode = document.getElementById('soft-curl-example');

    const agentsUrl = `${sUrl}/notes/api/software/${pageId}/agents.md`;
    if (apiKeyDisp) apiKeyDisp.value = proj.api_key || '';
    if (agentsUrlDisp) agentsUrlDisp.value = agentsUrl;
    if (curlCode) {
        curlCode.innerText = `curl -H "X-Agent-Key: ${proj.api_key}" ${agentsUrl}`;
    }

    // Render Tab Panes
    renderSoftwareRulesList(rules);
    renderSoftwareTasksList(tasks);
    renderSoftwareIdeasList(ideas);
    renderSoftwareCommitsList(commits);
}

function switchSoftwareTab(tabName) {
    currentSoftwareTab = tabName;
    ['rules', 'tasks', 'ideas', 'commits', 'ai'].forEach(t => {
        const btn = document.getElementById(`stab-btn-${t}`);
        const pane = document.getElementById(`software-pane-${t}`);
        if (btn) btn.classList.toggle('active', t === tabName);
        if (pane) pane.style.display = (t === tabName) ? 'block' : 'none';
    });
}

function renderSoftwareRulesList(rules) {
    const listEl = document.getElementById('software-rules-list');
    if (!listEl) return;

    if (rules.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; padding:24px 8px; color:var(--muted); font-size:0.85rem; background:var(--surface); border-radius:8px;">
                📜 Henüz mimari kanun veya kural eklenmedi.<br>
                Ajanların ve geliştiricilerin uyması gereken kuralları ekleyin.
            </div>
        `;
        return;
    }

    listEl.innerHTML = rules.map(r => {
        let badgeColor = '#dc2626';
        let badgeBg = 'rgba(220,38,38,0.12)';
        if (r.severity === 'SHOULD') {
            badgeColor = '#d97706';
            badgeBg = 'rgba(217,119,6,0.12)';
        } else if (r.severity === 'NEVER') {
            badgeColor = '#7f1d1d';
            badgeBg = 'rgba(127,29,29,0.18)';
        }

        return `
            <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:6px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-size:0.7rem; font-weight:800; color:${badgeColor}; background:${badgeBg}; padding:2px 6px; border-radius:4px;">
                            ${r.severity}
                        </span>
                        <span style="font-size:0.75rem; color:var(--muted); font-weight:700;">
                            [${r.category || 'Architecture'}]
                        </span>
                    </div>
                    <button class="btn btn-ghost btn-xs" style="color:var(--danger); padding:2px 6px;" onclick="deleteSoftwareRule(${r.id})">✕</button>
                </div>
                <div style="font-weight:700; font-size:0.9rem; color:var(--text-primary);">${escapeHtml(r.title)}</div>
                <div style="font-size:0.82rem; color:var(--text-secondary); line-height:1.4;">${escapeHtml(r.content)}</div>
            </div>
        `;
    }).join('');
}

function renderSoftwareTasksList(tasks) {
    const listEl = document.getElementById('software-tasks-list');
    if (!listEl) return;

    if (tasks.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; padding:24px 8px; color:var(--muted); font-size:0.85rem; background:var(--surface); border-radius:8px;">
                ☑️ Aktif görev veya sprint maddesi bulunmuyor.<br>
                Yeni bir görev ekleyerek CLI ajanı veya kendiniz için atama yapabilirsiniz.
            </div>
        `;
        return;
    }

    listEl.innerHTML = tasks.map(t => {
        let prioBadge = '🟢 Düşük';
        if (t.priority === 'critical') prioBadge = '🔥 Kritik';
        else if (t.priority === 'high') prioBadge = '🔴 Yüksek';
        else if (t.priority === 'medium') prioBadge = '🟡 Orta';

        const isDone = (t.status === 'done');

        return `
            <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:6px; opacity:${isDone ? 0.65 : 1};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div style="display:flex; align-items:center; gap:6px; flex:1;">
                        <input type="checkbox" ${isDone ? 'checked' : ''} onchange="toggleSoftwareTaskDone(${t.id}, this.checked)" style="width:18px; height:18px; cursor:pointer;">
                        <span style="font-weight:700; font-size:0.92rem; ${isDone ? 'text-decoration:line-through; color:var(--muted);' : ''}">
                            ${escapeHtml(t.title)}
                        </span>
                    </div>
                    <button class="btn btn-ghost btn-xs" style="color:var(--danger); padding:2px 6px;" onclick="deleteSoftwareTask(${t.id})">✕</button>
                </div>
                ${t.description ? `<div style="font-size:0.82rem; color:var(--text-secondary); margin-left:24px;">${escapeHtml(t.description)}</div>` : ''}
                <div style="display:flex; justify-content:space-between; align-items:center; margin-left:24px; margin-top:4px; flex-wrap:wrap; gap:6px;">
                    <div style="display:flex; gap:6px; align-items:center;">
                        <span style="font-size:0.7rem; background:var(--surface); border:1px solid var(--border); padding:2px 6px; border-radius:6px; font-weight:700;">
                            ${prioBadge}
                        </span>
                        ${t.assigned_agent ? `<span style="font-size:0.7rem; background:rgba(99,102,241,0.12); color:#4f46e5; padding:2px 6px; border-radius:6px; font-weight:700;">🤖 @${escapeHtml(t.assigned_agent)}</span>` : ''}
                        ${t.commit_hash ? `<span style="font-size:0.7rem; font-family:monospace; background:var(--surface); padding:2px 4px; border-radius:4px;">#${t.commit_hash.slice(0, 7)}</span>` : ''}
                    </div>
                    <select class="input-text" style="padding:2px 6px; font-size:0.75rem; width:auto;" onchange="updateSoftwareTaskStatus(${t.id}, this.value)">
                        <option value="todo" ${t.status === 'todo' ? 'selected' : ''}>📋 Yapılacak</option>
                        <option value="in_progress" ${t.status === 'in_progress' ? 'selected' : ''}>⏳ Devam Eden</option>
                        <option value="review" ${t.status === 'review' ? 'selected' : ''}>🔍 İnceleme</option>
                        <option value="done" ${t.status === 'done' ? 'selected' : ''}>✅ Tamam</option>
                    </select>
                </div>
            </div>
        `;
    }).join('');
}

function renderSoftwareIdeasList(ideas) {
    const listEl = document.getElementById('software-ideas-list');
    if (!listEl) return;

    if (ideas.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; padding:24px 8px; color:var(--muted); font-size:0.85rem; background:var(--surface); border-radius:8px;">
                💡 Henüz bir geliştirme fikri veya RFC kaydedilmedi.<br>
                Aklınıza gelen mimari ve özellik fikirlerini buraya ekleyin.
            </div>
        `;
        return;
    }

    listEl.innerHTML = ideas.map(i => {
        let statusBadge = '📝 Taslak';
        if (i.status === 'approved') statusBadge = '✅ Onaylandı';
        else if (i.status === 'in_progress') statusBadge = '⏳ Geliştiriliyor';
        else if (i.status === 'done') statusBadge = '🎉 Tamamlandı';
        else if (i.status === 'rejected') statusBadge = '❌ Reddedildi';

        return `
            <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:6px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; gap:6px; align-items:center;">
                        <span style="font-size:0.75rem; font-weight:700; background:var(--surface); border:1px solid var(--border); padding:2px 6px; border-radius:6px;">
                            ${i.category || 'Feature'}
                        </span>
                        <span style="font-size:0.75rem; color:var(--muted);">${statusBadge}</span>
                    </div>
                    <button class="btn btn-ghost btn-xs" style="color:var(--danger); padding:2px 6px;" onclick="deleteSoftwareIdea(${i.id})">✕</button>
                </div>
                <div style="font-weight:700; font-size:0.92rem;">${escapeHtml(i.title)}</div>
                ${i.description ? `<div style="font-size:0.82rem; color:var(--text-secondary); line-height:1.4;">${escapeHtml(i.description)}</div>` : ''}
                <div style="display:flex; justify-content:flex-end; margin-top:4px;">
                    <select class="input-text" style="padding:2px 6px; font-size:0.75rem; width:auto;" onchange="updateSoftwareIdeaStatus(${i.id}, this.value)">
                        <option value="draft" ${i.status === 'draft' ? 'selected' : ''}>📝 Taslak</option>
                        <option value="approved" ${i.status === 'approved' ? 'selected' : ''}>✅ Onaylandı</option>
                        <option value="in_progress" ${i.status === 'in_progress' ? 'selected' : ''}>⏳ Geliştiriliyor</option>
                        <option value="done" ${i.status === 'done' ? 'selected' : ''}>🎉 Tamamlandı</option>
                        <option value="rejected" ${i.status === 'rejected' ? 'selected' : ''}>❌ Reddedildi</option>
                    </select>
                </div>
            </div>
        `;
    }).join('');
}

function renderSoftwareCommitsList(commits) {
    const listEl = document.getElementById('software-commits-list');
    if (!listEl) return;

    if (commits.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; padding:24px 8px; color:var(--muted); font-size:0.85rem; background:var(--surface); border-radius:8px;">
                🔀 Henüz commit kaydı yok.<br>
                Yukarıdaki "🔄 Git Eşitle" butonuna basarak yerel depodan commitleri çekebilirsiniz.
            </div>
        `;
        return;
    }

    listEl.innerHTML = commits.map(c => `
        <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border); border-radius:8px; padding:10px 12px; display:flex; flex-direction:column; gap:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-family:monospace; font-size:0.75rem; background:var(--surface); padding:2px 6px; border-radius:4px; font-weight:700; color:var(--primary);">
                    ${c.commit_hash.slice(0, 7)}
                </span>
                <span style="font-size:0.72rem; color:var(--muted);">
                    ${c.committed_at ? c.committed_at.slice(0, 16) : ''}
                </span>
            </div>
            <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary); line-height:1.3;">
                ${escapeHtml(c.message)}
            </div>
            <div style="font-size:0.75rem; color:var(--muted);">
                Yazar: <b>${escapeHtml(c.author || 'Anonim')}</b>
            </div>
        </div>
    `).join('');
}

async function syncSoftwareGit() {
    showMobileToast("Git deposundan commitler çekiliyor...");
    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${activePageId}/sync-git`, {
            method: 'POST',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || '',
                'Content-Type': 'application/json'
            }
        });
        const json = await resp.json();
        if (json.ok) {
            showMobileToast(`✅ ${json.synced_count || 0} yeni commit eşitlendi!`);
            await renderSoftwarePage(activePageId);
        } else {
            alert(json.error || 'Git eşitleme başarısız oldu');
        }
    } catch (e) {
        showMobileToast("Git eşitleme hatası: " + e.message);
    }
}

async function openSoftwareSettingsModal() {
    if (!currentSoftwareData) return;
    const proj = currentSoftwareData.project || {};

    document.getElementById('soft-set-repo-name').value = proj.repo_name || activePageObj.title || '';
    document.getElementById('soft-set-repo-path').value = proj.repo_path || '';
    document.getElementById('soft-set-branch').value = proj.branch || 'main';
    document.getElementById('soft-set-tech-stack').value = proj.tech_stack || '';
    document.getElementById('soft-set-architecture').value = proj.system_architecture || '';
    document.getElementById('soft-set-api-key').value = proj.api_key || '';

    openModal('modal-software-settings');
}

async function submitSaveSoftwareSettings() {
    const repo_name = document.getElementById('soft-set-repo-name').value.trim();
    const repo_path = document.getElementById('soft-set-repo-path').value.trim();
    const branch = document.getElementById('soft-set-branch').value.trim() || 'main';
    const tech_stack = document.getElementById('soft-set-tech-stack').value.trim();
    const system_architecture = document.getElementById('soft-set-architecture').value.trim();
    const api_key = document.getElementById('soft-set-api-key').value.trim();

    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${activePageId}`, {
            method: 'PUT',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || '',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                repo_name, repo_path, branch, tech_stack, system_architecture, api_key
            })
        });
        const json = await resp.json();
        if (json.ok) {
            closeModal('modal-software-settings');
            showMobileToast('Proje ayarları kaydedildi');
            await renderSoftwarePage(activePageId);
        } else {
            alert(json.error || 'Kaydetme hatası');
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

function regenerateSoftwareApiKey() {
    const rand = 'tn_agent_' + Math.random().toString(36).substring(2, 14);
    document.getElementById('soft-set-api-key').value = rand;
}

function openAddSoftwareRuleModal() {
    document.getElementById('soft-rule-title').value = '';
    document.getElementById('soft-rule-content').value = '';
    openModal('modal-add-software-rule');
}

async function submitAddSoftwareRule() {
    const title = document.getElementById('soft-rule-title').value.trim();
    const content = document.getElementById('soft-rule-content').value.trim();
    const category = document.getElementById('soft-rule-category').value;
    const severity = document.getElementById('soft-rule-severity').value;

    if (!title) {
        alert('Lütfen kural başlığı yazın.');
        return;
    }

    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${activePageId}/rules`, {
            method: 'POST',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || '',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, content, category, severity })
        });
        const json = await resp.json();
        if (json.ok) {
            closeModal('modal-add-software-rule');
            showMobileToast('Kural eklendi');
            await renderSoftwarePage(activePageId);
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

async function deleteSoftwareRule(ruleId) {
    if (!confirm('Bu kuralı silmek istediğinize emin misiniz?')) return;
    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${activePageId}/rules/${ruleId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || ''
            }
        });
        const json = await resp.json();
        if (json.ok) {
            showMobileToast('Kural silindi');
            await renderSoftwarePage(activePageId);
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

function openAddSoftwareTaskModal() {
    document.getElementById('soft-task-title').value = '';
    document.getElementById('soft-task-desc').value = '';
    document.getElementById('soft-task-agent').value = '';
    openModal('modal-add-software-task');
}

async function submitAddSoftwareTask() {
    const title = document.getElementById('soft-task-title').value.trim();
    const description = document.getElementById('soft-task-desc').value.trim();
    const priority = document.getElementById('soft-task-priority').value;
    const assigned_agent = document.getElementById('soft-task-agent').value.trim();

    if (!title) {
        alert('Lütfen görev başlığı yazın.');
        return;
    }

    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${activePageId}/tasks`, {
            method: 'POST',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || '',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, description, priority, assigned_agent, status: 'todo' })
        });
        const json = await resp.json();
        if (json.ok) {
            closeModal('modal-add-software-task');
            showMobileToast('Görev eklendi');
            await renderSoftwarePage(activePageId);
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

async function updateSoftwareTaskStatus(taskId, status) {
    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        await fetch(`${sUrl}/notes/api/software/${activePageId}/tasks/${taskId}`, {
            method: 'PUT',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || '',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status })
        });
        await renderSoftwarePage(activePageId);
    } catch (e) {
        console.warn("Task status update error:", e);
    }
}

async function toggleSoftwareTaskDone(taskId, isDone) {
    await updateSoftwareTaskStatus(taskId, isDone ? 'done' : 'todo');
}

async function deleteSoftwareTask(taskId) {
    if (!confirm('Bu görevi silmek istediğinize emin misiniz?')) return;
    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${activePageId}/tasks/${taskId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || ''
            }
        });
        const json = await resp.json();
        if (json.ok) {
            showMobileToast('Görev silindi');
            await renderSoftwarePage(activePageId);
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

function openAddSoftwareIdeaModal() {
    document.getElementById('soft-idea-title').value = '';
    document.getElementById('soft-idea-desc').value = '';
    openModal('modal-add-software-idea');
}

async function submitAddSoftwareIdea() {
    const title = document.getElementById('soft-idea-title').value.trim();
    const description = document.getElementById('soft-idea-desc').value.trim();
    const category = document.getElementById('soft-idea-category').value;
    const status = document.getElementById('soft-idea-status').value;

    if (!title) {
        alert('Lütfen fikir başlığı yazın.');
        return;
    }

    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${activePageId}/ideas`, {
            method: 'POST',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || '',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, description, category, status })
        });
        const json = await resp.json();
        if (json.ok) {
            closeModal('modal-add-software-idea');
            showMobileToast('Fikir eklendi');
            await renderSoftwarePage(activePageId);
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

async function updateSoftwareIdeaStatus(ideaId, status) {
    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        await fetch(`${sUrl}/notes/api/software/${activePageId}/ideas/${ideaId}`, {
            method: 'PUT',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || '',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status })
        });
        await renderSoftwarePage(activePageId);
    } catch (e) {
        console.warn("Idea status update error:", e);
    }
}

async function deleteSoftwareIdea(ideaId) {
    if (!confirm('Bu fikri silmek istediğinize emin misiniz?')) return;
    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${activePageId}/ideas/${ideaId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || ''
            }
        });
        const json = await resp.json();
        if (json.ok) {
            showMobileToast('Fikir silindi');
            await renderSoftwarePage(activePageId);
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

async function openAgentsMarkdownModal() {
    const sUrl = await window.appSync.getServerUrl();
    const token = await window.appStorage.getSetting('auth_token', '');

    try {
        const resp = await fetch(`${sUrl}/notes/api/software/${activePageId}/agents.md`, {
            headers: {
                'Authorization': token ? `Bearer ${token}` : '',
                'X-Auth-Token': token || ''
            }
        });
        const mdText = await resp.text();
        const preEl = document.getElementById('soft-agents-md-text');
        if (preEl) preEl.innerText = mdText;
        openModal('modal-software-agents-view');
    } catch (e) {
        showMobileToast('AGENTS.md yüklenemedi: ' + e.message);
    }
}

function copySoftwareAgentsMdText() {
    const preEl = document.getElementById('soft-agents-md-text');
    if (preEl && preEl.innerText) {
        navigator.clipboard.writeText(preEl.innerText).then(() => {
            showMobileToast('AGENTS.md panoya kopyalandı!');
        });
    }
}

function copySoftwareApiKey() {
    const el = document.getElementById('soft-api-key-display');
    if (el && el.value) {
        navigator.clipboard.writeText(el.value).then(() => {
            showMobileToast('API Anahtarı kopyalandı!');
        });
    }
}

function copySoftwareAgentsUrl() {
    const el = document.getElementById('soft-agents-url-display');
    if (el && el.value) {
        navigator.clipboard.writeText(el.value).then(() => {
            showMobileToast('AGENTS.md bağlantısı kopyalandı!');
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOBİL POWER PACKS: Pin, Kilit, Ekler, Hedef Sayacı, Zaman Tüneli, Graf
// ─────────────────────────────────────────────────────────────────────────────

async function toggleMobilePagePin() {
    if (!activePageId) return;
    const page = await window.appStorage.getPage(activePageId);
    if (!page) return;
    const newStatus = page.is_pinned ? 0 : 1;
    page.is_pinned = newStatus;
    await window.appStorage.savePage(page);

    const btn = document.getElementById('m-btn-page-pin');
    if (btn) btn.style.color = newStatus ? 'var(--warning, #f59e0b)' : '';

    showMobileToast(newStatus ? '📌 Sayfa başa sabitlendi' : '📌 Sabitleme kaldırıldı');
    await reloadDrawerNavigation();

    // Sunucuya senkronize et
    window.appSync.apiFetch(`/notes/api/pages/${activePageId}/pin`, { method: 'POST' }).catch(() => {});
}

function promptMobilePageLock() {
    if (!activePageId) return;
    const desc = document.getElementById('m-pin-desc');
    const remBtn = document.getElementById('m-btn-remove-lock');
    const pinInp = document.getElementById('m-pin-set-input');
    const errEl = document.getElementById('m-pin-set-err');

    if (errEl) errEl.style.display = 'none';
    if (pinInp) pinInp.value = '';

    if (activePageObj && activePageObj.is_locked) {
        if (desc) desc.innerText = 'Bu sayfa kilitli. PIN değiştirebilir veya kilidi kaldırabilirsiniz:';
        if (remBtn) remBtn.style.display = 'block';
    } else {
        if (desc) desc.innerText = 'Bu sayfayı kilitlemek için 4 haneli PIN belirleyin:';
        if (remBtn) remBtn.style.display = 'none';
    }
    openModal('modal-mobile-pin-set');
}

async function submitMobileLockSet() {
    const pinInp = document.getElementById('m-pin-set-input');
    const pin = pinInp ? pinInp.value.trim() : '';
    const errEl = document.getElementById('m-pin-set-err');
    if (!pin || pin.length < 4) {
        if (errEl) { errEl.innerText = 'PIN en az 4 haneli olmalıdır.'; errEl.style.display = 'block'; }
        return;
    }
    try {
        const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/lock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin, action: 'lock' })
        });
        const data = await res.json();
        if (data.ok) {
            if (activePageObj) activePageObj.is_locked = 1;
            window[`unlocked_page_${activePageId}`] = true;
            closeModal('modal-mobile-pin-set');
            await renderActivePage();
            showMobileToast('🔒 Sayfa başarıyla kilitlendi');
        } else {
            if (errEl) { errEl.innerText = data.error || 'İşlem başarısız'; errEl.style.display = 'block'; }
        }
    } catch (e) {
        if (errEl) { errEl.innerText = 'Bağlantı hatası'; errEl.style.display = 'block'; }
    }
}

async function submitMobileLockRemove() {
    if (!confirm('Sayfa kilidini kaldırmak istediğinize emin misiniz?')) return;
    try {
        const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/lock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'unlock' })
        });
        const data = await res.json();
        if (data.ok) {
            if (activePageObj) activePageObj.is_locked = 0;
            delete window[`unlocked_page_${activePageId}`];
            closeModal('modal-mobile-pin-set');
            await renderActivePage();
            showMobileToast('🔓 Sayfa kilidi kaldırıldı');
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

async function submitMobileUnlockPin() {
    const pinInp = document.getElementById('m-locked-pin-input');
    const pin = pinInp ? pinInp.value.trim() : '';
    const errEl = document.getElementById('m-locked-pin-error');
    if (!pin) return;

    try {
        const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/verify-lock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
        });
        const data = await res.json();
        if (data.ok && data.page) {
            window[`unlocked_page_${activePageId}`] = true;
            activePageObj = data.page;
            await window.appStorage.put('pages', { ...data.page, _dirty: false });
            await renderActivePage();
        } else {
            if (errEl) {
                errEl.innerText = data.error || 'Hatalı PIN kodu';
                errEl.style.display = 'block';
            }
        }
    } catch (e) {
        if (errEl) {
            errEl.innerText = 'Bağlantı hatası';
            errEl.style.display = 'block';
        }
    }
}

function insertMobileToggleBlock() {
    const editor = document.getElementById('page-rich-editor');
    if (!editor) return;
    const title = prompt('Katlanabilir Başlık:', '▶️ Bölüm Başlığı') || 'Bölüm';
    const html = `<details class="note-toggle" open><summary>${escapeHtml(title)}</summary><p>Detayları buraya yazabilirsiniz...</p></details><p><br></p>`;
    document.execCommand('insertHTML', false, html);
    handleMobileRichNoteInput();
    editor.focus();
}

function promptMobileSmartClip() {
    const inp = document.getElementById('m-smart-clip-url');
    const stat = document.getElementById('m-smart-clip-status');
    if (inp) inp.value = '';
    if (stat) stat.style.display = 'none';
    openModal('modal-mobile-smart-clip');
}

async function submitMobileSmartClip() {
    const inp = document.getElementById('m-smart-clip-url');
    const url = inp ? inp.value.trim() : '';
    const stat = document.getElementById('m-smart-clip-status');
    const btn = document.getElementById('m-btn-clip-submit');
    if (!url) return;

    if (stat) { stat.innerText = 'Bağlantı ve meta veriler alınıyor...'; stat.style.display = 'block'; }
    if (btn) btn.disabled = true;

    try {
        const res = await window.appSync.apiFetch('/notes/api/tools/clip_url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (data.ok && data.card) {
            const c = data.card;
            const thumbHtml = c.image_url ? `<div class="bookmark-card-thumb" style="background-image:url('${c.image_url}');"></div>` : '';
            const cardHtml = `
                <a href="${escapeHtml(c.url)}" target="_blank" class="bookmark-card">
                    ${thumbHtml}
                    <div class="bookmark-card-info">
                        <div class="bookmark-card-title">${escapeHtml(c.title || c.url)}</div>
                        <div class="bookmark-card-desc">${escapeHtml(c.description || '')}</div>
                        <div class="bookmark-card-source">🔗 ${escapeHtml(c.site_name || 'Web')}</div>
                    </div>
                </a><p><br></p>
            `;
            const editor = document.getElementById('page-rich-editor');
            if (editor) {
                editor.focus();
                document.execCommand('insertHTML', false, cardHtml);
                handleMobileRichNoteInput();
            }
            closeModal('modal-mobile-smart-clip');
            showMobileToast('🔗 Yer imi notunuza eklendi');
        } else {
            if (stat) stat.innerText = data.error || 'Bağlantı alınamadı.';
        }
    } catch (e) {
        if (stat) stat.innerText = 'Hata: URL çözümlenemedi.';
    } finally {
        if (btn) btn.disabled = false;
    }
}

function toggleMobileAttachmentsTray(forceState) {
    const bar = document.getElementById('mobile-attachments-bar');
    if (!bar) return;
    if (forceState !== undefined) {
        bar.style.display = forceState ? 'block' : 'none';
    } else {
        bar.style.display = (bar.style.display === 'none' || !bar.style.display) ? 'block' : 'none';
    }
    if (bar.style.display === 'block' && activePageId) {
        loadMobileAttachmentsList(activePageId);
    }
}

async function loadMobileAttachmentsList(pageId) {
    if (!pageId) return;
    try {
        const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}/attachments`);
        const data = await res.json();
        if (data.ok && data.attachments) {
            const listEl = document.getElementById('mobile-attachments-list');
            const countEl = document.getElementById('mobile-attachments-count');
            if (countEl) countEl.innerText = data.attachments.length;
            if (listEl) {
                if (data.attachments.length === 0) {
                    listEl.innerHTML = '<span style="font-size:0.72rem; color:var(--muted); font-style:italic;">Ekli belge yok.</span>';
                    return;
                }
                const sUrl = await window.appSync.getServerUrl();
                listEl.innerHTML = data.attachments.map(att => {
                    const isPdf = att.filename.toLowerCase().endsWith('.pdf') || att.mime_type.includes('pdf');
                    const icon = isPdf ? '📄' : (att.filename.match(/\.(zip|tar|gz)$/i) ? '📦' : '📎');
                    const sizeKb = Math.round((att.file_size || 0) / 1024);
                    const fullUrl = att.file_url.startsWith('http') ? att.file_url : `${sUrl}${att.file_url}`;
                    const clickAction = isPdf ? `openMobilePdfViewer('${fullUrl}', '${escapeHtml(att.original_name)}')` : `window.open('${fullUrl}', '_system')`;
                    return `
                        <div class="attachment-chip">
                            <span onclick="${clickAction}">${icon} ${escapeHtml(att.original_name)} (${sizeKb}K)</span>
                            <span class="att-del-btn" onclick="deleteMobileAttachment(${att.id})">✕</span>
                        </div>
                    `;
                }).join('');
            }
        }
    } catch (e) {
        console.warn("loadMobileAttachmentsList error:", e);
    }
}

async function handleMobileAttachmentSelected(event) {
    const file = event.target.files[0];
    if (!file || !activePageId) return;
    const formData = new FormData();
    formData.append('file', file);

    try {
        const sUrl = await window.appSync.getServerUrl();
        const token = await window.appStorage.getSetting('auth_token', '');
        const res = await fetch(`${sUrl}/notes/api/pages/${activePageId}/attachments`, {
            method: 'POST',
            headers: { 'Authorization': token ? `Bearer ${token}` : '', 'X-Auth-Token': token || '' },
            body: formData
        });
        const data = await res.json();
        if (data.ok) {
            showMobileToast(`📎 ${file.name} başarıyla eklendi`);
            loadMobileAttachmentsList(activePageId);
            document.getElementById('mobile-attachments-bar').style.display = 'block';
        } else {
            alert(data.error || 'Yüklenemedi');
        }
    } catch (e) {
        alert('Dosya yükleme hatası: ' + e.message);
    }
    event.target.value = '';
}

async function deleteMobileAttachment(attId) {
    if (!confirm('Bu eki silmek istediğinize emin misiniz?')) return;
    try {
        const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/attachments/${attId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
            loadMobileAttachmentsList(activePageId);
            showMobileToast('Ek silindi');
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

function openMobilePdfViewer(fileUrl, filename) {
    const frame = document.getElementById('m-pdf-iframe');
    const titleEl = document.getElementById('m-pdf-title');
    const dl = document.getElementById('m-pdf-download');
    if (frame) frame.src = fileUrl;
    if (titleEl) titleEl.innerText = filename || 'PDF Belge';
    if (dl) dl.href = fileUrl;
    openModal('modal-mobile-pdf-viewer');
}

function promptMobileWordGoal() {
    if (!activePageId || !activePageObj) return;
    const curTarget = activePageObj.target_word_count || 0;
    const val = prompt('Hedef kelime sayısı girin (Kaldırmak için 0):', curTarget > 0 ? curTarget : '1000');
    if (val === null) return;
    const target = parseInt(val, 10);
    if (isNaN(target) || target < 0) return;

    activePageObj.target_word_count = target;
    window.appStorage.savePage(activePageObj);
    updateMobileWordGoalStats(activePageObj);
    showMobileToast(target > 0 ? `🎯 Hedef belirlendi: ${target} kelime` : '🎯 Hedef kaldırıldı');

    window.appSync.apiFetch(`/notes/api/pages/${activePageId}/word-count-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
    }).catch(() => {});
}

function updateMobileWordGoalStats(page) {
    const richEditor = document.getElementById('page-rich-editor');
    const hiddenTa = document.getElementById('page-note-content');
    const text = richEditor ? richEditor.innerText.trim() : (hiddenTa ? hiddenTa.value.trim() : '');
    const len = text.length;
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;

    const statsEl = document.getElementById('mobile-note-stats');
    if (statsEl) statsEl.innerText = `${len} karakter • ${words} kelime`;

    const target = (page && page.target_word_count) ? page.target_word_count : 0;
    const wrap = document.getElementById('mobile-word-goal-wrap');
    const textEl = document.getElementById('mobile-word-goal-text');
    const fillEl = document.getElementById('mobile-word-goal-fill');
    const pctEl = document.getElementById('mobile-word-goal-pct');

    if (target > 0) {
        const pct = Math.min(100, Math.round((words / target) * 100));
        if (textEl) textEl.innerText = `🎯 ${words} / ${target} kelime (${pct >= 100 ? '🎉 Tamam' : `%${pct}`})`;
        if (fillEl) {
            fillEl.style.width = `${pct}%`;
            fillEl.style.backgroundColor = pct >= 100 ? 'var(--success)' : 'var(--primary)';
        }
        if (pctEl) pctEl.innerText = `%${pct}`;
        if (wrap) wrap.style.display = 'flex';
    } else {
        if (wrap) wrap.style.display = 'none';
    }
}

async function openMobileTimeMachine() {
    if (!activePageId) return;
    openModal('modal-mobile-time-machine');
    const listEl = document.getElementById('m-time-machine-list');
    if (listEl) listEl.innerHTML = '<div style="text-align:center; padding:16px; color:var(--muted);">Versiyonlar yükleniyor...</div>';

    try {
        const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/versions`);
        const data = await res.json();
        if (data.ok && data.versions) {
            if (data.versions.length === 0) {
                listEl.innerHTML = '<div style="text-align:center; padding:16px; color:var(--muted); font-size:0.8rem;">Bu sayfa için henüz kaydedilmiş bir önceki versiyon yok.</div>';
                return;
            }
            listEl.innerHTML = data.versions.map(v => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; background:var(--surface2); border-radius:6px; font-size:0.8rem;">
                    <div>
                        <div style="font-weight:700;">${escapeHtml(v.title || 'Başlıksız')}</div>
                        <div style="font-size:0.7rem; color:var(--muted);">${v.created_at} &bull; ${v.char_count || 0} karakter</div>
                    </div>
                    <button class="btn btn-primary btn-xs" onclick="restoreMobilePageVersion(${v.id})">↩️ Geri Yükle</button>
                </div>
            `).join('');
        }
    } catch (e) {
        if (listEl) listEl.innerHTML = '<div style="color:var(--danger); text-align:center; padding:16px;">Alınamadı: ' + e.message + '</div>';
    }
}

async function restoreMobilePageVersion(versionId) {
    if (!confirm('Bu versiyonu geri yüklemek istediğinize emin misiniz?')) return;
    try {
        const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/versions/${versionId}/restore`, { method: 'POST' });
        const data = await res.json();
        if (data.ok && data.page) {
            activePageObj = data.page;
            await window.appStorage.put('pages', { ...data.page, _dirty: false });
            closeModal('modal-mobile-time-machine');
            await renderActivePage();
            showMobileToast('⏳ Sayfa önceki versiyona geri yüklendi!');
        }
    } catch (e) {
        showMobileToast('Hata: ' + e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOBİL ZİHİN AĞI GRAFİĞİ (Mobile Mind Map / Graph View)
// ─────────────────────────────────────────────────────────────────────────────

let mGraphAnimationId = null;

async function openMobileGraphView() {
    toggleSidebar(false);
    openModal('modal-mobile-graph-view');
    try {
        let graphData = null;
        try {
            const res = await window.appSync.apiFetch('/notes/api/graph');
            const data = await res.json();
            if (data.ok && (data.graph || data.nodes)) {
                graphData = data.graph || data;
            }
        } catch (netErr) {
            console.warn('Graf API çağrısı başarısız, yerel depolamaya geçiliyor:', netErr);
        }

        // Çevrimdışı / Yerel Depolama yedeği
        if ((!graphData || !graphData.nodes || graphData.nodes.length === 0) && window.appStorage) {
            const pages = await window.appStorage.getAll('pages');
            const activePages = (pages || []).filter(p => !p._deleted && !p.is_archived);
            const nodes = [];
            const edges = [];
            const titleToId = {};
            for (const p of activePages) {
                titleToId[(p.title || '').trim().toLowerCase()] = p.id;
                nodes.push({
                    id: p.id,
                    label: p.title || 'İsimsiz',
                    icon: p.icon || '📝',
                    type: p.type || 'notes',
                    color: p.color || (p.type === 'checklist' ? '#10b981' : p.type === 'finance' ? '#f59e0b' : '#3b82f6')
                });
            }
            const linkPattern = /\[\[(.*?)\]\]/g;
            const seen = new Set();
            for (const p of activePages) {
                const content = (p.content || '') + ' ' + (p.title || '');
                let m;
                while ((m = linkPattern.exec(content)) !== null) {
                    const targetId = titleToId[(m[1] || '').trim().toLowerCase()];
                    if (targetId && targetId !== p.id) {
                        const key = `${p.id}->${targetId}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            edges.push({ source: p.id, target: targetId });
                        }
                    }
                }
            }
            graphData = { nodes, links: edges, edges };
        }

        if (graphData && graphData.nodes) {
            // Modalın DOM'da tam açılması ve boyutlanması için kısa gecikme
            setTimeout(() => {
                renderMobileGraphCanvas(graphData);
            }, 100);
        } else {
            setTimeout(() => {
                renderMobileGraphCanvas({ nodes: [], links: [] });
            }, 100);
        }
    } catch (e) {
        console.error('Graf yükleme hatası:', e);
        showMobileToast('Zihin grafiği açılamadı: ' + e.message);
    }
}

function renderMobileGraphCanvas(graph) {
    const canvas = document.getElementById('m-graph-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const container = canvas.parentElement;
    const pRect = container ? container.getBoundingClientRect() : null;
    canvas.width = (pRect && pRect.width > 50) ? Math.floor(pRect.width) : Math.floor(window.innerWidth * 0.9);
    canvas.height = (pRect && pRect.height > 50) ? Math.floor(pRect.height) : Math.floor(window.innerHeight * 0.65);
    const width = canvas.width;
    const height = canvas.height;

    const rawNodes = (graph && graph.nodes) ? graph.nodes : [];
    const rawLinks = (graph && (graph.links || graph.edges)) ? (graph.links || graph.edges) : [];

    if (rawNodes.length === 0) {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#f1f5f9';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🕸️ Henüz sayfa veya not bulunmuyor', width / 2, height / 2 - 14);
        ctx.font = '12px sans-serif';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText('Sayfa ekledikçe burada zihin ağı oluşur.', width / 2, height / 2 + 12);
        ctx.fillText('Notlarınıza [[Sayfa Adı]] yazarak sayfaları birbirine bağlayabilirsiniz.', width / 2, height / 2 + 32);
        return;
    }

    const nodes = rawNodes.map((n, i) => {
        const angle = (i / rawNodes.length) * 2 * Math.PI;
        const radius = Math.min(width, height) * 0.32 + Math.random() * 30;
        return {
            ...n,
            x: width / 2 + Math.cos(angle) * radius,
            y: height / 2 + Math.sin(angle) * radius,
            vx: 0,
            vy: 0,
            r: Math.max(8, Math.min(18, 6 + (n.val || 1) * 2.5))
        };
    });

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const links = rawLinks.map(l => ({
        source: nodeMap.get(l.source),
        target: nodeMap.get(l.target)
    })).filter(l => l.source && l.target);

    function handleTap(clientX, clientY) {
        const r = canvas.getBoundingClientRect();
        const mx = clientX - r.left;
        const my = clientY - r.top;
        const clicked = nodes.find(n => Math.hypot(n.x - mx, n.y - my) <= n.r + 8);
        if (clicked) {
            closeModal('modal-mobile-graph-view');
            openPage(clicked.id);
        }
    }

    canvas.onclick = (e) => handleTap(e.clientX, e.clientY);
    canvas.ontouchend = (e) => {
        if (e.changedTouches.length > 0) {
            handleTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
        }
    };

    if (mGraphAnimationId) cancelAnimationFrame(mGraphAnimationId);

    function step() {
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            a.vx += (width / 2 - a.x) * 0.0007;
            a.vy += (height / 2 - a.y) * 0.0007;
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist = Math.hypot(dx, dy) || 1;
                if (dist < 160) {
                    const force = (160 - dist) / dist * 0.05;
                    a.vx -= dx * force;
                    a.vy -= dy * force;
                    b.vx += dx * force;
                    b.vy += dy * force;
                }
            }
        }
        for (const l of links) {
            const dx = l.target.x - l.source.x;
            const dy = l.target.y - l.source.y;
            const dist = Math.hypot(dx, dy) || 1;
            const force = (dist - 60) * 0.006;
            l.source.vx += dx * force;
            l.source.vy += dy * force;
            l.target.vx -= dx * force;
            l.target.vy -= dy * force;
        }
        for (const n of nodes) {
            n.x += n.vx;
            n.y += n.vy;
            n.vx *= 0.86;
            n.vy *= 0.86;
        }

        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
        ctx.lineWidth = 1.2;
        for (const l of links) {
            ctx.beginPath();
            ctx.moveTo(l.source.x, l.source.y);
            ctx.lineTo(l.target.x, l.target.y);
            ctx.stroke();
        }
        for (const n of nodes) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
            ctx.fillStyle = (typeof activePageId !== 'undefined' && n.id == activePageId) ? '#3b82f6' : (n.color || '#0284c7');
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.font = '10px sans-serif';
            ctx.fillStyle = '#f8fafc';
            ctx.textAlign = 'center';
            ctx.fillText(n.label || 'Not', n.x, n.y + n.r + 12);
        }
        mGraphAnimationId = requestAnimationFrame(step);
    }
    step();
}

// ─────────────────────────────────────────────────────────────────────────────
// MOBİL E-POSTA DOĞRULAMA (6 Haneli Kod)
// ─────────────────────────────────────────────────────────────────────────────

async function submitMobileEmailCode() {
    const inp = document.getElementById('m-verify-code-input');
    const code = inp ? inp.value.trim() : '';
    const stat = document.getElementById('m-verify-code-status');
    if (!code || code.length < 6) {
        if (stat) { stat.innerText = 'Lütfen 6 haneli kodu girin.'; stat.style.color = 'var(--danger)'; stat.style.display = 'block'; }
        return;
    }
    try {
        const res = await window.appSync.apiFetch('/notes/api/auth/verify-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (data.ok) {
            if (stat) { stat.innerText = '✓ E-posta başarıyla doğrulandı!'; stat.style.color = 'var(--success)'; stat.style.display = 'block'; }
            const uJson = await window.appStorage.getSetting('user_profile', '');
            if (uJson) {
                const u = JSON.parse(uJson);
                u.is_email_verified = 1;
                await window.appStorage.setSetting('user_profile', JSON.stringify(u));
            }
            setTimeout(() => {
                closeModal('modal-mobile-email-verify');
                refreshMobileAuthUI();
            }, 1000);
        } else {
            if (stat) { stat.innerText = data.error || 'Hatalı kod'; stat.style.color = 'var(--danger)'; stat.style.display = 'block'; }
        }
    } catch (e) {
        if (stat) { stat.innerText = 'Hata: ' + e.message; stat.style.color = 'var(--danger)'; stat.style.display = 'block'; }
    }
}

async function resendMobileEmailCode() {
    const stat = document.getElementById('m-verify-code-status');
    try {
        const res = await window.appSync.apiFetch('/notes/api/auth/resend-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (data.ok) {
            const demoHint = data.code_demo ? ` (Demo Kodu: ${data.code_demo})` : '';
            if (stat) { stat.innerText = `Kod tekrar gönderildi!${demoHint}`; stat.style.color = 'var(--primary)'; stat.style.display = 'block'; }
            if (data.code_demo) {
                const inp = document.getElementById('m-verify-code-input');
                if (inp) inp.value = data.code_demo;
            }
        }
    } catch (e) {
        if (stat) { stat.innerText = 'Kod gönderilemedi: ' + e.message; stat.style.color = 'var(--danger)'; stat.style.display = 'block'; }
    }
}
