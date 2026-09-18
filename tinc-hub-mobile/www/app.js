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
                    <div class="overview-item" style="padding:10px 12px; display:flex; align-items:flex-start; justify-content:space-between; gap:10px; border-radius:10px; margin-bottom:6px;">
                        <div style="flex:1; min-width:0;">
                            <div style="font-size:0.9rem; color:var(--text); white-space:pre-wrap; word-break:break-word; line-height:1.4;">
                                ${escapeHtml(n.content)}
                            </div>
                            <div style="font-size:0.72rem; color:var(--muted); margin-top:4px;">
                                🕒 ${timeStr}
                            </div>
                        </div>
                        <div style="display:flex; gap:6px; flex-shrink:0;">
                            <button class="btn btn-secondary btn-sm" onclick="openTransferQuickNoteModal(${n.id})" title="Sayfaya Aktar" style="padding:4px 8px; font-size:0.78rem;">📁 Aktar</button>
                            <button class="btn btn-ghost btn-sm" onclick="deleteQuickNoteFromUI(${n.id})" title="Sil" style="padding:4px 8px; color:var(--danger);">🗑️</button>
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

    const countTag = document.getElementById('quick-tasks-count-tag');
    if (countTag) countTag.innerText = `${directActive.length} Görev`;

    const directListEl = document.getElementById('quick-direct-tasks-list');
    if (directListEl) {
        if (quickItems.length === 0) {
            directListEl.innerHTML = `<div class="empty-hint">Henüz hızlı görev eklenmedi. Yukarıdan hemen yazıp ekleyin ✨</div>`;
        } else {
            directListEl.innerHTML = quickItems.map(it => {
                const alarmColor = it.remind_at ? '#7c3aed' : 'var(--muted)';
                return `
                <div class="checklist-item-card ${it.is_done ? 'done' : ''}" style="margin-bottom:6px;">
                    <div class="checkbox-custom" onclick="toggleQuickDirectItem(${it.id})">
                        ${it.is_done ? '✓' : ''}
                    </div>
                    <div class="checklist-item-body" onclick="toggleQuickDirectItem(${it.id})">
                        <div class="checklist-item-title">${escapeHtml(it.title)}</div>
                        ${it.remind_at ? `<div class="checklist-item-meta"><span class="meta-badge reminder" style="background:#f5f3ff; color:#7c3aed; border:1px solid #ddd6fe; cursor:pointer;" onclick="event.stopPropagation(); openItemReminderModal(${it.id})">⏰ ${escapeHtml(it.remind_at.substring(5, 16))}</span></div>` : ''}
                    </div>
                    <div class="checklist-item-actions" style="display:flex; align-items:center; gap:4px;">
                        <button class="item-action-btn" style="color:${alarmColor}; font-size:0.9rem;" onclick="event.stopPropagation(); openItemReminderModal(${it.id})" title="Alarm & Hatırlatıcı Ayarla">⏰</button>
                        <button class="item-action-btn" onclick="deleteQuickDirectItem(${it.id})" title="Sil">🗑️</button>
                    </div>
                </div>
            `}).join('');
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

                const alarmBtn = (t.type === 'checklist') ?
                    `<button class="item-action-btn" style="color:${t.remind_at ? '#7c3aed' : 'var(--muted)'}; font-size:0.9rem; padding:4px;" onclick="event.stopPropagation(); openItemReminderModal(${t.raw_id})" title="Alarm Ayarla">⏰</button>` : '';

                return `
                    <div class="overview-item" style="padding:10px 12px; margin-bottom:6px; cursor:pointer;" onclick="openPage(${t.page_id})">
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
                            ${alarmBtn}
                            <span style="color:var(--muted); font-size:0.8rem;">➔</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    syncWidgetData();
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
    if (!confirm('Bu hızlı notu silmek istediğinize emin misiniz?')) return;
    await window.appStorage.deleteQuickNote(noteId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
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
    await window.appStorage.deleteItem(itemId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
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
                    <span class="drawer-drag-handle cat-drag-handle" title="Ayracı taşı">⠿</span>
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
                        <span class="drawer-drag-handle page-drag-handle" onclick="event.stopPropagation()" title="Sayfayı taşı">⠿</span>
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
                        <span class="drawer-drag-handle cat-drag-handle" onclick="event.stopPropagation()" title="Dosyayı taşı">⠿</span>
                        <span class="drawer-cat-arrow">▶</span>
                        <span style="font-size:1.05rem; line-height:1;">${cat.icon || '📁'}</span>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;">${escapeHtml(cat.name)}</span>
                        <span class="cat-color-dot" style="width:7px; height:7px; border-radius:50%; background:${catColor}; flex-shrink:0; display:inline-block; box-shadow:0 0 0 1.5px rgba(0,0,0,0.06);"></span>
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
// Mobil Çekmece Sürükle-Bırak (Touch / Drag & Drop Controller)
// ─────────────────────────────────────────────────────────────────────────────
let mobileDragState = null;

function initMobileDrawerDragAndDrop() {
    const catContainer = document.getElementById('drawer-categories-list');
    if (!catContainer) return;

    const handles = catContainer.querySelectorAll('.drawer-drag-handle');
    handles.forEach(handle => {
        handle.removeEventListener('touchstart', onHandleTouchStart);
        handle.addEventListener('touchstart', onHandleTouchStart, { passive: false });
    });
}

function onHandleTouchStart(e) {
    if (e.touches.length > 1) return;
    const touch = e.touches[0];
    const handle = e.currentTarget;
    const isCat = handle.classList.contains('cat-drag-handle');
    const itemEl = isCat ? handle.closest('.drawer-cat-group, .drawer-cat-divider-group') : handle.closest('.drawer-page-item');
    if (!itemEl) return;

    e.preventDefault();
    e.stopPropagation();

    // Sürükleme esnasında parmak altında takip edecek hayalet öğe (ghost)
    const ghost = document.createElement('div');
    ghost.className = 'drag-floating-ghost';
    let labelText = 'Öğe';
    if (isCat) {
        const titleSpan = itemEl.querySelector('.drawer-cat-title span:nth-child(4)');
        const divLabel = itemEl.querySelector('.drawer-divider-label');
        labelText = titleSpan ? titleSpan.innerText : (divLabel ? divLabel.innerText : 'Ayraç');
    } else {
        const pageTitle = itemEl.querySelector('.drawer-page-item span:first-child span:last-child');
        labelText = pageTitle ? pageTitle.innerText : 'Sayfa';
    }
    ghost.innerHTML = (isCat ? '📁 ' : '📄 ') + escapeHtml(labelText);
    document.body.appendChild(ghost);

    ghost.style.left = (touch.clientX - 25) + 'px';
    ghost.style.top = (touch.clientY - 40) + 'px';

    itemEl.classList.add('is-dragging');

    mobileDragState = {
        type: isCat ? 'cat' : 'page',
        itemEl: itemEl,
        itemId: isCat ? itemEl.dataset.categoryId : itemEl.dataset.pageId,
        sourceCatId: isCat ? null : itemEl.dataset.categoryId,
        ghost: ghost,
        lastTarget: null,
        lastPos: null,
        lastAction: null
    };

    document.addEventListener('touchmove', onMobileTouchMove, { passive: false });
    document.addEventListener('touchend', onMobileTouchEnd, { passive: false });
    document.addEventListener('touchcancel', onMobileTouchCancel, { passive: false });
}

function onMobileTouchMove(e) {
    if (!mobileDragState) return;
    e.preventDefault();
    e.stopPropagation();

    const touch = e.touches[0];
    const ghost = mobileDragState.ghost;
    if (ghost) {
        ghost.style.left = (touch.clientX - 25) + 'px';
        ghost.style.top = (touch.clientY - 40) + 'px';
    }

    clearMobileDropIndicators();

    const elementUnder = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!elementUnder) return;

    if (mobileDragState.type === 'cat') {
        const hoverGroup = elementUnder.closest('.drawer-cat-group, .drawer-cat-divider-group');
        if (hoverGroup && hoverGroup !== mobileDragState.itemEl) {
            const rect = hoverGroup.getBoundingClientRect();
            const relY = touch.clientY - rect.top;
            if (relY < rect.height / 2) {
                hoverGroup.classList.add('drop-target-above');
                mobileDragState.lastPos = 'above';
            } else {
                hoverGroup.classList.add('drop-target-below');
                mobileDragState.lastPos = 'below';
            }
            mobileDragState.lastTarget = hoverGroup;
            mobileDragState.lastAction = 'reorderCat';
        }
    } else if (mobileDragState.type === 'page') {
        // 1. Dosya Başlığı üzerine bırakma (Başka dosyaya aktarma)
        const hoverCatHeader = elementUnder.closest('.drawer-cat-header');
        if (hoverCatHeader) {
            const targetCatId = hoverCatHeader.dataset.categoryId;
            if (targetCatId !== mobileDragState.sourceCatId) {
                hoverCatHeader.classList.add('cat-drop-hover');
                mobileDragState.lastTarget = hoverCatHeader;
                mobileDragState.lastAction = 'moveToCat';
                return;
            }
        }

        // 2. Sayfa üzerine bırakma (Aynı veya farklı dosya içinde sayfa sıralama)
        const hoverPage = elementUnder.closest('.drawer-page-item');
        if (hoverPage && hoverPage !== mobileDragState.itemEl) {
            const rect = hoverPage.getBoundingClientRect();
            const relY = touch.clientY - rect.top;
            if (relY < rect.height / 2) {
                hoverPage.classList.add('drop-target-above');
                mobileDragState.lastPos = 'above';
            } else {
                hoverPage.classList.add('drop-target-below');
                mobileDragState.lastPos = 'below';
            }
            mobileDragState.lastTarget = hoverPage;
            mobileDragState.lastAction = 'reorderPage';
        }
    }
}

async function onMobileTouchEnd(e) {
    if (!mobileDragState) return;
    const state = mobileDragState;
    mobileDragState = null;

    document.removeEventListener('touchmove', onMobileTouchMove);
    document.removeEventListener('touchend', onMobileTouchEnd);
    document.removeEventListener('touchcancel', onMobileTouchCancel);

    if (state.ghost && state.ghost.parentNode) {
        state.ghost.parentNode.removeChild(state.ghost);
    }
    state.itemEl.classList.remove('is-dragging');
    clearMobileDropIndicators();

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
                .map(el => parseInt(el.dataset.categoryId))
                .filter(Boolean);

            await window.appStorage.reorderCategories(catIds);

            if (window.appSync && window.appSync.isOnline) {
                try {
                    await window.appSync.apiFetch('/notes/api/categories/reorder', {
                        method: 'POST',
                        body: JSON.stringify({ category_ids: catIds })
                    });
                } catch (e) {
                    console.warn("Sunucu kategori sıralama hatası:", e);
                }
            }
            window.appSync.syncNow();
            showMobileToast('Dosya sırası güncellendi');
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
                    try {
                        await window.appSync.apiFetch(`/notes/api/pages/${pageId}/move`, {
                            method: 'POST',
                            body: JSON.stringify({ category_id: targetCatId })
                        });
                    } catch (e) {
                        console.warn("Sunucu sayfa taşıma hatası:", e);
                    }
                }
                window.appSync.syncNow();
                await reloadDrawerNavigation();
                showMobileToast('Sayfa yeni dosyaya aktarıldı');
            } else if (state.lastAction === 'reorderPage') {
                const targetPageEl = state.lastTarget;
                const targetParent = targetPageEl.closest('.drawer-cat-pages');
                if (!targetParent) return;

                const targetCatId = parseInt(targetParent.dataset.categoryId);

                if (state.lastPos === 'above') {
                    targetParent.insertBefore(state.itemEl, targetPageEl);
                } else {
                    targetParent.insertBefore(state.itemEl, targetPageEl.nextSibling);
                }

                const pageIds = Array.from(targetParent.querySelectorAll('.drawer-page-item'))
                    .map(el => parseInt(el.dataset.pageId))
                    .filter(Boolean);

                await window.appStorage.reorderPages(targetCatId, pageIds);

                // Eğer başka bir dosyadan bu dosyaya aktarılmışsa kaynak dosyayı da güncelle
                if (parseInt(state.sourceCatId) !== targetCatId) {
                    const sourceParent = document.getElementById(`drawer-cat-pages-${state.sourceCatId}`);
                    if (sourceParent) {
                        const sourcePageIds = Array.from(sourceParent.querySelectorAll('.drawer-page-item'))
                            .map(el => parseInt(el.dataset.pageId))
                            .filter(Boolean);
                        await window.appStorage.reorderPages(parseInt(state.sourceCatId), sourcePageIds);
                    }
                }

                if (window.appSync && window.appSync.isOnline) {
                    try {
                        await window.appSync.apiFetch('/notes/api/pages/reorder', {
                            method: 'POST',
                            body: JSON.stringify({ category_id: targetCatId, page_ids: pageIds })
                        });
                    } catch (e) {
                        console.warn("Sunucu sayfa sıralama hatası:", e);
                    }
                }
                window.appSync.syncNow();
                await reloadDrawerNavigation();
                showMobileToast(parseInt(state.sourceCatId) !== targetCatId ? 'Sayfa yeni dosyaya aktarıldı' : 'Sayfa sırası güncellendi');
            }
        }
    } catch (err) {
        console.error("Mobil sürükle-bırak hatası:", err);
    }
}

function onMobileTouchCancel(e) {
    if (!mobileDragState) return;
    if (mobileDragState.ghost && mobileDragState.ghost.parentNode) {
        mobileDragState.ghost.parentNode.removeChild(mobileDragState.ghost);
    }
    if (mobileDragState.itemEl) {
        mobileDragState.itemEl.classList.remove('is-dragging');
    }
    clearMobileDropIndicators();
    mobileDragState = null;
    document.removeEventListener('touchmove', onMobileTouchMove);
    document.removeEventListener('touchend', onMobileTouchEnd);
    document.removeEventListener('touchcancel', onMobileTouchCancel);
}

function clearMobileDropIndicators() {
    document.querySelectorAll('.drop-target-above, .drop-target-below, .cat-drop-hover').forEach(el => {
        el.classList.remove('drop-target-above', 'drop-target-below', 'cat-drop-hover');
    });
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

    const isChecklist = (page.type === 'checklist');
    const isNotes = (page.type === 'notes' || page.type === 'note');
    const isFinance = (page.type === 'finance');
    const isProject = (page.type === 'project');
    const isSoftware = (page.type === 'software');

    document.getElementById('page-progress-wrap').style.display = isChecklist ? 'flex' : 'none';
    document.getElementById('page-quick-add-box').style.display = isChecklist ? 'flex' : 'none';
    document.getElementById('page-checklist-container').style.display = isChecklist ? 'flex' : 'none';
    document.getElementById('page-note-container').style.display = isNotes ? 'block' : 'none';
    document.getElementById('page-finance-container').style.display = isFinance ? 'flex' : 'none';
    document.getElementById('page-project-container').style.display = isProject ? 'flex' : 'none';
    const softContainer = document.getElementById('page-software-container');
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
        document.getElementById('page-note-content').value = page.content || '';
        fetchPageDetailsFromServer(page.id);
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
}

function renderChecklistItemHtml(it) {
    let metaBadges = '';
    if (it.remind_at) {
        let displayRemind = it.remind_at;
        try {
            const dt = new Date(it.remind_at.replace(' ', 'T'));
            displayRemind = `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
        } catch(e) {}
        metaBadges += `<span class="meta-badge reminder" style="background:#f5f3ff; color:#7c3aed; border:1px solid #ddd6fe; cursor:pointer;" onclick="event.stopPropagation(); openItemReminderModal(${it.id})" title="Alarmı Düzenle">⏰ ${displayRemind}</span>`;
    }
    if (it.price) metaBadges += `<span class="meta-badge price">💰 ${escapeHtml(it.price)}</span>`;
    if (it.quantity) metaBadges += `<span class="meta-badge" style="background:var(--surface2); color:var(--text-secondary);">${escapeHtml(it.quantity)}</span>`;
    if (it.url) metaBadges += `<a href="${escapeHtml(it.url)}" target="_system" class="meta-badge url">🔗 Link</a>`;

    const alarmIconColor = it.remind_at ? '#7c3aed' : 'var(--muted)';

    return `
        <div class="checklist-item-card ${it.is_done ? 'done' : ''}" id="item-card-${it.id}">
            <div class="checkbox-custom" onclick="toggleItemDone(${it.id})">
                ${it.is_done ? '✓' : ''}
            </div>
            <div class="checklist-item-body" onclick="toggleItemDone(${it.id})">
                <div class="checklist-item-title">${escapeHtml(it.title)}</div>
                ${metaBadges ? `<div class="checklist-item-meta">${metaBadges}</div>` : ''}
            </div>
            <div class="checklist-item-actions" style="display:flex; align-items:center; gap:4px;">
                <button class="item-action-btn" style="color:${alarmIconColor}; font-size:0.9rem;" onclick="event.stopPropagation(); openItemReminderModal(${it.id})" title="Alarm & Hatırlatıcı Ayarla">⏰</button>
                <button class="item-action-btn" onclick="deletePageItem(${it.id})" title="Sil">🗑️</button>
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
            taskListEl.innerHTML = pendingItems.slice(0, 8).map(it => {
                const alarmBtn = `<button class="item-action-btn" style="color:${it.remind_at ? '#7c3aed' : 'var(--muted)'}; font-size:0.9rem; padding:4px;" onclick="event.stopPropagation(); openItemReminderModal(${it.id})" title="Alarm Ayarla">⏰</button>`;
                return `
                <div class="overview-item" style="cursor:pointer;" onclick="openPage(${it.page_id})">
                    <div style="display:flex; align-items:center; gap:10px; overflow:hidden; flex:1;">
                        <div class="checkbox-custom ${it.is_done ? 'checked' : ''}" onclick="event.stopPropagation(); toggleOverviewItemDone(${it.id})">
                            ${it.is_done ? '✓' : ''}
                        </div>
                        <div style="overflow:hidden; display:flex; flex-direction:column; gap:1px;">
                            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; font-size:0.9rem; ${it.is_done ? 'text-decoration:line-through; opacity:0.6;' : ''}">
                                ${escapeHtml(it.title)}
                            </span>
                            ${it.remind_at ? `<span style="font-size:0.72rem; color:#7c3aed; font-weight:600;">⏰ ${escapeHtml(it.remind_at.substring(5, 16))}</span>` : ''}
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        ${alarmBtn}
                        <span style="color:var(--muted); font-size:0.75rem;">➔</span>
                    </div>
                </div>
            `}).join('');
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

function selectNewPageType(type) {
    newPageType = type;
    const btnCheck = document.getElementById('btn-type-checklist');
    const btnNotes = document.getElementById('btn-type-notes');
    const btnSoft = document.getElementById('btn-type-software');
    const btnFin = document.getElementById('btn-type-finance');
    const btnProj = document.getElementById('btn-type-project');

    if (btnCheck) btnCheck.classList.toggle('active', type === 'checklist');
    if (btnNotes) btnNotes.classList.toggle('active', type === 'notes');
    if (btnSoft) btnSoft.classList.toggle('active', type === 'software');
    if (btnFin) btnFin.classList.toggle('active', type === 'finance');
    if (btnProj) btnProj.classList.toggle('active', type === 'project');

    const typeIcons = {
        checklist: '🛒',
        notes: '📝',
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
        software: '💻',
        finance: '💳',
        project: '🔬'
    };

    const chosenIcon = (iconInput ? iconInput.value.trim() : '') || typeIcons[newPageType] || '📝';

    const newPage = {
        id: Date.now(),
        category_id: catId,
        title: title,
        type: newPageType,
        icon: chosenIcon,
        content: '',
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

    const matchedPages = pages.filter(p => !p._deleted && (p.title || '').toLowerCase().includes(q));
    const matchedItems = items.filter(i => !i._deleted && (i.title || '').toLowerCase().includes(q));
    const matchedVault = vault.filter(v => !v._deleted && ((v.title || '').toLowerCase().includes(q) || (v.username || '').toLowerCase().includes(q)));

    let html = '';
    matchedPages.forEach(p => {
        html += `
            <div class="overview-item" onclick="closeModal('modal-search'); openPage(${p.id})">
                <span>${p.icon || '📝'} ${escapeHtml(p.title)} (Sayfa)</span>
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
            if (nameEl) nameEl.innerText = user.display_name || user.username;
            if (roleEl) roleEl.innerText = `@${user.username} (${user.role || 'Kullanıcı'})`;
            if (loggedInBox) loggedInBox.style.display = 'block';
            if (formBox) formBox.style.display = 'none';
            return;
        } catch (e) {}
    }

    if (loggedInBox) loggedInBox.style.display = 'none';
    if (formBox) formBox.style.display = 'block';
}

async function handleMobileAuthSubmit() {
    const uInput = document.getElementById('m-auth-user');
    const pInput = document.getElementById('m-auth-pass');
    const dInput = document.getElementById('m-auth-display');
    const msg = document.getElementById('m-auth-msg');

    const u = uInput ? uInput.value.trim() : '';
    const p = pInput ? pInput.value.trim() : '';
    const displayName = dInput ? dInput.value.trim() : '';

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
        res = await window.appSync.register(u, p, displayName);
    }

    if (res.ok) {
        if (msg) {
            msg.innerText = 'Başarılı! Oturum açıldı.';
            msg.style.color = 'var(--success)';
        }
        if (pInput) pInput.value = '';
        await refreshMobileAuthUI();
        window.appSync.syncNow();
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
